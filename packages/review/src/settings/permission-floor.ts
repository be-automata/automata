/**
 * The permission-mode floor (ADR-005 §2/§3/§3a/§3b) — a tighten-only cap over
 * the `review ⊏ plan ⊏ allowAll` lattice, composed with a PR-family DEFAULT
 * that is NOT the same value as the cap (ADR-005 §2's correction: an earlier
 * draft wrote `effective = min(derivedDefault, configured)` with PR
 * `derivedDefault = review`, which is a bug — `review` is the least-privilege
 * element, so the meet could never yield `plan`/`allowAll`, making the
 * trusted-internal write case mathematically impossible).
 *
 * Two distinct things:
 *   - `cap(ctx)` — the maximum privilege a scope permits (a monotone ceiling,
 *     composed across scopes by {@link tightenPermissionMode} = min-privilege).
 *   - `defaultPermissionMode(ctx)` — the value used when the automation sets no
 *     mode at all (PR-family → "review"; non-PR → "allowAll").
 *
 * `effective = tighten(configured ?? default, cap_eff)`. Worked cases (ADR-005
 * §2, reproduced verbatim by the test suite):
 *   - trusted-internal PR configured "allowAll" -> min(allowAll, cap=allowAll) = allowAll
 *   - trusted-internal PR unconfigured          -> min(review, allowAll) = review (default holds)
 *   - untrusted PR configured "allowAll"        -> min(allowAll, cap=review) = review (pinned)
 */

import {
  trustRank,
  isTrustedAuthorThreshold,
  type TrustedAuthorThreshold,
} from "./posture-lattice";

export type { TrustedAuthorThreshold };

/**
 * Permission modes, ordered strictest-first (index = privilege rank). `review`
 * is the emit-only, credential-free lane (ADR-004); `allowAll` is full write.
 */
export const PERMISSION_ORDER = ["review", "plan", "allowAll"] as const;

export type PermissionMode = (typeof PERMISSION_ORDER)[number];

/** Membership guard over the permission-mode vocabulary (untrusted config/DB text). */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    (PERMISSION_ORDER as readonly string[]).includes(value)
  );
}

/** Rank of a permission mode (lower = stricter / less privileged). */
export function privilege(mode: PermissionMode): number {
  const idx = PERMISSION_ORDER.indexOf(mode);
  return idx < 0 ? 0 : idx;
}

/**
 * The monotone meet over the permission lattice — argmin by {@link privilege}
 * (the stricter of the two, i.e. the LOWER privilege). Ties keep `a`
 * (idempotent). This is the SAME shape as `tightenSeverityPolicy` in
 * `./posture-lattice` (lower rank = stricter), unlike the inverted trust-rank
 * meet documented there.
 */
export function tightenPermissionMode(
  a: PermissionMode,
  b: PermissionMode,
): PermissionMode {
  return privilege(a) <= privilege(b) ? a : b;
}

/**
 * Server-derived context a single permission-mode resolution needs. `trust`
 * is `null` for a non-PR-family event, or when a PR-family event has NO
 * derivable trust snapshot (manual/retry dispatch with a failed lookup) — the
 * latter case MUST fail closed (ADR-005 §3a), never default to trusted.
 */
export interface PermissionContext {
  isPrFamily: boolean;
  trust: { isFork: boolean; authorAssociation: string } | null;
  trustedAuthorThreshold: TrustedAuthorThreshold;
}

/**
 * The value used when the automation configures no `permissionMode` at all
 * (ADR-005 §2). PR-family -> "review" (the emit-only default, ADR-004 §2);
 * non-PR -> "allowAll" (today's unconditional default, reproduced bit-for-bit
 * per ADR-005's AC4 regression invariant).
 */
export function defaultPermissionMode(ctx: PermissionContext): PermissionMode {
  return ctx.isPrFamily ? "review" : "allowAll";
}

/**
 * The maximum privilege a single context permits (ADR-005 §3). Non-PR events
 * are uncapped ("allowAll" — today's behavior, reproduced exactly). A
 * PR-family event is capped at "review" (the confused-deputy fence, ADR-004)
 * UNLESS the content is trust-verified: `trust !== null`, NOT a fork, and the
 * author's rank is at/above the resolved threshold `T_eff`. Missing trust
 * (`trust === null`) fails closed to "review" — it is never treated as
 * trusted, regardless of how the automation is configured.
 */
export function capPermissionMode(ctx: PermissionContext): PermissionMode {
  if (!ctx.isPrFamily) return "allowAll";
  if (ctx.trust === null) return "review";
  if (ctx.trust.isFork) return "review";
  if (!isTrustedAuthorThreshold(ctx.trustedAuthorThreshold)) return "review";
  if (!isTrustedAuthorThreshold(ctx.trust.authorAssociation)) return "review";
  const authorRank = trustRank(ctx.trust.authorAssociation);
  const thresholdRank = trustRank(ctx.trustedAuthorThreshold);
  return authorRank >= thresholdRank ? "allowAll" : "review";
}

/**
 * Resolve the effective permission mode for a single dispatch (ADR-005 §2/§5)
 * — the ONE seam both `remote-daemon-message.ts` and `startAgentMessage.ts`
 * must call (ADR-005 §3b: enforcing the cap in only one lets the other
 * bypass it).
 *
 * `scopeCaps` reserves the parameter for future org/repo permission caps
 * (mirroring the severity/trust axes' org/repo composition) — this ticket
 * (#82) adds NO cap columns, so every call site passes `[]` today. When
 * populated, `cap_eff = tighten(cap(ctx), ...scopeCaps)` — min-privilege
 * across every scope, a lower scope can only lower the cap, never raise it.
 */
export function resolvePermissionMode(
  configured: PermissionMode | null | undefined,
  ctx: PermissionContext,
  scopeCaps: readonly PermissionMode[] = [],
): PermissionMode {
  const capEff = scopeCaps.reduce(
    (acc, cap) => tightenPermissionMode(acc, cap),
    capPermissionMode(ctx),
  );
  const requested = configured ?? defaultPermissionMode(ctx);
  return tightenPermissionMode(requested, capEff);
}
