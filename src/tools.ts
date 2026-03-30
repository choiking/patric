import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentManager, AgentRunStatus } from "./agents";
import { executeBrowserAction } from "./browser";

// ---------------------------------------------------------------------------
// Safety utilities
// ---------------------------------------------------------------------------

const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Resolve a path relative to cwd and ensure it does not escape the working directory.
 */
function safePath(targetPath: string): string {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, targetPath);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new Error(
      `Path "${targetPath}" resolves outside the working directory. Operation refused.`
    );
  }
  return resolved;
}

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s+(-[^\s]*\s+)*-[^\s]*r[^\s]*\s+\/\s*$/, label: "rm -rf /" },
  { pattern: /\brm\s+(-[^\s]*\s+)*-[^\s]*r[^\s]*\s+~\s*$/, label: "rm -rf ~" },
  { pattern: /\bmkfs\b/i, label: "mkfs (format disk)" },
  { pattern: /\bdd\s.*\bof=\/dev\//i, label: "dd to device" },
  { pattern: />\s*\/dev\/[sh]d[a-z]/i, label: "write to raw device" },
  { pattern: /:()\s*\{\s*:\|\s*:&\s*\}\s*;?\s*:/, label: "fork bomb" },
];

function checkDangerousCommand(command: string): string | null {
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return label;
  }
  return null;
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return output.slice(0, MAX_OUTPUT_CHARS) + "\n\n... [output truncated at 30,000 chars]";
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  ok: boolean;
}

export interface ToolEvent {
  type: "tool_start" | "tool_end" | "tool_round_complete" | "agent_status" | "agent_tool_start" | "agent_tool_end";
  name: string;
  arguments?: Record<string, any>;
  result?: string;
  agentId?: string;
  agentName?: string;
  agentState?: AgentRunStatus["state"];
  detail?: string;
}

export const MAX_TOOL_ROUNDS = 20;

