import { bashQuote } from "../utils";
import { sandboxTimeoutMs } from "../constants";
import type { CredentialBrokerShape } from "../types";

/**
 * Pure command/args builders for the Docker-plane credential-broker sidecar
 * (#114). No docker daemon required — everything here is string assembly,
 * unit-tested as such; docker-provider.ts executes the results in
 * setUpCredentialBroker.
 *
 * Design (mirror of the egress sidecar in docker-egress.ts): when a sandbox is
 * created WITH a credential-broker shape, a per-run sidecar container holds the
 * installation token in its OWN container (read from a bind-mounted `:ro`
 * secret FILE, NOT `-e`) and runs the standalone git broker
 * (cred-broker-standalone.cjs). The guest's git points at
 * `http://<alias>:<port>/<owner>/<repo>.git` with a per-run Bearer (useless
 * off-box); the sidecar verifies the bearer, injects the real credential
 * server-side, and streams to github.com. The guest never sees the token.
 *
 * SECRET-CUSTODY NOTE (§4 of the SPEC): unlike the egress sidecar, which
 * passes its NON-secret policy via `-e EGRESS_POLICY_JSON` (visible in `docker
 * inspect .Config.Env`), the token+bearer here are delivered ONLY via a
 * `0o400` `:ro` file mount — they must never appear on argv, `-e`, `docker
 * inspect`, `docker ps`, or control-plane logs. Only the non-secret repo slug
 * and port are `-e`.
 */

/**
 * Thrown by the Docker provider when a RESUME targets a sandbox whose persisted
 * provenance is `"brokered"` (#114). A brokered Docker sandbox is non-resumable:
 * re-establishing a broker on an already-live guest would race the surviving
 * named sidecar and cannot scrub a raw token from a running daemon's
 * `/proc/environ`. The provider throws this BEFORE the guest is unpaused; the
 * control plane catches it (by name) and forces a fresh, fail-closed recreate.
 */
export class BrokeredSandboxNotResumableError extends Error {
  constructor(sandboxId: string) {
    super(
      `Brokered Docker sandbox ${sandboxId} is not resumable; recreate it (#114).`,
    );
    this.name = "BrokeredSandboxNotResumableError";
  }
}

/** Sidecar git-broker listen port on the internal network (≠ egress 3128). */
export const CRED_BROKER_GIT_PORT = 3129;
/** DNS alias for the cred-broker sidecar on the internal network. */
export const CRED_BROKER_ALIAS = "automata-cred-broker";
/** Where the standalone broker script is mounted inside the sidecar. */
export const CRED_BROKER_SCRIPT_CONTAINER_PATH = "/automata/cred-broker.cjs";
/** Where the `:ro` secret file is mounted inside the sidecar. */
export const CRED_BROKER_SECRETS_CONTAINER_PATH =
  "/run/cred-broker/secrets.json";

/**
 * Prefix of every cred-broker internal-network name. The single source for
 * both naming ({@link credBrokerNetworkName}) and any future leaked-network
 * sweep filter — never re-inline the string. (Distinct from the egress prefix
 * so the two sidecars' dedicated networks never collide; a wired provider may
 * instead reuse the egress network when egress is also on — that is a wiring
 * decision deferred to the follow-up.)
 */
export const CRED_BROKER_NETWORK_PREFIX = "automata-cred-broker-";

/** Internal (`--internal`) network name for one sandbox container. */
export function credBrokerNetworkName(containerName: string): string {
  return `${CRED_BROKER_NETWORK_PREFIX}${containerName}`;
}

/** Suffix appended to a sandbox container name to form its sidecar name. The
 * single source for both {@link credBrokerSidecarName} and the reverse
 * (sidecar → guest name) used by the orphan-reclaim sweep — never re-inline. */
export const CRED_BROKER_SIDECAR_SUFFIX = "-cred-broker";

/** Cred-broker sidecar container name for one sandbox container. Built from
 * {@link CRED_BROKER_SIDECAR_SUFFIX} so it stays in lockstep with the reverse
 * derivation in the orphan-reclaim sweep. */
export function credBrokerSidecarName(containerName: string): string {
  return `${containerName}${CRED_BROKER_SIDECAR_SUFFIX}`;
}

