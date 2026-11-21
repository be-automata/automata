import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { codeOf, repoRoot } from "./bash-script-hygiene";
import { isSafeFlutterVersion, type CheckoutProbe } from "./container-entry";
import {
  FLUTTER_SDKS_DIR,
  FLUTTER_SHIM_DIR,
  FLUTTER_WRAPPER_SCRIPT,
  detectFlutterRequirementFrom,
  flutterAgentNote,
  flutterJournalLine,
  flutterWrapperArgv,
  selectFlutterSdk,
  type FlutterRequirement,
} from "./flutter-sdk";

const DEFAULT = "3.47.7";

/** A checkout made of in-memory files. */
function probe(files: Record<string, string>): CheckoutProbe {
  return {
    readFile: (rel) => files[rel] ?? null,
    isDir: () => false,
    list: () => [],
  };
}
const pubspec = (flutter: string, extra = "") =>
  `name: app\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n  flutter: ${flutter}\n${extra}`;
const req = (files: Record<string, string>) =>
  detectFlutterRequirementFrom(probe(files));

describe("#742 detectFlutterRequirementFrom: where the requirement comes from", () => {
  it(".fvmrc wins over fvm_config.json wins over pubspec", () => {
    const files = {
      ".fvmrc": JSON.stringify({ flutter: "3.41.2" }),
      ".fvm/fvm_config.json": JSON.stringify({ flutterSdkVersion: "3.35.0" }),
      "pubspec.yaml": pubspec("3.29.0"),
    };
    expect(req(files)).toEqual({
      kind: "pin",
      version: "3.41.2",
      source: ".fvmrc",
    });
    delete (files as Record<string, string>)[".fvmrc"];
    expect(req(files)).toEqual({
      kind: "pin",
      version: "3.35.0",
      source: "fvm_config.json",
    });
    delete (files as Record<string, string>)[".fvm/fvm_config.json"];
    expect(req(files)).toEqual({
      kind: "pin",
      version: "3.29.0",
      source: "pubspec",
    });
  });

  it.each([
    [
      "an exact pubspec version is a pin",
      "3.41.2",
      { kind: "pin", version: "3.41.2", source: "pubspec" },
    ],
    [
      "quotes are stripped",
      '"3.41.2"',
      { kind: "pin", version: "3.41.2", source: "pubspec" },
    ],
    [
      "a trailing comment is stripped",
      "3.41.2 # pinned",
      { kind: "pin", version: "3.41.2", source: "pubspec" },
    ],
    [
      "a caret range is a constraint",
      "^3.41.0",
      { kind: "constraint", range: "^3.41.0" },
    ],
    [
      "a quoted bounded range is a constraint",
      '">=3.41.0 <4.0.0"',
      { kind: "constraint", range: ">=3.41.0 <4.0.0" },
    ],
    ["any means none", "any", { kind: "none" }],
    ["empty means none", "", { kind: "none" }],
    ["junk (not a range) means none", "banana", { kind: "none" }],
    ["shell-ish text means none", "$(touch /x)", { kind: "none" }],
  ] as Array<[string, string, FlutterRequirement]>)("%s", (_n, value, want) => {
    expect(req({ "pubspec.yaml": pubspec(value) })).toEqual(want);
  });

  it("no marker files, no flutter key, or a flutter key outside environment: none", () => {
    expect(req({})).toEqual({ kind: "none" });
    expect(
      req({ "pubspec.yaml": "name: app\nenvironment:\n  sdk: ^3.0.0\n" }),
    ).toEqual({ kind: "none" });
    expect(
      req({
        "pubspec.yaml":
          "name: app\nenvironment:\n  sdk: ^3.0.0\ndependencies:\n  flutter: ^9.9.9\n",
      }),
    ).toEqual({ kind: "none" });
  });

  it("a channel in .fvmrc is not a pin and shadows fvm_config.json (the box's rule); the pubspec still applies", () => {
    expect(
      req({
        ".fvmrc": JSON.stringify({ flutter: "stable" }),
        "pubspec.yaml": pubspec("3.41.2"),
      }),
    ).toEqual({ kind: "pin", version: "3.41.2", source: "pubspec" });
    expect(
      req({
        ".fvmrc": JSON.stringify({ flutter: "stable" }),
        ".fvm/fvm_config.json": JSON.stringify({ flutterSdkVersion: "3.35.0" }),
      }),
    ).toEqual({ kind: "none" });
  });

  // card: protects=malformed marker files never throw and never produce a pin: bad JSON or a non-string field falls through to the next file, and an unsafe version never becomes a requirement; fails_when=a parse error escapes or raw text survives as a version; no_claim=the cell's reads (cell-run.test.ts)
  it.each([
    ["truncated JSON", '{"flutter": "3.41'],
    ["a JSON array", '["3.41.2"]'],
    ["a number field", JSON.stringify({ flutter: 3.41 })],
    ["null", "null"],
    ["binary noise", "\u0000\u00ff\ufffd{"],
    ["shell metacharacters", JSON.stringify({ flutter: "3.41.2;$(id)" })],
    ["a newline-forged version", JSON.stringify({ flutter: "3.41.2\nx: y" })],
  ])("a malformed .fvmrc (%s) falls through to fvm_config.json", (_n, rc) => {
    const files = {
      ".fvmrc": rc,
      ".fvm/fvm_config.json": JSON.stringify({ flutterSdkVersion: "3.35.0" }),
    };
    expect(() => req(files)).not.toThrow();
    const out = req(files);
    // A field that IS a string (unsafe text) shadows the legacy file, as on the box.
    if (out.kind === "pin") {
      expect(out).toEqual({
        kind: "pin",
        version: "3.35.0",
        source: "fvm_config.json",
      });
    } else {
      expect(out).toEqual({ kind: "none" });
    }
  });

  it.each([
    ["binary noise", "\u0000\u00ff environment:\n  flutter: \u0000"],
    ["a flow map", "environment: { flutter: 3.41.2 }\n"],
    ["CRLF line endings", "name: a\r\nenvironment:\r\n  flutter: ^3.41.0\r\n"],
    ["an unterminated quote", 'environment:\n  flutter: "3.41.2\n'],
    ["a backtick", "environment:\n  flutter: `id`\n"],
    ["a huge line", `environment:\n  flutter: ${"9".repeat(5000)}\n`],
  ])("a malformed pubspec (%s) never throws", (_n, text) => {
    expect(() => req({ "pubspec.yaml": text })).not.toThrow();
    const out = req({ "pubspec.yaml": text });
    if (out.kind === "pin")
      expect(isSafeFlutterVersion(out.version)).toBe(true);
    if (out.kind === "constraint") expect(out.range).toBe("^3.41.0");
  });
});

