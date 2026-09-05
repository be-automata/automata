# AGENTS.md

## Project Overview

**Terragon** - An AI-powered coding assistant platform that allows users to run coding agents in parallel inside remote sandboxes. This allows users to do multiple tasks concurrently and asynchronously. The remote sandboxes are full development environments that allow the coding agents to make edits, run tests, verify changes and put up commit and PRs.

## Repository Structure

- **Monorepo**: Uses pnpm workspace (v10.14.0) with multiple apps and packages
- **Frontend**: Next.js 15.4.5 app (`apps/www`) with React 19.1.0
- **Documentation**: Fumadocs-based documentation site (`apps/docs`)
- **WebSocket Service**: PartyKit-based real-time service (`apps/broadcast`)
- **CLI Tool**: Interactive CLI application (`apps/cli`) for pulling threads and creating tasks
- **Agent Daemon**: A node js script we run on all sandboxes to coordinate the coding agent
- **Shared Packages**: Core libraries, database models, and utilities (`packages/`)
- **Status Microsite**: Anthropic uptime microsite (`apps/isanthropicdown`)

## Key Commands

### Development

```bash
# Run all development services concurrently (frontend, websocket, daemon, docker)
pnpm dev

# TypeScript watch mode for all services
pnpm tsc-watch
```

`pnpm dev` command does the following:

- Starts up the docker containers
- Starts apps/www (our nextjs frontend)
- Starts apps/docs (our documentation site)
- Starts apps/broadcast (our realtime service to notify clients of updates)
- Builds daemon & bundled which is the script we run on remote sandboxes
- Builds and starts mcp-server for follow-up task suggestions
- Starts an ngrok tunnel. The daemon on remote sandboxes need to ping our web frontend with updates. In development, we use an ngrok tunnel to expose the development server to the public internet for this usecase.
- Starts our cron jobs. We use vercel cron jobs in production and this mimics that in development using the vercel-cron package.
- Starts the CLI tool in development mode

### Testing & Quality

```bash
# Run tests (www/app)
pnpm -C apps/www test
pnpm -C packages/shared test
pnpm -C packages/daemon test
pnpm -C packages/sandbox test

# TypeScript type checking
pnpm tsc-check
```

### Database (Drizzle ORM)

If you make a change to the db schema, you need to run the following command to push the schema to the development db.

Test environments push the schema automatically.

> **PRODUCTION DOES NOT.** Verified 2026-08-26: `.github/workflows/` contains only
> `ci.yml`, which runs lint/typecheck/tests and has **no drizzle push step**. There is
> no GitHub action that migrates the Neon production database when code lands on main.
>
> A schema change therefore ships in two ordered manual steps: **push the schema to prod
> FIRST, then deploy the worker**. Merging schema-dependent code without the push leaves
> production running code that reads columns which do not exist.
>
> The prod `DATABASE_URL` is a write-only Cloudflare Worker secret (`wrangler secret list`
> shows names only), so whoever runs the migration needs it out of band.
>
> **The ordering is enforced, not just documented.** Run the gate before every
> deploy — it exits non-zero if the deployed schema is missing a column this
> revision needs, and fails closed on an unset URL or an unreachable database:
>
> ```bash
> DATABASE_URL=... pnpm exec tsx deploy/assert-schema-ready.ts
> ```
>
> When you add a column to `packages/shared/src/db/schema.ts`, add it to that
> script's `REQUIRED` list in the SAME change.

```bash
# Push schema to dev database
pnpm -C packages/shared drizzle-kit-push-dev

# View database in Drizzle Studio
pnpm -C packages/shared drizzle-kit-studio-dev
```

### CLI Tool

```bash
# Install CLI locally for development
pnpm install-cli:dev

# Or run from apps/cli
pnpm -C apps/cli install:dev

# Uninstall CLI
pnpm -C apps/cli uninstall:dev
```

## Technology Stack

