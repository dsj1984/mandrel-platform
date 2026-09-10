#!/usr/bin/env bash
# select-semgrep-python.sh — choose the interpreter the pr-quality SAST step
# builds its Semgrep venv from, and refuse to run on one that is too old
# (Story #482).
#
# WHY THIS EXISTS
# ---------------
# The SAST step installs Semgrep two ways: a hash-pinned closure from
# `scripts/semgrep-requirements.txt` on Linux/cp312, and the bare top pin
# everywhere else. That second branch is deliberate — it is where a Python
# roll-FORWARD degrades to, so a CI image moving to 3.13 goes
# unpinned-but-green rather than fleet-red on ABI-incompatible cp312 wheels.
#
# But it carried no floor of its own, so an interpreter that is too OLD
# hard-failed instead. semgrep raised `requires_python` to `>=3.10` at 1.137.0,
# and macOS ships `/usr/bin/python3` = 3.9.6, so every consumer on a macOS
# self-hosted runner with system Python went red on `ci-required` with nothing
# but pip's resolver error:
#
#   ERROR: Could not find a version that satisfies the requirement
#          semgrep==1.176.1 (from versions: ..., 1.135.0, 1.136.0)
#
# which reads like a network or registry problem and never names the
# interpreter as the cause (issue #480, observed in Beestera/swarm-os#2496).
#
# WHY IT DOES NOT JUST INSTALL AN OLDER SEMGREP
# ---------------------------------------------
# Resolving "the newest semgrep this interpreter supports" is the obvious fix
# and it is a security regression. The newest release supporting Python 3.9 is
# 1.136.0, which hard-pins `opentelemetry-*~=1.25.0`; `opentelemetry-proto` at
# that version requires `protobuf<5.0`, and EVERY protobuf 4.x is affected by
# CVE-2026-0994 (CVSS 8.2) — the advisory cleared by the 1.176.1 bump
# (#477/#472). The same downgrade drags back `opentelemetry-instrumentation`
# 0.46b0, whose `pkg_resources` import is why `setuptools` used to be in the
# closure at all. And because THIS install path is deliberately not
# hash-pinned and its closure is not OSV-scanned, the downgrade would be
# silent. So the floor fails closed: a usable interpreter or a named error,
# never a quieter, older Semgrep.
#
# CONTRACT
# --------
# SOURCE this file (do NOT exec it) from a `shell: bash` step, BEFORE the venv
# is created — the venv inherits whichever interpreter builds it, so a check
# made afterwards is already too late.
#
#   Inputs (read from the caller's shell / the step `env:` block):
#     SEMGREP_PIN          = the exact pip requirement the step installs,
#                            e.g. `semgrep==1.176.1` (diagnostics only)
#     SEMGREP_PYTHON_FLOOR = minimum `major.minor`, e.g. `3.10` — semgrep's
#                            own `requires_python` for the pinned version
#     SEMGREP_LOCKFILE_ABI = optional `major.minor` the hash-pinned lockfile
#                            was resolved for, e.g. `3.12` (Story #495)
#
#   Outputs (set on the caller's shell):
#     SEMGREP_PYTHON         = the interpreter to build the venv with
#     SEMGREP_PYTHON_VERSION = its `major.minor`
#
# PROBE ORDER
# -----------
# `python3` first, so a compliant runner behaves exactly as it did before this
# file existed, then the versioned names newest-first.
#
# On LINUX with SEMGREP_LOCKFILE_ABI set, the interpreter matching that ABI is
# probed FIRST instead. That ordering is what keeps the fleet on the
# hash-pinned install: the lockfile's wheels are cp312-only, so the moment a
# CI image rolls its bare `python3` to 3.13 the default order silently routes
# every consumer onto the un-hash-pinned, un-OSV-scanned fallback while a
# perfectly good `python3.12` sits unused on the same PATH. The ABI candidate
# is not privileged beyond order — it still has to clear the floor, and a
# runner that simply does not have it falls through to the normal list.
# Darwin keeps the plain order: no darwin hashes are generated, so there is no
# ABI worth steering toward.
#
# The OS is read through a bare `uname` resolved on PATH rather than a builtin,
# which is what lets the unit suite hand this script a Linux or a Darwin
# runner deterministically from a fixture directory.
#
# Returns non-zero after emitting a `::error::` when nothing on PATH qualifies;
# under the caller's `set -e` that fails the step.

_semgrep_python_probe() {
  # Echo "<major> <minor>" for the interpreter named by $1, or return non-zero
  # when it is absent from PATH or not a runnable interpreter.
  local cmd="$1"
  command -v "${cmd}" >/dev/null 2>&1 || return 1
  "${cmd}" -c 'import sys; print("%d %d" % sys.version_info[:2])' 2>/dev/null
}

_semgrep_is_uint() {
  # True when $1 is a non-empty run of digits. Used to validate BOTH fields of
  # a `major.minor` input before either reaches `[ ... -ge ... ]`, which is
  # where a non-numeric field would otherwise die as bash's own
  # "integer expression expected" — a message that names the shell rather than
  # the offending value.
  case "$1" in
    "" | *[!0-9]*) return 1 ;;
  esac
  return 0
}

_semgrep_fail() {
  # GitHub parses workflow commands out of the step's output, so the
  # `::error::` annotation goes to stdout. The same text is mirrored to stderr
  # WITHOUT that prefix — so the runner does not raise the annotation twice —
  # because a caller that captures only the error stream (a shell redirect, or
  # this script's unit suite) would otherwise be handed an empty reason.
  printf '::error::%s\n' "$1"
  printf '%s\n' "$1" >&2
}

