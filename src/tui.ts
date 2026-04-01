import process from "node:process";
import path from "node:path";
import fs from "node:fs";
import {
  buildAgentSystemPrompt,
  buildAgentTaskPrompt,
  formatAgentList,
  getEffectiveAgentToolNames,
  loadAgentRegistry,
  resolveAgentModel
} from "./agents";
import {
  clearStoredAuth,
  getEffectiveAuth,
  getEffectiveAuthStatus,
  getStoredAuth,
  setStoredApiAuth,
  setStoredOAuthAuth
} from "./auth";
import type { PatricConfig } from "./config";
import { appendHistory, loadHistory } from "./history";
import {
  formatConfigSummary,
  getDefaultBaseUrl,
  normalizeModelForProvider,
  normalizeProviderName,
  rememberRecentModel,
  saveConfig
} from "./config";
import { loginWithOpenAIOAuth, openBrowser } from "./oauth";
import { closeBrowser } from "./browser";
import { applyPatch, generatePatch } from "./patch";
import {
  getContextPercentage,
  getContextPercentageNum,
  listAvailableModels,
  streamCompletion,
  type ChatMessage,
  type ToolEvent
} from "./provider";
import { collectContext, getRepoInfo } from "./repo";
import { AGENT_TOOL_NAMES, getAllToolNames } from "./tools";
import { execCommand, listDir, readFileSafe, writeFileSafe } from "./utils";
import chalk from "chalk";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

// marked-terminal uses chalk which auto-detects color level at import time.
// In the TUI's alternate screen buffer, chalk may detect level 0 (no color).
// Force truecolor support since we only render in TTY mode.
chalk.level = 3;

type Role = "system" | "user" | "assistant" | "status" | "error" | "tool";

type ViewMode = "chat" | "settings" | "provider-picker" | "model-picker";

interface Message {
  role: Role;
  content: string;
  state?: "running" | "done" | "error";
  detail?: string;
  key?: string;
}

interface SlashCommand {
  name: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "Show help" },
  { name: "/pwd", description: "Show current directory" },
  { name: "/cd", description: "Change directory" },
  { name: "/ls", description: "List files" },
  { name: "/read", description: "Read file" },
  { name: "/write", description: "Write text to file" },
  { name: "/exec", description: "Run shell command" },
  { name: "/repo", description: "Show repository status" },
  { name: "/context", description: "Print repository context" },
  { name: "/agents", description: "List saved sub-agents" },
  { name: "/agent", description: "Run a saved sub-agent" },
  { name: "/patch", description: "Generate a patch file" },
  { name: "/apply", description: "Apply a patch file" },
  { name: "/settings", description: "Open settings" },
  { name: "/model", description: "Show or set model" },
  { name: "/exit", description: "Exit Patric" }
];

const PROVIDERS = ["openai", "openai-codex", "openrouter", "anthropic", "ollama", "gemini"] as const;

const RECOMMENDED_MODELS: Record<string, string[]> = {
  openai: ["gpt-5.4", "gpt-5.1", "gpt-5-mini", "gpt-5-nano"],
  "openai-codex": ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex-mini"],
  openrouter: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4", "google/gemini-2.5-flash"],
  anthropic: ["claude-sonnet-4-20250514", "claude-opus-4-1-20250805"],
  ollama: ["qwen3", "llama3.2", "deepseek-r1"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"]
};

const SETTINGS_ITEMS = [
  "Provider",
  "Model",
  "API Key",
  "Login",
  "Base URL",
] as const;

const SETTINGS_ITEMS_NO_API_KEY = [
  "Provider",
  "Model",
  "Login",
  "Base URL",
] as const;

const ANTHROPIC_KEYS_URL = "https://console.anthropic.com/settings/keys";

function invert(text: string): string {
  return `\x1b[7m${text}\x1b[0m`;
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

function color(text: string, code: number): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function cyan(text: string): string {
  return color(text, 36);
}

function gray(text: string): string {
  return color(text, 90);
}

function red(text: string): string {
  return color(text, 31);
}

function yellow(text: string): string {
  return color(text, 33);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function style(text: string, ...codes: number[]): string {
  return `\x1b[${codes.join(";")}m${text}\x1b[0m`;
}

const theme = {
  text: (text: string) => style(text, 39),
  muted: (text: string) => style(text, 38, 5, 244),
  faint: (text: string) => style(text, 2, 38, 5, 240),
  accent: (text: string) => style(text, 38, 5, 180),
  accentStrong: (text: string) => style(text, 1, 38, 5, 223),
  success: (text: string) => style(text, 38, 5, 114),
  warning: (text: string) => style(text, 38, 5, 215),
  error: (text: string) => style(text, 38, 5, 203),
  border: (text: string) => style(text, 38, 5, 238),
  panel: (text: string) => style(text, 39),
  selected: (text: string) => style(text, 30, 48, 5, 223),
  title: (text: string) => style(text, 1, 39),
  key: (text: string) => style(text, 1, 38, 5, 250),
  user: (text: string) => style(text, 39),
  assistant: (text: string) => style(text, 39),
  system: (text: string) => style(text, 39),
  chip: (text: string) => style(text, 39),
  overlay: (text: string) => style(text, 38, 5, 236),
  prompt: (text: string) => style(text, 1, 38, 5, 223)
};

function visibleWidth(value: string): number {
  return stripAnsi(value).length;
}

function truncatePlain(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 1)}…`;
}

function truncateAnsi(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  let out = "";
  let visible = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\x1b") {
      let sequence = char;
      index += 1;
      while (index < value.length) {
        sequence += value[index];
        if (value[index] === "m") {
          break;
        }
        index += 1;
      }
      out += sequence;
      continue;
    }
    if (visible >= width) {
      break;
    }
    out += char;
    visible += 1;
  }

  if (visibleWidth(value) > width && width > 1) {
    const plain = stripAnsi(out);
    out = `${plain.slice(0, width - 1)}…`;
  }

  return out;
}

function padLine(value: string, width: number): string {
  const gap = Math.max(0, width - visibleWidth(value));
  return `${value}${" ".repeat(gap)}`;
}

function frameLine(left: string, content: string, right: string, width: number): string {
  const innerWidth = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
  return `${left}${padLine(content, innerWidth)}${right}`;
}

function alignSides(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

function panel(lines: string[], width: number): string[] {
  const innerWidth = Math.max(1, width - 4);
  const top = `${theme.border("┌")}${theme.border("─".repeat(width - 2))}${theme.border("┐")}`;
  const bottom = `${theme.border("└")}${theme.border("─".repeat(width - 2))}${theme.border("┘")}`;
  const body = lines.map((line) =>
    frameLine(theme.border("│ "), truncateAnsi(line, innerWidth), theme.border(" │"), width)
  );
  return [top, ...body, bottom];
}

function divider(width: number, label?: string): string {
  const ruleWidth = Math.max(0, width);
  if (!label) {
    return theme.border("─".repeat(ruleWidth));
  }
  const text = ` ${label} `;
  const left = Math.max(2, Math.floor((ruleWidth - text.length) / 2));
  const right = Math.max(0, ruleWidth - text.length - left);
  return `${theme.border("─".repeat(left))}${theme.muted(text)}${theme.border("─".repeat(right))}`;
}

function renderListRow(left: string, right: string, width: number, selected = false): string {
  const row = padLine(alignSides(left, right, width), width);
  return selected ? theme.selected(row) : row;
}

function renderChip(label: string, value: string): string {
  return `${theme.muted(label)} ${theme.chip(value)}`;
}

function renderInputWithCursor(value: string, cursor: number, placeholder: string): string {
  if (!value) {
    return `${invert(" ")}${theme.muted(placeholder)}`;
  }
  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  const before = value.slice(0, safeCursor);
  const current = value[safeCursor] || " ";
  const after = safeCursor < value.length ? value.slice(safeCursor + 1) : "";
  return `${theme.text(before)}${invert(current)}${theme.text(after)}`;
}

function formatToolCallSummary(name: string, args?: Record<string, any>): string {
  if (name === "fetch_url") {
    const rawUrl = typeof args?.url === "string" ? args.url : "";
    if (!rawUrl) {
      return "fetch_url";
    }
    try {
      const parsed = new URL(rawUrl);
      const pathLabel = `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
      return `fetch_url ${pathLabel}`;
    } catch {
      return `fetch_url ${truncatePlain(rawUrl, 56)}`;
    }
  }
  if (name === "web_search") {
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    return query ? `web_search "${truncatePlain(query, 44)}"` : "web_search";
  }
  if (name === "bash") {
    const cmd = typeof args?.command === "string" ? args.command.trim() : "";
    return cmd ? `bash "${truncatePlain(cmd, 50)}"` : "bash";
  }
  if (name === "read_file") {
    const p = typeof args?.path === "string" ? args.path : "";
    return p ? `read_file ${truncatePlain(p, 50)}` : "read_file";
  }
  if (name === "write_file") {
    const p = typeof args?.path === "string" ? args.path : "";
    return p ? `write_file ${truncatePlain(p, 50)}` : "write_file";
  }
  if (name === "edit_file") {
    const p = typeof args?.path === "string" ? args.path : "";
    return p ? `edit_file ${truncatePlain(p, 50)}` : "edit_file";
  }
  if (name === "glob") {
    const pattern = typeof args?.pattern === "string" ? args.pattern : "";
    return pattern ? `glob "${truncatePlain(pattern, 50)}"` : "glob";
  }
  if (name === "grep") {
    const pattern = typeof args?.pattern === "string" ? args.pattern : "";
    return pattern ? `grep "${truncatePlain(pattern, 44)}"` : "grep";
  }
  if (name === "list_directory") {
    const p = typeof args?.path === "string" ? args.path : ".";
    return `list_directory ${truncatePlain(p, 50)}`;
  }
  if (name === "browser") {
    const action = typeof args?.action === "string" ? args.action : "";
    if (action === "navigate") {
      const url = typeof args?.url === "string" ? args.url : "";
      return url ? `browser navigate ${truncatePlain(url, 44)}` : "browser navigate";
    }
    if (action === "click") return `browser click [${args?.ref ?? "?"}]`;
    if (action === "type") {
      const t = typeof args?.text === "string" ? args.text : "";
      return `browser type [${args?.ref ?? "?"}] "${truncatePlain(t, 30)}"`;
    }
    return action ? `browser ${action}` : "browser";
  }
  if (name === "spawn_agent") {
    const agentName = typeof args?.name === "string" ? args.name : "?";
    return `spawn_agent ${truncatePlain(agentName, 24)}`;
  }
  if (name === "wait_agent") {
    const agentId = typeof args?.agent_id === "string" ? args.agent_id : "?";
    return `wait_agent ${truncatePlain(agentId, 24)}`;
  }
  if (name === "cancel_agent") {
    const agentId = typeof args?.agent_id === "string" ? args.agent_id : "?";
    return `cancel_agent ${truncatePlain(agentId, 24)}`;
  }
  if (name === "list_agents") {
    return "list_agents";
  }
  return name;
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (!rawLine) {
      lines.push("");
      continue;
    }
    const words = rawLine.split(/(\s+)/).filter(Boolean);
    let line = "";
    for (const token of words) {
      if (token.trim() === "") {
        if (line && visibleWidth(line) + token.length <= width) {
          line += token;
        }
        continue;
      }
      if (!line) {
        if (token.length <= width) {
          line = token;
          continue;
        }
        let remainder = token;
        while (remainder.length > width) {
          lines.push(remainder.slice(0, width));
          remainder = remainder.slice(width);
        }
        line = remainder;
        continue;
      }
      if (visibleWidth(line) + token.length <= width) {
        line += token;
        continue;
      }
      lines.push(line.trimEnd());
      if (token.length <= width) {
        line = token;
        continue;
      }
      let remainder = token;
      while (remainder.length > width) {
        lines.push(remainder.slice(0, width));
        remainder = remainder.slice(width);
      }
      line = remainder;
    }
    if (line) {
      lines.push(line.trimEnd());
    }
  }
  return lines;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