export interface ToolExecutionContext {
  allowedToolNames?: string[];
  agentManager?: AgentManager;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

type ProviderName = "openai" | "openai-codex" | "openrouter" | "anthropic" | "ollama" | "gemini";

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "web_search",
    description:
      "Search the web for current information using DuckDuckGo and Wikipedia. Good for general knowledge queries. For live cryptocurrency prices, use fetch_url with https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd (replace 'bitcoin' with the coin id). For other real-time data, prefer fetch_url with a specific API or website URL.",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The search query" }
      },
      required: ["query"]
    }
  },
  {
    name: "fetch_url",
    description:
      "Fetch content from a URL. Works with web pages (returns stripped text) and JSON APIs (returns raw JSON). Use for reading articles, documentation, or calling public APIs like CoinGecko, Wikipedia, weather services, etc.",
    parameters: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to fetch" }
      },
      required: ["url"]
    }
  },
  {
    name: "bash",
    description:
      "Execute a shell command in the working directory. Use for git, npm, build tools, " +
      "running scripts, etc. Output is captured and returned. Commands time out after 2 minutes. " +
      "Very long output is truncated to ~30,000 characters.",
    parameters: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        timeout: { type: "number", description: "Optional timeout in milliseconds (default 120000, max 600000)" }
      },
      required: ["command"]
    }
  },
  {
    name: "read_file",
    description:
      "Read the contents of a file. Path is relative to the working directory. " +
      "Returns numbered lines. Use offset/limit for large files.",
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path (relative to working directory)" },
        offset: { type: "number", description: "Optional 1-based starting line number" },
        limit: { type: "number", description: "Optional max number of lines to read" }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description:
      "Write content to a file. Creates the file and parent directories if needed, " +
      "overwrites if it exists. Path is relative to the working directory.",
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path (relative to working directory)" },
        content: { type: "string", description: "The full content to write" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "edit_file",
    description:
      "Find-and-replace in a file. Finds the first occurrence of old_string and replaces " +
      "it with new_string. The old_string must match exactly including whitespace and indentation. " +
      "Path is relative to the working directory.",
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path (relative to working directory)" },
        old_string: { type: "string", description: "The exact string to find" },
        new_string: { type: "string", description: "The replacement string" }
      },
      required: ["path", "old_string", "new_string"]
    }
  },
  {
    name: "glob",
    description:
      "Find files matching a glob pattern in the working directory. " +
      "Returns matching paths sorted by modification time. " +
      "Examples: '**/*.ts', 'src/**/*.test.ts', '*.json'.",
    parameters: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Glob pattern to match files" },
        path: { type: "string", description: "Optional subdirectory to search in" }
      },
      required: ["pattern"]
    }
  },
  {
    name: "grep",
    description:
      "Search file contents using a regex pattern. Returns matching lines with file paths " +
      "and line numbers. Uses ripgrep if available, falls back to grep.",
    parameters: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Optional file or directory to search in" },
        include: { type: "string", description: "Optional file glob filter (e.g. '*.ts')" }
      },
      required: ["pattern"]
    }
  },
  {
    name: "list_directory",
    description:
      "List directory contents with type indicators (/ for directories, @ for symlinks). " +
      "Path is relative to the working directory.",
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Directory path (defaults to '.')" }
      },
      required: []
    }
  },
  {
    name: "open_file",
    description:
      "Open a file with the system default application (e.g. images in Preview, " +
      "code in an editor, PDFs in a reader). Path is relative to the working directory.",
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path (relative to working directory)" }
      },
      required: ["path"]
    }
  },
  {
    name: "browser",
    description:
      "Control a browser to navigate web pages, interact with elements, and extract content. " +
      "Workflow: (1) 'navigate' to a URL, (2) 'snapshot' to see the page's interactive elements as numbered refs, " +
      "(3) use 'click', 'type', 'select' with ref numbers to interact. " +
      "Actions: navigate, snapshot, screenshot, click, type, select, check, uncheck, " +
      "evaluate, wait, text, tab_list, tab_new, tab_switch, tab_close, download, back, forward, reload, close.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          description:
            "The browser action to perform. One of: " +
            "navigate (go to URL), snapshot (get page structure with numbered refs), " +
            "screenshot (capture page image), click (click element by ref), " +
            "type (type text into element by ref), select (select option by ref), " +
            "check (check checkbox by ref), uncheck (uncheck checkbox by ref), " +
            "evaluate (run JavaScript), wait (wait for selector/text/time), " +
            "text (get page text content), " +
            "tab_list (list open tabs), tab_new (open new tab), " +
            "tab_switch (switch to tab by index), tab_close (close current tab), " +
            "download (download a file from URL), " +
            "back (go back), forward (go forward), reload (reload page), " +
            "close (close the browser)"
        },
        url: { type: "string", description: "URL for 'navigate', 'tab_new', or 'download' actions" },
        ref: { type: "number", description: "Element reference number from a snapshot (for click, type, select, check, uncheck)" },
        text: { type: "string", description: "Text to type (for 'type' action), option value (for 'select'), or text to wait for (for 'wait')" },
        expression: { type: "string", description: "JavaScript expression (for 'evaluate' action)" },
        selector: { type: "string", description: "CSS selector (for 'wait' action)" },
        timeout: { type: "number", description: "Timeout in milliseconds (for 'wait' action, default 10000)" },
        tab_index: { type: "number", description: "Tab index for 'tab_switch' (0-based)" }
      },
      required: ["action"]
    }
  },
  {
    name: "spawn_agent",
    description:
      "Spawn a sub-agent to handle a delegated task. Sub-agents run concurrently — " +
      "spawn multiple agents in parallel for independent subtasks (e.g., searching different repos, " +
      "analyzing different files). Each agent gets its own context and tools. " +
      "After spawning, use wait_agent to collect results.",
    parameters: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Saved sub-agent name" },
        task: { type: "string", description: "The delegated task for that sub-agent" }
      },
      required: ["name", "task"]
    }
  },
  {
    name: "wait_agent",
    description:
      "Wait for a running Patric sub-agent to finish and return its result. Only available to the top-level agent.",
    parameters: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string", description: "The sub-agent run id returned by spawn_agent" }
      },
      required: ["agent_id"]
    }
  },
  {
    name: "list_agents",
    description:
      "List saved sub-agents and any active/completed sub-agent runs. Only available to the top-level agent.",
    parameters: {
      type: "object" as const,
      properties: {},
      required: []
    }
  },
  {
    name: "cancel_agent",
    description:
      "Cancel a running Patric sub-agent by id. Only available to the top-level agent.",
    parameters: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string", description: "The sub-agent run id to cancel" }
      },
      required: ["agent_id"]
    }
  }
];

export function getAllToolNames(): string[] {
  return TOOL_DEFINITIONS.map((tool) => tool.name);
}

