import {
  Daytona,
  Sandbox as DaytonaSandbox,
  DaytonaConflictError,
} from "@daytonaio/sdk";
import {
  BackgroundCommandOptions,
  BrokerRefresh,
  CreateSandboxOptions,
  ISandboxProvider,
  ISandboxSession,
} from "../types";
import { nanoid } from "nanoid/non-secure";
import { bashQuote, safeEnvKey } from "../utils";
import path from "path";
import { getTemplateIdForSize } from "@terragon/sandbox-image";
import { retryAsync } from "@terragon/utils/retry";
import { formatError } from "@terragon/utils/error";
import {
  DAYTONA_BROKER_GITHUB_HOSTS,
  toDaytonaBrokeredNetwork,
  toDaytonaNetwork,
  type EgressPolicyShape,
} from "../egress";

const HOME_DIR = "root";
const DEFAULT_DIR = `/${HOME_DIR}`;
const REPO_DIR = "repo";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * #114 §7a: near-expiry throttle for the broker-secret rotation on the SECONDARY
 * connect paths (keepalive `extendLife`, admin-view `getSandboxOrNull`). Mirrors
 * the E2B provider constant: GitHub installation tokens live ~60 min, so we only
 * rotate the org Secret when it was last updated MORE than ~50 min ago (or is
 * gone), leaving a comfortable margin under the TTL while a burst of keepalives
 * mints at most ~one token per hour per sandbox.
 */
const BROKER_SECRET_STALE_MS = 50 * 60 * 1000; // 50 minutes

/**
 * #114: upsert the run's write-only Daytona org Secret to `token`, addressed by
 * the deterministic thread-derived `secretName`, and return its id (needed for
 * teardown, which deletes BY ID). Used on BOTH the create path (seed) and the
 * resume path (refresh with a fresh installation token).
 *
 * `daytona.secret.create` throws {@link DaytonaConflictError} when a secret of
 * that name already exists (a stale secret from a PRIOR run of the same thread),
 * so we fall back to `list({ name })` → exact-name match → `update(id, { value })`.
 * `list` does a PARTIAL name match, so we select the exact-name entry. The
 * GitHub hosts are (re)asserted on create so substitution is scoped to them.
 * Fail closed: any create/list/update failure propagates to the caller (which
 * must NOT run the guest on an absent/stale/real-resident credential).
 */
async function upsertDaytonaBrokerSecret(
  daytona: Daytona,
  secretName: string,
  token: string,
): Promise<string> {
  try {
    const secret = await daytona.secret.create({
      name: secretName,
      value: token,
      hosts: [...DAYTONA_BROKER_GITHUB_HOSTS],
    });
    return secret.id;
  } catch (error) {
    if (!(error instanceof DaytonaConflictError)) {
      throw error;
    }
    // Name already exists — update the existing secret's value in place.
    const { items } = await daytona.secret.list({ name: secretName });
    const match = items.find((s) => s.name === secretName);
    if (!match) {
      // Conflict on create but no exact-name match on list — ambiguous; fail
      // closed rather than run on an unknown secret.
      throw error;
    }
    await daytona.secret.update(match.id, { value: token });
    return match.id;
  }
}

/**
 * #114: best-effort delete of a run's Daytona org Secret, with ONE retry. The
 * secret is org-scoped and holds the raw installation token, so a swallowed
 * delete failure would orphan a live credential. Retry once; if it still fails,
 * WARN loudly naming the secret so an operator can reclaim it. Never throws
 * (teardown sequences this so it cannot mask a stop/delete error). A missing
 * secret ({@link DaytonaNotFoundError}) is a no-op.
 */
async function deleteDaytonaBrokerSecretBestEffort(
  daytona: Daytona,
  secretId: string,
  secretName: string,
): Promise<void> {
  try {
    await daytona.secret.delete(secretId);
    return;
  } catch (firstError) {
    console.warn(
      `[daytona] failed to delete broker secret ${secretName} (${secretId}); retrying once:`,
      formatError(firstError),
    );
  }
  try {
    await daytona.secret.delete(secretId);
  } catch (secondError) {
    console.warn(
      `[daytona] STILL failed to delete broker secret ${secretName} (${secretId}) after retry — ` +
        `it may be ORPHANED in the Daytona org and should be removed manually:`,
      formatError(secondError),
    );
  }
}