describe("#742 selectFlutterSdk", () => {
  const have = ["3.41.2", DEFAULT];
  const pin = (v: string): FlutterRequirement => ({
    kind: "pin",
    version: v,
    source: ".fvmrc",
  });
  const range = (r: string): FlutterRequirement => ({
    kind: "constraint",
    range: r,
  });

  it("a pin the image has selects it; the default's own pin changes nothing", () => {
    expect(selectFlutterSdk(pin("3.41.2"), have, DEFAULT)).toEqual({
      kind: "use",
      version: "3.41.2",
      reason: "pinned",
    });
    expect(selectFlutterSdk(pin(DEFAULT), have, DEFAULT)).toEqual({
      kind: "default",
      reason: "pinned-default",
    });
  });

  it("a pin the image lacks is a miss that keeps the default", () => {
    expect(selectFlutterSdk(pin("3.35.0"), have, DEFAULT)).toEqual({
      kind: "miss",
      wanted: "3.35.0",
    });
  });

  it("a constraint the default satisfies keeps the default", () => {
    expect(selectFlutterSdk(range("^3.41.0"), have, DEFAULT)).toEqual({
      kind: "default",
      reason: "default-satisfies",
    });
  });

  it("a constraint the default breaks selects the highest SDK that satisfies it", () => {
    expect(
      selectFlutterSdk(
        range(">=3.40.0 <3.45.0"),
        ["3.41.2", "3.42.1", DEFAULT],
        DEFAULT,
      ),
    ).toEqual({
      kind: "use",
      version: "3.42.1",
      reason: "constraint",
    });
  });

  it("a constraint nothing satisfies is a miss", () => {
    expect(selectFlutterSdk(range(">=3.50.0 <4.0.0"), have, DEFAULT)).toEqual({
      kind: "miss",
      wanted: ">=3.50.0 <4.0.0",
    });
  });

  it("no requirement keeps the default; unsafe names in the image listing are never selected", () => {
    expect(selectFlutterSdk({ kind: "none" }, have, DEFAULT)).toEqual({
      kind: "default",
      reason: "no-requirement",
    });
    expect(
      selectFlutterSdk(
        pin("3.41.2"),
        ["3.41.2; rm -rf /", "../3.41.2"],
        DEFAULT,
      ),
    ).toEqual({
      kind: "miss",
      wanted: "3.41.2",
    });
  });
});

