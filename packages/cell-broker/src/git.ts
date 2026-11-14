import type { DB } from "@terragon/shared/db";
import {
  beginEffect,
  completeEffect,
  releaseEffect,
  type BearerContext,
} from "@terragon/shared/model/cell-authority";
import { hashOpaqueToken } from "@terragon/shared/utils/opaque-token";
import {
  isZeroObjectName,
  parseReceivePackCommands,
  type ReceivePackCommand,
} from "@terragon/utils/receive-pack-refs";

import {
  assertOrigin,
  authorizeCellRequest,
  brokerError,
  concatBytes,
  decodePathSegments,
  forwardRequestHeaders,
  gitAuthChallenge,
  hasUnsupportedContentEncoding,
  internalError,
  mintFailureResponse,
  isAny3xx,
  isUnsafeSegment,
  passThrough,
  readCapped,
  refusalResponse,
  responseHeadersForCell,
  type TokenMinter,
} from "./common";
import {
  parseAdvertisedRefs,
  parseReportStatus,
  type ReportStatus,
} from "./report-status";

/**
 * Remote-cell git broker (#606): a smart-HTTP proxy that lets a cell clone,
 * fetch and push without holding a GitHub credential. The upstream URL is
 * built from the STEP's repository, never from the request path, and the
 * installation token is injected server-side.
 *
 * A push (POST git-receive-pack) is a recorded effect: its idempotency key is
 * the hash of the command list, so an identical retry replays GitHub's stored
 * answer instead of pushing twice. See `handlePush` for the outcomes.
 */

const ROUTE_PREFIX = "/api/cell/git";
const UPLOAD_PACK = "git-upload-pack";
const RECEIVE_PACK = "git-receive-pack";

const MAX_PUSH_BYTES = 32 * 1024 * 1024;
const MAX_COMMAND_SECTION_BYTES = 64 * 1024;
const MAX_PUSH_RESPONSE_BYTES = 1024 * 1024;
const MAX_ADVERTISEMENT_BYTES = 8 * 1024 * 1024;
const ADVERTISEMENT_TIMEOUT_MS = 30_000;
/** How many times one command list may be claimed anew after its stored success went stale. */
const MAX_PUSH_GENERATIONS = 20;

export interface GitBrokerDeps {
  db: DB;
  fetchImpl: typeof fetch;
  mintReadToken: TokenMinter;
  mintWriteToken: TokenMinter;
  sideEffectsEnabled: () => boolean;
  enabled: () => boolean;
  /** Cap on a push body; tests lower it. Defaults to 32 MiB. */
  maxPushBytes?: number;
  /** Time allowed for the ref advertisement fetch. Defaults to 30 s. */
  advertisementTimeoutMs?: number;
}

type Leg = "upload-pack" | "receive-pack-advert" | "receive-pack-post";

/** The allowlisted git smart-HTTP call this request is, or null. */
function classifyLeg(
  method: string,
  endpoint: string,
  search: URLSearchParams,
): Leg | null {
  if (method === "GET" && endpoint === "info/refs") {
    if (search.size !== 1 || search.getAll("service").length !== 1) return null;
    const service = search.get("service");
    if (service === UPLOAD_PACK) return "upload-pack";
    if (service === RECEIVE_PACK) return "receive-pack-advert";
    return null;
  }
  if (method === "POST" && search.size === 0) {
    if (endpoint === UPLOAD_PACK) return "upload-pack";
    if (endpoint === RECEIVE_PACK) return "receive-pack-post";
  }
  return null;
}

/** The idempotency key of a push: a hash of its canonical command list. */
export function pushIdempotencyKey(
  commands: readonly ReceivePackCommand[],
): string {
  const canonical = commands
    .map((c) => `${c.oldSha} ${c.newSha} ${c.ref}`)
    .join("\n");
  return `push:${hashOpaqueToken(canonical)}`;
}

/** Stop reading a request body and discard the rest. Never throws. */
function drop(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => undefined);
}

/**
 * A URL on github.com for the step's repository, on the fixed origin. The
 * only place a git upstream URL is built.
 */