/**
 * #114 §7a: throttled broker-secret rotation for the SECONDARY connect paths
 * (keepalive `extendLife`, admin-view `getSandboxOrNull`), run BEFORE the resume
 * so a brokered guest never resumes on a stale token.
 *
 * `refresh` is supplied ONLY when the caller knows the thread is brokered; its
 * presence means "keep this secret fresh". Absent = unbrokered / non-Daytona /
 * today's behavior: no-op. Daytona has NO by-name freshness read keyed on the
 * sandboxId (the secret name derives from the thread id, not the sandboxId), so
 * `refresh.secretName` carries the name the control plane derived.
 *
 * Near-expiry throttle: `list({ name })` → exact match → `updatedAt`. If it is
 * younger than {@link BROKER_SECRET_STALE_MS} we SKIP (mintToken never invoked —
 * frequent keepalives cost no GitHub token). Stale → mint + `update`. Gone →
 * mint + `create`. Fail closed: a missing `secretName`, a `list` error, or a
 * mint/update/create failure REJECTS — the caller must then NOT resume.
 */
async function refreshDaytonaBrokerSecretIfStale(
  refresh: BrokerRefresh | undefined,
): Promise<void> {
  if (!refresh) {
    return;
  }
  const secretName = refresh.secretName;
  if (!secretName) {
    // Brokered refresh with no name to rotate — cannot keep the secret fresh;
    // fail closed rather than resume on a possibly-stale credential.
    throw new Error(
      "daytona brokered refresh is missing the thread-derived secret name (#114); refusing to resume",
    );
  }
  const daytona = getDaytonaOrThrow();
  const { items } = await daytona.secret.list({ name: secretName });
  const match = items.find((s) => s.name === secretName);
  if (match) {
    const updatedAt = new Date(match.updatedAt).getTime();
    if (
      Number.isFinite(updatedAt) &&
      Date.now() - updatedAt < BROKER_SECRET_STALE_MS
    ) {
      // Still fresh — skip. `refresh.mintToken()` is NOT invoked (lazy).
      return;
    }
    const freshToken = await refresh.mintToken();
    await daytona.secret.update(match.id, { value: freshToken });
    return;
  }
  // Secret is gone (destroyed out of band) — re-create it; the persisted
  // create-time `secrets` mapping references this name, so injection resumes.
  const freshToken = await refresh.mintToken();
  await daytona.secret.create({
    name: secretName,
    value: freshToken,
    hosts: [...DAYTONA_BROKER_GITHUB_HOSTS],
  });
}

