import fs from "node:fs";
import {
  getDefaultBaseUrl,
  getModelCompatibilityError,
  normalizeModelForProvider,
  normalizeProviderName,
  type PatricConfig
} from "./config";
import { getEffectiveAuth, setStoredOAuthAuth, type OAuthAuth, type ProviderAuth } from "./auth";
import { extractOpenAIAccountId, refreshGoogleOAuth, refreshOpenAIOAuth } from "./oauth";
import {
  buildAgentSystemPrompt,
  buildAgentTaskPrompt,
  createAgentManager,
  formatAgentPromptSummary,
  getEffectiveAgentToolNames,
  loadAgentRegistry,
  resolveAgentModel,
  type AgentManager,
  type AgentRegistry
} from "./agents";
import {
  AGENT_TOOL_NAMES,
  executeTool,
  getAllToolNames,
  getToolsForProvider,
  MAX_TOOL_ROUNDS,
  type ToolCall,
  type ToolEvent,
  type ToolResult
} from "./tools";
import { formatPermissionSummary, PermissionState } from "./permissions";

export type { ToolEvent } from "./tools";

export interface CompletionResult {
  ok: boolean;
  content: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RuntimeContext {
  allowedToolNames?: string[];
  agentManager?: AgentManager;
  agentRegistry?: AgentRegistry;
  agent?: {
    kind: "top-level" | "sub-agent";
    name?: string;
  };
  permissionState?: PermissionState;
}

type ProviderName = "openai" | "openai-codex" | "openrouter" | "anthropic" | "ollama" | "gemini";

const PATRIC_USER_AGENT = "patric/0.3.0";

interface ProviderResponse {
  ok: boolean;
  content: string;
  toolCalls: ToolCall[];
  error?: string;
  responseId?: string;
}

function normalizeProvider(config: PatricConfig): ProviderName {
  return normalizeProviderName(config.provider);
}

function resolveBaseUrl(config: PatricConfig): string {
  return (config.baseUrl || getDefaultBaseUrl(normalizeProvider(config))).replace(/\/$/, "");
}

function resolveModel(config: PatricConfig): string {
  return normalizeModelForProvider(config.provider, config.model);
}

function isLikelyOpenAIChatModel(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    /(embedding|whisper|tts|transcri|moderation|image|realtime|audio|search|computer-use)/.test(
      normalized
    )
  ) {
    return false;
  }
  return /^(gpt|o[1-9]|codex|chatgpt)/.test(normalized);
}

function rankOpenAIModel(id: string): number {
  const normalized = id.toLowerCase();
  const priorities = [
    "gpt-5.4",
    "gpt-5.2",
    "gpt-5.1",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o",
    "gpt-4o-mini",
    "o4-mini",
    "o3",
    "o3-mini",
    "codex-mini-latest"
  ];
  const exact = priorities.indexOf(normalized);
  if (exact >= 0) {
    return exact;
  }
  const prefix = priorities.findIndex((candidate) => normalized.startsWith(`${candidate}-`));
  if (prefix >= 0) {
    return prefix + priorities.length;
  }
  return priorities.length * 2;
}

function sortOpenAIModels(ids: string[]): string[] {
  return [...ids].sort((left, right) => {
    const leftRank = rankOpenAIModel(left);
    const rightRank = rankOpenAIModel(right);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    const leftSnapshot = /\d{4}-\d{2}-\d{2}/.test(left);
    const rightSnapshot = /\d{4}-\d{2}-\d{2}/.test(right);
    if (leftSnapshot !== rightSnapshot) {
      return leftSnapshot ? 1 : -1;
    }
    return left.localeCompare(right, undefined, { numeric: true });
  });
}

async function getResolvedAuth(config: PatricConfig): Promise<ProviderAuth | undefined> {
  const auth = getEffectiveAuth(config.provider, {
    apiKey: config.apiKey,
    oauthToken: config.oauthToken
  });
  if (
    normalizeProvider(config) === "gemini" &&
    auth?.type === "oauth" &&
    auth.refresh &&
    auth.clientId &&
    auth.expires &&
    auth.expires <= Date.now() + 30_000
  ) {
    const refreshed = await refreshGoogleOAuth(auth);
    setStoredOAuthAuth(config.provider, refreshed.access, {
      refresh: refreshed.refresh,
      expires: refreshed.expires,
      clientId: refreshed.clientId,
      clientSecret: refreshed.clientSecret,
      tokenUri: refreshed.tokenUri,
      projectId: refreshed.projectId,
      scopes: refreshed.scopes
    });
    return refreshed;
  }
  if (
    normalizeProvider(config) === "openai-codex" &&
    auth?.type === "oauth" &&
    auth.refresh &&
    auth.expires &&
    auth.expires <= Date.now() + 30_000
  ) {
    const refreshed = await refreshOpenAIOAuth(auth);
    setStoredOAuthAuth(config.provider, refreshed.access, {
      refresh: refreshed.refresh,
      expires: refreshed.expires,
      accountId: refreshed.accountId,
      clientId: refreshed.clientId,
      clientSecret: refreshed.clientSecret,
      tokenUri: refreshed.tokenUri,
      projectId: refreshed.projectId,
      scopes: refreshed.scopes
    });
    return refreshed;
  }
  return auth;
}

