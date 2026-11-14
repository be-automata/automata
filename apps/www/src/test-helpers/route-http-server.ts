import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Serve a Web `Request -> Response` handler over real HTTP so real binaries
 * (git, gh) can talk to a route handler in tests. Listens on 127.0.0.1 with an
 * ephemeral port, or on a unix socket when `socketPath` is given (gh reaches a
 * plain-HTTP server that way). A failed listen rejects with the original error,
 * `code` intact (EPERM/EACCES), so callers can skip.
 */
export interface RouteServer {
  /** `http://127.0.0.1:<port>` (empty for a unix socket). */
  url: string;
  close(): Promise<void>;
}

type RouteHandler = (request: Request) => Promise<Response>;

/**
 * The request body as a web stream. Built by hand, not with `Readable.toWeb`:
 * when a handler cancels the body (a push over the cap) that adapter keeps
 * enqueuing 'data' into its closed controller and throws. Here a cancel only
 * drains and discards the rest, so the response can still be sent.
 */
function bodyStream(req: IncomingMessage): ReadableStream<Uint8Array> {
  let finished = false;
  const finish = (action: () => void) => {
    if (finished) return;
    finished = true;
    try {
      action();
    } catch {
      // The consumer already closed the stream.
    }
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer) => {
        if (finished) return;
        try {
          controller.enqueue(chunk);
        } catch {
          finished = true;
        }
      });
      req.on("end", () => finish(() => controller.close()));
      req.on("error", (error) => finish(() => controller.error(error)));
      req.on("close", () =>
        finish(() => controller.error(new Error("request aborted"))),
      );
    },
    cancel() {
      finished = true;
      req.resume();
    },
  });
}

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`;
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: bodyStream(req), duplex: "half" } : {}),
  } as RequestInit);
}

async function serve(
  handler: RouteHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const response = await handler(toRequest(req));
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.statusCode = response.status;
  if (response.body) {
    await pipeline(Readable.fromWeb(response.body as never), res);
  } else {
    res.end();
  }
}

export async function startRouteServer(
  handler: RouteHandler,
  opts: { socketPath?: string } = {},
): Promise<RouteServer> {
  const server = createServer((req, res) => {
    serve(handler, req, res).catch((error: unknown) => {
      console.error(
        "route-http-server: handler failed",
        error instanceof Error ? error.message : String(error),
      );
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (opts.socketPath) server.listen(opts.socketPath, resolve);
    else server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const url =
    typeof address === "object" && address
      ? `http://127.0.0.1:${address.port}`
      : "";
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
