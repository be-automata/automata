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

export const GROWTH_TRIGGER_INTERVAL_DEFAULT_S = 300;
const GROWTH_TRIGGER_INTERVAL_FLOOR_S = 30;
/** One day: a slower tick could not hold the 24 h dedupe window it serves. */
export const GROWTH_TRIGGER_INTERVAL_CEILING_S = 86_400;
export const GROWTH_TRIGGER_SUSTAIN_DEFAULT_S = 900;
const GROWTH_TRIGGER_SUSTAIN_FLOOR_S = 60;
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
  /** Inclusive; absent = unbounded. */
  ceiling?: number;
  floorHint: string;
}): number {
  const v = (spec.raw ?? "").trim();
  if (!v) return spec.defaultValue;
  const n = Number(v);
  if (!Number.isInteger(n)) {
    throw new Error(
      `${spec.name} must be an integer >= ${spec.floor}, got ${JSON.stringify(v)}`,
    );
  }
  if (n < spec.floor) {
    throw new Error(
      `${spec.name}=${n} is below the floor of ${spec.floor} s (${spec.floorHint})`,
    );
  }
  if (spec.ceiling !== undefined && n > spec.ceiling) {
    throw new Error(
      `${spec.name}=${n} is above the ceiling of ${spec.ceiling} s (one day)`,
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
  if (url.protocol === "https:") return v;
  if (url.protocol === "http:" && isLoopbackOrPrivateHost(url.hostname)) {
    return v;
  }
  throw new Error(
    "WORKER_ALERT_WEBHOOK_URL must use https: (http: is allowed only for a loopback host " +
      "— localhost, 127.0.0.0/8, ::1 — or a private IPv4 literal — 10/8, 172.16/12, " +
      "192.168/16) (value withheld: it may be a secret)",
  );
}

/** Dotted-quad IPv4 literal → its four octets, or null. */
function ipv4Octets(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  return [a, b, c, d];
}

/**
 * The plaintext exception: the webhook URL is a credential and the body names the box, so
 * cleartext is acceptable only where it never crosses a network the box does not own.
 * `URL` has already normalised the hostname (lower-cased, IPv6 in brackets, numeric IPv4
 * forms such as `0x7f.1` rewritten to dotted quads), so only canonical forms are matched.
 */
function isLoopbackOrPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const ip = ipv4Octets(hostname);
  if (ip === null) return false;
  const [a, b] = ip;
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
    ceiling: GROWTH_TRIGGER_INTERVAL_CEILING_S,
    floorHint:
      "WORKER_GROWTH_TRIGGER_SUSTAIN_S must also be ≥ 2 × the interval",
  });
  const sustainS = parseCadenceKnob({
    name: "WORKER_GROWTH_TRIGGER_SUSTAIN_S",
    raw: env.WORKER_GROWTH_TRIGGER_SUSTAIN_S,
    defaultValue: GROWTH_TRIGGER_SUSTAIN_DEFAULT_S,
    floor: GROWTH_TRIGGER_SUSTAIN_FLOOR_S,
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
  };
}
