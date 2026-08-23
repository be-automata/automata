import {
  BackgroundCommandOptions,
  CreateSandboxOptions,
  ISandboxProvider,
  ISandboxSession,
} from "../types";
import { getTemplateIdForSize } from "@terragon/sandbox-image";
import { Sandbox, Secret } from "@e2b/code-interpreter";
import { retryAsync } from "@terragon/utils/retry";
import {
  E2B_BROKER_GITHUB_HOSTS,
  toE2bBrokeredNetwork,
  toE2bNetwork,
} from "../egress";

const HOME_DIR = "root";
const REPO_DIR = "repo";
const SLEEP_MS = 60 * 15 * 1000; // 15 minutes

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
 * egress firewall WITHOUT the header-injection rules (the rules reference the
 * vault secret, whose name derives from the not-yet-known sandboxId, so they
 * are attached via `updateNetwork` right after create). Composes with any
 * per-repo egress policy WITHOUT clobbering it; ensures the GitHub hosts are in
 * `allowOut` so the rules can fire once attached.
 */
function e2bBrokeredCreateBaseNetwork(
  egressPolicy: CreateSandboxOptions["egressPolicy"],
): E2bCreateNetwork {
  if (egressPolicy) {
    const base = toE2bNetwork(egressPolicy);
    const allowOut = [...base.allowOut];
    for (const host of E2B_BROKER_GITHUB_HOSTS) {
      if (!allowOut.includes(host)) {
        allowOut.push(host);
      }
    }
    return { denyOut: base.denyOut, allowOut };
  }
  // No egress policy: keep today's OPEN internet (0.0.0.0/0), plus the hosts so
  // the injection rules (attached next) fire. No denyOut.
  return { allowOut: ["0.0.0.0/0", ...E2B_BROKER_GITHUB_HOSTS] };
}

async function resumeWithRetry(sandboxId: string): Promise<E2BSession> {
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
      // Attempt to run a command to check if the sandbox is running
      await session.runCommand("echo 'hello'", { cwd: "/" });
      console.log(`[e2b] Sandbox ${sandboxId} is running`);
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
    await this.sandbox.kill();
    // #114: best-effort destroy of this run's vault secret so nothing is
    // orphaned. Idempotent (destroy of a missing secret is a no-op) and never
    // fatal to the teardown.
    if (this.brokerSecretName) {
      await Secret.destroy(this.brokerSecretName).catch((error) => {
        console.warn(
          `[e2b] failed to destroy broker secret ${this.brokerSecretName}:`,
          error,
        );
      });
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

  async extendLife(sandboxId: string): Promise<void> {
    const sandbox = await Sandbox.connect(sandboxId);
    await sandbox.setTimeout(SLEEP_MS);
  }

  async getSandboxOrNull(sandboxId: string): Promise<ISandboxSession | null> {
    try {
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
        await Secret.destroy(secretName).catch(() => {});
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
    const session = await resumeWithRetry(sandboxId);
    const isBrokered =
      options.credentialBroker?.kind === "e2b-native" ||
      options.credentialBrokerMode === "brokered";
    if (!isBrokered) {
      return session;
    }
    const broker =
      options.credentialBroker?.kind === "e2b-native"
        ? options.credentialBroker
        : undefined;
    if (!broker) {
      // Brokered provenance but no shape to refresh from: we cannot re-seed the
      // vault with a fresh token, so fail closed rather than resume on a stale
      // or absent credential.
      throw new Error(
        `E2B brokered sandbox ${sandboxId} resume is missing the broker shape needed to refresh the vault secret (#114); refusing to resume.`,
      );
    }
    const secretName = e2bBrokerSecretName(sandboxId);
    if (await Secret.exists(secretName)) {
      await Secret.update(secretName, broker.installationToken);
    } else {
      // The vault entry is gone (e.g. destroyed out of band). Re-create it; the
      // persisted rules already reference this name, so injection resumes.
      await Secret.create(secretName, broker.installationToken);
    }
    session.markBrokered(secretName);
    return session;
  }

  /**
   * #114: force-destroy a sandbox by id, ALSO destroying its (derived) vault
   * secret so no secret is orphaned when teardown does not go through a
   * broker-aware {@link E2BSession}. Destroy of a missing secret is a no-op, so
   * this is safe for unbrokered E2B sandboxes too. Connecting to kill may
   * briefly unpause a paused guest, but — unlike Docker — an E2B brokered guest
   * never held a raw token (never-resident) and this runs no setup, so there is
   * nothing to re-leak.
   */
  async shutdownById(sandboxId: string): Promise<void> {
    await Secret.destroy(e2bBrokerSecretName(sandboxId)).catch((error) => {
      console.warn(
        `[e2b] failed to destroy broker secret for ${sandboxId}:`,
        error,
      );
    });
    try {
      const sandbox = await Sandbox.connect(sandboxId);
      await sandbox.kill();
    } catch (error) {
      console.warn(`[e2b] failed to kill sandbox ${sandboxId}:`, error);
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