export const AGENT_TOOL_NAMES = ["spawn_agent", "wait_agent", "list_agents", "cancel_agent"] as const;

function getFilteredToolDefinitions(allowedToolNames?: string[]): ToolDefinition[] {
  if (!allowedToolNames || allowedToolNames.length === 0) {
    return TOOL_DEFINITIONS;
  }
  const allowed = new Set(allowedToolNames);
  return TOOL_DEFINITIONS.filter((tool) => allowed.has(tool.name));
}

export function getToolsForOpenAI(): object[] {
  return TOOL_DEFINITIONS.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

function getToolsForOpenAIResponses(): object[] {
  return TOOL_DEFINITIONS.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

function getToolsForAnthropic(): object[] {
  return TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }));
}

function getToolsForGemini(): object[] {
  return [
    {
      functionDeclarations: TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }))
    }
  ];
}

export function getToolsForProvider(provider: ProviderName, allowedToolNames?: string[]): object[] {
  const filtered = getFilteredToolDefinitions(allowedToolNames);
  switch (provider) {
    case "anthropic":
      return filtered.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters
      }));
    case "gemini":
      return [
        {
          functionDeclarations: filtered.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }))
        }
      ];
    case "openai-codex":
      return filtered.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }));
    case "openai":
    case "openrouter":
    case "ollama":
    default:
      return filtered.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }));
  }
}

function formatAgentRun(status: AgentRunStatus): string {
  const header = `${status.id} ${status.name} [${status.state}]`;
  const task = `Task: ${status.task}`;
  if (status.state === "done") {
    return `${header}\n${task}\n\n${status.result || "(no result)"}`;
  }
  if (status.state === "error") {
    return `${header}\n${task}\n\n${status.error || "Agent failed."}`;
  }
  return `${header}\n${task}`;
}

function requireAgentManager(context?: ToolExecutionContext): AgentManager {
  if (!context?.agentManager) {
    throw new Error("Sub-agent runtime is not available in this context.");
  }
  return context.agentManager;
}

function executeSpawnAgent(name: string, task: string, context?: ToolExecutionContext): string {
  const manager = requireAgentManager(context);
  const status = manager.spawn(name, task);
  return `Spawned agent ${status.name} with id ${status.id}.`;
}

async function executeWaitAgent(agentId: string, context?: ToolExecutionContext): Promise<string> {
  const manager = requireAgentManager(context);
  const status = await manager.wait(agentId);
  return formatAgentRun(status);
}

function executeListAgents(context?: ToolExecutionContext): string {
  const manager = requireAgentManager(context);
  const available = manager.listAvailableAgents();
  const runs = manager.listRuns();
  const parts: string[] = [];

  if (available.length === 0) {
    parts.push("Available agents:\n(none)");
  } else {
    parts.push(
      [
        "Available agents:",
        ...available.map((spec) => `- ${spec.name} [${spec.scope}]: ${spec.description}`)
      ].join("\n")
    );
  }

  if (runs.length === 0) {
    parts.push("Agent runs:\n(none)");
  } else {
    parts.push(
      [
        "Agent runs:",
        ...runs.map((status) => `- ${status.id} ${status.name} [${status.state}] ${status.task}`)
      ].join("\n")
    );
  }

  return parts.join("\n\n");
}

function executeCancelAgent(agentId: string, context?: ToolExecutionContext): string {
  const manager = requireAgentManager(context);
  const status = manager.cancel(agentId);
  return `Cancelled agent ${status.name} (${status.id}).`;
}

