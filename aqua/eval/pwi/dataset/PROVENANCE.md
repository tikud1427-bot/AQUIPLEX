# pwi-v1 dataset — provenance

| Field | Value |
|---|---|
| File | `pwi-v1.json` |
| SHA-256 | `23706af21821f34e9c6c92443fe09011fcb98a03c5f9d46a2a003e1187ab001c` |
| Frozen | 2026-11-15T13:55:36Z (before the first benchmark run; no run output existed when the labels were written) |
| Author | Claude (Opus 5.5), the same agent that implemented PWI Phase 1, in the founder-authorised Phase 2 session |
| Personas | 4 synthetic users (p1 founder, p2 teacher/PhD, p3 freelance designer, p4 engineer with side project), all names and organisations invented |
| Size | 57 events (51 statements, 4 document uploads, 2 Memory-page actions) over 47 slots; 32 probes asked at 1–3 stages = 75 probe instances (counted by script) |

## How the labels were made

Labels by construction: every event carries its effects on the user's world
(`set`, `add`, `remove`, `end`, `correct`, `delete`, `hedge`, `sensitive`),
and `truth.mjs` replays them to obtain the truth at each stage. Probes name
slots, not expected strings; the required and forbidden strings are derived
from the replayed truth. No label was derived from, or adjusted to, Aqua's output.

## Independence — limits, stated plainly

- **Not independently labelled by a separate person.** The author knows the
  system (it audited it the same day) and has seen parts of the extraction
  patterns (e.g. "blocked on", "by <date>"). Sentences were written as a user
  would say them, not tuned to patterns, but this cannot be proven.
- Mitigations: labels are mechanical consequences of the script; the file is
  frozen by hash before any run; any later change requires a new version
  (pwi-v2), never an edit of v1.
- Recommended before thresholds become a release gate: an independent reviewer
  checks every event's effects and every probe (ACIB v3 governance tooling,
  `eval/governance/`, already supports reviewer sign-off).

## Changelog

- v1 (this file): initial.
