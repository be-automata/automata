import {
  type BroadcastSandboxMessage,
  type BroadcastClientMessage,
  BroadcastClientMessageSchema,
  parseBroadcastChannel,
  type BroadcastSandboxTerminalState,
} from "@terragon/types/broadcast";
import type { SandboxProvider } from "@terragon/types/sandbox";
import { Sandbox as E2bSandbox } from "@e2b/code-interpreter";
import * as Party from "partykit/server";
import debounce from "lodash.debounce";
import { validateRequest } from "./auth";
import { getPublicAppUrl } from "@terragon/env/apps-broadcast";

const SLEEP_MS = 1000 * 60 * 5; // 5 minutes

class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

type PtyCreateOptions = {
  cols: number;
  rows: number;
  envs: Record<string, string>;
  onData: (data: Uint8Array) => void;
};

interface ISandboxSession {
  extendSandboxTimeout(timeoutMs: number): Promise<void>;
  createPty(options: PtyCreateOptions): Promise<number>;
  sendPtyInput(pid: number, input: Uint8Array): Promise<void>;
  resizePty(
    pid: number,
    options: { cols: number; rows: number },
  ): Promise<void>;
  killPty(pid: number): Promise<void>;
}

async function resumeSandboxSession({
  sandboxId,
  sandboxProvider,
  options,
}: {
  sandboxId: string;
  sandboxProvider: SandboxProvider;
  options: {
    e2bApiKey?: string;
    daytonaApiKey?: string;
  };
}): Promise<ISandboxSession> {
  switch (sandboxProvider) {
    case "e2b": {
      if (!options.e2bApiKey) {
        throw new Error("E2B_API_KEY is not set");
      }
      const e2bSandbox = await E2bSandbox.resume(sandboxId, {
        // @ts-expect-error - autoPause is not public
        autoPause: true,
        timeoutMs: SLEEP_MS,
        apiKey: options.e2bApiKey,
      });
      return {
        extendSandboxTimeout: async () => {
          await e2bSandbox.setTimeout(SLEEP_MS);
        },
        createPty: async (options: PtyCreateOptions) => {
          const ptyHandle = await e2bSandbox.pty.create({
            user: "root",
            cwd: "/root/repo",
            ...options,
          });
          return ptyHandle.pid;
        },
        sendPtyInput: async (pid, input) => {
          await e2bSandbox.pty.sendInput(pid, input);
        },
        resizePty: async (pid, { cols, rows }) => {
          await e2bSandbox.pty.resize(pid, { cols, rows });
        },
        killPty: async (pid) => {
          await e2bSandbox.pty.kill(pid);
        },
      };
    }
    case "daytona": {
      // NOTE: partykit deployment doesn't like the daytona sdk so comment thing out for now
      throw new Error("Unsupported sandbox provider");
    }
    case "docker":
    case "mock":
    // hatchet-remote threads have no attachable sandbox; www never offers the
    // terminal for them (apps/www/src/lib/sandbox-terminal.ts).
    case "hatchet-remote":
      throw new Error("Unsupported sandbox provider");
    default:
      const _exhaustiveCheck: never = sandboxProvider;
      throw new Error(`Unsupported sandbox provider: ${_exhaustiveCheck}`);
  }
}

export default class SandboxParty implements Party.Server {
  options: Party.ServerOptions = {
    hibernate: false, // Keep alive for PTY sessions
  };

  private infoByConnectionId: Record<
    string,
    {
      sandbox: ISandboxSession | null;
      ptyPid: number | null;
      ptyRows: number;
      ptyCols: number;
      state: BroadcastSandboxTerminalState;
    }
  > = {};

  constructor(readonly room: Party.Room) {}

  private getChannelInfo() {
    const channel = parseBroadcastChannel(this.room.id);
    if (!channel || channel.type !== "sandbox") {
      throw new Error("Invalid lobby id");
    }
    return channel;
  }

  private getSandboxId() {
    const channel = this.getChannelInfo();
    return channel.sandboxId;
  }

  private getSandboxProvider() {
    const channel = this.getChannelInfo();
    return channel.sandboxProvider;
  }

  private async cleanUpConnection(conn: Party.Connection) {
    const info = this.infoByConnectionId[conn.id];
    if (info.ptyPid) {
      try {
        await info.sandbox?.killPty(info.ptyPid);
      } catch (e) {
        // Ignore errors during kill
        console.error(`[SandboxParty] Error killing PTY:`, e);
      }
    }
    if (info) {
      delete this.infoByConnectionId[conn.id];
    }
  }

