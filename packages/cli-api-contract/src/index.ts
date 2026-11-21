import { oc as ocBase } from "@orpc/contract";
import { AIModelExternalSchema } from "@terragon/agent/types";
import {
  EGRESS_ACCESS_REFUSALS,
  EGRESS_ENTRY_CODES,
  EGRESS_WARNING_CODES,
} from "@terragon/types/egress";
import * as z from "zod/v4";

const oc = ocBase.errors({
  UNAUTHORIZED: {
    message: "Unauthorized",
  },
  NOT_FOUND: {
    message: "Not found",
  },
  INTERNAL_ERROR: {
    message: "Internal server error",
  },
  RATE_LIMIT_EXCEEDED: {
    message: "Rate limit exceeded",
  },
  // Thrown by the shared auth middleware of every procedure (a retryable
  // auth-store failure), so it is declared at the base (spike 055, rule 6).
  SERVICE_UNAVAILABLE: {
    status: 503,
    message: "Service temporarily unavailable",
    data: z.object({ reason: z.enum(["auth_unavailable"]) }).optional(),
  },
});

// Define individual contracts
const listThreadsContract = oc
  .input(
    z.object({
      repo: z.string().optional(),
    }),
  )
  .output(
    z.array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        branchName: z.string().nullable(),
        githubRepoFullName: z.string().nullable(),
        githubPRNumber: z.number().nullable(),
        status: z.string(),
        updatedAt: z.date(),
        isUnread: z.boolean(),
        hasChanges: z.boolean().optional(),
      }),
    ),
  );

const threadDetailContract = oc
  .input(
    z.object({
      threadId: z.string(),
    }),
  )
  .output(
    z.object({
      threadId: z.string(),
      sessionId: z.string().nullable(),
      name: z.string().nullable(),
      branchName: z.string().nullable(),
      baseBranchName: z.string().nullable(),
      githubRepoFullName: z.string().nullable(),
      githubPRNumber: z.number().nullable(),
      jsonl: z.array(z.any()).nullable(),
      agent: z.enum(["claudeCode", "gemini", "amp", "codex", "opencode"]),
      hasChanges: z.boolean().optional(),
    }),
  );

const createThreadContract = oc
  .input(
    z.object({
      message: z.string(),
      githubRepoFullName: z.string(),
      repoBaseBranchName: z.string().optional(),
      createNewBranch: z.boolean().optional(),
      // Optional task mode from CLI
      mode: z.enum(["plan", "execute"]).optional(),
      // Optional model selection from CLI
      model: AIModelExternalSchema.optional(),
    }),
  )
  .output(
    z.object({
      threadId: z.string(),
      branchName: z.string().nullable(),
    }),
  );

// ---- Repo egress (#728) ----------------------------------------------------

const EntryErrorSchema = z.object({
  code: z.enum(EGRESS_ENTRY_CODES),
  message: z.string(),
  // null when the validator refuses to echo the entry, or for set-level codes
  entry: z.string().nullable(),
  // null for set-level codes (too_many_entries, level_unsupported_in_cell)
  index: z.number().int().nullable(),
});

const egressOc = oc.errors({
  FORBIDDEN: {
    status: 403,
    message: "Forbidden",
    data: z.object({ reason: z.enum(EGRESS_ACCESS_REFUSALS) }),
  },
  BAD_REQUEST: {
    status: 400,
    message: "Invalid egress settings",
    data: z.object({ errors: z.array(EntryErrorSchema).min(1) }),
  },
});

const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

const RepoPath = z.object({
  // org id or slug (OD-8)
  org: z.string().min(1).max(128),
  owner: z.string().min(1).max(100).regex(REPO_SEGMENT),
  repo: z.string().min(1).max(100).regex(REPO_SEGMENT),
});

const Level = z.enum(["none", "ip_port", "domain"]);
const Layer = z.enum(["system", "platform", "registries", "repo"]);
const HostEntry = z.object({ host: z.string(), layer: Layer });

const EgressView = z.object({
  org: z.object({ id: z.string(), slug: z.string() }),
  // lowercased owner/name
  repo: z.string(),
  stored: z.object({
    level: Level.nullable(),
    allowlist: z.array(z.string()),
    registries: z.boolean().nullable(),
    // ISO 8601, the compare-and-set token
    updatedAt: z.string().nullable(),
    updatedByUserId: z.string().nullable(),
  }),
  box: z.object({
    enforced: z.boolean(),
    allowlist: z.array(HostEntry),
    // a stored value the box builder throws on
    error: z.literal("invalid_policy").nullable(),
  }),
  cell: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      entries: z.array(HostEntry),
      bundles: z.array(z.string()),
      digest: z.string(),
    }),
    z.object({
      ok: z.literal(false),
      code: z.enum([
        "egress_level_unsupported",
        "egress_compile_failed",
        "broker_host_unavailable",
      ]),
      reason: z.string().nullable(),
    }),
  ]),
  warnings: z.array(
    z.object({
      code: z.enum(EGRESS_WARNING_CODES),
      entry: z.string().nullable(),
    }),
  ),
  // drives the read-only state of the UI
  canEdit: z.boolean(),
  readOnlyReason: z
    .enum(["not_repo_admin", "permission_unverified"])
    .nullable(),
  // used = rendered cell entries (platform + registries + repo, deduped)
  budget: z.object({ used: z.number().int(), max: z.number().int() }),
});

const egressGet = egressOc
  .route({
    method: "GET",
    path: "/v1/orgs/{org}/repos/{owner}/{repo}/egress",
    summary: "Read a repo's egress settings",
  })
  .input(RepoPath)
  .output(EgressView);

const HistoryEntry = z.object({
  id: z.string(),
  createdAt: z.string(),
  actorUserId: z.string(),
  authKind: z.enum(["api_key", "session"]),
  levelBefore: Level.nullable(),
  levelAfter: Level.nullable(),
  hostsAdded: z.array(z.string()),
  hostsRemoved: z.array(z.string()),
  registriesBefore: z.boolean().nullable(),
  registriesAfter: z.boolean().nullable(),
});

const egressHistory = egressOc
  .route({
    method: "GET",
    path: "/v1/orgs/{org}/repos/{owner}/{repo}/egress/history",
    summary: "List a repo's egress changes, newest first",
  })
  .input(
    RepoPath.extend({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      before: z.string().max(512).optional(),
    }),
  )
  .output(
    z.object({
      entries: z.array(HistoryEntry),
      nextBefore: z.string().nullable(),
    }),
  );

// The page register needs the org's stored rows with an explicit org (the
// legacy list reads the active org). Stored fields only, no effective view.
const egressList = egressOc
  .route({
    method: "GET",
    path: "/v1/orgs/{org}/egress",
    summary: "List an org's repos that have egress settings",
  })
  .input(z.object({ org: RepoPath.shape.org }))
  .output(
    z.object({
      org: z.object({ id: z.string(), slug: z.string() }),
      repos: z.array(
        z.object({
          repo: z.string(),
          level: Level.nullable(),
          allowlistCount: z.number().int(),
          registries: z.boolean().nullable(),
          updatedAt: z.string(),
        }),
      ),
    }),
  );

// Define the CLI API contract router
export const cliAPIContract = {
  threads: {
    list: listThreadsContract,
    detail: threadDetailContract,
    create: createThreadContract,
  },
  auth: {
    // Minimal endpoint for VSCode to discover the current user id
    whoami: oc.input(z.void()).output(z.object({ userId: z.string() })),
  },
  egress: {
    get: egressGet,
    history: egressHistory,
    list: egressList,
  },
};
