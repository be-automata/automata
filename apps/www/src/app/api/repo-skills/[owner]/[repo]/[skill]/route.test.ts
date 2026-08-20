import { describe, it, vi, beforeEach, expect } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { GET, PUT } from "./route";
import { getTenantContextOrNull } from "@/lib/auth-server";
import {
  createRepoSkillVersion,
  getRepoSkill,
  getSkillVersion,
  listSkillVersions,
} from "@terragon/shared/model/repo-skills";

vi.mock("@/lib/auth-server", () => ({
  getTenantContextOrNull: vi.fn(),
}));

vi.mock("@terragon/shared/model/repo-skills", () => ({
  createRepoSkillVersion: vi.fn(),
  getRepoSkill: vi.fn(),
  getSkillVersion: vi.fn(),
  listSkillVersions: vi.fn(),
}));

const captureMock = vi.fn();
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: captureMock }),
}));

vi.mock("@/lib/db", () => ({ db: {} }));

const ORG = "org_1";
const USER = "user_1";

// A body that satisfies the github-ops fenced-json verdict contract — the
// route runs the REAL shared validator (validateSkillBody is deliberately
// unmocked: the whole point of the route is write-time contract enforcement).
const VALID_OPS_BODY =
  'Review methodology.\n```json\n{ "verdict": "approve" }\n```\n';

