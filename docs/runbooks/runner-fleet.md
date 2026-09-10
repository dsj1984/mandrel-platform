# Runner Fleet — scaling self-hosted runners on the dev Mac

Operator recipe for the self-hosted GitHub Actions runners that live on the
developer Mac under `~/Development/github-runners/`. One folder per fleet
(`beestera-runners`, `domio-runners`, …), one sub-folder per registered
runner (`beestera-1`, `beestera-2`, …), each a launchd LaunchAgent driven by
the stock `svc.sh` GitHub ships inside the runner install.

This is a **platform-process doc with no consumer stub** (like
[`self-healing.md`](self-healing.md)): it describes the operator's machine,
not a consumer repo, so `platform-sync.mjs` never copies it.

## The tool: `runner-toggle.sh`

[`runner-toggle.sh`](runner-toggle.sh) is the canonical, versioned copy of the
one script the recipe needs. It is interactive-only and takes no arguments:

```bash
runner-toggle
```

It walks through four prompts:

1. **Pick a fleet** from a numbered list showing `active of total` for each.
2. **Read the status table** for that fleet (`idle` / `busy` / `dead` /
   `stopped`, PID, launchd label).
3. **Type the target count.** Blank leaves everything as is. The script
   starts the lowest-numbered inactive runners or stops the highest-numbered
   active ones until exactly that many are up.
4. **Decide about busy runners.** If reaching the target would stop a runner
   that is mid-job, the script asks whether to wait for those jobs to finish
   first. `y` polls every 10 seconds and stops each one as it drains;
   `N` leaves them running and exits 1 so the miss is visible.

The header comment in the script is the full design record: layout
assumptions, ordering rules, why stopping a busy runner is refused, exit codes,
and the bash 3.2 portability constraints.

### How "busy" is decided

A runner is **busy** when its own `Runner.Worker` process is running, and that
is decided by a **literal path match**: the script takes one `ps` snapshot and
compares `<runner-dir>/bin/Runner.Worker` as a whole command-line token, never
as a pattern. So a fleet folder whose name contains `+`, `(` or `[` is matched
exactly like any other — it is a path, not a regex.

That is a fix, not a detail. The check used to be `pgrep -f <path>`, whose
pattern is an extended regex, so a path holding those characters read the wrong
processes in both directions: a genuinely busy runner could report idle and be
stopped mid-job, and an unrelated runner could report busy. A `ps … | grep`
pipeline is not the alternative either — grep's own command line contains the
path it is searching for, so it matches itself and every runner reads as busy.

`scripts/runner-toggle.test.mjs` sources the script and drives the real check
against a stubbed process table; CI's `runner-kit-bash32` job runs that suite
and `bash -n` over the script under the macOS system bash 3.2.

### Installing it

Install a **copy**, on PATH:

```bash
cp docs/runbooks/runner-toggle.sh ~/.local/bin/runner-toggle && chmod +x ~/.local/bin/runner-toggle
```

A copy, deliberately **not a symlink into this repo**. An earlier revision
symlinked it and the tool broke within the hour: `mandrel-platform` is branched
constantly (`story-<id>` branches), and the symlink dangles the moment a
checkout lands on a branch that does not carry the file. An operator tool must
not break because of an unrelated branch switch. The `VERSION:` line in the
script header is how you tell an installed copy from the canonical one.

Installing it *inside* the runners folder also works, and is the shape to use
if you would rather not put it on PATH:

```bash
cp docs/runbooks/runner-toggle.sh ~/Development/github-runners/runner-toggle && chmod +x ~/Development/github-runners/runner-toggle
cd ~/Development/github-runners && ./runner-toggle
```

### How it finds the fleets

The script resolves a **fleet root** — the folder holding the fleet folders —
from the first of these that actually contains one:

| Candidate | Shape it serves |
|-----------|-----------------|
| `$RUNNER_TOGGLE_ROOT` | explicit override; a root with no fleets is an error, never a silent fallback |
| the script's own directory | installed inside the runners folder, run as `./runner-toggle` |
| `~/Development/github-runners` | installed on PATH, where the script's directory is a bin dir |

So a PATH install needs no configuration on this machine. Point
`RUNNER_TOGGLE_ROOT` at a different folder to drive a fleet tree living
somewhere else.

### Bumping it

Edit the file here, bump the `VERSION:` line in its header, land it through
the normal PR flow, then re-run the install `cp`. Use a `docs:` or `chore:`
commit type: this is operator tooling, not a consumer-facing surface, so it
should not cut a platform release.

