import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pin } from "@terragon/knowledge/node";
import type {
  KnowledgeReconcileInput,
  ReconcileContextResponse,
  ReconcilePublishRequest,
  ReconcilePublishResponse,
  ReconcileWorkerErrorCode,
  WireSidecar,
} from "@terragon/knowledge/reconcile-wire";

import { createSourceRepo, type SourceRepo } from "./__fixtures__/git-fixture";
import { orgMirrorDirs, mirrorPaths, type MirrorConfig } from "./mirror-paths";
import {
  reviewRoutingUpdater,
  runKnowledgeReconcile,
  type ReconcileTaskDeps,
} from "./reconcile-task";
import type { ReconcileCallResult, ReconcileClient } from "./www-client";

const TENANT = "tenant-1";
const ORG = "org_a";
const REPO = "owner/repo";
const INTENT = "intent-1";
const PAGE = "page.md";
const FILE = "src/x.ts";
const PAGE_TEXT = "# Page\n\nLetters b and c are the middle ones.\n";
const STATEMENT = "Letters b and c are the middle ones.";

let root: string;
let src: SourceRepo;

const CONFIG = (): MirrorConfig => ({
  root,
  maxBytes: 2 * 1024 ** 3,
  minFreeBytes: 1,
  snapshotMaxBytes: 256 * 1024 ** 2,
});
const plenty = async () => ({ bavail: 1e12, bsize: 1 });
const empty = async () => ({ bavail: 0, bsize: 1 });

interface FakeClient extends ReconcileClient {
  contexts: string[];
  published: ReconcilePublishRequest[];
  failed: Array<{ intentId: string; code: ReconcileWorkerErrorCode }>;
}

function fakeClient(opts: {
  context: ReconcileCallResult<ReconcileContextResponse>;
  publish?: ReconcileCallResult<ReconcilePublishResponse>;
}): FakeClient {
  const client: FakeClient = {
    contexts: [],
    published: [],
    failed: [],
    async context(intentId) {
      client.contexts.push(intentId);
      return opts.context;
    },
    async publish(request) {
      client.published.push(request);
      return (
        opts.publish ?? {
          kind: "ok",
          value: { result: "published", opsInserted: request.ops.length },
        }
      );
    },
    async fail(intentId, code) {
      client.failed.push({ intentId, code });
      return {
        kind: "ok",
        value: { state: "pending", attempts: 1, code },
      };
    },
  };
  return client;
}

function ready(over: {
  cursor?: string | null;
  target: string;
  sidecars?: WireSidecar[];
  purged?: string[];
  organizationId?: string;
}): ReconcileCallResult<ReconcileContextResponse> {
  return {
    kind: "ok",
    value: {
      status: "ready",
      intent: {
        id: INTENT,
        organizationId: over.organizationId ?? ORG,
        repoFullName: REPO,
        defaultBranch: "main",
        targetSha: over.target,
      },
      cursor: { lastSha: over.cursor ?? null },
      installationToken: "ghs_faketoken123456",
      sidecars: over.sidecars ?? [],
      rejected: [],
      purgedOrganizationIds: over.purged ?? [],
      excludedClaims: 0,
    },
  };
}

function inputFor(target: string): KnowledgeReconcileInput {
  return {
    intentId: INTENT,
    organizationId: ORG,
    repoFullName: REPO,
    targetSha: target,
  };
}

function deps(
  client: ReconcileClient,
  over: Partial<ReconcileTaskDeps> = {},
): ReconcileTaskDeps {
  return {
    client,
    mirrorConfig: CONFIG(),
    tenantId: TENANT,
    statfs: plenty,
    log: () => {},
    testHooks: { remoteUrl: src.url, allowFileProtocolForTests: true },
    ...over,
  };
}

