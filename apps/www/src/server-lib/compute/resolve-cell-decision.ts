import type { DB } from "@terragon/shared/db";
import type {
  RepoReviewSetting,
  ThreadSourceMetadata,
  ThreadTrustContext,
} from "@terragon/shared/db/types";
import type { EgressPolicyShape } from "@terragon/shared/model/egress-policy";
import {
  CELL_FIELDS,
  loadCellPolicy,
  registeredCellPolicyModule,
  type CellDecision,
  type CellFacts,
  type CellPolicy,
  type CellPolicyInput,
} from "@terragon/shared/cell-policy/cell-policy";
import {
  getCurrentProfileEvidence,
  getExecutionProfileByConfiguration,
  insertCellDecision,
  profileRecordForPolicy,
} from "@terragon/shared/model/execution-profiles";
import { getOrganizationReviewSetting } from "@terragon/shared/model/organization-review-settings";
import {
  TRUST_ORDER,
  trustRank,
  type TrustedAuthorThreshold,
} from "@terragon/review/settings/posture-lattice";
import type { RunDisplayLane } from "@terragon/utils/run-lane";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import { composeTrustedAuthorThreshold } from "@/server-lib/review/resolve-permission-mode";
import { systemEgressHosts } from "@/server-lib/egress/resolve-egress-policy";

/**
 * ADR-014 Testing step 5, slice 1: the `allow_cell` resolver at the dispatch
 * seam, in SHADOW mode. It decides and records; it never refuses a run.
 *
 * Every input is derived on the server (ADR-005 §3b): lane, repository
 * visibility (GitHub, fail closed to private), trust snapshot, secret NAMES,
 * egress mode (`egressPolicyFromRow`: a shape = enforce, none = observe) and
 * the profile's evidence rows, evaluated against the server clock.
 *
 * Profile: every Hatchet dispatch runs on Automata's own box today, so the
 * profile is `automata-box` / `customer_box`, picked by its configuration
 * `{ egress_mode }`. No row (a fresh database) means `{}`, which the policy
 * denies as `unknown_profile`.
 */

export const CELL_DECISION_MODE = "shadow" as const;

/** The provider/tier of the execution box every Hatchet run lands on today. */
export const AUTOMATA_BOX = {
  provider: "automata-box",
  tier: "customer_box",
} as const;

/** GitHub visibility lookup budget: shadow work must never stall a dispatch. */
const VISIBILITY_TIMEOUT_MS = 3_000;

export type RepoVisibility = "public" | "private";

export type CellRunFacts = {
  lane: RunDisplayLane;
  /** A PR companion run executes untrusted PR content (display lane `pr`). */
  isCompanionRun: boolean;
  /** `null` when GitHub could not be asked: treated as private. */
  repoVisibility: RepoVisibility | null;
  trustContext: ThreadTrustContext | null | undefined;
  trustedAuthorThreshold: TrustedAuthorThreshold;
  sourceType: ThreadSourceMetadata["type"] | null | undefined;
  /** Names of the secrets the run may receive, never values. */
  secretNames: string[];
};

/**
 * The PR content counts as trusted only for a same-repo, non-fork PR whose
 * author is at or above the trusted-author threshold (ADR-005 §4). Missing
 * trust data fails closed (ADR-005 §3a).
 */
export function isTrustedPrContent(
  trust: ThreadTrustContext | null | undefined,
  threshold: TrustedAuthorThreshold,
): boolean {
  if (!trust || trust.isFork || trust.isCrossRepo !== false) {
    return false;
  }
  const association = trust.authorAssociation as TrustedAuthorThreshold;
  if (!(TRUST_ORDER as readonly string[]).includes(association)) {
    return false;
  }
  return trustRank(association) >= trustRank(threshold);
}

/** Thread sources whose prompt is written by a signed-in member in www. */
const MEMBER_AUTHORED_SOURCES: ReadonlySet<string> = new Set([
  "www-fork",
  "www-multi-agent",
]);

/**
 * The cell facts, all derived here (provenance `server`):
 * - `repo_visibility`: GitHub's answer, `private` when unknown.
 * - `data_class`: `public` for a public repository, else `internal`. No
 *   finer classification exists yet, and a private repo is never `public`.
 * - `untrusted_content`: PR lanes and companions per the trust snapshot;
 *   task and self-heal runs only when a member wrote the prompt in www
 *   (no source metadata, or a www source) — a mention, an automation or an
 *   issue counts as untrusted.
 * - `irreversible`: false. No lane today merges, deploys or deletes; their
 *   effects are branches, pull requests and comments.
 * - `needs_egress`: the system hosts every worker-plane run must reach.
 */
