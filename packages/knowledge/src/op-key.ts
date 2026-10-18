// Op keys identify one proposed change to one claim, produced by one source revision.
// Shape: `${op}:${page}/${claimId}@${rev}` where rev is the first 12 hex chars of the source
// commit, or "working" when the change was not derived from a commit. Page and source revision
// are part of the key so that an approval recorded for one merge or one page can never be
// replayed against another.

export interface OpKeyParts {
  op: string;
  page: string;
  claimId: string;
  sourceRev: string;
}

export const WORKING_REV = "working";
const REV_LENGTH = 12;
const OP_SRC = "[a-z][a-z-]*";
// Characters that delimit the key (`:` `/` `@`), separate trailer values (`,`) or would make the
// key ambiguous when written into a commit trailer (whitespace) are never allowed inside a part.
const PART_SRC = "[^:/@,\\s]+";
const OP = new RegExp(`^${OP_SRC}$`);
const PART = new RegExp(`^${PART_SRC}$`);
const KEY = new RegExp(
  `^(${OP_SRC}):(${PART_SRC})\\/(${PART_SRC})@([0-9a-f]{${REV_LENGTH}}|${WORKING_REV})$`,
);

export class InvalidOpKeyPartError extends Error {
  readonly part: string;
  readonly value: string;
  constructor(part: string, value: string) {
    super(`invalid op key ${part}: ${JSON.stringify(value)}`);
    this.name = "InvalidOpKeyPartError";
    this.part = part;
    this.value = value;
  }
}

function normalizeRev(sourceRev: string | undefined): string {
  if (sourceRev === undefined || sourceRev === WORKING_REV) return WORKING_REV;
  const rev = sourceRev.toLowerCase();
  if (!/^[0-9a-f]+$/.test(rev) || rev.length < REV_LENGTH) {
    throw new InvalidOpKeyPartError("sourceRev", sourceRev);
  }
  return rev.slice(0, REV_LENGTH);
}

export function opKey(
  op: string,
  page: string,
  claimId: string,
  sourceRev?: string,
): string {
  if (!OP.test(op)) throw new InvalidOpKeyPartError("op", op);
  if (!PART.test(page)) throw new InvalidOpKeyPartError("page", page);
  if (!PART.test(claimId)) throw new InvalidOpKeyPartError("claimId", claimId);
  return `${op}:${page}/${claimId}@${normalizeRev(sourceRev)}`;
}

/** Inverse of opKey. Returns null for anything that is not an op key (e.g. `seed:<page>`). */
export function parseOpKey(key: string): OpKeyParts | null {
  const m = KEY.exec(key);
  if (!m) return null;
  // Every group in KEY is required, so a successful match always fills all four.
  const [, op, page, claimId, sourceRev] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  return { op, page, claimId, sourceRev };
}

/**
 * True when an op key's revision belongs to the given full source commit. This is the provenance gate's
 * rule: an approval only covers a change derived from the commit named in the push's Source-Commit.
 */
export function opKeyMatchesCommit(
  parts: OpKeyParts,
  sourceCommit: string,
): boolean {
  return (
    parts.sourceRev !== WORKING_REV &&
    sourceCommit.toLowerCase().startsWith(parts.sourceRev)
  );
}
