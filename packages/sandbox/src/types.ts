import { SandboxProvider, SandboxSize } from "@terragon/types/sandbox";
import { AIAgent, AIAgentCredentials } from "@terragon/agent/types";
import { FeatureFlags } from "@terragon/daemon/shared";
import { McpConfig } from "./mcp-config";

/**
 * Per-repo egress policy SHAPE (#66) — level + FINAL allowlist, fully
 * resolved control-plane-side (system entries already merged in). Structural
 * mirror of the www-side / worker-side shapes — declared per-package, never
 * imported across the plane boundary. Providers learn ONLY this shape — never
 * the settings table or where the policy came from. See src/egress.ts for the
 * per-provider mappings.
 */
export type EgressPolicyShape = {
  level: "none" | "ip_port" | "domain";
  allowlist: string[];
};

/**
 * Per-run credential-broker SHAPE (#114) — the inputs a Docker cred-broker
 * sidecar needs to stand up a repo-fenced git-smart-HTTP proxy: the GitHub
 * installation token, the per-run bearer the guest presents, and the fenced
 * `owner/repo`. Structural mirror of {@link EgressPolicyShape} — declared
 * per-package, resolved control-plane-side, never imported across the plane
 * boundary.
 *
 * HONESTY NOTE: unlike {@link EgressPolicyShape} (which carries only resolved
 * POLICY — non-secret), this shape carries a LIVE SECRET (the installation
 * token). A provider that consumes it therefore becomes a secret custodian for
 * the run's lifetime — a deliberate, narrower trust statement than egress's
 * plane-neutral invariant. The sidecar builders in
 * providers/docker-cred-broker.ts keep the token OFF argv/`-e`, delivering it
 * only through a `0o400` `:ro` file mount.
 *
 * WIRED (#114): consumed on the Docker create path (docker-provider
 * setUpCredentialBroker + setup.ts brokered git-config + env.ts brokered env);
 * resume fails closed via the NON-secret
 * {@link CreateSandboxOptions.credentialBrokerMode}. Built control-plane-side
 * only at CREATE; the bearer is ephemeral (never persisted).
 */
export type CredentialBrokerShape = {
  installationToken: string;
  runBearer: string;
  repoFullName: string;
};

// NOTE: This is stored in the database, so don't remove any values from this list.
export type SandboxStatus =
  | "unknown"
  | "provisioning"
  | "booting"
  | "running"
  | "paused"
  | "killed";

export type BootingSubstatus =
  | "provisioning"
  | "provisioning-done"
  | "cloning-repo"
  | "installing-agent"
  | "installing-sandbox-scripts"
  | "running-setup-script"
  | "booting-done";

export type CreateSandboxOptions = {
  threadName: string | null;
  agent: AIAgent | null;
  agentCredentials: AIAgentCredentials | null;
  userName: string;
  userEmail: string;
  githubAccessToken: string;
  githubRepoFullName: string;
  repoBaseBranchName: string;
  userId: string;
  sandboxProvider: SandboxProvider;
  sandboxSize: SandboxSize;
  createNewBranch: boolean;
  branchName?: string; // Specific branch to checkout when createNewBranch is false
  environmentVariables: Array<{ key: string; value: string }>;
  mcpConfig?: McpConfig;
  autoUpdateDaemon: boolean;
  customSystemPrompt?: string | null; // Custom system prompt to append to Claude
  skipSetupScript?: boolean; // Skip running terragon-setup.sh during sandbox setup
  setupScript?: string | null; // Custom setup script to override repository's terragon-setup.sh
  fastResume?: boolean; // Fast resume mode - skips unnecessary setup steps that run everytime (claude credentials, daemon update, etc)
  publicUrl: string;
  /**
   * Per-repo egress policy SHAPE (#66) — see {@link EgressPolicyShape}.
   * Absent = no enforcement (today's behavior). Enforced per provider:
   * Docker = internal network + filtering proxy sidecar (docker-egress.ts),
   * E2B = native firewall (network.allowOut/denyOut), Daytona = create-time
   * domainAllowList (`domain` level only — `ip_port`/`none` are create-time
   * errors there). See src/egress.ts for the mappings and
   * docs/egress-enforcement.md for ops caveats.
   */
  egressPolicy?: EgressPolicyShape;
  /**
   * Per-run credential-broker SHAPE (#114) — see {@link CredentialBrokerShape}.
   * Present (Docker create path, flag on) = the guest is brokered: the provider
   * stands up a cred-broker sidecar and the guest never receives the
   * installation token. Absent = today's raw-token behavior (rollback / flag
   * off / non-Docker provider). Carries a live secret; built only at CREATE.
   */
  credentialBroker?: CredentialBrokerShape;
  /**
   * NON-secret brokered provenance (#114). Persisted on the thread so a RESUME
   * can detect that a sandbox "should be brokered" WITHOUT the secret shape
   * (which is never persisted). On resume the Docker provider fails closed when
   * this is `"brokered"` (throws {@link BrokeredSandboxNotResumableError}
   * before the guest is unpaused); the control plane then recreates. Absent /
   * `"legacy-direct"` = today's resume behavior.
   */
  credentialBrokerMode?: "brokered" | "legacy-direct";
  featureFlags: FeatureFlags;
  generateBranchName: (threadName: string | null) => Promise<string | null>;
  onStatusUpdate: ({
    sandboxId,
    sandboxStatus,
    bootingStatus,
  }: {
    sandboxId: string | null;
    sandboxStatus: SandboxStatus;
    bootingStatus: BootingSubstatus | null;
  }) => Promise<void>;
};

export interface ISandboxProvider {
  getSandboxOrNull(sandboxId: string): Promise<ISandboxSession | null>;
  getOrCreateSandbox(
    sandboxId: string | null,
    options: CreateSandboxOptions,
  ): Promise<ISandboxSession>;
  hibernateById(sandboxId: string): Promise<void>;
  extendLife(sandboxId: string): Promise<void>;
  /**
   * Force-destroy a sandbox by id WITHOUT starting/unpausing it (#114). Unlike
   * {@link getSandboxOrNull} (which unpauses/starts a stale guest so it can be
   * resumed), this tears the guest and any sidecar/network/secret-file
   * resources down in place — used by the brokered-resume recreate so a stale
   * raw-token guest is never revived on its way to the grave. Optional: only
   * the Docker provider (the only brokered provider) implements it; callers
   * fall back to {@link getSandboxOrNull} + shutdown otherwise.
   */
  shutdownById?(sandboxId: string): Promise<void>;
}

export interface BackgroundCommandOptions {
  onOutput?: (data: string) => void;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface ISandboxSession {
  readonly sandboxId: string;
  readonly sandboxProvider: SandboxProvider;
  readonly homeDir: string;
  readonly repoDir: string;
  hibernate(): Promise<void>;
  runCommand(
    command: string,
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      timeoutMs?: number;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
    },
  ): Promise<string>;
  runBackgroundCommand(
    command: string,
    options?: BackgroundCommandOptions,
  ): Promise<void>;
  shutdown(): Promise<void>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
}