export async function listAvailableModels(config: PatricConfig): Promise<string[]> {
  const provider = normalizeProvider(config);

  if (provider === "openai-codex") {
    throw new Error("Live model discovery is not available for openai-codex.");
  }

  if (provider === "openai" || provider === "openrouter") {
    const auth = await getResolvedAuth(config);
    if (!auth) {
      throw new Error("Provider is not configured with credentials.");
    }
    if (provider === "openai" && auth.type !== "api") {
      throw new Error("Direct OpenAI model discovery requires an API key. Use openai-codex for browser OAuth.");
    }

    const response = await fetch(`${resolveBaseUrl(config)}/models`, {
      method: "GET",
      headers: getOpenAICompatibleHeaders(auth)
    });
    if (!response.ok) {
      throw new Error(`Model list request failed (${response.status}).`);
    }

    const data = await response.json();
    const models = Array.isArray(data?.data)
      ? data.data
          .map((item: any) => (typeof item?.id === "string" ? item.id.trim() : ""))
          .filter(Boolean)
      : [];

    if (provider === "openai") {
      return sortOpenAIModels(models.filter(isLikelyOpenAIChatModel));
    }

    return models.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  }

  if (provider === "ollama") {
    const response = await fetch(`${resolveBaseUrl(config)}/api/tags`, {
      method: "GET",
      headers: { "content-type": "application/json" }
    });
    if (!response.ok) {
      throw new Error(`Model list request failed (${response.status}).`);
    }
    const data = await response.json();
    const models = Array.isArray(data?.models)
      ? data.models
          .map((item: any) => (typeof item?.name === "string" ? item.name.trim() : ""))
          .filter(Boolean)
      : [];
    return models.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  }

  throw new Error(`Live model discovery is not available for ${provider}.`);
}

function getOpenAICompatibleHeaders(auth: ProviderAuth): Record<string, string> {
  const token = auth.type === "oauth" ? auth.access : auth.key;
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`
  };
}

function getOpenAICodexAccountId(auth: OAuthAuth): string | undefined {
  return auth.accountId || extractOpenAIAccountId(auth.access);
}

function getOpenAICodexHeaders(auth: ProviderAuth): Record<string, string> {
  if (auth.type !== "oauth") {
    throw new Error("OpenAI Codex requires browser OAuth.");
  }

  const accountId = getOpenAICodexAccountId(auth);
  return {
    "content-type": "application/json",
    authorization: `Bearer ${auth.access}`,
    ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
    originator: "patric",
    "user-agent": PATRIC_USER_AGENT
  };
}

function getAnthropicHeaders(auth: ProviderAuth): Record<string, string> {
  if (auth.type !== "api") {
    throw new Error("Anthropic requires API key authentication.");
  }
  return {
    "content-type": "application/json",
    "x-api-key": auth.key,
    "anthropic-version": "2023-06-01"
  };
}

function getGeminiHeaders(auth: ProviderAuth): Record<string, string> {
  if (auth.type === "oauth") {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${auth.access}`,
      ...(auth.projectId ? { "x-goog-user-project": auth.projectId } : {})
    };
  }
  return {
    "content-type": "application/json",
    "x-goog-api-key": auth.key
  };
}

async function ensureConfigured(config: PatricConfig): Promise<CompletionResult> {
  const provider = normalizeProvider(config);
  const auth = await getResolvedAuth(config);
  if (provider === "anthropic" && auth?.type !== "api") {
    return {
      ok: false,
      content:
        "Patric is not configured with an Anthropic API key. Anthropic's public API uses API keys here; set PATRIC_API_KEY or run `patric config set apiKey <key>`."
    };
  }
  if (provider === "openai" && auth?.type !== "api") {
    return {
      ok: false,
      content:
        "Direct OpenAI uses API keys here. Set `PATRIC_API_KEY` or run `patric config set apiKey <key>`, or switch provider to `openai-codex` for browser OAuth."
    };
  }
  if (provider === "openai-codex" && auth?.type !== "oauth") {
    return {
      ok: false,
      content:
        "OpenAI Codex uses ChatGPT browser OAuth here. Run `patric auth login openai-codex` or switch provider to `openai` for direct API-key access."
    };
  }

  if (provider !== "ollama" && provider !== "anthropic" && !auth) {
    return {
      ok: false,
      content:
        provider === "gemini"
          ? "Patric is not configured with Gemini credentials. Run `patric auth login gemini --client-file <client_secret.json>` or set `PATRIC_API_KEY`."
          : provider === "openai"
            ? "Patric is not configured with OpenAI credentials. Direct OpenAI uses API keys here; set `PATRIC_API_KEY` or run `patric config set apiKey <key>`."
            : provider === "openai-codex"
              ? "Patric is not configured with OpenAI Codex credentials. Run `patric auth login openai-codex`."
            : "Patric is not configured with credentials. Set PATRIC_API_KEY or PATRIC_OAUTH_TOKEN, or run `patric config set apiKey <key>` / `patric config set oauthToken <token>`."
    };
  }

  const model = resolveModel(config);
  if (!model) {
    return {
      ok: false,
      content:
        "Patric is not configured with a model. Set PATRIC_MODEL or run `patric config set model <model>`."
    };
  }

  const modelError = getModelCompatibilityError(config.provider, config.model);
  if (modelError) {
    return {
      ok: false,
      content: modelError
    };
  }

  return { ok: true, content: "" };
}

function splitSystemMessage(messages: any[]): {
  system: string;
  messages: any[];
} {
  const systemParts: string[] = [];
  const rest: any[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(typeof message.content === "string" ? message.content : "");
    } else {
      rest.push(message);
    }
  }

  return {
    system: systemParts.join("\n\n"),
    messages: rest
  };
}

async function readTextResponse(response: Response): Promise<string> {
  const text = await response.text();
  return text;
}

async function parseSseStream(
  response: Response,
  onEvent: (payload: string) => void
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Provider returned no stream body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const event of events) {
      const lines = event.split("\n").filter((line) => line.startsWith("data: "));
      for (const line of lines) {
        const payload = line.slice(6).trim();
        if (payload && payload !== "[DONE]") {
          onEvent(payload);
        }
      }
    }
  }
}

async function parseNdjsonStream(
  response: Response,
  onLine: (payload: string) => void
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Provider returned no stream body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const payload = line.trim();
      if (payload) {
        onLine(payload);
      }
    }
  }

  if (buffer.trim()) {
    onLine(buffer.trim());
  }
}

