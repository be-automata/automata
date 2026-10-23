import { randomBytes, randomUUID } from "node:crypto";

import {
  sealBindingOf,
  sealRunSecrets,
  type PlanePublicKey,
  type RunSecrets,
} from "@terragon/utils/payload-seal";

import type { AgentRunVariantName } from "../../src/agent-run/definition";
import type { AgentRunWireInput } from "../../src/agent-run/run-secrets";
import type {
  AgentRunInput,
  EgressPolicyShape,
  PulledDaemonMessage,
  ReviewAgentShape,
} from "../../src/agent-run/types";
import type { CanaryLane } from "./thread-spec";

/**
 * Builds one run EXACTLY as www's dispatchAgentRun does
 * (apps/www/src/agent/hatchet/dispatch.ts + transport.ts), for the lanes the
 * canary drives. DEV ONLY. What differs from www, on purpose:
 *
 *  - no database: the thread ids are fresh UUIDs and the "thread row" is the
 *    spec file dispatch.mts writes for the stub;
 *  - the org is a constant (`CANARY_ORG_ID`), so there are no settings rows:
 *    a review gets the classic system-default review agent, a task run gets
 *    no packs (and so no read-only GitHub token), and there is no repo env;
 *  - the egress policy is absent (the worker then runs its proxy in OBSERVE
 *    mode) unless the operator asks for `--egress-allow`, which builds the
 *    worker-plane shape www would: level `domain`, the callback host and
 *    api.anthropic.com, plus the operator entries.
 */

/** www's supersede policies → registered variant (transport.ts POLICY_TO_WORKFLOW). */
export const POLICY_TO_WORKFLOW = {
  "newest-wins": "agent-run-newest",
  "complete-run-queue": "agent-run-strict",
  "complete-run-discard": "agent-run-discard",
} as const satisfies Record<string, AgentRunVariantName>;
export type SupersedePolicy = keyof typeof POLICY_TO_WORKFLOW;

export function isSupersedePolicy(value: unknown): value is SupersedePolicy {
  return typeof value === "string" && value in POLICY_TO_WORKFLOW;
}

/**
 * The classic review agent www resolves when neither the repo nor the org
 * row sets anything (resolve-review-agent.ts: DEFAULT_REVIEW_BATTERIES,
 * runTests false, CLASSIC_COMMAND_TIMEOUT_MS).
 */
export const CLASSIC_REVIEW_AGENT: ReviewAgentShape = {
  mode: "classic",
  batteries: ["gstack-review", "somnio-review", "gsd-reviewers"],
  runTests: false,
  commandTimeoutMs: 60_000,
};

export const DEFAULT_CANARY_ORG_ID = "canary-org";

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** dispatch.ts generateTraceparent. */
export function generateTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

/** remote-task-pr.ts remoteTaskBranchName. */
export function remoteTaskBranchName(threadId: string): string {
  return `automata/task-${threadId.slice(0, 8).toLowerCase()}`;
}

/** supersede-recheck.ts buildPrKey. */
export function buildPrKey(
  orgId: string,
  repoFullName: string,
  prNumber: number,
): string {
  return `${orgId}/${repoFullName.trim().toLowerCase()}/${prNumber}`;
}

/** The worker-plane egress shape (resolve-egress-policy.ts systemEgressHosts("worker")). */
export function canaryEgressPolicy(
  callbackUrl: string,
  extra: readonly string[],
): EgressPolicyShape {
  const system = [new URL(callbackUrl).host, "api.anthropic.com"];
  const allowlist = [
    ...new Set([...extra, ...system].map((e) => e.trim().toLowerCase())),
  ].filter((e) => e !== "");
  return { level: "domain", allowlist };
}

export interface CanaryRunArgs {
  lane: CanaryLane;
  repoFullName: string;
  /** The branch the run checks out (the PR head for review/mention). */
  branch: string;
  /** PR base (review/mention). */
  baseBranch?: string;
  prNumber?: number;
  callbackUrl: string;
  orgId: string;
  policy: SupersedePolicy;
  egressPolicy?: EgressPolicyShape;
  prompt: string;
  model: string;
  permissionMode: PulledDaemonMessage["permissionMode"];
  /** Injected for tests. */
  threadId?: string;
  threadChatId?: string;
  deliveryId?: string;
  traceparent?: string;
}

