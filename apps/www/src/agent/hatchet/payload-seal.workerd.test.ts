import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import {
  generatePlaneKeyPair,
  sealRunSecrets,
  unsealRunSecrets,
  type PlanePrivateKey,
  type PlanePublicKey,
  type RunSecrets,
  type SealedRunSecrets,
} from "@terragon/utils/payload-seal";

/**
 * #380 AC 5: the seal module runs under BOTH runtimes. www dispatches from
 * workerd (Cloudflare Workers) and the worker unseals under Node, so the
 * fixture worker (`__fixtures__/payload-seal-workerd.worker.ts`) is started
 * under wrangler's local workerd and the envelope crosses the runtime
 * boundary in each direction. The negative vectors are repeated under
 * workerd so a runtime-specific WebCrypto difference (tag check, AAD,
 * X25519 import) cannot hide behind the Node suite.
 *
 * Card: protects=seal/unseal under workerd and across runtimes;
 * fails_when=workerd lacks X25519 deriveBits, or an envelope from one runtime
 * does not unseal in the other, or a negative vector unseals under workerd;
 * no_claim=nothing about the deployed OpenNext bundle (the fixture is a plain
 * module worker on www's compatibility date + nodejs_compat).
 */

const FIXTURES = join(__dirname, "__fixtures__");

type WorkerReply =
  | { ok: true; sealed: SealedRunSecrets }
  | { ok: true; secrets: RunSecrets }
  | { ok: true; sharedBytes: number; runtime: string }
  | { ok: false; reason: string; message: string };

const SECRETS: RunSecrets = {
  installationToken: "ghs_workerdInstallationToken0123456789",
  githubReadToken: "ghs_workerdReadToken0123456789abcdef",
  daemonToken: "daemon_workerd_token_0123456789abcdefghijklmnopqrstuvwxyz",
};
const THREAD_CHAT_ID = "tc_workerd";

describe("payload-seal under workerd (#380 AC 5)", () => {
  let worker: Unstable_DevWorker;
  let plane: { publicKey: PlanePublicKey; privateKey: PlanePrivateKey };

  const call = async (body: unknown): Promise<WorkerReply> => {
    const res = await worker.fetch("http://payload-seal.test/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return (await res.json()) as WorkerReply;
  };

  beforeAll(async () => {
    worker = await unstable_dev(
      join(FIXTURES, "payload-seal-workerd.worker.ts"),
      {
        config: join(FIXTURES, "payload-seal-workerd.wrangler.jsonc"),
        experimental: { disableExperimentalWarning: true },
        local: true,
        logLevel: "error",
      },
    );
    plane = await generatePlaneKeyPair("plane-workerd");
  }, 90_000);

  afterAll(async () => {
    await worker?.stop();
  });

  it("X25519 deriveBits works under workerd (the spec's first gate)", async () => {
    const reply = await call({ op: "probe" });
    expect(reply).toMatchObject({
      ok: true,
      sharedBytes: 32,
      runtime: "Cloudflare-Workers",
    });
  });

  it("seal under workerd → unseal under Node, and the reverse", async () => {
    const fromWorkerd = await call({
      op: "seal",
      pk: plane.publicKey,
      secrets: SECRETS,
      threadChatId: THREAD_CHAT_ID,
    });
    expect(fromWorkerd.ok).toBe(true);
    const sealed = (fromWorkerd as { sealed: SealedRunSecrets }).sealed;
    expect(sealed.v).toBe(1);
    expect(JSON.stringify(sealed)).not.toContain("ghs_");
    expect(
      await unsealRunSecrets([plane.privateKey], sealed, THREAD_CHAT_ID),
    ).toEqual(SECRETS);

    const fromNode = await sealRunSecrets(
      plane.publicKey,
      SECRETS,
      THREAD_CHAT_ID,
    );
    const back = await call({
      op: "unseal",
      keys: [plane.privateKey],
      sealed: fromNode,
      threadChatId: THREAD_CHAT_ID,
    });
    expect(back).toEqual({ ok: true, secrets: SECRETS });
  });

  it("the negative vectors hold under workerd: wrong key, wrong threadChatId, unknown kid, flipped ct", async () => {
    const other = await generatePlaneKeyPair("plane-workerd");
    const sealed = await sealRunSecrets(
      plane.publicKey,
      SECRETS,
      THREAD_CHAT_ID,
    );
    const unseal = (keys: PlanePrivateKey[], s: SealedRunSecrets, tc: string) =>
      call({ op: "unseal", keys, sealed: s, threadChatId: tc });

    expect(await unseal([other.privateKey], sealed, THREAD_CHAT_ID)).toEqual({
      ok: false,
      reason: "tag",
      message: "payload-seal: unseal failed (kid=plane-workerd, reason=tag)",
    });
    expect(await unseal([plane.privateKey], sealed, "tc_other")).toMatchObject({
      ok: false,
      reason: "tag",
    });
    expect(
      await unseal(
        [plane.privateKey],
        { ...sealed, kid: "plane-x" },
        THREAD_CHAT_ID,
      ),
    ).toMatchObject({ ok: false, reason: "unknown-kid" });
    // Flip the first base64url character of ct to a different valid one.
    const first = sealed.ct[0] === "A" ? "B" : "A";
    expect(
      await unseal(
        [plane.privateKey],
        { ...sealed, ct: first + sealed.ct.slice(1) },
        THREAD_CHAT_ID,
      ),
    ).toMatchObject({ ok: false, reason: "tag" });
  });
});