export async function executeTool(
  call: ToolCall,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  try {
    if (context?.allowedToolNames && !context.allowedToolNames.includes(call.name)) {
      throw new Error(`Tool not allowed in this context: ${call.name}`);
    }

    let content: string;
    switch (call.name) {
      case "web_search":
        content = await executeWebSearch(call.arguments.query || "");
        break;
      case "fetch_url":
        content = await executeFetchUrl(call.arguments.url || "");
        break;
      case "bash":
        content = await executeBash(call.arguments.command || "", call.arguments.timeout);
        break;
      case "read_file":
        content = executeReadFile(call.arguments.path || "", call.arguments.offset, call.arguments.limit);
        break;
      case "write_file":
        content = executeWriteFile(call.arguments.path || "", call.arguments.content || "");
        break;
      case "edit_file":
        content = executeEditFile(call.arguments.path || "", call.arguments.old_string || "", call.arguments.new_string ?? "");
        break;
      case "glob":
        content = await executeGlob(call.arguments.pattern || "", call.arguments.path);
        break;
      case "grep":
        content = await executeGrep(call.arguments.pattern || "", call.arguments.path, call.arguments.include);
        break;
      case "list_directory":
        content = executeListDirectory(call.arguments.path);
        break;
      case "open_file":
        content = await executeOpenFile(call.arguments.path || "");
        break;
      case "browser":
        content = await executeBrowserAction(call.arguments);
        break;
      case "spawn_agent":
        content = executeSpawnAgent(call.arguments.name || "", call.arguments.task || "", context);
        break;
      case "wait_agent":
        content = await executeWaitAgent(call.arguments.agent_id || "", context);
        break;
      case "list_agents":
        content = executeListAgents(context);
        break;
      case "cancel_agent":
        content = executeCancelAgent(call.arguments.agent_id || "", context);
        break;
      default:
        content = `Unknown tool: ${call.name}`;
    }
    return { callId: call.id, name: call.name, content, ok: true };
  } catch (error: any) {
    return {
      callId: call.id,
      name: call.name,
      content: `Tool error: ${error.message || String(error)}`,
      ok: false
    };
  }
}

function stripHtml(html: string): string {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/\s+/g, " ");
  return text.trim();
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, ms = 10000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function searchDuckDuckGoApi(query: string): Promise<string> {
  const response = await fetchWithTimeout(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
  );
  if (!response.ok) return "";

  const data = await response.json();
  const parts: string[] = [];

  if (data.AbstractText) {
    parts.push(`Summary: ${data.AbstractText}`);
    if (data.AbstractURL) parts.push(`Source: ${data.AbstractURL}`);
  }

  if (data.Answer) {
    parts.push(`Answer: ${data.Answer}`);
  }

  if (Array.isArray(data.RelatedTopics)) {
    const topics = data.RelatedTopics
      .filter((t: any) => t.Text)
      .slice(0, 5)
      .map((t: any) => `- ${t.Text}${t.FirstURL ? ` (${t.FirstURL})` : ""}`);
    if (topics.length > 0) {
      parts.push(`Related:\n${topics.join("\n")}`);
    }
  }

  if (Array.isArray(data.Results)) {
    for (const r of data.Results.slice(0, 3)) {
      if (r.Text) parts.push(`- ${r.Text}${r.FirstURL ? ` (${r.FirstURL})` : ""}`);
    }
  }

  return parts.join("\n\n");
}

async function searchWikipedia(query: string): Promise<string> {
  const response = await fetchWithTimeout(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srinfo=totalhits&srprop=snippet&srlimit=3&format=json`
  );
  if (!response.ok) return "";

  const data = await response.json();
  const results = data.query?.search;
  if (!Array.isArray(results) || results.length === 0) return "";

  return results
    .map((r: any) => {
      const snippet = stripHtml(r.snippet || "");
      return `- ${r.title}: ${snippet}\n  https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`;
    })
    .join("\n");
}

async function executeWebSearch(query: string): Promise<string> {
  if (!query.trim()) {
    return "Error: empty search query";
  }

  const parts: string[] = [];

  // Strategy 1: DuckDuckGo Instant Answer API
  try {
    const ddg = await searchDuckDuckGoApi(query);
    if (ddg) parts.push(ddg);
  } catch {}

  // Strategy 2: Wikipedia search
  try {
    const wiki = await searchWikipedia(query);
    if (wiki) parts.push(`Wikipedia results:\n${wiki}`);
  } catch {}

  if (parts.length === 0) {
    return `No results found for "${query}". Try using fetch_url to access a specific website directly (e.g., fetch_url with https://www.google.com/search?q=${encodeURIComponent(query)} or a relevant site).`;
  }

  return parts.join("\n\n---\n\n");
}

async function executeFetchUrl(url: string): Promise<string> {
  if (!url.trim()) {
    return "Error: empty URL";
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; Patric/0.3)"
      },
      signal: controller.signal,
      redirect: "follow"
    });

    if (!response.ok) {
      return `Fetch failed (${response.status}): ${url}`;
    }

    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();

    if (contentType.includes("html")) {
      const cleaned = stripHtml(text);
      return cleaned.length > 8000 ? `${cleaned.slice(0, 8000)}...` : cleaned;
    }

    return text.length > 8000 ? `${text.slice(0, 8000)}...` : text;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Shell tool execution functions
