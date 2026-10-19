/**
 * Sealed run secrets (#380, closes ADR-003 F4).
 *
 * www seals every per-run secret — the GitHub installation token, the
 * optional read-only token, the daemon token, the owner's repo environment
 * variables (`repoEnv`) and the self-heal check/gate token (`selfHealToken`)
 * — to the execution plane's public key before they enter the Hatchet
 * trigger input, so the engine's Postgres, its backups and the run API only
 * ever hold ciphertext. The worker unseals in memory at
 * run start with the plane's private half (`/etc/automata/payload-seal.key`).
 *
 * WebCrypto ONLY (`globalThis.crypto.subtle`): the same file runs under
 * workerd (www on Cloudflare Workers) and under Node (the worker box). No
 * `node:crypto`, no Buffer.
 *
 * Construction (v1):
 *   eph        = X25519 ephemeral key pair, fresh per envelope
 *   shared     = X25519(eph.sk, plane.pk)
 *   key        = HKDF-SHA256(ikm=shared, salt=eph.pk || plane.pk, info=INFO), 256 bit
 *   ct         = AES-256-GCM(key, iv=random 12 B, aad=INFO|kid|sha256(input), pt=JSON)
 * The AAD binds the envelope to its key id and to the WHOLE persisted input
 * it travels in (canonical JSON, minus the envelope): an envelope lifted from
 * one run cannot be replayed into another input, nor re-pointed at another
 * callback, branch, self-heal plan or task pack.
 *
 * `PayloadSealError.message` never carries key or plaintext bytes — only the
 * (charset-restricted, truncated) `kid` and a failure class — so it is safe
 * in a persisted failure reason or a journal line.
 */

export const PAYLOAD_SEAL_VERSION = 1 as const;
const INFO = "automata-run-secrets/v1";
const AES_KEY_BITS = 256;
const IV_BYTES = 12;
const X25519_KEY_BYTES = 32;
const GCM_TAG_BYTES = 16;
/** `kid` charset: the key file name and the www env value share it. */
const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;

// `type`, not `interface`: the envelope rides inside the Hatchet task input,
// whose generic requires the implicit index signature (JsonObject) TypeScript
// infers for type-literal aliases but never for interfaces.
export type SealedRunSecrets = {
  v: typeof PAYLOAD_SEAL_VERSION;
  /** Plane key id, e.g. "plane-2026-10". */
  kid: string;
  /** base64url, 32-byte raw ephemeral X25519 public key. */
  epk: string;
  /** base64url, 12 bytes. */
  iv: string;
  /** base64url, AES-256-GCM ciphertext || 16-byte tag. */
  ct: string;
};

// `type` for the same reason as SealedRunSecrets: both planes intersect it
// with their Hatchet input types.
export type RunSecrets = {
  installationToken: string;
  githubReadToken?: string;
  daemonToken: string;
  /**
   * The owner's repo/org/personal environment variables for a task run —
   * typically long-lived API keys. Sealed with the tokens, never in the
   * persisted input.
   */
  repoEnv?: Record<string, string>;
  /** The self-heal run's single-use check/gate token (audit or fix kind). */
  selfHealToken?: string;
};

export interface PlanePublicKey {
  kid: string;
  /** base64url raw X25519 public key (32 bytes). */
  publicKey: string;
}

/** The OKP/X25519 private JWK shape the key file stores. */
export interface X25519PrivateJwk {
  kty: "OKP";
  crv: "X25519";
  x: string;
  d: string;
}

export interface PlanePrivateKey {
  kid: string;
  privateKeyJwk: X25519PrivateJwk;
}

export type PayloadSealFailure =
  | "unknown-kid"
  | "tag"
  | "malformed"
  | "version"
  | "key"
  | "derive";

export class PayloadSealError extends Error {
  readonly reason: PayloadSealFailure;
  readonly kid: string;
  constructor(reason: PayloadSealFailure, kid: string) {
    const safeKid = KID_RE.test(kid) ? kid : "<invalid>";
    super(`payload-seal: unseal failed (kid=${safeKid}, reason=${reason})`);
    this.name = "PayloadSealError";
    this.reason = reason;
    this.kid = safeKid;
  }
}

/**
 * A plane PUBLIC key that cannot be parsed (`<kid>:<base64url>` text from
 * HATCHET_PAYLOAD_SEAL_KEY). Typed so a dispatcher can tell a
 * misconfigured key from an engine failure; the message names the rule that
 * failed and never echoes the text.
 */
export class PlaneKeyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaneKeyParseError";
  }
}