async function resumeWithRetry(sandboxId: string): Promise<DaytonaSandbox> {
  const startTime = Date.now();
  const daytona = getDaytonaOrThrow();
  return await retryAsync(
    async () => {
      console.log(`[daytona] Resuming sandbox ${sandboxId}...`);
      const sandbox = await daytona.get(sandboxId);
      console.log(`[daytona] Sandbox ${sandboxId} state: ${sandbox.state}`);
      if (sandbox.state === "stopping") {
        await sandbox.waitUntilStopped();
      }
      if (sandbox.state === "restoring" || sandbox.state === "starting") {
        await sandbox.waitUntilStarted();
      } else {
        await sandbox.start();
      }
      console.log(
        `[daytona] Resumed sandbox ${sandboxId} in ${Date.now() - startTime}ms`,
      );
      return sandbox;
    },
    {
      label: `resume sandbox ${sandboxId}`,
      maxAttempts: 3,
      delayMs: 1000,
    },
  );
}
async function createWithRetry(
  templateId: string,
  envs: Record<string, string>,
  opts?: {
    egressPolicy?: EgressPolicyShape;
    /**
     * #114: when set, mount the (already-created) org Secret of this NAME into
     * the guest via Daytona's create-time `secrets` map (GH_TOKEN/GITHUB_TOKEN →
     * the secret's opaque placeholder) AND compose the egress policy with the
     * GitHub broker hosts ({@link toDaytonaBrokeredNetwork}). The secret MUST
     * already exist (Daytona validates referenced names at create).
     */
    brokerSecretName?: string;
  },
): Promise<DaytonaSandbox> {
  const daytona = getDaytonaOrThrow();
  // Egress enforcement (#66 §3.7): translate the control-plane shape into
  // Daytona's create-time network params BEFORE any create attempt — an
  // unrepresentable policy (level "none", non-IP entries at ip_port level,
  // over-cap lists) must throw here, never produce a broken/unfenced sandbox.
  // Create-time only: live network updates are tier-gated on Daytona, which is
  // acceptable because sandboxes are created per-thread. Like E2B, Daytona
  // enforces natively (provider-side iptables) but emits no per-connection
  // audit feed — documented limitation (docs/egress-enforcement.md). On the
  // brokered path (#114) the GitHub hosts are merged into domainAllowList so an
  // enforced policy can never block the credential's traffic.
  const networkParams = opts?.brokerSecretName
    ? toDaytonaBrokeredNetwork({ egressPolicy: opts?.egressPolicy })
    : opts?.egressPolicy
      ? toDaytonaNetwork(opts.egressPolicy)
      : {};
  // #114: the `secrets` map references the EXISTING org Secret by name; Daytona
  // sets GH_TOKEN/GITHUB_TOKEN to its opaque placeholder (never the real token).
  const secretsParams = opts?.brokerSecretName
    ? {
        secrets: {
          GH_TOKEN: opts.brokerSecretName,
          GITHUB_TOKEN: opts.brokerSecretName,
        },
      }
    : {};
  return await retryAsync(
    async () => {
      console.log(
        `[daytona] Creating sandbox with templateId: ${templateId}...`,
      );
      const startTime = Date.now();
      const sandbox = await daytona.create({
        user: "root",
        snapshot: templateId,
        envVars: envs,
        autoStopInterval: 15, // 15 minutes
        autoArchiveInterval: 5, // 5 minutes
        autoDeleteInterval: 60 * 24 * 30, // 30 days
        ...networkParams,
        ...secretsParams,
      });
      console.log(
        `[daytona] Created sandbox in ${Date.now() - startTime}ms`,
        sandbox.id,
      );
      return sandbox;
    },
    {
      label: `create sandbox with templateId ${templateId}`,
      maxAttempts: 3,
      delayMs: 1000,
    },
  );
}

function getDaytonaOrThrow(): Daytona {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new Error("DAYTONA_API_KEY is not set");
  }
  const daytona = new Daytona({ apiKey });
  return daytona;
}

class DaytonaSession implements ISandboxSession {
  public readonly sandboxProvider: "daytona" = "daytona";
  /**
   * #114: the run's Daytona org-Secret id + name when the sandbox is brokered
   * (set on the create and resume paths). `shutdown()` deletes it (by id) so no
   * secret is orphaned. Undefined for unbrokered sandboxes.
   */
  private brokerSecretId?: string;
  private brokerSecretName?: string;

  constructor(private sandbox: DaytonaSandbox) {}

  /** #114: mark this session as brokered so `shutdown()` deletes the org
   * secret. Called by the provider after seeding/refreshing the secret. */
  markBrokered(secretId: string, secretName: string): void {
    this.brokerSecretId = secretId;
    this.brokerSecretName = secretName;
  }

  get homeDir(): string {
    return HOME_DIR;
  }

  get repoDir(): string {
    return REPO_DIR;
  }

  get sandboxId(): string {
    return this.sandbox.id;
  }

  async hibernate(): Promise<void> {
    await hibernateSandbox(this.sandbox);
  }