- **Framework**: Next.js 15.4.5 (App Router) with React 19.1.0
- **Styling**: Tailwind CSS v4
- **State Management**: Jotai, React Query (Tanstack Query)
- **Database**: Drizzle ORM with PostgreSQL
- **Auth**: Better Auth with GitHub OAuth, Claude OAuth integration
- **AI**: Anthropic Claude SDK, AI SDK, OpenAI (commit messages and Codex integration), Google Gemini, Amp
- **UI Components**: Radix UI primitives with shadcn/ui
- **Testing**: Vitest
- **Real-time**: PartySocket for WebSocket communication
- **Sandbox Providers**: E2B, Docker (for testing), Daytona
- **Runtime**: PartyKit (real-time infrastructure)
- **UI Development**: Ladle for component development
- **CLI**: Ink for interactive terminal UI, ORPC for type-safe API communication
- **Rich Text**: TipTap editor with slash commands
- **Email**: React Email for transactional emails
- **Deployment**: Vercel (frontend), PartyKit (WebSocket)

### Key Dependencies

- **Claude Integration**: `@anthropic-ai/sdk` (v0.52.0)
- **Sandbox Providers**: `@e2b/code-interpreter` (v1.2.0-beta.4)
- **GitHub**: Octokit (v5.0.2) for GitHub API
- **Database**: `drizzle-orm` (v0.43.1) with PostgreSQL
- **Rate Limiting**: `@upstash/ratelimit` with Redis
- **File Storage**: Cloudflare R2 integration
- **Real-time**: PartyKit (v0.0.110)
- **RPC**: `@orpc/server` (v1.6.0) for type-safe CLI-backend communication
- **Rich Text**: TipTap (v2.14.0) for advanced editor features
- **Email**: React Email for transactional email templates
- **Sandbox: Daytona**: `@daytonaio/sdk` (v0.25.5)

## Feature Flags

### Creating a Feature Flag

1. **Define the feature flag** in `packages/shared/src/model/feature-flags-definitions.ts`:

   ```typescript
   export const featureFlagsDefinitions = {
     myNewFeature: {
       defaultValue: false,
       description: "Clear description of what this feature flag enables",
     },
     // ... other flags
   } satisfies Record<string, FeatureFlagDefinition>;
   ```

2. **Use the feature flag** in React components with the `useFeatureFlag` hook:

   ```typescript
   import { useFeatureFlag } from "@/hooks/use-feature-flag";

   const MyComponent = () => {
     const isMyFeatureEnabled = useFeatureFlag("myNewFeature");

     if (isMyFeatureEnabled) {
       // Feature-specific code
     }
   };
   ```

3. **Configure feature flags** via the admin page:
   - Global settings affect all users by default
   - Per-user overrides can be set for specific users
   - The defaultValue in the definition is used when no override exists

### Deleting a Feature Flag

1. Remove all usages of the feature flag in code
2. Delete the feature flag definition from `feature-flags-definitions.ts`
3. Remove the feature flag configuration from the admin page

## Architecture Components

### Core Agent System (`apps/www/src/agent/`)

- **Sandbox Orchestration**: Multi-provider sandbox management (E2B, Docker)
- **Claude Integration**: Message processing and tool execution
- **Daemon System**: Autonomous Node.js agent running in sandboxes
- **Resource Management**: Hibernation and session lifecycle management

### Chat System (`apps/www/src/components/chat/`)

- **Real-time UI**: React-based chat interface with message streaming
- **Tool Visualization**: Custom components for bash, file operations, git diff, web search/fetch, todos
- **Message Processing**: Structured Claude message handling with tool calls
- **Status Tracking**: Thread status, sandbox state, and real-time updates
- **Rich Text Editor**: TipTap-based prompt box with mentions, image attachments, and slash commands
- **Follow-up Tasks**: Suggest follow-up task tool integration
- **Copy Features**: Copy buttons for chat messages and code blocks
- **Scroll Navigation**: Floating scroll-to-bottom button with delayed visibility

### Database Schema (`packages/shared/src/db/`)

