import { bashQuote } from "../utils";
import type { EgressPolicyShape } from "../egress";

/**
 * Pure command/args builders for Docker-plane egress enforcement (#66 slice 3,
 * spec §3.5). No docker daemon required — everything here is string assembly,
 * unit-tested as such; docker-provider.ts executes the results.
 *
 * Model: when a sandbox is created WITH an egress policy shape, the provider
 * 1. creates an `--internal` network (no outbound route at all),
 * 2. starts a sidecar container (same base image) attached to BOTH that
 *    internal network and the default bridge, running the standalone
 *    filtering forward proxy (egress-proxy-standalone.cjs, bind-mounted
 *    read-only),
 * 3. runs the sandbox container ON the internal network with HTTP(S)_PROXY
 *    pointed at the sidecar's network alias.
 * The sandbox's only path out is therefore through the proxy — env-unset
 * inside the sandbox cannot bypass it (the internal network has no route),
 * unlike the cooperative worker-plane env proxying.
 *
 * Audit v1: the sidecar logs every decision as a JSON line on its stdout
 * (`docker logs <sidecar>`); sandbox-plane audit POSTs to the control plane
 * are a documented follow-up (docs/egress-enforcement.md).
 */

/** Sidecar proxy listen port on the internal network. */
export const EGRESS_PROXY_PORT = 3128;
/** DNS alias for the sidecar on the internal network. */
export const EGRESS_PROXY_ALIAS = "automata-egress-proxy";
/** Where the standalone proxy script is mounted inside the sidecar. */
export const EGRESS_PROXY_SCRIPT_CONTAINER_PATH = "/automata/egress-proxy.cjs";

/** Internal (`--internal`) network name for one sandbox container. */
export function egressNetworkName(containerName: string): string {
  return `automata-egress-${containerName}`;
}

/** Sidecar container name for one sandbox container. */
export function egressSidecarName(containerName: string): string {
  return `${containerName}-egress`;
}

/**
 * `docker network create --internal <name>` — idempotent by construction:
 * a pre-existing network of that name is fine (`|| true` would swallow real
 * errors, so the caller ignores only "already exists" instead).
 */
export function buildEgressNetworkCreateCommand(networkName: string): string {
  return `docker network create --internal ${networkName}`;
}

/**
 * Run the sidecar: attached to the internal network under the well-known
 * alias, script bind-mounted read-only, policy shape delivered as JSON env
 * (spec §3.8 — the sidecar learns the shape and nothing else).
 */
export function buildEgressSidecarRunCommand({
  sidecarName,
  networkName,
  baseImage,
  scriptHostPath,
  policy,
}: {
  sidecarName: string;
  networkName: string;
  baseImage: string;
  scriptHostPath: string;
  policy: EgressPolicyShape;
}): string {
  const policyJson = JSON.stringify({
    level: policy.level,
    allowlist: policy.allowlist,
  });
  return [
    `docker run -d --name ${sidecarName}`,
    `--network ${networkName}`,
    `--network-alias ${EGRESS_PROXY_ALIAS}`,
    `-v ${bashQuote(scriptHostPath)}:${EGRESS_PROXY_SCRIPT_CONTAINER_PATH}:ro`,
    `-e EGRESS_POLICY_JSON=${bashQuote(policyJson)}`,
    `-e EGRESS_PROXY_PORT=${EGRESS_PROXY_PORT}`,
    `${baseImage} node ${EGRESS_PROXY_SCRIPT_CONTAINER_PATH}`,
  ].join(" ");
}

/**
 * Attach the sidecar to the default bridge so it (and only it) has a route
 * out. The sandbox container stays internal-only.
 */
export function buildEgressSidecarBridgeConnectCommand(
  sidecarName: string,
): string {
  return `docker network connect bridge ${sidecarName}`;
}

/**
 * Flags spliced into the sandbox `docker run`: pin it to the internal
 * network and point every proxy-honouring client at the sidecar. NO_PROXY
 * keeps loopback traffic (daemon unix/localhost plumbing) off the proxy.
 */
export function buildSandboxEgressRunFlags(networkName: string): string {
  const proxyUrl = `http://${EGRESS_PROXY_ALIAS}:${EGRESS_PROXY_PORT}`;
  const noProxy = "127.0.0.1,localhost";
  return [
    `--network ${networkName}`,
    `-e HTTP_PROXY=${bashQuote(proxyUrl)}`,
    `-e HTTPS_PROXY=${bashQuote(proxyUrl)}`,
    `-e http_proxy=${bashQuote(proxyUrl)}`,
    `-e https_proxy=${bashQuote(proxyUrl)}`,
    `-e NO_PROXY=${bashQuote(noProxy)}`,
    `-e no_proxy=${bashQuote(noProxy)}`,
  ].join(" ");
}

/** Best-effort teardown commands for removeSandbox/shutdown. */
export function buildEgressTeardownCommands(containerName: string): string[] {
  return [
    `docker rm -f ${egressSidecarName(containerName)}`,
    `docker network rm ${egressNetworkName(containerName)}`,
  ];
}
