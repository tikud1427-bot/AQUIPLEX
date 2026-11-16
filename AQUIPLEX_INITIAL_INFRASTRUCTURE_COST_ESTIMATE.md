# AQUIPLEX — Initial Infrastructure Cost Estimate (Phase 4B)

Date 2026-11-15. **No billable resource was created.** This is a planning
estimate. It is **not** a quote, and it **does not** claim how many users any
configuration supports: capacity comes from the Phase 6 load test.

## 0. Price basis and how reliable it is

Google's own pricing pages could not be read by the tools available here (the
fetched pages were truncated). The rates below come from search results:
Google's documentation snippets where available, otherwise third-party price
aggregators. **Every number must be checked in the Google Cloud pricing
calculator for the chosen region before budgeting.**

| Item | Rate used | Source quality |
|------|-----------|----------------|
| Cloud Run, instance-based billing (CPU always allocated) | $0.000018 / vCPU-s; $0.000002 / GiB-s; free 240,000 vCPU-s + 450,000 GiB-s per month | Google pricing snippet |
| Cloud Run, request-based billing | $0.000024 / vCPU-s; $0.0000025 / GiB-s; $0.40 / million requests; free 180,000 vCPU-s, 360,000 GiB-s, 2 M requests | most sources; one 2026 source claims lower rates (unverified) |
| Cloud Run worker pools | **assumed** = instance-based rates | **unverified** |
| Cloud SQL PostgreSQL Enterprise (dedicated core, zonal) | $0.0413 / vCPU-h; $0.0070 / GiB-h; HA ≈ 2× compute | Google billing doc snippet; HA from Bytebase |
| Cloud SQL shared core | db-f1-micro ≈ $8–11 / month; db-g1-small ≈ $24–26 / month (instance only; **no SLA**) | third-party (Bytebase and others) |
| Cloud SQL SSD storage | $0.17 / GB-month (HA ≈ $0.34) | Google snippet; one source says $0.22 |
| Cloud SQL backups | ≈ $0.08 / GB-month | **assumption** |
| Cloud Storage Standard (regional) | ≈ $0.020 / GB-month; Class A ≈ $0.05 / 1,000; Class B ≈ $0.004 / 10,000 | **general knowledge, unverified** |
| Internet egress | ≈ $0.12 / GB (premium tier, first tier) | **general knowledge, unverified** |
| Cloud Logging | $0.50 / GiB ingested beyond **50 GiB free per project per month**; $0.01 / GiB-month retained beyond 30 days | Google snippet |
| Secret Manager | ≈ $0.06 / active secret version / month + ≈ $0.03 / 10,000 accesses | **assumption** |
| Artifact Registry (images) | ≈ $0.10 / GB-month beyond 0.5 GB | **assumption** |

**Not included:**
- AI provider spend: Groq, Gemini, NVIDIA, embeddings. Today these are free
  tiers; at scale they are likely to be the largest cost.
- Mongo hosting (stays where it is).
- Razorpay fees.
- Domain and e-mail sending (Resend).
- Taxes.
- Committed-use discounts.

## 1. Unit costs derived (730 h month)

| Unit | Monthly |
|------|---------|
| 1 always-on Cloud Run instance, 1 vCPU / 1 GiB (instance-based) | 2,628,000 s × ($0.000018 + $0.000002) ≈ **$52.6** |
| …the free tier offsets once per billing account | ≈ −$5.2 |
| 1 Cloud Run instance, 0.5 vCPU / 512 MiB, always on | ≈ $26.3 |
| Cloud SQL 1 vCPU / 3.75 GiB, zonal | 730 × (0.0413 + 3.75 × 0.007) ≈ **$49.3** |
| Cloud SQL 1 vCPU / 3.75 GiB, HA | ≈ $98.6 |
| Cloud SQL 2 vCPU / 7.5 GiB, HA | 730 × (2 × 0.0826 + 7.5 × 0.0140) ≈ **$197** |

## 2. Scenarios

**These are assumed shapes, not capacity statements.**

### A. Staging (pre-launch testing)

| Component | Assumption | Fixed / usage | Monthly |
|-----------|------------|---------------|---------|
| API | request-based billing, min 0 instances (idle costs nothing), light test traffic | usage | $0–5 |
| Worker | 1 × 0.5 vCPU / 512 MiB, always on (worker pool; rates assumed) | fixed | ≈ $26 |
| Cloud SQL | db-f1-micro or db-g1-small, 10 GB SSD, backups | fixed | ≈ $12–30 |
| GCS | < 5 GB | usage | < $0.50 |
| Logs, monitoring | < 50 GiB / month | usage | $0 (free tier) |
| Secrets, registry | ~15 secrets, 1–2 GB images | fixed | ≈ $1–1.5 |
| **Total** | | | **≈ $40–65 / month** |

### B. Early production (initial launch)

