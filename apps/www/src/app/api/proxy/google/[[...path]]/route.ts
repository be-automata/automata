import { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserCreditBalance } from "@terragon/shared/model/credits";
import { isStripeConfigured } from "@/server-lib/stripe";
import { maybeTriggerCreditAutoReload } from "@/server-lib/credit-auto-reload";
import { logGoogleUsage } from "../log-google-usage";
import { waitUntil } from "@/lib/wait-until";
import { validateProxyRequestModel } from "@/server-lib/proxy-model-validation";
import { daemonTokenContextFromApiKey } from "@/lib/daemon-token-context";

const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/";
const DEFAULT_PATH = "v1beta/models/gemini-2.5-pro:streamGenerateContent";

export const dynamic = "force-dynamic";

type HandlerArgs = { params: Promise<{ path?: string[] }> };
type AuthContext = { userId: string; organizationId: string | null };

function getDaemonTokenFromHeaders(headers: Headers) {
  const directToken = headers.get("X-Daemon-Token");
  if (directToken && directToken.trim() !== "") {
    return directToken.trim();
  }
  // We're acting as a proxy for Google AI Studio, so we piggy back the daemon token as the GEMINI_API_KEY
  const googleApiKey = headers.get("x-goog-api-key");
  if (googleApiKey && googleApiKey.trim() !== "") {
    return googleApiKey.trim();
  }
  const authHeader = headers.get("authorization");
  if (!authHeader) {
    return null;
  }

  const match = authHeader.match(/^\s*Bearer\s+(.*)$/i);
  if (match && match[1]) {
    const token = match[1]!.trim();
    return token === "" ? null : token;
  }

  return null;
}

function buildTargetUrl(
  request: NextRequest,
  pathSegments: string[] | undefined,
) {
  let pathname =
    pathSegments && pathSegments.length > 0
      ? pathSegments.join("/")
      : DEFAULT_PATH;
  // Replace /v1/models with /v1beta/models
  pathname = pathname.replace("v1/models", "v1beta/models");
  const targetUrl = new URL(pathname, GOOGLE_API_BASE);
  // Add API key as query parameter
  const apiKey = getApiKey();
  if (apiKey) {
    targetUrl.searchParams.set("key", apiKey);
  }

  // Copy all other search params
  for (const [key, value] of request.nextUrl.searchParams.entries()) {
    if (key !== "key") {
      targetUrl.searchParams.set(key, value);
    }
  }

  return targetUrl;
}

function getApiKey(): string {
  return env.GOOGLE_AI_STUDIO_API_KEY;
}

function isGenerateContentPath(pathname: string) {
  return (
    pathname.includes("generateContent") ||
    pathname.includes("streamGenerateContent")
  );
}

function shouldLogUsage(pathname: string) {
  return isGenerateContentPath(pathname);
}

function isJsonContentType(contentType: string | null) {
  return Boolean(contentType && contentType.includes("application/json"));
}

function isEventStreamContentType(contentType: string | null) {
  return Boolean(contentType && contentType.includes("text/event-stream"));
}

function findEventSeparator(buffer: string) {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  if (lfIndex === -1 && crlfIndex === -1) {
    return null;
  }
  if (lfIndex !== -1 && (crlfIndex === -1 || lfIndex < crlfIndex)) {
    return { index: lfIndex, length: 2 } as const;
  }
  return { index: crlfIndex, length: 4 } as const;
}

