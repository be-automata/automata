import { parsePinnedImage, type PinnedImage } from "./container-image";

/**
 * The worker's cell (OpenSandbox) configuration (#656 PR-E). Three env names,
 * exported by the launcher (`run-worker.sh.template`) and `worker-box.env`:
 *
 * - `WORKER_OPENSANDBOX_URL`: the server's base URL;
 * - `WORKER_OPENSANDBOX_API_KEY_FILE`: a file holding exactly one
 *   `OPENSANDBOX_API_KEY=<hex>` line;
 * - `WORKER_OPENSANDBOX_GUEST_IMAGE`: the cell image, pinned by digest.
 *
 * Pure but for the injected `readFile`. It is read ONLY for a run carrying the
 * cell marker (in `selectRunExecutor`), so a rotated key needs no restart and
 * an unmarked run never opens the key file.
 */

export type CellConfigInvalidReason = "partial" | "key_file" | "url" | "image";

export type CellConfig =
  | { kind: "off" }
  | { kind: "on"; baseUrl: string; apiKey: string; image: PinnedImage }
  | { kind: "invalid"; reason: CellConfigInvalidReason };

export const CELL_ENV_URL = "WORKER_OPENSANDBOX_URL";
export const CELL_ENV_KEY_FILE = "WORKER_OPENSANDBOX_API_KEY_FILE";
export const CELL_ENV_IMAGE = "WORKER_OPENSANDBOX_GUEST_IMAGE";

const KEY_LINE = /^OPENSANDBOX_API_KEY=([0-9a-f]{32,128})\n?$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function parseBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const secure = url.protocol === "https:";
  const loopbackHttp =
    url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (!secure && !loopbackHttp) return null;
  return url.toString().replace(/\/$/, "");
}

/**
 * `off` when none of the three names is set, `invalid` when only some are or a
 * value is wrong, `on` otherwise. The key value and the file content are never
 * put in a result other than `on.apiKey`, and never logged.
 */
export function loadCellConfig(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): CellConfig {
  const rawUrl = env[CELL_ENV_URL];
  const keyFile = env[CELL_ENV_KEY_FILE];
  const rawImage = env[CELL_ENV_IMAGE];
  const set = [rawUrl, keyFile, rawImage].filter(present).length;
  if (set === 0) return { kind: "off" };
  if (set !== 3) return { kind: "invalid", reason: "partial" };

  let fileText: string;
  try {
    fileText = readFile((keyFile as string).trim());
  } catch {
    return { kind: "invalid", reason: "key_file" };
  }
  const match = KEY_LINE.exec(fileText);
  if (!match || match[1] === undefined) {
    return { kind: "invalid", reason: "key_file" };
  }

  const baseUrl = parseBaseUrl(rawUrl as string);
  if (baseUrl === null) return { kind: "invalid", reason: "url" };

  let image: PinnedImage;
  try {
    image = parsePinnedImage(rawImage);
  } catch {
    return { kind: "invalid", reason: "image" };
  }
  return { kind: "on", baseUrl, apiKey: match[1], image };
}

/**
 * The boot line, from the env NAMES' presence only. It never builds a
 * CellConfig and never opens the key file.
 */
export function describeCellEnv(env: NodeJS.ProcessEnv): string {
  const names = [
    [CELL_ENV_URL, "url"],
    [CELL_ENV_KEY_FILE, "key file"],
    [CELL_ENV_IMAGE, "image"],
  ] as const;
  const have = names.filter(([name]) => present(env[name]));
  if (have.length === 0) return "cells: off";
  return `cells: env present (${have.map(([, label]) => label).join(", ")})`;
}