- **Threads**: Chat sessions with sandbox and GitHub integration, parent thread relationships, task sharing
- **Users**: Authentication, settings, API key management, roles and permissions
- **Environments**: User-repository combinations with environment variables and MCP config
- **GitHub PRs**: Pull request tracking and automated workflows
- **Claude OAuth**: Token storage for Claude subscription integration
- **Thread Read Status**: Unread/read tracking for threads (marked read on archive)
- **User Flags**: Feature flags and user preferences
- **Feedback**: User feedback collection system
- **Waitlist**: Early access signup management
- **Allowed Signups**: Whitelist for user registration
- **Access Codes**: Controlled signup system with optional email binding and expiration

### GitHub Integration (`apps/www/src/server-actions/`)

- **Automated Workflows**: Branch creation, commits, and PR management
- **AI-Generated Content**: Commit messages and PR descriptions using OpenAI
- **Status Synchronization**: Real-time PR status polling and updates
- **GitHub Checks**: Webhook handlers for tracking check status
- **PR Management**: Auto-update titles/descriptions, use thread's base branch, user attribution
- **Auto-recovery**: Automatic fix for git commit/push failures with follow-up queuing

## Environment Setup

### Configuration Files

- **Environment**: `.env.example` files in apps/www, apps/broadcast, packages
- **Development**: Docker Compose with PostgreSQL 16, Redis 7
- **Deployment**: Vercel (frontend), PartyKit (WebSocket), sandbox providers
- **TypeScript**: Shared config via `@terragon/tsconfig`

### Key Environment Variables

- **AI Services**: Anthropic Claude, OpenAI, E2B API keys
- **Infrastructure**: Database URL, Redis, Cloudflare R2 storage
- **Auth**: GitHub OAuth credentials, internal shared secrets
- **Development**: ngrok for local tunnel, sandbox provider configs
- **Sandbox Providers**: `DAYTONA_API_KEY` for Daytona provider
- **Optional Providers**: Gemini API key, Amp API key, OpenAI OAuth/ChatGPT auth.json

## Package Structure

### Core Applications

- **`apps/www`**: Main Next.js frontend application
- **`apps/broadcast`**: PartyKit WebSocket service for real-time features
- **`apps/docs`**: Fumadocs-based documentation site
- **`apps/cli`**: Terry CLI tool for pulling threads (uses Ink for terminal UI)
- **`apps/isanthropicdown`**: Status microsite (Vite + Cloudflare Workers)

### Shared Packages

- **`@terragon/shared`**: Database models, schemas, and core utilities
- **`@terragon/daemon`**: Sandbox agent runtime and communication
- **`@terragon/bundled`**: Bundled scripts for deployment (includes daemon, mcp-server)
- **`@terragon/env`**: Environment configuration management
- **`@terragon/r2`**: Cloudflare R2 storage integration
- **`@terragon/dev-env`**: Docker development environment
- **`@terragon/tsconfig`**: Shared TypeScript configuration
- **`@terragon/mcp-server`**: Model Context Protocol server for follow-up task suggestions
- **`@terragon/debug-scripts`**: Debugging utilities for E2B sandboxes (SSH, connect, create, resume)
- **`@terragon/cli-api-contract`**: ORPC-based CLI API contract definitions
- **`@terragon/transactional`**: React Email-based transactional email templates
- **`@terragon/sandbox`**: Sandbox abstraction across multiple providers (E2B, Docker, Daytona)
- **`@terragon/sandbox-image`**: Sandbox image specific code to create template images for sandbox providers
- **`@terragon/one-time-token-signin`**: Better Auth plugin for magic-link/one-time token sign-in

## Important Notes

- **Package Manager**: pnpm (v10.14.0) with workspace support
- **TypeScript**: Path aliases `@/*` → `./src/*` in Next.js app
- **Monorepo**: Workspace dependencies with `workspace:*` references

### Environment Configuration

- **Development Database**: PostgreSQL on port 5432, Redis on port 6379
- **Test Database**: PostgreSQL on port 15432, Redis on port 16379
- **Environment Files**: `.env.development.local` for local development
- **Vitest Configuration**: Test environment variables are pre-configured in `vitest.config.ts`

## Troubleshooting

### Common Development Issues