  private initializeConnection(conn: Party.Connection) {
    if (conn.id in this.infoByConnectionId) {
      throw new Error("Connection already initialized");
    }
    this.infoByConnectionId[conn.id] = {
      sandbox: null,
      ptyPid: null,
      ptyRows: 24,
      ptyCols: 80,
      state: { status: "initializing", pid: null },
    };
    this.updateAndSendState(conn, { status: "initializing", pid: null });
  }

  private getInfoOrThrow(conn: Party.Connection) {
    const info = this.infoByConnectionId[conn.id];
    if (!info) {
      throw new Error("Connection not initialized");
    }
    return info;
  }

  private setSandboxActive = debounce(
    async (conn: Party.Connection) => {
      const channel = this.getChannelInfo();
      const url = new URL(conn.uri);
      const token = url.searchParams.get("token");
      await fetch(
        `${getPublicAppUrl(this.room.env)}/api/internal/broadcast/sandbox/keepalive`,
        {
          method: "POST",
          body: JSON.stringify({
            sandboxId: channel.sandboxId,
            threadId: channel.threadId,
          }),
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    },
    60000, // 1 minute
    { leading: true, trailing: true },
  );

  private extendSandboxTimeout = debounce(
    async (sandbox: ISandboxSession) => {
      await sandbox.extendSandboxTimeout(SLEEP_MS);
    },
    60000, // 1 minute
    { leading: true, trailing: true },
  );

  private async getSandboxEnvironmentVariables(conn: Party.Connection) {
    const channel = this.getChannelInfo();
    const url = new URL(conn.uri);
    const token = url.searchParams.get("token");
    const response = await fetch(
      `${getPublicAppUrl(this.room.env)}/api/internal/broadcast/sandbox/env`,
      {
        method: "POST",
        body: JSON.stringify({
          sandboxId: channel.sandboxId,
          threadId: channel.threadId,
        }),
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const json = (await response.json()) as {
      environmentVariables: Record<string, string>;
    };
    if (!response.ok) {
      throw new Error("Failed to get environment variables to start sandbox");
    }
    return json.environmentVariables;
  }

  private async getOrCreateSandbox(conn: Party.Connection) {
    const info = this.getInfoOrThrow(conn);
    if (!info.sandbox) {
      const isInitializing = info.state.status === "initializing";
      this.updateAndSendState(conn, {
        status: isInitializing ? "connecting" : "reconnecting",
        pid: null,
      });
      try {
        await this.setSandboxActive(conn);
        info.sandbox = await resumeSandboxSession({
          sandboxId: this.getSandboxId(),
          sandboxProvider: this.getSandboxProvider(),
          options: {
            e2bApiKey: this.room.env.E2B_API_KEY as string | undefined,
            daytonaApiKey: this.room.env.DAYTONA_API_KEY as string | undefined,
          },
        });
        this.updateAndSendState(conn, { status: "connected" });
      } catch (e) {
        console.error(`[SandboxParty] Error getting sandbox:`, e);
        throw new UserFacingError("Failed to connect to sandbox");
      }
    }
    return info.sandbox;
  }

  private async extendSandboxLife(
    conn: Party.Connection,
    sandbox: ISandboxSession,
  ) {
    await Promise.all([
      this.setSandboxActive(conn),
      this.extendSandboxTimeout(sandbox),
    ]);
  }

  private async getOrCreateSandboxPty(
    conn: Party.Connection,
    options: { cols: number; rows: number },
  ) {
    const info = this.getInfoOrThrow(conn);
    if (!info.ptyPid) {
      const sandbox = await this.getOrCreateSandbox(conn);
      const envs = await this.getSandboxEnvironmentVariables(conn);
      info.ptyRows = options.rows;
      info.ptyCols = options.cols;
      info.ptyPid = await sandbox.createPty({
        cols: info.ptyCols,
        rows: info.ptyRows,
        envs,
        onData: (data) => {
          const text = new TextDecoder().decode(data);
          this.sendPtyData(conn, text);
          this.extendSandboxLife(conn, sandbox);
        },
      });
      this.updateAndSendState(conn, { status: "connected", pid: info.ptyPid });
    }
    return info.ptyPid;
  }

  private sendMessage(
    conn: Party.Connection,
    message: BroadcastSandboxMessage,
  ) {
    conn.send(JSON.stringify(message));
  }

  private updateAndSendState(
    conn: Party.Connection,
    state: Partial<BroadcastSandboxTerminalState>,
  ) {
    const info = this.getInfoOrThrow(conn);
    info.state = { ...info.state, ...state };
    this.sendMessage(conn, {
      type: "sandbox",
      id: this.getSandboxId(),
      state: info.state,
    });
  }

  private sendPtyData(conn: Party.Connection, data: string) {
    const info = this.getInfoOrThrow(conn);
    this.sendMessage(conn, {
      type: "sandbox",
      id: this.getSandboxId(),
      state: info.state,
      ptyData: data,
    });
  }

  private async withSandboxPty(
    conn: Party.Connection,
    callback: (sandbox: ISandboxSession, ptyPid: number) => Promise<void>,
  ) {
    const info = this.getInfoOrThrow(conn);
    if (info.state.status !== "connected") {
      // Ignore if not connected
      return;
    }

    const numAttempts = 2;
    let lastError: any = null;

    for (let i = 0; i < numAttempts; i++) {
      try {
        const sandbox = await this.getOrCreateSandbox(conn);
        const ptyPid = await this.getOrCreateSandboxPty(conn, {
          cols: info.ptyCols,
          rows: info.ptyRows,
        });
        await callback(sandbox, ptyPid);
        await this.extendSandboxLife(conn, sandbox);
        return;
      } catch (e) {
        console.error(`[SandboxParty] Error in withSandboxPty:`, e);
        if (e instanceof Error && e.name === "TimeoutError") {
          this.updateAndSendState(conn, {
            status: "error",
            error: "Sandbox connection timed out",
          });
        }
        lastError = e;
        info.sandbox = null;
        info.ptyPid = null;
      }
    }
    if (lastError) {
      throw lastError;
    }
  }

  static async onBeforeConnect(request: Party.Request, lobby: Party.Lobby) {
    try {
      await validateRequest(
        request,
        lobby.id,
        lobby.env as Record<string, unknown>,
      );
      return request;
    } catch (e) {
      console.error(e);
      return new Response("Unauthorized", {
        status: 401,
      });
    }
  }

  private validateClientMessage(message: string): BroadcastClientMessage {
    try {
      const result = BroadcastClientMessageSchema.safeParse(
        JSON.parse(message),
      );
      if (
        !result.success ||
        result.data.type !== "sandbox" ||
        result.data.id !== this.getSandboxId()
      ) {
        throw new Error("Invalid client message");
      }
      return result.data;
    } catch (e) {
      console.error(`[SandboxParty] Invalid client message: ${message}`, e);
      throw new Error("Invalid client message");
    }
  }

  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    console.log(`[SandboxParty] Connection opened: ${conn.id}`);
    this.initializeConnection(conn);
  }

  async onMessage(message: string, sender: Party.Connection) {
    try {
      const messageParsed = this.validateClientMessage(message); // Handle creating a new PTY session
      const messageData = messageParsed.data;
      switch (messageData.type) {
        case "sandbox-pty-connect": {
          await this.getOrCreateSandboxPty(sender, {
            cols: messageData.cols || 80,
            rows: messageData.rows || 24,
          });
          break;
        }
        case "sandbox-pty-input": {
          await this.withSandboxPty(sender, async (sandbox, ptyPid) => {
            if (ptyPid === messageData.pid) {
              await sandbox.sendPtyInput(
                ptyPid,
                new TextEncoder().encode(messageData.input ?? ""),
              );
            }
          });
          break;
        }
        case "sandbox-pty-resize": {
          const cols = messageData.cols;
          const rows = messageData.rows;
          if (cols && rows) {
            await this.withSandboxPty(sender, async (sandbox, ptyPid) => {
              if (ptyPid === messageData.pid) {
                await sandbox.resizePty(ptyPid, { cols, rows });
              }
            });
          }
          break;
        }
      }
    } catch (e) {
      console.error(`[SandboxParty] Error handling message:`, message, e);
      this.updateAndSendState(sender, {
        status: "error",
        // TODO: Hide the error message from the client
        error: e instanceof UserFacingError ? e.message : "Unexpected error",
      });
    }
  }

  async onClose(conn: Party.Connection) {
    console.log(`[SandboxParty] Connection closed: ${conn.id}`);
    await this.cleanUpConnection(conn);
    conn.close();
  }

  async onError(conn: Party.Connection, error: Error) {
    console.error(`[SandboxParty] Error for connection ${conn.id}:`, error);
    await this.cleanUpConnection(conn);
    conn.close();
  }
}

SandboxParty satisfies Party.Worker;
