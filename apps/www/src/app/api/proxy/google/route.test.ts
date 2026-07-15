import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import * as googleAIStudioRoute from "./[[...path]]/route";
import { logGoogleUsage } from "./log-google-usage";
import { auth } from "@/lib/auth";
import { getUserCreditBalance } from "@terragon/shared/model/credits";
import { isStripeConfigured } from "@/server-lib/stripe";

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      verifyApiKey: vi.fn(),
    },
  },
}));

vi.mock("@terragon/shared/model/credits", () => ({
  getUserCreditBalance: vi.fn(),
}));

vi.mock("@/server-lib/stripe", () => ({
  isStripeConfigured: vi.fn(() => true),
}));

vi.mock("@/server-lib/credit-auto-reload", () => ({
  maybeTriggerCreditAutoReload: vi.fn(),
}));

vi.mock("@terragon/env/apps-www", () => ({
  env: {
    GOOGLE_AI_STUDIO_API_KEY: "test-google-ai-studio-key",
  },
}));

vi.mock("./log-google-usage", () => ({
  logGoogleUsage: vi.fn(),
}));

const encoder = new TextEncoder();

function createRequest({
  method = "POST",
  headers = {},
  body,
  url = "https://example.com/api/proxy/google-ai-studio",
  includeDefaultToken = true,
}: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  url?: string;
  includeDefaultToken?: boolean;
} = {}): NextRequest {
  const mergedHeaders = new Headers(headers);

  const hasDaemonToken =
    mergedHeaders.has("X-Daemon-Token") ||
    /^\s*Bearer\s+/i.test(mergedHeaders.get("authorization") ?? "");

  if (includeDefaultToken && !hasDaemonToken) {
    mergedHeaders.set("X-Daemon-Token", "test-daemon-token");
  }

  const arrayBuffer =
    body === undefined
      ? vi.fn().mockResolvedValue(new ArrayBuffer(0))
      : vi.fn().mockResolvedValue(encoder.encode(JSON.stringify(body)).buffer);

  return {
    method,
    headers: mergedHeaders,
    nextUrl: new URL(url),
    arrayBuffer,
  } as unknown as NextRequest;
}