// --- encoding ----------------------------------------------------------------

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  if (typeof text !== "string" || !B64URL_RE.test(text)) {
    throw new TypeError("not base64url");
  }
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * What an envelope is bound to (the AAD): the WHOLE persisted input it
 * travels in, minus the envelope itself and any plain-text secret field.
 * The worker trusts every plain-text field around the envelope — the
 * callback URL the unsealed daemon token is sent to, the self-heal plan that
 * fences what the installation token may push, the branches, the task packs
 * — so a sealed input copied into a NEW trigger with ANY of them changed
 * (anyone holding the engine API token can do that) must fail the tag, not
 * act on the forged field. Bound as SHA-256 over canonical JSON (keys sorted
 * recursively, `undefined` dropped exactly as JSON.stringify drops it on the
 * wire), so www's object and the worker's parsed copy digest identically.
 */
export type SealBinding = object;

/** The fields JSON-serialised secrets or the envelope live under: never part of the binding. */
const UNBOUND_FIELDS = new Set([
  "sealedSecrets",
  "installationToken",
  "githubReadToken",
  "daemonToken",
  "repoEnv",
]);

/** The input as bound: everything but the envelope and the plain-text secret fields. */
export function sealBindingOf(input: SealBinding): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!UNBOUND_FIELDS.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}

/** JSON with object keys sorted recursively; `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function aadFor(kid: string, binding: SealBinding): Promise<Uint8Array> {
  const digest = await subtle().digest(
    "SHA-256",
    utf8.encode(canonicalJson(sealBindingOf(binding))),
  );
  return utf8.encode(`${INFO}|${kid}|${toHex(new Uint8Array(digest))}`);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * WebCrypto types derived from the runtime global, not from lib.dom: the
 * worker compiles with `lib: ["esnext"]` + @types/node, where `CryptoKey`
 * and friends are not global names, while www compiles with lib.dom. Both
 * expose `globalThis.crypto.subtle`, so the types are taken from there.
 */
type Subtle = typeof globalThis.crypto.subtle;
type AnyKey = Awaited<ReturnType<Subtle["importKey"]>>;
type KeyPair = Extract<
  Awaited<ReturnType<Subtle["generateKey"]>>,
  { privateKey: unknown; publicKey: unknown }
>;

function subtle(): Subtle {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error("payload-seal: WebCrypto (crypto.subtle) is unavailable");
  }
  return c.subtle;
}

// --- keys ----------------------------------------------------------------------

/** Parse the www env form `<kid>:<base64url raw public key>`. */
export function parsePlanePublicKey(rawText: string): PlanePublicKey {
  // A `wrangler secret put` paste can carry a trailing newline; never let
  // that fail every dispatch.
  const text = rawText.trim();
  const idx = text.indexOf(":");
  if (idx <= 0) {
    throw new PlaneKeyParseError(
      "payload-seal: plane public key must be <kid>:<base64url>",
    );
  }
  const kid = text.slice(0, idx);
  const publicKey = text.slice(idx + 1);
  if (!KID_RE.test(kid)) {
    throw new PlaneKeyParseError(
      "payload-seal: plane key id has an invalid character set",
    );
  }
  let raw: Uint8Array;
  try {
    raw = fromBase64Url(publicKey);
  } catch {
    throw new PlaneKeyParseError(
      "payload-seal: plane public key is not base64url",
    );
  }
  if (raw.length !== X25519_KEY_BYTES) {
    throw new PlaneKeyParseError(
      `payload-seal: plane public key must be ${X25519_KEY_BYTES} raw bytes`,
    );
  }
  return { kid, publicKey };
}

/** The www env form of a plane public key (the inverse of parsePlanePublicKey). */
export function formatPlanePublicKey(pk: PlanePublicKey): string {
  return `${pk.kid}:${pk.publicKey}`;
}

/** Shape guard for a key-file entry; never logs the private scalar. */
export function isPlanePrivateKey(value: unknown): value is PlanePrivateKey {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { kid?: unknown; privateKeyJwk?: unknown };
  if (typeof v.kid !== "string" || !KID_RE.test(v.kid)) return false;
  const j = v.privateKeyJwk as Partial<X25519PrivateJwk> | null | undefined;
  return (
    typeof j === "object" &&
    j !== null &&
    j.kty === "OKP" &&
    j.crv === "X25519" &&
    typeof j.x === "string" &&
    B64URL_RE.test(j.x) &&
    typeof j.d === "string" &&
    B64URL_RE.test(j.d)
  );
}