// ---------------------------------------------------------------------------
// Markdown → ANSI rendering (using marked-terminal)
// ---------------------------------------------------------------------------

function renderMarkdown(text: string, width: number): string[] {
  const m = new Marked();
  const ext = markedTerminal({ width, reflowText: true, showSectionPrefix: false });
  // Fix marked-terminal bug: text renderer doesn't recurse into inline tokens
  const origText = ext.renderer.text;
  ext.renderer.text = function (token: any) {
    if (typeof token === "object" && token.tokens) {
      return this.parser.parseInline(token.tokens);
    }
    return origText.call(this, token);
  };
  m.use(ext);
  const raw = m.parse(text, { async: false }) as string;
  const lines = raw.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function leaveAltScreen(): void {
  process.stdout.write("\x1b[?1049l");
}

function clearScreen(): void {
  process.stdout.write("\x1b[3J\x1b[2J\x1b[H");
}

function setCursorHidden(hidden: boolean): void {
  process.stdout.write(hidden ? "\x1b[?25l" : "\x1b[?25h");
}

function isPrintable(char: string): boolean {
  return char >= " " && char !== "\x7f";
}

function splitInputSequence(value: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\u001b") {
      const next = value[index + 1];
      if (next === "[") {
        // CSI sequence: ESC [ ... <final byte 0x40-0x7E>
        let seq = `${char}${next}`;
        index += 2;
        while (index < value.length) {
          const code = value.charCodeAt(index);
          seq += value[index];
          index += 1;
          if (code >= 0x40 && code <= 0x7e) {
            break;
          }
        }
        index -= 1; // outer loop will increment
        out.push(seq);
      } else {
        out.push(char);
      }
      continue;
    }
    out.push(char);
  }
  return out;
}

function maskSecret(value: string): string {
  return value ? "***configured***" : "(not set)";
}

function providerApiKeyLabel(provider: string): string {
  switch (normalizeProviderName(provider)) {
    case "openai-codex":
      return "Token override";
    case "openrouter":
      return "OpenRouter API key";
    case "anthropic":
      return "Anthropic API key";
    case "ollama":
      return "API key";
    case "gemini":
      return "Gemini API key";
    case "openai":
    default:
      return "OpenAI API key";
  }
}

function providerBaseUrlLabel(provider: string): string {
  return normalizeProviderName(provider) === "ollama" ? "Ollama host" : "Base URL";
}

function getModelOptions(config: PatricConfig, discovered: string[] = []): string[] {
  const provider = normalizeProviderName(config.provider);
  const recent = config.recentModels[provider] || [];
  const recommended = RECOMMENDED_MODELS[provider] || [];
  return [...new Set([...recent, ...discovered, ...recommended]), "Custom model..."];
}

