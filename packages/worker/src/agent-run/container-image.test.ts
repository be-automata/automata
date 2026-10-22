import { describe, expect, it } from "vitest";

import { ImageReferenceError, parsePinnedImage } from "./container-image";

const DIGEST = `sha256:${"a1".repeat(32)}`;
const REPO = "ghcr.io/be-automata/automata-batteries";

describe("parsePinnedImage (ADR-013 I5: digest only)", () => {
  // card: protects=the exact `<repo>@sha256:<hex>` WORKER_BATTERIES_IMAGE form is accepted and split; fails_when=a valid pin is refused or the reference handed to docker differs from the input; no_claim=that the digest exists in any registry or daemon store
  it("accepts a GHCR repository pinned by digest", () => {
    expect(parsePinnedImage(`${REPO}@${DIGEST}`)).toEqual({
      repository: REPO,
      digest: DIGEST,
      reference: `${REPO}@${DIGEST}`,
    });
  });

  // card: protects=a local registry host with a port is still a valid pinned reference (the port colon is not a tag); fails_when=host:port is mistaken for a tag; no_claim=registry reachability
  it("accepts a registry host with a port", () => {
    expect(
      parsePinnedImage(`localhost:5000/automata-batteries@${DIGEST}`)
        .repository,
    ).toBe("localhost:5000/automata-batteries");
  });

  // card: protects=surrounding whitespace from an env file does not defeat the pin; fails_when=a trimmed valid pin is refused; no_claim=anything about interior whitespace (refused below)
  it("trims surrounding whitespace", () => {
    expect(parsePinnedImage(`  ${REPO}@${DIGEST}\n`).reference).toBe(
      `${REPO}@${DIGEST}`,
    );
  });

  // card: protects=a tag reference is REFUSED (a tag can move under a running box); fails_when=`:latest` or `:sha-…` parses; no_claim=nothing about digests
  it.each([
    `${REPO}:latest`,
    `${REPO}:sha-8fcf0bce`,
    REPO,
    "automata-batteries:dev",
  ])("refuses the tag reference %s", (ref) => {
    expect(() => parsePinnedImage(ref)).toThrow(/not pinned by digest/);
  });

  // card: protects=`repo:tag@digest` is refused instead of logging a tag Docker ignores; fails_when=it parses; no_claim=Docker's own resolution rules
  it("refuses a tag next to the digest", () => {
    expect(() => parsePinnedImage(`${REPO}:v1@${DIGEST}`)).toThrow(
      /tag next to its digest/,
    );
  });

  // card: protects=only sha256 with exactly 64 lowercase hex is a digest; fails_when=a short, uppercase or non-sha256 digest parses; no_claim=the digest's content
  it.each([
    `${REPO}@sha256:${"a1".repeat(31)}`,
    `${REPO}@sha256:${"A1".repeat(32)}`,
    `${REPO}@sha512:${"a1".repeat(64)}`,
    `${REPO}@${"a1".repeat(32)}`,
  ])("refuses the malformed digest in %s", (ref) => {
    expect(() => parsePinnedImage(ref)).toThrow(ImageReferenceError);
  });

  // card: protects=an empty/unset knob is refused with a message naming the expected form; fails_when=empty parses to a reference; no_claim=the switch logic (container-config.test.ts)
  it.each([undefined, "", "   "])("refuses an empty value (%j)", (v) => {
    expect(() => parsePinnedImage(v)).toThrow(/is empty/);
  });

  // card: protects=no uppercase/invalid repository and no interior whitespace or double '@'; fails_when=any of them parses; no_claim=the full OCI grammar
  it.each([
    `GHCR.io/Be-Automata/Batteries@${DIGEST}`,
    `ghcr.io//batteries@${DIGEST}`,
    `@${DIGEST}`,
    `${REPO} @${DIGEST}`,
    `${REPO}@${DIGEST}@${DIGEST}`,
  ])("refuses the malformed reference %s", (ref) => {
    expect(() => parsePinnedImage(ref)).toThrow(ImageReferenceError);
  });
});
