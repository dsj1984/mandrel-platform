# Incident Response — <PROJECT_NAME>

> **Thin local stub.** The canonical severity model, escalation flow, response
> steps, and postmortem template live in the mandrel-platform repo:
> [`docs/runbooks/incident-response.md`](https://github.com/dsj1984/mandrel-platform/blob/main/docs/runbooks/incident-response.md).
> This file only holds **<PROJECT_NAME>-specific contacts and links**.

---

## Escalation Contacts

| Role | Who | Channel |
|------|-----|---------|
| First responder / on-call | `<ONCALL_HANDLE>` | `<ONCALL_CHANNEL>` |
| On-call lead (P1/P2) | `<LEAD_HANDLE>` | `<LEAD_CHANNEL>` |
| Stakeholder notify (P1) | `<STAKEHOLDER_LIST>` | `<STAKEHOLDER_CHANNEL>` |

## Tooling Links

| Tool | URL |
|------|-----|
| Error tracking (Sentry) | `<SENTRY_PROJECT_URL>` |
| Uptime (Better Stack) | `<BETTERSTACK_URL>` |
| Status page | `<STATUS_PAGE_URL>` |
| Incident issue label | `incident`, `severity::P1` … |

## Severity SLAs (from canonical — confirm or override)

| Severity | Target response |
|----------|-----------------|
| P1 — Critical | < 15 min |
| P2 — High | < 1 hour |
| P3 — Medium | < 4 hours |
| P4 — Low | next business day |

## First Moves

1. Acknowledge the alert in `<BETTERSTACK_URL>` / `<SENTRY_PROJECT_URL>`.
2. Open an incident issue (`incident` + `severity::*`).
3. **Recent deploy? Rollback first** — see `rollback.md`.
4. Follow the full response steps in the canonical runbook.

## Project-Specific Notes

<!-- Paging procedures, escalation timeouts, known fragile subsystems. -->

- _TODO: fill in._

---

See also the local stubs: `rollback.md`, `observability.md`,
`secret-rotation.md`, and the project's `docs/environments.md`.