describe("#742 journal lines, agent note and the safe-version check", () => {
  it("logs the miss with the exact text, version through the safe check", () => {
    const r: FlutterRequirement = {
      kind: "pin",
      version: "3.35.0",
      source: ".fvmrc",
    };
    const sel = selectFlutterSdk(r, ["3.41.2"], DEFAULT);
    expect(flutterJournalLine(sel, r, DEFAULT)).toBe(
      "cell: flutter pin 3.35.0 not in the image; using 3.47.7",
    );
    expect(isSafeFlutterVersion("3.35.0")).toBe(true);
    expect(isSafeFlutterVersion("3.35.0\nforged: line")).toBe(false);
    expect(isSafeFlutterVersion("3.35")).toBe(false);
  });

  it("names the pin source on a hit and the reason on a default", () => {
    const r: FlutterRequirement = {
      kind: "pin",
      version: "3.41.2",
      source: ".fvmrc",
    };
    expect(
      flutterJournalLine(selectFlutterSdk(r, ["3.41.2"], DEFAULT), r, DEFAULT),
    ).toBe("cell: flutter 3.41.2 (pinned by .fvmrc)");
    const c: FlutterRequirement = { kind: "constraint", range: "^3.41.0" };
    expect(
      flutterJournalLine(selectFlutterSdk(c, [], DEFAULT), c, DEFAULT),
    ).toBe("cell: flutter 3.47.7 (default satisfies pubspec)");
    expect(
      flutterJournalLine(
        { kind: "default", reason: "no-requirement" },
        { kind: "none" },
        DEFAULT,
      ),
    ).toBe("cell: flutter 3.47.7 (no project pin)");
  });

  it("the agent note says which SDK it got: the pinned one, the default that meets the pin, the default after a miss, or nothing without a pin", () => {
    expect(
      flutterAgentNote(
        { kind: "use", version: "3.41.2", reason: "pinned" },
        DEFAULT,
      ),
    ).toContain("SDK 3.41.2");
    const miss = flutterAgentNote({ kind: "miss", wanted: "3.35.0" }, DEFAULT);
    expect(miss).toContain("3.35.0");
    expect(miss).toContain("NOT in this image");
    expect(miss).toContain("default SDK 3.47.7");
    expect(
      flutterAgentNote({ kind: "default", reason: "no-requirement" }, DEFAULT),
    ).toBeNull();
    // A project requirement the default already meets still names the SDK.
    for (const reason of ["pinned-default", "default-satisfies"] as const) {
      expect(flutterAgentNote({ kind: "default", reason }, DEFAULT)).toContain(
        "the image default SDK 3.47.7",
      );
    }
  });
});

