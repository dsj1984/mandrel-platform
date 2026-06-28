# SLO (Service Level Objectives) Runbook

> **Type:** Common / Process-level
> **Scope:** Any project using the mandrel-platform model. Defines the SLO framework, the canonical SLO targets for a Cloudflare Workers API/web service, and the error-budget burn procedures.
> **Project-specific values** (actual SLO targets, health endpoint URLs, Better Stack monitor names) live in each consumer's local runbook that links here.

---

## 1. SLO Framework

An **SLO (Service Level Objective)** is a target reliability level for a service. A **SLI (Service Level Indicator)** is what you measure. An **SLA (Service Level Agreement)** is a contract with users or customers that references SLOs.

```
SLA ──► SLO ──► SLI
(contract)  (target)  (measurement)
```

### Error Budget

The **error budget** is the allowable amount of unreliability implied by the SLO. If your SLO is 99.9% availability over 30 days, your error budget is 0.1% of 30 days = **43.2 minutes of downtime per month**.

When the error budget is exhausted:
- **Stop non-critical deploys** until the budget resets.
- **Prioritize reliability work** over feature work.
- **Review recent incidents** to address root causes.

---

## 2. Canonical SLO Targets

These are the recommended defaults for a Cloudflare Workers deployment. Consumer projects may tighten or loosen these based on their service tier, customer commitments, and observed reliability.

| Service | SLI | Target (SLO) | Error Budget (30-day) |
|---------|-----|-------------|----------------------|
| API (health endpoint) | Availability (HTTP 2xx from synthetic probe) | 99.9% | 43.2 min |
| API (requests) | Success rate (non-5xx / total requests) | 99.5% | 3.6 hr |
| API (response time) | P99 latency < 2000 ms | 99.0% | 7.2 hr |
| Web (health endpoint) | Availability (HTTP 2xx from synthetic probe) | 99.9% | 43.2 min |
| Web (page load) | P90 LCP < 2500 ms | 95.0% | 36 hr |

> **MVP posture:** Start with availability SLOs only (the first two rows). Add latency and performance SLOs once you have baseline data from at least 30 days of production traffic.

---

## 3. Measuring SLIs

### 3a. Availability (synthetic probe — Better Stack)

Better Stack probes the health endpoint every 30 seconds. Uptime percentage is calculated as:

```
availability = (total_checks - failed_checks) / total_checks × 100
```

View in the Better Stack dashboard (URL in project `docs/environments.md`).

### 3b. Success rate (Cloudflare Analytics Engine)

```bash
# Query AE for 5xx rate over the last 30 days
curl -s "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/analytics_engine/sql" \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  --data "
    SELECT
      countIf(blob4 >= '500') AS errors,
      count() AS total,
      round(100 * (1 - countIf(blob4 >= '500') / count()), 3) AS success_rate
    FROM <AE_DATASET>
    WHERE timestamp > now() - INTERVAL '30' DAY
  "
```

### 3c. P99 latency (Cloudflare Analytics Engine)

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/analytics_engine/sql" \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  --data "
    SELECT quantileTDigest(0.99)(toFloat64OrNull(blob5)) AS p99_latency_ms
    FROM <AE_DATASET>
    WHERE timestamp > now() - INTERVAL '30' DAY
  "
```

---

## 4. Error Budget Tracking

### 4a. Monthly review

At the start of each month, review the prior month's SLIs against the SLO targets:

1. Pull availability from Better Stack (monthly report).
2. Query AE for success rate and P99 latency.
3. Calculate error budget consumption:
   ```
   budget_used_minutes = (1 - actual_availability) × 30 × 24 × 60
   budget_remaining_pct = 1 - budget_used_minutes / budget_total_minutes
   ```
4. Record the result in the project's SLO log (see `docs/environments.md`).

### 4b. Real-time error budget burn

During an ongoing incident, estimate the budget burn rate:

```
burn_rate = current_error_rate / (1 - slo_target)
```

A burn rate > 1 means the budget is being consumed faster than the SLO window allows. A burn rate > 14.4 means the monthly budget will be exhausted in < 2 hours. Trigger rollback immediately at burn rate > 14.4.

---

## 5. Error Budget Policy

| Budget remaining | Action |
|-----------------|--------|
| > 50% | Normal operations; feature deploys allowed. |
| 25%–50% | Deploy with extra caution; ensure rollback plan is documented before each deploy. |
| 10%–25% | No non-critical deploys without on-call lead approval. Prioritize reliability work. |
| < 10% | **Deploy freeze** for non-critical features. All deploys require on-call lead sign-off. Reliability work takes priority over all feature work. |
| 0% (exhausted) | **Emergency freeze.** No deploys of any kind without VP/lead approval. Conduct incident review; address root causes before resuming normal cadence. |

---

## 6. Rollback Triggers Based on SLOs

Use the error-budget policy to decide when to roll back a deploy automatically:

| Signal | Threshold | Action |
|--------|-----------|--------|
| 5xx error rate (post-deploy, 5-minute window) | > 1% | Trigger rollback |
| Health endpoint non-2xx (post-deploy smoke) | Any failure after retries | Auto-rollback (wired in deploy workflow) |
| P99 latency spike (post-deploy, 10-minute window) | > 3× pre-deploy baseline | Consider rollback; page on-call |
| Error budget burn rate | > 14.4 | Rollback and page on-call |

These thresholds are the recommended defaults. Consumer projects should calibrate them to their observed baseline once they have 30 days of traffic data.

---

## 7. SLO Review Checklist (Monthly)

- [ ] Pulled Better Stack availability report for the prior month.
- [ ] Queried AE for success rate and P99 latency.
- [ ] Calculated error budget consumed vs. budget total.
- [ ] Recorded results in the project's SLO log.
- [ ] If budget < 25%: reviewed recent incidents and opened reliability action items.
- [ ] If budget < 10%: deploy freeze communicated to the team.
- [ ] SLO targets reviewed — still appropriate for the service tier?

---

## See Also

- [Incident Response Runbook](incident-response.md) — escalation and postmortem process.
- [Observability Runbook](observability.md) — how to query AE, Sentry, and Better Stack.
- [Rollback Runbook](rollback.md) — rollback procedure when error budget is burning.
- Project-local `docs/environments.md` — specific SLO targets, Better Stack monitor names, AE dataset name, SLO log location.