function githubGitUrl(
  owner: string,
  repo: string,
  endpoint: string,
  service?: string,
): URL {
  const url = new URL("https://github.com");
  url.pathname = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git/${endpoint}`;
  if (service) url.searchParams.set("service", service);
  assertOrigin(url, "https://github.com");
  return url;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Null unless `value` is canonical base64 (what `toBase64` writes). */
function fromBase64(value: string): Uint8Array | null {
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

interface UpstreamCall {
  deps: GitBrokerDeps;
  request: Request;
  url: URL;
  token: string;
  body?: Uint8Array | ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}

/** One call to GitHub with the token injected and redirects never followed. */
function callUpstream({
  deps,
  request,
  url,
  token,
  body,
  signal,
}: UpstreamCall): Promise<Response> {
  const headers = forwardRequestHeaders(request.headers);
  headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
  return deps.fetchImpl(url.toString(), {
    method: request.method,
    headers,
    redirect: "manual",
    body,
    signal,
    // Node requires duplex for a streaming request body.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

type CommandSection =
  | {
      ok: true;
      commands: ReceivePackCommand[];
      /** Every byte read so far: the command section and what followed it. */
      prefix: Uint8Array;
      consumed: number;
      reader: ReadableStreamDefaultReader<Uint8Array>;
      streamDone: boolean;
    }
  | { ok: false; response: Response };

/** Read the request body until its command section is complete. */
async function readCommandSection(
  body: ReadableStream<Uint8Array> | null,
): Promise<CommandSection> {
  if (!body) return { ok: false, response: brokerError(400, "bad_request") };
  const reader = body.getReader();
  const fail = (status: number, code: string): CommandSection => {
    drop(reader);
    return { ok: false, response: brokerError(status, code) };
  };
  let prefix: Uint8Array = new Uint8Array(0);
  let streamDone = false;
  for (;;) {
    const parsed = parseReceivePackCommands(prefix);
    if (parsed.ok) {
      if (parsed.consumed > MAX_COMMAND_SECTION_BYTES) {
        return fail(413, "payload_too_large");
      }
      return {
        ok: true,
        commands: parsed.commands,
        prefix,
        consumed: parsed.consumed,
        reader,
        streamDone,
      };
    }
    if (parsed.reason === "malformed") return fail(400, "bad_request");
    if (prefix.length > MAX_COMMAND_SECTION_BYTES) {
      return fail(413, "payload_too_large");
    }
    if (streamDone) return fail(400, "bad_request");
    try {
      const chunk = await reader.read();
      if (chunk.done) streamDone = true;
      else prefix = concatBytes(prefix, chunk.value);
    } catch {
      return fail(400, "bad_request");
    }
  }
}

type StoredPush = {
  httpStatus: number;
  contentType: string;
  bodyB64: string;
  refs: ReportStatus["refs"] | null;
};

function isStoredRefs(value: unknown): value is ReportStatus["refs"] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { ref?: unknown }).ref === "string" &&
        typeof (entry as { ok?: unknown }).ok === "boolean",
    )
  );
}

/** Rebuild a stored push answer, validating every stored field first. */
function replayResponse(result: Record<string, unknown>): Response {
  const { httpStatus, contentType, bodyB64 } = result as Partial<StoredPush>;
  const bytes = typeof bodyB64 === "string" ? fromBase64(bodyB64) : null;
  if (
    typeof httpStatus !== "number" ||
    !Number.isInteger(httpStatus) ||
    httpStatus < 200 ||
    httpStatus > 599 ||
    typeof contentType !== "string" ||
    !bytes
  ) {
    return brokerError(500, "corrupt_effect_result");
  }
  return new Response(bytes as BodyInit, {
    status: httpStatus,
    headers: { "content-type": contentType },
  });
}

interface Push {
  deps: GitBrokerDeps;
  request: Request;
  url: URL;
  token: string;
  context: BearerContext;
  idempotencyKey: string;
}

/**
 * GitHub refusals that say "try again" rather than "no": 408 and 429 behave
 * like a 5xx, and a 2xx whose every ng reason matches TRANSIENT_NG is released
 * instead of stored, so an identical retry claims afresh (the budget unit
 * stays spent).
 */
const TRANSIENT_STATUSES = new Set([408, 429]);
const TRANSIENT_NG =
  /failed to lock|cannot lock ref|timed? ?out|timeout|try again/i;

function isTransientRejection(bytes: Uint8Array): boolean {
  const refs = parseReportStatus(bytes)?.refs ?? [];
  return (
    refs.length > 0 &&
    refs.every((ref) => !ref.ok && TRANSIENT_NG.test(ref.reason ?? ""))
  );
}

/** Drop the claim of an effect that never got an answer. Never throws. */
async function releaseClaim(push: Push): Promise<void> {
  try {
    const released = await releaseEffect({
      db: push.deps.db,
      stepKey: push.context.stepKey,
      idempotencyKey: push.idempotencyKey,
      attempt: push.context.attempt,
    });
    if (!released) console.error("cell-broker: effect_taken_over (release)");
  } catch (error) {
    console.error(
      "cell-broker: releaseEffect failed",
      error instanceof Error ? error.name : "unknown",
    );
  }
}

/** Store GitHub's answer so a retry replays it. Never throws. */
async function storeOutcome(
  push: Push,
  upstream: Response,
  bytes: Uint8Array,
): Promise<void> {
  const result: StoredPush = {
    httpStatus: upstream.status,
    contentType: upstream.headers.get("content-type") ?? "",
    bodyB64: toBase64(bytes),
    refs: parseReportStatus(bytes)?.refs ?? null,
  };
  try {
    const stored = await completeEffect({
      db: push.deps.db,
      stepKey: push.context.stepKey,
      idempotencyKey: push.idempotencyKey,
      attempt: push.context.attempt,
      result,
    });
    // A newer attempt took the claim over: the cell still gets GitHub's bytes.
    if (!stored) console.error("cell-broker: effect_taken_over (complete)");
  } catch (error) {
    // The claim stays pending: the same attempt gets effect_in_progress, a
    // newer attempt takes it over. Logged, not hidden.
    console.error(
      "cell-broker: completeEffect failed",
      error instanceof Error ? error.name : "unknown",
    );
  }
}

/**
 * Forward a claimed push. The body is the buffered prefix followed by the rest
 * of the request, through a byte counter that aborts the upstream call over the
 * cap. Outcomes: GitHub answered 2xx/4xx -> stored and returned; overflow ->
 * released, 413; a transient failure (cell disconnect, network error, 5xx, 3xx,
 * oversized answer) -> released, 502.
 */
async function forwardPush(
  push: Push,
  section: Extract<CommandSection, { ok: true }>,
): Promise<Response> {
  const max = push.deps.maxPushBytes ?? MAX_PUSH_BYTES;
  const controller = new AbortController();
  let total = section.prefix.length;
  let overflowed = total > max;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      if (overflowed) {
        stream.error(new Error("push body over the cap"));
        controller.abort();
        return;
      }
      stream.enqueue(section.prefix);
    },
    async pull(stream) {
      try {
        if (section.streamDone) {
          stream.close();
          return;
        }
        const chunk = await section.reader.read();
        if (chunk.done) {
          stream.close();
          return;
        }
        total += chunk.value.length;
        if (total > max) {
          overflowed = true;
          stream.error(new Error("push body over the cap"));
          controller.abort();
          drop(section.reader);
          return;
        }
        stream.enqueue(chunk.value);
      } catch (error) {
        stream.error(error);
        controller.abort();
      }
    },
  });

  let upstream: Response;
  try {
    upstream = await callUpstream({
      deps: push.deps,
      request: push.request,
      url: push.url,
      token: push.token,
      body,
      signal: controller.signal,
    });
  } catch {
    await releaseClaim(push);
    return overflowed
      ? brokerError(413, "payload_too_large")
      : brokerError(502, "upstream_error");
  }
  if (overflowed) {
    void upstream.body?.cancel().catch(() => undefined);
    await releaseClaim(push);
    return brokerError(413, "payload_too_large");
  }
  if (
    upstream.status >= 500 ||
    isAny3xx(upstream.status) ||
    TRANSIENT_STATUSES.has(upstream.status)
  ) {
    void upstream.body?.cancel().catch(() => undefined);
    await releaseClaim(push);
    return brokerError(502, "upstream_error");
  }
  const bytes = await readCapped(upstream.body, MAX_PUSH_RESPONSE_BYTES).catch(
    () => null,
  );
  // The cap can be crossed while the answer is still being read (GitHub
  // replies early): that is an overflow, not an upstream failure.
  if (overflowed) {
    await releaseClaim(push);
    return brokerError(413, "payload_too_large");
  }
  if (!bytes) {
    await releaseClaim(push);
    return brokerError(502, "upstream_error");
  }
  if (upstream.status < 300 && isTransientRejection(bytes)) {
    // The cell sees the rejection; nothing is stored, so a retry is forwarded.
    await releaseClaim(push);
  } else {
    await storeOutcome(push, upstream, bytes);
  }
  return new Response(bytes as BodyInit, {
    status: upstream.status,
    headers: responseHeadersForCell(upstream.headers),
  });
}

/** A stored answer that is a 2xx where every pushed ref is reported ok. */
function isStoredSuccess(
  result: Record<string, unknown>,
  commands: readonly ReceivePackCommand[],
): boolean {
  const { httpStatus, refs } = result;
  if (typeof httpStatus !== "number" || httpStatus < 200 || httpStatus > 299) {
    return false;
  }
  if (!isStoredRefs(refs)) return false;
  return commands.every((command) =>
    refs.some((entry) => entry.ref === command.ref && entry.ok),
  );
}

/**
 * The ref tips GitHub advertises for the step's repository, or null when it
 * did not answer a parseable advertisement. A GET: nothing is claimed.
 */
async function fetchAdvertisedRefs(
  deps: GitBrokerDeps,
  owner: string,
  repo: string,
  token: string,
): Promise<Map<string, string> | null> {
  try {
    const url = githubGitUrl(owner, repo, "info/refs", RECEIVE_PACK);
    const upstream = await callUpstream({
      deps,
      request: new Request(url.toString(), {
        method: "GET",
        headers: { "user-agent": "git/automata-cell-broker" },
      }),
      url,
      token,
      signal: AbortSignal.timeout(
        deps.advertisementTimeoutMs ?? ADVERTISEMENT_TIMEOUT_MS,
      ),
    });
    if (upstream.status < 200 || upstream.status > 299) {
      void upstream.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await readCapped(upstream.body, MAX_ADVERTISEMENT_BYTES);
    return bytes ? parseAdvertisedRefs(bytes) : null;
  } catch {
    return null;
  }
}

/** True when every command's ref is already at its new sha (absent for a delete). */
function advertisedTipsMatch(
  tips: ReadonlyMap<string, string>,
  commands: readonly ReceivePackCommand[],
): boolean {
  return commands.every((command) =>
    isZeroObjectName(command.newSha)
      ? !tips.has(command.ref)
      : tips.get(command.ref) === command.newSha,
  );
}

interface PushRequest {
  deps: GitBrokerDeps;
  request: Request;
  bearer: string;
  context: BearerContext;
  owner: string;
  repo: string;
  url: URL;
}

/**
 * POST git-receive-pack (amendment 12): nothing that can fail for a local or
 * GitHub-App reason runs after the effect is claimed. Order: encoding (415),
 * declared length (413), command section (400/413), write token (502), probe,
 * claim (`beginEffect`), forward.
 */
async function handlePush({
  deps,
  request,
  bearer,
  context,
  owner,
  repo,
  url,
}: PushRequest): Promise<Response> {
  if (hasUnsupportedContentEncoding(request.headers)) {
    return brokerError(415, "unsupported_encoding");
  }
  const max = deps.maxPushBytes ?? MAX_PUSH_BYTES;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    return brokerError(413, "payload_too_large");
  }

  const section = await readCommandSection(request.body);
  if (!section.ok) return section.response;

  if (section.commands.length === 0) {
    // Only git's probe (a bare flush, nothing after it) has no commands.
    let probe = section.prefix.length === section.consumed;
    if (probe && !section.streamDone) {
      try {
        probe = (await section.reader.read()).done;
      } catch {
        probe = false;
      }
    }
    if (!probe) {
      drop(section.reader);
      return brokerError(400, "bad_request");
    }
  }

  let token: string;
  try {
    token = (await deps.mintWriteToken(owner, repo)).token;
  } catch (error) {
    drop(section.reader);
    return mintFailureResponse(error);
  }

  if (section.commands.length === 0) {
    try {
      return passThrough(
        await callUpstream({
          deps,
          request,
          url,
          token,
          body: section.prefix,
        }),
      );
    } catch {
      return brokerError(502, "upstream_error");
    }
  }

  const baseKey = pushIdempotencyKey(section.commands);
  let tips: Map<string, string> | null = null;
  let refetched = false;
  for (let generation = 1; generation <= MAX_PUSH_GENERATIONS; generation++) {
    const idempotencyKey =
      generation === 1 ? baseKey : `${baseKey}:g${generation}`;
    let begun: Awaited<ReturnType<typeof beginEffect>>;
    try {
      begun = await beginEffect({ db: deps.db, token: bearer, idempotencyKey });
    } catch {
      drop(section.reader);
      return internalError("begin_effect");
    }
    if (begun.kind === "refused") {
      drop(section.reader);
      return refusalResponse(begun.reason);
    }
    if (begun.kind === "go") {
      return forwardPush(
        { deps, request, url, token, context: begun.context, idempotencyKey },
        section,
      );
    }
    // Replay. A stored rejection stays idempotent; a stored success is only
    // replayed while the refs still show it, otherwise the push is claimed
    // anew under the next generation.
    if (!isStoredSuccess(begun.result, section.commands)) {
      drop(section.reader);
      return replayResponse(begun.result);
    }
    tips ??= await fetchAdvertisedRefs(deps, owner, repo, token);
    if (!tips) {
      drop(section.reader);
      return brokerError(502, "upstream_error");
    }
    if (!advertisedTipsMatch(tips, section.commands) && generation >= 2) {
      // A concurrent request may have completed this generation after the
      // first read: look once more before claiming the next one.
      if (!refetched) {
        refetched = true;
        tips = await fetchAdvertisedRefs(deps, owner, repo, token);
        if (!tips) {
          drop(section.reader);
          return brokerError(502, "upstream_error");
        }
      }
    }
    if (advertisedTipsMatch(tips, section.commands)) {
      drop(section.reader);
      return replayResponse(begun.result);
    }
  }
  drop(section.reader);
  return brokerError(409, "push_generations_exhausted");
}

export function createGitBrokerHandler(
  deps: GitBrokerDeps,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const auth = await authorizeCellRequest(deps, request, {
      onMissingBearer: gitAuthChallenge,
    });
    if (!auth.ok) return auth.response;

    const url = new URL(request.url);
    const decoded = decodePathSegments(url.pathname, ROUTE_PREFIX);
    if (!decoded.ok) return brokerError(400, "bad_request");
    const [owner, repoGit, ...endpointParts] = decoded.segments;
    if (!owner || !repoGit || endpointParts.length === 0) {
      return brokerError(403, "forbidden_path");
    }
    if (
      decoded.segments.some((segment) => isUnsafeSegment(segment, "git")) ||
      !repoGit.endsWith(".git")
    ) {
      return brokerError(403, "forbidden_path");
    }
    const requestRepo = `${owner}/${repoGit.slice(0, -".git".length)}`;
    if (requestRepo.toLowerCase() !== auth.repoFullName) {
      return brokerError(403, "forbidden_path");
    }

    const endpoint = endpointParts.join("/");
    const leg = classifyLeg(request.method, endpoint, url.searchParams);
    if (!leg) return brokerError(403, "forbidden_path");

    if (leg !== "upload-pack" && !deps.sideEffectsEnabled()) {
      return brokerError(503, "side_effects_disabled");
    }

    // The upstream URL comes from the step's repo and the allowlisted endpoint.
    const { owner: stepOwner, repo: stepRepo } = auth;
    let upstreamUrl: URL;
    try {
      upstreamUrl = githubGitUrl(
        stepOwner,
        stepRepo,
        endpoint,
        endpoint === "info/refs"
          ? leg === "upload-pack"
            ? UPLOAD_PACK
            : RECEIVE_PACK
          : undefined,
      );
    } catch {
      return internalError("upstream_origin");
    }

    if (leg === "receive-pack-post") {
      return handlePush({
        deps,
        request,
        bearer: auth.bearer,
        context: auth.context,
        owner: stepOwner,
        repo: stepRepo,
        url: upstreamUrl,
      });
    }

    let token: string;
    try {
      const minted =
        leg !== "upload-pack"
          ? await deps.mintWriteToken(stepOwner, stepRepo)
          : await deps.mintReadToken(stepOwner, stepRepo);
      token = minted.token;
    } catch (error) {
      return mintFailureResponse(error);
    }
    try {
      return passThrough(
        await callUpstream({
          deps,
          request,
          url: upstreamUrl,
          token,
          body:
            request.method === "POST" ? (request.body ?? undefined) : undefined,
        }),
      );
    } catch {
      return brokerError(502, "upstream_error");
    }
  };
}
