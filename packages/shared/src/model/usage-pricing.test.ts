import { describe, it, expect } from "vitest";
import {
  getAnthropicMessagesSkuForModel,
  ANTHROPIC_MESSAGES_FABLE_SKU,
  ANTHROPIC_MESSAGES_OPUS_SKU,
  ANTHROPIC_MESSAGES_SONNET_SKU,
  USAGE_SKU_PRICING,
} from "./usage-pricing";

describe("getAnthropicMessagesSkuForModel — fable routing", () => {
  it("routes claude-fable upstream ids to the dedicated fable SKU", () => {
    // Falling through to the default bucket would hide Fable spend inside the
    // legacy-opus line in usage reports; the dedicated SKU keeps the
    // placeholder pricing auditable until official list prices land.
    expect(getAnthropicMessagesSkuForModel("claude-fable-5")).toBe(
      ANTHROPIC_MESSAGES_FABLE_SKU,
    );
    expect(getAnthropicMessagesSkuForModel("claude-mythos-5")).toBe(
      ANTHROPIC_MESSAGES_FABLE_SKU,
    );
  });

  it("leaves existing buckets untouched", () => {
    expect(getAnthropicMessagesSkuForModel("claude-opus-4-1")).toBe(
      ANTHROPIC_MESSAGES_OPUS_SKU,
    );
    expect(getAnthropicMessagesSkuForModel("claude-sonnet-5")).toBe(
      ANTHROPIC_MESSAGES_SONNET_SKU,
    );
  });

  it("fable placeholder pricing is the HIGHEST anthropic bucket, never lower", () => {
    // Deliberate: over-billing a premium model is correctable; silently
    // under-billing is not. This pin fails if someone lowers the placeholder
    // without adding real list prices.
    const fable = USAGE_SKU_PRICING[ANTHROPIC_MESSAGES_FABLE_SKU]!;
    const opus = USAGE_SKU_PRICING[ANTHROPIC_MESSAGES_OPUS_SKU]!;
    expect(fable.inputRatePerToken).toBeGreaterThanOrEqual(
      opus.inputRatePerToken,
    );
    expect(fable.outputRatePerToken).toBeGreaterThanOrEqual(
      opus.outputRatePerToken,
    );
  });
});
