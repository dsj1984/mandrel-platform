// pnpm install watchdog — supervise the shared toolchain install so an install
// that has STOPPED fails fast with a named cause (Story #530).
//
// WHAT IT IS FOR
// --------------
// `setup-toolchain`'s install step is the one install a caller cannot reach.
// A consumer can wrap the installs in its own repo-owned jobs, but the shared
// tiers install inside this composite, and a caller cannot inject a step
// there. So when a `pnpm install` wedges, the job holds its runner until
// `timeout-minutes` kills it and reds `ci-required` on a diff that could not
// have caused it.
//
// The measured incident (Beestera/swarm-os, 2026-09-14, run 34876024126,
// pnpm 11.5.2): `ci / Lint & format` entered `Setup toolchain` and never left.
// Its pnpm process accumulated 20.99s of CPU across 27 MINUTES — flat,
// re-sampled 20s apart, sleeping at 0% — with ~1,200 file descriptors open on
// the store's SQLite `index.db`. The `Checkout` before it took 6s. Two jobs
// wedged in that window with the same signature and DIFFERENT store
// topologies, so store isolation is not the remedy.
//
// PROGRESS IS CPU, NOT OUTPUT
// ---------------------------
// A wedged pnpm still holds its pipes, so an output-based watchdog watches the
// wrong signal: silence proves nothing and noise proves nothing. What
// separated the wedge from a healthy install was the process tree's
// accumulated CPU. It is measured over the whole TREE because pnpm does its
// work in children; a parent that has handed everything to a worker is not
// stalled.
//
// A STALL IS A RATE, NOT AN ABSENCE
// ---------------------------------
// The wedge still ticked — 20.99s across 27 minutes is ~1.3% of one core. A
// watchdog testing "CPU has not advanced at all" would never have fired on the
// very incident it exists for. So the decision is a mean RATE over a trailing
// window: kill when the tree stays below `minCpuRate` for a continuous
// `stallTimeoutMs`, and only after a grace window, because a cold install is
// legitimately quiet early.
//
// FAIL-SAFE IS LOAD-BEARING
// -------------------------
// A supervisor that can red a job on its own bug is worse than the stall it
// prevents. Every path that cannot answer the question — an unreadable process
// table, an unparseable `ps`, a config value that is not a number — DISARMS
// for the rest of the run and lets the install finish under its own exit
// status. The watchdog may only ever turn a provably stopped install into a
// fast, named failure; it may never be the reason a job fails.
//
// It does not make a wedged tier pass. The tier still fails — it fails in
// minutes with a cause, and it releases the runner.

import { spawn, execFile } from "node:child_process";

/**
 * Exit code reserved for a watchdog stall kill, so the failure is greppable in
 * a log and distinguishable from anything the install itself returns. 75 is
 * EX_TEMPFAIL ("temporary failure; retry later"), which is what a stalled
 * install is; pnpm itself exits 1 / 2 / 254.
 */
export const EXIT_STALLED = 75;

/** Defaults, in the units the env carries them (seconds, and a 0..1 rate). */
export const DEFAULTS = Object.freeze({
  stallTimeoutSeconds: 600,
  graceSeconds: 120,
  minCpuRate: 0.05,
  sampleIntervalSeconds: 10,
});

/**
 * Parse a `ps -o time=` field into seconds.
 *
 * The field is not one format. Linux `procps` emits `[DD-]HH:MM:SS`; BSD/macOS
 * emits `MM:SS.cc` and `HH:MM.SS` depending on magnitude. Rather than branch on
 * platform — which would make the parser lie on whichever platform the tests
 * do not run on — this reads the shape: split the day prefix, then treat the
 * colon-separated parts as the tail of [hours, minutes, seconds].
 *
 * @param {string} field Raw `time=` field, e.g. "20:59.02" or "1-02:03:04".
 * @returns {number|null} Seconds, or `null` when the field is not a time —
 *   which the caller MUST treat as "cannot answer", never as zero.
 */
