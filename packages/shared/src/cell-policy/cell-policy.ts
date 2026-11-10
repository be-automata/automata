import { loadPolicy, type LoadedPolicy } from "@open-policy-agent/opa-wasm";

/**
 * The `allow_cell` policy (ADR-014 Decision 2), evaluated in-process from the
 * OPA-compiled WASM next to this file (`cell.wasm`, built from
 * `policy/cell.rego` by packages/shared/scripts/build-cell-policy.sh).
 *
 * Pure: no database, no clock, no I/O. The caller hands in the WASM (bytes in
 * Node, a precompiled `WebAssembly.Module` on Cloudflare Workers, which refuse
 * to compile WASM from bytes at runtime) and a fully server-derived input.
 */

/** The fields the policy requires on every cell (`required_cell_fields`). */
export const CELL_FIELDS = [
  "data_class",
  "repo_visibility",
  "untrusted_content",
  "irreversible",
  "lane",
  "secrets",
  "needs_egress",
] as const;

export type CellField = (typeof CELL_FIELDS)[number];

export type CellFacts = {
  data_class: string;
  repo_visibility: "public" | "private";
  untrusted_content: boolean;
  irreversible: boolean;
  lane: string;
  /** Secret NAMES the run receives, never values. */
  secrets: string[];
  /** Hosts the run must reach. */
  needs_egress: string[];
};

/** The profile record as the policy reads it. */
export type CellPolicyProfile = {
  id: string;
  provider: string;
  tier: "customer_box" | "managed";
  configuration?: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  evidence?: {
    source: string;
    measured_at: string;
    expires_at: string;
  };
  legal?: { status: string; expires_at: string };
};

export type CellPolicyInput = {
  /** RFC 3339, from the server clock. */
  now: string;
  cell: Partial<CellFacts>;
  /** `"server"` for every field the server derived; anything else is self-declared. */
  provenance: Partial<Record<CellField, string>>;
  /** `{}` when no profile matched: the policy denies `unknown_profile`. */
  profile: CellPolicyProfile | Record<string, never>;
};

export type CellDecision = { allowed: boolean; reasons: string[] };

/** The compiled entrypoint (`opa build -t wasm -e cell/decision`). */
export const CELL_POLICY_ENTRYPOINT = "cell/decision";

export {
  CELL_POLICY_WASM_GLOBAL,
  registeredCellPolicyModule,
} from "./cell-policy-global";

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * OPA's WASM target leaves `time.parse_rfc3339_ns` to the host. Strict on the
 * format (a malformed timestamp throws, which the caller turns into a denial);
 * millisecond precision, which a 30-day expiry does not need beyond.
 */
export function parseRfc3339Ns(value: unknown): number {
  if (typeof value !== "string" || !RFC3339.test(value)) {
    throw new Error(`time.parse_rfc3339_ns: not RFC 3339: ${String(value)}`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`time.parse_rfc3339_ns: invalid time: ${value}`);
  }
  return ms * 1e6;
}

export type CellPolicy = {
  evaluate(input: CellPolicyInput): CellDecision;
};

/**
 * Instantiate the policy once; `evaluate` is synchronous and safe to call per
 * request on the same instance (each call resets the WASM heap).
 */
export async function loadCellPolicy(
  wasm: BufferSource | WebAssembly.Module,
): Promise<CellPolicy> {
  const policy: LoadedPolicy = await loadPolicy(wasm, undefined, {
    "time.parse_rfc3339_ns": parseRfc3339Ns,
  });
  return {
    evaluate(input) {
      const resultSet = policy.evaluate(input, CELL_POLICY_ENTRYPOINT) as
        | Array<{ result?: { allow?: unknown; reasons?: unknown } }>
        | undefined;
      const result = resultSet?.[0]?.result;
      // An undefined decision is a denial: the policy is deny by default and
      // so is its host.
      if (
        !result ||
        typeof result.allow !== "boolean" ||
        !Array.isArray(result.reasons)
      ) {
        return { allowed: false, reasons: ["no_decision"] };
      }
      return {
        allowed: result.allow,
        reasons: result.reasons.map((r) => String(r)),
      };
    },
  };
}
