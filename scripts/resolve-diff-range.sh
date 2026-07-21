#!/usr/bin/env bash
# resolve-diff-range.sh — the SINGLE, event-agnostic base/head SHA derivation
# shared by every diff-scoped tier of pr-quality.yml (Story #314).
#
# WHY THIS EXISTS
# ---------------
# The diff-scoped security tiers (gitleaks secret scan + Semgrep SAST) must
# scope their scan to the commits the triggering event INTRODUCED, so a
# pre-existing finding never blocks. Each event exposes that base/head pair
# under a different context path:
#
#   pull_request → github.event.pull_request.base.sha / .head.sha
#   merge_group  → github.event.merge_group.base_sha  / .head_sha
#   push         → github.event.before                / github.sha
#
# Under a `merge_group` (merge-queue) event `github.event.pull_request.*` is
# empty, so without this derivation the tiers degrade to a FULL-TREE scan and
# surface pre-existing findings unrelated to the queued commits — bouncing the
# whole queue batch. Deriving base/head from the merge_group context instead
# keeps the queue diff-scoped. This file is the one place that classification
# lives, so gitleaks and SAST cannot drift apart.
#
# CONTRACT
# --------
# SOURCE this file (do NOT exec it) from a `shell: bash` step, after the repo
# has been checked out with `fetch-depth: 0`. It reads the env vars below (all
# optional; an absent context evaluates to the empty string in a GitHub
# expression, so nothing here can `startup_failure` on a missing context) and
# sets three variables in the CALLER's shell:
#
#   Inputs (wire each to the matching context in the step's `env:` block):
#     PR_BASE_SHA          = github.event.pull_request.base.sha
#     PR_HEAD_SHA          = github.event.pull_request.head.sha
#     MERGE_GROUP_BASE_SHA = github.event.merge_group.base_sha
#     MERGE_GROUP_HEAD_SHA = github.event.merge_group.head_sha
#     EVENT_NAME           = github.event_name
#     PUSH_BEFORE_SHA      = github.event.before
#     PUSH_HEAD_SHA        = github.sha
#
#   Outputs (set on the caller's shell):
#     RESOLVED_EVENT_MODE = pull_request | merge_group | push | none
#     RESOLVED_BASE_SHA   = <base commit>   (empty when mode = none)
#     RESOLVED_HEAD_SHA   = <head commit>   (empty when mode = none)
#
# Each consumer applies its own shaping to the raw pair: gitleaks builds a
# `base..head` git-log range (`..` already excludes base-branch drift, so no
# explicit merge-base is needed); SAST needs a single `--baseline-commit`, and
# for pull_request derives the merge base of base..head (M8: base.sha is the
# live base-branch tip and drifts past the fork point once main advances),
# while for merge_group / push the base is already the exact fork point.
#
# `mode = none` means "no ranged base is resolvable" → the consumer falls back
# to a full-tree scan. This is reached by an absent context (queue no-op, or a
# branch-creation push whose `before` is the zero SHA / an unreachable commit).

resolve_diff_range() {
  local zero_sha="0000000000000000000000000000000000000000"
  RESOLVED_EVENT_MODE="none"
  RESOLVED_BASE_SHA=""
  RESOLVED_HEAD_SHA=""

  if [ -n "${PR_BASE_SHA:-}" ] && [ -n "${PR_HEAD_SHA:-}" ]; then
    # pull_request — the base-branch tip / PR head. Highest precedence so a
    # caller that (unusually) exposes both PR and push context stays PR-scoped.
    RESOLVED_EVENT_MODE="pull_request"
    RESOLVED_BASE_SHA="${PR_BASE_SHA}"
    RESOLVED_HEAD_SHA="${PR_HEAD_SHA}"
  elif [ -n "${MERGE_GROUP_BASE_SHA:-}" ] && [ -n "${MERGE_GROUP_HEAD_SHA:-}" ]; then
    # merge_group — the merge queue built base_sha..head_sha; head_sha is the
    # temporary merge commit of the queued PR(s) on top of base_sha (the exact
    # fork point, so no drift to correct for).
    RESOLVED_EVENT_MODE="merge_group"
    RESOLVED_BASE_SHA="${MERGE_GROUP_BASE_SHA}"
    RESOLVED_HEAD_SHA="${MERGE_GROUP_HEAD_SHA}"
  elif [ "${EVENT_NAME:-}" = "push" ] && [ -n "${PUSH_BEFORE_SHA:-}" ] && \
       [ "${PUSH_BEFORE_SHA}" != "${zero_sha}" ] && \
       git cat-file -e "${PUSH_BEFORE_SHA}^{commit}" 2>/dev/null; then
    # push — the commits this push added (before..sha). `before` is the zero
    # SHA on a branch-creation push, and may be unreachable after a
    # force-push / shallow fetch; either case falls through to `none`.
    RESOLVED_EVENT_MODE="push"
    RESOLVED_BASE_SHA="${PUSH_BEFORE_SHA}"
    RESOLVED_HEAD_SHA="${PUSH_HEAD_SHA}"
  fi
}

resolve_diff_range

# When EXECUTED directly (not sourced) — e.g. by the unit test — echo the
# resolution as `KEY=value` lines so the truth table is assertable without a
# GitHub runner. `BASH_SOURCE[0] == $0` iff the file was run, not sourced.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  printf 'RESOLVED_EVENT_MODE=%s\n' "${RESOLVED_EVENT_MODE}"
  printf 'RESOLVED_BASE_SHA=%s\n' "${RESOLVED_BASE_SHA}"
  printf 'RESOLVED_HEAD_SHA=%s\n' "${RESOLVED_HEAD_SHA}"
fi