async function logUsageFromEventStream({
  stream,
  targetUrl,
  userId,
  organizationId,
  model,
}: {
  stream: ReadableStream<Uint8Array>;
  targetUrl: URL;
  userId: string;
  organizationId: string | null;
  model?: string;
}) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let logged = false;
  let doneReading = false;

  const processBuffer = async () => {
    let separator = findEventSeparator(buffer);
    while (separator) {
      const rawEvent = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      const lines = rawEvent.split(/\r?\n/);
      const dataLines = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length > 0) {
        const payload = dataLines.join("\n");
        if (payload === "[DONE]") {
          separator = findEventSeparator(buffer);
          continue;
        }
        try {
          const parsed = JSON.parse(payload);
          if (parsed?.usageMetadata) {
            await logGoogleUsage({
              path: targetUrl.pathname,
              usage: parsed.usageMetadata,
              userId,
              organizationId,
              model: model ?? parsed.modelVersion ?? undefined,
            });
            return true;
          }
        } catch (_error) {
          // Ignore payloads that are not JSON objects
          console.log("Failed to parse event stream payload:", payload);
        }
      }
      separator = findEventSeparator(buffer);
    }
    return false;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        logged = (await processBuffer()) || logged;
        if (logged && !done) {
          break;
        }
      }
      if (done) {
        buffer += decoder.decode();
        logged = (await processBuffer()) || logged;
        doneReading = true;
        break;
      }
    }
  } catch (error) {
    console.error("Failed to log Google usage (event-stream)", error);
  } finally {
    if (!doneReading) {
      await reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }
}

async function proxyRequest(
  request: NextRequest,
  args: HandlerArgs,
  authContext: AuthContext & { bodyBuffer?: ArrayBuffer; model?: string },
) {
  const params = await args.params;
  const targetUrl = buildTargetUrl(request, params.path);

  const validation = await validateProxyRequestModel({
    request,
    provider: "google",
  });
  if (!validation.valid) {
    return new Response(validation.error, { status: 400 });
  }

  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "host" ||
      lowerKey === "content-length" ||
      lowerKey === "connection" ||
      lowerKey === "authorization" ||
      lowerKey === "x-daemon-token" ||
      lowerKey === "x-goog-api-key"
    ) {
      continue;
    }
    headers.set(key, value);
  }

  // Use the body buffer that was already read during authorization
  // Transform it to match Gemini API schema
  const body = authContext.bodyBuffer ? authContext.bodyBuffer : undefined;

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });

  let responseBody: BodyInit | null = response.body;
  if (shouldLogUsage(targetUrl.pathname)) {
    const contentType = response.headers.get("content-type");
    if (isEventStreamContentType(contentType) && response.body) {
      const [clientStream, loggingStream] = response.body.tee();
      responseBody = clientStream;
      void logUsageFromEventStream({
        stream: loggingStream,
        targetUrl,
        userId: authContext.userId,
        organizationId: authContext.organizationId,
        model: authContext.model,
      }).catch((error) => {
        console.error(
          "Failed to log Google AI Studio usage (event-stream handler)",
          error,
        );
      });
    } else if (isJsonContentType(contentType)) {
      try {
        const buffer = await response.arrayBuffer();
        responseBody = buffer;
        const decoded = new TextDecoder().decode(buffer);
        const json = JSON.parse(decoded);
        const usage = json?.usageMetadata;
        if (usage) {
          await logGoogleUsage({
            path: targetUrl.pathname,
            usage,
            userId: authContext.userId,
            organizationId: authContext.organizationId,
            model: authContext.model ?? json?.modelVersion ?? undefined,
          });
        }
      } catch (error) {
        console.error("Failed to log Google AI Studio usage (json)", error);
      }
    }
  }

  const responseHeaders = new Headers();
  for (const [key, value] of response.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "content-length" ||
      lowerKey === "connection" ||
      lowerKey === "transfer-encoding" ||
      lowerKey === "content-encoding"
    ) {
      continue;
    }
    responseHeaders.set(key, value);
  }

  const origin = request.headers.get("origin");
  if (origin) {
    responseHeaders.set("Access-Control-Allow-Origin", origin);
    responseHeaders.set("Access-Control-Allow-Credentials", "true");
    responseHeaders.append("Vary", "Origin");
  } else {
    responseHeaders.set("Access-Control-Allow-Origin", "*");
  }

  return new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