// ---------------------------------------------------------------------------

async function executeBash(command: string, timeoutMs?: number): Promise<string> {
  if (!command.trim()) return "Error: empty command";

  const dangerLabel = checkDangerousCommand(command);
  if (dangerLabel) {
    return `Error: Command blocked for safety (${dangerLabel}). Ask the user to run it manually if needed.`;
  }

  const timeout = Math.min(Math.max(timeoutMs || DEFAULT_TIMEOUT_MS, 1000), 600_000);

  return new Promise<string>((resolve) => {
    const proc = spawn("bash", ["-c", command], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000);
    }, timeout);

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += (output ? "\n" : "") + stderr;
      output = truncateOutput(output);

      if (timedOut) {
        resolve(`Command timed out after ${timeout}ms.\n${output}`);
      } else if (code !== 0) {
        resolve(`Command exited with code ${code}.\n${output}`);
      } else {
        resolve(output || "(no output)");
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve(`Error spawning command: ${err.message}`);
    });
  });
}

function executeReadFile(filePath: string, offset?: number, limit?: number): string {
  if (!filePath.trim()) return "Error: empty file path";
  const fullPath = safePath(filePath);
  if (!fs.existsSync(fullPath)) return `Error: file not found: ${filePath}`;
  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) return `Error: not a file: ${filePath}`;

  const content = fs.readFileSync(fullPath, "utf8");
  const lines = content.split("\n");
  const startLine = offset ? Math.max(1, offset) : 1;
  const endLine = limit ? startLine + limit - 1 : lines.length;
  const selected = lines.slice(startLine - 1, endLine);
  const numbered = selected.map((line, i) =>
    `${String(startLine + i).padStart(6, " ")}  ${line}`
  );
  return truncateOutput(numbered.join("\n"));
}

function executeWriteFile(filePath: string, content: string): string {
  if (!filePath.trim()) return "Error: empty file path";
  const fullPath = safePath(filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
  return `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${filePath}`;
}

function executeEditFile(filePath: string, oldString: string, newString: string): string {
  if (!filePath.trim()) return "Error: empty file path";
  if (!oldString) return "Error: old_string cannot be empty";
  const fullPath = safePath(filePath);
  if (!fs.existsSync(fullPath)) return `Error: file not found: ${filePath}`;

  const content = fs.readFileSync(fullPath, "utf8");
  const index = content.indexOf(oldString);
  if (index === -1) {
    const preview = content.slice(0, 200);
    return (
      `Error: old_string not found in ${filePath}. ` +
      `Make sure it matches exactly (including whitespace). ` +
      `File starts with:\n${preview}...`
    );
  }

  const secondIndex = content.indexOf(oldString, index + oldString.length);
  const note = secondIndex !== -1
    ? " Note: multiple occurrences found; only the first was replaced."
    : "";

  const updated = content.slice(0, index) + newString + content.slice(index + oldString.length);
  fs.writeFileSync(fullPath, updated, "utf8");
  return `Successfully edited ${filePath}.${note}`;
}

async function executeGlob(pattern: string, searchPath?: string): Promise<string> {
  if (!pattern.trim()) return "Error: empty glob pattern";
  const baseDir = searchPath ? safePath(searchPath) : process.cwd();

  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];
  let skipped = 0;
  try {
    for await (const match of glob.scan({ cwd: baseDir, dot: false, onlyFiles: true })) {
      const fullMatch = path.resolve(baseDir, match);
      if (fullMatch === process.cwd() || fullMatch.startsWith(process.cwd() + path.sep)) {
        matches.push(match);
      }
      if (matches.length >= 500) break;
    }
  } catch (err: any) {
    // Bun.Glob.scan() can throw EPERM/EACCES on macOS-protected directories
    // (e.g. ~/Library/Caches). Skip and continue with whatever was collected.
    if (err?.code === "EPERM" || err?.code === "EACCES") {
      skipped++;
    } else {
      throw err;
    }
  }

  const warnings: string[] = [];
  if (skipped > 0) {
    warnings.push(`(skipped ${skipped} inaccessible path${skipped > 1 ? "s" : ""})`);
  }
  if (baseDir === os.homedir() && (pattern === "**/*" || pattern === "**")) {
    warnings.push("Note: cwd is your home directory — consider scoping to a project folder for better results.");
  }

  if (matches.length === 0) {
    const warn = warnings.length ? `\n${warnings.join("\n")}` : "";
    return `No files matched pattern "${pattern}"${warn}`;
  }

  const withStats = matches.map((m) => {
    try {
      const stat = fs.statSync(path.resolve(baseDir, m));
      return { path: m, mtime: stat.mtimeMs };
    } catch {
      return { path: m, mtime: 0 };
    }
  });
  withStats.sort((a, b) => b.mtime - a.mtime);

  const result = withStats.map((w) => w.path).join("\n");
  const suffix = warnings.length ? `\n\n${warnings.join("\n")}` : "";
  return truncateOutput(
    (matches.length >= 500 ? `${result}\n\n... (limited to 500 results)` : result) + suffix
  );
}