function extractTextFromOutputParts(parts: any[]): string {
  return parts
    .map((part) =>
      typeof part?.text === "string"
        ? part.text
        : typeof part?.output_text === "string"
          ? part.output_text
          : ""
    )
    .filter(Boolean)
    .join("");
}

function extractTextFromResponsesOutput(output: any): string {
  if (!Array.isArray(output)) {
    return "";
  }
  return output
    .map((item: any) => {
      if (item?.type === "message") {
        if (typeof item.content === "string") {
          return item.content;
        }
        return Array.isArray(item.content) ? extractTextFromOutputParts(item.content) : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

function extractToolCallsFromResponsesOutput(output: any): ToolCall[] {
  if (!Array.isArray(output)) {
    return [];
  }

  return output
    .filter((item: any) => item?.type === "function_call" && typeof item?.name === "string")
    .map((item: any, index: number) => {
      let argumentsObject: Record<string, any> = {};
      if (typeof item.arguments === "string" && item.arguments.trim()) {
        try {
          argumentsObject = JSON.parse(item.arguments);
        } catch {
          argumentsObject = {};
        }
      } else if (item.arguments && typeof item.arguments === "object") {
        argumentsObject = item.arguments;
      }
      return {
        id: item.call_id || item.id || `call_${index}`,
        name: item.name,
        arguments: argumentsObject
      };
    });
}

function parseOpenAICompatibleResponseContent(data: any): string {
  const chatContent = data?.choices?.[0]?.message?.content;
  if (typeof chatContent === "string") {
    return chatContent;
  }
  if (Array.isArray(chatContent)) {
    return extractTextFromOutputParts(chatContent);
  }
  return (
    extractTextFromResponsesOutput(data?.output) ||
    extractTextFromResponsesOutput(data?.response?.output) ||
    ""
  );
}

function parseOpenAICompatibleResponseToolCalls(data: any): ToolCall[] {
  const chatToolCalls = data?.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(chatToolCalls) && chatToolCalls.length > 0) {
    return chatToolCalls.map((call: any, index: number) => {
      let argumentsObject: Record<string, any> = {};
      const rawArguments = call?.function?.arguments;
      if (typeof rawArguments === "string" && rawArguments.trim()) {
        try {
          argumentsObject = JSON.parse(rawArguments);
        } catch {
          argumentsObject = {};
        }
      }
      return {
        id: call?.id || `call_${index}`,
        name: call?.function?.name || "",
        arguments: argumentsObject
      };
    });
  }
  const outputCalls = extractToolCallsFromResponsesOutput(data?.output);
  if (outputCalls.length > 0) {
    return outputCalls;
  }
  return extractToolCallsFromResponsesOutput(data?.response?.output);
}

function buildOpenAICodexInstructions(system: string): string {
  const trimmed = system.trim();
  return trimmed || "You are Patric, a pragmatic coding assistant.";
}

function buildOpenAICodexMessageItem(role: "user" | "assistant", content: string): any {
  return {
    type: "message",
    role,
    content
  };
}

function convertToOpenAICodexInput(messages: ChatMessage[]): {
  instructions: string;
  input: any[];
} {
  const { system, messages: rest } = splitSystemMessage(messages);
  return {
    instructions: buildOpenAICodexInstructions(system),
    input: rest
      .filter(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string" &&
          message.content.trim()
      )
      .map((message) => buildOpenAICodexMessageItem(message.role, message.content))
  };
}

function buildOpenAICodexFunctionCallItem(call: ToolCall): any {
  return {
    type: "function_call",
    call_id: call.id,
    name: call.name,
    arguments: JSON.stringify(call.arguments || {})
  };
}

function buildOpenAICodexToolOutputItems(toolResults: ToolResult[]): any[] {
  return toolResults.map((result) => ({
    type: "function_call_output",
    call_id: result.callId,
    output: result.content
  }));
}

function buildOpenAICodexContinuationItems(
  assistantContent: string,
  toolCalls: ToolCall[],
  toolResults: ToolResult[]
): any[] {
  const items: any[] = [];
  if (assistantContent.trim()) {
    items.push(buildOpenAICodexMessageItem("assistant", assistantContent));
  }
  for (const call of toolCalls) {
    items.push(buildOpenAICodexFunctionCallItem(call));
  }
  items.push(...buildOpenAICodexToolOutputItems(toolResults));
  return items;
}

function extractResponseId(data: any): string | undefined {
  if (typeof data?.id === "string" && data.id) {
    return data.id;
  }
  if (typeof data?.response?.id === "string" && data.response.id) {
    return data.response.id;
  }
  return undefined;
}

function filterTopLevelToolNames(registry: AgentRegistry, requestedToolNames?: string[]): string[] {
  const requested = requestedToolNames && requestedToolNames.length > 0
    ? requestedToolNames
    : getAllToolNames();
  if (registry.all.length > 0) {
    return [...requested];
  }
  const blocked = new Set<string>(AGENT_TOOL_NAMES);
  return requested.filter((toolName) => !blocked.has(toolName));
}

function describeAgentStatusEvent(status: {
  state: string;
  task: string;
  result?: string;
  error?: string;
}): string {
  if (status.state === "done") {
    return (status.result || "").slice(0, 240);
  }
  if (status.state === "error") {
    return status.error || "";
  }
  return status.task;
}

async function createRuntimeContext(
  config: PatricConfig,
  onToolEvent?: (event: ToolEvent) => void,
  runtimeContext?: RuntimeContext
): Promise<RuntimeContext> {
  const baseContext: RuntimeContext = {
    ...runtimeContext,
    agent: runtimeContext?.agent || { kind: "top-level" }
  };

  if (baseContext.agent?.kind === "sub-agent") {
    return {
      ...baseContext,
      allowedToolNames: baseContext.allowedToolNames || getAllToolNames().filter((name) => !AGENT_TOOL_NAMES.includes(name as any))
    };
  }

  const registry = baseContext.agentRegistry || loadAgentRegistry(process.cwd());
  const allowedToolNames = filterTopLevelToolNames(registry, baseContext.allowedToolNames);

  if (baseContext.agentManager) {
    return {
      ...baseContext,
      agentRegistry: registry,
      allowedToolNames,
      agent: { kind: "top-level" }
    };
  }

  const agentManager = createAgentManager({
    registry,
    onStatus: (status) => {
      const spec = registry.byName.get(status.name.trim().toLowerCase());
      onToolEvent?.({
        type: "agent_status",
        name: "agent",
        agentId: status.id,
        agentName: status.name,
        agentState: status.state,
        detail: spec ? describeAgentStatusEvent(status) : status.task
      });
    },
    runner: async (spec, task, signal, runId) => {
      const childConfig: PatricConfig = {
        ...config,
        model: resolveAgentModel(config, spec)
      };
      const childAllowedToolNames = getEffectiveAgentToolNames(
        spec,
        allowedToolNames.filter((toolName) => !AGENT_TOOL_NAMES.includes(toolName as any))
      );
      return streamCompletion(
        childConfig,
        [
          { role: "system", content: buildAgentSystemPrompt(config.systemPrompt, spec) },
          { role: "user", content: buildAgentTaskPrompt(task) }
        ],
        undefined,
        (childEvent) => {
          if (childEvent.type === "tool_start") {
            onToolEvent?.({
              type: "agent_tool_start",
              name: childEvent.name,
              arguments: childEvent.arguments,
              agentId: runId,
              agentName: spec.name,
            });
          } else if (childEvent.type === "tool_end") {
            onToolEvent?.({
              type: "agent_tool_end",
              name: childEvent.name,
              result: childEvent.result,
              agentId: runId,
              agentName: spec.name,
            });
          }
        },
        signal,
        {
          allowedToolNames: childAllowedToolNames,
          agentRegistry: registry,
          agent: { kind: "sub-agent", name: spec.name },
          permissionState: runtimeContext?.permissionState
            ? new PermissionState({
                configAllowed: runtimeContext.permissionState.getConfigAllowed(),
                promptFn: null,
                isSubAgent: true,
              })
            : undefined,
        }
      );
    }
  });

  return {
    ...baseContext,
    allowedToolNames,
    agentRegistry: registry,
    agentManager,
    agent: { kind: "top-level" }
  };
}

const MEMORY_REMINDER = `MEMORY SYSTEM: You have read_memory and save_memory tools. You MUST use them when the user shares ANY personal info or preferences about themselves or about your personality/behavior.
- "my name is X" / "call me X" / "I'm a Y" → read_memory('user') then save_memory('user', updated)
- "your name is X" / "be more casual" / "speak like X" → read_memory('soul') then save_memory('soul', updated)
- project conventions or rules → read_memory('project') then save_memory('project', updated)
ALWAYS call the tools. Never just acknowledge without saving.`;

function buildEffectiveMessages(messages: ChatMessage[], runtimeContext: RuntimeContext): ChatMessage[] {
  const extra: ChatMessage[] = [];

  if (runtimeContext.agent?.kind === "top-level" && runtimeContext.agentRegistry && runtimeContext.agentRegistry.all.length > 0) {
    extra.push({
      role: "system",
      content: formatAgentPromptSummary(runtimeContext.agentRegistry)
    });
  }

  if (runtimeContext.agent?.kind === "top-level") {
    extra.push({
      role: "system",
      content: MEMORY_REMINDER
    });
  }

  return extra.length > 0 ? [...messages, ...extra] : messages;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenAI, OpenRouter, Ollama-via-OpenAI-compat)
// ---------------------------------------------------------------------------

async function streamOpenAIWithTools(
  config: PatricConfig,
  rawMessages: any[],
  tools: object[] | undefined,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal
): Promise<ProviderResponse> {
  const provider = normalizeProvider(config);
  const isOllama = provider === "ollama";
  const auth = isOllama ? undefined : await getResolvedAuth(config);
  const model = resolveModel(config);
  const url = isOllama
    ? `${resolveBaseUrl(config)}/api/chat`
    : `${resolveBaseUrl(config)}/chat/completions`;

  const body: any = {
    model,
    messages: rawMessages,
    temperature: 0.2,
    stream: true
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetch(url, {
    method: "POST",
    headers:
      isOllama || !auth
        ? { "content-type": "application/json" }
        : getOpenAICompatibleHeaders(auth),
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    return {
      ok: false,
      content: "",
      toolCalls: [],
      error: `Provider request failed (${response.status}): ${await readTextResponse(response)}`
    };
  }

  let content = "";
  const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map();

  const parseEvent = (payload: string) => {
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }

    // Ollama NDJSON: message may have content or tool_calls
    const message = parsed.message;
    if (message) {
      if (typeof message.content === "string" && message.content) {
        content += message.content;
        onChunk?.(message.content);
      }
      if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
          const fn = tc.function || tc;
          const idx = toolCallAccum.size;
          toolCallAccum.set(idx, {
            id: tc.id || `call_${idx}`,
            name: fn.name || "",
            args: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {})
          });
        }
      }
      return;
    }

    if (typeof parsed?.type === "string" && parsed.type.startsWith("response.")) {
      if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
        content += parsed.delta;
        onChunk?.(parsed.delta);
        return;
      }

      if (parsed.type === "response.completed" && parsed.response) {
        if (!content) {
          const completedText = parseOpenAICompatibleResponseContent(parsed.response);
          if (completedText) {
            content += completedText;
            onChunk?.(completedText);
          }
        }
        const completedToolCalls = parseOpenAICompatibleResponseToolCalls(parsed.response);
        for (const call of completedToolCalls) {
          const existingEntry = [...toolCallAccum.entries()].find(([, value]) => value.id === call.id);
          const idx = existingEntry?.[0] ?? toolCallAccum.size;
          toolCallAccum.set(idx, {
            id: call.id,
            name: call.name,
            args: JSON.stringify(call.arguments || {})
          });
        }
        return;
      }

      const item = parsed.item;
      if (
        (parsed.type === "response.output_item.added" || parsed.type === "response.output_item.done") &&
        item?.type === "function_call" &&
        typeof item.name === "string"
      ) {
        const resolvedId = item.call_id || item.id || "";
        const existingEntry = [...toolCallAccum.entries()].find(([, value]) => value.id === resolvedId);
        const idx = existingEntry?.[0] ?? toolCallAccum.size;
        toolCallAccum.set(idx, {
          id: resolvedId || `call_${idx}`,
          name: item.name,
          args: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
        });
      }
      return;
    }

    // OpenAI SSE: choices[0].delta
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return;

    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onChunk?.(delta.content);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? toolCallAccum.size;
        if (!toolCallAccum.has(idx)) {
          toolCallAccum.set(idx, { id: tc.id || `call_${idx}`, name: "", args: "" });
        }
        const accum = toolCallAccum.get(idx)!;
        if (tc.id) accum.id = tc.id;
        if (tc.function?.name) accum.name += tc.function.name;
        if (tc.function?.arguments) accum.args += tc.function.arguments;
      }
    }
  };

  if (isOllama) {
    await parseNdjsonStream(response, parseEvent);
  } else {
    await parseSseStream(response, parseEvent);
  }

  const toolCalls: ToolCall[] = [];
  for (const [, accum] of toolCallAccum) {
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(accum.args);
    } catch {}
    toolCalls.push({ id: accum.id, name: accum.name, arguments: args });
  }

  return { ok: true, content, toolCalls };
}

