# Spec — issue #526: delivery-loop comments name the approver without an @-mention or `[bot]`

Ticket: be-automata/automata#526. Out of scope: what the loop decides or when it comments.

## Acceptance criteria (verbatim from the issue)

1. `renderMergeReady` in `apps/www/src/server-lib/delivery/delivery-effects.ts` names the approver without an `@` and without a trailing `[bot]`, e.g. "Automata (`automata-ai-bot`) approved `<sha7>`…".
2. No comment the delivery loop renders (`renderMergeReady`, `renderNeedsHuman`, `renderNoCi`, `renderRefsFollowup`) contains an `@` followed by a login.
3. `apps/www/src/server-lib/delivery/delivery-effects.test.ts` asserts both of the above for every renderer.
4. The delivery-loop marker line (`<!-- automata:delivery-loop kind= sha= -->`) is unchanged, so comments the loop already posted are still found.
5. The existing delivery tests (`apps/www/src/server-lib/delivery/`) still pass.

## Ground truth (verified in the checkout at write time)

- Nothing is done yet; no earlier PR for #526 (`gh pr list --search "526 in:body"` empty).
- `delivery-effects.ts:101` (in `renderMergeReady`, `:91`) renders `` `**Ready to merge.** @${approver} approved \`${sha7}\`…` ``; the caller passes `approver: deps.botLogin()` (`evaluate-delivery-pr.ts:466`), which defaults to `resolveBotLogin()` (`apps/www/src/server-lib/review/bot-login.ts:4-7`, `GITHUB_BOT_LOGIN` else `<app name>[bot]`), so the posted text is `@automata-ai-bot[bot]` (#524).
- `renderNoCi` (`:111`) and `renderNeedsHuman` / `NEEDS_HUMAN_TEXT` (`:115-142`) are static text plus a short sha and a number: no `@` today.
- `renderRefsFollowup` (`:171-189`) renders each unticked criterion of a merged PR body through `sanitizeAgentText` (`apps/www/src/server-lib/audit/render-issue.ts:59-77`), whose `MENTION_RE` (`:55`) turns `@alice` into `` `@alice` `` — a code span, not a notification, but still an `@` followed by a login, so criterion 2 fails for an item that names someone.
- `deliveryMarker` (`:24-26`) is `<!-- automata:delivery-loop kind=${kind} sha=${headSha} -->`; `postDeliveryComment` appends it. Not touched.
- Existing tests: `delivery-effects.test.ts` (DB-backed, uses `TEST_DATABASE_ADMIN_URL`, available here) has one `renderMergeReady` test passing `approver: "automata-ai-bot[bot]"`.

## Contract

- `renderMergeReady({ prNumber, headSha, approver })` signature unchanged. First line becomes
  ``**Ready to merge.** Automata (`<login without [bot]>`) approved `<sha7>` and every check is green at that commit.``
  The `[bot]` suffix is stripped case-insensitively; a login inside backticks is a code span and never notifies.
- `renderRefsFollowup`: each item is still passed through `sanitizeAgentText`; afterwards the `` `@name` `` code spans it produced (and any `@` directly before a login inside backticks) lose the `@`, so the comment holds no `@<login>`. Item text otherwise unchanged. An email-shaped `word@word` (which `MENTION_RE` skips and GitHub never treats as a mention) is not a login mention and is left as is; an author's own backticked `` `@scope/pkg` `` loses its `@` too (intended: criterion 2 is literal).
- `Automata` is the fixed display name from the ticket's example; the login in parentheses comes from `approver`.
- `renderNoCi`, `renderNeedsHuman`, `deliveryMarker`, `postDeliveryComment`: unchanged.

## Tests / UAT

- T0 (local), in `delivery-effects.test.ts`:
  - `renderMergeReady` with `approver: "automata-ai-bot[bot]"` contains `` Automata (`automata-ai-bot`) approved `abcdef1` ``, does not contain `[bot]`, does not match `/@[A-Za-z0-9]/`.
  - every renderer (`renderMergeReady`, `renderNoCi`, `renderNeedsHuman` for every `DeliveryNeedsHumanReason`, `renderRefsFollowup` with an item naming `@alice` and an `@org/team`) does not match `/@[A-Za-z0-9]/`.
  - `deliveryMarker("merge-ready", "H1")` equals the literal `<!-- automata:delivery-loop kind=merge-ready sha=H1 -->`.
- Gates: `pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/server-lib/delivery/`, `pnpm turbo tsc-check --filter=@terragon/www`, `pnpm --filter @terragon/www exec eslint src/server-lib/delivery`, `pnpm exec prettier --check` on the changed files.

## Phases

1. `delivery-effects.ts` + `delivery-effects.test.ts` (2 files).

## Validator

Cycle 1: PASS_WITH_WARNINGS (Opus). Applied: line numbers corrected; email and backticked-`@` behaviour stated; typecheck gate switched to the repo's `tsc-check`.

## Refinement (applied)

- `renderRefsFollowup` strips every `@` run that starts a login and is not preceded by a word character (`unmention`), not only the `` `@name` `` spans: `@@carol`, `` `x`@dave `` and `path/@erin` escaped the narrower form. Emails keep their `@`.
- `renderMergeReady` names `Automata` alone when no login is left (approver `[bot]`).
- The test's reason list is a `Record<DeliveryNeedsHumanReason, 1>`, so a new reason fails the typecheck until it is tested.
