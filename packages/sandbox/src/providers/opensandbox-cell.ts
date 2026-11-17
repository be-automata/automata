/**
 * OpenSandbox cell adapter (#634 S2): `ICellProvider` over the OpenSandbox 1.2.1
 * lifecycle API and execd. A pure HTTP adapter: no env reads, no DB, no wiring.
 * Imports only the cell contract (type-only) and Node built-ins, so it never
 * pulls e2b or Daytona.
 */
import type {
  CellCreatePlan,
  CellExecOptions,
  CellExecResult,
  CellListEntry,
  CellListOptions,
  CellLogger,
  CellProviderErrorCode,
  CellTags,
  CellVaultEntry,
  ICellProvider,
} from "@terragon/types/cell";

/**
 * Kept equal to `CELL_SELF_CHECK_BLOCKED_EXIT` in @terragon/types (a test
 * asserts it): this file imports the contract type-only, so the sandbox
 * package needs no runtime dependency on types.
 */
export const OPENSANDBOX_SELF_CHECK_BLOCKED_EXIT = 3;

const DEFAULT_EXECD_PORT = 44772;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_BUDGET_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const EXEC_SLACK_MS = 10_000;
const DEFAULT_MAX_EXEC_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_COPY_OUT_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_LIST_PAGE_BYTES = 1024 * 1024;
const MAX_POLICY_BODY_BYTES = 64 * 1024;
const MAX_CREATE_REPLY_BYTES = 64 * 1024;
const DEFAULT_COPY_OUT_TIMEOUT_MS = 120_000;
/** Kept equal to `CELL_MIN_TTL_MS` in @terragon/types (a test asserts it). */
export const OPENSANDBOX_MIN_TTL_MS = 60_000;
const MIN_TTL_SECONDS = OPENSANDBOX_MIN_TTL_MS / 1000;
const PING_INTERVAL_MS = 100;
const LIST_PAGE_SIZE = 100;
/** 100k cells: a server that never stops paging fails instead of looping. */
const MAX_LIST_PAGES = 1_000;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 2_000;
/** The header-name pattern: `CELL_VAULT_HEADER_PATTERN` in @terragon/types (type-only import here). */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
const CONNECTION_FAILED = "BACKEND_CONNECTION_FAILED";

/** The message carries the op, code and status only: never a body or header. */
export class CellProviderError extends Error {
  constructor(
    readonly code: CellProviderErrorCode,
    readonly op: string,
    readonly status?: number,
  ) {
    super(`${op}: ${code}${status ? " " + status : ""}`);
    this.name = "CellProviderError";
  }
}

export interface OpenSandboxCellConfig {
  baseUrl: string;
  apiKey: string;
  /** Digest-pinned image reference. */
  image: string;
  entrypoint: readonly string[];
  execdPort?: number;
  /** The probe contract is `CELL_SELF_CHECK_BLOCKED_EXIT` in @terragon/types. */
  selfCheck: { argv: readonly string[] };
  readyTimeoutMs?: number;
  retryBudgetMs?: number;
  requestTimeoutMs?: number;
  /** Cap on the raw exec SSE body in bytes, default 16 MiB; over it exec fails. */
  maxExecOutputBytes?: number;
  /** Cap on a copyOut body in bytes, default 64 MiB; over it copyOut fails. */
  maxCopyOutBytes?: number;
  /** Deadline for a copyOut request including its body read, default 120 s. */
  copyOutTimeoutMs?: number;
}

export interface OpenSandboxCellDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  logger: CellLogger;
}

type RetryMode = "idempotent" | "undelivered";

interface SendOptions {
  body?: unknown;
  retry: RetryMode;
  timeoutMs?: number;
}

interface Sent {
  res: Response;
  /** The 502 body's `code`, parsed once and only for a POST that retries on it. */
  code?: string;
}

/** A step finishes with `done`, or asks for another attempt after `retryInMs`. */
type RetryStep<T, L = undefined> = { done: T } | { retryInMs: number; last: L };

