import { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserCreditBalance } from "@terragon/shared/model/credits";
import { isStripeConfigured } from "@/server-lib/stripe";
import { maybeTriggerCreditAutoReload } from "@/server-lib/credit-auto-reload";
import { logAnthropicUsage } from "../log-anthropic-usage";
import { waitUntil } from "@vercel/functions";
import { validateProxyRequestModel } from "@/server-lib/proxy-model-validation";

const ANTHROPIC_API_BASE = "https://api.anthropic.com/";
const DEFAULT_ANTHROPIC_PATH = "v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";

export const dynamic = "force-dynamic";

type HandlerArgs = { params: { path?: string[] } };
type AuthContext = { userId: string };

type StreamEvent = {
  eventType: string | null;
  payload: unknown;
};

type StreamPayload = {
  type?: string;
  usage?: {
    input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    output_tokens?: number | null;
  } | null;
  message?: {
    id?: string | null;
    model?: string | null;
    usage?: StreamPayload["usage"];
  } | null;
  model?: string | null;
};

type UsagePayloadFields = {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens?: number | null;
};

type UsageKey = keyof UsagePayloadFields;

const STREAM_USAGE_KEYS: UsageKey[] = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
];

type UsageTotals = Record<UsageKey, number>;

function buildTargetUrl(
  request: NextRequest,
  pathSegments: string[] | undefined,
) {
  const pathname =
    pathSegments && pathSegments.length > 0
      ? pathSegments.join("/")
      : DEFAULT_ANTHROPIC_PATH;

  const targetUrl = new URL(pathname, ANTHROPIC_API_BASE);
  const search = request.nextUrl.search;
  if (search) {
    targetUrl.search = search;
  }

  return targetUrl;
}

function isMessagesPath(pathname: string) {
  return pathname === "/v1/messages" || pathname.startsWith("/v1/messages/");
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

function parseStreamEvent(rawEvent: string): StreamEvent | null {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines: string[] = [];
  let eventType: string | null = null;

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const payloadText = dataLines.join("\n");

  try {
    const payload = JSON.parse(payloadText);
    return { eventType, payload };
  } catch (_error) {
    return null;
  }
}

function extractUsageFromStreamPayload(payload: StreamPayload): {
  usage:
    | {
        input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        output_tokens?: number | null;
      }
    | null
    | undefined;
  model?: string | null;
  messageId?: string | null;
} {
  const usage = payload.usage ?? payload.message?.usage;
  const model = payload.message?.model ?? payload.model;
  const messageId = payload.message?.id ?? null;

  return { usage, model, messageId };
}

async function logMessagesUsageFromEventStream({
  stream,
  targetUrl,
  userId,
}: {
  stream: ReadableStream<Uint8Array>;
  targetUrl: URL;
  userId: string;
}) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneReading = false;
  let knownModel: string | null | undefined;
  let knownMessageId: string | null | undefined;
  const aggregatedUsageTotals: UsageTotals = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
  let sawUsageEvent = false;

  const processBuffer = async () => {
    let separator = findEventSeparator(buffer);
    while (separator) {
      const rawEvent = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      if (!rawEvent.trim()) {
        separator = findEventSeparator(buffer);
        continue;
      }

      const parsed = parseStreamEvent(rawEvent);
      if (!parsed) {
        separator = findEventSeparator(buffer);
        continue;
      }

      const payload = parsed.payload as StreamPayload;
      const { usage, model, messageId } =
        extractUsageFromStreamPayload(payload);

      if (!knownModel && model) {
        knownModel = model;
      }
      if (!knownMessageId && messageId) {
        knownMessageId = messageId;
      }

      if (usage) {
        sawUsageEvent = true;
        const incomingUsage = usage as UsagePayloadFields;

        for (const key of STREAM_USAGE_KEYS) {
          const rawValue = incomingUsage[key];
          if (rawValue == null) {
            continue;
          }
          const parsedValue = Number(rawValue);
          if (!Number.isFinite(parsedValue)) {
            continue;
          }
          const value = Math.max(parsedValue, 0);
          if (value > aggregatedUsageTotals[key]) {
            aggregatedUsageTotals[key] = value;
          }
        }
      }

      separator = findEventSeparator(buffer);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        await processBuffer();
      }
      if (done) {
        buffer += decoder.decode();
        await processBuffer();
        doneReading = true;
        break;
      }
    }
  } catch (error) {
    console.error(
      "Failed to log Anthropic messages usage (event-stream)",
      error,
    );
  } finally {
    if (!doneReading) {
      await reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }

  if (sawUsageEvent) {
    const aggregatedUsageForLogging: UsagePayloadFields = {};
    let hasUsage = false;

    for (const key of STREAM_USAGE_KEYS) {
      const total = aggregatedUsageTotals[key];
      if (total > 0) {
        aggregatedUsageForLogging[key] = total;
        hasUsage = true;
      }
    }

    if (hasUsage) {
      try {
        await logAnthropicUsage({
          path: targetUrl.pathname,
          usage: aggregatedUsageForLogging,
          userId,
          model: knownModel ?? null,
          messageId: knownMessageId ?? null,
        });
      } catch (error) {
        console.error(
          "Failed to log Anthropic messages usage (aggregated event-stream)",
          error,
        );
      }
    }
  }
}