/**
 * Docker label key/value stamped on every cred-broker sidecar at creation
 * ({@link buildCredBrokerSidecarRunCommand}). This is the ROBUST identity marker
 * the orphan-reclaim sweep selects candidates by (`docker ps -a --filter
 * label=<key>=<value>`), NOT the `-cred-broker` name suffix.
 *
 * Why a label and not the name suffix (#114 Codex HIGH 1): a guest name is
 * `terragon-sandbox[-test]-MMDD-HHMM-<nanoid>` and the nanoid alphabet is
 * `A-Za-z0-9_-`, so a legitimate guest name CAN in principle end in the literal
 * `-cred-broker`. Classifying by suffix would then mistake that live guest for a
 * sidecar, omit it from the live-guest set, and force-remove its (real, still
 * referenced) broker. The label is set only by us on the sidecar `docker run`,
 * so it can never collide with a guest name however the nanoid falls.
 */
export const CRED_BROKER_ROLE_LABEL_KEY = "automata.role";
export const CRED_BROKER_ROLE_LABEL_VALUE = "cred-broker";

/**
 * Extra margin added on top of the control-plane boot timeout to derive
 * {@link ORPHAN_BROKER_MIN_AGE_MS}. Generous, so clock skew / a slow readiness
 * barrier / clone can never push a legitimate in-flight create past the gate.
 */
export const ORPHAN_BROKER_AGE_MARGIN_MS = 15 * 60 * 1000;

/**
 * Minimum age a cred-broker sidecar/network must reach before the create-time
 * orphan sweep may reclaim it (#114).
 *
 * DERIVATION (Codex HIGH 2 — the age gate must EXCEED the max boot lifetime, not
 * undercut it): a guest `docker run` has no per-create timeout of its own, so the
 * longest a legitimate create can sit with its broker up but its guest not yet
 * attached is bounded by the control-plane sandbox-creation timeout,
 * {@link sandboxTimeoutMs} (currently 15 min; see ../constants.ts). We set the
 * gate to that timeout PLUS {@link ORPHAN_BROKER_AGE_MARGIN_MS} (15 min) = 30 min
 * so a slow-but-legitimate create still booting right up to the timeout is always
 * younger than the gate and therefore protected from a concurrent create's sweep.
 * Deriving it from the constant (rather than a hardcoded 10 min, which was
 * SHORTER than the boot timeout) keeps the two from silently drifting apart. The
 * gate still bounds how long a genuinely stranded sidecar can hold the
 * installation token before the next brokered create reclaims it.
 */
export const ORPHAN_BROKER_MIN_AGE_MS =
  sandboxTimeoutMs + ORPHAN_BROKER_AGE_MARGIN_MS;

/**
 * Pure orphan-selection predicate for the create-time broker reclaim (#114).
 *
 * A cred-broker sidecar/network is a genuine orphan — safe to force-remove —
 * ONLY when BOTH hold:
 *  - its guest is NOT live (no running/paused container with the guest name):
 *    a live sandbox always has its guest attached, so a live broker is never
 *    unreferenced; and
 *  - it is OLDER than {@link ORPHAN_BROKER_MIN_AGE_MS}: a concurrent create
 *    that has stood up its broker but not yet attached its guest is younger
 *    than this, so the age gate protects that in-flight window.
 *
 * Because BOTH are required, this can never select a concurrent LIVE
 * sandbox's broker: a live one is either young (age gate) or has a running/
 * paused guest attached (reference gate). Only a broker whose guest never came
 * up (or already died) AND that has aged past the create window is reclaimed.
 * The current run's own container name is always excluded (defensive; its
 * fresh nanoid name never collides in practice).
 */
export function isAgedUnreferencedBroker(params: {
  /** The sandbox container name this broker belongs to. */
  containerName: string;
  /** ms-since-epoch the sidecar/network was created (NaN → unknown → keep). */
  createdAtMs: number;
  /** Whether a running/paused guest container with this name exists. */
  guestAlive: boolean;
  /** Reference time (ms since epoch). */
  nowMs: number;
  /** Age threshold; defaults to {@link ORPHAN_BROKER_MIN_AGE_MS}. */
  minAgeMs?: number;
  /** The in-flight create's container name — never reclaim it. */
  currentContainerName?: string;
}): boolean {
  const {
    containerName,
    createdAtMs,
    guestAlive,
    nowMs,
    currentContainerName,
  } = params;
  const minAgeMs = params.minAgeMs ?? ORPHAN_BROKER_MIN_AGE_MS;
  if (currentContainerName && containerName === currentContainerName) {
    return false;
  }
  if (guestAlive) {
    return false;
  }
  // Unknown/unparseable age → fail safe and keep it.
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }
  return nowMs - createdAtMs >= minAgeMs;
}