export function parseCpuTime(field) {
  const raw = String(field ?? "").trim();
  if (raw === "") return null;
  const dashIdx = raw.indexOf("-");
  const days = dashIdx === -1 ? 0 : Number(raw.slice(0, dashIdx));
  const clock = dashIdx === -1 ? raw : raw.slice(dashIdx + 1);
  if (!Number.isFinite(days) || days < 0) return null;
  const parts = clock.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  // Right-align into [hours, minutes, seconds]: a two-part clock is MM:SS.
  const [hours, minutes, seconds] =
    nums.length === 3 ? nums : [0, nums[0], nums[1]];
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/**
 * Parse `ps -Ao pid=,ppid=,time=` output into rows.
 *
 * A row whose time field does not parse is DROPPED rather than counted as
 * zero: a zero would read as "this process is doing nothing", which is exactly
 * the claim the watchdog kills on.
 *
 * @param {string} stdout
 * @returns {{pid:number, ppid:number, cpuSeconds:number}[]}
 */
export function parsePsRows(stdout) {
  const rows = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    const cpuSeconds = parseCpuTime(fields[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (cpuSeconds === null) continue;
    rows.push({ pid, ppid, cpuSeconds });
  }
  return rows;
}

/**
 * Every pid in `rootPid`'s tree, root included, from a flat pid/ppid list.
 *
 * Walks breadth-first from the root rather than scanning ancestors per row, so
 * a cycle in a malformed table cannot spin: each pid is visited once.
 *
 * @param {{pid:number, ppid:number}[]} rows
 * @param {number} rootPid
 * @returns {number[]}
 */
export function collectTree(rows, rootPid) {
  const children = new Map();
  for (const { pid, ppid } of rows) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen];
}

/**
 * Total accumulated CPU of `rootPid`'s tree.
 *
 * @param {{pid:number, ppid:number, cpuSeconds:number}[]} rows
 * @param {number} rootPid
 * @returns {number|null} Seconds, or `null` when the root is not in the table
 *   at all — the tree is gone, or the table could not be read. Either way the
 *   caller cannot conclude "stalled" from it.
 */
export function sumTreeCpuSeconds(rows, rootPid) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  if (!byPid.has(rootPid)) return null;
  let total = 0;
  for (const pid of collectTree(rows, rootPid)) {
    total += byPid.get(pid)?.cpuSeconds ?? 0;
  }
  return total;
}

/**
 * The decision. Pure, so the incident's shape can be replayed without a real
 * stall and without waiting ten minutes for one.
 *
 * Not armed until `graceSeconds` has elapsed, and not decidable until the
 * trailing window is full — a window that has not filled cannot distinguish a
 * stall from an install that started three seconds ago.
 *
 * The rate is a MEAN over the trailing window, anchored on the newest sample
 * at or before the window's leading edge. A mean defers the kill when the tree
 * was busy for any part of the window, which is the conservative direction:
 * the cost of waiting is minutes, and the cost of a wrong kill is a red
 * required check on an innocent diff.
 *
 * @param {{atMs:number, cpuSeconds:number}[]} samples Ordered oldest-first,
 *   `atMs` measured from the child's start.
 * @param {{stallTimeoutMs:number, graceMs:number, minCpuRate:number}} config
 * @returns {{stalled:boolean, reason:string, rate:number|null,
 *   windowSeconds:number|null, cpuSeconds:number|null}}
 */
export function evaluateStall(samples, config) {
  const idle = (reason) => ({
    stalled: false,
    reason,
    rate: null,
    windowSeconds: null,
    cpuSeconds: null,
  });
  if (!Array.isArray(samples) || samples.length < 2) return idle("too-few-samples");
  const last = samples[samples.length - 1];
  if (last.atMs < config.graceMs) return idle("within-grace");

  // The newest sample at or before the trailing window's leading edge. Using
  // the newest such sample keeps the measured window as close to
  // `stallTimeoutMs` as the sampling cadence allows, rather than stretching it
  // back to the start of the run.
  const edgeMs = last.atMs - config.stallTimeoutMs;
  let anchor = null;
  for (const sample of samples) {
    if (sample.atMs <= edgeMs) anchor = sample;
    else break;
  }
  if (anchor === null) return idle("window-not-full");
  // The window must also lie entirely past the grace period, or a quiet cold
  // start would be averaged into the verdict it is explicitly exempt from.
  if (anchor.atMs < config.graceMs) return idle("window-not-full");

  const windowSeconds = (last.atMs - anchor.atMs) / 1000;
  if (windowSeconds <= 0) return idle("window-not-full");
  const rate = (last.cpuSeconds - anchor.cpuSeconds) / windowSeconds;
  const stalled = rate < config.minCpuRate;
  return {
    stalled,
    reason: stalled ? "cpu-rate-below-floor" : "progressing",
    rate,
    windowSeconds,
    cpuSeconds: last.cpuSeconds - anchor.cpuSeconds,
  };
}

