import readline from "node:readline";
import { loadConfig, configureProvider, setConfigValue, rememberAllowedTool } from "../config/config.js";
import { listAvailableModels } from "../core/provider.js";
import { PermissionState, type PermissionDecision } from "../core/permissions.js";
import { loadChatConfig, streamChatTurn } from "../core/chat.js";

const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
// Keep the stdout channel reserved for structured messages.
console.log = (...args) => console.error(...args);
let active: AbortController | undefined;
const approvals = new Map<string, (decision: PermissionDecision) => void>();
function settings() {
  const { provider, model, baseUrl } = loadConfig();
  return { provider, model, baseUrl };
}

async function handle(message: any) {
  const { id, method, data } = message;
  try {
    if (method === "permission") {
      const decision = ["allow-once", "allow-always", "deny"].includes(data?.decision) ? data.decision : "deny";
      approvals.get(data?.id)?.(decision);
      approvals.delete(data?.id);
      return;
    }
    if (method === "stop") {
      active?.abort();
      for (const resolve of approvals.values()) resolve("deny");
      approvals.clear();
      return;
    }
    if (active) throw new Error("Wait for the current response to finish.");
    if (method === "settings") emit({ id, result: settings() });
    else if (method === "saveSettings") {
      if (!data || typeof data.provider !== "string" || typeof data.model !== "string" || !data.model.trim()) {
        throw new Error("Choose a provider and enter a model ID.");
      }
      const url = new URL(data.baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use an HTTP or HTTPS base URL.");
      configureProvider(data.provider, data.model);
      setConfigValue("baseUrl", url.href.replace(/\/$/, ""));
      if (typeof data.apiKey === "string" && data.apiKey.trim()) setConfigValue("apiKey", data.apiKey.trim());
      emit({ id, result: settings() });
    } else if (method === "models") emit({ id, result: await listAvailableModels(loadConfig()) });
    else if (method === "chat") await chat(id, data);
    else throw new Error("Unknown desktop request.");
  } catch (error) {
    emit({ id, error: error instanceof Error ? error.message : String(error) });
  }
}

async function chat(id: string, data: any) {
  if (!data || !Array.isArray(data.messages) || data.messages.length > 500 ||
      data.messages.some((m: any) => !["user", "assistant"].includes(m.role) || typeof m.content !== "string")) {
    throw new Error("Invalid conversation.");
  }
  process.chdir(data.cwd);
  const controller = new AbortController();
  active = controller;
  try {
    const { config } = loadChatConfig();
    const permissions = new PermissionState({
      configAllowed: config.allowedTools,
      promptFn: (request) => new Promise((resolve) => {
        if (controller.signal.aborted) return resolve("deny");
        const permissionId = crypto.randomUUID();
        approvals.set(permissionId, (decision) => {
          if (decision === "allow-always") {
            try { rememberAllowedTool(request.toolName); }
            catch {
              emit({ event: "error", data: "Could not save this permission. The action was denied; try Allow once instead." });
              resolve("deny");
              return;
            }
          }
          resolve(decision);
        });
        emit({ event: "permission", data: { ...request, id: permissionId } });
      })
    });
    const result = await streamChatTurn(config, data.messages,
      (chunk) => emit({ event: "chunk", data: chunk }),
      (event) => emit({ event: "tool", data: event }), controller.signal,
      { permissionState: permissions });
    emit({ id, result: { ...result, stopped: controller.signal.aborted } });
  } finally {
    active = undefined;
    for (const resolve of approvals.values()) resolve("deny");
    approvals.clear();
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  try { void handle(JSON.parse(line)); }
  catch { emit({ error: "Invalid desktop message." }); }
});