export async function startTui(
  config: PatricConfig,
  options?: { openSettings?: boolean; closeAfterSettings?: boolean }
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Patric TUI requires an interactive terminal.");
  }

  let cwd = process.cwd();
  let activeModel = config.model;
  let mode: ViewMode = options?.openSettings ? "settings" : "chat";
  let isActive = true;
  let isBusy = false;
  let input = "";
  let cursor = 0;
  let scrollOffset = 0;
  let slashIndex = 0;
  const promptHistory: string[] = loadHistory();
  let historyIndex = -1;
  let savedInput = "";
  let settingsIndex = 0;
  let pickerIndex = 0;
  let editingField: "apiKey" | "baseUrl" | "customModel" | null = null;
  let editingBuffer = "";
  let overlayStatus = "";
  let activeToolStatus = "";
  let shouldExit = false;
  let closeAfterSettings = options?.closeAfterSettings ?? false;
  let modelPickerLoading = false;
  let modelPickerRequestId = 0;
  let isInAltScreen = false;
  let renderedPromptLines = 0;
  let transcriptEndsWithNewline = true;
  let introPrinted = false;
  let hasPrintedConversation = false;
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let abortController: AbortController | null = null;

  // Agent run tracking for tree display
  interface AgentRunInfo {
    id: string;
    name: string;
    task: string;
    state: "queued" | "running" | "done" | "error" | "cancelled";
    toolUses: number;
    lastTool: string;
  }
  const agentRuns = new Map<string, AgentRunInfo>();

  const draftConfig: PatricConfig = {
    ...config,
    recentModels: { ...config.recentModels }
  };
  let draftApiKey = "";
  let draftOAuthToken = "";
  const modelOptionsCache = new Map<string, string[]>();
  const getSettingsItems = () =>
    normalizeProviderName(draftConfig.provider) === "openai-codex"
      ? SETTINGS_ITEMS_NO_API_KEY
      : SETTINGS_ITEMS;

  const messages: Message[] = [];

  const llmMessages: ChatMessage[] = [{ role: "system", content: config.systemPrompt }];

  const getSlashSuggestions = () => {
    if (!input.startsWith("/")) {
      return [];
    }
    const query = input.trim().split(/\s+/)[0].toLowerCase();
    return SLASH_COMMANDS.filter((command) => command.name.startsWith(query)).slice(0, 6);
  };

  const addMessage = (role: Role, content: string) => {
    const message = { role, content: normalizeNewlines(content) };
    messages.push(message);
    scrollOffset = 0;
    scheduleRender();
  };

  const addToolMessage = (
    content: string,
    state: "running" | "done" | "error",
    detail = "",
    key?: string
  ) => {
    const message = {
      role: "tool" as const,
      content: normalizeNewlines(content),
      state,
      detail: normalizeNewlines(detail),
      key
    };
    messages.push(message);
    scheduleRender();
  };

  const updateLastToolMessage = (state: "done" | "error", detail = "") => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "tool" && message.state === "running") {
        message.state = state;
        message.detail = normalizeNewlines(detail);
        scheduleRender();
        return;
      }
    }
  };

  const upsertToolMessage = (
    key: string,
    content: string,
    state: "running" | "done" | "error",
    detail = ""
  ) => {
    const normalizedContent = normalizeNewlines(content);
    const normalizedDetail = normalizeNewlines(detail);
    const existing = messages.find((message) => message.role === "tool" && message.key === key);
    if (existing) {
      existing.content = normalizedContent;
      existing.state = state;
      existing.detail = normalizedDetail;
      scheduleRender();
      return;
    }
    addToolMessage(normalizedContent, state, normalizedDetail, key);
  };

  const setStatus = (text: string) => {
    overlayStatus = text;
  };

  const renderAgentGroupMessage = () => {
    if (agentRuns.size === 0) {
      return;
    }
    const runs = [...agentRuns.values()];
    const running = runs.filter((r) => r.state === "queued" || r.state === "running");
    const done = runs.filter((r) => r.state === "done");
    const failed = runs.filter((r) => r.state === "error" || r.state === "cancelled");
    const allFinished = running.length === 0;

    // Build header
    let header: string;
    if (allFinished) {
      const names = runs.map((r) => capitalize(r.name)).join(", ");
      header = `Ran ${runs.length} agent${runs.length > 1 ? "s" : ""}: ${names}`;
    } else {
      const agentNames = new Map<string, number>();
      for (const r of running) {
        agentNames.set(r.name, (agentNames.get(r.name) || 0) + 1);
      }
      const parts: string[] = [];
      for (const [name, count] of agentNames) {
        parts.push(`${count} ${capitalize(name)} agent${count > 1 ? "s" : ""}`);
      }
      header = `Running ${parts.join(", ")}…`;
    }

    // Build tree lines
    const lines: string[] = [header];
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const isLast = i === runs.length - 1;
      const prefix = isLast ? "└─" : "├─";
      const childPrefix = isLast ? "   " : "│  ";
      const toolInfo = run.toolUses > 0 ? ` · ${run.toolUses} tool use${run.toolUses > 1 ? "s" : ""}` : "";
      const taskLabel = truncatePlain(run.task, 60);
      lines.push(`${prefix} ${capitalize(run.name)}: ${taskLabel}${toolInfo}`);
      if (run.lastTool && (run.state === "running" || run.state === "queued")) {
        lines.push(`${childPrefix}⎿  ${run.lastTool}`);
      }
    }

    const content = lines.join("\n");
    const state = allFinished
      ? (failed.length > 0 ? "error" : "done")
      : "running";
    upsertToolMessage("agent-group", content, state as "running" | "done" | "error");
  };

  function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  const handleToolEvent = (event: ToolEvent) => {
    if (event.type === "tool_start") {
      stopSpinner();
      const summary = formatToolCallSummary(event.name, event.arguments);
      activeToolStatus = summary;
      addToolMessage(summary, "running");
      return;
    }
    if (event.type === "tool_end") {
      const failed = Boolean(event.result && event.result.startsWith("Tool error:"));
      updateLastToolMessage(failed ? "error" : "done", failed ? event.result || "" : "");
      activeToolStatus = "";
      return;
    }
    if (event.type === "tool_round_complete") {
      activeToolStatus = "";
      return;
    }
    if (event.type === "agent_status") {
      const agentId = event.agentId || event.agentName || "agent";
      const agentName = event.agentName || "agent";
      const existing = agentRuns.get(agentId);
      if (existing) {
        existing.state = event.agentState || "running";
      } else {
        agentRuns.set(agentId, {
          id: agentId,
          name: agentName,
          task: event.detail || "",
          state: event.agentState || "queued",
          toolUses: 0,
          lastTool: "",
        });
      }
      renderAgentGroupMessage();
      return;
    }
    if (event.type === "agent_tool_start") {
      const agentId = event.agentId || "";
      const run = agentRuns.get(agentId);
      if (run) {
        run.toolUses += 1;
        run.lastTool = formatToolCallSummary(event.name, event.arguments);
        renderAgentGroupMessage();
      }
      return;
    }
    if (event.type === "agent_tool_end") {
      renderAgentGroupMessage();
      return;
    }
  };

  const syncDraftConfig = () => {
    draftConfig.provider = config.provider;
    draftConfig.model = config.model;
    draftConfig.baseUrl = config.baseUrl;
    draftConfig.apiKey = config.apiKey;
    draftConfig.oauthToken = config.oauthToken;
    draftConfig.systemPrompt = config.systemPrompt;
    draftConfig.recentModels = { ...config.recentModels };
  };

  const syncDraftAuth = (provider = draftConfig.provider) => {
    const auth = getEffectiveAuth(provider, {
      apiKey: config.apiKey,
      oauthToken: config.oauthToken
    });
    draftApiKey = auth?.type === "api" ? auth.key : "";
    draftOAuthToken = auth?.type === "oauth" ? auth.access : "";
  };

  syncDraftAuth();

  const getModelCacheKey = (provider: string, baseUrl: string) =>
    `${normalizeProviderName(provider)}:${baseUrl.replace(/\/$/, "")}`;

  const getDraftRuntimeConfig = (): PatricConfig => ({
    ...draftConfig,
    apiKey: draftApiKey,
    oauthToken: draftOAuthToken,
    recentModels: { ...draftConfig.recentModels }
  });

  const getDraftModelOptions = () =>
    getModelOptions(
      draftConfig,
      modelOptionsCache.get(getModelCacheKey(draftConfig.provider, draftConfig.baseUrl)) || []
    );

  const supportsLiveModelDiscovery = (provider: string) => {
    const normalized = normalizeProviderName(provider);
    return normalized === "openai" || normalized === "openrouter" || normalized === "ollama";
  };

  const refreshModelOptions = async (force = false) => {
    if (!supportsLiveModelDiscovery(draftConfig.provider)) {
      return;
    }

    const cacheKey = getModelCacheKey(draftConfig.provider, draftConfig.baseUrl);
    if (!force && modelOptionsCache.has(cacheKey)) {
      return;
    }

    const requestId = ++modelPickerRequestId;
    modelPickerLoading = true;
    overlayStatus = `Loading ${draftConfig.provider} models...`;
    render();

    try {
      const models = await listAvailableModels(getDraftRuntimeConfig());
      if (requestId !== modelPickerRequestId) {
        return;
      }
      modelOptionsCache.set(cacheKey, models);
      const options = getDraftModelOptions();
      pickerIndex = Math.max(0, options.indexOf(draftConfig.model));
      overlayStatus = models.length > 0
        ? `Loaded ${models.length} ${draftConfig.provider} models`
        : `No ${draftConfig.provider} models returned; using fallback list`;
    } catch {
      if (requestId !== modelPickerRequestId) {
        return;
      }
      overlayStatus = `Could not load live ${draftConfig.provider} models; showing fallback list`;
    } finally {
      if (requestId === modelPickerRequestId) {
        modelPickerLoading = false;
        render();
      }
    }
  };

  const getActiveChatConfig = (): PatricConfig => ({
    ...config,
    model: normalizeModelForProvider(config.provider, activeModel),
    recentModels: { ...config.recentModels }
  });

  const clearPromptBlock = () => {
    if (renderedPromptLines === 0 || mode !== "chat" || isInAltScreen) {
      return;
    }
    for (let index = 0; index < renderedPromptLines; index += 1) {
      process.stdout.write("\r\x1b[2K");
      if (index < renderedPromptLines - 1) {
        process.stdout.write("\x1b[1A");
      }
    }
    process.stdout.write("\r");
    renderedPromptLines = 0;
  };

  const getChatPromptLines = (): string[] => {
    const columns = process.stdout.columns || 100;
    const width = Math.max(48, columns - 2);
    const prompt = renderInputWithCursor(input, cursor, 'Try "what does this project do?"');
    const cfg = getActiveChatConfig();
    const pctStr = getContextPercentage(cfg, llmMessages);
    const pctNum = getContextPercentageNum(cfg, llmMessages);
    const contextLabel = pctNum >= 90
      ? theme.error(`context ${pctStr}%`)
      : pctNum >= 70
        ? theme.warning(`context ${pctStr}%`)
        : theme.muted(`context ${pctStr}%`);

    const rule = theme.border("─".repeat(width));
    const inputLine = `${theme.prompt(">")} ${truncateAnsi(prompt, Math.max(12, width - 2))}`;
    const ruleBottom = theme.border("─".repeat(width));
    const footer = alignSides(` ${theme.muted("/help · /settings")}`, `${contextLabel} `, width);

    const lines = [rule, inputLine, ruleBottom, footer];
    for (const line of renderSlashMenu()) {
      lines.push(truncateAnsi(line, width));
    }
    return lines;
  };

  const renderSpinnerPrompt = () => {
    if (!isActive || mode !== "chat" || isInAltScreen) {
      return;
    }
    clearPromptBlock();
    const columns = process.stdout.columns || 100;
    const width = Math.max(48, columns - 2);
    const frame = spinnerFrames[spinnerFrame % spinnerFrames.length];
    const left = `${theme.prompt(">")} ${theme.muted(`${frame} Thinking...`)}`;
    const right = activeToolStatus ? theme.muted(activeToolStatus) : theme.muted("esc to stop");
    const line = alignSides(truncateAnsi(left, Math.max(12, width - 18)), right, width);
    process.stdout.write(line);
    renderedPromptLines = 1;
  };

  const startSpinner = () => {
    spinnerFrame = 0;
    if (spinnerTimer) clearInterval(spinnerTimer);
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % spinnerFrames.length;
      render();
    }, 80);
    render();
  };

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    // No need to clear prompt block — fullscreen render() handles it
    clearPromptBlock();
  };

  const renderChatPrompt = () => {
    if (!isActive || mode !== "chat" || isInAltScreen) {
      clearPromptBlock();
      return;
    }
    if (isBusy) {
      return;
    }
    clearPromptBlock();
    const lines = getChatPromptLines();
    process.stdout.write(lines.join("\n"));
    renderedPromptLines = lines.length;
  };

  const writeTranscript = (text: string) => {
    if (!text) {
      return;
    }
    clearPromptBlock();
    process.stdout.write(text);
    transcriptEndsWithNewline = text.endsWith("\n");
  };

  const printTranscriptLines = (
    lines: string[],
    options: { leadingBlank?: boolean; trailingBlank?: boolean } = {}
  ) => {
    if (lines.length === 0) {
      return;
    }
    let out = "";
    if (!transcriptEndsWithNewline) {
      out += "\n";
    }
    if (options.leadingBlank) {
      out += "\n";
    }
    out += lines.join("\n");
    out += options.trailingBlank ? "\n\n" : "\n";
    writeTranscript(out);
    if (!isBusy) {
      renderChatPrompt();
    }
  };

  const formatMessageLines = (message: Message, width: number): string[] => {
    if (message.role === "user") {
      const wrapped = wrapText(message.content, Math.max(10, width - 2));
      return [
        `${theme.prompt(">")} ${theme.user(wrapped[0] || "")}`,
        ...wrapped.slice(1).map((line) => `  ${theme.user(line)}`)
      ];
    }
    if (message.role === "assistant") {
      return renderMarkdown(message.content, Math.max(10, width));
    }
    if (message.role === "tool" && message.key === "agent-group") {
      const contentLines = message.content.split("\n");
      const color = message.state === "running" ? theme.muted
        : message.state === "error" ? theme.error
        : theme.system;
      const icon = message.state === "running" ? theme.muted("⏺")
        : message.state === "error" ? theme.error("⏺")
        : theme.success("⏺");
      return contentLines.map((line, li) =>
        li === 0 ? `${icon} ${color(line)}` : `  ${color(line)}`
      );
    }
    if (message.role === "tool") {
      const icon = message.state === "running"
        ? theme.muted("⏺")
        : message.state === "error"
          ? theme.error("⏺")
          : theme.success("⏺");
      const body = message.state === "error"
        ? theme.error
        : message.state === "running"
          ? theme.muted
          : theme.system;
      const lines = wrapText(message.content, Math.max(10, width - 3))
        .map((line) => `${icon} ${body(line)}`);
      if (message.detail && message.state === "error") {
        lines.push(...wrapText(message.detail, Math.max(10, width - 5)).map((line) => `  ${theme.error(line)}`));
      }
      return lines;
    }
    const label = message.role === "error" ? theme.error("⏺") : theme.muted("⏺");
    const body = message.role === "error" ? theme.error : theme.system;
    return wrapText(message.content, Math.max(10, width - 3)).map((line) => `${label} ${body(line)}`);
  };

  const appendMessageToTranscript = (message: Message) => {
    fs.appendFileSync("/tmp/patric-debug.log", message.role + "\n");
    if (mode !== "chat" || isInAltScreen) {
      return;
    }
    if (message.role === "tool" && message.state === "running") {
      return;
    }
    const columns = process.stdout.columns || 100;
    const width = Math.max(20, columns - 4);
    printTranscriptLines(formatMessageLines(message, width), {
      leadingBlank: false,
      trailingBlank: message.role === "assistant"
    });
    if (message.role === "user") {
      hasPrintedConversation = true;
    }
  };

  const printChatIntro = () => {
    if (introPrinted) {
      return;
    }
    const activeConfig = getActiveChatConfig();
    const modelInfo = activeConfig.model
      ? `${activeConfig.provider}/${activeConfig.model}`
      : `${activeConfig.provider}/(not set)`;
    const authStatus = getEffectiveAuthStatus(activeConfig.provider, {
      apiKey: activeConfig.apiKey,
      oauthToken: activeConfig.oauthToken
    });
    printTranscriptLines(
      [
        `${theme.title("Patric")} ${theme.faint("v0.3.0")}`,
        `${theme.muted("cwd")} ${cwd}`,
        `${theme.muted("model")} ${modelInfo}`,
        `${theme.muted("auth")} ${authStatus}`,
        theme.muted("Use /help for commands or /settings to configure.")
      ],
      { trailingBlank: true }
    );
    introPrinted = true;
  };

  const redrawChatScreen = () => {
    if (!isActive || mode !== "chat" || isInAltScreen) {
      return;
    }
    const columns = process.stdout.columns || 100;
    const width = Math.max(20, columns - 4);
    let transcript = "";

    if (introPrinted) {
      const activeConfig = getActiveChatConfig();
      const modelInfo = activeConfig.model
        ? `${activeConfig.provider}/${activeConfig.model}`
        : `${activeConfig.provider}/(not set)`;
      const authStatus = getEffectiveAuthStatus(activeConfig.provider, {
        apiKey: activeConfig.apiKey,
        oauthToken: activeConfig.oauthToken
      });
      transcript += [
        `${theme.title("Patric")} ${theme.faint("v0.3.0")}`,
        `${theme.muted("cwd")} ${cwd}`,
        `${theme.muted("model")} ${modelInfo}`,
        `${theme.muted("auth")} ${authStatus}`,
        theme.muted("Use /help for commands or /settings to configure.")
      ].join("\n");
      transcript += "\n\n";
    }

    let seenUserMessage = false;
    for (const message of messages) {
      if (message.role === "tool" && message.state === "running") {
        continue;
      }
      if (message.role === "user" && seenUserMessage) {
        transcript += "\n";
      }
      transcript += `${formatMessageLines(message, width).join("\n")}\n`;
      if (message.role === "assistant") {
        transcript += "\n";
      }
      if (message.role === "user") {
        seenUserMessage = true;
      }
    }

    renderedPromptLines = 0;
    clearScreen();
    if (transcript) {
      process.stdout.write(transcript);
      transcriptEndsWithNewline = transcript.endsWith("\n");
    } else {
      transcriptEndsWithNewline = true;
    }
    renderChatPrompt();
  };

  const openSettingsScreen = () => {
    syncDraftConfig();
    syncDraftAuth();
    mode = "settings";
    overlayStatus = "";
    settingsIndex = 0;
    render();
  };

  const renderBackdrop = (displayMode: ViewMode = mode): string[] => {
    const displayConfig = displayMode === "chat" ? getActiveChatConfig() : draftConfig;
    const columns = process.stdout.columns || 100;
    const width = Math.max(48, columns - 2);
    const modelInfo = displayConfig.model
      ? `${displayConfig.provider}/${displayConfig.model}`
      : `${displayConfig.provider}/(unset)`;
    const normalizedDisplayProvider = normalizeProviderName(displayConfig.provider);
    const authStatus = displayMode === "settings"
      ? normalizedDisplayProvider === "ollama"
        ? "local"
        : normalizedDisplayProvider === "anthropic"
          ? (draftApiKey.trim() ? "ready" : "needs api key")
          : normalizedDisplayProvider === "openai"
            ? (draftApiKey.trim() ? "ready" : "needs api key")
            : normalizedDisplayProvider === "openai-codex"
              ? (draftOAuthToken.trim() ? "oauth" : "needs browser login")
          : draftOAuthToken.trim()
            ? "oauth"
            : draftApiKey.trim()
              ? "ready"
              : "needs auth"
      : getEffectiveAuthStatus(displayConfig.provider, {
          apiKey: displayConfig.apiKey,
          oauthToken: displayConfig.oauthToken
        });
    const readiness = authStatus === "local" || authStatus === "ready" || authStatus === "oauth"
      ? theme.success(authStatus)
      : theme.warning(authStatus);
    const cwdLabel = truncatePlain(cwd, Math.max(10, width - 38));
    const shellMode = displayMode === "chat" ? "chat" : "settings";
    const hero = `${theme.title("Patric")} ${theme.faint("v0.3.0")}`;
    return [
      alignSides(hero, `${theme.muted(shellMode)}`, width),
      alignSides(
        `${renderChip("provider", displayConfig.provider)}  ${renderChip("model", truncatePlain(modelInfo, Math.max(12, width - 56)))}`,
        `${theme.muted("status")} ${readiness}`,
        width
      ),
      alignSides(
        `${renderChip("cwd", cwdLabel)}`,
        `${theme.muted("help")} ${theme.chip("/help  /settings")}`,
        width
      ),
      divider(width)
    ];
  };

  const renderChatFrame = (dimmed = false): string[] => {
    const rows = process.stdout.rows || 30;
    const columns = process.stdout.columns || 100;
    const width = Math.max(48, columns - 2);
    const header = renderBackdrop("chat");
    const inputLines = renderInput();
    const availableHeight = Math.max(0, rows - header.length - inputLines.length);
    const messageLines = renderMessages(availableHeight, width);
    const out = [...header, ...messageLines];

    while (out.length < rows - inputLines.length) {
      out.push("");
    }
    out.push(...inputLines);

    const frameLines = out.slice(0, rows);
    if (!dimmed) {
      return frameLines;
    }
    return frameLines.map((line) => {
      const plain = stripAnsi(line);
      return plain ? gray(plain) : "";
    });
  };

  const renderMessages = (availableHeight: number, width: number): string[] => {
    const out: string[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        if (out.length > 0 && out[out.length - 1] !== "") {
          out.push("");
        }
        const wrapped = wrapText(message.content, Math.max(10, width - 2));
        out.push(`${theme.prompt(">")} ${theme.user(wrapped[0] || "")}`);
        for (let i = 1; i < wrapped.length; i++) {
          out.push(`  ${theme.user(wrapped[i])}`);
        }
      } else if (message.role === "assistant") {
        const mdLines = renderMarkdown(message.content, Math.max(10, width));
        for (const line of mdLines) {
          out.push(line);
        }
        out.push("");
      } else if (message.role === "tool" && message.key === "agent-group") {
        const lines = message.content.split("\n");
        const color = message.state === "running" ? theme.muted
          : message.state === "error" ? theme.error
          : theme.system;
        const icon = message.state === "running" ? theme.muted("⏺")
          : message.state === "error" ? theme.error("⏺")
          : theme.success("⏺");
        for (let li = 0; li < lines.length; li++) {
          if (li === 0) {
            out.push(`${icon} ${color(lines[li])}`);
          } else {
            out.push(`  ${color(lines[li])}`);
          }
        }
      } else if (message.role === "tool") {
        const icon = message.state === "running"
          ? theme.muted("⏺")
          : message.state === "error"
            ? theme.error("⏺")
            : theme.success("⏺");
        const body = message.state === "error"
          ? theme.error
          : message.state === "running"
            ? theme.muted
            : theme.system;
        for (const line of wrapText(message.content, Math.max(10, width - 3))) {
          out.push(`${icon} ${body(line)}`);
        }
        if (message.detail && message.state === "error") {
          for (const line of wrapText(message.detail, Math.max(10, width - 5))) {
            out.push(`  ${theme.error(line)}`);
          }
        }
      } else if (message.role === "error" || message.role === "status") {
        const label = message.role === "error" ? theme.error("⏺") : theme.muted("⏺");
        const body = message.role === "error" ? theme.error : theme.system;
        for (const line of wrapText(message.content, Math.max(10, width - 3))) {
          out.push(`${label} ${body(line)}`);
        }
      }
    }
    while (out.length > 0 && out[out.length - 1] === "") {
      out.pop();
    }
    const total = out.length;
    const maxScroll = Math.max(0, total - availableHeight);
    scrollOffset = Math.min(scrollOffset, maxScroll);
    const start = Math.max(0, total - availableHeight - scrollOffset);
    return out.slice(start, start + availableHeight);
  };

  const renderSlashMenu = (): string[] => {
    const suggestions = getSlashSuggestions();
    if (suggestions.length === 0) {
      return [];
    }
    const columns = process.stdout.columns || 100;
    const width = Math.max(36, Math.min(columns - 6, 68));
    return suggestions.map((suggestion, index) => {
      const name = truncatePlain(suggestion.name, 16).padEnd(16, " ");
      const desc = truncatePlain(suggestion.description, Math.max(12, width - 21));
      return `  ${renderListRow(theme.key(name), theme.muted(desc), width, index === slashIndex)}`;
    });
  };

  const renderInput = (): string[] => {
    const columns = process.stdout.columns || 100;
    const width = Math.max(48, columns - 2);
    const frame = spinnerFrames[spinnerFrame % spinnerFrames.length];
    const prompt = isBusy
      ? theme.muted(`${frame} Thinking...`)
      : renderInputWithCursor(input, cursor, 'Try "what does this project do?"');
    const composer = [divider(width)];
    let rightStatus = "";
    if (activeToolStatus) {
      rightStatus = theme.muted(activeToolStatus);
    } else if (isBusy) {
      rightStatus = theme.muted("esc to stop");
    } else {
      const cfg = getActiveChatConfig();
      const pctStr = getContextPercentage(cfg, llmMessages);
      const pctNum = getContextPercentageNum(cfg, llmMessages);
      const label = `context ${pctStr}%`;
      rightStatus = pctNum >= 90
        ? theme.error(label)
        : pctNum >= 70
          ? theme.warning(label)
          : theme.muted(label);
    }
    const promptLine = alignSides(
      `${theme.prompt(">")} ${truncateAnsi(prompt, Math.max(12, width - 18))}`,
      rightStatus,
      width
    );
    composer.push(promptLine);
    const menu = renderSlashMenu();
    if (menu.length > 0) {
      composer.push("");
      for (const line of menu) {
        composer.push(truncateAnsi(line, width));
      }
    }
    return composer;
  };

  const renderOverlay = (title: string, bodyLines: string[], footer: string, compact = false): string[] => {
    const columns = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    const width = compact
      ? Math.min(54, Math.max(40, columns - 24))
      : Math.min(68, Math.max(50, columns - 20));
    const modal = panel(
      [
        theme.title(title),
        theme.faint(""),
        "",
        ...bodyLines,
        "",
        theme.system(footer)
      ],
      width
    );
    const leftPadding = Math.max(2, Math.floor((columns - width) / 2));
    const topPadding = Math.max(2, Math.floor((rows - modal.length) / 2) - 1);
    const out = renderChatFrame(true);
    for (let index = 0; index < modal.length; index += 1) {
      out[topPadding + index] = `${" ".repeat(leftPadding)}${modal[index]}`;
    }
    return out;
  };

  const renderSettingsOverlay = (): string[] => {
    if (mode === "provider-picker") {
      const items = PROVIDERS.map((provider, index) =>
        renderListRow(theme.key(provider), theme.muted(index === pickerIndex ? "selected" : ""), 24, index === pickerIndex)
      );
      return renderOverlay(
        "Choose provider",
        [theme.muted("Select the backend Patric should talk to."), "", ...items],
        overlayStatus || "Up/Down · Enter select · Esc back",
        true
      );
    }
    if (mode === "model-picker") {
      const options = getDraftModelOptions().map((item, index) =>
        renderListRow(
          theme.panel(truncatePlain(item, 28)),
          theme.muted(index === pickerIndex ? "selected" : ""),
          34,
          index === pickerIndex
        )
      );
      const description = supportsLiveModelDiscovery(draftConfig.provider)
        ? "Recent, recommended, and live models for the active provider."
        : "Recent and recommended models for the active provider.";
      return renderOverlay(
        "Choose model",
        [theme.muted(description), "", ...options],
        overlayStatus ||
          (modelPickerLoading
            ? "Loading live model list... · Esc back"
            : "Up/Down · Enter select · Esc back"),
        true
      );
    }

    const settingsItems = getSettingsItems();
    const items = settingsItems.map((item, index) => {
      let value = "";
      if (item === "Provider") {
        value = draftConfig.provider;
      } else if (item === "Model") {
        value = draftConfig.model || dim("(not set)");
      } else if (item === "API Key") {
        value = maskSecret(draftApiKey);
      } else if (item === "Login") {
        const p = normalizeProviderName(draftConfig.provider);
        if (p === "openai-codex") value = "Browser OAuth";
        else if (p === "openai") value = dim("use API key");
        else if (p === "anthropic") value = "Open console & paste key";
        else if (p === "gemini") value = "Browser OAuth";
        else value = dim("not available");
      } else if (item === "Base URL") {
        value = draftConfig.baseUrl;
      }
      const plainValue = stripAnsi(value) || "";
      return renderListRow(
        theme.key(truncatePlain(item, 16).padEnd(16, " ")),
        plainValue ? theme.muted(truncatePlain(plainValue, 28)) : theme.muted(""),
        46,
        index === settingsIndex
      );
    });

    if (editingField) {
      const label =
        editingField === "apiKey"
          ? providerApiKeyLabel(draftConfig.provider)
          : editingField === "baseUrl"
            ? providerBaseUrlLabel(draftConfig.provider)
            : "Custom model";
      items.splice(
        Math.min(items.length, settingsIndex + 1),
        0,
        `${theme.accent(label)} ${theme.faint("•")} ${theme.panel(editingBuffer || "(empty)")}`
      );
    }

    return renderOverlay(
      "Settings",
      [
        `${theme.key("cwd")} ${theme.muted(truncatePlain(cwd, 46))}`,
        "",
        ...items,
        "",
        theme.muted("Current setup"),
        ...formatConfigSummary(draftConfig).split("\n").map((line) => `${theme.system(line)}`)
      ],
      overlayStatus || "Enter edit · Esc close"
    );
  };

  // Throttled render for streaming
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRender = () => {
    if (!renderTimer) {
      renderTimer = setTimeout(() => {
        renderTimer = null;
        render();
      }, 16);
    }
  };

  const render = () => {
    if (!isActive) {
      return;
    }
    const rows = process.stdout.rows || 30;
    const columns = process.stdout.columns || 100;
    const width = Math.max(20, columns - 4);

    if (mode !== "chat") {
      // Settings: use existing fullscreen overlay
      let frameLines = renderSettingsOverlay();
      while (frameLines.length < rows) frameLines.push("");
      frameLines = frameLines.slice(0, rows);
      process.stdout.write("\x1b[H" + frameLines.map((line) => line + "\x1b[K").join("\n"));
      return;
    }

    // Chat mode: simple transcript layout (intro + messages + prompt)
    // Build the prompt lines (always visible at bottom)
    let promptLines: string[];
    if (isBusy) {
      const rule = theme.border("─".repeat(width));
      const inputLine = `${theme.muted(">")}`;
      const footerRight = theme.muted("esc to interrupt");
      const footer = alignSides(` `, `${footerRight} `, width);
      const ruleBottom = theme.border("─".repeat(width));
      promptLines = [rule, inputLine, ruleBottom, footer];
    } else {
      promptLines = getChatPromptLines();
    }

    // Build transcript: intro + messages
    const transcript: string[] = [];

    // Intro
    const activeConfig = getActiveChatConfig();
    const modelInfo = activeConfig.model
      ? `${activeConfig.provider}/${activeConfig.model}`
      : `${activeConfig.provider}/(not set)`;
    const authStatus = getEffectiveAuthStatus(activeConfig.provider, {
      apiKey: activeConfig.apiKey,
      oauthToken: activeConfig.oauthToken
    });
    transcript.push(
      `${theme.title("Patric")} ${theme.faint("v0.3.0")}`,
      `${theme.muted("cwd")} ${cwd}`,
      `${theme.muted("model")} ${modelInfo}`,
      `${theme.muted("auth")} ${authStatus}`,
      theme.muted("Use /help for commands or /settings to configure."),
      ""
    );

    // Messages
    for (const message of messages) {
      if (message.role === "user") {
        if (transcript.length > 0 && transcript[transcript.length - 1] !== "") {
          transcript.push("");
        }
        const wrapped = wrapText(message.content, Math.max(10, width - 2));
        transcript.push(`${theme.prompt(">")} ${theme.user(wrapped[0] || "")}`);
        for (let i = 1; i < wrapped.length; i++) {
          transcript.push(`  ${theme.user(wrapped[i])}`);
        }
      } else if (message.role === "assistant") {
        const mdLines = renderMarkdown(message.content, Math.max(10, width));
        for (const line of mdLines) transcript.push(line);
        transcript.push("");
      } else if (message.role === "tool" && message.key === "agent-group") {
        const lines = message.content.split("\n");
        const color = message.state === "running" ? theme.muted
          : message.state === "error" ? theme.error : theme.system;
        const icon = message.state === "running" ? theme.muted("⏺")
          : message.state === "error" ? theme.error("⏺") : theme.success("⏺");
        for (let li = 0; li < lines.length; li++) {
          transcript.push(li === 0 ? `${icon} ${color(lines[li])}` : `  ${color(lines[li])}`);
        }
      } else if (message.role === "tool") {
        const icon = message.state === "running" ? theme.muted("⏺")
          : message.state === "error" ? theme.error("⏺") : theme.success("⏺");
        const body = message.state === "error" ? theme.error
          : message.state === "running" ? theme.muted : theme.system;
        for (const line of wrapText(message.content, Math.max(10, width - 3))) {
          transcript.push(`${icon} ${body(line)}`);
        }
        if (message.detail && message.state === "error") {
          for (const line of wrapText(message.detail, Math.max(10, width - 5))) {
            transcript.push(`  ${theme.error(line)}`);
          }
        }
      } else if (message.role === "error" || message.role === "status") {
        const label = message.role === "error" ? theme.error("⏺") : theme.muted("⏺");
        const body = message.role === "error" ? theme.error : theme.system;
        for (const line of wrapText(message.content, Math.max(10, width - 3))) {
          transcript.push(`${label} ${body(line)}`);
        }
      }
    }

    // Show thinking indicator in transcript when busy
    if (isBusy) {
      const frame = spinnerFrames[spinnerFrame % spinnerFrames.length];
      transcript.push("");
      const thinkingLeft = `  ${theme.muted(`${frame} Thinking...`)}`;
      const thinkingRight = activeToolStatus ? theme.muted(activeToolStatus) : "";
      transcript.push(thinkingRight ? alignSides(thinkingLeft, `${thinkingRight} `, width) : thinkingLeft);
    }

    // Remove trailing blanks from transcript
    while (transcript.length > 0 && transcript[transcript.length - 1] === "") {
      transcript.pop();
    }

    // Window transcript into available height (above fixed prompt)
    const availableHeight = Math.max(1, rows - promptLines.length);
    const total = transcript.length;
    const maxScroll = Math.max(0, total - availableHeight);
    scrollOffset = Math.min(scrollOffset, maxScroll);
    const start = Math.max(0, total - availableHeight - scrollOffset);
    const visible = transcript.slice(start, start + availableHeight);

    // Pad to fill available height
    while (visible.length < availableHeight) {
      visible.push("");
    }

    // Append fixed prompt at screen bottom
    visible.push(...promptLines);

    // Write frame
    process.stdout.write(
      "\x1b[H" + visible.slice(0, rows).map((line) => line + "\x1b[K").join("\n")
    );
  };

  const resetInput = () => {
    input = "";
    cursor = 0;
    slashIndex = 0;
    historyIndex = -1;
    savedInput = "";
  };

  const persistDraftSettings = (status: string) => {
    const provider = draftConfig.provider;
    const normalizedProvider = normalizeProviderName(provider);
    const trimmedApiKey = draftApiKey.trim();
    const trimmedOAuthToken = draftOAuthToken.trim();
    const stored = getStoredAuth(provider);
    const wantsApiAuth =
      normalizedProvider === "openai" || normalizedProvider === "anthropic";
    const wantsOAuthAuth = normalizedProvider === "openai-codex";

    if (wantsOAuthAuth) {
      if (trimmedOAuthToken) {
        if (!(stored?.type === "oauth" && stored.access === trimmedOAuthToken)) {
          setStoredOAuthAuth(provider, trimmedOAuthToken);
        }
      } else {
        clearStoredAuth(provider);
      }
    } else if (wantsApiAuth) {
      if (trimmedApiKey) {
        if (!(stored?.type === "api" && stored.key === trimmedApiKey)) {
          setStoredApiAuth(provider, trimmedApiKey);
        }
      } else {
        clearStoredAuth(provider);
      }
    } else if (trimmedOAuthToken) {
      if (!(stored?.type === "oauth" && stored.access === trimmedOAuthToken)) {
        setStoredOAuthAuth(provider, trimmedOAuthToken);
      }
    } else if (trimmedApiKey) {
      if (!(stored?.type === "api" && stored.key === trimmedApiKey)) {
        setStoredApiAuth(provider, trimmedApiKey);
      }
    } else {
      clearStoredAuth(provider);
    }

    config.provider = provider;
    config.model = normalizeModelForProvider(provider, draftConfig.model);
    config.baseUrl = draftConfig.baseUrl;
    config.apiKey = "";
    config.oauthToken = "";
    config.systemPrompt = draftConfig.systemPrompt;
    config.recentModels = { ...draftConfig.recentModels };
    activeModel = config.model;

    draftConfig.model = config.model;
    draftConfig.apiKey = "";
    draftConfig.oauthToken = "";

    saveConfig({
      ...draftConfig,
      apiKey: "",
      oauthToken: "",
      recentModels: { ...draftConfig.recentModels }
    });
    overlayStatus = status;
  };

  const closeSettings = () => {
    const status = overlayStatus;
    mode = "chat";
    editingField = null;
    editingBuffer = "";
    overlayStatus = "";
    if (closeAfterSettings) {
      shouldExit = true;
      return;
    }
    if (status.trim()) {
      messages.push({ role: "status", content: normalizeNewlines(status) });
      scrollOffset = 0;
    }
    render();
  };

  const commitEditingField = () => {
    if (!editingField) {
      return;
    }
    const cacheKey = getModelCacheKey(draftConfig.provider, draftConfig.baseUrl);
    if (editingField === "apiKey") {
      draftApiKey = editingBuffer;
      if (editingBuffer.trim()) {
        draftOAuthToken = "";
      }
      modelOptionsCache.delete(cacheKey);
      persistDraftSettings(`${providerApiKeyLabel(draftConfig.provider)} updated`);
    } else if (editingField === "baseUrl") {
      draftConfig.baseUrl = editingBuffer || getDefaultBaseUrl(draftConfig.provider);
      modelOptionsCache.delete(cacheKey);
      persistDraftSettings(`${providerBaseUrlLabel(draftConfig.provider)} updated`);
    } else {
      draftConfig.model = normalizeModelForProvider(draftConfig.provider, editingBuffer);
      if (draftConfig.model) {
        rememberRecentModel(draftConfig, draftConfig.provider, draftConfig.model);
      }
      persistDraftSettings(`Model set to ${draftConfig.model || "(not set)"}`);
    }
    editingField = null;
    editingBuffer = "";
  };

  const processSlashEnter = () => {
    const suggestions = getSlashSuggestions();
    if (suggestions.length > 0) {
      if (suggestions.some((suggestion) => suggestion.name === input.trim())) {
        return false;
      }
      input = `${suggestions[Math.min(slashIndex, suggestions.length - 1)].name} `;
      cursor = input.length;
      return true;
    }
    return false;
  };

  const runSavedAgent = async (name: string, task: string) => {
    const registry = loadAgentRegistry(cwd);
    const spec = registry.byName.get(name.trim().toLowerCase());
    if (!spec) {
      addMessage("error", `Unknown agent: ${name}`);
      return;
    }

    const allowedToolNames = getEffectiveAgentToolNames(
      spec,
      getAllToolNames().filter((toolName) => !AGENT_TOOL_NAMES.includes(toolName as any))
    );
    const runtimeConfig: PatricConfig = {
      ...getActiveChatConfig(),
      model: resolveAgentModel(getActiveChatConfig(), spec)
    };

    isBusy = true;
    addMessage("status", `Running agent ${spec.name}`);
    render();
    startSpinner();

    let liveAssistantMessage: Message | null = null;
    let streamedAssistantOutput = false;
    const ensureAssistantMessage = () => {
      if (!liveAssistantMessage) {
        liveAssistantMessage = { role: "assistant", content: "" };
        messages.push(liveAssistantMessage);
      }
      return liveAssistantMessage;
    };

    abortController = new AbortController();
    const result = await streamCompletion(
      runtimeConfig,
      [
        { role: "system", content: buildAgentSystemPrompt(runtimeConfig.systemPrompt, spec) },
        { role: "user", content: buildAgentTaskPrompt(task) }
      ],
      (chunk) => {
        if (!streamedAssistantOutput) {
          stopSpinner();
        }
        ensureAssistantMessage().content += chunk;
        scheduleRender();
        streamedAssistantOutput = true;
      },
      (event) => {
        if (event.type === "tool_start") {
          liveAssistantMessage = null;
        }
        handleToolEvent(event);
      },
      abortController.signal,
      {
        allowedToolNames,
        agentRegistry: registry,
        agent: { kind: "sub-agent", name: spec.name }
      }
    );
    abortController = null;
    stopSpinner();
    isBusy = false;
    activeToolStatus = "";

    if (streamedAssistantOutput) {
      render();
    }

    if (!result.ok) {
      if (!liveAssistantMessage) {
        liveAssistantMessage = { role: "error", content: result.content };
        messages.push(liveAssistantMessage);
      } else {
        liveAssistantMessage.role = "error";
        liveAssistantMessage.content = result.content;
        if (!streamedAssistantOutput) {
        }
      }
      return;
    }

    if (!liveAssistantMessage && result.content) {
      liveAssistantMessage = { role: "assistant", content: result.content };
      messages.push(liveAssistantMessage);
    }
  };

  const runCommand = async (raw: string) => {
    const command = raw.trim();
    if (!command) {
      return;
    }

    if (command === "/help") {
      addMessage(
        "status",
        [
          "Patric commands",
          "/help, /pwd, /cd, /ls, /read, /write, /exec, /repo, /context, /agents, /agent run <name> <prompt>, /patch, /apply, /settings, /model, /exit"
        ].join("\n")
      );
      return;
    }
    if (command === "/pwd") {
      addMessage("status", cwd);
      return;
    }
    if (command.startsWith("/cd ")) {
      cwd = path.resolve(cwd, command.slice(4).trim());
      process.chdir(cwd);
      addMessage("status", cwd);
      return;
    }
    if (command === "/ls" || command.startsWith("/ls ")) {
      const target = command === "/ls" ? "" : command.slice(4).trim();
      addMessage("status", listDir(target, cwd).join("\n"));
      return;
    }
    if (command.startsWith("/read ")) {
      const result = readFileSafe(command.slice(6).trim(), cwd);
      addMessage("status", `# ${result.fullPath}\n${result.content}`);
      return;
    }
    if (command.startsWith("/write ")) {
      const parts = command.slice(7).trim().split(" ");
      const target = parts.shift();
      const content = parts.join(" ");
      if (!target) {
        addMessage("error", "Usage: /write <file> <text>");
        return;
      }
      const filePath = writeFileSafe(target, content, cwd);
      addMessage("status", `Wrote ${filePath}`);
      return;
    }
    if (command.startsWith("/exec ")) {
      addMessage("status", execCommand(command.slice(6).trim(), cwd));
      return;
    }
    if (command === "/repo") {
      const info = getRepoInfo(cwd);
      if (!info.isGitRepo) {
        addMessage("status", `Repository root: ${cwd}\nGit: not detected`);
        return;
      }
      addMessage(
        "status",
        [
          `Repository root: ${info.root}`,
          `Branch: ${info.branch}`,
          `Changed files: ${info.status.length}`,
          info.status.length ? `Status:\n${info.status.slice(0, 20).join("\n")}` : "Status: clean"
        ].join("\n")
      );
      return;
    }
    if (command === "/context" || command.startsWith("/context ")) {
      const targets = command === "/context" ? [] : command.slice(9).trim().split(/\s+/).filter(Boolean);
      addMessage("status", collectContext(cwd, targets));
      return;
    }
    if (command === "/agents") {
      addMessage("status", formatAgentList(loadAgentRegistry(cwd)));
      return;
    }
    if (command.startsWith("/agent run ")) {
      const rest = command.slice(11).trim();
      const firstSpace = rest.indexOf(" ");
      if (firstSpace === -1) {
        addMessage("error", "Usage: /agent run <name> <prompt>");
        return;
      }
      const name = rest.slice(0, firstSpace).trim();
      const task = rest.slice(firstSpace + 1).trim();
      if (!name || !task) {
        addMessage("error", "Usage: /agent run <name> <prompt>");
        return;
      }
      await runSavedAgent(name, task);
      return;
    }
    if (command.startsWith("/patch ")) {
      isBusy = true;
      render();
      startSpinner();
      const result = await generatePatch({ ...config, model: activeModel }, cwd, command.slice(7).trim(), true);
      stopSpinner();
      isBusy = false;
      addMessage(result.ok ? "status" : "error", result.ok ? `Saved patch: ${result.patchPath}` : result.content);
      return;
    }
    if (command.startsWith("/apply ")) {
      const result = applyPatch(cwd, command.slice(7).trim());
      addMessage("status", `Applied patch: ${result.patchFile}`);
      return;
    }
    if (command === "/settings") {
      openSettingsScreen();
      return;
    }
    if (command === "/model") {
      addMessage("status", activeModel || "(not set)");
      return;
    }
    if (command.startsWith("/model ")) {
      activeModel = normalizeModelForProvider(config.provider, command.slice(7).trim());
      draftConfig.model = activeModel;
      rememberRecentModel(draftConfig, draftConfig.provider, activeModel);
      addMessage("status", `Model set to ${activeModel}`);
      return;
    }
    if (command === "/exit") {
      shouldExit = true;
      return;
    }

    const turnStartIndex = messages.length;
    agentRuns.clear();
    isBusy = true;
    messages.push({ role: "user", content: normalizeNewlines(command) });
    scrollOffset = 0;
    startSpinner();
    let liveAssistantMessage: Message | null = null;
    let streamedAssistantOutput = false;
    const ensureAssistantMessage = () => {
      if (!liveAssistantMessage) {
        liveAssistantMessage = { role: "assistant", content: "" };
        messages.push(liveAssistantMessage);
      }
      return liveAssistantMessage;
    };
    const getTurnAssistantReply = () =>
      messages
        .slice(turnStartIndex)
        .filter((message) => message.role === "assistant" && message.content.trim())
        .map((message) => message.content)
        .join("\n\n");
    const runtimeConfig = getActiveChatConfig();
    llmMessages.push({ role: "user", content: command });
    abortController = new AbortController();
    const result = await streamCompletion(runtimeConfig, llmMessages, (chunk) => {
      if (!streamedAssistantOutput) stopSpinner();
      ensureAssistantMessage().content += chunk;
      scheduleRender();
      streamedAssistantOutput = true;
    }, (event) => {
      if (event.type === "tool_start") {
        liveAssistantMessage = null;
      }
      handleToolEvent(event);
    }, abortController.signal);
    abortController = null;
    stopSpinner();
    isBusy = false;
    activeToolStatus = "";
    if (streamedAssistantOutput) {
      render();
    }
    if (!result.ok) {
      if (!liveAssistantMessage) {
        liveAssistantMessage = { role: "error", content: result.content };
        messages.push(liveAssistantMessage);
      } else {
        liveAssistantMessage.role = "error";
        liveAssistantMessage.content = result.content;
      }
    } else {
      const assistantReply = getTurnAssistantReply();
      if (!assistantReply && !liveAssistantMessage && result.content) {
        liveAssistantMessage = { role: "assistant", content: result.content };
        messages.push(liveAssistantMessage);
      }
      const historyReply = getTurnAssistantReply();
      if (historyReply) {
        llmMessages.push({ role: "assistant", content: historyReply });
      }
    }
    render();
  };

  const handleSettingsKey = async (inputKey: string) => {
    if (editingField) {
      if (inputKey === "\r") {
        commitEditingField();
      } else if (inputKey === "\u001b") {
        editingField = null;
        editingBuffer = "";
      } else if (inputKey === "\x7f") {
        editingBuffer = editingBuffer.slice(0, -1);
      } else if (inputKey.length === 1 && isPrintable(inputKey)) {
        editingBuffer += inputKey;
      }
      return;
    }

    if (inputKey === "\u001b") {
      if (mode === "settings") {
        closeSettings();
      } else {
        mode = "settings";
      }
      return;
    }
    if (inputKey === "?") {
      overlayStatus = "Arrows move · Enter select · Esc close";
      return;
    }
    if (inputKey === "q" && mode === "settings") {
      closeSettings();
      return;
    }
    if (inputKey === "\u001b[A") {
      if (mode === "settings") {
        const settingsItems = getSettingsItems();
        settingsIndex = (settingsIndex - 1 + settingsItems.length) % settingsItems.length;
      } else {
        const items = mode === "provider-picker" ? PROVIDERS.length : getDraftModelOptions().length;
        pickerIndex = (pickerIndex - 1 + items) % items;
      }
      return;
    }
    if (inputKey === "\u001b[B") {
      if (mode === "settings") {
        const settingsItems = getSettingsItems();
        settingsIndex = (settingsIndex + 1) % settingsItems.length;
      } else {
        const items = mode === "provider-picker" ? PROVIDERS.length : getDraftModelOptions().length;
        pickerIndex = (pickerIndex + 1) % items;
      }
      return;
    }
    if (inputKey !== "\r") {
      return;
    }

    if (mode === "provider-picker") {
      draftConfig.provider = PROVIDERS[pickerIndex];
      draftConfig.baseUrl = getDefaultBaseUrl(draftConfig.provider);
      draftConfig.model = "";
      syncDraftAuth(draftConfig.provider);
      settingsIndex = Math.min(settingsIndex, getSettingsItems().length - 1);
      persistDraftSettings(`Using ${draftConfig.provider}`);
      mode = "settings";
      return;
    }
    if (mode === "model-picker") {
      const options = getDraftModelOptions();
      const selected = options[pickerIndex];
      if (selected === "Custom model...") {
        editingField = "customModel";
        editingBuffer = draftConfig.model;
      } else {
        draftConfig.model = selected;
        rememberRecentModel(draftConfig, draftConfig.provider, draftConfig.model);
        persistDraftSettings(`Model set to ${draftConfig.model}`);
      }
      mode = "settings";
      return;
    }

    const settingsItems = getSettingsItems();
    const item = settingsItems[settingsIndex];
    if (item === "Provider") {
      pickerIndex = PROVIDERS.indexOf(normalizeProviderName(draftConfig.provider));
      mode = "provider-picker";
      return;
    }
    if (item === "Model") {
      const options = getDraftModelOptions();
      pickerIndex = Math.max(0, options.indexOf(draftConfig.model));
      mode = "model-picker";
      void refreshModelOptions();
      return;
    }
    if (item === "API Key") {
      editingField = "apiKey";
      editingBuffer = draftApiKey;
      return;
    }
    if (item === "Login") {
      const p = normalizeProviderName(draftConfig.provider);
      if (p === "openai-codex") {
        overlayStatus = "Waiting for browser login...";
        render();
        try {
          await loginWithOpenAIOAuth({
            provider: "openai-codex",
            onAuthUrl: (_url, opened) => {
              overlayStatus = opened
                ? "Opened browser — complete login there..."
                : `Open this URL: ${_url}`;
              render();
            }
          });
          const stored = getStoredAuth("openai-codex");
          if (stored?.type === "api") {
            draftApiKey = stored.key;
            draftOAuthToken = "";
          } else if (stored?.type === "oauth") {
            draftOAuthToken = stored.access;
            draftApiKey = "";
          }
          modelOptionsCache.delete(getModelCacheKey(draftConfig.provider, draftConfig.baseUrl));
          persistDraftSettings("OpenAI Codex login successful");
        } catch (err: unknown) {
          overlayStatus = `Login failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        return;
      }
      if (p === "openai") {
        overlayStatus = "Direct OpenAI uses API keys. Switch provider to openai-codex for browser OAuth.";
        return;
      }
      if (p === "anthropic") {
        await openBrowser(ANTHROPIC_KEYS_URL);
        overlayStatus = "Opened browser — paste your API key below";
        editingField = "apiKey";
        editingBuffer = draftApiKey;
        return;
      }
      if (p === "gemini") {
        overlayStatus = "Gemini requires --client-file. Use CLI: patric auth login gemini";
        return;
      }
      overlayStatus = `Browser login not available for ${p}. Use API Key field.`;
      return;
    }
    if (item === "Base URL") {
      editingField = "baseUrl";
      editingBuffer = draftConfig.baseUrl;
      return;
    }
  };

  const handleChatKey = async (inputKey: string) => {
    const suggestions = getSlashSuggestions();
    if (inputKey === "\u0003") {
      shouldExit = true;
      return;
    }
    if (isBusy) {
      if (inputKey === "\u001b" && abortController) {
        abortController.abort();
      }
      return;
    }
    // Shift+Up / Shift+Down — scroll by one line
    if (inputKey === "\u001b[1;2A") {
      scrollOffset += 1;
      return;
    }
    if (inputKey === "\u001b[1;2B") {
      scrollOffset = Math.max(0, scrollOffset - 1);
      return;
    }
    // Page Up / Page Down — scroll by half a screen
    if (inputKey === "\u001b[5~") {
      const rows = process.stdout.rows || 24;
      scrollOffset += Math.max(1, Math.floor(rows / 2));
      return;
    }
    if (inputKey === "\u001b[6~") {
      const rows = process.stdout.rows || 24;
      scrollOffset = Math.max(0, scrollOffset - Math.max(1, Math.floor(rows / 2)));
      return;
    }
    if (inputKey === "\u001b[A") {
      if (suggestions.length > 0) {
        slashIndex = (slashIndex - 1 + suggestions.length) % suggestions.length;
      } else if (promptHistory.length > 0) {
        if (historyIndex === -1) {
          savedInput = input;
          historyIndex = promptHistory.length - 1;
        } else if (historyIndex > 0) {
          historyIndex--;
        }
        input = promptHistory[historyIndex];
        cursor = input.length;
      }
      return;
    }
    if (inputKey === "\u001b[B") {
      if (suggestions.length > 0) {
        slashIndex = (slashIndex + 1) % suggestions.length;
      } else if (historyIndex !== -1) {
        historyIndex++;
        if (historyIndex >= promptHistory.length) {
          input = savedInput;
          historyIndex = -1;
        } else {
          input = promptHistory[historyIndex];
        }
        cursor = input.length;
      }
      return;
    }
    if (inputKey === "\u001b[D") {
      cursor = Math.max(0, cursor - 1);
      return;
    }
    if (inputKey === "\u001b[C") {
      cursor = Math.min(input.length, cursor + 1);
      return;
    }
    if (inputKey === "\x7f") {
      if (cursor > 0) {
        input = `${input.slice(0, cursor - 1)}${input.slice(cursor)}`;
        cursor -= 1;
      }
      return;
    }
    if (inputKey === "\t" && suggestions.length > 0) {
      const suggestion = suggestions[Math.min(slashIndex, suggestions.length - 1)];
      input = `${suggestion.name} `;
      cursor = input.length;
      return;
    }
    if (inputKey === "\r" || inputKey === "\n") {
      if (suggestions.length > 0 && input.startsWith("/")) {
        if (processSlashEnter()) {
          return;
        }
      }
      const command = input;
      if (command.trim()) {
        promptHistory.push(command);
        appendHistory(command);
      }
      resetInput();
      await runCommand(command);
      return;
    }
    if (inputKey.length === 1 && isPrintable(inputKey)) {
      input = `${input.slice(0, cursor)}${inputKey}${input.slice(cursor)}`;
      cursor += 1;
      slashIndex = 0;
    }
  };

  const onData = async (chunk: Buffer) => {
    if (!isActive || isBusy && mode === "settings") {
      return;
    }
    const raw = chunk.toString("utf8");
    // Handle SGR mouse wheel events: \x1b[<btn;col;rowM
    // btn 64 = wheel up, btn 65 = wheel down
    const mouseMatch = raw.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
    if (mouseMatch) {
      const btn = parseInt(mouseMatch[1], 10);
      if (btn === 64) { // wheel up
        scrollOffset += 3;
        render();
        return;
      }
      if (btn === 65) { // wheel down
        scrollOffset = Math.max(0, scrollOffset - 3);
        render();
        return;
      }
      return; // ignore other mouse events
    }
    const events = splitInputSequence(raw);
    for (const value of events) {
      if (mode === "chat") {
        await handleChatKey(value);
      } else {
        await handleSettingsKey(value);
      }
      if (shouldExit) {
        cleanup();
        return;
      }
    }
    render();
  };

  const cleanup = () => {
    if (!isActive) {
      return;
    }
    isActive = false;
    stopSpinner();
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    closeBrowser().catch(() => {});
    process.stdin.off("data", onData);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    // Disable mouse tracking, show cursor, leave alt-screen
    process.stdout.write("\x1b[?1006l\x1b[?1000l");
    setCursorHidden(false);
    leaveAltScreen();
    process.stdout.write("\x1b[2mGoodbye.\x1b[0m\n");
  };

  // Enter alt-screen, hide cursor, enable SGR mouse tracking
  process.stdout.write("\x1b[?1049h");
  setCursorHidden(true);
  process.stdout.write("\x1b[?1000h\x1b[?1006h");
  isInAltScreen = true;
  introPrinted = true; // skip inline intro since we use fullscreen renderChatFrame
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onData);
  render();
}
