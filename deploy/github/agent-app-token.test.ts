// deploy/github/agent-app-token.sh against a throwaway RSA key and fake
// `curl` / `security` binaries on PATH: no network, no keychain, no real App.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  verify,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const SCRIPT = join(import.meta.dirname, "agent-app-token.sh");
const FAKE_TOKEN = "ghs_fakeInstallationToken0123456789";
const SCOPED_RESPONSE = JSON.stringify({
  token: FAKE_TOKEN,
  expires_at: "2026-11-18T08:00:00Z",
  repository_selection: "selected",
  repositories: [{ name: "automata" }],
  permissions: { contents: "write", pull_requests: "write", metadata: "read" },
});

let dir: string;
let bin: string;
let pem: string;
let publicKey: KeyObject;

function run(
  args: string[],
  env: Record<string, string>,
): SpawnSyncReturns<string> {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
      HOME: dir,
      FAKE_DIR: dir,
      FAKE_CURL_BODY: SCOPED_RESPONSE,
      ...env,
    },
  });
}

/** The JWT the fake curl received, after checking the header's exact form. */
function curlJwt(): string {
  const stdin = readFileSync(join(dir, "curl.stdin"), "utf8");
  const match = /^Authorization: Bearer (\S+)\n$/.exec(stdin);
  assert.ok(match?.[1], `unexpected header on curl's stdin: ${stdin}`);
  return match[1];
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function assertValidJwt(jwt: string, appId: string): void {
  const [header, payload, signature] = jwt.split(".");
  assert.ok(header && payload && signature, `not a JWT: ${jwt}`);
  assert.deepEqual(decodeSegment(header), { alg: "RS256", typ: "JWT" });
  const claims = decodeSegment(payload) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  assert.equal(claims.iss, appId);
  assert.equal(typeof claims.iat, "number");
  assert.equal(typeof claims.exp, "number");
  const iat = claims.iat as number;
  const exp = claims.exp as number;
  assert.ok(iat <= now - 50 && iat >= now - 70, `iat ${iat} vs now ${now}`);
  assert.equal(exp - iat, 600, "GitHub caps a JWT at 10 minutes");
  const ok = verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
  assert.ok(ok, "the RS256 signature does not verify with the public key");
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-app-token-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    // GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY") keys.
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  pem = pair.privateKey;
  publicKey = createPublicKey(pair.publicKey);
  writeFileSync(join(dir, "key.pem"), pem, { mode: 0o600 });
  writeFileSync(
    join(dir, "key.b64"),
    Buffer.from(pem).toString("base64") + "\n",
  );
  writeFileSync(join(dir, "key.hex"), Buffer.from(pem).toString("hex"));

  // Fake curl: records its argv and the headers it got on stdin, then answers
  // with $FAKE_CURL_BODY and exits $FAKE_CURL_EXIT.
  writeExecutable(
    join(bin, "curl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_DIR/curl.args"
cat > "$FAKE_DIR/curl.stdin"
printf '%s' "$FAKE_CURL_BODY"
exit "\${FAKE_CURL_EXIT:-0}"
`,
  );
  // Fake security: records its argv, prints the base64 key.
  writeExecutable(
    join(bin, "security"),
    `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_DIR/security.args"
cat "$FAKE_DIR/key.b64"
`,
  );
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("agent-app-token.sh", () => {
  const ids = {
    AUTOMATA_AGENT_APP_ID: "123456",
    AUTOMATA_AGENT_INSTALLATION_ID: "987654",
  };

  test("mints: stdout is only the token, the JWT goes to curl on stdin", () => {
    const result = run([], {
      ...ids,
      AUTOMATA_AGENT_APP_KEY_FILE: join(dir, "key.pem"),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${FAKE_TOKEN}\n`);
    assert.equal(result.stderr, "");

    const args = readFileSync(join(dir, "curl.args"), "utf8").split("\n");
    assert.ok(
      args.includes(
        "https://api.github.com/app/installations/987654/access_tokens",
      ),
      args.join(" "),
    );
    assert.ok(args.includes("POST"));
    assert.ok(args.includes("@-"), "headers must come from stdin, not argv");
    assert.ok(
      !args.some((a) => a.includes("Bearer")),
      "the JWT must never be on argv",
    );

    const body = JSON.parse(args[args.indexOf("--data") + 1]!);
    assert.deepEqual(body, {
      repositories: ["automata"],
      permissions: {
        contents: "write",
        pull_requests: "write",
        issues: "write",
        checks: "read",
        metadata: "read",
      },
    });
    assertValidJwt(curlJwt(), "123456");
  });

  test("refuses a token GitHub widened beyond the repository or the permissions", () => {
    const wider = [
      { repository_selection: "all" },
      { repositories: [{ name: "automata" }, { name: "other" }] },
      { permissions: { administration: "write" } },
      { permissions: { checks: "write" } },
    ];
    for (const change of wider) {
      const result = run([], {
        ...ids,
        AUTOMATA_AGENT_APP_KEY_FILE: join(dir, "key.pem"),
        FAKE_CURL_BODY: JSON.stringify({
          ...(JSON.parse(SCOPED_RESPONSE) as object),
          ...change,
        }),
      });
      assert.equal(result.status, 1, JSON.stringify(change));
      assert.equal(result.stdout, "");
      assert.ok(!result.stderr.includes(FAKE_TOKEN));
    }
  });

  test("--jwt prints a valid JWT and makes no request", () => {
    rmSync(join(dir, "curl.args"), { force: true });
    const result = run(["--jwt"], {
      AUTOMATA_AGENT_APP_ID: "42",
      AUTOMATA_AGENT_APP_KEY_FILE: join(dir, "key.pem"),
    });
    assert.equal(result.status, 0, result.stderr);
    assertValidJwt(result.stdout.trim(), "42");
    assert.throws(() => readFileSync(join(dir, "curl.args")));
  });

  test("reads the key from the keychain item automata-agent-app-key / automata", () => {
    const result = run([], ids);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${FAKE_TOKEN}\n`);
    const args = readFileSync(join(dir, "security.args"), "utf8").trim();
    assert.equal(
      args,
      [
        "find-generic-password",
        "-s",
        "automata-agent-app-key",
        "-a",
        "automata",
        "-w",
      ].join("\n"),
    );
  });

  test("accepts the base64 and hex forms of the stored key", () => {
    const hasXxd = spawnSync("bash", ["-c", "command -v xxd"]).status === 0;
    const forms = hasXxd ? ["key.b64", "key.hex"] : ["key.b64"];
    for (const form of forms) {
      const result = run(["--jwt"], {
        AUTOMATA_AGENT_APP_ID: "7",
        AUTOMATA_AGENT_APP_KEY_FILE: join(dir, form),
      });
      assert.equal(result.status, 0, `${form}: ${result.stderr}`);
      assertValidJwt(result.stdout.trim(), "7");
    }
  });

  test("falls back to the config file for the ids", () => {
    const config = join(dir, "app.env");
    writeFileSync(
      config,
      // No final newline: the last line must still be read.
      '# automata-agent\nAPP_ID = "555"\nINSTALLATION_ID=666 # repo only',
    );
    const result = run([], {
      AUTOMATA_AGENT_CONFIG: config,
      AUTOMATA_AGENT_APP_KEY_FILE: join(dir, "key.pem"),
    });
    assert.equal(result.status, 0, result.stderr);
    const args = readFileSync(join(dir, "curl.args"), "utf8");
    assert.match(args, /\/app\/installations\/666\/access_tokens/);
    assertValidJwt(curlJwt(), "555");
  });

  test("exits 2 without ids, and says which one is missing", () => {
    const result = run([], {
      AUTOMATA_AGENT_CONFIG: join(dir, "missing.env"),
      AUTOMATA_AGENT_APP_KEY_FILE: join(dir, "key.pem"),
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /App id/);
  });

  test("exits 1 on a GitHub error, with its message and no secret", () => {
    const result = run([], {
      ...ids,
      AUTOMATA_AGENT_APP_KEY_FILE: join(dir, "key.pem"),
      FAKE_CURL_BODY: '{"message":"A JSON web token could not be decoded"}',
      FAKE_CURL_EXIT: "22",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /could not be decoded/);
    assert.ok(!result.stderr.includes(curlJwt()));
    assert.ok(!result.stderr.includes("PRIVATE KEY"));
  });

  test("exits 1 on a truncated key, naming the cause", () => {
    const cut = join(dir, "cut.b64");
    writeFileSync(cut, Buffer.from(pem).toString("base64").slice(0, 128));
    const result = run(["--jwt"], {
      AUTOMATA_AGENT_APP_ID: "1",
      AUTOMATA_AGENT_APP_KEY_FILE: cut,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /truncated/);
  });

  test("exits 1 when the stored value is not a private key", () => {
    const junk = join(dir, "junk.b64");
    writeFileSync(junk, Buffer.from("not a key").toString("base64"));
    const result = run(["--jwt"], {
      AUTOMATA_AGENT_APP_ID: "1",
      AUTOMATA_AGENT_APP_KEY_FILE: junk,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  });
});