describe("#742 the wrapper script (run for real against a fake SDK tree)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flutter-sdk-test-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  /** A fake /opt/flutter-sdks/<v> whose tools echo FLUTTER_ROOT and argv. */
  function fakeSdk(v: string): string {
    const sdk = path.join(root, "sdks", v);
    fs.mkdirSync(path.join(sdk, "bin"), { recursive: true });
    for (const t of ["flutter", "dart"]) {
      fs.writeFileSync(
        path.join(sdk, "bin", t),
        `#!/bin/bash\necho "${t} root=$FLUTTER_ROOT args=$*"\n`,
        { mode: 0o755 },
      );
    }
    return sdk;
  }
  /** The real argv with /opt/flutter-sdks pointed at the fake tree. */
  function install(v: string, shimDir: string) {
    const argv = flutterWrapperArgv(v);
    argv[2] = FLUTTER_WRAPPER_SCRIPT.replace(
      FLUTTER_SDKS_DIR,
      path.join(root, "sdks"),
    );
    argv[5] = shimDir;
    return spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
  }
  const run = (file: string, ...args: string[]) =>
    spawnSync(file, args, { encoding: "utf8" });

  it("argv carries the version and the cell's shim dir; the script is inline, not a file", () => {
    const argv = flutterWrapperArgv("3.41.2");
    expect(argv.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(argv.slice(3)).toEqual(["--", "3.41.2", FLUTTER_SHIM_DIR]);
    expect(FLUTTER_SHIM_DIR).toBe("/home/agent/.automata-run/flutter-pin");
  });

  it("writes flutter, dart and fvm wrappers that select the SDK and set FLUTTER_ROOT", () => {
    const sdk = fakeSdk("3.41.2");
    const shim = path.join(root, "shim-ok");
    const r = install("3.41.2", shim);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(shim, "flutter"), "utf8")).toContain(
      `exec env FLUTTER_ROOT=${sdk} ${sdk}/bin/flutter "$@"`,
    );
    expect(
      run(path.join(shim, "flutter"), "test", "--coverage").stdout.trim(),
    ).toBe(`flutter root=${sdk} args=test --coverage`);
    expect(run(path.join(shim, "dart"), "format", ".").stdout.trim()).toBe(
      `dart root=${sdk} args=format .`,
    );
    expect(
      run(path.join(shim, "fvm"), "flutter", "pub", "get").stdout.trim(),
    ).toBe(`flutter root=${sdk} args=pub get`);
    expect(run(path.join(shim, "fvm"), "dart", "--version").stdout.trim()).toBe(
      `dart root=${sdk} args=--version`,
    );
  });

  it("refuses every other fvm subcommand with a notice (exit 69)", () => {
    fakeSdk("3.41.2");
    const shim = path.join(root, "shim-fvm");
    expect(install("3.41.2", shim).status).toBe(0);
    const r = run(path.join(shim, "fvm"), "install", "3.10.0");
    expect(r.status).toBe(69);
    expect(r.stderr).toContain("only 'fvm flutter' and 'fvm dart'");
    expect(r.stderr).toContain("3.41.2");
  });

  it("refuses a bad version (64) and a version the image lacks (65), writing nothing", () => {
    fakeSdk("3.41.2");
    const bad = path.join(root, "shim-bad");
    expect(install("../../etc", bad).status).toBe(64);
    expect(install("", bad).status).toBe(64);
    expect(install("3.99.9", bad).status).toBe(65);
    expect(fs.existsSync(bad)).toBe(false);
  });
});

describe("#742 the batteries image's SDK cache (static)", () => {
  const dockerfile = fs.readFileSync(
    path.join(repoRoot, "deploy/images/batteries/Dockerfile"),
    "utf8",
  );
  const verify = fs.readFileSync(
    path.join(repoRoot, "deploy/images/batteries/verify.sh"),
    "utf8",
  );
  const defaultVersion = /^ARG FLUTTER_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
  const extras = (
    /^ARG FLUTTER_EXTRA_SDKS="([^"]*)"$/m.exec(dockerfile)?.[1] ?? ""
  )
    .split(/\s+/)
    .filter((p) => p !== "");

  // card: protects=every baked SDK is fetched by version AND a full sha256, is not the default (whose path is a symlink the mv would write through), and has the per-SDK fixture lock the offline proof needs; fails_when=an entry lacks its digest, repeats the default or ships without a lock; no_claim=that the digest matches the release (the build checks it)
  it("every extra is VERSION=SHA256, not the default, with a fixture lock", () => {
    expect(defaultVersion).toBeDefined();
    expect(extras.length).toBeGreaterThan(0);
    for (const pin of extras) {
      const [v, sha] = pin.split("=");
      expect(isSafeFlutterVersion(v ?? ""), pin).toBe(true);
      expect(sha, pin).toMatch(/^[0-9a-f]{64}$/);
      expect(v).not.toBe(defaultVersion);
      expect(
        fs.existsSync(
          path.join(
            repoRoot,
            "deploy/images/batteries/flutter-fixture",
            v ?? "",
            "pubspec.lock",
          ),
        ),
        v,
      ).toBe(true);
    }
  });

  // card: protects=the build itself refuses an extra equal to the default and fetches each extra through the sha256 check; verify.sh runs the offline flutter test per extra; fails_when=the guard, the digest argument or the offline test is dropped; no_claim=the real build (batteries-image workflow)
  it("the extras loop guards the default, fetches through fetch-verified with the digest, and verify.sh runs the offline test", () => {
    const loop = codeOf(dockerfile).slice(
      codeOf(dockerfile).indexOf("RUN mkdir -p /opt/flutter-sdks"),
    );
    expect(loop).toMatch(
      /\[ "\$\{v\}" != "\$\{FLUTTER_VERSION\}" \] \|\| \{ echo "[^"]*" >&2; exit 1; \}/,
    );
    expect(loop).toMatch(/fetch-verified "[^"]+\$\{v\}[^"]+" \\\s+"\$\{sha\}"/);
    expect(verify).toContain('check "flutter-test-$v" "All tests passed"');
    expect(verify).toContain('"$sdk/bin/flutter" test');
  });
});
