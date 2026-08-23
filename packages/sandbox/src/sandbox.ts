import type { SandboxProvider } from "@terragon/types/sandbox";
import type { BrokerRefresh, CreateSandboxOptions } from "./types";
import { getSandboxProvider } from "./provider";
import { setupSandboxEveryTime, setupSandboxOneTime } from "./setup";

export async function getOrCreateSandbox(
  sandboxId: string | null,
  options: CreateSandboxOptions,
) {
  const provider = getSandboxProvider(options.sandboxProvider);
  const log = (msg: string) => {
    console.log(`[${options.sandboxProvider}] ${msg}`);
  };
  const startTime = Date.now();
  if (sandboxId) {
    log(`Resuming sandbox ${sandboxId}...`);
  } else {
    log(`Creating new sandbox for ${options.githubRepoFullName}...`);
    await options.onStatusUpdate({
      sandboxId: null,
      sandboxStatus: "provisioning",
      bootingStatus: "provisioning",
    });
  }
  const sandbox = await provider.getOrCreateSandbox(sandboxId, options);
  if (!sandboxId) {
    await options.onStatusUpdate({
      sandboxId: sandbox.sandboxId,
      sandboxStatus: "booting",
      bootingStatus: "provisioning-done",
    });
  }
  // #114: on a CREATE the provider has already stood up the guest plus any
  // per-run sidecars (egress and/or the cred-broker), their network(s), and the
  // `:ro` secret file. If setup throws AFTER that, those resources orphan — and
  // an orphaned cred-broker sidecar still holds the installation token in its
  // heap / `:ro` secret file. So tear the fresh sandbox down (its shutdown()
  // sweeps sidecar + network + secret file) before rethrowing. This is the
  // provider-agnostic source fix that keeps EVERY caller of getOrCreateSandbox
  // safe on a setup failure, complementing the provider's own create-phase
  // try/catch (which sweeps a failure DURING create). A RESUME never owns the
  // guest, so it is left untouched.
  try {
    log(`setupSandboxEveryTime ${sandbox.sandboxId}...`);
    await setupSandboxEveryTime({
      session: sandbox,
      options,
      isCreatingSandbox: !sandboxId,
    });
    if (!sandboxId) {
      log(`setupSandboxOneTime ${sandbox.sandboxId}...`);
      await setupSandboxOneTime(sandbox, options);
    }
  } catch (setupError) {
    if (!sandboxId) {
      log(
        `setup failed for fresh sandbox ${sandbox.sandboxId}; tearing it down to avoid orphaned guest/sidecar/network/secret`,
      );
      await sandbox.shutdown().catch((teardownError) => {
        console.error(
          `[${options.sandboxProvider}] failed to tear down sandbox ${sandbox.sandboxId} after setup failure`,
          teardownError,
        );
      });
    }
    throw setupError;
  }
  const duration = Date.now() - startTime;
  if (sandboxId) {
    log(`Resumed sandbox ${sandbox.sandboxId} in ${duration}ms`);
  } else {
    log(`Created sandbox ${sandbox.sandboxId} in ${duration}ms`);
  }
  await options.onStatusUpdate({
    sandboxId: sandbox.sandboxId,
    sandboxStatus: "running",
    bootingStatus: null,
  });
  return sandbox;
}

export async function hibernateSandbox({
  sandboxProvider,
  sandboxId,
}: {
  sandboxProvider: SandboxProvider;
  sandboxId: string;
}) {
  const provider = getSandboxProvider(sandboxProvider);
  await provider.hibernateById(sandboxId);
}

export async function extendSandboxLife({
  sandboxProvider,
  sandboxId,
  refresh,
}: {
  sandboxProvider: SandboxProvider;
  sandboxId: string;
  /**
   * #114 §7a: lazy broker-secret refresh handle. Present only for brokered E2B
   * threads; the provider rotates the vault secret (throttled) before connect.
   * Absent = today's behavior. See {@link BrokerRefresh}.
   */
  refresh?: BrokerRefresh;
}) {
  const provider = getSandboxProvider(sandboxProvider);
  await provider.extendLife(sandboxId, refresh);
}

export async function getSandboxOrNull({
  sandboxProvider,
  sandboxId,
  refresh,
}: {
  sandboxProvider: SandboxProvider;
  sandboxId: string;
  /**
   * #114 §7a: lazy broker-secret refresh handle. Present only for brokered E2B
   * threads; the provider rotates the vault secret (throttled) before connect.
   * Absent = today's behavior. See {@link BrokerRefresh}.
   */
  refresh?: BrokerRefresh;
}) {
  const provider = getSandboxProvider(sandboxProvider);
  return await provider.getSandboxOrNull(sandboxId, refresh);
}

/**
 * Force-destroy a sandbox by id, tearing down its container and any sidecar/
 * network/secret-file resources (#114). Best-effort: a missing sandbox is a
 * no-op. Used by the control plane's brokered-resume recreate (the CAS winner
 * destroys the stale sandbox before creating a fresh one), so a brokered
 * sandbox and its cred-broker sidecar are never orphaned.
 */
export async function shutdownSandboxById({
  sandboxProvider,
  sandboxId,
  brokerSecretName,
}: {
  sandboxProvider: SandboxProvider;
  sandboxId: string;
  /**
   * #114 (Daytona-only): the deterministic thread-derived org-Secret name to
   * delete alongside the guest. Daytona's broker secret name derives from the
   * thread id (not the sandboxId), so a by-id teardown of a fresh/stale sandbox
   * cannot re-derive it — the control plane supplies it so the token-holding
   * secret is never orphaned. Undefined for E2B/Docker/non-brokered.
   */
  brokerSecretName?: string;
}): Promise<void> {
  const provider = getSandboxProvider(sandboxProvider);
  // #114: prefer the in-place force-destroy that NEVER unpauses/starts the
  // guest. Routing through getSandboxOrNull (as the fallback does) would
  // unpause a stale brokered guest — reviving the raw-token guest we are trying
  // to tear down. The Docker, E2B, and Daytona providers implement shutdownById;
  // others keep the resume-then-shutdown fallback.
  if (provider.shutdownById) {
    await provider.shutdownById(sandboxId, brokerSecretName);
    return;
  }
  const session = await provider.getSandboxOrNull(sandboxId);
  if (session) {
    await session.shutdown();
  }
}