_semgrep_python_candidates() {
  # Echo the probe order for this runner, space-separated. The bare `uname` is
  # resolved on PATH on purpose (see the header): a fixture shim can then
  # supply the OS, which is the only way the Linux-only branch below is
  # testable off a Linux host.
  local abi="${SEMGREP_LOCKFILE_ABI:-}"
  local default_order="python3 python3.13 python3.12 python3.11 python3.10"
  local os abi_major abi_minor

  os="$(uname -s 2>/dev/null || true)"
  [ "${os}" = "Linux" ] || {
    printf '%s' "${default_order}"
    return 0
  }

  abi_major="${abi%%.*}"
  abi_minor="${abi#*.}"
  abi_minor="${abi_minor%%.*}"
  # An unset or malformed ABI is NOT an error: the lockfile is an optimisation
  # on this path, and the floor below is the thing that actually fails closed.
  if [ -z "${abi}" ] || [ "${abi}" = "${abi_major}" ] ||
    ! _semgrep_is_uint "${abi_major}" || ! _semgrep_is_uint "${abi_minor}"; then
    printf '%s' "${default_order}"
    return 0
  fi

  printf '%s' "python${abi_major}.${abi_minor} ${default_order}"
}

select_semgrep_python() {
  local floor="${SEMGREP_PYTHON_FLOOR:-}"
  local pin="${SEMGREP_PIN:-<unset>}"
  local floor_major floor_minor cmd probe major minor system_python candidates

  SEMGREP_PYTHON=""
  SEMGREP_PYTHON_VERSION=""

  floor_major="${floor%%.*}"
  floor_minor="${floor#*.}"
  floor_minor="${floor_minor%%.*}"

  # A missing or malformed floor must not silently degrade to "anything goes":
  # that is the exact fail-open this file exists to close. Both fields are
  # validated as WHOLE integers. A shape test like `[0-9]*.[0-9]*` pins only
  # the FIRST character of each field, so a typo such as `3.1O` (letter O)
  # passes it, survives to `[ "${minor}" -ge "1O" ]`, and fails there with
  # bash's "integer expression expected" — after which the loop falls through
  # and the step blames the runner's interpreters for a typo in its own input.
  if [ -z "${floor}" ] || [ "${floor}" = "${floor_major}" ] ||
    ! _semgrep_is_uint "${floor_major}" || ! _semgrep_is_uint "${floor_minor}"; then
    _semgrep_fail "SEMGREP_PYTHON_FLOOR is unset or malformed ('${floor}') — it must be a major.minor version such as 3.10, both fields whole numbers. Without it this step cannot tell whether the runner's Python is new enough to install ${pin}, and it will not guess."
    return 1
  fi

  # Reported in the failure message: the interpreter a consumer would expect to
  # be used, so the error names what they actually have rather than only what
  # is required.
  system_python="absent"

  # Probe order — ABI-first on Linux when the lockfile's ABI is known, the
  # historical order everywhere else. See the header's PROBE ORDER section.
  candidates="$(_semgrep_python_candidates)"

  # shellcheck disable=SC2086  # deliberate word-splitting: the candidate list
  # is this file's own space-separated output, never user input.
  for cmd in ${candidates}; do
    probe="$(_semgrep_python_probe "${cmd}")" || continue
    read -r major minor <<<"${probe}"
    [ -n "${major:-}" ] && [ -n "${minor:-}" ] || continue
    if [ "${cmd}" = "python3" ]; then
      system_python="${major}.${minor}"
    fi
    # Compare major and minor as SEPARATE integers. A concatenated "${major}${minor}"
    # compares wrong across the tens boundary — "39" sorts above "310" as a
    # string, and as an integer 39 is below 310 only by accident of digit count.
    if [ "${major}" -gt "${floor_major}" ] ||
      { [ "${major}" -eq "${floor_major}" ] && [ "${minor}" -ge "${floor_minor}" ]; }; then
      SEMGREP_PYTHON="${cmd}"
      SEMGREP_PYTHON_VERSION="${major}.${minor}"
      echo "Semgrep interpreter: ${cmd} (Python ${SEMGREP_PYTHON_VERSION}); floor ${floor} for ${pin}."
      return 0
    fi
  done

  _semgrep_fail "${pin} requires Python >= ${floor}, but no interpreter on this runner's PATH satisfies it (python3 is ${system_python})."
  echo "Probed, in order: ${candidates}."
  echo "Remedy: put a Python >= ${floor} earlier on the runner's PATH than /usr/bin — e.g. 'brew install python@3.12' plus a python3 symlink in a directory the runner's .path lists first — or set 'enable-sast: false' to skip the Semgrep sub-step."
  echo "Semgrep is deliberately NOT downgraded to fit an older interpreter: the newest release supporting Python 3.9 (1.136.0) pins opentelemetry ~=1.25.0, which caps protobuf below 5.0, and every protobuf 4.x is affected by CVE-2026-0994 (CVSS 8.2). This install path is not hash-pinned and its closure is not OSV-scanned, so the downgrade would be silent."
  return 1
}

# When EXECUTED directly (not sourced) — e.g. by the unit test — echo the
# selection as `KEY=value` lines and exit with the selection's own status, so
# both the happy path and the fail-closed path are assertable without a
# GitHub runner. `BASH_SOURCE[0] == $0` iff the file was run, not sourced.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  if select_semgrep_python; then
    printf 'SEMGREP_PYTHON=%s\n' "${SEMGREP_PYTHON}"
    printf 'SEMGREP_PYTHON_VERSION=%s\n' "${SEMGREP_PYTHON_VERSION}"
    exit 0
  fi
  exit 1
fi

select_semgrep_python
