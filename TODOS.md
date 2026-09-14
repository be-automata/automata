# TODOS

Design debt raised by a design review of the supersedePolicy settings UI on
2026-08-23. Open items only; each says what is already true of the system and
what is actually missing.

- [ ] **Document the design system (DESIGN.md).** No documented design system exists, so every new screen calibrates against universal principles instead of product decisions. Unblocks consistent future UI. Roughly a one-hour session; blocks nothing. Depends on: nothing.
- [ ] **Audit-trail surface for policy changes.** The record already exists: each write to `apps/www/src/app/api/review-settings/[owner]/[repo]/route.ts` stamps `changed: Object.keys(patch)` so the trail carries the delta, not just the resulting row. What is missing is the view — no screen shows who changed which policy when. Design it once alongside the other audit surfaces (egress sink, broker audit), as an org-level audit page or an expandable row. Depends on: a unified audit-surface decision.
- [ ] **Supersede line in the published review summary.** Proposed, not yet built: when a run supersedes another under newest-wins, have the review that does get posted open with a line naming the superseded commit and the policy that dropped it. That reaches the GitHub-only reader without a second comment, since it travels inside the single-writer post. It does not cover discard mode. Touches the verdict template and needs review against the emit-only contract. Depends on: the supersedePolicy base implementation.
