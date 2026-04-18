import type { Server } from "bun";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RelayRequest {
  id: number;
  type: string;
  method?: string;
  params?: Record<string, any>;
  tabId?: number;
  url?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RELAY_PORT = 9223;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let server: Server | null = null;
let extensionConnected = false;
let lastPollTime = 0;

// Command queue: relay pushes commands, extension polls for them
let pendingCommand: { req: RelayRequest; resolve: (result: any) => void; reject: (err: Error) => void } | null = null;

// When extension polls and there's no command, we hold the response open (long-poll)
let waitingPoll: { resolve: (resp: Response) => void } | null = null;

let nextId = 1;

// ---------------------------------------------------------------------------
// Public API — send commands to the extension
// ---------------------------------------------------------------------------

function sendRequest(msg: Omit<RelayRequest, "id">): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!extensionConnected) {
      reject(new Error("Extension not connected"));
      return;
    }

    const id = nextId++;
    const req = { ...msg, id } as RelayRequest;

    // If there's already a pending command, reject the old one
    if (pendingCommand) {
      pendingCommand.reject(new Error("Superseded by new command"));
    }

    pendingCommand = { req, resolve, reject };

    // If extension is already long-polling, respond immediately
    if (waitingPoll) {
      const poll = waitingPoll;
      waitingPoll = null;
      poll.resolve(new Response(JSON.stringify(req), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }));
    }

    // Timeout after 30s
    setTimeout(() => {
      if (pendingCommand && pendingCommand.req.id === id) {
        pendingCommand.reject(new Error(`Relay request timed out: ${msg.type} ${msg.method || ""}`));
        pendingCommand = null;
      }
    }, 30_000);
  });
}

/** Send a CDP command to a tab via the extension */
export function sendCommand(
  method: string,
  params?: Record<string, any>,
  tabId?: number
): Promise<any> {
  return sendRequest({ type: "command", method, params, tabId });
}

/** List all open tabs */
export function listTabs(): Promise<
  Array<{ tabId: number; title: string; url: string; active: boolean }>
> {
  return sendRequest({ type: "listTabs" });
}

/** Create a new tab */
export function createTab(url?: string): Promise<{ tabId: number }> {
  return sendRequest({ type: "createTab", url });
}

/** Close a tab */
export function closeTab(tabId: number): Promise<void> {
  return sendRequest({ type: "closeTab", tabId });
}

/** Activate (focus) a tab */
export function activateTab(tabId: number): Promise<void> {
  return sendRequest({ type: "activateTab", tabId });
}

/** Navigate a tab to a URL (uses chrome.tabs.update, no debugger needed) */
export function navigateTab(tabId: number, url: string): Promise<void> {
  return sendRequest({ type: "navigateTab", tabId, url });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function killExistingRelay(): Promise<void> {
  try {
    const proc = Bun.spawn(["lsof", "-ti", `:${RELAY_PORT}`], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const pids = text.trim().split(/\s+/).filter(Boolean);
    const myPid = String(process.pid);
    for (const pid of pids) {
      if (pid !== myPid) {
        try { process.kill(Number(pid), "SIGTERM"); } catch {}
      }
    }
    if (pids.length > 0) {
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch {}
}

export async function startRelayServer(): Promise<void> {
  if (server) return;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  const serve = () => Bun.serve({
    port: RELAY_PORT,
    idleTimeout: 30, // seconds — needed for long-poll (default is 10)
    async fetch(req) {
      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const url = new URL(req.url);

      function jsonResp(data: any) {
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Extension polls for commands (long-poll)
      if (req.method === "GET" && url.pathname === "/poll") {
        extensionConnected = true;
        lastPollTime = Date.now();

        // If there's a pending command, return it immediately
        if (pendingCommand) {
          const cmd = pendingCommand.req;
          return jsonResp(cmd);
        }

        // Otherwise, hold the connection open for up to 25 seconds (long-poll)
        return new Promise<Response>((resolve) => {
          waitingPoll = { resolve: (resp) => resolve(resp) };
          setTimeout(() => {
            if (waitingPoll) {
              waitingPoll = null;
              resolve(jsonResp({ type: "noop" }));
            }
          }, 25_000);
        });
      }

      // Extension posts command results
      if (req.method === "POST" && url.pathname === "/result") {
        extensionConnected = true;
        lastPollTime = Date.now();

        try {
          const body = await req.json() as { id: number; result?: any; error?: { message: string } };

          if (pendingCommand && pendingCommand.req.id === body.id) {
            const cmd = pendingCommand;
            pendingCommand = null;
            if (body.error) {
              cmd.reject(new Error(body.error.message));
            } else {
              cmd.resolve(body.result);
            }
          }
        } catch {}

        return jsonResp({ ok: true });
      }

      // Health check
      if (req.method === "GET" && url.pathname === "/") {
        return new Response("Patric Relay Server", { status: 200, headers: corsHeaders });
      }

      return new Response("Not found", { status: 404, headers: corsHeaders });
    },
  });

  try {
    server = serve();
  } catch {
    // Port likely in use by a stale process — kill it and retry
    await killExistingRelay();
    server = serve();
  }
}

export function stopRelayServer(): void {
  if (server) {
    server.stop(true);
    server = null;
  }
  extensionConnected = false;
  pendingCommand = null;
  waitingPoll = null;
}

export function isExtensionConnected(): boolean {
  // Consider connected if we heard from the extension in the last 60 seconds
  return extensionConnected && (Date.now() - lastPollTime < 60_000);
}

export function getRelayPort(): number {
  return RELAY_PORT;
}