async function streamOpenAICodexWithTools(
  config: PatricConfig,
  instructions: string,
  input: any[],
  tools: object[] | undefined,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal
): Promise<ProviderResponse> {
  const auth = await getResolvedAuth(config);
  const model = resolveModel(config);
  const body: any = {
    model,
    instructions: buildOpenAICodexInstructions(instructions),
    input,
    stream: true,
    store: false
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetch(`${resolveBaseUrl(config)}/codex/responses`, {
    method: "POST",
    headers: getOpenAICodexHeaders(auth!),
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    return {
      ok: false,
      content: "",
      toolCalls: [],
      error: `Provider request failed (${response.status}): ${await readTextResponse(response)}`
    };
  }

  let content = "";
  let responseId: string | undefined;
  const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map();

  const mergeToolCalls = (calls: ToolCall[]) => {
    for (const call of calls) {
      const existingEntry = [...toolCallAccum.entries()].find(([, value]) => value.id === call.id);
      const idx = existingEntry?.[0] ?? toolCallAccum.size;
      toolCallAccum.set(idx, {
        id: call.id,
        name: call.name,
        args: JSON.stringify(call.arguments || {})
      });
    }
  };

  await parseSseStream(response, (payload) => {
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }

    responseId ||= extractResponseId(parsed);

    if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
      content += parsed.delta;
      onChunk?.(parsed.delta);
      return;
    }

    const item = parsed.item;
    if (
      (parsed.type === "response.output_item.added" || parsed.type === "response.output_item.done") &&
      item?.type === "function_call" &&
      typeof item.name === "string"
    ) {
      const resolvedId = item.call_id || item.id || "";
      const existingEntry = [...toolCallAccum.entries()].find(([, value]) => value.id === resolvedId);
      const idx = existingEntry?.[0] ?? toolCallAccum.size;
      toolCallAccum.set(idx, {
        id: resolvedId || `call_${idx}`,
        name: item.name,
        args: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
      });
      return;
    }

    if (parsed.type === "response.completed" && parsed.response) {
      if (!content) {
        const completedText = parseOpenAICompatibleResponseContent(parsed.response);
        if (completedText) {
          content += completedText;
          onChunk?.(completedText);
        }
      }
      mergeToolCalls(parseOpenAICompatibleResponseToolCalls(parsed.response));
    }
  });

  const toolCalls: ToolCall[] = [];
  for (const [, accum] of toolCallAccum) {
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(accum.args);
    } catch {}
    toolCalls.push({ id: accum.id, name: accum.name, arguments: args });
  }

  return { ok: true, content, toolCalls, responseId };
}

