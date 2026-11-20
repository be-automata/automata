# Spec: #719, Flutter/Dart artifact hosts for cell egress

The ticket is the spec. It is kept in `<state>/719/ticket.md`.

## Decision (2026-11-20)

OD-1 = (c): no bundle change.

- `automata/registries@1` stays byte for byte.
- A Flutter repo that needs Flutter SDK or engine downloads lists `storage.googleapis.com` in its own `domain` allowlist.
- (d), precaching Flutter in the image, is a later follow-up. (b) and (a) are not taken.

## Scope

Docs only, in the cell egress section of `packages/worker/deploy/README.md`:

1. Correct the line at `:1414-1415`, which says `flutter pub get` fails in a cell. The #719 research found otherwise:

   - pub.dev serves package archives itself (`/api/archives/<pkg>-<ver>.tar.gz`, 200, no redirect, checked 2026-11-20), so `pub get` should not need `storage.googleapis.com`;
   - the Flutter SDK and engine artifacts (`flutter precache`, artifacts fetched on demand, the Android Gradle embedding at `/download.flutter.io`) come from `FLUTTER_STORAGE_BASE_URL`, which defaults to `https://storage.googleapis.com`.

   The README says this is still to be confirmed in a cell (AC-1).

2. Explain how a repo adds `storage.googleapis.com` to its own `domain` allowlist. State the risk in one sentence: the host serves every GCS bucket, so an agent could upload to a bucket it controls. Note that `domain` also governs the box. Give the PUT example.

## Ground truth (verified at `origin/main` `039aa790`)

| Claim                                       | Where                                                                                                                         | Holds                                                                                                  |
| :------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------- |
| The stale line                              | `packages/worker/deploy/README.md:1414-1415` ("`flutter pub get` or a Flutter SDK download that redirects there still fails") | yes                                                                                                    |
| `@1` leaves storage hosts out               | `packages/shared/src/model/cell-egress-catalog.ts:29-33`                                                                      | yes                                                                                                    |
| A wider list is `@2`, never an edit of `@1` | `README.md:1415-1416`                                                                                                         | yes                                                                                                    |
| The PUT example already exists              | `README.md:1418-1424`                                                                                                         | yes; reused                                                                                            |
| Tests that read this README                 | `packages/worker/src/agent-run/deploy-assets.test.ts:108,112,615`                                                             | they check other paragraphs (worker-2, GLOBAL_MAX_RUNS, daemon launcher), which this edit leaves alone |

## Gates

- `pnpm turbo format-check`
- prettier `--no-editorconfig --config .prettierrc --check` on the README
- `pnpm turbo lint`
- worker vitest `src/agent-run/deploy-assets.test.ts`

## AC map

- AC-1: deferred. It needs a real cell on the execution box, so it runs after merge.
- AC-2: met by the issue's Decisions section.
- AC-3: this change.
- AC-4 to AC-6: out of scope (OD-1 = c).