  async runCommandWithSession(
    command: string,
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      timeoutMs?: number;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
      blockUntilComplete?: boolean;
    },
  ): Promise<{
    sessionId: string;
    cmdId: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  }> {
    const sessionId = nanoid();
    try {
      const workDir = options?.cwd || REPO_DIR;
      const workDirPath = workDir.startsWith("/")
        ? workDir
        : path.join(DEFAULT_DIR, workDir);
      await this.sandbox.process.createSession(sessionId);
      await this.sandbox.process.executeSessionCommand(sessionId, {
        command: `cd ${workDirPath}`,
        runAsync: false,
      });
      if (options?.env) {
        for (const [key, value] of Object.entries(options.env)) {
          await this.sandbox.process.executeSessionCommand(sessionId, {
            command: `export ${safeEnvKey(key)}=${bashQuote(value)}`,
            runAsync: false,
          });
        }
      }
      const commandExecutionResult =
        await this.sandbox.process.executeSessionCommand(sessionId, {
          command,
          runAsync: true,
        });
      const commandId = commandExecutionResult.cmdId!;
      let stdoutLines: string[] = [];
      let stderrLines: string[] = [];
      const commandLogsPromise = this.sandbox.process.getSessionCommandLogs(
        sessionId,
        commandId,
        (chunk) => {
          options?.onStdout?.(chunk);
          stdoutLines.push(chunk);
        },
        (chunk) => {
          options?.onStderr?.(chunk);
          stderrLines.push(chunk);
        },
      );
      if (!options?.blockUntilComplete) {
        return { sessionId, cmdId: commandId };
      }
      const result = await Promise.race([
        commandLogsPromise,
        new Promise<"timeout">((resolve) =>
          setTimeout(() => {
            resolve("timeout");
          }, options?.timeoutMs || DEFAULT_TIMEOUT_MS),
        ),
      ]);
      if (result === "timeout") {
        throw new Error(`Command timed out after ${options?.timeoutMs || 0}ms`);
      }
      const commandResult = await this.sandbox.process.getSessionCommand(
        sessionId,
        commandId,
      );
      return {
        sessionId,
        cmdId: commandId,
        exitCode: commandResult.exitCode!,
        stdout: stdoutLines.join("\n"),
        stderr: stderrLines.join("\n"),
      };
    } catch (error) {
      console.error("Error running command with session:", formatError(error));
      try {
        await this.sandbox.process.deleteSession(sessionId);
      } catch (error) {
        console.error("Error deleting session:", formatError(error));
      }
      if (
        error instanceof Error &&
        error.message.includes("Operation timed out")
      ) {
        throw new Error(`Command timed out after ${options?.timeoutMs || 0}ms`);
      }
      throw error;
    }
  }

  async runCommand(
    command: string,
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      timeoutMs?: number;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
    },
  ): Promise<string> {
    console.log("Running command:", command);
    const startTime = Date.now();
    if (
      typeof options?.onStdout === "function" ||
      typeof options?.onStderr === "function"
    ) {
      const commandResult = await this.runCommandWithSession(command, {
        env: options?.env,
        cwd: options?.cwd,
        timeoutMs: options?.timeoutMs,
        blockUntilComplete: true,
        onStdout: options?.onStdout,
        onStderr: options?.onStderr,
      });
      if (commandResult.exitCode !== 0) {
        throw new Error(
          `Command failed with exit code ${commandResult.exitCode}\n\nstdout:\n ${commandResult.stdout || "(empty)"}\nstderr:\n ${commandResult.stderr || "(empty)"}`,
        );
      }
      return commandResult.stdout || "";
    }

    try {
      const workDir = options?.cwd || REPO_DIR;
      const workDirPath = workDir.startsWith("/")
        ? workDir
        : path.join(DEFAULT_DIR, workDir);
      const timeoutSecs = Math.ceil(
        (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000,
      );
      const commandResult = await this.sandbox.process.executeCommand(
        command,
        workDirPath,
        options?.env,
        timeoutSecs,
      );
      console.log(`Command executed (took ${Date.now() - startTime}ms)`, {
        exitCode: commandResult.exitCode,
        result: commandResult.result,
        workDirPath,
      });
      if (commandResult.exitCode !== 0) {
        throw new Error(
          `Command failed with exit code ${commandResult.exitCode}\n\noutput:\n ${commandResult.result || "(empty)"}`,
        );
      }
      return commandResult.result || "";
    } catch (error) {
      console.error("Error running command:", formatError(error));
      if (
        error instanceof Error &&
        error.message.includes("command execution timeout")
      ) {
        throw new Error(`Command timed out after ${options?.timeoutMs || 0}ms`);
      }
      throw error;
    }
  }

  async runBackgroundCommand(
    command: string,
    options?: BackgroundCommandOptions,
  ): Promise<void> {
    console.log("Running command:", command);
    await this.runCommandWithSession(command, {
      env: options?.env,
      timeoutMs: options?.timeoutMs,
      onStdout: options?.onOutput,
      onStderr: options?.onOutput,
      blockUntilComplete: false,
    });
  }

  async shutdown(): Promise<void> {
    // #114: the org-secret delete MUST run regardless of whether stop/delete
    // succeeds — otherwise a throw here would orphan the run's secret (holding
    // the raw installation token). Sequence the delete in a `finally` so a
    // rejected stop/delete still tears the secret down; the original error is
    // not swallowed (it rethrows after the finally). Delete is best-effort /
    // idempotent (no-op if absent) and never masks the stop/delete error.
    try {
      await this.sandbox.stop();
      await this.sandbox.delete();
    } finally {
      if (this.brokerSecretId && this.brokerSecretName) {
        await deleteDaytonaBrokerSecretBestEffort(
          getDaytonaOrThrow(),
          this.brokerSecretId,
          this.brokerSecretName,
        );
      }
    }
  }

  async readTextFile(path: string): Promise<string> {
    const file = await this.sandbox.fs.downloadFile(path);
    return file.toString();
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    const fileContent = Buffer.from(content);
    await this.sandbox.fs.uploadFile(fileContent, path);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const fileContent = Buffer.from(content);
    await this.sandbox.fs.uploadFile(fileContent, path);
  }
}

