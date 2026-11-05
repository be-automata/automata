import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseUri } from "./claims";
import {
  parseFailResponse,
  parsePublishResponse,
  parseReconcileContextResponse,
  RECONCILE_ALL_ERROR_CODES,
  RECONCILE_WORKER_ERROR_CODES,
  classifyClaimEvidence,
  repoPinTarget,
  repoRelativePath,
  TICKET_SNAPSHOT_FIELDS,
  TICKET_SOURCE_CODES,
  TICKET_KEY,
  ticketPinTarget,
} from "./reconcile-wire";
import { LIMITS_SEED, SEED } from "./test-fixtures";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHA = "a".repeat(40);

const ready = () => ({
  status: "ready",
  intent: {
    id: "i1",
    organizationId: "o1",
    repoFullName: "acme/widgets",
    defaultBranch: "main",
    targetSha: SHA,
  },
  cursor: { lastSha: null },
  installationToken: "tok",
  sidecars: [
    {
      page: "docs/a.md",
      claims: [
        {
          id: "c1",
          statement: "s",
          version: 2,
          evidence: [
            { uri: "repo://src/x.ts#L1-L2", hash: "0123456789abcdef" },
          ],
        },
      ],
    },
  ],
  rejected: [
    {
      opId: "op1",
      claimId: "c1",
      op: "update",
      evidenceFingerprint: "fp",
      locatedEvidence: ["repo://src/x.ts#L1-L2"],
    },
  ],
  purgedOrganizationIds: ["o9"],
  excludedClaims: 0,
  tickets: [] as unknown[],
  unavailableClaims: [] as unknown[],
});

describe("parseReconcileContextResponse", () => {
  it("accepts a well-formed ready response", () => {
    const parsed = parseReconcileContextResponse(ready());
    expect(parsed).toEqual(ready());
  });

  it("accepts a lastSha cursor", () => {
    const r = { ...ready(), cursor: { lastSha: "b".repeat(40) } };
    expect(parseReconcileContextResponse(r)).toEqual(r);
  });

  it.each(["gated", "done", "not_found", "no_access"])(
    "accepts %s without intent fields",
    (status) => {
      expect(
        parseReconcileContextResponse({
          status,
          purgedOrganizationIds: ["o1"],
        }),
      ).toEqual({ status, purgedOrganizationIds: ["o1"] });
    },
  );

  it("rejects malformed bodies", () => {
    const bad: unknown[] = [
      null,
      "x",
      [],
      { ...ready(), status: "weird" },
      { ...ready(), installationToken: 5 },
      { ...ready(), intent: { ...ready().intent, targetSha: "XYZ" } },
      { ...ready(), intent: { ...ready().intent, targetSha: "A".repeat(40) } },
      { ...ready(), excludedClaims: -1 },
      { ...ready(), excludedClaims: 1.5 },
      { ...ready(), cursor: { lastSha: "nope" } },
      { ...ready(), sidecars: "x" },
      { ...ready(), rejected: [{ opId: "x" }] },
      { status: "ready" },
      { status: "done" },
    ];
    for (const b of bad) expect(parseReconcileContextResponse(b)).toBeNull();
    const { cursor: _cursor, ...noCursor } = ready();
    expect(parseReconcileContextResponse(noCursor)).toBeNull();
  });

  it("drops unknown keys (PD-22)", () => {
    const r = ready();
    const parsed = parseReconcileContextResponse({
      ...r,
      futureField: 1,
      intent: { ...r.intent, extra: true },
    });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed ?? {}).sort()).toEqual(Object.keys(r).sort());
    const intent = (parsed as { intent: object }).intent;
    expect(Object.keys(intent).sort()).toEqual(Object.keys(r.intent).sort());
  });
});

describe("parsePublishResponse", () => {
  it.each([
    "published",
    "already_published",
    "gated",
    "cursor_moved",
    "not_processing",
    "stale_claim",
  ])("accepts %s", (result) => {
    expect(parsePublishResponse({ result, opsInserted: 3 })).toEqual({
      result,
      opsInserted: 3,
    });
  });

  it("rejects unknown results and bad counts, drops unknown keys", () => {
    expect(parsePublishResponse({ result: "nope", opsInserted: 0 })).toBeNull();
    expect(
      parsePublishResponse({ result: "published", opsInserted: -1 }),
    ).toBeNull();
    expect(parsePublishResponse([])).toBeNull();
    const parsed = parsePublishResponse({
      result: "published",
      opsInserted: 0,
      more: 1,
    });
    expect(Object.keys(parsed ?? {}).sort()).toEqual(["opsInserted", "result"]);
  });
});

