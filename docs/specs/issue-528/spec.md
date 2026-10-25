# Spec — issue #528: document the delivery loop's partial-delivery (`Refs`) follow-up

Ticket: be-automata/automata#528 (documentation only; code changes are out of scope).

## Acceptance criteria (verbatim from the issue)

1. `docs/delivery-loop.md` gains a short section on partial delivery: a PR whose body ends `Refs #N` (not `Closes #N`) leaves the issue open, and when it merges the loop posts one comment on the issue listing the PR's unticked acceptance criteria.
2. The section says the loop never re-runs delivery by itself: a person re-labels the issue `automata:deliver` to deliver the rest.
3. Every claim names the source file it comes from (`apps/www/src/server-lib/delivery/delivery-effects.ts`, `evaluate-delivery-pr.ts`).

## Ground truth (verified in the checkout at write time)

- `docs/delivery-loop.md` exists (#518) with sections Global flag, Per-repo mode, Fix cycles and the merge, Rollback. It has **no** partial-delivery section (`grep -n "Refs" docs/delivery-loop.md` → nothing). No earlier PR for #528 (`gh pr list --search "528 in:body"` returns only unrelated #55).
- Its citation style: each claim ends with `(<path>, <symbol>)`.
- `apps/www/src/server-lib/delivery/delivery-effects.ts:151-179` `parseUndeliveredCriteria`: returns null unless the body's last non-empty line, above the platform task-link footer (`PLATFORM_FOOTER_LINE`, :149), is exactly `Refs #<issue>`; otherwise returns the unticked (`- [ ]`) items of the `## Acceptance criteria` section, in order. Its doc comment: a PR that delivered everything ends `Closes #<issue>`.
- `delivery-effects.ts:190-208` `renderRefsFollowup`: comment "**#<pr> merged without delivering every criterion.** Still open:", each item as `- [ ]` (sanitized, @-mentions dropped), a fallback line when none were listed, then "Re-label this issue `automata:deliver` to deliver the rest."
- `delivery-effects.ts:62-81` `postDeliveryComment` + `deliveryMarker` (:24): one comment per (kind, head sha), kind `refs-followup` (:22); an existing marked comment by the App's bot is reused, so it posts once.
- `apps/www/src/server-lib/delivery/evaluate-delivery-pr.ts:345-366` (`applyStep`, case `close`): only when mode is `on` and the phase is `merged` it calls `parseUndeliveredCriteria(github.body, row.issueNumber)` and posts the `refs-followup` comment on the **issue** (`prNumber: row.issueNumber`), then moves the row to `merged`. Comment at :346-347: "a re-label by a person delivers it (no automatic re-run)". No code path in `apps/www/src/server-lib/delivery/` dispatches a delivery run or adds a label on merge (`grep -rn "automata:deliver" apps/www/src` → only the comment text in `delivery-effects.ts`).
- "Leaves the issue open": the loop never closes issues; only `Closes #N` (a GitHub closing keyword) closes on merge. The skill's rule is `deploy/skills/issue-delivery/SKILL.md:186-187` (`Closes` only when every criterion is PASS, else `Refs`; a re-label delivers the rest).
- Shadow mode posts nothing (`mode === "on"` guard), consistent with the existing Per-repo mode table.

## Contract

Add one section, `## Partial delivery`, to `docs/delivery-loop.md` (before `## Rollback`, keeping Rollback last as the page's anchor target). Each claim ends with a citation to `apps/www/src/server-lib/delivery/delivery-effects.ts` or `apps/www/src/server-lib/delivery/evaluate-delivery-pr.ts` (the skill file may be cited in addition). No code, schema or config changes.

## Tests / UAT

- T0 (local): `grep` the new section for `Refs #`, `Closes #`, `unticked`, `automata:deliver`, `re-label`; every bullet in the section has a citation to one of the two named files; every cited path exists.
- `pnpm install --frozen-lockfile --prefer-offline`, then `pnpm exec prettier --check docs/delivery-loop.md` exits 0.

## Phases

1. Edit `docs/delivery-loop.md` (1 file). Gate: prettier check + the T0 greps.

## Validator fix cycle 1 (applied)

Verdict PASS_WITH_WARNINGS. Applied: corrected line ranges; the doc states the empty-list case (a `Refs` PR with no unticked items still gets a comment with a fallback line, `delivery-effects.ts:200`); "once" is bounded to one comment per merged PR (dedup per kind + head sha, bot-authored only; the row is terminal after merge, `decide-delivery-step.ts:115-116`), so two partial PRs each post their own; "leaves the issue open" is attributed to GitHub's closing keywords plus the skill rule, never to loop code; install runs before prettier. Avoid: saying the loop closes/reopens issues, or that `automata:deliver` is a loop constant.
