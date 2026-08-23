import {
  BackgroundCommandOptions,
  BrokerRefresh,
  CreateSandboxOptions,
  ISandboxProvider,
  ISandboxSession,
} from "../types";
import { getTemplateIdForSize } from "@terragon/sandbox-image";
import { Sandbox, Secret, SecretNotFoundError } from "@e2b/code-interpreter";
import { retryAsync } from "@terragon/utils/retry";
import {
  E2B_BROKER_GITHUB_HOSTS,
  toE2bBrokeredNetwork,
  toE2bNetwork,
} from "../egress";

const HOME_DIR = "root";
const REPO_DIR = "repo";
const SLEEP_MS = 60 * 15 * 1000; // 15 minutes

/**
 * #114 §7a: near-expiry throttle for the broker-secret rotation on the SECONDARY
 * connect paths (keepalive `extendLife`, admin-view `getSandboxOrNull`).
 *
 * GitHub installation tokens live ~60 min. We rotate the vault secret only when
 * it was last updated MORE than this long ago (or is missing), so a burst of
 * keepalives on a still-fresh secret mints at most ~one token per hour per
 * sandbox instead of one per call. 50 min leaves a comfortable margin under the
 * ~60 min TTL so the vaulted token is never allowed to actually expire between
 * rotations.
 */
const BROKER_SECRET_STALE_MS = 50 * 60 * 1000; // 50 minutes

/** Network options passed to {@link createWithRetry} / `Sandbox.create`. */
type E2bCreateNetwork = { allowOut: string[]; denyOut?: string[] };

/**
 * Deterministic per-run E2B Secret-vault name for the native credential broker
 * (#114). Derived from the E2B sandboxId — the ONLY handle that both survives
 * pause/resume AND is available at teardown-by-id — so create, resume-refresh,
 * and teardown all address the same vault entry with NO extra persistence
 * (resume relies only on the NON-secret `credentialBrokerMode` provenance, per
 * the design). Sanitized to the `[a-z0-9-]` charset a secret name accepts.
 */
