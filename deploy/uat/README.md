# Production UAT evidence — epic #193 (Phase 2)

One file per child ticket, `phase2-<ticket>.md`, holding the evidence the epic's
Acceptance Criteria ask for: run ids, journal lines, engine rows, command outputs.
Recorded against the live execution box after each ticket's deploy. Evidence from
any non-BeAutomata organisation is reduced to run ids, tenant ids and timestamps
(the repository is public).

| Ticket                     | Issue | File                                    |
| :------------------------- | :---- | :-------------------------------------- |
| 1 — per-run memory ceiling | #204  | recorded in #204 / `docs/adr/ADR-007-…` |
| 2 — counting box slots     | #205  | [phase2-2.md](phase2-2.md)              |
| 3 — headroom admission     | #371  | [phase2-3.md](phase2-3.md)              |
| 3 — headroom check         | #371  | phase2-3.md                             |
| 4 — env-driven caps        | #372  | phase2-4.md                             |
| 5 — growth triggers        | #373  | phase2-5.md                             |
| 6 — tenant map             | #374  | phase2-6.md                             |
| 7 — fleet enrollment       | #375  | phase2-7.md                             |
| 8 — ADR-002 Rev 4          | #376  | phase2-8.md                             |

The automated suites that gate each PR are in `docs/uat/` and CI; these files are
the production half.
