import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildEntryScript,
  CONTAINER_FLUTTER_SHIM_DIR,
  CONTAINER_PINS_FILE,
  CONTAINER_RUN_ENV_FILE,
  detectFlutterPin,
  detectFlutterPinFrom,
  detectSomnioStacks,
  detectSomnioStacksFrom,
  FLUTTER_PIN_SHIM_EXIT,
  type CheckoutProbe,
} from "./container-entry";
import { serializeRunEnvFile } from "./container-policy";

/** An in-memory checkout: `files` maps a relative path to its content (dirs are implied). */
function probe(files: Record<string, string>): CheckoutProbe {
  const dirs = new Set<string>(["."]);
  for (const f of Object.keys(files)) {
    let d = path.posix.dirname(f);
    while (d !== ".") {
      dirs.add(d);
      d = path.posix.dirname(d);
    }
  }
  return {
    readFile: (rel) => files[rel] ?? null,
    isDir: (rel) => dirs.has(rel),
    list: (rel) => {
      const names = new Set<string>();
      for (const p of [...Object.keys(files), ...dirs]) {
        if (p === rel || p === ".") continue;
        const parent = path.posix.dirname(p);
        if (parent === rel) names.add(path.posix.basename(p));
      }
      return [...names];
    },
  };
}

describe("detectSomnioStacksFrom (ADR-013 Run path 5.2)", () => {
  // card: protects=a Flutter app (pubspec depending on the Flutter SDK) installs dart AND flutter rules; fails_when=flutter is missed or a plain Dart package gets flutter; no_claim=that somnio accepts the names (integration suite runs the real CLI)
  it("pubspec.yaml → dart, plus flutter only with an SDK dependency", () => {
    expect(
      detectSomnioStacksFrom(
        probe({
          "pubspec.yaml":
            "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
        }),
      ),
    ).toEqual(["dart", "flutter"]);
    expect(
      detectSomnioStacksFrom(probe({ "pubspec.yaml": "name: pkg\n" })),
    ).toEqual(["dart"]);
  });

  // card: protects=TypeScript, React and NestJS are read from tsconfig.json and package.json dependency maps (any of the three dep fields); fails_when=a stack is missed or inferred from an unrelated key; no_claim=monorepo sub-packages (root only)
  it("tsconfig + package.json deps → typescript, react, nestjs", () => {
    expect(
      detectSomnioStacksFrom(
        probe({
          "tsconfig.json": "{}",
          "package.json": JSON.stringify({
            dependencies: { "@nestjs/core": "^10" },
            devDependencies: { react: "^19" },
            scripts: { react: "not-a-dep" },
          }),
        }),
      ),
    ).toEqual(["nestjs", "react", "typescript"]);
  });

  // card: protects=Python is detected from pyproject/requirements*.txt and django/fastapi/flask by dependency, without substring false positives; fails_when=`flask-cors`-only or a comment mention adds flask, or a framework is missed; no_claim=lockfile-only projects
  it("python + frameworks by dependency name", () => {
    expect(
      detectSomnioStacksFrom(
        probe({
          "requirements-dev.txt": "Django>=4.2\nfastapi==0.110\n",
        }),
      ),
    ).toEqual(["django", "fastapi", "python"]);
    expect(
      detectSomnioStacksFrom(
        probe({ "pyproject.toml": 'dependencies = ["flaskx>=1"]\n' }),
      ),
    ).toEqual(["python"]);
  });

  // card: protects=.NET is found at the root or one level down, Firebase functions need firebase.json AND functions/; fails_when=either is missed or functions/ alone triggers it; no_claim=deeper .NET layouts
  it("dotnet (root or one level) and Firebase functions", () => {
    expect(detectSomnioStacksFrom(probe({ "src/Api/Api.csproj": "" }))).toEqual(
      [],
    );
    expect(detectSomnioStacksFrom(probe({ "Api/Api.csproj": "" }))).toEqual([
      "dotnet",
    ]);
    expect(
      detectSomnioStacksFrom(
        probe({ "firebase.json": "{}", "functions/index.js": "" }),
      ),
    ).toEqual(["functions"]);
    expect(detectSomnioStacksFrom(probe({ "functions/index.js": "" }))).toEqual(
      [],
    );
  });

  // card: protects=no marker → no stack → nothing installed; fails_when=an empty checkout yields a stack; no_claim=nothing
  it("installs nothing when no stack matches", () => {
    expect(detectSomnioStacksFrom(probe({ "README.md": "# x" }))).toEqual([]);
  });

  // card: protects=the fs probe never follows a symlinked marker out of the checkout; fails_when=a pubspec.yaml symlink to a host file is read; no_claim=TOCTOU on a live checkout
  it("ignores a symlinked marker file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stacks-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    fs.writeFileSync(path.join(outside, "pubspec.yaml"), "name: x\n");
    fs.symlinkSync(
      path.join(outside, "pubspec.yaml"),
      path.join(dir, "pubspec.yaml"),
    );
    fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
    expect(detectSomnioStacks(dir)).toEqual(["typescript"]);
  });
});

