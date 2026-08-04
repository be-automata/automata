import { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserCreditBalance } from "@terragon/shared/model/credits";
import { isStripeConfigured } from "@/server-lib/stripe";
import { maybeTriggerCreditAutoReload } from "@/server-lib/credit-auto-reload";
import { logOpenRouterUsage } from "../log-usage";
import { daemonTokenContextFromApiKey } from "@/lib/daemon-token-context";
import { waitUntil } from "@/lib/wait-until";
import { validateProxyRequestModel } from "@/server-lib/proxy-model-validation";

const OPENROUTER_API_BASE = "https://openrouter.ai/api/";
const DEFAULT_PATH = "v1/chat/completions";

export const dynamic = "force-dynamic";

type HandlerArgs = { params: Promise<{ path?: string[] }> };
type AuthContext = { userId: string; organizationId: string | null };

function getDaemonTokenFromHeaders(headers: Headers) {
  const directToken = headers.get("X-Daemon-Token");
  if (directToken && directToken.trim() !== "") {
    return directToken.trim();
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
  const pathname =
    pathSegments && pathSegments.length > 0
      ? pathSegments.join("/")
      : DEFAULT_PATH;

  const targetUrl = new URL(pathname, OPENROUTER_API_BASE);

  // Copy all search params
  if (request.nextUrl.searchParams.toString()) {
    targetUrl.search = request.nextUrl.searchParams.toString();
  }

  return targetUrl;
}

function getApiKey(): string {
  return env.OPENROUTER_API_KEY;
}

function isChatCompletionsPath(pathname: string) {
  return pathname.startsWith("/api/v1/chat/completions");
}

function isCompletionsPath(pathname: string) {
  return pathname.startsWith("/api/v1/completions");
}

function shouldLogUsage(pathname: string) {
  return isChatCompletionsPath(pathname) || isCompletionsPath(pathname);
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
}: {
  stream: ReadableStream<Uint8Array>;
  targetUrl: URL;
  userId: string;
  organizationId: string | null;
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
          if (parsed?.usage) {
            await logOpenRouterUsage({
              path: targetUrl.pathname,
              usage: parsed.usage,
              userId,
              organizationId,
              model: parsed.model ?? undefined,
            });
            return true;
          }
        } catch (_error) {
          // Ignore payloads that are not JSON objects
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
    console.error("Failed to log OpenRouter usage (event-stream)", error);
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
  authContext: AuthContext & { bodyBuffer?: ArrayBuffer },
) {
  const params = await args.params;
  const targetUrl = buildTargetUrl(request, params.path);

  const validation = await validateProxyRequestModel({
    request,
    provider: "openrouter",
    bodyBuffer: authContext.bodyBuffer,
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
      lowerKey === "x-daemon-token"
    ) {
      continue;
    }
    headers.set(key, value);
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("OpenRouter API key not configured");
  }
  headers.set("Authorization", `Bearer ${apiKey}`);

  // Use the body buffer that was already read during authorization
  const body = authContext.bodyBuffer;

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
      }).catch((error) => {
        console.error(
          "Failed to log OpenRouter usage (event-stream handler)",
          error,
        );
      });
    } else if (isJsonContentType(contentType)) {
      try {
        const buffer = await response.arrayBuffer();
        responseBody = buffer;
        const decoded = new TextDecoder().decode(buffer);
        const json = JSON.parse(decoded);
        const usage = json?.usage;
        if (usage) {
          await logOpenRouterUsage({
            path: targetUrl.pathname,
            usage,
            userId: authContext.userId,
            organizationId: authContext.organizationId,
            model: json?.model ?? undefined,
          });
        }
      } catch (error) {
        console.error("Failed to log OpenRouter usage (json)", error);
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
    }
  | {
      response: null;
      userId: string;
      organizationId: string | null;
      bodyBuffer?: ArrayBuffer;
    }
> {
  const token = getDaemonTokenFromHeaders(request.headers);
  if (!token) {
    return { response: new Response("Unauthorized", { status: 401 }) };
  }

  // Read body once if present (for POST, PUT, PATCH requests)
  const bodyBuffer =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  // Check if API key is configured
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log("OpenRouter proxy access denied: API key not configured");
    return {
      response: new Response(
        "OpenRouter provider not configured on this server",
        {
          status: 503,
        },
      ),
    };
  }

  try {
    const { valid, error, key } = await auth.api.verifyApiKey({
      body: { key: token },
    });

    // Resolve the tenant context ONCE through the shared helper: it owns the

    // better-auth 1.5 `referenceId` rename (with a legacy `userId` fallback so a

    // mixed-version rollout cannot 401 the fleet) and the organizationId decode.

    const daemonContext = daemonTokenContextFromApiKey(key);

    const userId = daemonContext?.userId;

    if (error || !valid || !userId) {
      console.log("Unauthorized OpenRouter proxy request", { error, valid });
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
        console.log("OpenRouter proxy access denied: insufficient credits", {
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
      organizationId: daemonContext?.organizationId ?? null,
      bodyBuffer,
    };
  } catch (err) {
    console.error("Failed to verify OpenRouter proxy request", err);
    return { response: new Response("Unauthorized", { status: 401 }) };
  }
}

async function handleWithAuth(
  request: NextRequest,
  args: HandlerArgs,
  handler: (
    request: NextRequest,
    args: HandlerArgs,
    context: AuthContext & { bodyBuffer?: ArrayBuffer },
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
