import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildDaemonEnv, type BrokerHandoff } from "./daemon-env";
import { ghBrokerConfigYaml } from "./gh-broker";
import { verifyGhAuth } from "./verify-gh-auth";

export interface HostGhPreflightArgs {
  /** The run's clone on the host (gh runs with it as cwd). */
  workdir: string;
  /** #380: from the unsealed RunSecrets; used only on a legacy-direct box. */
  installationToken: string;
  botLogin: string;
  /** The run's brokers; null on a legacy-direct (unbrokered) box. */
  broker: BrokerHandoff | null;
  egressProxyUrl: string | null;
  /** Injectable `gh auth status` runner (tests). */
  exec?: Parameters<typeof verifyGhAuth>[0]["exec"];
}

/**
 * The fail-closed bot-identity precondition (ADR-002 F3), run by the WORKER on
 * the host before the run's container exists: `gh auth status` with the
 * sanitized env (buildDaemonEnv) and an isolated, worker-private gh config dir
 * that routes gh through the run's gh broker. It proves the brokers answer as
 * the App bot before an agent is started that would post through them; a box
 * that cannot is blocked, never allowed to post as the wrong identity.
 *
 * Nothing here enters the container: the config dir is a mkdtemp of the
 * worker's own and is removed before this returns. Throws on a failed check.
 */
export async function preflightHostGhAuth(
  args: HostGhPreflightArgs,
): Promise<void> {
  const ghConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "automata-gh-"));
  try {
    if (args.broker) {
      await fs.writeFile(
        path.join(ghConfigDir, "config.yml"),
        ghBrokerConfigYaml(args.broker.ghSocketPath),
        { mode: 0o600 },
      );
    }
    const env = buildDaemonEnv({
      baseEnv: process.env,
      // No model call happens here; the box key must not ride this env.
      anthropicApiKey: "",
      installationToken: args.installationToken,
      ghConfigDir,
      botLogin: args.botLogin,
      egressProxyUrl: args.egressProxyUrl,
      broker: args.broker,
    });
    const result = await verifyGhAuth({
      workdir: args.workdir,
      env,
      exec: args.exec,
    });
    if (!result.ok) {
      throw new Error(
        `gh auth precondition failed — blocking run (agent would post as the wrong identity): ${result.detail}`,
      );
    }
  } finally {
    await fs.rm(ghConfigDir, { recursive: true, force: true }).catch(() => {});
  }
}