## What the script deliberately does not do

- **Cancel a running job.** `svc.sh stop` is a bare `launchctl unload` and
  kills the job outright. If you really need that, run `./svc.sh stop` in the
  runner's own folder so the choice is explicit.
- **Register or remove runners.** It only toggles runners that are already
  configured. Registration still goes through `config.sh` in a fresh folder.
- **Read `~/Library/LaunchAgents`.** That directory accumulates orphaned
  plists for runners whose folders were deleted; the folders are the source
  of truth.

## Related hygiene

`~/Library/LaunchAgents` accumulates a plist per runner ever registered, and
nothing removes one when its runner folder is deleted. The leftovers sit in
`launchctl list` as entries with a `-` PID and exit status 78 (their
`WorkingDirectory` no longer exists), which is noise every time you read the
runner state by hand.

**Swept 2026-09-07**: 14 orphans removed — 6 `Beestera-swarm-os`, 5
`dsj1984-athportal`, 2 `Beestera-design-system`, 1 `dsj1984-domio`
(`domio-runner-7`). 18 plists remain, one per live runner folder, and no
`launchctl` entry is dead.

The safe way to find them is to key on the folder, not the label, since the
label does not always match the folder name (`domio-2` runs under the label
`domio-2`, but `domio-3` runs under `domio-runner-3`):

```bash
cd ~/Library/LaunchAgents
for p in actions.runner.*.plist; do
  wd="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$p" 2>/dev/null)"
  [ -d "$wd" ] || echo "ORPHAN $p -> $wd"
done
```

Before deleting, confirm the candidate has no live PID in `launchctl list` and
no `Runner.Listener` process. Then, for each:

```bash
launchctl unload ~/Library/LaunchAgents/<label>.plist 2>/dev/null
rm ~/Library/LaunchAgents/<label>.plist
```

Only do this for labels whose runner folder no longer exists; a live runner's
plist is exactly what `svc.sh start` reloads.

## Reconciling against GitHub — offline is **not** orphaned

Removing a plist does not deregister anything on GitHub, so it is reasonable
to expect leftover registrations after a fleet is deleted. **Do not clean them
up by deleting whatever shows `offline`.** A runner you stopped on purpose
(with `runner-toggle`, or `svc.sh stop`) reports `offline` and is
indistinguishable, in the runner list alone, from one whose folder is gone.
Deleting it forces a full `config.sh` re-registration to get it back.

The only safe signal is whether a **local folder still claims that runner
name**. Each folder's `.service` file names its launchd label, whose last
dot-separated field is the registered runner name, so the two sides can be
matched exactly:

```bash
# registered: "<scope>\t<name>"
{ gh api orgs/<ORG>/actions/runners --paginate --jq '.runners[] | "org\t\(.name)"'
  gh api repos/<OWNER>/<REPO>/actions/runners --paginate --jq '.runners[] | "repo\t\(.name)"'
} | sort > /tmp/registered.tsv

# local: runner name derived from each folder's .service label
for d in ~/Development/github-runners/*/*/; do
  d="${d%/}"; [ -f "$d/.service" ] || continue
  lbl="$(basename "$(cat "$d/.service")" .plist)"   # actions.runner.<scope>.<name>
  echo "${lbl##*.}"
done | sort > /tmp/local.txt

# a registered name absent from local.txt is a genuine orphan registration.
# The re-sort matters: registered.tsv is sorted by whole line (scope first),
# so cutting field 2 does NOT leave it sorted, and comm needs sorted input.
cut -f2 /tmp/registered.tsv | sort | comm -23 - /tmp/local.txt
```

Only a name that comes out of that last command is safe to remove, via the
runner list in the org or repo settings, or:

```bash
gh api -X DELETE repos/<OWNER>/<REPO>/actions/runners/<ID>
gh api -X DELETE orgs/<ORG>/actions/runners/<ID>
```

**Verified 2026-09-07**: 18 registrations (12 in the `Beestera` org, 6 in
`dsj1984/domio`) against 18 local folders — an exact 1:1 match in both
directions, zero orphan registrations. The `swarm-os`, `design-system` and
`athportal` runners whose plists were swept that day had already been
deregistered; the stale plists were the only trace they left. Every other
repo and org on the account reports zero self-hosted runners. The three
`offline` entries in `dsj1984/domio` at the time were deliberately stopped
runners, not orphans.