/**
 * Read the watchdog's configuration out of the environment.
 *
 * Every rejection path returns `armed: false` with a reason rather than
 * throwing or falling back to a default: an operator who typed a bad number
 * asked for supervision and must be told they are not getting it, and a
 * watchdog that invents its own thresholds when handed nonsense is exactly the
 * component that can red a job on its own bug.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{armed:boolean, reason:string, stallTimeoutMs:number,
 *   graceMs:number, minCpuRate:number, sampleIntervalMs:number}}
 */
export function resolveConfig(env = {}) {
  const num = (raw, fallback) => {
    const value = String(raw ?? "").trim();
    if (value === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  };
  const disarmed = (reason) => ({
    armed: false,
    reason,
    stallTimeoutMs: 0,
    graceMs: 0,
    minCpuRate: 0,
    sampleIntervalMs: 0,
  });

  const stallTimeout = num(env.PNPM_WATCHDOG_STALL_TIMEOUT, DEFAULTS.stallTimeoutSeconds);
  const grace = num(env.PNPM_WATCHDOG_GRACE, DEFAULTS.graceSeconds);
  const minCpuRate = num(env.PNPM_WATCHDOG_MIN_CPU_RATE, DEFAULTS.minCpuRate);
  const interval = num(env.PNPM_WATCHDOG_SAMPLE_INTERVAL, DEFAULTS.sampleIntervalSeconds);

  for (const [name, value] of [
    ["PNPM_WATCHDOG_STALL_TIMEOUT", stallTimeout],
    ["PNPM_WATCHDOG_GRACE", grace],
    ["PNPM_WATCHDOG_MIN_CPU_RATE", minCpuRate],
    ["PNPM_WATCHDOG_SAMPLE_INTERVAL", interval],
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      return disarmed(`${name} is not a non-negative number`);
    }
  }
  // 0 is the documented off switch, not a zero-length window.
  if (stallTimeout === 0) return disarmed("disabled (stall timeout 0)");
  if (interval === 0) return disarmed("disabled (sample interval 0)");

  return {
    armed: true,
    reason: "armed",
    stallTimeoutMs: stallTimeout * 1000,
    graceMs: grace * 1000,
    minCpuRate,
    sampleIntervalMs: interval * 1000,
  };
}

/**
 * Sample the live process table. Rejects rather than resolving empty when `ps`
 * cannot be run, so the caller disarms instead of reading a missing table as
 * an idle one.
 *
 * @returns {Promise<{pid:number, ppid:number, cpuSeconds:number}[]>}
 */
export function psSampler() {
  return new Promise((resolve, reject) => {
    // Array argv, never a shell: the watchdog runs on a self-hosted runner and
    // must not be a place where anything gets word-split.
    execFile("ps", ["-Ao", "pid=,ppid=,time="], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const rows = parsePsRows(stdout);
      if (rows.length === 0) return reject(new Error("ps returned no parseable rows"));
      resolve(rows);
    });
  });
}

/**
 * Format the operator-facing kill message. Separated from `main` so the text a
 * human reads in a red log is itself asserted, rather than being whatever the
 * code happened to interpolate.
 *
 * @param {{rate:number, windowSeconds:number, cpuSeconds:number}} verdict
 * @param {{minCpuRate:number}} config
 * @returns {string}
 */
export function renderStallMessage(verdict, config) {
  const pct = (n) => `${(n * 100).toFixed(2)}%`;
  return (
    `pnpm install stalled: the install process tree used ` +
    `${verdict.cpuSeconds.toFixed(2)}s of CPU over the last ` +
    `${Math.round(verdict.windowSeconds)}s (${pct(verdict.rate)} of one core), ` +
    `below the ${pct(config.minCpuRate)} floor for the whole window. ` +
    `The install is stopped, not slow — killed after ` +
    `${Math.round(verdict.windowSeconds)}s rather than holding this runner to ` +
    `the job's timeout-minutes. Set install-stall-timeout: '0' to disable this ` +
    `supervision, or raise it if this install is legitimately this quiet.`
  );
}

/**
 * How long a tree gets to honour SIGTERM before it is SIGKILLed. A wedged pnpm
 * is the case that matters here: a process asleep in a syscall may never run
 * its signal handler, and a watchdog that TERMs and hopes leaves exactly the
 * runner-holding process it exists to remove.
 */
export const KILL_ESCALATION_MS = 5000;

/**
 * Signal every member of a process tree.
 *
 * Signals the leaves first so a parent cannot fork a replacement while its
 * children are still being walked.
 *
 * @param {number[]} pids
 * @param {string} [signal]
 * @param {(pid:number, signal:string)=>void} [kill]
 */