/** Shape guard for the wire envelope (the worker's first check on an input). */
export function isSealedRunSecrets(value: unknown): value is SealedRunSecrets {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === PAYLOAD_SEAL_VERSION &&
    typeof v.kid === "string" &&
    typeof v.epk === "string" &&
    typeof v.iv === "string" &&
    typeof v.ct === "string"
  );
}

/** The public half of a private key entry (for the boot self-check and the key script). */
export function publicKeyOf(priv: PlanePrivateKey): PlanePublicKey {
  return { kid: priv.kid, publicKey: priv.privateKeyJwk.x };
}

/** Generate a fresh plane key pair under `kid`. */
export async function generatePlaneKeyPair(
  kid: string,
): Promise<{ publicKey: PlanePublicKey; privateKey: PlanePrivateKey }> {
  if (!KID_RE.test(kid)) {
    throw new Error("payload-seal: plane key id has an invalid character set");
  }
  const s = subtle();
  const pair = (await s.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as KeyPair;
  const jwk = await s.exportKey("jwk", pair.privateKey);
  if (
    jwk.kty !== "OKP" ||
    jwk.crv !== "X25519" ||
    typeof jwk.x !== "string" ||
    typeof jwk.d !== "string"
  ) {
    throw new Error("payload-seal: unexpected X25519 JWK export shape");
  }
  const privateKeyJwk: X25519PrivateJwk = {
    kty: "OKP",
    crv: "X25519",
    x: jwk.x,
    d: jwk.d,
  };
  return {
    publicKey: { kid, publicKey: jwk.x },
    privateKey: { kid, privateKeyJwk },
  };
}

// --- seal / unseal --------------------------------------------------------------

async function deriveAesKey(
  sharedSecret: ArrayBuffer,
  salt: Uint8Array,
  usage: "encrypt" | "decrypt",
): Promise<AnyKey> {
  const s = subtle();
  const ikm = await s.importKey("raw", sharedSecret, "HKDF", false, [
    "deriveKey",
  ]);
  return s.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8.encode(INFO) },
    ikm,
    { name: "AES-GCM", length: AES_KEY_BITS },
    false,
    [usage],
  );
}

function assertRunSecrets(value: unknown): asserts value is RunSecrets {
  if (typeof value !== "object" || value === null) throw new Error("shape");
  const v = value as Record<string, unknown>;
  if (typeof v.installationToken !== "string" || v.installationToken === "") {
    throw new Error("shape");
  }
  if (typeof v.daemonToken !== "string" || v.daemonToken === "") {
    throw new Error("shape");
  }
  if (
    v.githubReadToken !== undefined &&
    (typeof v.githubReadToken !== "string" || v.githubReadToken === "")
  ) {
    throw new Error("shape");
  }
  if (
    v.selfHealToken !== undefined &&
    (typeof v.selfHealToken !== "string" || v.selfHealToken === "")
  ) {
    throw new Error("shape");
  }
  if (v.repoEnv !== undefined) {
    if (typeof v.repoEnv !== "object" || v.repoEnv === null) {
      throw new Error("shape");
    }
    for (const [k, val] of Object.entries(v.repoEnv)) {
      if (typeof k !== "string" || typeof val !== "string") {
        throw new Error("shape");
      }
    }
  }
}

/** Exactly the RunSecrets fields of `value`, in a fixed order — never a spread. */
function pickRunSecrets(value: RunSecrets): RunSecrets {
  return {
    installationToken: value.installationToken,
    ...(value.githubReadToken !== undefined
      ? { githubReadToken: value.githubReadToken }
      : {}),
    daemonToken: value.daemonToken,
    ...(value.repoEnv !== undefined ? { repoEnv: { ...value.repoEnv } } : {}),
    ...(value.selfHealToken !== undefined
      ? { selfHealToken: value.selfHealToken }
      : {}),
  };
}

/**
 * Seal `secrets` to the plane key, bound to the WHOLE persisted input (AAD =
 * INFO|kid|SHA-256 of its canonical JSON minus the envelope and the plain-text
 * secret fields). Every call makes a
 * fresh ephemeral key and IV, so two seals of the same secrets never share a
 * byte of envelope.
 */