export class DaytonaProvider implements ISandboxProvider {
  constructor() {}

  /**
   * #114 §7a: keepalive. `refresh` (a brokered Daytona thread only) rotates the
   * org secret BEFORE the resume so a brokered guest never resumes on a stale
   * token; near-expiry THROTTLED so frequent keepalives don't mint a token every
   * call. Fail closed: a rotation failure throws WITHOUT resuming. Absent
   * `refresh` (unbrokered / non-Daytona) = today's behavior byte-for-byte.
   */
  async extendLife(sandboxId: string, refresh?: BrokerRefresh): Promise<void> {
    // Rotate BEFORE resuming (fail closed: a throw here means we never resume).
    await refreshDaytonaBrokerSecretIfStale(refresh);
    // The refresh is already done above, so resume with NO refresh (no double
    // rotation). getSandboxOrNull(no-refresh) is byte-identical to today.
    const sandbox = await this.getSandboxOrNull(sandboxId);
    if (!sandbox) {
      throw new Error("Sandbox not found");
    }
    await sandbox.runCommand("echo 'hello'");
  }

  /**
   * #114 §7a: admin daemon-log view. Like {@link extendLife}, resuming a paused
   * brokered guest must rotate its org secret BEFORE the resume via the lazy,
   * near-expiry-throttled `refresh`. Fail closed: a rotation failure means we
   * never resume and return null (no usable session). Absent `refresh` =
   * today's behavior.
   */
  async getSandboxOrNull(
    sandboxId: string,
    refresh?: BrokerRefresh,
  ): Promise<ISandboxSession | null> {
    try {
      // Rotate BEFORE resume — a rotation throw skips resumeWithRetry entirely,
      // so a brokered guest is never resumed on a stale token.
      await refreshDaytonaBrokerSecretIfStale(refresh);
      const sandbox = await resumeWithRetry(sandboxId);
      return new DaytonaSession(sandbox);
    } catch (error) {
      console.warn(`Failed to resume sandbox ${sandboxId}:`, error);
      return null;
    }
  }