describe("parseFailResponse", () => {
  it("accepts every known code and rejects unknown ones", () => {
    for (const code of RECONCILE_ALL_ERROR_CODES) {
      expect(parseFailResponse({ state: "failed", attempts: 2, code })).toEqual(
        {
          state: "failed",
          attempts: 2,
          code,
        },
      );
    }
    expect(
      parseFailResponse({ state: "pending", attempts: 1, code: "boom" }),
    ).toBeNull();
    expect(
      parseFailResponse({ state: "x", attempts: 1, code: "worker_error" }),
    ).toBeNull();
    expect(
      parseFailResponse({
        state: "failed",
        attempts: 1.2,
        code: "worker_error",
      }),
    ).toBeNull();
    expect(parseFailResponse(null)).toBeNull();
    const parsed = parseFailResponse({
      state: "pending",
      attempts: 0,
      code: "worker_error",
      z: 1,
    });
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      "attempts",
      "code",
      "state",
    ]);
  });

  it("keeps the worker list a strict subset of all codes", () => {
    expect([...RECONCILE_WORKER_ERROR_CODES]).toEqual([
      "repo_access_lost",
      "non_descendant_unrecoverable",
      "disk_low",
      "mirror_over_cap",
      "mirror_corrupt",
      "fetch_failed",
      "snapshot_failed",
      "engine_failed",
      "control_plane_rejected",
      "worker_error",
    ]);
    expect(
      RECONCILE_ALL_ERROR_CODES.slice(RECONCILE_WORKER_ERROR_CODES.length),
    ).toEqual(["lease_expired", "dispatch_failed", "max_attempts"]);
  });
});

describe("repoRelativePath", () => {
  it("normalizes a clean path", () => {
    expect(repoRelativePath("docs/a.md")).toBe("docs/a.md");
    expect(repoRelativePath("./docs/a.md")).toBe("docs/a.md");
  });

  it.each([
    "docs//a.md",
    "/etc/passwd",
    "../x",
    "a/../b",
    "a\\b",
    "a\u0000b",
    "a\u0001b",
    "a\u007fb",
    "C:/x",
    "repo://a.md",
    "",
    "./",
    ".git/config",
    "a/.GIT/x",
    "a/./b",
    "a/",
    "x".repeat(1025),
  ])("rejects %j", (p) => {
    expect(repoRelativePath(p)).toBeNull();
  });

  it("measures the limit in bytes", () => {
    expect(repoRelativePath("é".repeat(512))).not.toBeNull();
    expect(repoRelativePath("é".repeat(513))).toBeNull();
  });
});

describe("repoPinTarget", () => {
  it("extracts the target of a repo pin", () => {
    expect(repoPinTarget("repo://src/x.ts#L1-L2")).toBe("src/x.ts");
  });

  it.each([
    "doc://pricing#trial",
    "ticket://T-1#/a",
    "repo://../x#L1-L1",
    "repo://x",
    "nonsense",
  ])("returns null for %s", (u) => {
    expect(repoPinTarget(u)).toBeNull();
  });

  it("agrees with parseUri on every fixture evidence URI", () => {
    const uris = [...SEED, ...LIMITS_SEED].flatMap((c) => c.evidence);
    expect(uris.length).toBeGreaterThan(5);
    for (const u of uris) {
      const { scheme, target } = parseUri(u);
      const expected = scheme === "repo" ? repoRelativePath(target) : null;
      expect(repoPinTarget(u)).toBe(expected);
    }
  });
});

describe("ticketPinTarget", () => {
  it("parses key, pointer and decoded first field", () => {
    expect(ticketPinTarget("ticket://SUP-12#/description")).toEqual({
      key: "SUP-12",
      pointer: "/description",
      field: "description",
    });
    expect(ticketPinTarget("ticket://SUP-12#/comments/0/text")?.field).toBe(
      "comments",
    );
    expect(ticketPinTarget("ticket://SUP-12#/a~1b/c")?.field).toBe("a/b");
  });
  it.each([
    "ticket://sup-12#/x",
    "ticket://SUP-12",
    "ticket://../x#/a",
    "repo://a#L1-L1",
    "ticket://SUP-12#summary",
    "ticket://SUP-12#/a\u0000b",
  ])("returns null for %s", (u) => {
    expect(ticketPinTarget(u)).toBeNull();
  });
  it("agrees with parseUri on the ticket fixtures", () => {
    const uris = [...SEED, ...LIMITS_SEED]
      .flatMap((c) => c.evidence)
      .filter((u) => u.startsWith("ticket://"));
    for (const u of uris) {
      const { scheme, target, anchor } = parseUri(u);
      expect(scheme).toBe("ticket");
      const pin = ticketPinTarget(u);
      if (pin) {
        expect(pin.key).toBe(target);
        expect(pin.pointer).toBe(anchor);
      }
    }
  });
  it("uses the tracker's issue-key shape", () => {
    const src = readFileSync(
      join(HERE, "../../../apps/www/src/server-lib/tracker/tracker-types.ts"),
      "utf8",
    );
    const m = /ISSUE_KEY_SOURCE = "([^"]+)"/.exec(src);
    expect(m).not.toBeNull();
    const tracker = (m?.[1] ?? "").replace(/\\\\d/g, "[0-9]");
    expect(TICKET_KEY.source).toBe(`^${tracker}$`);
  });
});

