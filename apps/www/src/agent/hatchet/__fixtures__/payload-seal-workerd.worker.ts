import {
  PayloadSealError,
  sealRunSecrets,
  unsealRunSecrets,
  type PlanePrivateKey,
  type PlanePublicKey,
  type RunSecrets,
  type SealedRunSecrets,
} from "@terragon/utils/payload-seal";

/**
 * Test-only Cloudflare Worker: runs the SAME `@terragon/utils/payload-seal`
 * module www ships with, under workerd (wrangler `unstable_dev`), so the
 * payload-seal.workerd.test.ts can seal here and unseal in Node — and the
 * reverse. Not deployed; not imported by application code.
 */

type Body =
  | {
      op: "seal";
      pk: PlanePublicKey;
      secrets: RunSecrets;
      threadChatId: string;
    }
  | {
      op: "unseal";
      keys: PlanePrivateKey[];
      sealed: SealedRunSecrets;
      threadChatId: string;
    }
  | { op: "probe" };

export default {
  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as Body;
    try {
      if (body.op === "probe") {
        // The spec's first gate: X25519 deriveBits must work under workerd.
        const s = globalThis.crypto.subtle;
        const a = (await s.generateKey({ name: "X25519" }, true, [
          "deriveBits",
        ])) as CryptoKeyPair;
        const b = (await s.generateKey({ name: "X25519" }, true, [
          "deriveBits",
        ])) as CryptoKeyPair;
        const bits = await s.deriveBits(
          { name: "X25519", public: a.publicKey },
          b.privateKey,
          256,
        );
        return Response.json({
          ok: true,
          sharedBytes: bits.byteLength,
          runtime: navigator.userAgent,
        });
      }
      if (body.op === "seal") {
        const sealed = await sealRunSecrets(
          body.pk,
          body.secrets,
          body.threadChatId,
        );
        return Response.json({ ok: true, sealed });
      }
      const secrets = await unsealRunSecrets(
        body.keys,
        body.sealed,
        body.threadChatId,
      );
      return Response.json({ ok: true, secrets });
    } catch (e) {
      if (e instanceof PayloadSealError) {
        return Response.json({
          ok: false,
          reason: e.reason,
          message: e.message,
        });
      }
      return Response.json({
        ok: false,
        reason: "other",
        message: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      });
    }
  },
};
