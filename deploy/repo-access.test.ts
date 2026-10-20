import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { assessRepoAccess, parseRepoArg } from "./repo-access.ts";

describe("assessRepoAccess", () => {
  test("read + write for doc PRs is ok", () => {
    assert.deepEqual(
      assessRepoAccess({
        metadata: "read",
        contents: "write",
        pull_requests: "write",
      }),
      { ok: true, read: true, docPrWrite: true, missing: [] },
    );
  });

  test("admin satisfies write", () => {
    const result = assessRepoAccess({
      metadata: "read",
      contents: "admin",
      pull_requests: "admin",
    });
    assert.equal(result.ok, true);
  });

  test("read-only is short on both write permissions", () => {
    assert.deepEqual(
      assessRepoAccess({
        metadata: "read",
        contents: "read",
        pull_requests: "read",
      }),
      {
        ok: false,
        read: true,
        docPrWrite: false,
        missing: ["contents:write", "pull_requests:write"],
      },
    );
  });

  test("empty permissions miss everything", () => {
    const result = assessRepoAccess({});
    assert.equal(result.ok, false);
    assert.equal(result.read, false);
    assert.deepEqual(result.missing, [
      "metadata:read",
      "contents:write",
      "pull_requests:write",
    ]);
  });

  test("an unknown level counts as absent", () => {
    const result = assessRepoAccess({
      metadata: "read",
      contents: "none",
      pull_requests: "write",
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["contents:write"]);
  });
});

describe("parseRepoArg", () => {
  test("parses owner/repo", () => {
    assert.deepEqual(parseRepoArg("example-org/docs"), {
      owner: "example-org",
      repo: "docs",
    });
  });

  for (const bad of ["owner", "a/b/c", "", "/repo", "owner/"]) {
    test(`rejects "${bad}"`, () => {
      assert.throws(() => parseRepoArg(bad), /owner\/repo/);
    });
  }
});
