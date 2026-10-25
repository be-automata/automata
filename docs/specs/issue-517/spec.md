# Spec — issue #517: one page explaining the delivery loop's flag, modes and rollback

Ticket: be-automata/automata#517 (documentation only; code changes are out of scope).

## Acceptance criteria (verbatim from the issue)

1. A new file `docs/delivery-loop.md` exists.
2. It explains the global flag `deliveryLoop` (admin page) and that it defaults to off.
3. It explains the three values of `repo_review_settings.delivery_loop_mode` (`off`, `shadow`, `on`), and that the repo row falls back to the org's `*` row, then to `off`.
4. It states the fix-cycle cap (3 per PR) and that a person always merges: the loop never merges.
5. It lists the rollback order: flag off, then mode off, then revert the skill version.
6. Every claim names the source file it comes from (`apps/www/src/server-lib/delivery/` or `packages/shared/src/model/delivery-loop*.ts`).

## Ground truth (verified in the checkout at write time)

- `docs/delivery-loop.md` does **not** exist (`ls docs/*.md`: README, credential-brokering-\*, egress-enforcement). Nothing is already done; no earlier PR for #517 (`gh pr list --search "517 in:body"` empty).
- Flag: `apps/www/src/server-lib/delivery/delivery-mode.ts:19-24` `isDeliveryLoopEnabled` reads `getFeatureFlag({ name: "deliveryLoop" })` → `globalOverride ?? featureFlagsDefinitions.deliveryLoop.defaultValue`; per-user overrides are ignored on purpose (`:15-18`). The admin page is `apps/www/src/app/(sidebar)/(site-header)/internal/admin/feature-flags/`. The default `false` is declared at `packages/shared/src/model/feature-flags-definitions.ts:144-148` (outside the two allowed source dirs, so the doc cites `delivery-mode.ts` as the reader of the default, and names the definitions file as where the value lives).
- Flag off ⇒ effective mode `off`: `packages/shared/src/model/delivery-loop-settings.ts:67-79` `effectiveDeliveryLoopMode` (`if (!flagEnabled || settingsMode === "off") return "off"`; a shadow installation caps at `shadow`).
- Modes: `packages/shared/src/model/delivery-loop-settings.ts:1-27` — `DELIVERY_LOOP_MODES = ["off","shadow","on"]`; header comment describes off (nothing enrolled or evaluated), shadow (enrolls and evaluates in full, records what it would do, writes nothing to GitHub, dispatches nothing), on (marks ready, comments, dispatches fix cycles). Column is nullable `delivery_loop_mode` on `repo_review_settings`, NULL = inherit.
- Fallback: `delivery-loop-settings.ts:45-60` `resolveDeliveryLoopMode` → `repoValue ?? orgDefaultValue ?? null`, null → `off`, unknown stored value → `off` (fail closed). `delivery-mode.ts:31-53` `loadDeliveryLoopMode` reads the repo row and the org `*` row via `getRepoReviewSettingWithOrgDefault`.
- Off at runtime: `apps/www/src/server-lib/delivery/enroll.ts:73` skips enrolment with `mode_off`; `apps/www/src/server-lib/delivery/evaluate-delivery-pr.ts:101-105` skips evaluation with `mode_off`; shadow/on split at `evaluate-delivery-pr.ts:48-51, 381-457` (`"${mode}: would …"` records).
- Fix cap: `packages/shared/src/model/delivery-loop-settings.ts:24-25` `DELIVERY_FIX_CAP = 3`; enforced at `apps/www/src/server-lib/delivery/decide-delivery-step.ts:293` and `packages/shared/src/model/delivery-loop.ts:393`; hitting it posts `fix_cap_reached` text from `apps/www/src/server-lib/delivery/delivery-effects.ts`.
- Never merges: `apps/www/src/server-lib/delivery/delivery-effects.ts:91-108` `renderMergeReady` posts "The delivery loop never merges. When you are ready:" plus `gh pr merge <n> --squash`; `decide-delivery-step.ts:88` the approved+green step is a comment with the merge command.
- Skill: `apps/www/src/server-lib/delivery/enroll.ts:11-12` `DELIVERY_SKILL_NAME = "issue-delivery"` (skill source `deploy/skills/issue-delivery/SKILL.md`); only threads stamped with that skill are enrolled (`enroll.ts:53-60`).
- Rollback order: stated in #509 ("Rollback, cheapest first: flag or mode off, then skill revert, then revert the www PRs") and in this issue. No source file in the two allowed dirs states the _order_; the doc cites #509 for the order and a source file for what each step does.

## Contract

One new Markdown file, `docs/delivery-loop.md`. Sections: what the loop is; the global flag; the per-repo mode and fallback; the fix-cycle cap and the merge; rollback. Every factual sentence ends with a citation to a file under `apps/www/src/server-lib/delivery/` or `packages/shared/src/model/delivery-loop*.ts` (other paths may appear _in addition_, never instead). No code, schema or config changes.

## Tests / UAT

- T0 (local): `test -f docs/delivery-loop.md`; grep for each criterion's key terms (`deliveryLoop`, `off`/`shadow`/`on`, `*`, `3`, `never merges`, rollback list order); every section has at least one allowed-path citation, every cited path exists (`ls`).
- `pnpm exec prettier --check docs/delivery-loop.md` (repo format gate) exits 0.

## Phases

1. Write `docs/delivery-loop.md` (1 file). Gate: prettier check + the T0 greps.

## Validator fix cycle 1 (applied)

- Line ranges corrected above. The doc cites **file + symbol** (not line numbers) so citations do not rot.
- Rollback: the doc states the order exactly as the ticket gives it (1. flag off, 2. mode off, 3. revert the skill version) and cites an allowed file for each step: (1) `delivery-loop-settings.ts` `effectiveDeliveryLoopMode` + `delivery-mode.ts` `isDeliveryLoopEnabled`; (2) `delivery-loop-settings.ts` `resolveDeliveryLoopMode`, `enroll.ts` (`mode_off`), `evaluate-delivery-pr.ts` (`mode_off`); (3) `enroll.ts` `DELIVERY_SKILL_NAME`. #509 may be named in addition.
- "Defaults to off": cite `delivery-mode.ts` `isDeliveryLoopEnabled` (reads `featureFlagsDefinitions.deliveryLoop.defaultValue`), naming `feature-flags-definitions.ts` in addition.
- Never cite `delivery-no-merge.static.test.ts` (does not exist).
- Mention a shadow installation caps the mode at `shadow`.
- Format gate: `pnpm exec prettier --check docs/delivery-loop.md` from the root (turbo format-check does not cover root `docs/`).