describe("Google AI Studio proxy route", () => {
  const verifyApiKeyMock = vi.mocked(auth.api.verifyApiKey);
  const getUserCreditBalanceMock = vi.mocked(getUserCreditBalance);
  const logUsageMock = vi.mocked(logGoogleUsage);
  const { POST } = googleAIStudioRoute;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    verifyApiKeyMock.mockResolvedValue({
      valid: true,
      error: null,
      key: { userId: "user-123" } as any,
    });
    getUserCreditBalanceMock.mockResolvedValue({
      totalCreditsCents: 1_000,
      totalUsageCents: 0,
      balanceCents: 1_000,
    });
    logUsageMock.mockReset();
    logUsageMock.mockImplementation(async () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("logs usage for JSON responses", async () => {
    const responsePayload = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: "Hello! How can I help you today?",
              },
            ],
            role: "model",
          },
          finishReason: "STOP",
          safetyRatings: [],
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      },
      modelVersion: "gemini-2.5-pro",
    };

    const fetchResponse = new Response(JSON.stringify(responsePayload), {
      headers: {
        "content-type": "application/json",
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(fetchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      body: {
        model: "gemini-2.5-pro",
        contents: [{ parts: [{ text: "Hello" }] }],
      },
      url: "https://example.com/api/proxy/google/v1/models/gemini-2.5-pro:generateContent",
    });
    const response = await POST(request, {
      params: Promise.resolve({
        path: ["v1", "models", "gemini-2.5-pro:generateContent"],
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchArgs = fetchMock.mock.calls[0]!;
    const fetchUrl = fetchArgs[0] as URL;
    expect(fetchUrl.origin).toBe("https://generativelanguage.googleapis.com");
    expect(fetchUrl.searchParams.get("key")).toBe("test-google-ai-studio-key");

    expect(logUsageMock).toHaveBeenCalledTimes(1);
    expect(logUsageMock).toHaveBeenCalledWith({
      path: fetchUrl.pathname,
      usage: responsePayload.usageMetadata,
      userId: "user-123",
      organizationId: null,      model: "gemini-2.5-pro",
    });
  });

  it("authorizes requests using the Authorization header token", async () => {
    const fetchResponse = new Response(
      JSON.stringify({
        candidates: [],
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          totalTokenCount: 0,
        },
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    );

    const fetchMock = vi.fn().mockResolvedValue(fetchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      includeDefaultToken: false,
      headers: {
        Authorization: "Bearer another-daemon-token",
      },
      body: {
        model: "gemini-2.5-pro",
        contents: [],
      },
      url: "https://example.com/api/proxy/google/v1/models/gemini-2.5-pro:generateContent",
    });

    await POST(request, {
      params: Promise.resolve({
        path: ["v1", "models", "gemini-2.5-pro:generateContent"],
      }),
    });

    expect(verifyApiKeyMock).toHaveBeenCalledWith({
      body: { key: "another-daemon-token" },
    });

    const fetchUrl = fetchMock.mock.calls[0]![0] as URL;
    expect(fetchUrl.searchParams.get("key")).toBe("test-google-ai-studio-key");
  });

  it("rejects requests when user has no remaining credits", async () => {
    getUserCreditBalanceMock.mockResolvedValueOnce({
      totalCreditsCents: 0,
      totalUsageCents: 0,
      balanceCents: 0,
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest();
    const response = await POST(request, {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(402);
    expect(await response.text()).toBe("Insufficient credits");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips the credit check and does not 402 when Stripe is not configured", async () => {
    vi.mocked(isStripeConfigured).mockReturnValueOnce(false);

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest();
    const response = await POST(request, { params: Promise.resolve({}) });

    // Fail open: with billing off the zero-credit gate is skipped entirely — the
    // credit balance is never read and the request is not 402'd.
    expect(response.status).not.toBe(402);
    expect(getUserCreditBalanceMock).not.toHaveBeenCalled();
  });

  it("logs usage for streaming responses", async () => {
    const events = [
      {
        data: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "Hello" }],
                role: "model",
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
          },
          modelVersion: "gemini-2.5-pro",
        }),
      },
      {
        data: "[DONE]",
      },
    ];

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const { data } of events) {
          const chunk = `data: ${data}\n\n`;
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    const fetchResponse = new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(fetchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      body: {
        model: "gemini-2.5-pro",
        contents: [{ parts: [{ text: "Hello" }] }],
      },
      url: "https://example.com/api/proxy/google/v1/models/gemini-2.5-pro:streamGenerateContent",
    });
    const response = await POST(request, {
      params: Promise.resolve({
        path: ["v1", "models", "gemini-2.5-pro:streamGenerateContent"],
      }),
    });

    // Consume the response stream to allow the logging stream to process
    const bodyText = await response.text();
    expect(bodyText).toContain("gemini-2.5-pro");

    // Wait for async logging to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(logUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
        userId: "user-123",
        organizationId: null,        model: "gemini-2.5-pro",
      }),
    );
  });

  it("forwards custom paths correctly", async () => {
    const fetchResponse = new Response(
      JSON.stringify({
        candidates: [],
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          totalTokenCount: 0,
        },
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    );

    const fetchMock = vi.fn().mockResolvedValue(fetchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      url: "https://example.com/api/proxy/google/v1/models/gemini-2.5-pro:generateContent",
      body: {
        model: "gemini-2.5-pro",
        contents: [{ parts: [{ text: "Test" }] }],
      },
    });

    await POST(request, {
      params: Promise.resolve({
        path: ["v1", "models", "gemini-2.5-pro:generateContent"],
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchArgs = fetchMock.mock.calls[0]!;
    const fetchUrl = fetchArgs[0] as URL;
    expect(fetchUrl.pathname).toBe(
      "/v1beta/models/gemini-2.5-pro:generateContent",
    );
  });

  it("rejects requests with non-Gemini 2.5/3 models", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      body: {
        model: "gemini-1.5-flash",
        contents: [{ parts: [{ text: "hi" }] }],
      },
      url: "https://example.com/api/proxy/google/v1/models/gemini-1.5-flash:generateContent",
    });
    const response = await POST(request, {
      params: Promise.resolve({
        path: ["v1", "models", "gemini-1.5-flash:generateContent"],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid model requested");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects requests with gemini-1.0-pro", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      body: {
        model: "gemini-1.0-pro",
        contents: [{ parts: [{ text: "hi" }] }],
      },
      url: "https://example.com/api/proxy/google/v1/models/gemini-1.0-pro:generateContent",
    });
    const response = await POST(request, {
      params: Promise.resolve({
        path: ["v1", "models", "gemini-1.0-pro:generateContent"],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid model requested");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts requests with gemini-2.5-pro model", async () => {
    const responsePayload = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: "Hello!",
              },
            ],
            role: "model",
          },
          finishReason: "STOP",
          safetyRatings: [],
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
      modelVersion: "gemini-2.5-pro",
    };
    const fetchResponse = new Response(JSON.stringify(responsePayload), {
      headers: {
        "content-type": "application/json",
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(fetchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      body: {
        model: "gemini-2.5-pro",
        contents: [{ parts: [{ text: "hi" }] }],
      },
      url: "https://example.com/api/proxy/google/v1/models/gemini-2.5-pro:generateContent",
    });
    const response = await POST(request, {
      params: Promise.resolve({
        path: ["v1", "models", "gemini-2.5-pro:generateContent"],
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts requests with gemini-3-pro model", async () => {
    const responsePayload = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: "Hello!",
              },
            ],
            role: "model",
          },
          finishReason: "STOP",
          safetyRatings: [],
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
      modelVersion: "gemini-3-pro",
    };
    const fetchResponse = new Response(JSON.stringify(responsePayload), {
      headers: {
        "content-type": "application/json",
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(fetchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest({
      body: {
        model: "gemini-3-pro",
        contents: [{ parts: [{ text: "hi" }] }],
      },
      url: "https://example.com/api/proxy/google/v1/models/gemini-3-pro:generateContent",
    });
    const response = await POST(request, {
      params: Promise.resolve({
        path: ["v1", "models", "gemini-3-pro:generateContent"],
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
