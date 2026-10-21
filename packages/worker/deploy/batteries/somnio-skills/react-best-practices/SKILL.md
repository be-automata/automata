---
name: react-best-practices
description: >-
  Execute a micro-level React code quality audit. Validates code against the
  pinned Somnio standards for testing, component architecture, hooks patterns,
  state management, performance, and TypeScript. Produces a detailed violations
  report with prioritized action plan. Use when the user asks to check React
  code quality, validate best practices, or review frontend code standards.
  Triggers on: 'react best practices', 'react code quality', 'component review',
  'hooks review', 'react standards', 'frontend code quality'.
---

# react-best-practices (execution-box adapter)

## Provenance

- `UPSTREAM-SKILL.md` and every other file beside this one are vendored
  verbatim from somnio-software/somnio-ai-tools at the commit pinned in
  `packages/worker/deploy/batteries.json` (MIT; the notice is `LICENSE` at the
  pack root). That includes the standards under `agent-rules/rules/react/`.
- This adapter is written by automata. It changes only where the standards
  are read from.

## Standards override

This file wins over every vendored file wherever they conflict.

- The standards are at `${CLAUDE_SKILL_DIR}/agent-rules/rules/react/`.
- Wherever a vendored file says to read `agent-rules/rules/react/<file>` from
  the repository, or to WebFetch it from raw.githubusercontent.com, Read
  `${CLAUDE_SKILL_DIR}/agent-rules/rules/react/<file>` instead, even when the
  repository has its own `agent-rules/`.
- Never WebFetch the standards. The network is fenced, and the live `main`
  copy is not the pinned one.
- Every subagent you dispatch gets the absolute standards directory and this
  override in its prompt: subagents never read this file.

## Procedure

Read `${CLAUDE_SKILL_DIR}/UPSTREAM-SKILL.md` and follow it with the override
above. Its relative paths (`references/`, `agents/`, `assets/`) are relative
to `${CLAUDE_SKILL_DIR}`.
