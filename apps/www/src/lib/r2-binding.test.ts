import { describe, it, expect } from "vitest";
import { getR2Binding } from "./r2-binding";

describe("getR2Binding (off-Workers)", () => {
  it("returns undefined when there is no Cloudflare context (node/test → S3 path)", () => {
    expect(getR2Binding("R2_BUCKET")).toBeUndefined();
    expect(getR2Binding("R2_PRIVATE_BUCKET")).toBeUndefined();
  });
});
