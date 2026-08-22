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
   * networkAllowList/domainAllowList. See src/egress.ts for the mappings and
   * docs/egress-enforcement.md for ops caveats.
   */
  egressPolicy?: EgressPolicyShape;
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