export function signalTree(pids, signal = "SIGTERM", kill = (pid, sig) => process.kill(pid, sig)) {
  for (const pid of [...pids].reverse()) {
    // A pid that has already exited throws ESRCH; that is the goal state, not
    // an error worth propagating.
    try {
      kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run the install under supervision.
 *
 * @param {object} opts
 * @param {string} opts.command Executable to run (never through a shell).
 * @param {string[]} opts.args
 * @param {ReturnType<typeof resolveConfig>} opts.config
 * @param {() => Promise<{pid:number, ppid:number, cpuSeconds:number}[]>} [opts.sampler]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<number>} The exit code to exit with.
 */
export function supervise({ command, args, config, sampler = psSampler, log = console.error }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    const startedAt = Date.now();
    const samples = [];
    let timer = null;
    let settled = false;
    let disarmed = !config.armed;
    let killedForStall = null;
    let escalation = null;

    const stopSampling = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const stopEscalation = () => {
      if (escalation !== null) {
        clearTimeout(escalation);
        escalation = null;
      }
    };

    const settle = (code) => {
      if (settled) return;
      settled = true;
      stopSampling();
      stopEscalation();
      resolve(code);
    };

    child.on("error", (err) => {
      log(`::error::pnpm install watchdog: could not start ${command}: ${err.message}`);
      settle(1);
    });

    child.on("exit", (code, signal) => {
      // A stall kill owns the exit code: the child's own status after a
      // SIGTERM says "terminated", which is true of any cancellation and would
      // make the stall unrecognisable.
      if (killedForStall !== null) {
        log(`::error::${killedForStall}`);
        return settle(EXIT_STALLED);
      }
      if (signal) return settle(128 + (signalNumber(signal) ?? 0));
      settle(code ?? 0);
    });

    const disarm = (reason) => {
      if (disarmed) return;
      disarmed = true;
      stopSampling();
      // Said once, loudly enough to see, and never as an error: the install is
      // still running and may well succeed.
      log(
        `::warning::pnpm install watchdog disarmed (${reason}); the install ` +
          `continues unsupervised and its own exit status stands.`,
      );
    };

    if (!config.armed) {
      log(`pnpm install watchdog: not armed (${config.reason}).`);
      return;
    }

    log(
      `pnpm install watchdog armed: killing the install if its process tree ` +
        `stays under ${(config.minCpuRate * 100).toFixed(2)}% CPU for ` +
        `${Math.round(config.stallTimeoutMs / 1000)}s, after a ` +
        `${Math.round(config.graceMs / 1000)}s grace period.`,
    );

    const tick = async () => {
      if (settled || disarmed) return;
      let rows;
      try {
        rows = await sampler();
      } catch (err) {
        return disarm(`process state is unreadable: ${err.message}`);
      }
      if (settled || disarmed) return;
      const cpuSeconds = sumTreeCpuSeconds(rows, child.pid);
      if (cpuSeconds === null) {
        // The child is not in the table. Either it just exited — the `exit`
        // handler settles that — or the table cannot answer for it. Neither is
        // evidence of a stall.
        return;
      }
      samples.push({ atMs: Date.now() - startedAt, cpuSeconds });
      const verdict = evaluateStall(samples, config);
      if (!verdict.stalled) return;

      killedForStall = renderStallMessage(verdict, config);
      stopSampling();
      const tree = collectTree(rows, child.pid);
      signalTree(tree, "SIGTERM");
      // Escalate rather than trust. This timer is NOT unref'd: it is the only
      // thing standing between a TERM-deaf tree and a runner held for the rest
      // of the job's budget, so it must keep the loop alive until it fires.
      escalation = setTimeout(() => signalTree(tree, "SIGKILL"), KILL_ESCALATION_MS);
    };

    timer = setInterval(() => {
      void tick();
    }, config.sampleIntervalMs);
    // Never hold the event loop open on the watchdog's account; the child does
    // that, and a lingering timer would outlive a settled run.
    if (typeof timer.unref === "function") timer.unref();
  });
}

/** @param {string} signal @returns {number|undefined} */
function signalNumber(signal) {
  return { SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 }[signal];
}

/**
 * CLI: everything after `--` is the command to supervise.
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const sep = argv.indexOf("--");
  const rest = sep === -1 ? argv : argv.slice(sep + 1);
  if (rest.length === 0) {
    console.error("::error::pnpm install watchdog: no command given (usage: -- <cmd> [args...])");
    return 2;
  }
  const config = resolveConfig(env);
  return supervise({ command: rest[0], args: rest.slice(1), config });
}

// Run only when invoked directly (not when imported by the test suite).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(await main());
}