function buildOpenAIToolResultMessages(
  assistantContent: string,
  toolCalls: ToolCall[],
  toolResults: ToolResult[]
): any[] {
  const assistantMsg: any = {
    role: "assistant",
    content: assistantContent || null,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
    }))
  };

  const resultMsgs = toolResults.map((tr) => ({
    role: "tool",
    tool_call_id: tr.callId,
    content: tr.content
  }));

  return [assistantMsg, ...resultMsgs];
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function streamAnthropicWithTools(
  config: PatricConfig,
  rawMessages: any[],
  tools: object[] | undefined,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal
): Promise<ProviderResponse> {
  const { system, messages: rest } = splitSystemMessage(rawMessages);
  const auth = await getResolvedAuth(config);
  const model = resolveModel(config);

  const body: any = {
    model,
    max_tokens: 4096,
    system: system || undefined,
    messages: rest,
    stream: true
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetch(`${resolveBaseUrl(config)}/v1/messages`, {
    method: "POST",
    headers: getAnthropicHeaders(auth!),
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    return {
      ok: false,
      content: "",
      toolCalls: [],
      error: `Provider request failed (${response.status}): ${await readTextResponse(response)}`
    };
  }

  let content = "";
  const toolCalls: ToolCall[] = [];
  let currentToolUse: { id: string; name: string; inputJson: string } | null = null;

  await parseSseStream(response, (payload) => {
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }

    if (parsed.type === "content_block_start") {
      const block = parsed.content_block;
      if (block?.type === "tool_use") {
        currentToolUse = { id: block.id, name: block.name, inputJson: "" };
      }
    } else if (parsed.type === "content_block_delta") {
      if (parsed.delta?.type === "text_delta" && typeof parsed.delta.text === "string") {
        content += parsed.delta.text;
        onChunk?.(parsed.delta.text);
      } else if (parsed.delta?.type === "input_json_delta" && currentToolUse) {
        currentToolUse.inputJson += parsed.delta.partial_json || "";
      }
    } else if (parsed.type === "content_block_stop") {
      if (currentToolUse) {
        let args: Record<string, any> = {};
        try {
          args = JSON.parse(currentToolUse.inputJson);
        } catch {}
        toolCalls.push({ id: currentToolUse.id, name: currentToolUse.name, arguments: args });
        currentToolUse = null;
      }
    }
  });

  return { ok: true, content, toolCalls };
}

function buildAnthropicToolResultMessages(
  assistantContent: string,
  toolCalls: ToolCall[],
  toolResults: ToolResult[]
): any[] {
  const contentBlocks: any[] = [];
  if (assistantContent) {
    contentBlocks.push({ type: "text", text: assistantContent });
  }
  for (const tc of toolCalls) {
    contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
  }

  const resultBlocks = toolResults.map((tr) => ({
    type: "tool_result",
    tool_use_id: tr.callId,
    content: tr.content
  }));

  return [
    { role: "assistant", content: contentBlocks },
    { role: "user", content: resultBlocks }
  ];
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

async function streamGeminiWithTools(
  config: PatricConfig,
  rawMessages: any[],
  tools: object[] | undefined,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal
): Promise<ProviderResponse> {
  const { system, messages: rest } = splitSystemMessage(rawMessages);
  const auth = await getResolvedAuth(config);
  const model = resolveModel(config);

  const body: any = {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents: rest
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetch(
    `${resolveBaseUrl(config)}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: getGeminiHeaders(auth!),
      body: JSON.stringify(body),
      signal
    }
  );

  if (!response.ok) {
    return {
      ok: false,
      content: "",
      toolCalls: [],
      error: `Provider request failed (${response.status}): ${await readTextResponse(response)}`
    };
  }

  let content = "";
  const toolCalls: ToolCall[] = [];

  await parseSseStream(response, (payload) => {
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const parts = parsed.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return;

    for (const part of parts) {
      if (typeof part?.text === "string" && part.text) {
        content += part.text;
        onChunk?.(part.text);
      }
      if (part?.functionCall) {
        toolCalls.push({
          id: `gemini_${toolCalls.length}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args || {}
        });
      }
    }
  });

  return { ok: true, content, toolCalls };
}

