import { describe, it, expect } from "vitest";
import { validateProxyRequestModel } from "./proxy-model-validation";
import { NextRequest } from "next/server";

describe("validateProxyRequestModel", () => {
  it("accepts a Claude Fable model on the anthropic proxy (credits runs on fable)", async () => {
    // A useCredits run with the fable model sends the upstream id
    // (claude-fable-5) through /api/proxy/anthropic; before the matcher was
    // added the proxy 400'd it with "Only Claude Sonnet, Haiku, or Opus…".
    const request = new NextRequest("https://example.com", { method: "POST" });
    const body = JSON.stringify({ model: "claude-fable-5" });
    const bodyBuffer = new TextEncoder().encode(body).buffer;
    const result = await validateProxyRequestModel({
      request,
      provider: "anthropic",
      bodyBuffer,
    });
    expect(result).toEqual({ valid: true });
  });

  it("still rejects a non-Claude model on the anthropic proxy", async () => {
    const request = new NextRequest("https://example.com", { method: "POST" });
    const body = JSON.stringify({ model: "gpt-5.2" });
    const bodyBuffer = new TextEncoder().encode(body).buffer;
    const result = await validateProxyRequestModel({
      request,
      provider: "anthropic",
      bodyBuffer,
    });
    expect(result.valid).toBe(false);
  });

  it("should validate a valid openrouter model", async () => {
    const request = new NextRequest("https://example.com", {
      method: "POST",
    });
    const body = JSON.stringify({ model: "google/gemini-2.5-pro" });
    const bodyBuffer = new TextEncoder().encode(body).buffer;
    const result = await validateProxyRequestModel({
      request,
      provider: "openrouter",
      bodyBuffer,
    });
    expect(result).toEqual({ valid: true });
  });

  it("should reject an invalid openrouter model", async () => {
    const request = new NextRequest("https://example.com", {
      method: "POST",
    });
    const body = JSON.stringify({ model: "invalid/model" });
    const bodyBuffer = new TextEncoder().encode(body).buffer;
    const result = await validateProxyRequestModel({
      request,
      provider: "openrouter",
      bodyBuffer,
    });
    expect(result).toEqual({
      valid: false,
      error: "Invalid model requested: invalid/model",
    });
  });
});
