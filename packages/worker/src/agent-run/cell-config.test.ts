import { describe, expect, it, vi } from "vitest";

import { describeCellEnv, loadCellConfig } from "./cell-config";

const IMAGE = `ghcr.io/be-automata/automata-cell@sha256:${"cd".repeat(32)}`;
const KEY = "ab".repeat(24);
const ENV = {
  WORKER_OPENSANDBOX_URL: "http://127.0.0.1:8090",
  WORKER_OPENSANDBOX_API_KEY_FILE: "/run/key",
  WORKER_OPENSANDBOX_GUEST_IMAGE: IMAGE,
};
const read = (text: string) => () => text;

describe("loadCellConfig (T-CONFIG, parsing half)", () => {
  // card: protects=an unset env means cells are off, not a failure; fails_when=any of the three names set still yields off; no_claim=the run-side behaviour
  it("is off when none of the three names is set", () => {
    const readFile = vi.fn();
    expect(loadCellConfig({}, readFile)).toEqual({ kind: "off" });
    expect(readFile).not.toHaveBeenCalled();
  });

  // card: protects=one or two of three names set is a refusal; fails_when=a partial env reads the key file or yields on/off; no_claim=which name is missing
  it("is invalid(partial) when only some names are set", () => {
    const readFile = vi.fn();
    expect(
      loadCellConfig(
        { WORKER_OPENSANDBOX_URL: ENV.WORKER_OPENSANDBOX_URL },
        readFile,
      ),
    ).toEqual({ kind: "invalid", reason: "partial" });
    expect(
      loadCellConfig(
        { ...ENV, WORKER_OPENSANDBOX_GUEST_IMAGE: "  " },
        readFile,
      ),
    ).toEqual({ kind: "invalid", reason: "partial" });
    expect(readFile).not.toHaveBeenCalled();
  });

  // card: protects=the key file must be exactly one OPENSANDBOX_API_KEY=<hex> line; fails_when=a second line, a bad name, short hex or an unreadable file is accepted; no_claim=the key being valid on the server
  it("is invalid(key_file) for anything but one key line", () => {
    for (const text of [
      "",
      `OPENSANDBOX_API_KEY=${KEY}\nextra=1\n`,
      `OTHER_KEY=${KEY}\n`,
      "OPENSANDBOX_API_KEY=abc\n",
      `OPENSANDBOX_API_KEY=${KEY.toUpperCase()}\n`,
    ]) {
      expect(loadCellConfig(ENV, read(text))).toEqual({
        kind: "invalid",
        reason: "key_file",
      });
    }
    expect(
      loadCellConfig(ENV, () => {
        throw new Error("ENOENT");
      }),
    ).toEqual({ kind: "invalid", reason: "key_file" });
  });

  // card: protects=plain http only to loopback, https elsewhere, no userinfo; fails_when=a remote http URL or credentials in the URL is accepted; no_claim=reachability
  it("is invalid(url) for a non-loopback http, a bad scheme or userinfo", () => {
    for (const url of [
      "http://example.org:8090",
      "ftp://127.0.0.1",
      "nope",
      "https://user:pw@example.org",
    ]) {
      expect(
        loadCellConfig(
          { ...ENV, WORKER_OPENSANDBOX_URL: url },
          read(`OPENSANDBOX_API_KEY=${KEY}\n`),
        ),
      ).toEqual({ kind: "invalid", reason: "url" });
    }
  });

  // card: protects=the guest image is pinned by digest; fails_when=a tag-only reference is accepted; no_claim=the digest existing in the registry
  it("is invalid(image) for a tag-only reference", () => {
    expect(
      loadCellConfig(
        {
          ...ENV,
          WORKER_OPENSANDBOX_GUEST_IMAGE:
            "ghcr.io/be-automata/automata-cell:latest",
        },
        read(`OPENSANDBOX_API_KEY=${KEY}\n`),
      ),
    ).toEqual({ kind: "invalid", reason: "image" });
  });

  // card: protects=a valid env yields the key, the normalised URL and the parsed image; fails_when=the URL keeps a trailing slash or the key is not extracted; no_claim=the server answering
  it("is on for a valid env (loopback http and https)", () => {
    const cfg = loadCellConfig(ENV, read(`OPENSANDBOX_API_KEY=${KEY}\n`));
    expect(cfg).toMatchObject({
      kind: "on",
      baseUrl: "http://127.0.0.1:8090",
      apiKey: KEY,
    });
    expect(cfg.kind === "on" && cfg.image.reference).toBe(IMAGE);
    expect(
      loadCellConfig(
        { ...ENV, WORKER_OPENSANDBOX_URL: "https://os.internal.example/" },
        read(`OPENSANDBOX_API_KEY=${KEY}`),
      ),
    ).toMatchObject({ kind: "on", baseUrl: "https://os.internal.example" });
  });

  // card: protects=the key value never leaves the config on a failure or in the boot line; fails_when=an invalid result, an error text or describeCellEnv carries the key; no_claim=logs elsewhere
  it("never exposes the key value outside an on result", () => {
    const bad = loadCellConfig(
      { ...ENV, WORKER_OPENSANDBOX_URL: "http://example.org" },
      read(`OPENSANDBOX_API_KEY=${KEY}\n`),
    );
    expect(JSON.stringify(bad)).not.toContain(KEY);
    expect(describeCellEnv(ENV)).not.toContain(KEY);
  });
});

describe("describeCellEnv (T-CONFIG-LAZY, boot half)", () => {
  // card: protects=the boot line reports the names' presence only; fails_when=it reads a file or prints a value; no_claim=the config being valid
  it("reports presence without reading anything", () => {
    expect(describeCellEnv({})).toBe("cells: off");
    expect(describeCellEnv(ENV)).toBe(
      "cells: env present (url, key file, image)",
    );
    expect(describeCellEnv({ WORKER_OPENSANDBOX_URL: "x" })).toBe(
      "cells: env present (url)",
    );
    expect(describeCellEnv(ENV)).not.toContain("/run/key");
  });
});
