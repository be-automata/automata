import { afterAll, beforeAll, expect } from "vitest";
import { env } from "@terragon/env/apps-www";
import {
  formatPlanePublicKey,
  generatePlaneKeyPair,
  sealBindingOf,
  unsealRunSecrets,
  type RunSecrets,
  type SealBinding,
  type SealedRunSecrets,
} from "@terragon/utils/payload-seal";

/**
 * #380 test fixture: a per-file plane key. `installTestPlaneKey` sets the
 * public half as env.HATCHET_PAYLOAD_SEAL_KEY for the file (beforeAll) and
 * clears it afterwards; the private half stays here so a captured dispatch
 * input can be OPENED and asserted on.
 */
export type TestPlaneKey = {
  readonly kid: string;
  /** The key pair; `undefined` until beforeAll ran. */
  pair: Awaited<ReturnType<typeof generatePlaneKeyPair>> | undefined;
  /** Open a captured input's envelope under the input's own routing fields. */
  unseal(input: Record<string, unknown>): Promise<RunSecrets>;
  /** Set env to this key again (after a case changed it). */
  reinstall(): void;
};

export function installTestPlaneKey(kid: string): TestPlaneKey {
  const key: TestPlaneKey = {
    kid,
    pair: undefined,
    async unseal(input) {
      expect(input.sealedSecrets).toBeDefined();
      if (!key.pair) throw new Error("plane key not installed (beforeAll)");
      return unsealRunSecrets(
        [key.pair.privateKey],
        input.sealedSecrets as SealedRunSecrets,
        sealBindingOf(input as unknown as SealBinding),
      );
    },
    reinstall() {
      if (!key.pair) throw new Error("plane key not installed (beforeAll)");
      setKey(formatPlanePublicKey(key.pair.publicKey));
    },
  };
  beforeAll(async () => {
    key.pair = await generatePlaneKeyPair(kid);
    key.reinstall();
  });
  afterAll(() => setKey(""));
  return key;
}

export function setKey(text: string): void {
  (env as { HATCHET_PAYLOAD_SEAL_KEY: string }).HATCHET_PAYLOAD_SEAL_KEY = text;
}