function req(path: string, init?: RequestInit) {
  return new NextRequest(`http://localhost${path}`, init as never);
}
function putReq(skill: string, body: unknown) {
  return req(`/api/repo-skills/acme/widgets/${skill}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const params = (skill: string) =>
  Promise.resolve({ owner: "acme", repo: "widgets", skill });

/**
 * Tiny in-memory skill store so the happy-path test is a REAL PUT→GET
 * roundtrip (sha computed from the body, pointer moved) instead of asserting
 * against hand-written mock echoes.
 */
type StoredVersion = {
  id: string;
  skillId: string;
  body: string;
  contentSha: string;
  source: string;
  createdByUserId: string | null;
  createdAt: Date;
};
let store: {
  skill: {
    id: string;
    organizationId: string;
    repoFullName: string;
    skillName: string;
    currentVersionId: string | null;
    lastKnownGoodVersionId: string | null;
  } | null;
  versions: StoredVersion[];
};

function wireStoreMocks() {
  vi.mocked(getRepoSkill).mockImplementation(async ({ organizationId }) =>
    store.skill && store.skill.organizationId === organizationId
      ? (store.skill as never)
      : undefined,
  );
  vi.mocked(getSkillVersion).mockImplementation(
    async ({ versionId }) =>
      store.versions.find((v) => v.id === versionId) as never,
  );
  vi.mocked(listSkillVersions).mockImplementation(
    async () =>
      [...store.versions]
        .reverse()
        .map(({ body: _body, ...meta }) => meta) as never,
  );
  vi.mocked(createRepoSkillVersion).mockImplementation(
    async ({
      organizationId,
      repoFullName,
      skillName,
      body,
      source,
      createdByUserId,
    }) => {
      if (!store.skill) {
        store.skill = {
          id: "skill_1",
          organizationId,
          repoFullName: repoFullName.toLowerCase(),
          skillName,
          currentVersionId: null,
          lastKnownGoodVersionId: null,
        };
      }
      const version: StoredVersion = {
        id: `v_${store.versions.length + 1}`,
        skillId: store.skill.id,
        body,
        contentSha: createHash("sha256").update(body, "utf8").digest("hex"),
        source,
        createdByUserId: createdByUserId ?? null,
        createdAt: new Date(),
      };
      store.versions.push(version);
      store.skill.currentVersionId = version.id;
      return { skill: store.skill, version } as never;
    },
  );
}

describe("GET/PUT /api/repo-skills/[owner]/[repo]/[skill]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store = { skill: null, versions: [] };
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId: USER,
      organizationId: ORG,
    });
    wireStoreMocks();
  });

  it("401 when unauthenticated (both verbs, nothing touched)", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue(null);
    const g = await GET(req("/api/repo-skills/acme/widgets/github-ops"), {
      params: params("github-ops"),
    });
    expect(g.status).toBe(401);
    const p = await PUT(putReq("github-ops", { body: VALID_OPS_BODY }), {
      params: params("github-ops"),
    });
    expect(p.status).toBe(401);
    expect(getRepoSkill).not.toHaveBeenCalled();
    expect(createRepoSkillVersion).not.toHaveBeenCalled();
  });

  it("rejects a session with no active org before any read or write", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId: USER,
      organizationId: null,
    });
    const g = await GET(req("/api/repo-skills/acme/widgets/github-ops"), {
      params: params("github-ops"),
    });
    expect(g.status).toBe(400);
    const p = await PUT(putReq("github-ops", { body: VALID_OPS_BODY }), {
      params: params("github-ops"),
    });
    expect(p.status).toBe(400);
    expect(createRepoSkillVersion).not.toHaveBeenCalled();
  });

  it("is org-fenced: another org's session gets 404, never the skill body", async () => {
    await PUT(putReq("github-ops", { body: VALID_OPS_BODY }), {
      params: params("github-ops"),
    });
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId: "intruder",
      organizationId: "org_other",
    });
    const res = await GET(req("/api/repo-skills/acme/widgets/github-ops"), {
      params: params("github-ops"),
    });
    expect(res.status).toBe(404);
  });

  it("404 when the skill row does not exist", async () => {
    const res = await GET(req("/api/repo-skills/acme/widgets/github-ops"), {
      params: params("github-ops"),
    });
    expect(res.status).toBe(404);
  });

  it("422 when a github-ops body lacks the fenced-json contract — NO write happens", async () => {
    const res = await PUT(
      putReq("github-ops", { body: "just prose, no contract" }),
      { params: params("github-ops") },
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    // The validator's own message reaches the caller (names what's missing).
    expect(json.error).toMatch(/fenced-json verdict contract/);
    expect(createRepoSkillVersion).not.toHaveBeenCalled();
  });

  it("422 when a non-registry skill body is empty (default validator)", async () => {
    const res = await PUT(putReq("github-mention", { body: "   \n" }), {
      params: params("github-mention"),
    });
    expect(res.status).toBe(422);
    expect(createRepoSkillVersion).not.toHaveBeenCalled();
  });

  it("400 when body is missing or not a string", async () => {
    const res = await PUT(putReq("github-ops", { body: 42 }), {
      params: params("github-ops"),
    });
    expect(res.status).toBe(400);
    expect(createRepoSkillVersion).not.toHaveBeenCalled();
  });

  it("happy path: PUT creates an api-sourced version; GET roundtrips it; a second PUT changes the sha", async () => {
    const put1 = await PUT(putReq("github-ops", { body: VALID_OPS_BODY }), {
      params: params("github-ops"),
    });
    expect(put1.status).toBe(200);
    const v1 = (await put1.json()) as {
      version: { versionId: string; contentSha: string; source: string };
    };
    expect(v1.version.source).toBe("api");
    expect(createRepoSkillVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        source: "api",
        createdByUserId: USER,
      }),
    );
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "repo_skill_version_created" }),
    );

    const get1 = await GET(req("/api/repo-skills/acme/widgets/github-ops"), {
      params: params("github-ops"),
    });
    expect(get1.status).toBe(200);
    const g1 = (await get1.json()) as {
      skill: {
        current: { versionId: string; body: string; contentSha: string };
        versions: Array<{ id: string; contentSha: string }>;
      };
    };
    expect(g1.skill.current.body).toBe(VALID_OPS_BODY);
    expect(g1.skill.current.contentSha).toBe(v1.version.contentSha);
    // History carries metadata only — never bodies.
    expect(g1.skill.versions[0]).not.toHaveProperty("body");

    const edited = VALID_OPS_BODY + "\nOne more rule.\n";
    const put2 = await PUT(putReq("github-ops", { body: edited }), {
      params: params("github-ops"),
    });
    const v2 = (await put2.json()) as { version: { contentSha: string } };
    expect(v2.version.contentSha).not.toBe(v1.version.contentSha);

    const get2 = await GET(req("/api/repo-skills/acme/widgets/github-ops"), {
      params: params("github-ops"),
    });
    const g2 = (await get2.json()) as {
      skill: {
        current: { body: string; contentSha: string };
        versions: Array<{ id: string }>;
      };
    };
    expect(g2.skill.current.contentSha).toBe(v2.version.contentSha);
    expect(g2.skill.current.body).toBe(edited);
    expect(g2.skill.versions).toHaveLength(2);
  });

  it("GET ?versionId returns that version's body on demand (diff view, #64 slice 2)", async () => {
    const put = await PUT(putReq("github-ops", { body: VALID_OPS_BODY }), {
      params: params("github-ops"),
    });
    const { version } = (await put.json()) as {
      version: { versionId: string };
    };
    const res = await GET(
      req(
        `/api/repo-skills/acme/widgets/github-ops?versionId=${version.versionId}`,
      ),
      { params: params("github-ops") },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: { versionId: string; body: string };
    };
    expect(body.version.versionId).toBe(version.versionId);
    expect(body.version.body).toBe(VALID_OPS_BODY);
  });

  it("GET ?versionId 404s for a version that belongs to another skill (org-safe)", async () => {
    await PUT(putReq("github-ops", { body: VALID_OPS_BODY }), {
      params: params("github-ops"),
    });
    // A version id that exists in the store but under a different skillId.
    store.versions.push({
      id: "v_other",
      skillId: "some_other_skill",
      body: "secret other-skill body",
      contentSha: "x",
      source: "api",
      createdByUserId: null,
      createdAt: new Date(),
    });
    const res = await GET(
      req("/api/repo-skills/acme/widgets/github-ops?versionId=v_other"),
      { params: params("github-ops") },
    );
    expect(res.status).toBe(404);
  });
});
