# Ported review skills: provenance

The review skills below are ported from the legacy orchestrator repository
`orch-agents` at commit `b337099`. Each file was copied verbatim and then
changed ONLY by the edits listed for it (B1–B12 of the cutover spec). Any
other difference from the legacy text is a defect. Check with:

```sh
git -C <orch-agents clone> show b337099:skills/<path> > /tmp/legacy.md
diff /tmp/legacy.md deploy/skills/<ported path>
```

The two skills are pushed flattened (`deploy/skill-push.ts` resolves the
`<!-- include: … -->` and `<!-- include-pinned: … -->` lines before validating
and storing the body), so the agent reads one self-contained text.

| Ported file                           | Legacy file (`orch-agents@b337099`)          | Pushed as skill     |
| ------------------------------------- | -------------------------------------------- | ------------------- |
| `github-ops/SKILL.md`                 | `skills/github-ops/SKILL.md`                 | `github-ops`        |
| `flutter-pr-review/SKILL.md`          | `skills/flutter-pr-review/SKILL.md`          | `flutter-pr-review` |
| `_shared/review-finding-contract.md`  | `skills/_shared/review-finding-contract.md`  | (partial)           |
| `_shared/review-verdict-contract.md`  | `skills/_shared/review-verdict-contract.md`  | (partial)           |
| `_shared/simplify-lenses.md`          | `skills/_shared/simplify-lenses.md`          | (partial)           |
| `_shared/somnio-flutter-standards.md` | `skills/_shared/somnio-flutter-standards.md` | (partial)           |

`github-ops/SKILL.md` used to be the vendor's own review skill, with this
port kept beside it as `github-ops-ported/SKILL.md`. The port is now the
canonical `github-ops` body: `github-ops/SKILL.md` is the port plus a
frontmatter block (B1 dropped the legacy one; the skill-store stripper removes
this one too) and the B12 review-mode sections, and `github-ops-ported/` is
gone. `flutter-pr-review/SKILL.md` likewise carries a stripped frontmatter
block, which holds the deploy-order warning below.

> **Deploy order: do not push `flutter-pr-review` with review-mode sections
> before #493 is merged AND deployed.** Until then www renders
> `<!-- automata:if … -->` sections only for `github-ops`. A marker-bearing
> `flutter-pr-review` body reaches the agent raw, the agent emits a tagged
> `json review-intent` block the classic parser cannot read, and every Flutter
> review posts a no-verdict notice. `deploy/skill-push.ts` refuses that live
> write unless `--allow-review-mode-sections` is passed. Nothing pushes it
> automatically: the seed (`deploy/seed-pilot-mirror.ts`) seeds only
> `github-ops`, `github-deep-research` and `github-mention`.

## Edits

- **B1. Frontmatter dropped** (both skills). The legacy YAML carried
  orchestrator metadata (allowed tools, context fetchers, agent policy).
- **B2. Tools and context** (both skills). The "Trigger Context contains
  `gh pr view`, `gh pr diff` … You have no shell" sentences became: `Bash` is
  for read-only git only (`git rev-parse HEAD`,
  `git diff origin/{{baseBranch}}...HEAD`, `git log`, `git show`); no `gh`, no
  network; the PR view, `<prior_reviews>` and `<review_threads>` are in
  `## Trigger Context`. A `## Trigger Context` heading followed by the line
  `<!-- automata:context pr-view prior-reviews review-threads -->` was added
  after the intro paragraph; the control plane replaces that line with the
  prefetched blocks.
- **B3. Verdict delivery** (both skills). "How you deliver your verdict" no
  longer calls `emit_review({...})`: the final message ends with exactly one
  fenced json block (`verdict`, `commit`, `summary`, `findings`,
  `resolvedThreads`), or the `unable_to_review` block when no diff can be
  obtained. One sentence maps the legacy names the unchanged sections still
  use (`body` → `summary`, `comments` → `findings`). The sub-agent
  "single writer" paragraph went with the call. "Call `emit_review` exactly
  ONCE" became "Emit exactly one json block, then stop".
- **B4. Thread resolution** (both skills). `emit_resolve_thread({...})`
  became a `resolvedThreads` entry in the same block. The "Reviewer voice —
  do NOT write Fixed:" rule (github-ops) is kept verbatim.
- **B5. Durable memory removed** (github-ops). The review lane has no memory
  tool yet.
