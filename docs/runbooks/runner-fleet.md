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
one script the recipe needs. It is interactive-only:

```bash
cd ~/Development/github-runners && ./runner-toggle
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

### Installing the working copy

The runners folder holds a **symlink**, not a copy, so there is one source of
truth and an edit in this repo is live immediately:

```bash
ln -sf ~/Development/mandrel-platform/docs/runbooks/runner-toggle.sh ~/Development/github-runners/runner-toggle
```

The script discovers fleets relative to the symlink's own directory, which is
why it must live inside the runners folder.

### Bumping it

Edit the file here, bump the `VERSION:` line in its header, and land it
through the normal PR flow. Use a `docs:` or `chore:` commit type: this is
operator tooling, not a consumer-facing surface, so it should not cut a
platform release.

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

`launchctl list | grep actions.runner` on the dev Mac shows plists for fleets
whose folders are gone (`swarm-os`, `athportal`, `design-system`), several
with exit status 78. They are harmless but noisy. To retire one:

```bash
launchctl unload ~/Library/LaunchAgents/<label>.plist && rm ~/Library/LaunchAgents/<label>.plist
```

Only do this for labels whose runner folder no longer exists; a live runner's
plist is what `svc.sh start` reloads.