- **Docker containers not starting**: Check Docker is running and ports 5432, 6379 are free
- **TypeScript errors after pulling**: Run `pnpm install` to sync dependencies
- **Database schema out of sync**: Run `pnpm -C packages/shared drizzle-kit-push-dev`
- **Sandbox connection issues**: Verify E2B API keys are set correctly
- **Ngrok tunnel issues**: Check `NGROK_AUTH_TOKEN` and `NGROK_DOMAIN` in `.env.development.local`
- **CLI not found**: Run `pnpm install-cli:dev` to install the Terry CLI locally

### Debug Scripts

```bash
# SSH into an E2B sandbox
pnpm -C packages/debug-scripts e2b-ssh <sandbox-id>
```

## Recent Features

- **Claude OAuth**: Direct Claude subscription integration for API access
- **Follow-up Queue**: Agent queue for processing follow-up tasks
- **Auto-close Draft PRs**: Setting to automatically close draft PRs on archive
- **Interactive CLI**: Pull command with thread selection interface, create task command
- **MCP Server**: Model Context Protocol server for follow-up task suggestions
- **Survey System**: User feedback collection via survey page
- **Task Sharing**: Read-only task sharing with visibility controls
- **Access Codes**: Controlled signup system with email binding and expiration
- **Slash Commands**: TipTap-based slash commands in chat prompt box
- **Active Sandboxes Admin**: Admin page for monitoring active sandboxes
- **Onboarding Emails**: Automated welcome emails for new users
- **Redo Task**: Button to restart tasks from chat header
- **Fast Resume**: Optimized sandbox setup for quicker thread resumption
- **Admin UI Enhancements**: Sortable columns, filters, thread/user counts, invite functionality
- **Automations**: Scheduled and PR-triggered automations with cron validation, next-run calculation, and admin visibility
- **Daytona Provider**: Optional Daytona sandbox provider behind feature flag with `DAYTONA_API_KEY`
- **MCP Permission Prompt**: Internal MCP tool to handle permission requests in plan mode
- **Credentials UI**: Gemini and Amp API key storage; OpenAI OAuth and ChatGPT auth.json support
- **CLI Additions**: `auth`, `list`, and `mcp` commands, plus `--resume` option for `pull`

## Release Notes

When adding new entries to release notes (`apps/docs/content/docs/resources/release-notes.mdx`):

1. Follow the template and guidelines in `apps/docs/RELEASE_NOTES_TEMPLATE.md`
2. **CRITICAL**: After adding a new release notes entry, bump the `RELEASE_NOTES_VERSION` constant in `apps/www/src/lib/constants.ts` by incrementing it by 1
3. This version bump triggers the release notes badge to appear for users, notifying them of new updates

## AI Coding Harness

This repo ships a checked-in harness for AI coding agents (Claude Code and Codex). It is
installed and regenerated by the `somnio-engineering-ai:harness-init` plugin skill; the
provenance manifest is `.claude/harness.json` (source repo, pinned revision, sha256 per file).

**What is in it**

- `.claude/settings.json` — permission deny list for secret files (`.env*`, `*.pem`, `*.key`,
  `*credentials*.json`, `auth.json`, `.netrc`, ...), a Bash allowlist, an `ask` list for
  destructive commands (`rm -rf`, `git push --force`, `terraform apply/destroy`), and the
  sandbox policy (network limited to the npm registry and GitHub; cloud/CLI tools such as
  `gh`, `wrangler`, `docker` run outside the sandbox).
- `.claude/rules/typescript/best-practices.md` — path-scoped TypeScript rule (`paths: **/*.ts`).
  Claude Code loads it lazily when a matching file is read; the rule index lives in the managed
  block of `CLAUDE.md`.
- `.claude/hooks/inject-rules.py` — `PreToolUse(Write)` hook. Path-scoped rules load on read,
  not on create, so this hook injects the matching rule body when the agent creates a NEW file.
  Tests: `python3 .claude/hooks/test_inject_rules.py`.