interface ListPage {
  entries: CellListEntry[];
  hasNextPage: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The string-valued entries only: one odd value must not hide a cell's other tags. */
function stringTags(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
}

/** Frees a response body this code ignores, so the connection is not held. */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // An already-read or locked body has nothing left to free.
  }
}

async function requireOk(op: string, res: Response): Promise<void> {
  if (res.ok) return;
  await discard(res);
  throw new CellProviderError("http_error", op, res.status);
}

/** A failed body read maps to http_error with no cause: a parse error quotes the body. */
async function readBody<T>(
  op: string,
  read: () => Promise<T>,
  status?: number,
): Promise<T> {
  try {
    return await read();
  } catch {
    throw new CellProviderError("http_error", op, status);
  }
}

/**
 * Reads a body as bytes, counting them. Over `maxBytes`, or on any failure,
 * the stream is cancelled and the read fails with no content in the error.
 */
async function readCappedBytes(
  op: string,
  res: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new CellProviderError("http_error", op);
      chunks.push(value);
    }
  } catch {
    // Over the cap, aborted or broken: release the connection, report no output.
    await reader.cancel().catch(() => undefined);
    throw new CellProviderError("http_error", op);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readCappedText(
  op: string,
  res: Response,
  maxBytes: number,
): Promise<string> {
  return new TextDecoder().decode(await readCappedBytes(op, res, maxBytes));
}

/** Capped JSON read; an over-cap or unparseable body fails with no content in the error. */
async function readCappedJson(
  op: string,
  res: Response,
  maxBytes: number,
): Promise<unknown> {
  const text = await readCappedText(op, res, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new CellProviderError("http_error", op);
  }
}

function cellPath(id: string, suffix = ""): string {
  return `/sandboxes/${encodeURIComponent(id)}${suffix}`;
}

const isNonBlank = (v: unknown): boolean =>
  typeof v === "string" && v.trim() !== "";
const isPositive = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/** Identity tags and resources the adapter relies on; callers can be untyped. */
function assertPlanFields(plan: CellCreatePlan): void {
  const tags: Record<string, unknown> = isRecord(plan.tags) ? plan.tags : {};
  const res: Record<string, unknown> = isRecord(plan.resources)
    ? plan.resources
    : {};
  const tagsOk =
    tags.automata === "cell" &&
    ["worker", "epoch", "stepKey", "attempt", "expiresAt", "deployment"].every(
      (k) => isNonBlank(tags[k]),
    );
  if (!tagsOk || !isPositive(res.cpu) || !isPositive(res.memoryMiB)) {
    throw new CellProviderError("invalid_plan", "create");
  }
}

/**
 * An auth kind other than bearer or apiKey, an empty `paths` (upstream could read
 * it as every path), and a header name or placeholder that is blank or malformed
 * are refused, never echoed.
 */
function assertVault(vault: readonly CellVaultEntry[] | undefined): void {
  for (const v of vault ?? []) {
    const auth: unknown = v.auth;
    const paths: unknown = v.paths;
    const placeholder = (v as { placeholder?: unknown }).placeholder;
    const header = (v as { header?: unknown }).header;
    const badAuth = auth !== "bearer" && auth !== "apiKey";
    const badPaths =
      paths !== undefined && !(Array.isArray(paths) && paths.length > 0);
    const badPlaceholder =
      placeholder !== undefined && !isNonBlank(placeholder);
    const badHeader =
      auth === "apiKey" &&
      !(typeof header === "string" && HEADER_NAME_PATTERN.test(header));
    if (badAuth || badPaths || badPlaceholder || badHeader) {
      throw new CellProviderError("invalid_plan", "create");
    }
  }
}

function guardPlan(plan: CellCreatePlan): void {
  // Callers can be untyped, so re-check what the type promises.
  if ((plan.provider as string) !== "opensandbox") {
    throw new CellProviderError("wrong_provider", "create");
  }
  if ((plan.runtime as string) !== "runc") {
    throw new CellProviderError("runtime_not_runc", "create");
  }
  const policy = plan.networkPolicy as Partial<CellCreatePlan["networkPolicy"]>;
  if (
    !isRecord(policy) ||
    policy.defaultAction !== "deny" ||
    !Array.isArray(policy.egress)
  ) {
    throw new CellProviderError("policy_required", "create");
  }
  assertPlanFields(plan);
  assertVault(plan.vault);
  // NaN or Infinity would serialize as `timeout: null`.
  if (
    !Number.isFinite(plan.ttlMs) ||
    Math.ceil(plan.ttlMs / 1000) < MIN_TTL_SECONDS
  ) {
    throw new CellProviderError("ttl_too_short", "create");
  }
}

function bindingAuth(v: CellVaultEntry): Record<string, unknown> {
  const base =
    v.auth === "apiKey"
      ? { type: "apiKey", name: v.header, credential: v.name }
      : { type: "bearer", credential: v.name };
  if (v.placeholder === undefined) return base;
  return {
    ...base,
    substitutions: [
      { credential: v.name, placeholder: v.placeholder, in: ["header"] },
    ],
  };
}

function vaultBody(vault: readonly CellVaultEntry[]): unknown {
  return {
    credentials: vault.map((v) => ({
      name: v.name,
      source: { type: "inline", value: v.credential },
    })),
    bindings: vault.map((v) => ({
      name: v.name,
      match: {
        hosts: [...v.hosts],
        ...(v.paths ? { paths: [...v.paths] } : {}),
      },
      auth: bindingAuth(v),
    })),
  };
}

/**
 * The data lines of each event: `data:` lines up to a blank line (SSE
 * multi-line data), or a bare `{...}` line as spike 058 parsed it. `event:`,
 * `id:` and `:` comment lines are ignored.
 */
function streamEvents(text: string): string[][] {
  const events: string[][] = [];
  let data: string[] = [];
  const flush = (): void => {
    if (data.length > 0) events.push(data);
    data = [];
  };
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.startsWith("data:")) {
      data.push(rawLine.slice(5).replace(/^ /, ""));
    } else if (rawLine.trim() === "") {
      flush();
    } else if (rawLine.trimStart().startsWith("{")) {
      flush();
      events.push([rawLine]);
    }
  }
  flush();
  return events;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * One event's JSON: its data lines joined (multi-line data) or, when the
 * server sent one JSON object per `data:` line with no blank line between
 * events, each line on its own. A truncated event yields nothing.
 */