function buildGeminiToolResultMessages(
  assistantContent: string,
  toolCalls: ToolCall[],
  toolResults: ToolResult[]
): any[] {
  const modelParts: any[] = [];
  if (assistantContent) {
    modelParts.push({ text: assistantContent });
  }
  for (const tc of toolCalls) {
    modelParts.push({ functionCall: { name: tc.name, args: tc.arguments } });
  }

  const userParts = toolResults.map((tr) => ({
    functionResponse: {
      name: tr.name,
      response: { result: tr.content }
    }
  }));

  return [
    { role: "model", parts: modelParts },
    { role: "user", parts: userParts }
  ];
}

// ---------------------------------------------------------------------------
// Message format conversion (ChatMessage[] -> provider raw format)
// ---------------------------------------------------------------------------

function convertToOpenAIFormat(messages: ChatMessage[]): any[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function convertToAnthropicFormat(messages: ChatMessage[]): any[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function convertToGeminiFormat(messages: ChatMessage[]): any[] {
  const result: any[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      result.push({ role: "system", content: m.content });
    } else {
      result.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Unified tool-use loop
// ---------------------------------------------------------------------------

function debugLog(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  fs.appendFileSync("/tmp/patric-debug.log", `[${ts}] ${msg}\n`);
}

async function streamWithToolLoop(
  config: PatricConfig,
  messages: ChatMessage[],
  onChunk?: (chunk: string) => void,
  onToolEvent?: (event: ToolEvent) => void,
  signal?: AbortSignal,
  runtimeContext: RuntimeContext = {}
): Promise<CompletionResult> {
  const provider = normalizeProvider(config);
  const tools = getToolsForProvider(provider, runtimeContext.allowedToolNames);

  let rawMessages: any[];
  let codexInstructions = "";
  switch (provider) {
    case "openai-codex": {
      const codexInput = convertToOpenAICodexInput(messages);
      codexInstructions = codexInput.instructions;
      rawMessages = codexInput.input;
      break;
    }
    case "gemini":
      rawMessages = convertToGeminiFormat(messages);
      break;
    case "anthropic":
      rawMessages = convertToAnthropicFormat(messages);
      break;
    default:
      rawMessages = convertToOpenAIFormat(messages);
      break;
  }

  let fullContent = "";
  let usedTools = false;

  try {
  for (let iteration = 0; iteration < MAX_TOOL_ROUNDS; iteration++) {
    debugLog(`--- iteration ${iteration} start (provider=${provider})`);
    let providerResponse: ProviderResponse;

    switch (provider) {
      case "anthropic":
        providerResponse = await streamAnthropicWithTools(config, rawMessages, tools, onChunk, signal);
        break;
      case "gemini":
        providerResponse = await streamGeminiWithTools(config, rawMessages, tools, onChunk, signal);
        break;
      case "openai-codex":
        providerResponse = await streamOpenAICodexWithTools(
          config,
          codexInstructions,
          rawMessages,
          tools,
          onChunk,
          signal
        );
        break;
      case "ollama":
      case "openrouter":
      case "openai":
      default:
        providerResponse = await streamOpenAIWithTools(config, rawMessages, tools, onChunk, signal);
        break;
    }

    debugLog(`iteration ${iteration} response: ok=${providerResponse.ok} content=${providerResponse.content.slice(0, 100)} toolCalls=${providerResponse.toolCalls.length}`);

    if (!providerResponse.ok) {
      debugLog(`iteration ${iteration} error: ${providerResponse.error}`);
      return { ok: false, content: providerResponse.error || "Provider error" };
    }

    fullContent += providerResponse.content;

    if (providerResponse.toolCalls.length === 0) {
      if (providerResponse.content.trim()) {
        return { ok: true, content: fullContent };
      }
      if (usedTools) {
        return {
          ok: false,
          content: "Provider finished without a final answer after using tools."
        };
      }
      return { ok: false, content: "Provider returned no assistant message." };
    }

    // Execute tool calls
    usedTools = true;
    const toolResults: ToolResult[] = [];
    for (const call of providerResponse.toolCalls) {
      debugLog(`tool_start: ${call.name} args=${JSON.stringify(call.arguments).slice(0, 200)}`);

      // Permission check
      if (runtimeContext.permissionState) {
        debugLog(`permission_check: ${call.name} (has permissionState)`);
        const summary = formatPermissionSummary(call.name, call.arguments);
        const permResult = await runtimeContext.permissionState.checkPermission({
          toolName: call.name,
          arguments: call.arguments,
          summary,
        });
        debugLog(`permission_result: ${call.name} allowed=${permResult.allowed} decision=${permResult.decision}`);
        if (!permResult.allowed) {
          toolResults.push({
            callId: call.id,
            name: call.name,
            content: `Permission denied: the user declined to allow "${call.name}". Try an alternative approach or ask the user to perform this action manually.`,
            ok: false,
          });
          onToolEvent?.({ type: "tool_start", name: call.name, arguments: call.arguments });
          onToolEvent?.({ type: "tool_end", name: call.name, result: "Permission denied by user" });
          continue;
        }
      }

      onToolEvent?.({ type: "tool_start", name: call.name, arguments: call.arguments });
      const result = await executeTool(call, {
        allowedToolNames: runtimeContext.allowedToolNames,
        agentManager: runtimeContext.agentManager
      });
      toolResults.push(result);
      debugLog(`tool_end: ${call.name} ok=${result.ok} result=${result.content.slice(0, 200)}`);
      onToolEvent?.({
        type: "tool_end",
        name: call.name,
        result: result.content.slice(0, 300)
      });
    }
    onToolEvent?.({
      type: "tool_round_complete",
      name: providerResponse.toolCalls[providerResponse.toolCalls.length - 1]?.name || ""
    });

    // Build tool result messages in provider-specific format and append
    let resultMessages: any[];
    switch (provider) {
      case "anthropic":
        resultMessages = buildAnthropicToolResultMessages(
          providerResponse.content,
          providerResponse.toolCalls,
          toolResults
        );
        break;
      case "gemini":
        resultMessages = buildGeminiToolResultMessages(
          providerResponse.content,
          providerResponse.toolCalls,
          toolResults
        );
        break;
      case "openai-codex":
        rawMessages.push(
          ...buildOpenAICodexContinuationItems(
            providerResponse.content,
            providerResponse.toolCalls,
            toolResults
          )
        );
        continue;
      default:
        resultMessages = buildOpenAIToolResultMessages(
          providerResponse.content,
          providerResponse.toolCalls,
          toolResults
        );
        break;
    }

    rawMessages.push(...resultMessages);
  }

  return {
    ok: false,
    content: `Reached maximum tool iterations (${MAX_TOOL_ROUNDS}) without a final answer.`
  };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { ok: true, content: fullContent || "" };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API (backward compatible)
// ---------------------------------------------------------------------------

export async function requestCompletion(
  config: PatricConfig,
  messages: ChatMessage[]
): Promise<CompletionResult> {
  const configured = await ensureConfigured(config);
  if (!configured.ok) {
    return configured;
  }

  // requestCompletion is used for testConnection — no tools needed
  const provider = normalizeProvider(config);
  switch (provider) {
    case "anthropic":
      return requestAnthropic(config, messages);
    case "ollama":
      return requestOllama(config, messages);
    case "gemini":
      return requestGemini(config, messages);
    case "openai-codex":
      return requestOpenAICodex(config, messages);
    case "openrouter":
    case "openai":
    default:
      return requestOpenAICompatible(config, messages);
  }
}

export async function streamCompletion(
  config: PatricConfig,
  messages: ChatMessage[],
  onChunk?: (chunk: string) => void,
  onToolEvent?: (event: ToolEvent) => void,
  signal?: AbortSignal,
  runtimeContext?: RuntimeContext
): Promise<CompletionResult> {
  const configured = await ensureConfigured(config);
  if (!configured.ok) {
    return configured;
  }

  const resolvedRuntimeContext = await createRuntimeContext(config, onToolEvent, runtimeContext);
  const effectiveMessages = buildEffectiveMessages(messages, resolvedRuntimeContext);
  return streamWithToolLoop(
    config,
    effectiveMessages,
    onChunk,
    onToolEvent,
    signal,
    resolvedRuntimeContext
  );
}

export async function testConnection(config: PatricConfig): Promise<CompletionResult> {
  return requestCompletion(config, [
    {
      role: "system",
      content: config.systemPrompt
    },
    {
      role: "user",
      content: "Reply with exactly: ok"
    }
  ]);
}

// ---------------------------------------------------------------------------
// Legacy non-streaming request functions (used by requestCompletion / testConnection)
// ---------------------------------------------------------------------------

async function requestOpenAICompatible(
  config: PatricConfig,
  messages: ChatMessage[]
): Promise<CompletionResult> {
  const resolvedAuth = await getResolvedAuth(config);
  const model = resolveModel(config);
  const response = await fetch(
    `${resolveBaseUrl(config)}/chat/completions`,
    {
      method: "POST",
      headers:
        getOpenAICompatibleHeaders(resolvedAuth!),
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2
      })
    }
  );

  if (!response.ok) {
    return {
      ok: false,
      content: `Provider request failed (${response.status}): ${await readTextResponse(response)}`
    };
  }

  const data = await response.json();
  const content = parseOpenAICompatibleResponseContent(data);
  if (!content) {
    return { ok: false, content: "Provider returned no assistant message." };
  }
  return { ok: true, content };
}

async function requestOpenAICodex(
  config: PatricConfig,
  messages: ChatMessage[]
): Promise<CompletionResult> {
  const { instructions, input } = convertToOpenAICodexInput(messages);
  const response = await streamOpenAICodexWithTools(
    config,
    instructions,
    input,
    undefined,
    undefined
  );

  if (!response.ok) {
    return { ok: false, content: response.error || "Provider error" };
  }
  if (!response.content) {
    return { ok: false, content: "Provider returned no assistant message." };
  }
  return { ok: true, content: response.content };
}

async function requestAnthropic(
  config: PatricConfig,
  messages: ChatMessage[]
): Promise<CompletionResult> {
  const { system, messages: rest } = splitSystemMessage(messages);
  const auth = await getResolvedAuth(config);
  const model = resolveModel(config);
  const response = await fetch(`${resolveBaseUrl(config)}/v1/messages`, {
    method: "POST",
    headers: getAnthropicHeaders(auth!),
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: system || undefined,
      messages: rest.map((message) => ({
        role: message.role,
        content: message.content
      }))
    })
  });

  if (!response.ok) {
    return {
      ok: false,
      content: `Provider request failed (${response.status}): ${await readTextResponse(response)}`
    };
  }

  const data = await response.json();
  const content = Array.isArray(data.content)
    ? data.content
        .filter((item: any) => item?.type === "text" && typeof item.text === "string")
        .map((item: any) => item.text)
        .join("")
    : "";
  return content
    ? { ok: true, content }
    : { ok: false, content: "Provider returned no assistant message." };
}

async function requestOllama(
  config: PatricConfig,
  messages: ChatMessage[]
): Promise<CompletionResult> {
  const model = resolveModel(config);
  const response = await fetch(`${resolveBaseUrl(config)}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false
    })
  });

  if (!response.ok) {
    return {
      ok: false,
      content: `Provider request failed (${response.status}): ${await readTextResponse(response)}`
    };
  }

  const data = await response.json();
  const content = data.message?.content;
  return typeof content === "string" && content
    ? { ok: true, content }
    : { ok: false, content: "Provider returned no assistant message." };
}

async function requestGemini(
  config: PatricConfig,
  messages: ChatMessage[]
): Promise<CompletionResult> {
  const { system, messages: rest } = splitSystemMessage(messages);
  const auth = await getResolvedAuth(config);
  const model = resolveModel(config);
  const response = await fetch(
    `${resolveBaseUrl(config)}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: getGeminiHeaders(auth!),
      body: JSON.stringify({
        systemInstruction: system
          ? {
              parts: [{ text: system }]
            }
          : undefined,
        contents: rest.map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }]
        }))
      })
    }
  );

  if (!response.ok) {
    return {
      ok: false,
      content: `Provider request failed (${response.status}): ${await readTextResponse(response)}`
    };
  }

  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts;
  const content = Array.isArray(parts)
    ? parts
        .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
        .join("")
    : "";
  return content
    ? { ok: true, content }
    : { ok: false, content: "Provider returned no assistant message." };
}

