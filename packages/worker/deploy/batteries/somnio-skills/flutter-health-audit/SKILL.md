---
name: flutter-health-audit
description: >-
  Execute a comprehensive Flutter Project Health Audit. Analyzes tech stack,
  architecture, state management, testing, code quality, CI/CD, and
  documentation. Produces a shareable Markdown report with section scores and
  weighted overall score. Use when the user asks to audit a Flutter project,
  run a health check, evaluate project quality, or assess technical debt.
  Triggers on: 'flutter audit', 'health audit', 'project audit', 'flutter
  health', 'tech debt assessment', 'project quality check'.
---

# flutter-health-audit (execution-box adapter)

## Provenance

- `UPSTREAM-SKILL.md` and every other file beside this one are vendored
  verbatim from somnio-software/somnio-ai-tools at the commit pinned in
  `packages/worker/deploy/batteries.json` (MIT; the notice is `LICENSE` at the
  pack root).
- This adapter is written by automata. It changes only Step 0 (environment
  setup), which installs a toolchain this run does not have.

## Step 0 override

This file wins over every vendored file wherever they conflict.

The execution box ships no Flutter SDK, FVM or Homebrew, and its network is
fenced, so Step 0 cannot install or align one. Run `command -v flutter` first.
When it finds nothing:

- Do not follow `references/tool-installer.md`,
  `references/version-alignment.md` or `references/version-validator.md`, and
  run no `fvm`, `flutter`, `dart pub`, `pub get`, `build_runner`, `brew` or
  `npm install` command.
- Write `reports/.artifacts/flutter-health-audit/step_00_test_coverage.md`
  with exactly these two lines, then continue with Wave 1:

  ```
  Code Coverage: Unknown (not collected: no Flutter toolchain in this run)
  Coverage Breakdown: (not collected: no Flutter toolchain in this run)
  ```

- This replaces every "MANDATORY", "stops if fails" and Wave 0 gate rule in
  the vendored files. Say in the report that Step 0 was skipped and why.
- Every subagent you dispatch gets this override in its prompt: subagents
  never read this file.

## Procedure

Read `${CLAUDE_SKILL_DIR}/UPSTREAM-SKILL.md` and follow it with the override
above. Its relative paths (`references/`, `agents/`, `assets/`) are relative
to `${CLAUDE_SKILL_DIR}`.
