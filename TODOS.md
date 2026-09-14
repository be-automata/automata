# TODOS

## Design debt (from /plan-design-review 2026-08-23 — supersedePolicy settings UI)

- [ ] **Run /design-consultation → DESIGN.md.** No documented design system exists; every new screen calibrates against universal principles instead of product decisions. Unblocks consistent future UI; ~1h session, blocks nothing. Depends on: nothing.
- [ ] **Audit-trail surface for policy changes.** The settings copy promises "cada cambio queda en el registro de auditoría" but no screen shows who changed which policy when. Design ONCE together with the other audit surfaces (egress sink, broker audit) — org-level audit page or expandable row. Depends on: unified audit-surface decision.
- [ ] **Supersede line in the published review summary.** When a run supersedes another (newest-wins), the review that IS posted opens with "Reemplaza la corrida de <sha> (política: más reciente)" — covers the GitHub-only dev without extra comments (travels inside the single-writer post). Does not cover discard mode. Touches the verdict template; review against the emit-only contract. Depends on: supersedePolicy base implementation.