| Component | Assumption | Fixed / usage | Monthly |
|-----------|------------|---------------|---------|
| API | 1 instance always on (min 1), CPU always allocated; bursts to a 2nd instance ~20 % of the time | fixed ~$53 + usage ~$10 | ≈ $63 |
| Worker | 1 × 1 vCPU / 1 GiB always on | fixed | ≈ $53 |
| Cloud SQL | 1 vCPU / 3.75 GiB **zonal**; 20 GB SSD; backups ~20 GB | fixed | ≈ $54 |
| …or with HA (recommended once there are paying users) | | fixed | ≈ $108 |
| GCS | 10 GB artifacts; light operations | usage | ≈ $0.50 |
| Egress | 20 GB (chat responses are small; artifact downloads dominate) | usage | ≈ $2.40 |
| Logs | 20–40 GiB (`[JOB]`, `[TURN]`, `[WORKER]` lines) | usage | $0 (within 50 GiB) |
| Secrets, registry | | fixed | ≈ $1.50 |
| **Total** | | | **≈ $175 (zonal) – $230 (HA) / month** |

### C. Growth

| Component | Assumption | Fixed / usage | Monthly |
|-----------|------------|---------------|---------|
| API | average 3 instances (min 2), CPU always allocated | fixed ~$105 + usage ~$55 | ≈ $160 |
| Workers | 2 × 1 vCPU / 1 GiB always on | fixed | ≈ $105 |
| Cloud SQL | 2 vCPU / 7.5 GiB HA; 100 GB SSD (HA rate); backups ~100 GB | fixed | ≈ $197 + $34 + $8 ≈ $239 |
| GCS | 200 GB; heavier operations | usage | ≈ $5 |
| Egress | 200 GB | usage | ≈ $24 |
| Logs | 150 GiB / month | usage | (150 − 50) × $0.50 ≈ $50 |
| Monitoring, secrets, registry | | mixed | ≈ $5 |
| **Total** | | | **≈ $590 / month** |

## 3. Fixed versus usage-based

| Fixed (paid whether or not anyone uses it) | Usage-based |
|--------------------------------------------|-------------|
| API minimum instances (always-on CPU) | API instances above the minimum |
| Worker instances | Requests (request-based billing only) |
| Cloud SQL instance, storage, HA, backups | Egress (artifact downloads) |
| Secret versions; registry storage | Logging beyond 50 GiB / month |
| | GCS storage growth and operations |
| | **AI provider calls (not estimated)** |

In scenarios A–C, **Cloud SQL and always-on instances are 80–95 % of the
infrastructure bill.** The levers are:
- right-sizing Cloud SQL after the load test;
- request-based CPU for the API, if the staging experiment supports it
  (configuration plan §6);
- committed-use discounts once usage is steady.

## 4. Backup and recovery costs

| Item | Assumption | Monthly |
|------|------------|---------|
| Cloud SQL automated backups (7 retained) + point-in-time recovery logs | ≈ the database size again | early ≈ $1.60, growth ≈ $8 (at $0.08/GB, unverified) |
| GCS soft delete (7 days) | deleted bytes kept 7 days | negligible at these sizes |
| Migration exports (30-day retention, Artifact Migration Readiness §2.4) | one-off: history + artifacts copy | < $1 for a few GB |
| Cross-region disaster recovery (replica or backup copies) | not included | +≈ 1× Cloud SQL compute if adopted |

## 5. What would change these numbers

- **Region.** An India region (closer to users if they are mostly there) has
  different rates. Re-run in the calculator.
- **Load-test results** (Phase 6): instance counts, Cloud SQL tier, connection
  limits.
- **Request-based versus always-allocated CPU** for the API.
- **Log verbosity.** The structured lines are deliberately compact. Disable
  `AQUA_JOB_LOG` if ingestion approaches the free tier without need.
- **AI provider choice**, which is outside this estimate and likely dominant.

## Sources consulted

- [Cloud Run pricing](https://cloud.google.com/run/pricing) (snippets via search; the page itself could not be fetched)
- [Cloud Run billing settings for services](https://docs.cloud.google.com/run/docs/configuring/cpu-allocation)
- [Cloud SQL pricing](https://cloud.google.com/sql/pricing) and [billing doc](https://cloud.google.com/sql/docs/billing)
- [Bytebase Cloud SQL pricing](https://www.bytebase.com/dbcost/cloudsql-pricing/), [db-f1-micro](https://www.bytebase.com/dbcost/cloudsql/instance/db-f1-micro/), [db-g1-small](https://www.bytebase.com/dbcost/cloudsql/instance/db-g1-small/)
- [Google Cloud Observability pricing](https://cloud.google.com/monitoring/pricing)
- [Cloud Run worker pools](https://docs.cloud.google.com/run/docs/deploy-worker-pools) and [YAML reference](https://docs.cloud.google.com/run/docs/reference/yaml/v1)
- [Cloud Run execution environments](https://docs.cloud.google.com/run/docs/about-execution-environments)