export function cellFactsForRun(facts: CellRunFacts): CellFacts {
  const repoVisibility = facts.repoVisibility ?? "private";
  const prFamily =
    facts.isCompanionRun || facts.lane === "review" || facts.lane === "pr";
  const untrusted = prFamily
    ? facts.isCompanionRun ||
      !isTrustedPrContent(facts.trustContext, facts.trustedAuthorThreshold)
    : !(
        facts.sourceType == null ||
        MEMBER_AUTHORED_SOURCES.has(facts.sourceType)
      );
  return {
    data_class: repoVisibility === "public" ? "public" : "internal",
    repo_visibility: repoVisibility,
    untrusted_content: untrusted,
    irreversible: false,
    lane: facts.lane,
    secrets: [...new Set(facts.secretNames)].sort(),
    needs_egress: systemEgressHosts("worker"),
  };
}

/** The box configuration a run lands on: the worker enforces iff it got a shape. */
export function boxConfigurationFor(
  egressPolicy: EgressPolicyShape | null | undefined,
): { egress_mode: "enforce" | "observe" } {
  return { egress_mode: egressPolicy ? "enforce" : "observe" };
}

let policyPromise: Promise<CellPolicy> | null = null;

/**
 * The policy, instantiated once per isolate. On Workers the module comes from
 * the Worker entry (workerd refuses to compile WASM bytes); in Node it is read
 * from the committed file. A failed load is not cached.
 */
export function getCellPolicy(): Promise<CellPolicy> {
  if (!policyPromise) {
    policyPromise = (async () => {
      const module = registeredCellPolicyModule();
      if (module) {
        return loadCellPolicy(module);
      }
      const { readCellPolicyWasm } = await import(
        "@terragon/shared/cell-policy/cell-policy-file"
      );
      return loadCellPolicy(await readCellPolicyWasm());
    })().catch((error: unknown) => {
      policyPromise = null;
      throw error;
    });
  }
  return policyPromise;
}

/** Test seam: drop the cached instance. */
export function resetCellPolicyForTests(): void {
  policyPromise = null;
}

/**
 * GitHub's `private` flag for the repo; null when it cannot be read in time.
 * One deadline covers the whole lookup, the installation-token mint inside
 * `getOctokitForApp` included, so a slow or hung GitHub never delays a
 * dispatch (shadow mode must not cost a run anything). Null is read as
 * private downstream (fail closed).
 */