- `.claude/skills/` and `.codex/skills/` — vendored somnio catalog skills for each agent:
  `git-branch-format`, `git-commit-format`, `harness-audit`, `optimize-claude-config`,
  `security-audit`. The per-agent manifest is `.somnio-skills.json` in each directory; Codex
  reference material lives under `.codex/somnio_rules/`.
- `.claude/ship-gate.json` — draft of the commands a ship must pass. `required` is empty until
  the tech lead promotes entries from `_candidates` (mirrors the CI verification commands).
- Managed blocks between `<!-- somnio:harness:begin -->` and `<!-- somnio:harness:end -->` in
  `CLAUDE.md` (stack detection, rule index, verification commands), in this file (the inlined
  coding standards Codex reads, since Codex has no lazy rule loader), and in `.gitignore`
  (runtime state: `.claude/.harness/`, `.claude/*.local.md`, `.claude/settings.json.bak`).

**Rules of the road**

- Managed blocks and `.claude/rules/` are regenerated by `harness-init`. The TypeScript rule and
  the codex block below were customised for this repo after install (repo tsconfig, kebab-case
  files, no third-party service references), so their `harness.json` hashes are intentionally
  stale: on a `--reconfigure` run answer keep-mine for the rule, then re-apply the same edits to
  the regenerated codex block.
- The hook and its tests carry local fixes over the plugin asset (quoted `paths:` globs,
  out-of-tree paths, symlinks, fail-open exit); keep them when syncing from upstream.
- Repo-specific instructions belong in the hand-written sections of this file (above the
  managed block). `CLAUDE.md` imports this file via `@AGENTS.md`.
- Audit the harness with the `harness-audit` skill; the report lands in `reports/harness_audit.md`.

<!-- somnio:harness:begin -->
# System Prompt — Somnio Coding Standards (Typescript)

You are an expert software engineer. Follow these coding standards precisely when generating code.

### TypeScript conventions — naming, types, async/await, error handling, logging. Applies to all .ts files (apps, packages, scripts).
> Applies to: `**/*.ts`

### General guidelines for TypeScript code in this repo.
# TypeScript Best Practices

These rules apply to every `.ts` file in the repo (apps, packages, build
scripts, utilities). Framework-specific conventions (Next.js, Drizzle,
PartyKit, the daemon) live with the package that owns them.

Assume the reader knows JavaScript and is comfortable with static types. Do
not restate basic language mechanics.

---

## tsconfig standards

Canonical baseline is `packages/tsconfig/base.json` (`@terragon/tsconfig`).
Extend it in any new TS package unless the framework overrides a flag:

Why these flags:
- `strict: true` turns on `strictNullChecks`, `noImplicitAny`, and the rest —
  non-negotiable.
- `noUncheckedIndexedAccess` types every index access as possibly
  `undefined`. Narrow instead of assuming the element exists.
- `noUnusedLocals` makes dead variables a compile error. Remove them instead
  of prefixing `_`.
- `esModuleInterop` lets default imports work against CommonJS packages.
- `skipLibCheck` skips type-checking of `node_modules/**/*.d.ts` — faster
  builds, and we can't fix upstream types anyway.

Never downgrade `strict` to bypass an error. Fix the type.

---

## Naming

- **Functions, variables, parameters:** `camelCase`. Verb-first for functions:
  `createThread()`, `parseDaemonEvent()`.
- **Constants (module-level, immutable):** `SCREAMING_SNAKE_CASE`.
- **Types, interfaces, classes, enums:** `PascalCase`.
- **Files:** `kebab-case.ts` (e.g. `active-org.ts`, `feature-flags-definitions.ts`). Barrel files (`index.ts`) re-export only.
- **Secret/env keys:** `SCREAMING_SNAKE_CASE` strings — match the name
  declared in `@terragon/env` and `.env.example`.
- **Identifiers in code are always English.**

---

## Imports & modules

Use ES module syntax (`import`/`export`) even when the compiled output is
CommonJS. Never write `require()` in source.

Grouping: built-in → third-party → local, separated by a blank line.

Import only what you use. Prefer named imports over `import * as X` unless the
library exposes a large surface you actually consume (e.g.
`import * as schema from '@terragon/shared/db/schema'`).