  async getOrCreateSandbox(
    sandboxId: string | null,
    options: CreateSandboxOptions,
  ): Promise<ISandboxSession> {
    if (sandboxId) {
      return await this.resumeSandbox(sandboxId, options);
    }
    // Convert environment variables array to object
    const envs: Record<string, string> = {};
    if (options.environmentVariables) {
      for (const { key, value } of options.environmentVariables) {
        envs[key] = value;
      }
    }
    const templateId = getTemplateIdForSize({
      provider: "daytona",
      size: options.sandboxSize,
    });

    // #114: Daytona native credential broker. Like E2B, Daytona injects the
    // credential in its OWN egress plane — but INVERTED: the `secrets` map
    // references an org Secret that must ALREADY EXIST, so we create the secret
    // FIRST, then create the sandbox referencing it by name. The guest env
    // (env.ts) sets no resident token; setup.ts writes only a verbatim-token
    // extraheader carrying the non-secret placeholder. Fail closed: any failure
    // deletes the secret and (if created) tears the sandbox down before
    // rethrowing — never fall back to a resident raw token.
    const broker =
      options.credentialBroker?.kind === "daytona-native"
        ? options.credentialBroker
        : undefined;
    if (broker) {
      const daytona = getDaytonaOrThrow();
      const secretName = broker.secretName;
      // 1. Upsert the org secret BEFORE create (referenced names must exist).
      const secretId = await upsertDaytonaBrokerSecret(
        daytona,
        secretName,
        broker.installationToken,
      );
      // 2. Create the sandbox referencing the secret by name + brokered network.
      //    Strip GH_TOKEN/GITHUB_TOKEN from envVars so the `secrets`-map
      //    placeholder is authoritative (a user-supplied value must never shadow
      //    it at the sandbox level).
      const brokeredEnvs = { ...envs };
      delete brokeredEnvs.GH_TOKEN;
      delete brokeredEnvs.GITHUB_TOKEN;
      let session: DaytonaSession;
      try {
        const sandbox = await createWithRetry(templateId, brokeredEnvs, {
          egressPolicy: options.egressPolicy,
          brokerSecretName: secretName,
        });
        session = new DaytonaSession(sandbox);
        session.markBrokered(secretId, secretName);
      } catch (error) {
        // Create failed: delete the secret we created, then rethrow (fail
        // closed — never fall back to a resident raw token).
        console.error(
          "[daytona] failed to create brokered sandbox; deleting secret",
          formatError(error),
        );
        await deleteDaytonaBrokerSecretBestEffort(
          daytona,
          secretId,
          secretName,
        );
        throw error;
      }
      try {
        await setupDaytonaOneTime(session);
      } catch (error) {
        // Post-create setup failed: tear the guest down (shutdown deletes the
        // secret too) then rethrow.
        console.error(
          "[daytona] brokered sandbox one-time setup failed; tearing down",
          formatError(error),
        );
        await session.shutdown().catch(() => {});
        throw error;
      }
      return session;
    }

    const sandbox = await createWithRetry(templateId, envs, {
      egressPolicy: options.egressPolicy,
    });
    const session = new DaytonaSession(sandbox);
    await setupDaytonaOneTime(session);
    return session;
  }

  /**
   * #114: resume path. Like E2B, a Daytona brokered sandbox CAN resume in place
   * (the org secret and the create-time `secrets` mapping persist across
   * stop/start). But the seeded installation token may have expired (~1h TTL),
   * so on a brokered resume we REFRESH the secret value with the fresh token the
   * control plane supplies BEFORE resuming. Fail closed: if the refresh fails we
   * throw rather than resume on a stale/absent credential (and never fall back
   * to a resident raw token). Non-brokered = today's behavior.
   */
  private async resumeSandbox(
    sandboxId: string,
    options: CreateSandboxOptions,
  ): Promise<ISandboxSession> {
    const broker =
      options.credentialBroker?.kind === "daytona-native"
        ? options.credentialBroker
        : undefined;
    const isBrokered = !!broker || options.credentialBrokerMode === "brokered";
    if (!isBrokered) {
      const sandbox = await this.getSandboxOrNull(sandboxId);
      if (!sandbox) {
        throw new Error("Sandbox not found");
      }
      return sandbox;
    }
    if (!broker) {
      // Brokered provenance but no shape to refresh from: we cannot re-seed the
      // secret with a fresh token. Fail closed BEFORE resuming.
      throw new Error(
        `Daytona brokered sandbox ${sandboxId} resume is missing the broker shape needed to refresh the org secret (#114); refusing to resume.`,
      );
    }
    const daytona = getDaytonaOrThrow();
    // Refresh the secret value with the fresh token BEFORE resuming. Fail
    // closed: a failure throws WITHOUT resuming, so the guest stays stopped and
    // never resumes on a stale/absent credential.
    let secretId: string;
    try {
      secretId = await upsertDaytonaBrokerSecret(
        daytona,
        broker.secretName,
        broker.installationToken,
      );
    } catch (error) {
      console.error(
        `[daytona] brokered resume secret refresh failed for ${sandboxId}; refusing to resume`,
        formatError(error),
      );
      throw error;
    }
    const sandbox = await resumeWithRetry(sandboxId);
    const session = new DaytonaSession(sandbox);
    session.markBrokered(secretId, broker.secretName);
    return session;
  }

