/**
 * The batteries image reference a container run starts from (ADR-013 I5:
 * "the worker runs images by digest only").
 *
 * `WORKER_BATTERIES_IMAGE` must name ONE immutable image:
 * `<repository>@sha256:<64 lowercase hex>`. A tag (`:latest`, `:sha-abc`) is
 * refused, and so is a reference carrying both a tag and a digest
 * (`repo:tag@sha256:…`): Docker resolves that by the digest and ignores the
 * tag, so the tag would be a label that lies about what runs.
 *
 * Pure: no I/O. Whether the digest is present in the rootless daemon's store
 * is checked at boot by the runtime adapter (container-runtime.ts).
 */

/** A parsed, digest-pinned image reference. */
export interface PinnedImage {
  /** The repository part, e.g. `ghcr.io/be-automata/automata-batteries`. */
  repository: string;
  /** `sha256:<64 hex>`. */
  digest: string;
  /** `<repository>@<digest>`: the exact string passed to `docker create`. */
  reference: string;
}

/** Thrown for any reference that is not `<repository>@sha256:<hex>`. */
export class ImageReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageReferenceError";
  }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
// A registry host (optionally with a port) followed by lowercase path
// components. Docker's own grammar, narrowed: no uppercase, no empty
// component, no leading or trailing separator.
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const REGISTRY_HOST = /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;

/**
 * Parse `raw` as a digest-pinned reference, or throw ImageReferenceError
 * naming what is wrong. The message never echoes more than the reference
 * itself (it carries no secret).
 */
export function parsePinnedImage(raw: string | undefined): PinnedImage {
  const value = raw?.trim() ?? "";
  if (!value) {
    throw new ImageReferenceError(
      "WORKER_BATTERIES_IMAGE is empty: container runs need the batteries image pinned by digest (ghcr.io/be-automata/automata-batteries@sha256:<digest>)",
    );
  }
  if (/\s/.test(value)) {
    throw new ImageReferenceError(
      `WORKER_BATTERIES_IMAGE ${JSON.stringify(value)} contains whitespace`,
    );
  }
  const at = value.indexOf("@");
  if (at < 0) {
    throw new ImageReferenceError(
      `WORKER_BATTERIES_IMAGE ${JSON.stringify(value)} is not pinned by digest: a tag can move under a running box (ADR-013 I5); use <repository>@sha256:<digest>`,
    );
  }
  if (value.indexOf("@", at + 1) >= 0) {
    throw new ImageReferenceError(
      `WORKER_BATTERIES_IMAGE ${JSON.stringify(value)} has more than one '@'`,
    );
  }
  const repository = value.slice(0, at);
  const digest = value.slice(at + 1);
  if (!DIGEST.test(digest)) {
    throw new ImageReferenceError(
      `WORKER_BATTERIES_IMAGE digest ${JSON.stringify(digest)} is not sha256:<64 lowercase hex>`,
    );
  }
  assertRepository(repository, value);
  return { repository, digest, reference: `${repository}@${digest}` };
}

function assertRepository(repository: string, whole: string): void {
  if (!repository) {
    throw new ImageReferenceError(
      `WORKER_BATTERIES_IMAGE ${JSON.stringify(whole)} names no repository`,
    );
  }
  const parts = repository.split("/");
  // A first component with a '.' or ':' (or `localhost`) is a registry host,
  // which may carry a port; every other component is a path component.
  const first = parts[0] ?? "";
  const hasHost =
    parts.length > 1 &&
    (first.includes(".") || first.includes(":") || first === "localhost");
  const pathParts = hasHost ? parts.slice(1) : parts;
  if (hasHost && !REGISTRY_HOST.test(first)) {
    throw new ImageReferenceError(
      `WORKER_BATTERIES_IMAGE registry ${JSON.stringify(first)} is not a host[:port]`,
    );
  }
  const last = pathParts[pathParts.length - 1] ?? "";
  // `repo:tag@sha256:…` — the colon is in the LAST path component (a port
  // only ever sits on the host). Docker would run the digest and ignore the
  // tag; refuse the ambiguity instead of logging a misleading tag.
  if (last.includes(":")) {
    throw new ImageReferenceError(
      `WORKER_BATTERIES_IMAGE ${JSON.stringify(whole)} carries a tag next to its digest; pin the digest alone`,
    );
  }
  for (const part of pathParts) {
    if (!PATH_COMPONENT.test(part)) {
      throw new ImageReferenceError(
        `WORKER_BATTERIES_IMAGE path component ${JSON.stringify(part)} is not a valid lowercase repository name`,
      );
    }
  }
}
