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
export const GROWTH_TRIGGER_INTERVAL_FLOOR_S = 30;
export const GROWTH_TRIGGER_SUSTAIN_DEFAULT_S = 900;
export const GROWTH_TRIGGER_SUSTAIN_FLOOR_S = 60;
export const GROWTH_TRIGGER_RAM_FRACTION_DEFAULT = 0.7;

export interface GrowthTriggerConfig {
  /** Never log this. */
  webhookUrl: string;
  intervalS: number;
  sustainS: number;
  /** Exclusive bounds 0 < x < 1. */
  ramFraction: number;
  /** `WORKER_ENTERPRISE_QUESTIONNAIRE=1`: the scale composite's manual arm. */
  questionnaire: boolean;
}

function parseIntegerKnob(
  name: string,
  raw: string | undefined,
  defaultValue: number,
  floor: number,
): number {
  const v = (raw ?? "").trim();
  if (!v) return defaultValue;
  const n = Number(v);
  if (!Number.isInteger(n) || n < floor) {
    throw new Error(
      `${name} must be an integer >= ${floor}, got ${JSON.stringify(v)}`,
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
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "WORKER_ALERT_WEBHOOK_URL must use http: or https: (value withheld: it may be a secret)",
    );
  }
  return v;
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

  const intervalS = parseIntegerKnob(
    "WORKER_GROWTH_TRIGGER_INTERVAL_S",
    env.WORKER_GROWTH_TRIGGER_INTERVAL_S,
    GROWTH_TRIGGER_INTERVAL_DEFAULT_S,
    GROWTH_TRIGGER_INTERVAL_FLOOR_S,
  );
  const sustainS = parseIntegerKnob(
    "WORKER_GROWTH_TRIGGER_SUSTAIN_S",
    env.WORKER_GROWTH_TRIGGER_SUSTAIN_S,
    GROWTH_TRIGGER_SUSTAIN_DEFAULT_S,
    GROWTH_TRIGGER_SUSTAIN_FLOOR_S,
  );
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