/** A real pin against the same text, laid out the way the engine reads it. */
function pinOf(text: string, uri: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-"));
  try {
    fs.mkdirSync(path.join(dir, "repo", "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "repo", FILE), text);
    return pin(dir, uri);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const FILE_V1 = "a\nb\nc\nd\n";

function sidecarFor(uri = `repo://${FILE}#L2-L3`, text = FILE_V1) {
  const evidence = [pinOf(text, uri)];
  return [
    {
      page: PAGE,
      claims: [{ id: "claim-1", statement: STATEMENT, version: 3, evidence }],
    },
  ] satisfies WireSidecar[];
}

function seed(): string {
  src.commit(PAGE, PAGE_TEXT);
  return src.commit(FILE, FILE_V1);
}

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-root-")),
  );
  src = createSourceRepo();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  src.cleanup();
});

describe("context outcomes", () => {
  it.each(["done", "not_found"] as const)("%s is a no-op", async (status) => {
    const client = fakeClient({
      context: { kind: "ok", value: { status, purgedOrganizationIds: [] } },
    });
    const res = await runKnowledgeReconcile(
      inputFor("a".repeat(40)),
      deps(client),
    );
    expect(res).toEqual({ outcome: "noop" });
    expect(client.failed).toEqual([]);
    expect(client.published).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("gated returns without failing", async () => {
    const client = fakeClient({
      context: {
        kind: "ok",
        value: { status: "gated", purgedOrganizationIds: [] },
      },
    });
    const res = await runKnowledgeReconcile(
      inputFor("a".repeat(40)),
      deps(client),
    );
    expect(res.outcome).toBe("gated");
    expect(client.failed).toEqual([]);
  });

  it("no_access fails once with repo_access_lost and does no git work", async () => {
    const client = fakeClient({
      context: {
        kind: "ok",
        value: { status: "no_access", purgedOrganizationIds: [] },
      },
    });
    const res = await runKnowledgeReconcile(
      inputFor("a".repeat(40)),
      deps(client),
    );
    expect(res).toEqual({ outcome: "failed", code: "repo_access_lost" });
    expect(client.failed).toEqual([
      { intentId: INTENT, code: "repo_access_lost" },
    ]);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("reaps purged orgs before anything else", async () => {
    const { orgDir } = orgMirrorDirs(root, TENANT, "org_x");
    fs.mkdirSync(path.join(orgDir, "r.git"), { recursive: true });
    const client = fakeClient({
      context: {
        kind: "ok",
        value: { status: "done", purgedOrganizationIds: ["org_x"] },
      },
    });
    await runKnowledgeReconcile(inputFor("a".repeat(40)), deps(client));
    expect(fs.existsSync(orgDir)).toBe(false);
  });

  it("a rejected context fails with control_plane_rejected", async () => {
    const client = fakeClient({ context: { kind: "rejected", status: 403 } });
    const res = await runKnowledgeReconcile(
      inputFor("a".repeat(40)),
      deps(client),
    );
    expect(res.code).toBe("control_plane_rejected");
    expect(client.failed).toHaveLength(1);
  });

  it("an unreachable context records nothing", async () => {
    const client = fakeClient({ context: { kind: "unreachable" } });
    const res = await runKnowledgeReconcile(
      inputFor("a".repeat(40)),
      deps(client),
    );
    expect(res.outcome).toBe("failed");
    expect(client.failed).toEqual([]);
  });
});

describe("modes", () => {
  it("first reconcile with no claims publishes a full, empty set", async () => {
    const target = seed();
    const client = fakeClient({ context: ready({ target }) });
    const res = await runKnowledgeReconcile(inputFor(target), deps(client));
    expect(res.outcome).toBe("published");
    expect(client.published).toEqual([
      { intentId: INTENT, fromSha: null, toSha: target, mode: "full", ops: [] },
    ]);
    expect(client.failed).toEqual([]);
  });

  it("a full re-check of unchanged files finds the pin under repo/ (layout)", async () => {
    const target = seed();
    const client = fakeClient({
      context: ready({ target, sidecars: sidecarFor() }),
    });
    await runKnowledgeReconcile(inputFor(target), deps(client));
    const request = client.published[0];
    expect(request?.mode).toBe("full");
    expect(request?.ops).toEqual([]);
  });

  it("a descendant cursor publishes a range with a repin for a moved pin", async () => {
    const cursor = seed();
    const target = src.commit(FILE, `z\n${FILE_V1}`);
    const client = fakeClient({
      context: ready({ cursor, target, sidecars: sidecarFor() }),
    });
    await runKnowledgeReconcile(inputFor(target), deps(client));
    const request = client.published[0];
    expect(request?.mode).toBe("range");
    expect(request?.fromSha).toBe(cursor);
    expect(request?.ops.length).toBeGreaterThanOrEqual(1);
    const op = request?.ops[0];
    expect(op?.claimId).toBe("claim-1");
    expect(op?.baseVersion).toBe(3);
    expect(op?.id).toContain(target.slice(0, 12));
  });

  it("coherent in-place drift becomes a review op through the review-routing updater", async () => {
    const cursor = seed();
    const target = src.commit(FILE, "a\nB\nC\nd\n");
    const updater = reviewRoutingUpdater();
    const client = fakeClient({
      context: ready({ cursor, target, sidecars: sidecarFor() }),
    });
    await runKnowledgeReconcile(inputFor(target), deps(client, { updater }));
    const request = client.published[0];
    expect(request?.mode).toBe("range");
    expect(request?.ops.map((o) => o.kind)).toEqual(["review"]);
    expect(updater.calls).toBeGreaterThanOrEqual(1);
  });

  it("a cursor missing from the mirror falls back to a full re-check", async () => {
    const target = seed();
    const client = fakeClient({
      context: ready({ cursor: "1".repeat(40), target }),
    });
    const res = await runKnowledgeReconcile(inputFor(target), deps(client));
    expect(res.outcome).toBe("published");
    expect(client.published[0]?.mode).toBe("full");
    expect(client.published[0]?.fromSha).toBe("1".repeat(40));
  });

  it("a present but non-descendant cursor falls back to a full re-check", async () => {
    const first = seed();
    await runKnowledgeReconcile(
      inputFor(first),
      deps(fakeClient({ context: ready({ target: first }) })),
    );
    const rewritten = src.rewriteHead(FILE, "a\nb\nc\nd\ne\n");
    const client = fakeClient({
      context: ready({ cursor: first, target: rewritten }),
    });
    await runKnowledgeReconcile(inputFor(rewritten), deps(client));
    expect(client.published[0]?.mode).toBe("full");
  });
});

describe("failures", () => {
  it("a target missing from the mirror fails non_descendant_unrecoverable", async () => {
    seed();
    const target = "2".repeat(40);
    const client = fakeClient({ context: ready({ target }) });
    const res = await runKnowledgeReconcile(inputFor(target), deps(client));
    expect(res.code).toBe("non_descendant_unrecoverable");
    expect(client.failed).toEqual([
      { intentId: INTENT, code: "non_descendant_unrecoverable" },
    ]);
    expect(client.published).toEqual([]);
  });

  it("disk_low fails, leaves no snapshot, and releases the lock", async () => {
    const target = seed();
    const client = fakeClient({
      context: ready({ target, sidecars: sidecarFor() }),
    });
    const res = await runKnowledgeReconcile(
      inputFor(target),
      deps(client, {
        statfs: empty,
        mirrorConfig: { ...CONFIG(), minFreeBytes: 1 },
      }),
    );
    expect(res.code).toBe("disk_low");
    expect(client.failed).toEqual([{ intentId: INTENT, code: "disk_low" }]);
    const tmp = mirrorPaths(root, TENANT, ORG, REPO).tmpDir;
    const leftovers = fs.existsSync(tmp)
      ? fs.readdirSync(tmp).filter((n) => n.startsWith("snap-"))
      : [];
    expect(leftovers).toEqual([]);

    const again = fakeClient({
      context: ready({ target, sidecars: sidecarFor() }),
    });
    const second = await runKnowledgeReconcile(inputFor(target), deps(again));
    expect(second.outcome).toBe("published");
  });

  it("an intent that disagrees with the Hatchet input is rejected with no git work", async () => {
    const target = seed();
    const client = fakeClient({
      context: ready({ target, organizationId: "org_other" }),
    });
    const res = await runKnowledgeReconcile(inputFor(target), deps(client));
    expect(res.code).toBe("control_plane_rejected");
    expect(fs.existsSync(mirrorPaths(root, TENANT, ORG, REPO).bare)).toBe(
      false,
    );

    const other = fakeClient({ context: ready({ target }) });
    const res2 = await runKnowledgeReconcile(
      inputFor("3".repeat(40)),
      deps(other),
    );
    expect(res2.code).toBe("control_plane_rejected");
  });

  it("a traversing page or pin is rejected with no git work", async () => {
    const target = seed();
    const good = sidecarFor();
    const badPage: WireSidecar[] = [{ page: "../x.md", claims: [] }];
    const badPin: WireSidecar[] = [
      {
        page: PAGE,
        claims: [
          {
            id: "c",
            statement: "s",
            version: 1,
            evidence: [{ uri: "repo://../x#L1-L1", hash: "0".repeat(16) }],
          },
        ],
      },
    ];
    const docPin: WireSidecar[] = [
      {
        page: PAGE,
        claims: [
          {
            id: "c",
            statement: "s",
            version: 1,
            evidence: [{ uri: "doc://x#y", hash: "0".repeat(16) }],
          },
        ],
      },
    ];
    expect(good).toHaveLength(1);
    for (const sidecars of [badPage, badPin, docPin]) {
      const client = fakeClient({ context: ready({ target, sidecars }) });
      const res = await runKnowledgeReconcile(inputFor(target), deps(client));
      expect(res.code).toBe("control_plane_rejected");
      expect(client.failed).toHaveLength(1);
      expect(fs.existsSync(mirrorPaths(root, TENANT, ORG, REPO).bare)).toBe(
        false,
      );
    }
  });

  it("a page the engine cannot key is skipped, not fatal", async () => {
    const target = seed();
    const sidecars = sidecarFor();
    const first = sidecars[0];
    if (!first) throw new Error("fixture");
    const client = fakeClient({
      context: ready({
        target,
        sidecars: [{ ...first, page: "docs/page.md" }],
      }),
    });
    const res = await runKnowledgeReconcile(inputFor(target), deps(client));
    expect(res.outcome).toBe("published");
    expect(client.published[0]?.ops).toEqual([]);
  });

  it("sweeps stale snapshot leftovers once git work starts", async () => {
    const target = seed();
    const tmp = mirrorPaths(root, TENANT, ORG, REPO).tmpDir;
    const stale = path.join(tmp, "snap-old");
    fs.mkdirSync(stale, { recursive: true });
    const old = new Date(Date.now() - 3 * 3_600_000);
    fs.utimesSync(stale, old, old);
    const client = fakeClient({ context: ready({ target }) });
    await runKnowledgeReconcile(inputFor(target), deps(client));
    expect(fs.existsSync(stale)).toBe(false);
  });
});

describe("publish results", () => {
  async function runWith(
    publish: ReconcileCallResult<ReconcilePublishResponse>,
  ) {
    const target = seed();
    const client = fakeClient({ context: ready({ target }), publish });
    const res = await runKnowledgeReconcile(inputFor(target), deps(client));
    return { res, client };
  }

  it("a 422 fails exactly once with control_plane_rejected", async () => {
    const { res, client } = await runWith({ kind: "rejected", status: 422 });
    expect(res.code).toBe("control_plane_rejected");
    expect(client.failed).toHaveLength(1);
  });

  it("an unreachable publish fails exactly once with worker_error", async () => {
    const { res, client } = await runWith({ kind: "unreachable" });
    expect(res.code).toBe("worker_error");
    expect(client.failed).toEqual([{ intentId: INTENT, code: "worker_error" }]);
    expect(client.published).toHaveLength(1);
  });

  it.each([
    ["already_published", "published"],
    ["cursor_moved", "superseded"],
    ["stale_claim", "stale"],
  ] as const)("%s maps to %s with no fail call", async (result, outcome) => {
    const { res, client } = await runWith({
      kind: "ok",
      value: { result, opsInserted: 0 },
    });
    expect(res.outcome).toBe(outcome);
    expect(client.failed).toEqual([]);
  });
});

describe("logging", () => {
  it("never logs the installation token", async () => {
    const target = seed();
    const lines: unknown[] = [];
    const client = fakeClient({
      context: ready({ target, sidecars: sidecarFor() }),
    });
    await runKnowledgeReconcile(
      inputFor(target),
      deps(client, { log: (m, f) => lines.push(m, f) }),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain("ghs_faketoken");
  });
});
