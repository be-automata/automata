/**
 * #373: growth-trigger knobs.
 *
 * WHY A SEPARATE MODULE AND NOT config.ts (V8). `loadWorkerConfig` runs at boot AND per
 * run; a typo in an alerting knob placed there would fail every agent run on the box.
 * These knobs are parsed once, at arm time, and only by the evaluator's wiring.
 *
 * DEFAULT-OFF, LIKE #204/#215. With `WORKER_ALERT_WEBHOOK_URL` unset or blank this
 * returns null WITHOUT reading anything else, so a stray value in another growth knob can
 * never stop a box that never enabled the feature from booting (AC 1). Once the URL is
 * set every knob is validated and a bad one is refused at boot (AC 7) — a box told to
 * alert must not silently run unwatched.
 *
 * The URL is a secret (a Slack incoming-webhook URL is its own credential), so no error
 * here ever echoes it.
 */

import { isIP } from "node:net";

import { formatHours, GROWTH_REFIRE_MS } from "./growth-triggers";

export const GROWTH_TRIGGER_INTERVAL_DEFAULT_S = 300;
const GROWTH_TRIGGER_INTERVAL_FLOOR_S = 30;
export const GROWTH_TRIGGER_SUSTAIN_DEFAULT_S = 900;
const GROWTH_TRIGGER_SUSTAIN_FLOOR_S = 60;
/**
 * The dedupe window (GROWTH_REFIRE_MS): a "sustained" condition that must last longer than
 * a day would be announced after the window that holds its re-fire has already turned
 * over, and the /proc sample buffer (sustain ÷ interval samples) would grow without a
 * bound worth having.
 */
export const GROWTH_TRIGGER_SUSTAIN_CEILING_S = GROWTH_REFIRE_MS / 1000;
/**
 * Half the sustain ceiling, derived: sustain must be ≥ 2 × the interval and is capped at
 * GROWTH_TRIGGER_SUSTAIN_CEILING_S, so no larger interval could ever boot. Refusing it
 * here names the real reason instead of a 2 × refusal the operator cannot satisfy.
 */
export const GROWTH_TRIGGER_INTERVAL_CEILING_S =
  GROWTH_TRIGGER_SUSTAIN_CEILING_S / 2;
export const GROWTH_TRIGGER_RAM_FRACTION_DEFAULT = 0.7;

interface GrowthTriggerConfig {
  /** Never log this. */
  webhookUrl: string;
  intervalS: number;
  sustainS: number;
  /** Exclusive bounds 0 < x < 1. */
  ramFraction: number;
  /** `WORKER_ENTERPRISE_QUESTIONNAIRE=1`: the scale composite's manual arm. */
  questionnaire: boolean;
  /**
   * `WORKER_GROWTH_TRIGGER_TENANT_SIGNALS`: false (`off`) skips the engine read; the four
   * run-based (tenant-wide) triggers then read `unknown`, while ram_swap is unaffected.
   */
  tenantSignals: boolean;
}

/**
 * Both cadence knobs are bound to each other by the 2 × rule, so a floor refusal names
 * both: an operator lowering one must see the other in the same message (AC 7).
 */
function parseCadenceKnob(spec: {
  name: string;
  raw: string | undefined;
  defaultValue: number;
  floor: number;
  /** Inclusive. `hint` says why, as `floorHint` does for the floor. */
  ceiling: { value: number; hint: string };
  floorHint: string;
}): number {
  const v = (spec.raw ?? "").trim();
  if (!v) return spec.defaultValue;
  const n = Number(v);
  if (!Number.isInteger(n)) {
    throw new Error(
      `${spec.name} must be an integer >= ${spec.floor} and <= ${spec.ceiling.value}, ` +
        `got ${JSON.stringify(v)}`,
    );
  }
  if (n < spec.floor) {
    throw new Error(
      `${spec.name}=${n} is below the floor of ${spec.floor} s (${spec.floorHint})`,
    );
  }
  if (n > spec.ceiling.value) {
    throw new Error(
      `${spec.name}=${n} is above the ceiling of ${spec.ceiling.value} s (${spec.ceiling.hint})`,
    );
  }
  return n;
}

function parseRamFraction(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  if (!v) return GROWTH_TRIGGER_RAM_FRACTION_DEFAULT;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) {
    throw new Error(
      `WORKER_GROWTH_TRIGGER_RAM_FRACTION must be a number with 0 < x < 1, got ${JSON.stringify(v)}`,
    );
  }
  return n;
}

/** `on` (default, also blank) | `off`; anything else is refused. The value is not a secret. */
function parseTenantSignals(raw: string | undefined): boolean {
  const v = (raw ?? "").trim();
  if (v === "" || v === "on") return true;
  if (v === "off") return false;
  throw new Error(
    `WORKER_GROWTH_TRIGGER_TENANT_SIGNALS must be "on" or "off", got ${JSON.stringify(v)}`,
  );
}