async function executeGrep(
  pattern: string,
  searchPath?: string,
  include?: string
): Promise<string> {
  if (!pattern.trim()) return "Error: empty search pattern";
  const target = searchPath ? safePath(searchPath) : process.cwd();

  return new Promise<string>((resolve) => {
    // Try ripgrep first
    const rgArgs = ["--no-heading", "--line-number", "--color=never", "--max-count=100"];
    if (include) rgArgs.push("--glob", include);
    rgArgs.push(pattern, target);

    const proc = spawn("rg", rgArgs, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("error", () => {
      // ripgrep not available, fall back to grep
      const grepArgs = ["-rn", "--color=never"];
      if (include) grepArgs.push(`--include=${include}`);
      grepArgs.push(pattern, target);

      const grepProc = spawn("grep", grepArgs, {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let grepOut = "";
      let grepErr = "";
      grepProc.stdout.on("data", (data: Buffer) => { grepOut += data.toString(); });
      grepProc.stderr.on("data", (data: Buffer) => { grepErr += data.toString(); });

      grepProc.on("close", (code) => {
        if (code === 1 && !grepOut) resolve(`No matches found for pattern "${pattern}"`);
        else if (grepErr && !grepOut) resolve(`Grep error: ${grepErr}`);
        else resolve(truncateOutput(grepOut || "(no output)"));
      });

      grepProc.on("error", (err) => {
        resolve(`Error: neither ripgrep nor grep available: ${err.message}`);
      });
    });

    proc.on("close", (code) => {
      if (code === 1 && !stdout) resolve(`No matches found for pattern "${pattern}"`);
      else if (stderr && !stdout) resolve(`Search error: ${stderr}`);
      else resolve(truncateOutput(stdout || "(no output)"));
    });
  });
}

function executeListDirectory(dirPath?: string): string {
  const target = dirPath ? safePath(dirPath) : process.cwd();
  if (!fs.existsSync(target)) return `Error: directory not found: ${dirPath || "."}`;
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return `Error: not a directory: ${dirPath || "."}`;

  const entries = fs.readdirSync(target, { withFileTypes: true });
  const formatted = entries
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    })
    .map((entry) => {
      if (entry.isDirectory()) return `${entry.name}/`;
      if (entry.isSymbolicLink()) return `${entry.name}@`;
      return entry.name;
    });

  return formatted.length === 0 ? "(empty directory)" : formatted.join("\n");
}

async function executeOpenFile(filePath: string): Promise<string> {
  if (!filePath) return "Error: path is required.";
  const fullPath = safePath(filePath);
  if (!fs.existsSync(fullPath)) return `Error: file not found: ${filePath}`;

  const platform = process.platform;
  const command =
    platform === "darwin"
      ? { cmd: "open", args: [fullPath] }
      : platform === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", fullPath] }
        : { cmd: "xdg-open", args: [fullPath] };

  return new Promise<string>((resolve) => {
    const child = spawn(command.cmd, command.args, {
      stdio: "ignore",
      detached: platform !== "win32"
    });
    let settled = false;
    child.once("error", (err) => {
      if (!settled) {
        settled = true;
        resolve(`Error: failed to open ${filePath}: ${err.message}`);
      }
    });
    child.once("spawn", () => {
      if (!settled) {
        settled = true;
        if (platform !== "win32") child.unref();
        resolve(`Opened ${filePath} with the default application.`);
      }
    });
  });
}
