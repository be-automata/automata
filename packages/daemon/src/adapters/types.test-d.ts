/**
 * Type-level guard for the SHAPE-not-KIND boundary (ADR-006, #75 AC2).
 *
 * There is no expectTypeOf/type-test infra in this repo (grep-empty for
 * `expectTypeOf`), so this file uses plain `// @ts-expect-error` assertions.
 * It is a regular `.ts` file inside `tsconfig.json`'s `src/**\/*` include, so
 * `pnpm -C packages/daemon tsc-check` (and CI's `turbo tsc-check`) type-check
 * it on every run — a case that stops erroring (because a field was added to
 * `PrepareEnvContext`) fails the build with "Unused '@ts-expect-error'
 * directive", and a case that starts erroring for the wrong reason is
 * exactly the regression this guard exists to catch.
 *
 * This file contains no runtime assertions and is intentionally never
 * executed — vitest's default include glob only matches `*.test.ts`/
 * `*.spec.ts`, not `*.test-d.ts`, so it is a compile-only artifact.
 */
import { claudeAdapter } from "./claude-adapter";
import type { AIAgentCredentials, PrepareEnvContext } from "./types";

// A well-formed ctx — mirrors exactly what DaemonMessageClaudeSchema carries
// (shared.ts:17-32) plus the runtime handle. Must compile with NO error.
const validCtx: PrepareEnvContext = {
  runtime: {} as import("../runtime").IDaemonRuntime,
  useCredits: false,
  token: "TEST_TOKEN",
  normalizedUrl: "https://example.terragonlabs.com",
};
claudeAdapter.prepareEnv(validCtx);

// PrepareEnvContext must never accept a userId. Nothing below the control
// plane may branch on user identity (ADR-006 anti-deviation invariant:
// "Nothing below the control plane may branch on credential kind, user, or
// org — only on the resolved shape and agent identity").
const userIdBearingCtx: PrepareEnvContext = {
  runtime: {} as import("../runtime").IDaemonRuntime,
  useCredits: false,
  token: "TEST_TOKEN",
  normalizedUrl: "https://example.terragonlabs.com",
  // @ts-expect-error — userId must not be assignable onto PrepareEnvContext.
  userId: "user_123",
};
claudeAdapter.prepareEnv(userIdBearingCtx);

// PrepareEnvContext must never accept an organizationId.
const orgIdBearingCtx: PrepareEnvContext = {
  runtime: {} as import("../runtime").IDaemonRuntime,
  useCredits: false,
  token: "TEST_TOKEN",
  normalizedUrl: "https://example.terragonlabs.com",
  // @ts-expect-error — organizationId must not be assignable onto PrepareEnvContext.
  organizationId: "org_123",
};
claudeAdapter.prepareEnv(orgIdBearingCtx);

// PrepareEnvContext must never carry a credential KIND (AIAgentCredentials,
// the env-var|json-file|built-in-credits union). KIND resolution stays in
// apps/www/src/agent/credentials.ts; the daemon only ever sees an
// already-resolved token/useCredits, never the kind that produced them.
// This is the grounded correction to the ticket's originally proposed
// `{creds: AIAgentCredentials; ...}` ctx shape.
const kindBearingCtx: PrepareEnvContext = {
  runtime: {} as import("../runtime").IDaemonRuntime,
  useCredits: false,
  token: "TEST_TOKEN",
  normalizedUrl: "https://example.terragonlabs.com",
  // @ts-expect-error — a credential-kind field must not be assignable onto PrepareEnvContext.
  creds: { type: "env-var", key: "X", value: "y" } satisfies AIAgentCredentials,
};
claudeAdapter.prepareEnv(kindBearingCtx);

// `boxApiKey` is grep-empty repo-wide (the ticket invented this field);
// PrepareEnvContext must not carry it.
const boxApiKeyBearingCtx: PrepareEnvContext = {
  runtime: {} as import("../runtime").IDaemonRuntime,
  useCredits: false,
  token: "TEST_TOKEN",
  normalizedUrl: "https://example.terragonlabs.com",
  // @ts-expect-error — boxApiKey must not be assignable onto PrepareEnvContext.
  boxApiKey: "sk-box-should-not-exist",
};
claudeAdapter.prepareEnv(boxApiKeyBearingCtx);