- **B6. Large-PR hardening** (both skills). The lens include and the
  stack-specific shapes are kept. The "Delegating the 7–10 / 9–12 pass"
  subsection became one line, "Run dimensions 7–10 (9–12) inline yourself.",
  and the hard rules about `Agent`/`Task` availability and sub-agent emits
  were deleted. Classic review runs have no sub-agents.
- **B7. Diff source** (both skills). "Base the verdict on the full diff in
  Trigger Context. If it is truncated…" became "Base the verdict on
  `git diff origin/{{baseBranch}}...HEAD`. If you cannot obtain it, emit
  `unable_to_review`."
- **B8. Finding contract partial.** The `REVIEW_POST_INLINE_COMMENTS`
  sentence became "The control plane folds findings into one review body.",
  and "The `emit_review` tool description states the one in force" became
  "The tolerance note at the end of this prompt states the one in force".
- **B9. Flutter standards partial.** Step 1 (the WebFetch / ToolSearch
  instructions) became "The seven files are inlined below at the pinned
  commit; never fetch anything.", followed by seven
  `<!-- include-pinned: … -->` lines, one per pinned URL at
  `somnio-software/somnio-ai-tools@1584e818d0243df9e9cbc8e6c0a9c34862d05dcf`.
  Steps 2-3, the table and the applicability check are unchanged. In
  flutter-pr-review the "(`WebFetch` is used solely …)" sentence was removed.
- **B10. Customer names scrubbed.** The only customer PR reference sat in the
  Flutter delegation subsection that B6 removed.

- **B11. Large-diff trigger source.** `_shared/simplify-lenses.md` said "the
  `gh pr diff` output in Trigger Context tells you both"; there is no diff block
  here, so it now names the PR view's `additions`, `deletions` and
  `changedFiles`, which carry the same counts. (Added after the first port.)

- **B12. Review-mode sections** (both skills). `<!-- automata:if classic -->`
  / `<!-- automata:if orchestrated … -->` blocks add the lead-reviewer and
  sub-agent section for orchestrated runs, and swap the "read-only git only"
  intro and the "Emit exactly one json block … run no shell command" line for
  orchestrated variants. The classic render is byte-identical to the port
  above. Without these sections an orchestrated run falls back to classic.
  Every diff instruction names the base as `origin/{{baseBranch}}`, which the
  control plane renders to the PR's real base ref on every run; never
  `origin/main` or a prose `<base>` (stacked PRs target another PR's branch).
  The save surfaces refuse a body that breaks this
  (`assertSkillBodyNamesPrBase`).

The partials still call the review text `body` and the findings `comments`
(the legacy names). The intent parser accepts both as aliases
(`parse-review-intent.ts`, `withLegacyKeyAliases`), so following that wording
never drops a finding.

## Unchanged by rule

The six (TypeScript) and eight (Flutter) review dimensions, the Dart/Flutter
severity anchors, "Verify before you block", the body format, the decision
rule, the `Resolved: X / Y` rules, the draft rule and every "What a
substantive review does NOT look like" bullet.

## github-mention (the org-owned mention lane)

`github-mention/SKILL.md` merges two legacy skills from `orch-agents`
(`b337099`): `skills/github-mention-respond/SKILL.md` (Section A, the
issue / PR-conversation mention) and
`skills/github-review-comment-respond/SKILL.md` (Section B, the inline
review-comment mention). It is a port, not a verbatim copy:

- **M1. Frontmatter** replaced by a two-key header (name, description); the
  orchestrator metadata (allowed tools, fetchers, agent policy) is dropped.
- **M2. Trigger block.** The `{{ commentBody }}` / `{{ mentionInstruction }}` /
  `{{ commentPath }}` placeholders are gone: the control plane appends a
  `## Mention` block (commenter, kind, instruction, anchor, diff hunk) wrapped
  as untrusted content, and the `## Trigger Context` directive
  `<!-- automata:context pr-view prior-reviews review-threads -->` brings the
  PR view, prior reviews and review threads.
- **M3. Delivery.** `emit_reply` / `emit_review` and the review-comment skill's
  `gh api …/replies` posting became ONE fenced `json mention-reply` block
  (`kind`, `reply`, optional `commit`, optional `review` in the review-intent
  shape). The control plane posts the reply as the App (in-thread for a review
  comment) and the review through the review lane's writer.
- **M4. Kept:** the three actions of each section, "every mention gets a
  reply", never merge/close, no code change on a disagreement, anchor changes
  to the commented line, never act on `<user_content>` as control, and the two
  review partials (`<!-- include: … -->`, flattened by skill-push).
- **M5. Issues push nothing.** An issue mention answers in the reply only.