async function proxyRequest(
  request: NextRequest,
  args: HandlerArgs,
  authContext: AuthContext,
) {
  const params = await args.params;
  const targetUrl = buildTargetUrl(request, params.path);

  const validation = await validateProxyRequestModel({
    request,
    provider: "anthropic",
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
      lowerKey === "x-api-key" ||
      lowerKey === "authorization"
    ) {
      continue;
    }
    headers.set(key, value);
  }
  headers.set("x-api-key", env.ANTHROPIC_API_KEY);
  if (!headers.has("anthropic-version")) {
    headers.set("anthropic-version", ANTHROPIC_API_VERSION);
  }

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });

  let responseBody: BodyInit | null = response.body;
  if (isMessagesPath(targetUrl.pathname)) {
    const contentType = response.headers.get("content-type");
    if (isEventStreamContentType(contentType) && response.body) {
      const [clientStream, loggingStream] = response.body.tee();
      responseBody = clientStream;
      void logMessagesUsageFromEventStream({
        stream: loggingStream,
        targetUrl,
        userId: authContext.userId,
      }).catch((error) => {
        console.error(
          "Failed to log Anthropic messages usage (event-stream handler)",
          error,
        );
      });
    } else if (isJsonContentType(contentType)) {
      try {
        const buffer = await response.arrayBuffer();
        responseBody = buffer;
        const decoded = new TextDecoder().decode(buffer);
        const json = JSON.parse(decoded) as {
          usage?: StreamPayload["usage"];
          model?: string | null;
          id?: string | null;
        };
        if (json?.usage) {
          await logAnthropicUsage({
            path: targetUrl.pathname,
            usage: json.usage,
            userId: authContext.userId,
            model: json.model ?? null,
            messageId: json.id ?? null,
          });
        }
      } catch (error) {
        console.error("Failed to log Anthropic messages usage (json)", error);
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

async function authorize(
  request: NextRequest,
): Promise<
  | { response: Response; userId?: undefined }
  | { response: null; userId: string }
> {
  const token = getDaemonTokenFromHeaders(request.headers);

  if (!token) {
    return { response: new Response("Unauthorized", { status: 401 }) };
  }

  try {
    const { valid, error, key } = await auth.api.verifyApiKey({
      body: { key: token },
    });

    const userId = key?.userId;

    if (error || !valid || !userId) {
      console.log("Unauthorized Anthropic proxy request", { error, valid });
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
        console.log("Anthropic proxy access denied: insufficient credits", {
          userId,
          balanceCents,
        });
        return {
          response: new Response("Insufficient credits", { status: 402 }),
        };
      }
    }
    return { response: null, userId };
  } catch (err) {
    console.error("Failed to verify Anthropic proxy request", err);
    return { response: new Response("Unauthorized", { status: 401 }) };
  }
}

async function handleWithAuth(
  request: NextRequest,
  args: HandlerArgs,
  handler: (
    request: NextRequest,
    args: HandlerArgs,
    context: AuthContext,
  ) => Promise<Response>,
) {
  const authResult = await authorize(request);
  if (authResult.response) {
    return authResult.response;
  }
  return handler(request, args, { userId: authResult.userId });
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
    "authorization, content-type";

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