function eventObjects(lines: readonly string[]): unknown[] {
  const joined = parseJson(lines.join("\n"));
  if (joined !== undefined || lines.length === 1) return [joined];
  return lines.map(parseJson);
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

/** An `error` event's exit code: `error.exit_code`, else (older servers) top-level. */
function errorExitCode(event: Record<string, unknown>): number | undefined {
  const inner = isRecord(event.error)
    ? asInteger(event.error.exit_code)
    : undefined;
  return inner ?? asInteger(event.exit_code);
}

/**
 * `undefined` (a failed run) without a terminal event, on an `error` event with
 * no integer exit code, or on an `execution_complete` without one. An `error`
 * event with an exit code is a completed run, and its code wins over an
 * `execution_complete`.
 */
function parseExecStream(text: string): CellExecResult | undefined {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let completeCode: number | undefined;
  let errorCode: number | undefined;
  let errored = false;
  // A truncated event parses to nothing: without a terminal event the run fails.
  for (const event of streamEvents(text).flatMap(eventObjects)) {
    if (!isRecord(event)) continue;
    if (event.type === "stdout" && typeof event.text === "string") {
      stdout.push(event.text);
    } else if (event.type === "stderr" && typeof event.text === "string") {
      stderr.push(event.text);
    } else if (event.type === "execution_complete") {
      completeCode = asInteger(event.exit_code);
    } else if (event.type === "error") {
      const code = errorExitCode(event);
      if (code === undefined) errored = true;
      else errorCode ??= code;
    }
  }
  const exitCode = errorCode ?? completeCode;
  return errored || exitCode === undefined
    ? undefined
    : { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

export function createOpenSandboxCellProvider(
  config: OpenSandboxCellConfig,
  deps: OpenSandboxCellDeps,
): ICellProvider {
  const base = config.baseUrl.replace(/\/+$/, "");
  const port = config.execdPort ?? DEFAULT_EXECD_PORT;
  const readyTimeoutMs = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const retryBudgetMs = config.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;
  const requestTimeoutMs =
    config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  // Detached from `deps`: workerd's global fetch throws "Illegal invocation"
  // when called with any `this` but the global scope, so `deps.fetch(...)`
  // would fail on Cloudflare Workers (www's reconciler) and nowhere else.
  const doFetch = deps.fetch;

  const maxCopyOutBytes = config.maxCopyOutBytes ?? DEFAULT_MAX_COPY_OUT_BYTES;
  const copyOutTimeoutMs =
    config.copyOutTimeoutMs ?? DEFAULT_COPY_OUT_TIMEOUT_MS;
  const maxExecOutputBytes =
    config.maxExecOutputBytes ?? DEFAULT_MAX_EXEC_OUTPUT_BYTES;

  const execd = (id: string, suffix: string): string =>
    cellPath(id, `/proxy/${port}/${suffix}`);

  async function once(
    method: string,
    path: string,
    o: { body?: unknown; timeoutMs: number },
  ): Promise<Response> {
    const hasBody = o.body !== undefined;
    return doFetch(`${base}${path}`, {
      method,
      headers: {
        "OPEN-SANDBOX-API-KEY": config.apiKey,
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(o.body) } : {}),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  }

  /**
   * Runs `step` until it stops asking for a retry or the budget is spent. The
   * budget also counts the sleeps it asked for, so a loop stays bounded even
   * when an injected clock never advances; in real time `now()` covers them.
   */
  async function withinBudget<T, L>(
    budgetMs: number,
    step: (attempt: number) => Promise<RetryStep<T, L>>,
    exhausted: (last: L) => T,
  ): Promise<T> {
    const start = deps.now();
    let sleptMs = 0;
    for (let attempt = 0; ; attempt++) {
      const outcome = await step(attempt);
      if ("done" in outcome) return outcome.done;
      if (Math.max(deps.now() - start, sleptMs) >= budgetMs) {
        return exhausted(outcome.last);
      }
      sleptMs += outcome.retryInMs;
      await deps.sleep(outcome.retryInMs);
    }
  }

  /** The JSON body's `code` only; the body itself is never kept or logged. */
  async function bodyCode(res: Response): Promise<string | undefined> {
    try {
      const text = await readCappedText("create", res, MAX_ERROR_BODY_BYTES);
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) && typeof parsed.code === "string"
        ? parsed.code
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function sendOnce(
    op: string,
    method: string,
    path: string,
    o: SendOptions,
    attempt: number,
  ): Promise<RetryStep<Sent, Sent>> {
    let res: Response;
    try {
      res = await once(method, path, {
        body: o.body,
        timeoutMs: o.timeoutMs ?? requestTimeoutMs,
      });
    } catch {
      throw new CellProviderError("http_error", op); // no cause: it may echo a request
    }
    if (res.status !== 502) return { done: { res } };
    const code = o.retry === "undelivered" ? await bodyCode(res) : undefined;
    const sent: Sent = { res, code };
    if (o.retry === "undelivered" && code !== CONNECTION_FAILED) {
      return { done: sent };
    }
    await discard(res);
    return {
      retryInMs: Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS),
      last: sent,
    };
  }

  function send(
    op: string,
    method: string,
    path: string,
    o: SendOptions,
  ): Promise<Sent> {
    return withinBudget(
      retryBudgetMs,
      (attempt) => sendOnce(op, method, path, o, attempt),
      (last) => last,
    );
  }

  /** For an idempotent call where 404 means the work is already done; true when it was 404. */
  async function send404AsDone(
    op: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<boolean> {
    const { res } = await send(op, method, path, { body, retry: "idempotent" });
    if (res.status === 404) {
      await discard(res);
      return true;
    }
    await requireOk(op, res);
    await discard(res);
    return false;
  }

  async function listByTags(
    tags: Partial<CellTags>,
    opts?: CellListOptions,
  ): Promise<CellListEntry[]> {
    const requested = opts?.maxPages;
    // A cap outside 1..MAX_LIST_PAGES would silently list nothing (0, NaN) or
    // page without bound (Infinity): refuse it.
    if (
      requested !== undefined &&
      !(
        Number.isSafeInteger(requested) &&
        requested >= 1 &&
        requested <= MAX_LIST_PAGES
      )
    ) {
      throw new CellProviderError("invalid_argv", "list");
    }
    const maxPages = requested ?? MAX_LIST_PAGES;
    const defined = Object.entries(tags).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    );
    const wanted: Record<string, string> = {
      automata: "cell",
      ...Object.fromEntries(defined),
    };
    const filter = new URLSearchParams(wanted).toString();
    // The server filters too; this re-check means a server that ignored a key
    // can never hand us (and teardown) a cell that is not ours.
    const matches = (e: CellListEntry): boolean =>
      Object.entries(wanted).every(([k, v]) => e.tags[k] === v);
    const out: CellListEntry[] = [];
    const finish = (truncated: boolean): CellListEntry[] =>
      Object.defineProperty(out, "truncated", {
        value: truncated,
        enumerable: false,
      });
    for (let page = 1; page <= maxPages; page++) {
      const { res } = await send(
        "list",
        "GET",
        `/sandboxes?metadata=${encodeURIComponent(filter)}&page=${page}&pageSize=${LIST_PAGE_SIZE}`,
        { retry: "idempotent" },
      );
      await requireOk("list", res);
      const { entries, hasNextPage } = await readListPage(res);
      out.push(...entries.filter(matches));
      // An empty page ends the walk even if the server claims more.
      if (!hasNextPage || entries.length === 0) return finish(false);
    }
    // Without `maxPages` a server that never stops paging still fails closed.
    if (opts?.maxPages === undefined) {
      throw new CellProviderError("http_error", "list");
    }
    return finish(true);
  }

  /** Fails closed on a malformed page: adoption must never miscount cells. */
  async function readListPage(res: Response): Promise<ListPage> {
    const body: unknown = await readBody(
      "list",
      () => readCappedJson("list", res, MAX_LIST_PAGE_BYTES),
      res.status,
    );
    const record = isRecord(body) ? body : {};
    const items = record.items;
    if (items !== undefined && !Array.isArray(items)) {
      throw new CellProviderError("http_error", "list", res.status);
    }
    const entries: CellListEntry[] = [];
    for (const item of items ?? []) {
      if (!isRecord(item) || typeof item.id !== "string" || item.id === "") {
        throw new CellProviderError("http_error", "list", res.status);
      }
      entries.push({
        cellId: item.id,
        tags: stringTags(item.metadata),
      });
    }
    const pagination = record.pagination;
    return {
      entries,
      hasNextPage: isRecord(pagination) && pagination.hasNextPage === true,
    };
  }

  async function del(cellId: string): Promise<"deleted" | "gone"> {
    const gone = await send404AsDone("delete", "DELETE", cellPath(cellId));
    return gone ? "gone" : "deleted";
  }

  async function quarantine(cellId: string): Promise<void> {
    await send404AsDone(
      "quarantine",
      "PUT",
      cellPath(cellId, "/networkpolicy?dropEstablished=true"),
      { defaultAction: "deny", egress: [] },
    );
  }

  async function revoke(cellId: string): Promise<void> {
    await send404AsDone(
      "revoke",
      "DELETE",
      cellPath(cellId, "/credential-vault"),
    );
  }

  async function exec(
    cellId: string,
    argv: readonly string[],
    opts?: CellExecOptions,
  ): Promise<CellExecResult> {
    if (argv.length === 0 || !argv[0]) {
      throw new CellProviderError("invalid_argv", "exec");
    }
    const timeout = opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const { res } = await send("exec", "POST", execd(cellId, "command"), {
      body: {
        argv: [...argv],
        timeout,
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      },
      retry: "undelivered",
      timeoutMs: timeout + EXEC_SLACK_MS,
    });
    await requireOk("exec", res);
    const text = await readCappedText("exec", res, maxExecOutputBytes);
    const outcome = parseExecStream(text);
    if (!outcome) throw new CellProviderError("http_error", "exec");
    return outcome;
  }

  async function copyOut(cellId: string, path: string): Promise<Uint8Array> {
    const { res } = await send(
      "copyOut",
      "GET",
      `${execd(cellId, "files/download")}?path=${encodeURIComponent(path)}`,
      { retry: "idempotent", timeoutMs: copyOutTimeoutMs },
    );
    await requireOk("copyOut", res);
    return readCappedBytes("copyOut", res, maxCopyOutBytes);
  }

  function createBody(plan: CellCreatePlan): unknown {
    return {
      image: { uri: config.image },
      entrypoint: [...config.entrypoint],
      timeout: Math.ceil(plan.ttlMs / 1000),
      resourceLimits: {
        cpu: `${Math.max(1, Math.round(plan.resources.cpu * 1000))}m`,
        memory: `${plan.resources.memoryMiB}Mi`,
      },
      metadata: plan.tags,
      networkPolicy: plan.networkPolicy,
      credentialProxy: { enabled: true },
    };
  }

  /** Runs every step whatever fails earlier and returns the failures. */
  async function runTeardown(
    cellId: string,
    steps: ReadonlyArray<(cellId: string) => Promise<unknown>>,
  ): Promise<CellProviderError[]> {
    const failures: CellProviderError[] = [];
    for (const step of steps) {
      try {
        await step(cellId);
      } catch (error) {
        failures.push(
          error instanceof CellProviderError
            ? error
            : new CellProviderError("http_error", "teardown"),
        );
      }
    }
    return failures;
  }

  /** Internal cleanup: never throws, logs each failed step without secrets. */
  async function teardownSteps(cellId: string): Promise<void> {
    const steps = [revoke, quarantine, del];
    for (const { op, code, status } of await runTeardown(cellId, steps)) {
      deps.logger.warn("cell teardown step failed", {
        cellId,
        op,
        code,
        status,
      });
    }
  }

  /** Public teardown: every step runs, then one error or an AggregateError. */
  async function teardownStrict(cellId: string): Promise<void> {
    const failures = await runTeardown(cellId, [revoke, quarantine, del]);
    const [first] = failures;
    if (!first) return;
    if (failures.length === 1) throw first;
    throw new AggregateError(failures, "teardown");
  }

  /**
   * A create whose delivery is unproven (non-delivery 502, transport failure,
   * unusable 2xx) may still have made the cell: find it by the plan's full
   * identity, so only this plan's cell is adopted or torn down.
   */
  function adoptByTags(plan: CellCreatePlan, status?: number): Promise<string> {
    const { worker, epoch, stepKey, attempt } = plan.tags;
    const key = { worker, epoch, stepKey, attempt };
    return withinBudget<string, undefined>(
      retryBudgetMs,
      async () => {
        const found = await listByTags(key);
        if (found.length > 1) {
          await Promise.allSettled(found.map((f) => teardownSteps(f.cellId)));
          throw new CellProviderError("http_error", "create", status);
        }
        const only = found[0];
        return only
          ? { done: only.cellId }
          : { retryInMs: BACKOFF_BASE_MS, last: undefined };
      },
      () => {
        // The one secret-free warn every adopt path that finds nothing emits.
        deps.logger.warn("cell create adoption found nothing", {
          op: "create",
          stepKey: plan.tags.stepKey,
          attempt: plan.tags.attempt,
          ...(status === undefined ? {} : { status }),
        });
        throw new CellProviderError("http_error", "create", status);
      },
    );
  }

  async function adopt(
    plan: CellCreatePlan,
    status?: number,
  ): Promise<{ cellId: string; adopted: boolean }> {
    return { cellId: await adoptByTags(plan, status), adopted: true };
  }

  /** The unordered multiset key of one rule, normalised like the server's echo. */
  function ruleKey(rule: unknown): string | undefined {
    if (!isRecord(rule) || typeof rule.action !== "string") return undefined;
    const { action, target, ports } = rule;
    const list = Array.isArray(ports) && ports.length > 0 ? ports : undefined;
    return JSON.stringify({
      action,
      target: typeof target === "string" && target !== "" ? target : undefined,
      ports: list ? [...list].sort() : undefined,
    });
  }

  function sameRules(got: unknown, want: readonly unknown[]): boolean {
    if (!Array.isArray(got) || got.length !== want.length) return false;
    const a = got.map(ruleKey).sort();
    const b = want.map(ruleKey).sort();
    return a.every((k, i) => k !== undefined && k === b[i]);
  }

  /** True when the live policy body is the plan's enforcing deny-by-default one. */
  function policyMatches(body: unknown, plan: CellCreatePlan): boolean {
    return (
      isRecord(body) &&
      body.mode === "enforcing" &&
      isRecord(body.policy) &&
      body.policy.defaultAction === "deny" &&
      sameRules(body.policy.egress, plan.networkPolicy.egress)
    );
  }

  /** One policy read: a 5xx or transport failure is "retry"; any other miss is a mismatch. */
  async function probePolicy(
    cellId: string,
    plan: CellCreatePlan,
  ): Promise<"match" | "mismatch" | "retry"> {
    let res: Response;
    try {
      res = await once("GET", cellPath(cellId, "/networkpolicy"), {
        timeoutMs: requestTimeoutMs,
      });
    } catch {
      return "retry"; // a cell still starting may not answer yet
    }
    if (res.status >= 500) {
      await discard(res);
      return "retry";
    }
    if (!res.ok) {
      await discard(res);
      return "mismatch";
    }
    try {
      return policyMatches(
        await readCappedJson("policy", res, MAX_POLICY_BODY_BYTES),
        plan,
      )
        ? "match"
        : "mismatch";
    } catch {
      return "mismatch"; // a non-JSON body is not an enforcing policy
    }
  }

  /**
   * An adopted cell's live policy must be the plan's: anything else is torn down.
   * Runs after `waitReady`; a 5xx or transport failure is retried within the
   * readiness budget, a 2xx mismatch or a 404 fails at once.
   */
  async function verifyAdoptedPolicy(
    cellId: string,
    plan: CellCreatePlan,
  ): Promise<void> {
    const verdict = await withinBudget<"match" | "mismatch", undefined>(
      readyTimeoutMs,
      async () => {
        const probed = await probePolicy(cellId, plan);
        return probed === "retry"
          ? { retryInMs: PING_INTERVAL_MS, last: undefined }
          : { done: probed };
      },
      () => "mismatch",
    );
    if (verdict === "match") return;
    await teardownSteps(cellId);
    throw new CellProviderError("http_error", "create");
  }

  /** `undefined` when the POST failed in transport, so its delivery is unknown. */
  async function postCreate(plan: CellCreatePlan): Promise<Sent | undefined> {
    try {
      return await send("create", "POST", "/sandboxes", {
        body: createBody(plan),
        retry: "undelivered",
      });
    } catch (error) {
      // Any transport failure of this POST is ambiguous: the server may have made the cell.
      if (error instanceof CellProviderError && error.op === "create") {
        return undefined;
      }
      throw error;
    }
  }

  /** `adopted` when the id came from list-and-adopt rather than the create reply. */
  async function createSandbox(
    plan: CellCreatePlan,
  ): Promise<{ cellId: string; adopted: boolean }> {
    const sent = await postCreate(plan);
    if (!sent) return adopt(plan);
    const { res, code } = sent;
    if (res.status >= 500) {
      await discard(res);
      if (res.status === 502 && code === CONNECTION_FAILED) {
        throw new CellProviderError("http_error", "create", 502);
      }
      return adopt(plan, res.status);
    }
    await requireOk("create", res);
    let id: unknown;
    try {
      const body = await readCappedJson("create", res, MAX_CREATE_REPLY_BYTES);
      id = isRecord(body) ? body.id : undefined;
    } catch {
      id = undefined; // an unparseable body is treated like a missing id
    }
    if (typeof id !== "string" || id === "") {
      return adopt(plan, res.status);
    }
    return { cellId: id, adopted: false };
  }

  async function pingOk(cellId: string): Promise<boolean> {
    try {
      const res = await once("GET", execd(cellId, "ping"), {
        timeoutMs: requestTimeoutMs,
      });
      await discard(res);
      return res.ok;
    } catch {
      return false; // not yet
    }
  }

  function waitReady(cellId: string): Promise<void> {
    return withinBudget(
      readyTimeoutMs,
      async () =>
        (await pingOk(cellId))
          ? { done: undefined }
          : { retryInMs: PING_INTERVAL_MS, last: undefined },
      () => {
        throw new CellProviderError("not_ready", "ready");
      },
    );
  }

  /** Fail closed: only the probe's blocked exit proves the policy is enforced. */
  async function selfCheck(cellId: string): Promise<void> {
    let outcome: CellExecResult;
    try {
      outcome = await exec(cellId, config.selfCheck.argv);
    } catch {
      throw new CellProviderError("egress_not_enforced", "selfcheck");
    }
    if (outcome.exitCode !== OPENSANDBOX_SELF_CHECK_BLOCKED_EXIT) {
      throw new CellProviderError("egress_not_enforced", "selfcheck");
    }
  }

  async function writeVault(
    cellId: string,
    vault: readonly CellVaultEntry[],
  ): Promise<void> {
    const { res } = await send(
      "vault",
      "POST",
      cellPath(cellId, "/credential-vault"),
      { body: vaultBody(vault), retry: "undelivered" },
    );
    await requireOk("vault", res);
    await discard(res);
  }

  async function create(plan: CellCreatePlan): Promise<{ cellId: string }> {
    if (!isNonBlank(config.image)) {
      throw new CellProviderError("invalid_config", "create");
    }
    guardPlan(plan);
    const { cellId, adopted } = await createSandbox(plan);
    if (adopted) {
      // Ready first (a starting cell's policy read 5xxs), then the policy is
      // proven, and only then the self-check and the vault.
      try {
        await waitReady(cellId);
      } catch (error) {
        await teardownSteps(cellId);
        throw error;
      }
      await verifyAdoptedPolicy(cellId, plan);
    }
    try {
      if (!adopted) await waitReady(cellId);
      await selfCheck(cellId);
      await writeVault(cellId, plan.vault);
    } catch (error) {
      // Contract order: revoke (an adopted cell's vault state is unknown; a
      // 404 is a no-op) → quarantine → delete. Best-effort, so the original
      // error is rethrown.
      await teardownSteps(cellId);
      throw error;
    }
    deps.logger.info("cell created", { cellId });
    return { cellId };
  }

  return {
    create,
    exec,
    copyOut,
    revoke,
    quarantine,
    delete: del,
    teardown: teardownStrict,
    listByTags,
  };
}