// ---------------------------------------------------------------------------
// Context window tracking
// ---------------------------------------------------------------------------

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  "gpt-3.5-turbo": 16_385,
  "o1": 200_000,
  "o1-mini": 128_000,
  "o1-pro": 200_000,
  "o3": 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,
  "gpt-4.1": 1_047_576,
  "gpt-4.1-mini": 1_047_576,
  "gpt-4.1-nano": 1_047_576,
  "gpt-5.4": 1_047_576,
  "gpt-5.1": 1_047_576,
  "gpt-5-mini": 1_047_576,
  "gpt-5-nano": 1_047_576,
  "gpt-5.3-codex": 1_047_576,
  // Anthropic
  "claude-3-opus-20240229": 200_000,
  "claude-3-sonnet-20240229": 200_000,
  "claude-3-haiku-20240307": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-opus-4-1-20250805": 200_000,
  // Gemini
  "gemini-2.5-pro": 1_048_576,
  "gemini-2.5-flash": 1_048_576,
  "gemini-2.0-flash": 1_048_576,
  "gemini-1.5-pro": 2_097_152,
  "gemini-1.5-flash": 1_048_576,
  // Ollama common defaults
  "llama3.2": 131_072,
  "qwen3": 131_072,
  "deepseek-r1": 131_072,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

function getContextWindowForModel(model: string): number {
  if (MODEL_CONTEXT_WINDOWS[model]) {
    return MODEL_CONTEXT_WINDOWS[model];
  }
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.startsWith(key)) {
      return value;
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Rough token estimation: ~4 characters per token for English text.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += msg.role.length + 4;
    chars += typeof msg.content === "string" ? msg.content.length : JSON.stringify(msg.content).length;
  }
  return Math.ceil(chars / 4);
}

export function getContextPercentage(config: PatricConfig, messages: ChatMessage[]): string {
  const model = config.model || "";
  const windowSize = getContextWindowForModel(model);
  const used = estimateTokens(messages);
  const raw = Math.min(100, (used / windowSize) * 100);
  if (raw === 0) return "0";
  if (raw < 10) return raw.toFixed(1);
  return String(Math.round(raw));
}

export function getContextPercentageNum(config: PatricConfig, messages: ChatMessage[]): number {
  const model = config.model || "";
  const windowSize = getContextWindowForModel(model);
  const used = estimateTokens(messages);
  return Math.min(100, (used / windowSize) * 100);
}