  async hibernateById(sandboxId: string): Promise<void> {
    try {
      const daytona = getDaytonaOrThrow();
      const sandbox = await daytona.get(sandboxId);
      await hibernateSandbox(sandbox);
    } catch (error) {
      console.error(
        `Failed to hibernate sandbox ${sandboxId}:`,
        formatError(error),
      );
    }
  }

  /**
   * #114: force-destroy a sandbox by id, ALSO deleting its org secret so no
   * secret (holding a live installation token) is orphaned when teardown does
   * not go through a broker-aware {@link DaytonaSession} — e.g. the create-
   * timeout / persist-failure sweeps and the brokered-resume recreate, which
   * tear down a FRESH or STALE sandbox by id alone.
   *
   * `daytona.get()` fetches the sandbox WITHOUT starting it, and
   * `sandbox.delete()` works on a STOPPED guest (verified in
   * @daytonaio/sdk@0.205.1), so this NEVER revives a paused brokered guest —
   * mirroring the E2B `shutdownById` non-revival guarantee.
   *
   * The Daytona broker secret name derives from the STABLE thread id (not the
   * sandboxId), so it cannot be re-derived here; the caller passes it in
   * `brokerSecretName`. We resolve its id via `list({ name })` (list is a
   * PARTIAL match, so we select the exact name) and delete best-effort in a
   * `finally` so a `delete()` throw cannot orphan the secret. Absent
   * `brokerSecretName` (E2B/Docker/non-brokered) = guest teardown only.
   */
  async shutdownById(
    sandboxId: string,
    brokerSecretName?: string,
  ): Promise<void> {
    const daytona = getDaytonaOrThrow();
    try {
      // get() does NOT start a stopped guest; delete() works on a stopped one —
      // so the brokered guest is never revived on its way to the grave.
      const sandbox = await daytona.get(sandboxId);
      await sandbox.delete();
    } catch (error) {
      console.warn(
        `[daytona] failed to delete sandbox ${sandboxId}:`,
        formatError(error),
      );
    } finally {
      if (brokerSecretName) {
        // Resolve the secret id from its (thread-derived) name, then delete
        // best-effort (retry-then-WARN). No-op if the secret is already gone.
        try {
          const { items } = await daytona.secret.list({
            name: brokerSecretName,
          });
          const match = items.find((s) => s.name === brokerSecretName);
          if (match) {
            await deleteDaytonaBrokerSecretBestEffort(
              daytona,
              match.id,
              brokerSecretName,
            );
          }
        } catch (listError) {
          console.warn(
            `[daytona] failed to look up broker secret ${brokerSecretName} for by-id teardown — ` +
              `it may be ORPHANED and should be removed manually:`,
            formatError(listError),
          );
        }
      }
    }
  }
}

async function setupDaytonaOneTime(session: ISandboxSession): Promise<void> {
  const etcProfileDPromptShContents = [
    // Ensure PS1 is set so .bashrc won't early-return in login shells
    "[ -n \"${PS1-}\" ] || PS1='\\w $ '",
    "export PS1",
  ].join("\n");
  await session.runCommand(
    `if [ ! -f /etc/profile.d/prompt.sh ]; then echo ${bashQuote(etcProfileDPromptShContents)} >> /etc/profile.d/prompt.sh; chmod 644 /etc/profile.d/prompt.sh; fi`,
    { cwd: "/" },
  );
}

async function hibernateSandbox(sandbox: DaytonaSandbox): Promise<void> {
  await sandbox.stop();
  // Rely on the auto-archive feature to archive the sandbox automatically
  // await sandbox.archive();
}
