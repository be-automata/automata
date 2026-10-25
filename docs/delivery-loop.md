# Delivery loop: flag, modes and rollback

The delivery loop takes an issue-delivery pull request from opened to merge-ready (#509). It enrolls the PR the `issue-delivery` skill opened, marks it ready, runs fix cycles on review findings or failing checks, and posts the merge command once the PR is approved and green (`apps/www/src/server-lib/delivery/enroll.ts`, `enrollDeliveryAtPrOpen`; `apps/www/src/server-lib/delivery/evaluate-delivery-pr.ts`, `evaluateDeliveryPr`). This page covers the switches an operator controls. To turn the loop off now, go to [Rollback](#rollback).

## Global flag

- The loop has one global switch, the `deliveryLoop` feature flag, set on the admin page (Internal, Admin, Feature flags) as the flag's global override. Per-user overrides are ignored on purpose, because the loop's effects are not per user (`apps/www/src/server-lib/delivery/delivery-mode.ts`, `isDeliveryLoopEnabled`).
- It defaults to off: with no global override the flag takes its definition default, `defaultValue: false` in `packages/shared/src/model/feature-flags-definitions.ts` (`apps/www/src/server-lib/delivery/delivery-mode.ts`, `isDeliveryLoopEnabled`).
- Flag off forces the effective mode to `off`, whatever the per-repo rows say (`packages/shared/src/model/delivery-loop-settings.ts`, `effectiveDeliveryLoopMode`).

## Per-repo mode

The per-repo mode is the nullable column `repo_review_settings.delivery_loop_mode`, with three values (`packages/shared/src/model/delivery-loop-settings.ts`, `DELIVERY_LOOP_MODES`).

| Mode     | What it does                                                                                                   | Source                                                                           |
| :------- | :------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------- |
| `off`    | Nothing is enrolled or evaluated.                                                                              | `packages/shared/src/model/delivery-loop-settings.ts`, `DELIVERY_LOOP_MODES`     |
| `shadow` | Enrolls and evaluates in full and records what it would do; writes nothing to GitHub, dispatches no fix cycle. | `apps/www/src/server-lib/delivery/evaluate-delivery-pr.ts`, `evaluateDeliveryPr` |
| `on`     | Marks the PR ready, posts comments and dispatches fix cycles.                                                  | `apps/www/src/server-lib/delivery/evaluate-delivery-pr.ts`, `evaluateDeliveryPr` |

Inheritance and safety rules:

- A NULL value inherits: the repo row, then the org's `*` row, then `off` (`packages/shared/src/model/delivery-loop-settings.ts`, `resolveDeliveryLoopMode`).
- A stored value that is not one of the three modes resolves to `off`, so an unreadable setting fails closed and never turns effects on (`packages/shared/src/model/delivery-loop-settings.ts`, `resolveDeliveryLoopMode`).
- A shadow installation caps the effective mode at `shadow`, even when the setting says `on` (`packages/shared/src/model/delivery-loop-settings.ts`, `effectiveDeliveryLoopMode`).

## Fix cycles and the merge

- The cap is 3 fix cycles per PR (`packages/shared/src/model/delivery-loop-settings.ts`, `DELIVERY_FIX_CAP`).
- At the cap the loop stops starting cycles and posts a needs-a-person comment with the reason `fix_cap_reached` (`apps/www/src/server-lib/delivery/decide-delivery-step.ts`, `cycleOrCap`).
- When the PR is approved at its head and every check is green, the loop posts one comment with the `gh pr merge <n> --squash` command. The loop never merges; a person always merges (`apps/www/src/server-lib/delivery/delivery-effects.ts`, `renderMergeReady`).

## Rollback

Roll back in this order, cheapest first (the order comes from #509, not from code).

1. **Flag off.** Turn `deliveryLoop` off on the admin page. The flag is read on every evaluation, and flag off makes the effective mode `off` for every repo at once (`apps/www/src/server-lib/delivery/delivery-mode.ts`, `isDeliveryLoopEnabled` and `loadDeliveryLoopMode`; `apps/www/src/server-lib/delivery/evaluate-delivery-pr.ts`, `evaluateDeliveryPr`; `packages/shared/src/model/delivery-loop-settings.ts`, `effectiveDeliveryLoopMode`).
2. **Mode off.** Set `delivery_loop_mode` to `off` for the repo, or on the org's `*` row to cover every repo that inherits. An `off` mode skips enrollment of new PRs and skips evaluation of enrolled ones (`packages/shared/src/model/delivery-loop-settings.ts`, `resolveDeliveryLoopMode`; `apps/www/src/server-lib/delivery/enroll.ts`, `enrollDeliveryAtPrOpen`; `apps/www/src/server-lib/delivery/evaluate-delivery-pr.ts`, `evaluateDeliveryPr`).
3. **Revert the skill version.** Revert the `issue-delivery` skill (`deploy/skills/issue-delivery/SKILL.md`) to its previous version. The loop enrolls only threads stamped with the skill name `issue-delivery`, so what the skill does decides what reaches the loop (`apps/www/src/server-lib/delivery/enroll.ts`, `DELIVERY_SKILL_NAME`).
