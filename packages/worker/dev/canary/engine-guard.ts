import { CanaryRefusal } from "./github-token";

/**
 * The canary must only ever trigger on the box's OWN hatchet-lite. A Hatchet
 * token embeds its engine's gRPC and REST addresses as claims; a prod token
 * pasted into the env would otherwise point dispatch at the prod engine.
 * DEV ONLY.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostOf(hostPort: string): string {
  const trimmed = hostPort.trim();
  try {
    return new URL(
      trimmed.includes("://") ? trimmed : `grpc://${trimmed}`,
    ).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isLoopbackAddress(hostPortOrUrl: string): boolean {
  return LOOPBACK_HOSTS.has(hostOf(hostPortOrUrl));
}

/** The address claims of a Hatchet API token (unverified decode, as the SDK does). */
export function hatchetTokenAddresses(token: string): {
  grpcBroadcastAddress?: string;
  serverUrl?: string;
} {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new CanaryRefusal("HATCHET_CLIENT_TOKEN is not a JWT");
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new CanaryRefusal("HATCHET_CLIENT_TOKEN claims are not JSON");
  }
  return {
    ...(typeof claims.grpc_broadcast_address === "string"
      ? { grpcBroadcastAddress: claims.grpc_broadcast_address }
      : {}),
    ...(typeof claims.server_url === "string"
      ? { serverUrl: claims.server_url }
      : {}),
  };
}

/**
 * The engine addresses dispatch will use, refused unless both are loopback.
 * An explicit HATCHET_CLIENT_HOST_PORT / HATCHET_CLIENT_API_URL wins over the
 * token claims (the SDK's precedence); the result is passed to Hatchet.init
 * as an override so no yaml file can redirect it afterwards.
 */
export function resolveLocalEngine(env: NodeJS.ProcessEnv): {
  token: string;
  hostPort: string;
  apiUrl: string;
} {
  const token = env.HATCHET_CLIENT_TOKEN?.trim();
  if (!token) {
    throw new CanaryRefusal("HATCHET_CLIENT_TOKEN is not set");
  }
  const claims = hatchetTokenAddresses(token);
  const hostPort =
    env.HATCHET_CLIENT_HOST_PORT?.trim() || claims.grpcBroadcastAddress || "";
  const apiUrl = env.HATCHET_CLIENT_API_URL?.trim() || claims.serverUrl || "";
  if (!isLoopbackAddress(hostPort) || !isLoopbackAddress(apiUrl)) {
    throw new CanaryRefusal(
      `refusing a non-local engine (grpc=${hostPort || "unset"}, api=${apiUrl || "unset"}): the canary triggers only the box's own hatchet-lite`,
    );
  }
  return { token, hostPort, apiUrl };
}