export interface CanaryRun {
  workflowName: AgentRunVariantName;
  input: AgentRunInput;
  additionalMetadata: Record<string, string>;
  /** What next-message serves. */
  message: PulledDaemonMessage;
  prKey?: string;
}

/** The run's workflow, input and metadata — dispatchAgentRun's assembly, lane by lane. */
export function buildCanaryRun(args: CanaryRunArgs): CanaryRun {
  const threadId = args.threadId ?? randomUUID();
  const threadChatId = args.threadChatId ?? randomUUID();
  if (args.lane !== "task" && args.prNumber === undefined) {
    throw new Error(`--lane ${args.lane} needs --pr`);
  }
  if (args.lane === "task" && args.prNumber !== undefined) {
    throw new Error("--lane task runs have no PR (drop --pr)");
  }
  const base: AgentRunInput = {
    threadId,
    threadChatId,
    repoFullName: args.repoFullName,
    branch: args.branch,
    ...(args.baseBranch !== undefined && args.baseBranch !== args.branch
      ? { baseBranch: args.baseBranch }
      : {}),
    daemonCallbackUrl: args.callbackUrl,
    orgId: args.orgId,
    ...(args.prNumber !== undefined ? { prNumber: args.prNumber } : {}),
    traceparent: args.traceparent ?? generateTraceparent(),
    ...(args.egressPolicy ? { egressPolicy: args.egressPolicy } : {}),
  };
  const message: PulledDaemonMessage = {
    type: "claude",
    model: args.model,
    agent: "claudeCode",
    agentVersion: 1,
    prompt: args.prompt,
    sessionId: null,
    permissionMode: args.permissionMode,
    featureFlags: {},
  };
  if (args.lane === "review") {
    const prNumber = args.prNumber as number;
    const prKey = buildPrKey(args.orgId, args.repoFullName, prNumber);
    const workflowName = POLICY_TO_WORKFLOW[args.policy];
    return {
      workflowName,
      input: {
        ...base,
        prKey,
        deliveryId: args.deliveryId ?? `manual:${threadId}:${randomHex(8)}`,
        supersedePolicy: args.policy,
        recheckOnComplete: false,
        reviewAgent: CLASSIC_REVIEW_AGENT,
      },
      // transport.ts buildReviewRunMetadata (metaVersion "1").
      additionalMetadata: {
        metaVersion: "1",
        threadId,
        threadChatId,
        orgId: args.orgId,
        repoFullName: args.repoFullName.trim().toLowerCase(),
        prNumber: String(prNumber),
        lane: "review",
        supersedePolicy: args.policy,
        recheckOnComplete: "false",
      },
      message,
      prKey,
    };
  }
  // Task and mention keep the legacy plan: workflow `agent-run`, ids-only
  // metadata. A task run on its base branch works on its own branch.
  const input: AgentRunInput =
    args.lane === "task"
      ? { ...base, workBranch: remoteTaskBranchName(threadId) }
      : base;
  return {
    workflowName: "agent-run",
    input,
    additionalMetadata: { threadId, threadChatId },
    message,
  };
}

/** dispatch.ts sealWireInput: every secret into the envelope, AAD = the whole input. */
export async function sealCanaryInput(
  input: AgentRunInput,
  secrets: RunSecrets,
  planeKey: PlanePublicKey,
): Promise<AgentRunWireInput> {
  const sealedSecrets = await sealRunSecrets(
    planeKey,
    secrets,
    sealBindingOf(input),
  );
  return { ...input, sealedSecrets };
}

/** A fresh daemon token: 32 random bytes, base64url (never derived from anything). */
export function mintCanaryDaemonToken(): string {
  return randomBytes(32).toString("base64url");
}
