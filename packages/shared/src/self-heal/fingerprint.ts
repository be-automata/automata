import { createHash } from "node:crypto";

const MAX_SUBJECT_LENGTH = 300;
/** Optional discriminator for several findings of one rule on one subject. */
export const FINDING_KEY_RE = /^[a-z0-9._:/@-]{1,40}$/;

export interface FingerprintInput {
  repoFullName: string;
  audit: string;
  section: string;
  rule: string;
  subject: string;
  key?: string | undefined;
}

/**
 * Stable identity of a finding. Title, plan, severity, line numbers and
 * ordering are deliberately absent: the agent rewrites them every run.
 */
export function fingerprintFinding(input: FingerprintInput): string {
  const canonical = JSON.stringify([
    input.repoFullName.toLowerCase(),
    input.audit,
    input.section,
    input.rule,
    input.subject,
    input.key ?? "",
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Canonical subject, or null when it is not an acceptable repo-relative path
 * (path kind) or package name (npm kind).
 */
export function normalizeSubject(
  raw: string,
  subjectKind: "path" | "npm",
): string | null {
  const trimmed = stripMarkdownNoise(raw);
  if (trimmed === "" || trimmed.length > MAX_SUBJECT_LENGTH) return null;
  return subjectKind === "npm"
    ? normalizeNpmSubject(trimmed)
    : normalizePathSubject(trimmed);
}

/**
 * The agent sometimes wraps a subject in Markdown code spans or quotes, e.g.
 * npm:`@grpc/grpc-js`. Strip that decoration so the identity (and the
 * downstream package-name check) never depends on formatting. Clean input is
 * returned unchanged, so existing fingerprints do not move.
 */
function stripMarkdownNoise(raw: string): string {
  let value = raw.replace(/`/g, "").replace(/\s+/g, " ").trim();
  const unwrap = (input: string): string => {
    let out = input;
    while (
      out.length >= 2 &&
      (out[0] === '"' || out[0] === "'") &&
      out[out.length - 1] === out[0]
    ) {
      out = out.slice(1, -1).trim();
    }
    return out;
  };
  value = unwrap(value);
  if (/^npm:/i.test(value)) {
    value = `${value.slice(0, 4)}${unwrap(value.slice(4).trim())}`;
  }
  return value;
}

function normalizePathSubject(value: string): string | null {
  // Shell substitution and control characters never belong in a repo path.
  if (/\$[({]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return null;
  let path = value.replace(/\\/g, "/");
  path = path.replace(/#L\d+(?:-L?\d+)?$/i, "");
  path = path.replace(/:\d+(?::\d+)?$/, "");
  path = path.replace(/\/{2,}/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  if (path === "" || path.startsWith("/") || /^[a-zA-Z]:\//.test(path)) {
    return null;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  if (segments[0] === ".git") return null;
  return path;
}

function normalizeNpmSubject(value: string): string | null {
  let name = value.toLowerCase();
  if (name.startsWith("npm:")) name = name.slice(4);
  // A version separator is an "@" after the first character (scopes lead with one).
  const at = name.indexOf("@", 1);
  if (at > 0) name = name.slice(0, at);
  if (!/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/.test(name)) return null;
  return `npm:${name}`;
}