export function e2bBrokerSecretName(sandboxId: string): string {
  return `gh-inst-${sandboxId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

/**
 * Build the CREATE-time base network for a brokered E2B sandbox (#114): the
 * egress firewall WITHOUT the header-injection rules AND, crucially, WITHOUT the
 * GitHub hosts reachable. The rules reference the vault secret whose name
 * derives from the not-yet-known sandboxId, so they are attached via
 * `updateNetwork` right after create. If GitHub were in `allowOut` at create
 * time there would be a window (a template startup process, or another holder of
 * the sandbox id) where the guest could reach GitHub with NO injection rule —
 * i.e. anonymously / un-brokered. So we create with GitHub DENIED and let
 * `updateNetwork` open the GitHub `allowOut` and attach the transform rules
 * ATOMICALLY together (`SandboxNetworkUpdate` replaces allowOut/denyOut/rules in
 * one call), so GitHub egress is never open without its injection rule.
 *
 * Composition with a per-repo egress policy is preserved (not clobbered): the
 * rest of the repo allowlist is kept at create; only the GitHub hosts are held
 * back until the rules attach. `updateNetwork` (via {@link toE2bBrokeredNetwork})
 * restores the full composed allowlist plus GitHub plus the rules.
 */
function e2bBrokeredCreateBaseNetwork(
  egressPolicy: CreateSandboxOptions["egressPolicy"],
): E2bCreateNetwork {
  const githubHosts: readonly string[] = E2B_BROKER_GITHUB_HOSTS;
  if (egressPolicy) {
    const base = toE2bNetwork(egressPolicy);
    // Keep the repo allowlist, but hold back the GitHub hosts until the rules
    // attach. With deny-all as the default (base.denyOut), a host absent from
    // allowOut is denied — so GitHub is unreachable in the create window.
    const allowOut = base.allowOut.filter(
      (host) => !githubHosts.includes(host),
    );
    return { denyOut: base.denyOut, allowOut };
  }
  // No egress policy: create FULLY CLOSED (deny-all). Open internet cannot
  // selectively deny GitHub (E2B deny rules are IP/CIDR only, not domains), so
  // to guarantee GitHub is never open without its rule we deny everything in the
  // create window; `updateNetwork` reopens 0.0.0.0/0 + the GitHub hosts together
  // with the injection rules immediately after.
  return { allowOut: [], denyOut: ["0.0.0.0/0"] };
}

/**
 * #114: best-effort destroy of a run's E2B vault secret, with ONE retry. The
 * secret is project-scoped and holds the raw installation token, so a swallowed
 * destroy failure would orphan a live credential in the vault. On the first
 * failure we retry once; if it still fails we log a clear WARN naming the secret
 * so an operator can reclaim it manually. Never throws (teardown callers sequence
 * this so it cannot mask a `kill()` error), and destroy of a missing secret is a
 * no-op — safe for unbrokered sandboxes too.
 */
async function destroyBrokerSecretBestEffort(
  secretName: string,
): Promise<void> {
  try {
    await Secret.destroy(secretName);
    return;
  } catch (firstError) {
    console.warn(
      `[e2b] failed to destroy broker secret ${secretName}; retrying once:`,
      firstError,
    );
  }
  try {
    await Secret.destroy(secretName);
  } catch (secondError) {
    console.warn(
      `[e2b] STILL failed to destroy broker secret ${secretName} after retry — ` +
        `it may be ORPHANED in the E2B project vault and should be removed manually:`,
      secondError,
    );
  }
}

/**
 * #114 §7a: throttled broker-secret rotation for the SECONDARY connect paths,
 * run BEFORE `Sandbox.connect` (which auto-resumes the guest) so a brokered
 * guest never resumes on a stale token.
 *
 * `refresh` is supplied ONLY when the caller knows the thread is brokered
 * (`credentialBrokerMode === "brokered"`), so its presence means "this sandbox
 * is brokered — keep its vault secret fresh". Absent = unbrokered / non-E2B /
 * today's behavior: no-op (nothing minted, nothing rotated).
 *
 * Near-expiry throttle: read the vaulted secret's `updatedAt` via
 * `Secret.getInfo` (metadata only — the value stays write-only). If it is
 * younger than {@link BROKER_SECRET_STALE_MS} we SKIP — `refresh.mintToken()` is
 * never invoked, so frequent keepalives cost no GitHub token. Only when the
 * secret is stale (or missing) do we mint a fresh token and
 * `Secret.update`/`create` it.
 *
 * Fail closed: if `getInfo` fails for any reason OTHER than "not found", or if
 * the mint / update / create throws, this REJECTS — the caller must then NOT
 * connect (so the guest stays paused rather than resuming on a possibly
 * revoked/rotated credential), consistent with the primary `resumeSandbox` path.
 * A genuinely-missing secret is not a failure: we (re)create it, mirroring the
 * primary path's `Secret.create`-if-gone.
 */
async function refreshBrokerSecretIfStale(
  sandboxId: string,
  refresh: BrokerRefresh | undefined,
): Promise<void> {
  if (!refresh) {
    return;
  }
  const secretName = e2bBrokerSecretName(sandboxId);
  let updatedAt: Date | null = null;
  let secretExists = true;
  try {
    const info = await Secret.getInfo(secretName);
    updatedAt = info.updatedAt;
  } catch (error) {
    if (error instanceof SecretNotFoundError) {
      // Brokered provenance but the vault entry is gone (e.g. destroyed out of
      // band). Not a failure — re-mint and re-create below; the persisted egress
      // rules already reference this name, so injection resumes.
      secretExists = false;
    } else {
      // Ambiguous vault error — fail closed (do NOT connect on an unknown
      // freshness state).
      throw error;
    }
  }
  if (
    secretExists &&
    updatedAt &&
    Date.now() - updatedAt.getTime() < BROKER_SECRET_STALE_MS
  ) {
    // Still fresh — skip. `refresh.mintToken()` is NOT invoked (lazy): a
    // frequent keepalive on a fresh secret mints no GitHub token.
    return;
  }
  // Stale or missing — mint a fresh installation token and rotate the vault
  // secret BEFORE the caller connects. A mint/rotate failure propagates (fail
  // closed): the caller will not connect, so the guest stays paused.
  const freshToken = await refresh.mintToken();
  if (secretExists) {
    await Secret.update(secretName, freshToken);
  } else {
    await Secret.create(secretName, freshToken);
  }
}

async function resumeWithRetry(
  sandboxId: string,
  opts?: {
    /**
     * #114: skip the post-connect liveness probe. On a BROKERED resume the vault
     * secret is refreshed with the fresh token BEFORE this connect runs (so the
     * guest never resumes on a stale credential); the caller still connects with
     * the probe skipped so IT owns the first control-plane command — letting it
     * mark the session brokered and tear it down if the probe fails.
     * `Sandbox.connect` auto-resumes the guest and runs E2B's OWN internal resume
     * probe — unavoidable and credential-free — but no control-plane command
     * touches the guest here.
     */
    skipReadyCheck?: boolean;
  },
): Promise<E2BSession> {
  const startTime = Date.now();
  return await retryAsync(
    async () => {
      console.log(`[e2b] Resuming sandbox ${sandboxId}...`);
      // e2b v2: `connect` auto-resumes a paused sandbox (`Sandbox.resume` is
      // gone). Pause-on-timeout is a persistent sandbox `lifecycle` property
      // set at create time, so nothing to re-assert here.
      const sandbox = await Sandbox.connect(sandboxId, {
        timeoutMs: SLEEP_MS,
      });
      console.log(
        `[e2b] Resumed sandbox ${sandboxId} in ${Date.now() - startTime}ms`,
      );
      const session = new E2BSession(sandbox);
      if (!opts?.skipReadyCheck) {
        // Attempt to run a command to check if the sandbox is running
        await session.runCommand("echo 'hello'", { cwd: "/" });
        console.log(`[e2b] Sandbox ${sandboxId} is running`);
      }
      return session;
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
  network?: E2bCreateNetwork,
): Promise<Sandbox> {
  return await retryAsync(
    async () => {
      console.log(`[e2b] Creating sandbox with templateId: ${templateId}...`);
      const startTime = Date.now();
      const sandbox = await Sandbox.create(templateId, {
        // e2b v2: `lifecycle.onTimeout: "pause"` is the stable replacement for
        // the old patched `autoPause: true` (patches/e2b.patch is gone).
        lifecycle: { onTimeout: "pause" },
        timeoutMs: SLEEP_MS,
        // Egress enforcement (#66 §3.6): when the control plane shipped a
        // policy SHAPE, translate it to E2B's native firewall — deny-all plus
        // the resolved allowlist. Enforced below the process (env-unset cannot
        // bypass it), but E2B emits no per-connection audit feed: enforcement
        // without per-connection audit rows is a documented limitation
        // (docs/egress-enforcement.md). Absent policy = no network opts at all.
        // On the brokered path (#114) this base carries the firewall only; the
        // header-injection rules are attached post-create via updateNetwork.
        ...(network ? { network } : {}),
        envs: {
          ...envs,
          // Uncomment this to debug git issues.
          // GIT_TRACE: "1",
        },
      });
      console.log(
        `[e2b] Created sandbox in ${Date.now() - startTime}ms`,
        sandbox.sandboxId,
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

class E2BSession implements ISandboxSession {
  public readonly sandboxProvider: "e2b" = "e2b";
  /**
   * #114: name of this run's E2B Secret-vault entry when the sandbox is
   * brokered (set on the create and resume paths). `shutdown()` destroys it so
   * no vault secret is orphaned. Undefined for unbrokered sandboxes.
   */
  private brokerSecretName?: string;
  constructor(private sandbox: Sandbox) {}

  /** #114: mark this session as brokered so `shutdown()` destroys the vault
   * secret. Called by the provider after seeding/refreshing the vault. */
  markBrokered(secretName: string): void {
    this.brokerSecretName = secretName;
  }

  get homeDir(): string {
    return HOME_DIR;
  }

  get repoDir(): string {
    return REPO_DIR;
  }

  get sandboxId(): string {
    return this.sandbox.sandboxId;
  }

  async hibernate(): Promise<void> {
    await this.sandbox.pause();
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
    const startTime = Date.now();
    console.log("Running command:", command);
    try {
      const result = await this.sandbox.commands.run(command, {
        ...options,
        user: "root",
        envs: options?.env,
        cwd: options?.cwd || REPO_DIR,
        onStdout: options?.onStdout,
        onStderr: options?.onStderr,
        timeoutMs: options?.timeoutMs || 0,
      });
      console.log(
        `Command result: ${result.stdout} (took ${Date.now() - startTime}ms)`,
      );
      return result.stdout;
    } catch (error) {
      console.error("Error running command:", JSON.stringify(error));
      // Handle timeout errors
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(`Command timed out after ${options?.timeoutMs || 0}ms`);
      }
      // Check if it's a command execution error with result details
      if (error && typeof error === "object" && "result" in error) {
        const commandError = error as {
          result?: {
            error?: boolean;
            stderr?: string;
            exitCode?: number;
            stdout?: string;
          };
        };
        if (commandError.result?.error) {
          throw new Error(
            `Command failed${commandError.result.exitCode ? ` with exit code ${commandError.result.exitCode}` : ""}\n\nstdout:\n ${commandError.result.stdout || "(empty)"}\nstderr:\n ${commandError.result.stderr || "(empty)"}`,
          );
        }
      }
      throw error;
    }
  }

  async runBackgroundCommand(
    command: string,
    options?: BackgroundCommandOptions,
  ): Promise<void> {
    await this.sandbox.commands.run(command, {
      background: true,
      timeoutMs: options?.timeoutMs || 0,
      onStdout: (data) => {
        options?.onOutput?.(data);
      },
      onStderr: (data) => {
        options?.onOutput?.(data);
      },
      user: "root",
      envs: options?.env,
      cwd: REPO_DIR,
    });
  }

  async shutdown(): Promise<void> {
    // #114: the vault-secret destroy MUST run regardless of whether kill()
    // succeeds — otherwise a kill() throw would orphan the run's secret in the
    // vault. Sequence the destroy in a `finally` so a rejected kill() still
    // tears down the secret; the kill error is not swallowed (it rethrows after
    // the finally). Destroy is best-effort/idempotent (no-op if absent) and
    // never masks the kill error.
    try {
      await this.sandbox.kill();
    } finally {
      if (this.brokerSecretName) {
        // Retry-then-WARN: a swallowed destroy failure would orphan the raw
        // installation token in the project vault.
        await destroyBrokerSecretBestEffort(this.brokerSecretName);
      }
    }
  }

  async readTextFile(path: string): Promise<string> {
    return await this.sandbox.files.read(path);
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    await this.sandbox.files.write(path, content);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    await this.sandbox.files.write(path, content.buffer as ArrayBuffer);
  }
}

export class E2BProvider implements ISandboxProvider {
  constructor() {}

  /**
   * #114 §7a (CLOSED): `Sandbox.connect` auto-resumes a paused guest, so this
   * keepalive path now ROTATES the brokered vault secret BEFORE connect, exactly
   * like the primary `resumeSandbox` path — a brokered guest never resumes on a
   * stale token. `refresh` is the lazy handle the control plane threads in when
   * the thread is brokered; rotation is near-expiry THROTTLED
   * ({@link refreshBrokerSecretIfStale}) so frequent keepalives don't mint a
   * GitHub token on every call. Absent `refresh` (unbrokered / non-E2B) = today's
   * behavior. Fail closed: a rotation failure throws WITHOUT connecting (the
   * guest stays paused).
   */
  async extendLife(sandboxId: string, refresh?: BrokerRefresh): Promise<void> {
    await refreshBrokerSecretIfStale(sandboxId, refresh);
    const sandbox = await Sandbox.connect(sandboxId);
    await sandbox.setTimeout(SLEEP_MS);
  }

  /**
   * #114 §7a (CLOSED): used by the admin daemon-log view
   * (apps/www/src/server-actions/admin/sandbox.ts). Like {@link extendLife},
   * `Sandbox.connect` auto-resumes the guest, so this now ROTATES the brokered
   * vault secret BEFORE connect via the lazy, near-expiry-throttled `refresh`
   * handle — no stale-token resume. Absent `refresh` = today's behavior. Fail
   * closed: a rotation failure means we never connect and return null (no usable
   * session), so the guest is not resumed on a stale credential.
   */
  async getSandboxOrNull(
    sandboxId: string,
    refresh?: BrokerRefresh,
  ): Promise<ISandboxSession | null> {
    try {
      // Rotate BEFORE connect — a rotation throw skips resumeWithRetry entirely,
      // so a brokered guest is never auto-resumed on a stale token.
      await refreshBrokerSecretIfStale(sandboxId, refresh);
      return await resumeWithRetry(sandboxId);
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
      provider: "e2b",
      size: options.sandboxSize,
    });

    // #114: E2B native credential broker. Unlike Docker (out-of-guest sidecar),
    // E2B injects the credential in its OWN egress plane: the installation token
    // lives in E2B's write-only Secret vault and a per-host `transform.headers`
    // rule injects `Authorization: token ${e2b.secrets.<name>}` for github.com /
    // api.github.com, resolved per request OUTSIDE the guest. The token is never
    // in the guest env, argv, or disk (env.ts sets only a placeholder; setup.ts
    // writes no ~/.git-credentials). The vault-secret name derives from the
    // sandboxId, which does not exist until create — so we create the sandbox
    // with the firewall base, then seed the vault and attach the rules via
    // updateNetwork. Fail closed: any failure destroys the secret and kills the
    // fresh guest before rethrowing (never fall back to a resident raw token).
    const broker =
      options.credentialBroker?.kind === "e2b-native"
        ? options.credentialBroker
        : undefined;
    if (broker) {
      const baseNetwork = e2bBrokeredCreateBaseNetwork(options.egressPolicy);
      const sandbox = await createWithRetry(templateId, envs, baseNetwork);
      const secretName = e2bBrokerSecretName(sandbox.sandboxId);
      try {
        await Secret.create(secretName, broker.installationToken);
        const authHeaderValue = `token ${Secret.fill(secretName)}`;
        const fullNetwork = toE2bBrokeredNetwork({
          egressPolicy: options.egressPolicy,
          authHeaderValue,
        });
        await sandbox.updateNetwork(fullNetwork);
      } catch (error) {
        console.error(
          "[e2b] failed to set up native credential broker; tearing down",
          error,
        );
        await destroyBrokerSecretBestEffort(secretName);
        await sandbox.kill().catch(() => {});
        throw error;
      }
      const e2bSession = new E2BSession(sandbox);
      e2bSession.markBrokered(secretName);
      return e2bSession;
    }

    const network = options.egressPolicy
      ? toE2bNetwork(options.egressPolicy)
      : undefined;
    const sandbox = await createWithRetry(templateId, envs, network);
    const e2bSession = new E2BSession(sandbox);
    return e2bSession;
  }

  /**
   * Resume path. Unlike Docker, an E2B brokered sandbox CAN resume in place —
   * the egress rules and the vault-secret entry both persist across pause. But
   * the installation token seeded into the vault may have expired (~1h TTL), so
   * on a brokered resume we REFRESH the vault secret with the fresh token the
   * control plane supplies (Secret.update; create if it is somehow gone). The
   * rules need no change (they reference the secret by name), so no
   * updateNetwork. Fail closed: if the refresh fails we throw rather than resume
   * on a stale/absent credential (and never fall back to a resident raw token).
   */
  private async resumeSandbox(
    sandboxId: string,
    options: CreateSandboxOptions,
  ): Promise<ISandboxSession> {
    const isBrokered =
      options.credentialBroker?.kind === "e2b-native" ||
      options.credentialBrokerMode === "brokered";
    if (!isBrokered) {
      return await resumeWithRetry(sandboxId);
    }
    const broker =
      options.credentialBroker?.kind === "e2b-native"
        ? options.credentialBroker
        : undefined;
    if (!broker) {
      // Brokered provenance but no shape to refresh from: we cannot re-seed the
      // vault with a fresh token. Fail closed BEFORE resuming — do not even
      // connect (which would auto-resume the guest), so the sandbox stays paused
      // rather than running on a stale/absent (possibly revoked/rotated)
      // credential.
      throw new Error(
        `E2B brokered sandbox ${sandboxId} resume is missing the broker shape needed to refresh the vault secret (#114); refusing to resume.`,
      );
    }
    const secretName = e2bBrokerSecretName(sandboxId);
    // Refresh the vault secret with the fresh token BEFORE connecting.
    // `Sandbox.connect` auto-resumes the guest, so refreshing AFTER connect would
    // leave a window where the guest runs against the PRIOR (stale/possibly
    // revoked) credential. The vault Secret is PROJECT-scoped and addressed by
    // name — both the sandboxId and the fresh installation token are known here,
    // with NO live sandbox connection — so we can rewrite it first. Fail closed:
    // if the refresh fails we throw WITHOUT connecting, so the sandbox stays
    // PAUSED and never resumes on a stale/absent credential (and never falls back
    // to a resident raw token).
    try {
      if (await Secret.exists(secretName)) {
        await Secret.update(secretName, broker.installationToken);
      } else {
        // The vault entry is gone (e.g. destroyed out of band). Re-create it;
        // the persisted rules already reference this name, so injection resumes.
        await Secret.create(secretName, broker.installationToken);
      }
    } catch (error) {
      console.error(
        `[e2b] brokered resume vault refresh failed for ${sandboxId}; refusing to resume (sandbox stays paused)`,
        error,
      );
      throw error;
    }
    // The vault now holds the fresh token — it is safe to resume the guest.
    // Connect with the liveness probe SKIPPED (only E2B's own internal resume
    // probe runs), mark the session brokered so teardown destroys the vault
    // secret, then run the control-plane probe ourselves. If the refresh above
    // had already connected in a retry and then failed we would have killed it —
    // but with refresh strictly BEFORE connect, a refresh failure means nothing
    // was ever connected.
    const session = await resumeWithRetry(sandboxId, { skipReadyCheck: true });
    session.markBrokered(secretName);
    try {
      await session.runCommand("echo 'hello'", { cwd: "/" });
    } catch (error) {
      // Post-resume liveness probe failed. The vault holds a fresh token and the
      // guest never held a raw one (never-resident), but do not leave a
      // half-alive brokered guest: tear it down (kill + destroy the vault secret)
      // then rethrow so the run cannot proceed.
      console.error(
        `[e2b] brokered resume liveness probe failed for ${sandboxId}; tearing down`,
        error,
      );
      await session.shutdown().catch(() => {});
      throw error;
    }
    console.log(`[e2b] Sandbox ${sandboxId} is running (brokered resume)`);
    return session;
  }

  /**
   * #114: force-destroy a sandbox by id, ALSO destroying its (derived) vault
   * secret so no secret is orphaned when teardown does not go through a
   * broker-aware {@link E2BSession}. Destroy of a missing secret is a no-op, so
   * this is safe for unbrokered E2B sandboxes too.
   *
   * Ordering: KILL FIRST, then destroy the secret in a `finally`. `Sandbox.connect`
   * auto-resumes a paused guest, so if we destroyed the secret BEFORE connecting
   * the guest would briefly resume with its injection rules pointing at a
   * now-deleted secret. By killing first the guest only ever resumes while the
   * secret still exists (bounded by its own ~1h TTL, never-resident — nothing to
   * re-leak), and the `finally` still guarantees the secret is destroyed even if
   * kill throws. Mirrors {@link E2BSession.shutdown}'s finally pattern.
   */
  async shutdownById(
    sandboxId: string,
    // #114: Daytona-only param (its broker secret name derives from the thread
    // id, not the sandboxId). E2B derives its vault-secret name from the
    // sandboxId, so this is ignored here — accepted only to satisfy the
    // ISandboxProvider signature.
    _brokerSecretName?: string,
  ): Promise<void> {
    const secretName = e2bBrokerSecretName(sandboxId);
    try {
      const sandbox = await Sandbox.connect(sandboxId);
      await sandbox.kill();
    } catch (error) {
      console.warn(`[e2b] failed to kill sandbox ${sandboxId}:`, error);
    } finally {
      await destroyBrokerSecretBestEffort(secretName);
    }
  }

  async hibernateById(sandboxId: string): Promise<void> {
    const sandbox = await Sandbox.connect(sandboxId);
    console.log(await sandbox.commands.run("free -h"));
    const startTime = Date.now();
    console.log(`Pausing sandbox... ${sandboxId}`);
    await sandbox.pause({ requestTimeoutMs: 2 * 60 * 1000 }); // 2 minutes
    console.log(`Paused sandbox in ${Date.now() - startTime}ms`);
  }
}
