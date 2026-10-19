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

## Governed agent plane: deferred by the 2026-10-18 CEO review

Scope decisions from the review of "Automata as a governed agent plane, boxes bundled".
Each item lists its re-entry trigger.

- [ ] **Agent Forge: own git core, GitHub as a projection.**
  - **Why:** answers the pilot's "less GitHub dependency" ask with shipped code instead of a roadmap.
  - **Context:** spikes 001–008 validated all of it, and the build guide is `.claude/skills/spike-findings-automata-platform/references/agent-forge-git.md`. Deferred because it is the largest independent build, and the pilot runs on GitHub through the credential broker.
  - **Re-entry:** a GitHub limit or outage blocks agents, or a buyer requires the dependency gone.
  - **Effort:** XL (human) / L (CC). **Priority:** P2. **Depends on:** the commercial checkpoint after M2.
- [ ] **Agency / white-label channel.**
  - **Why:** the distribution channel Agent37 grows on. It has no sub-accounts or billing pass-through, and our org hierarchy can supply both.
  - **Context:** a parent agency org with client sub-orgs, branding and usage roll-up. Needs the metering ledger (EXP-2) first.
  - **Re-entry:** the ledger has run for 4 weeks, and an agency asks.
  - **Effort:** L / M. **Priority:** P3. **Depends on:** metering ledger.
- [ ] **Stripe invoicing on the metering ledger.**
  - **Why:** self-serve paid conversion.
  - **Context:** the first client is invoiced by hand at an interim flat pilot fee.
  - **Re-entry:** a second paying customer signs.
  - **Effort:** M / S. **Priority:** P3. **Depends on:** metering ledger, pricing levels.
- [ ] **BYOC and Agent37 box providers behind the box-provider seam.**
  - **Why:** the customer's own cloud for regulated buyers, and a commodity box supplier.
  - **Context:** the seam ships in M3 with our Hetzner as provider #1.
  - **Re-entry:** the capacity gate fails, or a buyer requires BYOC.
  - **Effort:** M / S each. **Priority:** P3. **Depends on:** box-provider seam (M3).
- [ ] **Pricing levels (platform fee and metered units).**
  - **Why:** turns pilot evidence into a price.
  - **Context:** set from at least 4 weeks of ledger data, plus full cost per scope and approval minutes (the pilot exit metrics).
  - **Re-entry:** the commercial checkpoint data is in.
  - **Effort:** S / S. **Priority:** P2. **Depends on:** commercial checkpoint after M2.

## Governed agent plane: deferred by the 2026-10-18 eng review

- [ ] **Web approval queue for knowledge ops.**
  - **Why:** an overview and batch approval once Slack volume gets high.
  - **Context:** M1 approves in Slack only (eng D3). The org integrations page already shows a queue count.
  - **Re-entry:** more than 50 pending items for an org, or a partner request.
  - **Effort:** M / S. **Priority:** P3. **Depends on:** M1 shipped.
- [ ] **Knowledge MCP in the review lane.**
  - **Why:** reviews could check claims against company knowledge.
  - **Context:** M2 attaches the knowledge MCP to task runs only (eng D8). The classic review policy is an ADR-004 byte-for-byte golden, and review comments are public on public repos, so this needs a disclosure rule (clearance by repo visibility, eng D9) plus an intentional golden change.
  - **Effort:** M / S. **Priority:** P3. **Depends on:** the M2 knowledge MCP.
- [ ] **Unforgeable approver identity for org-app Slack installs.**
  - **Why:** on an org's own Slack app, the org admin holds the signing secret and can forge the approving user (`apps/www/src/app/api/webhooks/slack/route-fence.ts:13-18`).
  - **Context:** eng D10 kept the org route as an accepted shortcut. The fix: accept knowledge approvals only on the platform route, or confirm on a signed-in Automata page.
  - **Re-entry:** an org-app partner onboards for knowledge approvals, or a buyer audits approval provenance.
  - **Effort:** M / S. **Priority:** P2. **Depends on:** the M1 approval flow.
