import { canonicalizeEgressEntries } from "@terragon/shared/model/egress-policy";
import {
  classifyEgressEntries,
  type EgressEntryError,
} from "@terragon/shared/model/egress-entries";
import type { EgressLevel } from "@terragon/types/egress";

/** The three stored egress fields of one repo; the unit a change is computed on. */
export interface EgressFields {
  level: EgressLevel | null;
  /** Canonical: trimmed, lowercased, deduped, order-stable. */
  allowlist: string[];
  registries: boolean | null;
}

/** The request fields of `egress.update` that change `EgressFields`. */
export interface EgressPatch {
  level?: EgressLevel | null;
  allowlist?: string[];
  add?: string[];
  remove?: string[];
  registries?: boolean;
}

export type EgressChangeResult =
  | { ok: true; after: EgressFields; changed: boolean }
  | { ok: false; errors: EgressEntryError[] };

function invalid(message: string): EgressEntryError {
  return { code: "invalid_input", message, entry: null, index: null };
}

function canonicalHosts(hosts: string[] | undefined): string[] {
  return canonicalizeEgressEntries(hosts ?? []);
}

function shapeErrors(
  patch: EgressPatch,
  add: readonly string[],
  remove: readonly string[],
): EgressEntryError[] {
  const errors: EgressEntryError[] = [];
  const has = (v: unknown) => v !== undefined;
  const sent = [patch.level, patch.allowlist, patch.add, patch.remove];
  if (![...sent, patch.registries].some(has)) {
    errors.push(
      invalid(
        "send at least one of level, allowlist, add, remove or registries",
      ),
    );
  }
  if (has(patch.allowlist) && (has(patch.add) || has(patch.remove))) {
    errors.push(invalid("allowlist is exclusive with add and remove"));
  }
  const removing = new Set(remove);
  if (add.some((host) => removing.has(host))) {
    errors.push(invalid("a host cannot be in both add and remove"));
  }
  return errors;
}

/** The request-shape rules the schema cannot express (spec 4.2, "Update rules"); pure, so a caller can refuse before spending anything. */
export function patchShapeErrors(patch: EgressPatch): EgressEntryError[] {
  return shapeErrors(
    patch,
    canonicalHosts(patch.add),
    canonicalHosts(patch.remove),
  );
}

/** The allowlist after the patch: `allowlist` replaces, `add` appends the missing, `remove` drops the present. */
function patchedAllowlist(
  stored: readonly string[],
  patch: EgressPatch,
  add: readonly string[],
  remove: readonly string[],
): string[] {
  if (patch.allowlist !== undefined) {
    return canonicalizeEgressEntries(patch.allowlist);
  }
  const removing = new Set(remove);
  return canonicalizeEgressEntries([...stored, ...add]).filter(
    (host) => !removing.has(host),
  );
}

function sameFields(a: EgressFields, b: EgressFields): boolean {
  return (
    a.level === b.level &&
    a.registries === b.registries &&
    a.allowlist.length === b.allowlist.length &&
    a.allowlist.every((host, index) => host === b.allowlist[index])
  );
}

/**
 * Apply the patch to the stored fields and classify the RESULT (not only the
 * hosts sent), so a legacy-stored wildcard blocks a later `add` until it is
 * removed (OD-2 on the whole result). Every refusal is returned at once.
 * `changed` is false when the result equals what is stored. `brokerHost` is
 * resolved once per request by the caller (undefined: the placeholder applies).
 */
export function computeEgressChange(
  stored: EgressFields,
  patch: EgressPatch,
  brokerHost: string | undefined,
): EgressChangeResult {
  const add = canonicalHosts(patch.add);
  const remove = canonicalHosts(patch.remove);
  const shape = shapeErrors(patch, add, remove);
  if (shape.length > 0) return { ok: false, errors: shape };
  const after: EgressFields = {
    level: patch.level !== undefined ? patch.level : stored.level,
    allowlist: patchedAllowlist(stored.allowlist, patch, add, remove),
    registries: patch.registries ?? stored.registries,
  };
  const { errors } = classifyEgressEntries({
    level: after.level,
    entries: after.allowlist,
    registries: after.registries,
    brokerHost,
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, after, changed: !sameFields(stored, after) };
}
