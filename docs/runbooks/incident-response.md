# Incident Response Runbook

> **Type:** Common / Process-level
> **Scope:** Any project using the mandrel-platform model. Defines the severity classification, escalation path, response steps, and postmortem process for production incidents.
> **Project-specific values** (escalation contacts, Sentry project links, Better Stack URLs, on-call rotation) live in each consumer's local runbook that links here.

---

## 1. Severity Classification

| Severity | Definition | Target Response Time | Example |
|----------|-----------|---------------------|---------|
| **P1 — Critical** | Production is down or completely broken for all users. Revenue, data integrity, or security directly at risk. | Immediate (< 15 min) | Worker returning 500 on all requests; data breach suspected |
| **P2 — High** | Core feature broken for most users; significant degradation; security issue contained but active. | < 1 hour | Login flow failing; payment processing errors; > 5% 5xx rate |
| **P3 — Medium** | Partial degradation; non-core feature broken; workaround exists. | < 4 hours | Slow queries on one endpoint; non-critical API returning errors |
| **P4 — Low** | Minor issue; no immediate user impact; cosmetic or logging error. | Next business day | Missing a log line; a UI label is wrong; Sentry noise |

Severity is assigned by the first responder and may be upgraded or downgraded as the incident evolves.

---

## 2. Escalation Path

1. **First responder** (on-call or whoever notices the alert):
   - Acknowledge the alert in Better Stack / Sentry.
   - Open an incident issue in GitHub (label: `incident`, `severity::P1` / `P2` / etc.).
   - Begin investigation using the [Observability Runbook](observability.md).

2. **On-call lead** (P1/P2 only):
   - The first responder notifies the on-call lead via the project's escalation channel (see `docs/environments.md` for contact details).
   - The lead takes command of the incident: owns the incident issue, coordinates responders, decides on rollback.

3. **Stakeholders** (P1 only):
   - On-call lead notifies stakeholders via the designated channel within 30 minutes of a P1 declaration.
   - Provide a one-sentence impact summary and an ETA for the next update.

> **On-call contact and channel details are project-specific.** See the project's local incident-response runbook (linked from `docs/environments.md`) for handles, Slack/email channels, and paging procedures.

---

## 3. Response Steps

### 3a. Detect & Declare

1. Alert fires (Better Stack, Sentry, or user report).
2. First responder acknowledges within 15 minutes (P1) / 1 hour (P2).
3. Open an incident issue:
   ```
   Title: [P1] <Short description of the problem> — <date>
   Labels: incident, severity::P1, status::open
   Body: (use the postmortem template below)
   ```
4. Classify severity. If unsure, classify higher and downgrade once more information is available.

### 3b. Investigate

1. Check for a recent deploy — if yes, **rollback first, investigate later** (P1/P2). Use the [Rollback Runbook](rollback.md).
2. Check Sentry for error rate and stack traces.
3. `wrangler tail` for live log stream.
4. Check the Cloudflare dashboard for Worker CPU time, error counts, and request volume.
5. Check the database (Turso dashboard or `turso db shell`) for query errors or connectivity issues.
6. Check upstream dependencies (Clerk, external APIs) for incidents on their status pages.

### 3c. Mitigate

Apply the fastest fix that restores service — this may not be the root-cause fix:

- **Rollback** if a deploy is the likely cause. See [Rollback Runbook](rollback.md).
- **Feature flag off** if the incident is scoped to a feature with a flag.
- **Rate limit or block** if the incident is traffic-driven (DDoS, scraper).
- **Secret rotation** if a security incident is suspected. See [Secret Rotation Runbook](secret-rotation.md).

Update the incident issue with the mitigation applied and the time.

### 3d. Resolve

1. Confirm the health endpoint returns 2xx and error rate has returned to baseline.
2. Monitor for 15 minutes post-mitigation before declaring resolved.
3. Update the incident issue: change label to `status::resolved`, record the resolution time.
4. Notify stakeholders that the incident is resolved (P1/P2).

### 3e. Post-Incident (Postmortem)

For P1 and P2 incidents, complete a blameless postmortem within 48 hours:

- Timeline of events (detect → declare → mitigate → resolve).
- Root cause (the deepest technical reason, not the trigger).
- Impact (users affected, duration, data affected if any).
- What went well (detections that worked, rollback that fired, escalation that was smooth).
- What went poorly (detection gaps, slow escalation, wrong hypothesis).
- Action items (each with an owner and due date, linked to a GitHub issue).

Use the [Postmortem Template](#postmortem-template) in this runbook.

---

## 4. Communication Templates

### Initial stakeholder notification (P1)

```
Subject: [P1 INCIDENT] <Project> — <short description>
Time: <UTC timestamp>
Impact: <One sentence — who is affected and how badly>
Status: Investigating / Mitigating
ETA for next update: <30 minutes from now>
Incident issue: <GitHub issue URL>
```

### Resolution notification

```
Subject: [RESOLVED] <Project> — <short description>
Time resolved: <UTC timestamp>
Duration: <N minutes>
Impact: <Who was affected, how badly>
Cause: <One sentence — root cause or "Under investigation for postmortem">
Next steps: Postmortem will be completed by <date>
```

---

## 5. Postmortem Template

Copy into the GitHub incident issue body:

```markdown
## Postmortem — [P1/P2] <Title>

**Date:** <YYYY-MM-DD>
**Severity:** P1 / P2
**Duration:** <start time> → <end time> (UTC)
**Author:** <@handle>

### Impact

<Who was affected, approximate user count, data impact if any, revenue impact if quantifiable>

### Timeline

| UTC | Event |
|-----|-------|
| HH:MM | Alert fired / issue noticed |
| HH:MM | First responder acknowledged |
| HH:MM | Incident declared (severity assigned) |
| HH:MM | Mitigation applied (rollback / flag / etc.) |
| HH:MM | Service confirmed restored |
| HH:MM | Incident closed |

### Root Cause

<The deepest technical reason — not "a bad deploy" but the specific bug, config gap, or process failure that caused the bad deploy to escape>

### What Went Well

- <Detection that worked>
- <Escalation that was smooth>
- <Rollback that fired correctly>

### What Went Poorly

- <Detection gap>
- <Slow escalation>
- <Wrong hypothesis that cost time>

### Action Items

- [ ] <Action> — @owner — due <date> — #<issue>
- [ ] <Action> — @owner — due <date> — #<issue>
```

---

## 6. Incident Response Checklist

- [ ] Alert acknowledged within SLA (P1: 15 min, P2: 1 hr).
- [ ] Incident issue opened with severity label.
- [ ] On-call lead notified (P1/P2).
- [ ] Stakeholders notified (P1, within 30 min).
- [ ] Root cause hypotheses prioritized — checked recent deploys first.
- [ ] Mitigation applied and health endpoint confirmed green.
- [ ] Incident issue updated with resolution time.
- [ ] Postmortem scheduled (P1/P2 — within 48 hours).
- [ ] Action items opened as GitHub issues with owners.

---

## See Also

- [Rollback Runbook](rollback.md)
- [Observability Runbook](observability.md)
- [Secret Rotation Runbook](secret-rotation.md) — for security incidents.
- [SLO Runbook](slo.md) — for error-budget context and rollback triggers.
- Project-local incident-response runbook — on-call contacts, escalation channels, paging procedures.
