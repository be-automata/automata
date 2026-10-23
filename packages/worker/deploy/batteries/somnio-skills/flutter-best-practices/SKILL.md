---
name: flutter-best-practices
description: >-
  Execute a micro-level Flutter code quality audit. Validates code against the
  pinned Somnio standards for testing, architecture, and code implementation.
  Produces a detailed violations report with prioritized action plan. Use when
  the user asks to check Flutter code quality, validate best practices, or
  review code standards compliance.
  Triggers on: 'flutter best practices', 'code quality', 'code review',
  'flutter standards', 'architecture compliance', 'testing quality'.
---

# flutter-best-practices (execution-box adapter)

## Provenance

- `UPSTREAM-SKILL.md` and every other file beside this one are vendored
  verbatim from somnio-software/somnio-ai-tools at the commit pinned in
  `packages/worker/deploy/batteries.json` (MIT; the notice is `LICENSE` at the
  pack root). That includes the standards under `agent-rules/rules/flutter/`.
- This adapter is written by automata. It changes only where the standards
  are read from.

## Standards override

This file wins over every vendored file wherever they conflict.

- The standards are at `${CLAUDE_SKILL_DIR}/agent-rules/rules/flutter/`.
- Wherever a vendored file says to read `agent-rules/rules/flutter/<file>`
  from the repository, or to WebFetch it from raw.githubusercontent.com, Read
  `${CLAUDE_SKILL_DIR}/agent-rules/rules/flutter/<file>` instead, even when
  the repository has its own `agent-rules/`.
- Never WebFetch the standards. The network is fenced, and the live `main`
  copy is not the pinned one.
- Every subagent you dispatch gets the absolute standards directory and this
  override in its prompt: subagents never read this file.

## Procedure

Read `${CLAUDE_SKILL_DIR}/UPSTREAM-SKILL.md` and follow it with the override
above. Its relative paths (`references/`, `agents/`, `assets/`) are relative
to `${CLAUDE_SKILL_DIR}`.
