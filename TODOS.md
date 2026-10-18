# TODOS

Design debt raised by a design review of the supersedePolicy settings UI on
2026-08-23. Open items only; each says what is already true of the system and
what is actually missing.

- [x] **Document the design system (DESIGN.md).** Done: DESIGN.md (Ops Desk, 2026-10-16). No documented design system exists, so every new screen calibrates against universal principles instead of product decisions. Unblocks consistent future UI. Roughly a one-hour session; blocks nothing. Depends on: nothing.
- [ ] **Audit-trail surface for policy changes.** The record already exists: each write to `apps/www/src/app/api/review-settings/[owner]/[repo]/route.ts` stamps `changed: Object.keys(patch)` so the trail carries the delta, not just the resulting row. What is missing is the view — no screen shows who changed which policy when. Design it once alongside the other audit surfaces (egress sink, broker audit), as an org-level audit page or an expandable row. Depends on: a unified audit-surface decision.
- [ ] **Supersede line in the published review summary.** Proposed, not yet built: when a run supersedes another under newest-wins, have the review that does get posted open with a line naming the superseded commit and the policy that dropped it. That reaches the GitHub-only reader without a second comment, since it travels inside the single-writer post. It does not cover discard mode. Touches the verdict template and needs review against the emit-only contract. Depends on: the supersedePolicy base implementation.

## Knowledge engine (deferred from the CEO review of the governed-truth slice, 2026-10-18)

- [ ] **Ask-the-truth Slack command.** It answers a question from approved claims, with citations. **Depends on:** the retrieval eval (recall@10 on real org questions) clearing its bar. Deferred because unmeasured answers contradict the governed-truth promise.
- [ ] **Jira and Confluence as claim sources.** These would extend connector snapshots beyond Slack. **Depends on:** an Atlassian site with a Confluence scope that we own. Deferred so the first loop isn't blocked; until then the "whole company" claim stays engineering plus Slack.
- [ ] **Session distill to assertions.** These are "why" anchors mined from agent transcripts, feeding memory promotion. Deferred to the second wave, after the first governed loop runs.