async function authorize(request: NextRequest): Promise<
  | {
      response: Response;
      userId?: undefined;
      organizationId?: undefined;
      bodyBuffer?: undefined;
      model?: undefined;
    }
  | {
      response: null;
      userId: string;
      organizationId: string | null;
      bodyBuffer?: ArrayBuffer;
      model?: string;
    }
> {
  const token = getDaemonTokenFromHeaders(request.headers);
  if (!token) {
    return { response: new Response("Unauthorized", { status: 401 }) };
  }

  // Read body once if present (for POST, PUT, PATCH requests)
  let bodyBuffer: ArrayBuffer | undefined;
  let model: string | undefined;

  if (request.method !== "GET" && request.method !== "HEAD") {
    bodyBuffer = await request.arrayBuffer();

    // Try to extract model from request body
    try {
      const decoded = new TextDecoder().decode(bodyBuffer);
      const json = JSON.parse(decoded);
      model = json?.model;
    } catch {
      // Ignore parsing errors
    }
  }

  // Check if API key is configured
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log("Google proxy access denied: API key not configured");
    return {
      response: new Response("Google provider not configured on this server", {
        status: 503,
      }),
    };
  }

  try {
    const { valid, error, key } = await auth.api.verifyApiKey({
      body: { key: token },
    });

    const userId = key?.userId;

    if (error || !valid || !userId) {
      console.log("Unauthorized Google proxy request", {
        error,
        valid,
      });
      return { response: new Response("Unauthorized", { status: 401 }) };
    }

    // Credit gate only applies when billing is enabled. With Stripe off there is no
    // credit system, so skip the balance check entirely and fail open — otherwise a
    // fresh user (0 credits) would be 402'd off the platform proxy, breaking agent runs.
    if (isStripeConfigured()) {
      const { balanceCents } = await getUserCreditBalance({
        db,
        userId,
        skipAggCache: false,
      });
      waitUntil(maybeTriggerCreditAutoReload({ userId, balanceCents }));
      if (balanceCents <= 0) {
        console.log("Google proxy access denied: insufficient credits", {
          userId,
          balanceCents,
        });
        return {
          response: new Response("Insufficient credits", { status: 402 }),
        };
      }
    }
    return {
      response: null,
      userId,
      organizationId: daemonTokenContextFromApiKey(key)?.organizationId ?? null,
      bodyBuffer,
      model,
    };
  } catch (err) {
    console.error("Failed to verify Google proxy request", err);
    return { response: new Response("Unauthorized", { status: 401 }) };
  }
}

async function handleWithAuth(
  request: NextRequest,
  args: HandlerArgs,
  handler: (
    request: NextRequest,
    args: HandlerArgs,
    context: AuthContext & { bodyBuffer?: ArrayBuffer; model?: string },
  ) => Promise<Response>,
) {
  const authResult = await authorize(request);
  if (authResult.response) {
    return authResult.response;
  }
  return handler(request, args, {
    userId: authResult.userId,
    organizationId: authResult.organizationId,
    bodyBuffer: authResult.bodyBuffer,
    model: authResult.model,
  });
}

export async function GET(request: NextRequest, args: HandlerArgs) {
  return handleWithAuth(request, args, proxyRequest);
}

export async function POST(request: NextRequest, args: HandlerArgs) {
  return handleWithAuth(request, args, proxyRequest);
}

export async function PUT(request: NextRequest, args: HandlerArgs) {
  return handleWithAuth(request, args, proxyRequest);
}

export async function PATCH(request: NextRequest, args: HandlerArgs) {
  return handleWithAuth(request, args, proxyRequest);
}

export async function DELETE(request: NextRequest, args: HandlerArgs) {
  return handleWithAuth(request, args, proxyRequest);
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  const allowOrigin = origin ?? "*";
  const allowHeaders =
    request.headers.get("access-control-request-headers") ??
    "authorization, content-type, x-daemon-token";

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": allowHeaders,
    Vary: "Origin",
  };

  if (allowOrigin !== "*") {
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return new Response(null, {
    status: 204,
    headers,
  });
}