Use workspace imports (`@terragon/...`) across packages, the `@/*` alias
(`./src/*`) inside `apps/www`, and relative paths within a package.

---

## Types

- **`interface` for object shapes** that are part of a public contract
  (function parameters, return types, repository models). They extend cleanly
  and produce better error messages.
- **`type` for unions, tuples, conditional types, aliases.**
- **Never `any` without a one-line comment justifying it.** At external
  boundaries (`JSON.parse`, `req.body`, library escape hatches), use `unknown`
  and narrow:

- **Type guards** are functions that narrow `unknown`/union types. Name them
  `isX()` and return `value is X`:

- **No enums for string unions.** Use a literal union type instead — it
  plays better with JSON and erases at runtime:

---

## Nullables & optionals

With `strict: true`, `null` and `undefined` are never assignable to non-null
types. Use them deliberately:

- Optional object fields: `field?: string` — the field may be absent or
  `undefined`.
- Explicitly nullable fields (present but can hold null): `field: string | null`.
- Defaults via nullish coalescing:

Avoid the non-null assertion `!` unless you add a comment explaining why the
value is guaranteed non-null. Prefer narrowing, optional chaining, or
explicit checks.

---

## Async / await

Always `async`/`await`. No `.then()` chains in source code.

Parallelize independent calls with `Promise.all`. Keep sequential only when
each step depends on the previous one:

Every `await` in a non-throwing path must be reachable from a caller that
either handles the rejection or intentionally lets it propagate (see error
handling below).

---

## Error handling

- **Throw `Error` subclasses with descriptive messages.** Define a custom
  class for domain errors you want callers to distinguish:

- **Narrow `unknown` in catches before accessing `.message`.** In strict
  mode, the catch variable is `unknown`:

- **Services throw; callers decide what to do.** Service functions (pure
  data access or external API wrappers) do not wrap their own body in
  try/catch — they let errors propagate. The route handler or orchestrator
  decides whether to fail the request, fall back to a default, or log and
  continue.

---

## Logging

- In plain Node scripts, `console.log` / `console.error` are fine.
- In library code or shared utilities, **accept a logger via dependency
  injection** rather than importing a logger module at the top level — keeps
  the utility testable without mocking `console`.
- Never log secrets, ID tokens, full request headers, or PII. If a field
  might contain user email, redact or hash before logging.

---

## What NOT to Do

- ❌ Do not write `require()` in source. Use ES module `import`.
- ❌ Do not use `any` without an explanatory comment.
- ❌ Do not mutate function parameters. Build a new object and return it.
- ❌ Do not `export *` from barrel files unless the re-exported module is
  explicitly a public surface. Prefer named re-exports.
- ❌ Do not `catch (e)` and silently swallow. Log or rethrow.
- ❌ Do not use `||` for defaults when `0`, `''`, or `false` are valid
  values — use `??`.
- ❌ Do not suppress type errors with `@ts-ignore` / `@ts-nocheck` in source.
  (Tests may use `@ts-nocheck` when mocking — that's an explicit exception.)
- ❌ Do not commit commented-out code. Delete it; git remembers.

---

## Rules

1. `strict: true` is non-negotiable. Fix type errors, don't suppress them.
2. Identifiers are English.
3. `camelCase` members, `PascalCase` types, `SCREAMING_SNAKE_CASE` constants.
4. ES module `import` only — never `require()`.
5. Group imports: built-in → third-party → local, blank line between groups.
6. `interface` for object shapes, `type` for unions and aliases. No enums for
   string unions.
7. Use `unknown` + type guards at external boundaries; never `any` without a
   comment.
8. `??` for defaults; `!` only with a comment justifying the assertion.
9. `async`/`await` only. Parallelize with `Promise.all` when calls are
   independent.
10. Catch `unknown`; narrow with `instanceof Error` before reading `.message`.
11. Services throw; callers decide how to handle. No silent swallowing.
12. Never log secrets, ID tokens, or PII.

---
<!-- somnio:harness:end -->