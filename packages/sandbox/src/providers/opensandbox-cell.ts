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
  CellTags,
  CellVaultEntry,
  ICellProvider,
} from "@terragon/types/cell";

/** The self-check probe exits with this code when the denied host was blocked. */
export const OPENSANDBOX_SELF_CHECK_BLOCKED_EXIT = 3;

const DEFAULT_EXECD_PORT = 44772;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_BUDGET_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const EXEC_SLACK_MS = 10_000;
const MIN_TTL_SECONDS = 60;
const PING_INTERVAL_MS = 100;
const LIST_PAGE_SIZE = 100;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 2_000;
const CONNECTION_FAILED = "BACKEND_CONNECTION_FAILED";

export type CellProviderErrorCode =
  | "runtime_not_runc"
  | "policy_required"
  | "ttl_too_short"
  | "invalid_argv"
  | "not_ready"
  | "egress_not_enforced"
  | "http_error";

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
  /** The probe exits `OPENSANDBOX_SELF_CHECK_BLOCKED_EXIT` when egress is blocked. */
  selfCheck: { argv: readonly string[] };
  readyTimeoutMs?: number;
  retryBudgetMs?: number;
  requestTimeoutMs?: number;
}

export interface OpenSandboxCellDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  logger: {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
  };
}

type RetryMode = "idempotent" | "undelivered";

interface SendOptions {
  body?: unknown;
  retry: RetryMode;
  timeoutMs?: number;
}

interface CommandOutcome extends CellExecResult {
  errored: boolean;
}

interface ListPage {
  items?: { id: string; metadata?: Record<string, string> }[];
  pagination?: { hasNextPage?: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function guardPlan(plan: CellCreatePlan): void {
  // Callers can be untyped, so re-check what the type promises.
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
  if (Math.ceil(plan.ttlMs / 1000) < MIN_TTL_SECONDS) {
    throw new CellProviderError("ttl_too_short", "create");
  }
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
      auth: { type: v.auth, credential: v.name },
    })),
  };
}