export async function sealRunSecrets(
  pk: PlanePublicKey,
  secrets: RunSecrets,
  binding: SealBinding,
): Promise<SealedRunSecrets> {
  if (!KID_RE.test(pk.kid)) {
    throw new Error("payload-seal: plane key id has an invalid character set");
  }
  const s = subtle();
  const planeRaw = fromBase64Url(pk.publicKey);
  if (planeRaw.length !== X25519_KEY_BYTES) {
    throw new Error("payload-seal: plane public key has the wrong length");
  }
  const planePk = await s.importKey(
    "raw",
    planeRaw,
    { name: "X25519" },
    false,
    [
      // The static key takes no usages: X25519 import of a public key allows [].
    ],
  );
  // Non-extractable: only the public half is ever exported, and public keys
  // export regardless of the flag.
  const eph = (await s.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ])) as KeyPair;
  const ephRaw = new Uint8Array(await s.exportKey("raw", eph.publicKey));
  const shared = await s.deriveBits(
    { name: "X25519", public: planePk },
    eph.privateKey,
    AES_KEY_BITS,
  );
  const key = await deriveAesKey(shared, concat(ephRaw, planeRaw), "encrypt");
  const iv = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  // Only the RunSecrets fields, never a spread of the caller's object: a
  // stray property on `secrets` must not travel in the envelope.
  const plaintext = pickRunSecrets(secrets);
  assertRunSecrets(plaintext);
  const ct = await s.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: await aadFor(pk.kid, binding),
      tagLength: GCM_TAG_BYTES * 8,
    },
    key,
    utf8.encode(JSON.stringify(plaintext)),
  );
  return {
    v: PAYLOAD_SEAL_VERSION,
    kid: pk.kid,
    epk: toBase64Url(ephRaw),
    iv: toBase64Url(iv),
    ct: toBase64Url(new Uint8Array(ct)),
  };
}

/**
 * Unseal with the key whose `kid` matches. Every failure is a PayloadSealError
 * naming only the kid and a failure class: unknown kid, a version other than
 * 1, an undecodable field, a key that cannot be imported, a derive failure
 * (e.g. a low-order ephemeral point), a bad tag (wrong key, any binding
 * field changed, any flipped byte), or a plaintext that is not RunSecrets.
 */
export async function unsealRunSecrets(
  keys: readonly PlanePrivateKey[],
  sealed: SealedRunSecrets,
  binding: SealBinding,
): Promise<RunSecrets> {
  const kid = typeof sealed?.kid === "string" ? sealed.kid : "";
  if (!isSealedRunSecrets(sealed)) {
    throw new PayloadSealError(
      sealed &&
      typeof sealed === "object" &&
      (sealed as { v?: unknown }).v !== PAYLOAD_SEAL_VERSION
        ? "version"
        : "malformed",
      kid,
    );
  }
  const key = keys.find((k) => k.kid === sealed.kid);
  if (!key) throw new PayloadSealError("unknown-kid", kid);
  let ephRaw: Uint8Array;
  let iv: Uint8Array;
  let ct: Uint8Array;
  let planeRaw: Uint8Array;
  try {
    ephRaw = fromBase64Url(sealed.epk);
    iv = fromBase64Url(sealed.iv);
    ct = fromBase64Url(sealed.ct);
    planeRaw = fromBase64Url(key.privateKeyJwk.x);
  } catch {
    throw new PayloadSealError("malformed", kid);
  }
  if (
    ephRaw.length !== X25519_KEY_BYTES ||
    iv.length !== IV_BYTES ||
    ct.length < GCM_TAG_BYTES ||
    planeRaw.length !== X25519_KEY_BYTES
  ) {
    throw new PayloadSealError("malformed", kid);
  }
  const s = subtle();
  let planeSk: AnyKey;
  let ephPk: AnyKey;
  try {
    planeSk = await s.importKey(
      "jwk",
      key.privateKeyJwk,
      { name: "X25519" },
      false,
      ["deriveBits"],
    );
    ephPk = await s.importKey("raw", ephRaw, { name: "X25519" }, false, []);
  } catch {
    throw new PayloadSealError("key", kid);
  }
  let aesKey: AnyKey;
  try {
    const shared = await s.deriveBits(
      { name: "X25519", public: ephPk },
      planeSk,
      AES_KEY_BITS,
    );
    aesKey = await deriveAesKey(shared, concat(ephRaw, planeRaw), "decrypt");
  } catch {
    throw new PayloadSealError("derive", kid);
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await s.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: await aadFor(sealed.kid, binding),
        tagLength: GCM_TAG_BYTES * 8,
      },
      aesKey,
      ct,
    );
  } catch {
    throw new PayloadSealError("tag", kid);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(plaintext));
    assertRunSecrets(parsed);
  } catch {
    throw new PayloadSealError("malformed", kid);
  }
  return pickRunSecrets(parsed);
}

/** The string-valued secret field names — the one list every "no plain-text" check reads. */
export const RUN_SECRET_FIELDS = [
  "installationToken",
  "githubReadToken",
  "daemonToken",
  "selfHealToken",
] as const;