/**
 * The entry script run for real by the local bash against a scratch checkout,
 * with `/workspace` and HOME rewritten to temp dirs and a fake `somnio` that
 * behaves like the measured installer (rewrites a tracked CLAUDE.md, adds rule
 * files). The REAL CLI in the REAL image is the integration suite's job.
 */
describe("detectFlutterPinFrom (#558)", () => {
  // card: protects=an FVM pin is read from .fvmrc (`flutter`) or the legacy .fvm/fvm_config.json (`flutterSdkVersion`), .fvmrc winning; fails_when=either file is ignored or the legacy one wins; no_claim=FVM's own resolution rules
  it("reads .fvmrc, falls back to the legacy config, .fvmrc wins", () => {
    expect(
      detectFlutterPinFrom(probe({ ".fvmrc": '{"flutter": "3.41.2"}' })),
    ).toBe("3.41.2");
    expect(
      detectFlutterPinFrom(
        probe({ ".fvm/fvm_config.json": '{"flutterSdkVersion":"3.24.5"}' }),
      ),
    ).toBe("3.24.5");
    expect(
      detectFlutterPinFrom(
        probe({
          ".fvmrc": '{"flutter":"3.41.2"}',
          ".fvm/fvm_config.json": '{"flutterSdkVersion":"3.24.5"}',
        }),
      ),
    ).toBe("3.41.2");
  });

  // card: protects=only an exact release version is a pin: a channel, a shell metacharacter, broken JSON or no file yields null, so nothing unsafe rides the argv; fails_when=`stable` or `3.41.2;rm -rf` comes back as a pin; no_claim=FVM forks/channels support
  it("returns null for channels, malformed values and absent files", () => {
    const cases: Record<string, string>[] = [
      {},
      { ".fvmrc": '{"flutter":"stable"}' },
      { ".fvmrc": '{"flutter":"3.41.2; rm -rf /"}' },
      { ".fvmrc": '{"flutter":"$(id)"}' },
      { ".fvmrc": "not json" },
      { ".fvmrc": '{"flutter": 3}' },
    ];
    for (const files of cases) {
      expect(detectFlutterPinFrom(probe(files))).toBeNull();
    }
    expect(
      detectFlutterPinFrom(probe({ ".fvmrc": '{"flutter":"3.41.2-0.1.pre"}' })),
    ).toBe("3.41.2-0.1.pre");
  });

  // card: protects=the fs adapter reads a real checkout's .fvmrc; fails_when=the file on disk is not seen; no_claim=nothing
  it("reads a real checkout", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fvm-"));
    try {
      fs.writeFileSync(path.join(dir, ".fvmrc"), '{"flutter":"3.41.2"}');
      expect(detectFlutterPin(dir)).toBe("3.41.2");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildEntryScript: the Somnio rules step and the env file (run under bash)", () => {
  let root: string;
  let ws: string;
  let home: string;
  let bin: string;

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", ws, ...args], { encoding: "utf8" });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "entry-"));
    ws = path.join(root, "workspace");
    home = path.join(root, "home");
    bin = path.join(root, "bin");
    fs.mkdirSync(ws);
    fs.mkdirSync(path.join(home, ".automata-run"), { recursive: true });
    fs.mkdirSync(bin);
    git("init", "-q", ".");
    fs.writeFileSync(path.join(ws, "CLAUDE.md"), "# the repo's own\n");
    fs.writeFileSync(path.join(ws, "tsconfig.json"), "{}");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    // The fake installer: overwrite the tracked CLAUDE.md, add rules, log argv.
    fs.writeFileSync(
      path.join(bin, "somnio"),
      [
        "#!/bin/bash",
        'echo "$*" >"$SOMNIO_ARGS_LOG"',
        "printf 'installer text\\n' >CLAUDE.md",
        "mkdir -p '.claude/rules/typescript'",
        "printf 'rule\\n' >.claude/rules/typescript/best-practices.md",
        "printf 'odd\\n' >'.claude/rules/weird[1]*.md'",
        'exit "${SOMNIO_EXIT:-0}"',
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function runEntry(env: Record<string, string>, ...cmd: string[]) {
    const script = buildEntryScript()
      .replaceAll("/workspace", ws)
      .replaceAll(
        CONTAINER_RUN_ENV_FILE,
        path.join(home, ".automata-run/run.env"),
      )
      .replaceAll(CONTAINER_PINS_FILE, path.join(root, "pins.env"))
      .replaceAll(
        CONTAINER_FLUTTER_SHIM_DIR,
        path.join(home, ".automata-run/flutter-pin"),
      )
      .replaceAll("/opt/flutter/bin", path.join(root, "flutter/bin"));
    return spawnSync("bash", ["-c", script, "automata-entry", ...cmd], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        SOMNIO_ARGS_LOG: path.join(root, "args.log"),
        ...env,
      },
    });
  }

  // card: protects=the installer runs with the detected stacks, every tracked path it rewrote is restored (the repo's CLAUDE.md wins), every path it added is excluded, and the checkout ends clean; fails_when=CLAUDE.md keeps the installer's text, a rule file shows in `git status`, or the stacks argument differs; no_claim=the real somnio CLI's output layout (integration suite)
  it("installs, restores tracked files, excludes additions, leaves the checkout clean", () => {
    const r = runEntry({ AUTOMATA_SOMNIO_STACKS: "react,typescript" }, "true");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(root, "args.log"), "utf8").trim()).toBe(
      "-q rules install --agent claude --project --stacks react,typescript",
    );
    expect(fs.readFileSync(path.join(ws, "CLAUDE.md"), "utf8")).toBe(
      "# the repo's own\n",
    );
    expect(
      fs.existsSync(
        path.join(ws, ".claude/rules/typescript/best-practices.md"),
      ),
    ).toBe(true);
    expect(git("status", "--porcelain")).toBe("");
    const exclude = fs.readFileSync(path.join(ws, ".git/info/exclude"), "utf8");
    expect(exclude).toContain("/.claude/rules/typescript/best-practices.md\n");
    expect(exclude).toContain("/.claude/rules/weird\\[1\\]\\*.md\n");
  });

  // card: protects=a repo that already tracks its own .claude/ keeps it byte-for-byte: a rewritten tracked file is restored, a tracked file the installer DELETED comes back, and only the installer's additions are excluded; fails_when=the repo's settings or rule is lost, or one of its own paths lands in .git/info/exclude; no_claim=the real CLI's clean_adapter scope (integration suite)
  it("a repo with its own tracked .claude/ keeps it: rewrites restored, deletions undone", () => {
    fs.mkdirSync(path.join(ws, ".claude/rules"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".claude/settings.json"), '{"own":1}\n');
    fs.writeFileSync(path.join(ws, ".claude/rules/own.md"), "own rule\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "own");
    // An installer that also rewrites and deletes what the repo tracks.
    fs.writeFileSync(
      path.join(bin, "somnio"),
      [
        "#!/bin/bash",
        "printf '{}' >.claude/settings.json",
        "rm -f .claude/rules/own.md",
        "mkdir -p '.claude/rules/typescript'",
        "printf 'rule\\n' >.claude/rules/typescript/best-practices.md",
      ].join("\n"),
      { mode: 0o755 },
    );
    const r = runEntry({ AUTOMATA_SOMNIO_STACKS: "typescript" }, "true");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(
      fs.readFileSync(path.join(ws, ".claude/settings.json"), "utf8"),
    ).toBe('{"own":1}\n');
    expect(fs.readFileSync(path.join(ws, ".claude/rules/own.md"), "utf8")).toBe(
      "own rule\n",
    );
    expect(git("status", "--porcelain")).toBe("");
    const exclude = fs.readFileSync(path.join(ws, ".git/info/exclude"), "utf8");
    expect(exclude).toContain("/.claude/rules/typescript/best-practices.md\n");
    expect(exclude).not.toContain("own.md");
    expect(exclude).not.toContain("settings.json");
  });

  // card: protects=a failing installer never fails the run and still leaves the checkout clean; fails_when=the entry exits non-zero or the checkout is dirty; no_claim=partial-install semantics of the real CLI
  it("a failing installer is reported, the checkout still ends clean, the command still runs", () => {
    const r = runEntry(
      { AUTOMATA_SOMNIO_STACKS: "typescript", SOMNIO_EXIT: "3" },
      "bash",
      "-c",
      "echo ran",
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("ran\n");
    expect(r.stderr).toMatch(/somnio rules install failed/);
    expect(git("status", "--porcelain")).toBe("");
  });

  // card: protects=no detected stack means the installer is never called; fails_when=somnio runs with an empty stack list; no_claim=nothing
  it("skips the installer when no stack was detected", () => {
    const r = runEntry({ AUTOMATA_SOMNIO_STACKS: "" }, "true");
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(root, "args.log"))).toBe(false);
  });

  // card: protects=the run env file's secrets reach the exec'd daemon and the file is deleted before the daemon starts, with quoting that evaluates nothing; fails_when=a value is lost or mangled, a `$(…)` in a value executes, or the file survives; no_claim=docker cp delivering the file (integration suite)
  it("sources the run env file into the daemon's env and deletes it first", () => {
    const envFile = path.join(home, ".automata-run/run.env");
    fs.writeFileSync(
      envFile,
      serializeRunEnvFile({
        ANTHROPIC_API_KEY: "sk-ant-'quoted' $(touch pwned) `x`",
        FORCE_COLOR: "0",
      }),
    );
    const r = runEntry(
      {},
      "bash",
      "-c",
      'printf "%s|%s|%s" "$ANTHROPIC_API_KEY" "$FORCE_COLOR" "$(test -e "$1" && echo present || echo gone)"',
      "x",
      envFile,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("sk-ant-'quoted' $(touch pwned) `x`|0|gone");
    expect(fs.existsSync(path.join(ws, "pwned"))).toBe(false);
  });

  // card: protects=the exec'd command replaces the entry shell and its exit status is the container's; fails_when=a non-zero daemon exit is swallowed; no_claim=signal forwarding (that is --init's job)
  it("execs the command and propagates its exit status", () => {
    const r = runEntry({}, "bash", "-c", "exit 7");
    expect(r.status).toBe(7);
  });

  /** A fake image Flutter at <root>/flutter/bin, first on PATH, and the image pins. */
  function fakeImageFlutter(version: string) {
    const fbin = path.join(root, "flutter/bin");
    fs.mkdirSync(fbin, { recursive: true });
    for (const t of ["flutter", "dart"]) {
      fs.writeFileSync(path.join(fbin, t), "#!/bin/sh\necho image-sdk\n", {
        mode: 0o755,
      });
    }
    fs.writeFileSync(
      path.join(root, "pins.env"),
      `FLUTTER_VERSION=${version}\n`,
    );
    return `${fbin}:${bin}:${process.env.PATH}`;
  }

  // card: protects=#558 fail-closed: a pin the image does not have replaces flutter AND dart with shims that name both versions and exit 69, the image SDK leaves PATH, and the entry says so once; fails_when=the image SDK still runs, a shim exits 0, or the notice is missing; no_claim=the agent reading the notice (skills handle a non-zero tool)
  it("a pin the image lacks: flutter and dart become notice shims", () => {
    const PATH = fakeImageFlutter("3.47.7");
    const r = runEntry(
      { PATH, AUTOMATA_FLUTTER_PIN: "3.41.2" },
      "bash",
      "-c",
      'flutter --version; echo "f=$?"; dart format .; echo "d=$?"',
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(
      `f=${FLUTTER_PIN_SHIM_EXIT}\nd=${FLUTTER_PIN_SHIM_EXIT}\n`,
    );
    expect(r.stdout).not.toContain("image-sdk");
    expect(r.stderr).toContain(
      "this repository pins Flutter 3.41.2 (FVM) but the run image has 3.47.7 and no matching SDK, so flutter is not available",
    );
    expect(r.stderr).toContain(
      "automata-entry: Flutter 3.41.2 is pinned but the image has 3.47.7",
    );
  });

  // card: protects=a pin that matches the image changes nothing: the image SDK stays on PATH and no notice is printed; fails_when=a matching repo loses flutter; no_claim=nothing
  it("a pin that matches the image keeps the image SDK", () => {
    const PATH = fakeImageFlutter("3.47.7");
    const r = runEntry(
      { PATH, AUTOMATA_FLUTTER_PIN: "3.47.7" },
      "bash",
      "-c",
      "flutter",
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("image-sdk\n");
    expect(r.stderr).toBe("");
  });

  // card: protects=no pin, or a pin with shell metacharacters, leaves PATH alone (the value is never used); fails_when=an unsafe value reaches the shim text or the SDK is removed; no_claim=nothing
  it("no pin or an unsafe pin leaves the image SDK alone", () => {
    const PATH = fakeImageFlutter("3.47.7");
    for (const pin of ["", "3.41.2;touch pwned", "$(touch pwned)"]) {
      const r = runEntry({ PATH, AUTOMATA_FLUTTER_PIN: pin }, "flutter");
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("image-sdk\n");
    }
    expect(fs.existsSync(path.join(ws, "pwned"))).toBe(false);
  });

  // card: protects=the C2 entry starts no bridge: with no socket mounted, socat is never invoked; fails_when=a bridge starts without its socket; no_claim=C3's bridges (#430)
  it("starts no socat bridge when no bridge socket is mounted", () => {
    fs.writeFileSync(
      path.join(bin, "socat"),
      `#!/bin/bash\ntouch ${path.join(root, "socat-ran")}\n`,
      { mode: 0o755 },
    );
    const r = runEntry({}, "true");
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(root, "socat-ran"))).toBe(false);
  });
});