/**
 * The JSON payload written to the host secret file (mode `0o400`, bind-mounted
 * `:ro` into the sidecar). Kept as a builder so the write path and the tests
 * share one shape. NEVER logged; NEVER passed as argv/`-e`.
 */
export function buildCredBrokerSecretsFileContent(
  shape: Pick<CredentialBrokerShape, "installationToken" | "runBearer">,
): string {
  return JSON.stringify({
    installationToken: shape.installationToken,
    runBearer: shape.runBearer,
  });
}

/**
 * Run the cred-broker sidecar: attached to the internal network under the
 * well-known alias, broker script + secret file both bind-mounted read-only,
 * repo slug + port delivered as NON-secret env. The token+bearer are delivered
 * ONLY through the `:ro` secret-file mount — never argv/`-e` (see the
 * secret-custody note above).
 */
export function buildCredBrokerSidecarRunCommand({
  sidecarName,
  networkName,
  baseImage,
  scriptHostPath,
  secretsHostPath,
  repoFullName,
}: {
  sidecarName: string;
  networkName: string;
  baseImage: string;
  scriptHostPath: string;
  secretsHostPath: string;
  repoFullName: string;
}): string {
  return [
    `docker run -d --name ${sidecarName}`,
    // Robust identity marker for the orphan-reclaim sweep — selection is by this
    // label, never by the `-cred-broker` name suffix (#114 HIGH 1).
    `--label ${CRED_BROKER_ROLE_LABEL_KEY}=${CRED_BROKER_ROLE_LABEL_VALUE}`,
    `--network ${networkName}`,
    `--network-alias ${CRED_BROKER_ALIAS}`,
    `-v ${bashQuote(scriptHostPath)}:${CRED_BROKER_SCRIPT_CONTAINER_PATH}:ro`,
    `-v ${bashQuote(secretsHostPath)}:${CRED_BROKER_SECRETS_CONTAINER_PATH}:ro`,
    `-e CRED_BROKER_REPO_FULL_NAME=${bashQuote(repoFullName)}`,
    `-e CRED_BROKER_GIT_PORT=${CRED_BROKER_GIT_PORT}`,
    `-e CRED_BROKER_SECRETS_FILE=${bashQuote(CRED_BROKER_SECRETS_CONTAINER_PATH)}`,
    `${baseImage} node ${CRED_BROKER_SCRIPT_CONTAINER_PATH}`,
  ].join(" ");
}

/**
 * The guest git-config lines that route git through the cred-broker sidecar
 * (the port-relocated form of the worker's brokered git wiring in
 * daemon-env.ts). The guest carries ONLY the per-run Bearer — never the
 * installation token.
 *
 * Also emits DEFENSIVE residue-removal lines (belt-and-suspenders for #89; a
 * fresh base image is clean so these are normally no-ops): remove any
 * `~/.git-credentials`, any prior `credential.helper`, and any prior
 * github.com `extraheader`, before writing the brokered wiring. All idempotent
 * / tolerant of "not found".
 */
export function buildGuestCredBrokerGitConfig({
  alias,
  port,
  bearer,
}: {
  alias: string;
  port: number;
  bearer: string;
}): string[] {
  const brokerUrl = `http://${alias}:${port}/`;
  return [
    // Defensive residue removal (idempotent; tolerant of "not found").
    `rm -f ~/.git-credentials`,
    `git config --global --unset-all credential.helper || true`,
    `git config --global --unset-all http.https://github.com/.extraheader || true`,
    // Brokered wiring: rewrite github.com to the broker, present the per-run
    // bearer, and disable any credential helper so nothing writes a token.
    `git config --global url.${bashQuote(brokerUrl)}.insteadOf https://github.com/`,
    `git config --global http.${brokerUrl}.extraheader ${bashQuote(`Authorization: Bearer ${bearer}`)}`,
    `git config --global credential.helper ${bashQuote("")}`,
  ];
}

/**
 * Guest `docker run` flags for a BROKER-ONLY sandbox (no egress enforcement):
 * pin the guest to the cred-broker's user-defined (non-internal) network so it
 * reaches the sidecar by alias AND keeps normal outbound internet (the
 * broker's job is to keep the TOKEN out of the guest, not to fence egress —
 * that is #66's separate concern). When egress IS also on, the guest is already
 * pinned to the egress internal network and the sidecar joins THAT network
 * instead (see docker-provider.setUpCredentialBroker), so this helper is unused.
 */
export function buildSandboxCredBrokerRunFlags(networkName: string): string {
  return `--network ${networkName}`;
}