export async function readRepoVisibility(
  repoFullName: string,
  deps: {
    getOctokit?: typeof getOctokitForApp;
    timeoutMs?: number;
  } = {},
): Promise<RepoVisibility | null> {
  const timeoutMs = deps.timeoutMs ?? VISIBILITY_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  const lookup = (async (): Promise<RepoVisibility | null> => {
    const [owner, repo] = parseRepoFullName(repoFullName);
    const octokit = await (deps.getOctokit ?? getOctokitForApp)({
      owner,
      repo,
    });
    const { data } = await octokit.rest.repos.get({
      owner,
      repo,
      request: { signal: controller.signal },
    });
    return data.private ? "private" : "public";
  })().catch(() => null);
  try {
    return await Promise.race([lookup, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export type ResolvedCellDecision = CellDecision & {
  profileId: string | null;
  evidenceIds: string[];
  input: CellPolicyInput;
};

/**
 * Evaluate `allow_cell` for one run. Throws on any failure (database, WASM,
 * malformed evidence); the shadow recorder below turns that into a denial.
 */
export async function resolveCellDecision({
  db,
  facts,
  egressPolicy,
  now,
  policy,
  box = AUTOMATA_BOX,
}: {
  db: DB;
  facts: CellFacts;
  egressPolicy: EgressPolicyShape | null | undefined;
  now: Date;
  policy?: CellPolicy;
  /** The box's catalog key; a parameter only so tests can isolate rows. */
  box?: { provider: string; tier: "customer_box" | "managed" };
}): Promise<ResolvedCellDecision> {
  const configuration = boxConfigurationFor(egressPolicy);
  const profileRow = await getExecutionProfileByConfiguration({
    db,
    ...box,
    configuration,
  });
  let profile: CellPolicyInput["profile"] = {};
  let evidenceIds: string[] = [];
  if (profileRow) {
    const evidence = await getCurrentProfileEvidence({
      db,
      profileId: profileRow.id,
    });
    // The allowlist is per repo, not measured: in enforce mode it is the
    // run's own resolved shape (system hosts included).
    const record = profileRecordForPolicy(profileRow, evidence, {
      capabilities: egressPolicy
        ? { egress_allowlist: egressPolicy.allowlist }
        : {},
    });
    profile = record.profile;
    evidenceIds = record.evidenceIds;
  }
  const input: CellPolicyInput = {
    now: now.toISOString(),
    cell: facts,
    provenance: Object.fromEntries(CELL_FIELDS.map((f) => [f, "server"])),
    profile,
  };
  const decision = (policy ?? (await getCellPolicy())).evaluate(input);
  return { ...decision, profileId: profileRow?.id ?? null, evidenceIds, input };
}

/**
 * The dispatch seam in shadow mode: resolve, write one `cell_decision` row,
 * log one line, and return. NEVER throws and never changes the dispatch: a
 * resolver, WASM or GitHub failure is recorded as
 * `allowed=false, reasons=['resolver_error']`; a failed insert is logged.
 */
export async function recordShadowCellDecision({
  db,
  threadId,
  threadChatId,
  organizationId,
  repoFullName,
  lane,
  isCompanionRun,
  trustContext,
  sourceType,
  secretNames,
  egressPolicy,
  repoRow,
  now = () => new Date(),
  deps = {},
}: {
  db: DB;
  threadId: string;
  threadChatId: string;
  organizationId: string | null;
  repoFullName: string;
  lane: RunDisplayLane;
  isCompanionRun: boolean;
  trustContext: ThreadTrustContext | null | undefined;
  sourceType: ThreadSourceMetadata["type"] | null | undefined;
  secretNames: string[];
  egressPolicy: EgressPolicyShape | null | undefined;
  repoRow: Pick<RepoReviewSetting, "trustedAuthorThreshold"> | undefined;
  now?: () => Date;
  deps?: {
    readRepoVisibility?: typeof readRepoVisibility;
    resolve?: typeof resolveCellDecision;
  };
}): Promise<void> {
  let row: {
    allowed: boolean;
    reasons: string[];
    profileId: string | null;
    evidenceIds: string[];
    input: CellPolicyInput | null;
  };
  try {
    const [repoVisibility, orgRow] = await Promise.all([
      (deps.readRepoVisibility ?? readRepoVisibility)(repoFullName),
      organizationId
        ? getOrganizationReviewSetting({ db, organizationId })
        : Promise.resolve(undefined),
    ]);
    const facts = cellFactsForRun({
      lane,
      isCompanionRun,
      repoVisibility,
      trustContext,
      trustedAuthorThreshold: composeTrustedAuthorThreshold(orgRow, repoRow),
      sourceType,
      secretNames,
    });
    const resolved = await (deps.resolve ?? resolveCellDecision)({
      db,
      facts,
      egressPolicy,
      now: now(),
    });
    row = resolved;
  } catch (error) {
    console.warn("[cell] resolver error (shadow: dispatch proceeds)", {
      threadId,
      threadChatId,
      error: error instanceof Error ? error.message : String(error),
    });
    row = {
      allowed: false,
      reasons: ["resolver_error"],
      profileId: null,
      evidenceIds: [],
      input: null,
    };
  }

  console.log("[cell] allow_cell decision", {
    threadId,
    threadChatId,
    seam: "dispatch",
    mode: CELL_DECISION_MODE,
    profileId: row.profileId,
    allowed: row.allowed,
    reasons: row.reasons,
  });

  try {
    await insertCellDecision({
      db,
      decision: {
        threadId,
        threadChatId,
        organizationId,
        profileId: row.profileId,
        allowed: row.allowed,
        reasons: row.reasons,
        evidenceIds: row.evidenceIds,
        seam: "dispatch",
        mode: CELL_DECISION_MODE,
        input: row.input as Record<string, unknown> | null,
      },
    });
  } catch (error) {
    console.warn(
      "[cell] cell_decision insert failed (shadow: dispatch proceeds)",
      {
        threadId,
        threadChatId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}