function parseWebhookUrl(v: string): string {
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    // The value itself is withheld: it is a credential.
    throw new Error(
      "WORKER_ALERT_WEBHOOK_URL is not a valid URL (value withheld: it may be a secret)",
    );
  }
  // Userinfo (`user:pass@host`) is refused: fetch rejects a URL that carries credentials,
  // so every alert would fail, and it is one more place a secret could be copied from.
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      "WORKER_ALERT_WEBHOOK_URL must not carry credentials in the URL (no user:password@ " +
        "before the host; put the sink's token in the path or query) " +
        "(value withheld: it may be a secret)",
    );
  }
  if (url.protocol === "https:") return v;
  if (url.protocol === "http:" && isLoopbackOrPrivateHost(url.hostname)) {
    return v;
  }
  throw new Error(
    "WORKER_ALERT_WEBHOOK_URL must use https: (http: is allowed only for a loopback literal " +
      "— 127.0.0.0/8, ::1 — or a private IPv4 literal — 10/8, 172.16/12, " +
      "192.168/16) (value withheld: it may be a secret)",
  );
}

/**
 * The plaintext exception: the webhook URL is a credential and the body names the box, so
 * cleartext is acceptable only where it never crosses a network the box does not own.
 * `URL` has already normalised the hostname (lower-cased, IPv6 in brackets, numeric IPv4
 * forms such as `0x7f.1` rewritten to dotted quads), so only canonical forms are matched.
 * Literals only, never a name — not even `localhost`: a name goes through the resolver
 * (`/etc/hosts`, then DNS), so it could send the credential somewhere off the box.
 */
function isLoopbackOrPrivateHost(hostname: string): boolean {
  if (hostname === "[::1]") return true;
  if (isIP(hostname) !== 4) return false;
  const [a = -1, b = -1] = hostname.split(".").map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Null when the feature is off; the validated knobs otherwise. Throws a message naming
 * the knob and its bound on any invalid value.
 */
export function loadGrowthTriggerConfig(
  env: NodeJS.ProcessEnv,
): GrowthTriggerConfig | null {
  const rawUrl = (env.WORKER_ALERT_WEBHOOK_URL ?? "").trim();
  if (!rawUrl) return null;
  const webhookUrl = parseWebhookUrl(rawUrl);

  const intervalS = parseCadenceKnob({
    name: "WORKER_GROWTH_TRIGGER_INTERVAL_S",
    raw: env.WORKER_GROWTH_TRIGGER_INTERVAL_S,
    defaultValue: GROWTH_TRIGGER_INTERVAL_DEFAULT_S,
    floor: GROWTH_TRIGGER_INTERVAL_FLOOR_S,
    ceiling: {
      value: GROWTH_TRIGGER_INTERVAL_CEILING_S,
      hint:
        `WORKER_GROWTH_TRIGGER_SUSTAIN_S must be at least twice the interval and is capped ` +
        `at ${GROWTH_TRIGGER_SUSTAIN_CEILING_S} s, one day (the ${formatHours(GROWTH_REFIRE_MS)} dedupe window)`,
    },
    floorHint:
      "WORKER_GROWTH_TRIGGER_SUSTAIN_S must also be ≥ 2 × the interval",
  });
  const sustainS = parseCadenceKnob({
    name: "WORKER_GROWTH_TRIGGER_SUSTAIN_S",
    raw: env.WORKER_GROWTH_TRIGGER_SUSTAIN_S,
    defaultValue: GROWTH_TRIGGER_SUSTAIN_DEFAULT_S,
    floor: GROWTH_TRIGGER_SUSTAIN_FLOOR_S,
    ceiling: {
      value: GROWTH_TRIGGER_SUSTAIN_CEILING_S,
      hint: `a longer window could not be announced inside the ${formatHours(GROWTH_REFIRE_MS)} dedupe window it serves`,
    },
    floorHint: "it must also be ≥ 2 × WORKER_GROWTH_TRIGGER_INTERVAL_S",
  });
  // A sustained window shorter than two ticks is "sustained" over a single sample: one
  // spike would fire the RAM trigger. Refuse, naming both knobs (AC 7, Q-3).
  if (sustainS < 2 * intervalS) {
    throw new Error(
      `WORKER_GROWTH_TRIGGER_SUSTAIN_S=${sustainS} must be at least 2 × ` +
        `WORKER_GROWTH_TRIGGER_INTERVAL_S=${intervalS} (${2 * intervalS}): a sustained ` +
        `window shorter than two ticks would treat a single sample as sustained.`,
    );
  }

  return {
    webhookUrl,
    intervalS,
    sustainS,
    ramFraction: parseRamFraction(env.WORKER_GROWTH_TRIGGER_RAM_FRACTION),
    questionnaire: env.WORKER_ENTERPRISE_QUESTIONNAIRE === "1",
    tenantSignals: parseTenantSignals(env.WORKER_GROWTH_TRIGGER_TENANT_SIGNALS),
  };
}
