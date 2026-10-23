/**
 * Canary dispatcher for the ADR-013 throwaway box: builds a run exactly as
 * www's dispatchAgentRun does, seals it to the box's plane key and triggers
 * the real workflow on the box's OWN hatchet-lite. DEV ONLY — see ./README.md.
 *
 *   --lane task|review|mention  --repo owner/name  --prompt "…"
 *   [--pr N] [--branch B] [--base B] [--policy newest-wins|complete-run-queue|complete-run-discard]
 *   [--model sonnet] [--permission-mode allowAll|plan|review]
 *   [--callback-url https://…] [--egress-allow host ...]
 *
 * Env: CANARY_REPOS, CANARY_GH_APP_ID, CANARY_GH_INSTALLATION_ID,
 * CANARY_GH_APP_KEY_FILE, CANARY_CALLBACK_URL, CANARY_STATE_DIR,
 * CANARY_SEAL_KEY_FILE (default /etc/automata/payload-seal.key),
 * CANARY_SEAL_KID (default: the ring's newest), CANARY_ORG_ID,
 * HATCHET_CLIENT_TOKEN (+ optional HATCHET_CLIENT_HOST_PORT / _API_URL /
 * _TLS_STRATEGY) — the engine must be loopback or dispatch refuses.
 */
import { parseArgs } from "node:util";

import { Hatchet } from "@hatchet-dev/typescript-sdk";
import { publicKeyOf } from "@terragon/utils/payload-seal";

import { readGuardedFile } from "../../src/agent-run/guarded-file";
import {
  DEFAULT_PAYLOAD_SEAL_KEY_FILE,
  readPlaneKeyFile,
} from "../../src/agent-run/payload-seal-keys";
import type { PulledDaemonMessage } from "../../src/agent-run/types";
import { resolveLocalEngine } from "./engine-guard";
import {
  assertRepoAllowed,
  CanaryRefusal,
  mintInstallationToken,
  parseRepoAllowlist,
  readPullRequestRefs,
  revokeInstallationToken,
} from "./github-token";
import {
  buildCanaryRun,
  canaryEgressPolicy,
  DEFAULT_CANARY_ORG_ID,
  isSupersedePolicy,
  mintCanaryDaemonToken,
  sealCanaryInput,
} from "./run-input";
import { CANARY_HEALTH_MARKER, CANARY_HEALTH_PATH } from "./stub-core";
import {
  isCanaryLane,
  removeThreadSpec,
  writeThreadSpec,
  type CanaryThreadSpec,
} from "./thread-spec";

const PERMISSION_MODES = ["allowAll", "plan", "review"] as const;

function fail(message: string, code = 2): never {
  console.error(`canary dispatch: ${message}`);
  process.exit(code);
}

