import { describe, it, expect, vi } from "vitest";

import type { DB } from "@terragon/shared/db";
import type { HatchetTenantBinding } from "@terragon/shared/db/types";

import { hatchetConfig } from "./dispatch";
import {
  HatchetTenantBindingError,
  resolveHatchetConfig,
  resolveHatchetConfigForRun,
  resolveHatchetConfigFromRows,
} from "./tenant-resolver";

function row(over: Partial<HatchetTenantBinding>): HatchetTenantBinding {
  return {
    id: "b1",
    organizationId: "org_1",
    repoFullName: "*",
    tenantId: "tenant-star",
    apiUrl: null,
    apiTokenEncrypted: "enc:star",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as HatchetTenantBinding;
}

const decrypt = (v: string) => `plain(${v})`;
const REPO = "Acme/Widgets";
const repoRow = row({
  repoFullName: "acme/widgets",
  tenantId: "tenant-repo",
  apiTokenEncrypted: "enc:repo",
  apiUrl: "https://hatchet.example.com",
});
const starRow = row({});

const throwingDb = {
  select: () => {
    throw new Error("db must not be queried");
  },
} as unknown as DB;

describe("resolveHatchetConfigFromRows", () => {
  it("prefers the repo row over the * row", () => {
    expect(
      resolveHatchetConfigFromRows({
        rows: [starRow, repoRow],
        repoFullName: REPO,
        decrypt,
      }),
    ).toStrictEqual({
      apiUrl: "https://hatchet.example.com",
      tenantId: "tenant-repo",
      apiToken: "plain(enc:repo)",
    });
  });

  it("uses the * row when no repo row exists, with null apiUrl falling back to env", () => {
    expect(
      resolveHatchetConfigFromRows({
        rows: [starRow],
        repoFullName: REPO,
        decrypt,
      }),
    ).toStrictEqual({
      apiUrl: hatchetConfig().apiUrl,
      tenantId: "tenant-star",
      apiToken: "plain(enc:star)",
    });
  });

  it("returns the env config unchanged with no rows", () => {
    expect(
      resolveHatchetConfigFromRows({ rows: [], repoFullName: REPO, decrypt }),
    ).toStrictEqual(hatchetConfig());
  });

  it("matches the repo case-insensitively", () => {
    const cfg = resolveHatchetConfigFromRows({
      rows: [repoRow, starRow],
      repoFullName: "ACME/WIDGETS",
      decrypt,
    });
    expect(cfg.tenantId).toBe("tenant-repo");
  });

  it("decrypts only the chosen row's ciphertext", () => {
    const spy = vi.fn(decrypt);
    resolveHatchetConfigFromRows({
      rows: [starRow, repoRow],
      repoFullName: REPO,
      decrypt: spy,
    });
    expect(spy.mock.calls).toStrictEqual([["enc:repo"]]);
  });

  it.each([
    ["empty tenantId", { tenantId: "" }],
    ["empty token", { apiTokenEncrypted: "" }],
    ["bad repo slug", { repoFullName: "not-a-slug" }],
    ["uppercase repo slug", { repoFullName: "Acme/Widgets" }],
    ["ftp apiUrl", { apiUrl: "ftp://hatchet.example.com" }],
  ])("throws on a malformed row: %s", (_name, over) => {
    expect(() =>
      resolveHatchetConfigFromRows({
        rows: [starRow, row(over)],
        repoFullName: REPO,
        decrypt,
      }),
    ).toThrow(HatchetTenantBindingError);
  });

  it("validates rows that would not be chosen", () => {
    expect(() =>
      resolveHatchetConfigFromRows({
        rows: [repoRow, row({ tenantId: "" })],
        repoFullName: REPO,
        decrypt,
      }),
    ).toThrow(HatchetTenantBindingError);
  });
});

describe("env short-circuits (no query)", () => {
  it("resolveHatchetConfig: null org and u: org", async () => {
    for (const organizationId of [null, undefined, "u:user_1"]) {
      await expect(
        resolveHatchetConfig({
          db: throwingDb,
          organizationId,
          repoFullName: REPO,
        }),
      ).resolves.toStrictEqual(hatchetConfig());
    }
  });

  it("resolveHatchetConfigForRun: null tenant and env tenant", async () => {
    for (const tenantId of [null, undefined, hatchetConfig().tenantId]) {
      await expect(
        resolveHatchetConfigForRun({
          db: throwingDb,
          organizationId: "org_1",
          tenantId,
        }),
      ).resolves.toStrictEqual(hatchetConfig());
    }
  });
});