describe("classifyClaimEvidence", () => {
  it("admits repo plus ticket pins and returns the ticket pins", () => {
    expect(
      classifyClaimEvidence({
        page: "docs/a.md",
        uris: ["repo://src/x.ts#L1-L2", "ticket://SUP-12#/summary"],
      }),
    ).toEqual({
      kind: "admitted",
      ticketPins: [{ key: "SUP-12", pointer: "/summary", field: "summary" }],
    });
  });
  it("excludes a doc pin, and doc wins over an invalid page", () => {
    const uris = ["doc://pricing#trial"];
    expect(classifyClaimEvidence({ page: "docs/a.md", uris })).toEqual({
      kind: "excluded",
      reason: "doc_source",
    });
    expect(classifyClaimEvidence({ page: "../x.md", uris })).toEqual({
      kind: "excluded",
      reason: "doc_source",
    });
  });
  it("excludes a bad page, an unparsable URI and an unknown scheme as invalid", () => {
    for (const input of [
      { page: "../x.md", uris: ["repo://src/x.ts#L1-L2"] },
      { page: "a.md", uris: ["nonsense"] },
      { page: "a.md", uris: ["repo://../x#L1-L1"] },
      { page: "a.md", uris: ["ticket://bad#/x"] },
      { page: "a.md", uris: ["slack://x#y"] },
    ]) {
      expect(classifyClaimEvidence(input)).toEqual({
        kind: "excluded",
        reason: "invalid_path",
      });
    }
  });
  it("admits an unsupported ticket field (the fetcher decides)", () => {
    const r = classifyClaimEvidence({
      page: "a.md",
      uris: ["ticket://SUP-1#/resolution"],
    });
    expect(r).toEqual({
      kind: "admitted",
      ticketPins: [
        { key: "SUP-1", pointer: "/resolution", field: "resolution" },
      ],
    });
  });
});

describe("ticket wire fields", () => {
  it("pins the closed tuples", () => {
    expect([...TICKET_SNAPSHOT_FIELDS]).toEqual([
      "key",
      "summary",
      "stage",
      "resolved",
      "description",
      "links",
      "comments",
    ]);
    expect([...TICKET_SOURCE_CODES]).toEqual([
      "source_unavailable",
      "source_too_large",
      "pin_unsupported",
    ]);
  });
  const REV = "b".repeat(64);
  it("parses tickets and unavailableClaims", () => {
    const parsed = parseReconcileContextResponse({
      ...ready(),
      tickets: [{ key: "SUP-12", revision: REV, snapshot: { summary: "A" } }],
      unavailableClaims: [{ claimId: "c1", code: "source_unavailable" }],
    });
    expect(parsed).toMatchObject({
      tickets: [{ key: "SUP-12", revision: REV, snapshot: { summary: "A" } }],
      unavailableClaims: [{ claimId: "c1", code: "source_unavailable" }],
    });
  });
  it("defaults both to empty when an older www omits them", () => {
    const { tickets: _t, unavailableClaims: _u, ...old } = ready();
    expect(parseReconcileContextResponse(old)).toMatchObject({
      tickets: [],
      unavailableClaims: [],
    });
  });
  it.each([
    [
      "bad key",
      { tickets: [{ key: "x", revision: "b".repeat(64), snapshot: {} }] },
    ],
    [
      "bad revision",
      { tickets: [{ key: "SUP-1", revision: "zz", snapshot: {} }] },
    ],
    [
      "array snapshot",
      { tickets: [{ key: "SUP-1", revision: "b".repeat(64), snapshot: [] }] },
    ],
    ["unknown code", { unavailableClaims: [{ claimId: "c1", code: "nope" }] }],
    ["non-array", { tickets: {} }],
  ])("rejects %s", (_n, extra) => {
    expect(parseReconcileContextResponse({ ...ready(), ...extra })).toBeNull();
  });
});

describe("module hygiene", () => {
  it("has no runtime import", () => {
    const src = readFileSync(join(HERE, "reconcile-wire.ts"), "utf8");
    const runtime = [
      ...src.matchAll(
        /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
      ),
    ];
    expect(runtime.map((m) => m[1])).toEqual([]);
    expect(src).not.toMatch(/\bimport\(/);
  });
});