async function assertCallbackIsStub(callbackUrl: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(
      `${callbackUrl.replace(/\/+$/, "")}${CANARY_HEALTH_PATH}`,
      {
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (err) {
    throw new CanaryRefusal(
      `callback URL unreachable (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const body = (await res.json().catch(() => null)) as {
    canary?: unknown;
  } | null;
  if (!res.ok || body?.canary !== CANARY_HEALTH_MARKER) {
    throw new CanaryRefusal(
      "callback URL does not answer as the canary stub; refusing to send a run's callbacks anywhere else",
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      lane: { type: "string" },
      repo: { type: "string" },
      prompt: { type: "string" },
      pr: { type: "string" },
      branch: { type: "string" },
      base: { type: "string" },
      policy: { type: "string", default: "newest-wins" },
      model: { type: "string", default: "sonnet" },
      "permission-mode": { type: "string" },
      "callback-url": { type: "string" },
      "egress-allow": { type: "string", multiple: true },
    },
    strict: true,
  });

  const lane = values.lane;
  if (!isCanaryLane(lane)) fail("--lane must be task, review or mention");
  if (!values.repo) fail("--repo owner/name is required");
  if (!values.prompt?.trim()) fail("--prompt is required");
  // FIRST, before any secret is read: the repo allowlist (the App key can
  // mint for every repository of the org).
  const { name: repoName } = assertRepoAllowed(
    values.repo,
    parseRepoAllowlist(process.env.CANARY_REPOS),
  );
  const repoFullName = values.repo;
  if (!isSupersedePolicy(values.policy))
    fail("--policy is not a supersede policy");
  const permissionMode = (values["permission-mode"] ??
    (lane === "review"
      ? "review"
      : "allowAll")) as PulledDaemonMessage["permissionMode"];
  if (!(PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    fail("--permission-mode must be allowAll, plan or review");
  }
  let prNumber: number | undefined;
  if (values.pr !== undefined) {
    prNumber = Number(values.pr);
    if (!Number.isInteger(prNumber) || prNumber < 1)
      fail("--pr must be a PR number");
  }

  const engine = resolveLocalEngine(process.env);
  const callbackUrl = values["callback-url"] ?? process.env.CANARY_CALLBACK_URL;
  if (!callbackUrl) fail("--callback-url (or CANARY_CALLBACK_URL) is required");
  await assertCallbackIsStub(callbackUrl);

  const ring = readPlaneKeyFile(
    process.env.CANARY_SEAL_KEY_FILE ?? DEFAULT_PAYLOAD_SEAL_KEY_FILE,
  );
  const kid = process.env.CANARY_SEAL_KID?.trim();
  const planeKey = kid ? ring.find((k) => k.kid === kid) : ring[0];
  if (!planeKey) fail(`seal key ring has no kid ${JSON.stringify(kid)}`);

  const appId =
    process.env.CANARY_GH_APP_ID ?? fail("CANARY_GH_APP_ID is required");
  const installationId =
    process.env.CANARY_GH_INSTALLATION_ID ??
    fail("CANARY_GH_INSTALLATION_ID is required");
  const appKeyFile =
    process.env.CANARY_GH_APP_KEY_FILE ??
    fail("CANARY_GH_APP_KEY_FILE is required");
  const minted = await mintInstallationToken({
    appId,
    installationId,
    privateKeyPem: readGuardedFile(appKeyFile, {
      ownerOnly: true,
      maxBytes: 16 * 1024,
    }),
    repoName,
    lane,
  });

  const stateDir = process.env.CANARY_STATE_DIR ?? "/var/lib/automata-canary";
  let specWritten: string | null = null;
  try {
    let branch = values.branch;
    let baseBranch = values.base;
    if (
      prNumber !== undefined &&
      (branch === undefined || baseBranch === undefined)
    ) {
      const refs = await readPullRequestRefs({
        token: minted.token,
        repoFullName,
        prNumber,
      });
      branch ??= refs.head;
      baseBranch ??= refs.base;
    }
    const orgId = process.env.CANARY_ORG_ID?.trim() || DEFAULT_CANARY_ORG_ID;
    const run = buildCanaryRun({
      lane,
      repoFullName,
      branch: branch ?? "main",
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      ...(prNumber !== undefined ? { prNumber } : {}),
      callbackUrl,
      orgId,
      policy: values.policy,
      ...(values["egress-allow"]?.length
        ? {
            egressPolicy: canaryEgressPolicy(
              callbackUrl,
              values["egress-allow"],
            ),
          }
        : {}),
      prompt: values.prompt as string,
      model: values.model as string,
      permissionMode,
    });
    const daemonToken = mintCanaryDaemonToken();
    const spec: CanaryThreadSpec = {
      version: 1,
      threadId: run.input.threadId,
      threadChatId: run.input.threadChatId,
      daemonToken,
      lane,
      repoFullName,
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(run.prKey ? { prKey: run.prKey } : {}),
      createdAt: new Date().toISOString(),
      message: run.message,
    };
    // The stub must know the thread before the worker's first pull.
    writeThreadSpec(stateDir, spec);
    specWritten = spec.threadId;
    const wire = await sealCanaryInput(
      run.input,
      { installationToken: minted.token, daemonToken },
      publicKeyOf(planeKey),
    );

    const hatchet = Hatchet.init({
      token: engine.token,
      host_port: engine.hostPort,
      api_url: engine.apiUrl,
    });
    const ref = await hatchet.runNoWait(run.workflowName, wire, {
      additionalMetadata: run.additionalMetadata,
    });
    const runId = await ref.getWorkflowRunId();
    specWritten = null; // handed over: the run owns the token now
    if (run.prKey) {
      // setThreadActiveRun: the review run's generation stamp.
      writeThreadSpec(stateDir, { ...spec, activeRunExternalId: runId });
    }
    console.log(
      JSON.stringify({
        threadId: spec.threadId,
        threadChatId: spec.threadChatId,
        workflowRunId: runId,
        workflow: run.workflowName,
        lane,
        repo: repoFullName,
        branch: run.input.branch,
        ...(run.input.baseBranch ? { baseBranch: run.input.baseBranch } : {}),
        ...(run.input.workBranch ? { workBranch: run.input.workBranch } : {}),
        ...(prNumber !== undefined ? { pr: prNumber } : {}),
        sealKid: planeKey.kid,
        egress: run.input.egressPolicy ? "enforce" : "observe",
      }),
    );
  } catch (err) {
    if (specWritten) removeThreadSpec(stateDir, specWritten);
    await revokeInstallationToken(minted.token);
    throw err;
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    // Messages only: no thrown value here carries a token.
    fail(
      err instanceof Error ? err.message : String(err),
      err instanceof CanaryRefusal ? 3 : 1,
    );
  },
);