function parseExecStream(text: string): CommandOutcome | undefined {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  let errored = false;
  for (const line of text.split("\n")) {
    const raw = line.replace(/^data:\s*/, "").trim();
    if (!raw.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      continue; // a partial line
    }
    if (!isRecord(event)) continue;
    if (event.type === "stdout" && typeof event.text === "string") {
      stdout += event.text;
    } else if (event.type === "stderr" && typeof event.text === "string") {
      stderr += event.text;
    } else if (event.type === "execution_complete") {
      exitCode = asNumber(event.exit_code) ?? 0;
    } else if (event.type === "error") {
      errored = true;
      const inner = isRecord(event.error) ? event.error : {};
      exitCode = asNumber(inner.exit_code) ?? asNumber(event.exit_code) ?? -1;
    }
  }
  return exitCode === undefined
    ? undefined
    : { exitCode, stdout, stderr, errored };
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

  const execd = (id: string, suffix: string): string =>
    `/sandboxes/${encodeURIComponent(id)}/proxy/${port}/${suffix}`;

  async function once(
    method: string,
    path: string,
    o: { body?: unknown; timeoutMs: number },
  ): Promise<Response> {
    const hasBody = o.body !== undefined;
    return deps.fetch(`${base}${path}`, {
      method,
      headers: {
        "OPEN-SANDBOX-API-KEY": config.apiKey,
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(o.body) } : {}),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  }

  /** The JSON body's `code` only; the body itself is never kept or logged. */
  async function bodyCode(res: Response): Promise<string | undefined> {
    try {
      const parsed: unknown = JSON.parse(await res.clone().text());
      return isRecord(parsed) && typeof parsed.code === "string"
        ? parsed.code
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function mayRetry(res: Response, mode: RetryMode): Promise<boolean> {
    if (res.status !== 502) return false;
    return mode === "idempotent" || (await bodyCode(res)) === CONNECTION_FAILED;
  }

  async function send(
    op: string,
    method: string,
    path: string,
    o: SendOptions,
  ): Promise<Response> {
    const start = deps.now();
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await once(method, path, {
          body: o.body,
          timeoutMs: o.timeoutMs ?? requestTimeoutMs,
        });
      } catch {
        throw new CellProviderError("http_error", op); // no cause: it may echo a request
      }
      if (!(await mayRetry(res, o.retry))) return res;
      if (deps.now() - start >= retryBudgetMs) return res;
      await deps.sleep(
        Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS),
      );
    }
  }

  function requireOk(op: string, res: Response): void {
    if (!res.ok) throw new CellProviderError("http_error", op, res.status);
  }

  async function listByTags(tags: Partial<CellTags>): Promise<CellListEntry[]> {
    const defined = Object.entries(tags).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    );
    const filter = new URLSearchParams({
      automata: "cell",
      ...Object.fromEntries(defined),
    }).toString();
    const out: CellListEntry[] = [];
    for (let page = 1; ; page++) {
      const res = await send(
        "list",
        "GET",
        `/sandboxes?metadata=${encodeURIComponent(filter)}&page=${page}&pageSize=${LIST_PAGE_SIZE}`,
        { retry: "idempotent" },
      );
      requireOk("list", res);
      const body = (await res.json()) as ListPage;
      for (const item of body.items ?? []) {
        out.push({ cellId: item.id, tags: item.metadata ?? {} });
      }
      if (!body.pagination?.hasNextPage) return out;
    }
  }

  async function del(cellId: string): Promise<"deleted" | "gone"> {
    const res = await send(
      "delete",
      "DELETE",
      `/sandboxes/${encodeURIComponent(cellId)}`,
      { retry: "idempotent" },
    );
    if (res.status === 404) return "gone";
    requireOk("delete", res);
    return "deleted";
  }

  async function quarantine(cellId: string): Promise<void> {
    const res = await send(
      "quarantine",
      "PUT",
      `/sandboxes/${encodeURIComponent(cellId)}/networkpolicy?dropEstablished=true`,
      { body: { defaultAction: "deny", egress: [] }, retry: "idempotent" },
    );
    if (res.status === 404) return;
    requireOk("quarantine", res);
  }

  async function revoke(cellId: string): Promise<void> {
    const res = await send(
      "revoke",
      "DELETE",
      `/sandboxes/${encodeURIComponent(cellId)}/credential-vault`,
      { retry: "idempotent" },
    );
    if (res.status === 404) return;
    requireOk("revoke", res);
  }

  async function runCommand(
    cellId: string,
    argv: readonly string[],
    opts?: CellExecOptions,
  ): Promise<CommandOutcome> {
    if (argv.length === 0 || !argv[0]) {
      throw new CellProviderError("invalid_argv", "exec");
    }
    const timeout = opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const res = await send("exec", "POST", execd(cellId, "command"), {
      body: {
        argv: [...argv],
        timeout,
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      },
      retry: "undelivered",
      timeoutMs: timeout + EXEC_SLACK_MS,
    });
    requireOk("exec", res);
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new CellProviderError("http_error", "exec");
    }
    const outcome = parseExecStream(text);
    if (!outcome) throw new CellProviderError("http_error", "exec");
    return outcome;
  }

  async function exec(
    cellId: string,
    argv: string[],
    opts?: CellExecOptions,
  ): Promise<CellExecResult> {
    const { exitCode, stdout, stderr } = await runCommand(cellId, argv, opts);
    return { exitCode, stdout, stderr };
  }

  async function copyOut(cellId: string, path: string): Promise<Uint8Array> {
    const res = await send(
      "copyOut",
      "GET",
      `${execd(cellId, "files/download")}?path=${encodeURIComponent(path)}`,
      { retry: "idempotent" },
    );
    requireOk("copyOut", res);
    return new Uint8Array(await res.arrayBuffer());
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

  async function teardownMany(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      for (const step of [quarantine, del] as const) {
        try {
          await step(id);
        } catch {
          deps.logger.warn("cell teardown step failed", { cellId: id });
        }
      }
    }
  }

  /** A non-delivery 502 may still have created the cell: find it by its tags. */
  async function adoptByTags(plan: CellCreatePlan): Promise<string> {
    const start = deps.now();
    const key = { stepKey: plan.tags.stepKey, attempt: plan.tags.attempt };
    for (;;) {
      const found = await listByTags(key);
      if (found.length === 1 && found[0]) return found[0].cellId;
      if (found.length > 1) {
        await teardownMany(found.map((f) => f.cellId));
        throw new CellProviderError("http_error", "create", 502);
      }
      if (deps.now() - start >= retryBudgetMs) {
        throw new CellProviderError("http_error", "create", 502);
      }
      await deps.sleep(BACKOFF_BASE_MS);
    }
  }

  async function createSandbox(plan: CellCreatePlan): Promise<string> {
    const res = await send("create", "POST", "/sandboxes", {
      body: createBody(plan),
      retry: "undelivered",
    });
    if (res.status === 502) {
      if ((await bodyCode(res)) === CONNECTION_FAILED) {
        throw new CellProviderError("http_error", "create", 502);
      }
      return adoptByTags(plan);
    }
    requireOk("create", res);
    let id: unknown;
    try {
      const body: unknown = await res.json();
      id = isRecord(body) ? body.id : undefined;
    } catch {
      id = undefined;
    }
    if (typeof id !== "string" || id === "") {
      throw new CellProviderError("http_error", "create", res.status);
    }
    return id;
  }

  async function pingOk(cellId: string): Promise<boolean> {
    try {
      const res = await once("GET", execd(cellId, "ping"), {
        timeoutMs: requestTimeoutMs,
      });
      return res.ok;
    } catch {
      return false; // not yet
    }
  }

  async function waitReady(cellId: string): Promise<void> {
    const start = deps.now();
    for (;;) {
      if (await pingOk(cellId)) return;
      if (deps.now() - start >= readyTimeoutMs) {
        throw new CellProviderError("not_ready", "ready");
      }
      await deps.sleep(PING_INTERVAL_MS);
    }
  }

  /** Fail closed: only the probe's blocked exit proves the policy is enforced. */
  async function selfCheck(cellId: string): Promise<void> {
    let outcome: CommandOutcome;
    try {
      outcome = await runCommand(cellId, config.selfCheck.argv);
    } catch {
      throw new CellProviderError("egress_not_enforced", "selfcheck");
    }
    if (
      outcome.errored ||
      outcome.exitCode !== OPENSANDBOX_SELF_CHECK_BLOCKED_EXIT
    ) {
      throw new CellProviderError("egress_not_enforced", "selfcheck");
    }
  }

  async function writeVault(
    cellId: string,
    vault: readonly CellVaultEntry[],
  ): Promise<void> {
    const res = await send(
      "vault",
      "POST",
      `/sandboxes/${encodeURIComponent(cellId)}/credential-vault`,
      { body: vaultBody(vault), retry: "undelivered" },
    );
    requireOk("vault", res);
  }

  async function bestEffort(step: () => Promise<unknown>, cellId: string) {
    try {
      await step();
    } catch {
      deps.logger.warn("cell teardown step failed", { cellId });
    }
  }

  async function create(plan: CellCreatePlan): Promise<{ cellId: string }> {
    guardPlan(plan);
    const cellId = await createSandbox(plan);
    let vaultTried = false;
    try {
      await waitReady(cellId);
      await selfCheck(cellId);
      vaultTried = true;
      await writeVault(cellId, plan.vault);
    } catch (error) {
      if (vaultTried) await bestEffort(() => revoke(cellId), cellId);
      await bestEffort(() => quarantine(cellId), cellId);
      await bestEffort(() => del(cellId), cellId);
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
    listByTags,
  };
}
