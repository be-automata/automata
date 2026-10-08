/**
 * Advisory hints for environment variable keys the platform itself reads —
 * shown next to a variable in the editor. Pure (client and server). Hints
 * never change behavior: the tracker parser accepts only the canonical key,
 * so a misspelled key is surfaced here instead of being silently honored.
 */

export type EnvKeyScope = "global" | "organization" | "repository";

export type EnvKeyHintLevel = "info" | "warning";

export interface EnvKeyHint {
  /** The variable the hint is attached to; null for a whole-list hint. */
  key: string | null;
  level: EnvKeyHintLevel;
  message: string;
}

/** Keys the platform reads, with what they do. */
export const KNOWN_ENV_KEYS: Readonly<Record<string, string>> = {
  YOUTRACK_URL: "YouTrack instance URL used by the post-merge ticket audit.",
  YOUTRACK_TOKEN:
    "YouTrack token for the post-merge ticket audit. Control-plane only: never delivered to an agent.",
  YOUTRACK_PROJECTS:
    "Comma-separated YouTrack project short names the audit matches (e.g. ACME).",
  AUTOMATA_TRACKER_WRITES:
    "Set to `live` to let the audit write to the tracker; anything else is shadow mode (reads and a PR comment only).",
  YOUTRACK_AGENT_TOKEN:
    "YouTrack token delivered to agents of prompt-defined automations.",
};

/** Common misspellings → the key the platform actually reads. */
export const ENV_KEY_ALIASES: Readonly<Record<string, string>> = {
  AUTOMATA_PROJECTS: "YOUTRACK_PROJECTS",
  YOUTRACK_PROJECT: "YOUTRACK_PROJECTS",
  YOUTRACK_TRACKER_WRITES: "AUTOMATA_TRACKER_WRITES",
  TRACKER_WRITES: "AUTOMATA_TRACKER_WRITES",
  YOUTRACK_BASE_URL: "YOUTRACK_URL",
  YOUTRACK_HOST: "YOUTRACK_URL",
  YOUTRACK_API_TOKEN: "YOUTRACK_TOKEN",
};

const TRACKER_KEYS = [
  "YOUTRACK_URL",
  "YOUTRACK_TOKEN",
  "YOUTRACK_PROJECTS",
  "AUTOMATA_TRACKER_WRITES",
];

export function getEnvKeyHints(
  variables: ReadonlyArray<{ key: string; value?: string }>,
  scope: EnvKeyScope,
): EnvKeyHint[] {
  const hints: EnvKeyHint[] = [];
  const keys = new Set(variables.map((variable) => variable.key.trim()));

  for (const key of keys) {
    const canonical = ENV_KEY_ALIASES[key];
    if (canonical) {
      hints.push({
        key,
        level: "warning",
        message: `${key} is not read by the platform. Did you mean ${canonical}?`,
      });
    }
  }

  if (scope === "global") {
    const trackerKeys = TRACKER_KEYS.filter((key) => keys.has(key));
    if (trackerKeys.length > 0) {
      hints.push({
        key: null,
        level: "warning",
        message: `${trackerKeys.join(", ")} ${trackerKeys.length === 1 ? "is" : "are"} not read by the post-merge audit from personal Global variables. Set tracker variables on the Organization environment (or a repository environment).`,
      });
    }
    return hints;
  }

  const hasUrl = keys.has("YOUTRACK_URL");
  const hasToken = keys.has("YOUTRACK_TOKEN");
  if (scope === "organization" && hasUrl !== hasToken) {
    hints.push({
      key: hasUrl ? "YOUTRACK_URL" : "YOUTRACK_TOKEN",
      level: "warning",
      message: `The tracker needs both YOUTRACK_URL and YOUTRACK_TOKEN; ${hasUrl ? "YOUTRACK_TOKEN" : "YOUTRACK_URL"} is missing here.`,
    });
  }

  const writes = variables.find(
    (variable) => variable.key.trim() === "AUTOMATA_TRACKER_WRITES",
  );
  if (writes?.value !== undefined && writes.value.trim() !== "live") {
    hints.push({
      key: "AUTOMATA_TRACKER_WRITES",
      level: "info",
      message:
        "Only `live` enables tracker writes; any other value runs the audit in shadow mode.",
    });
  }
  return hints;
}
