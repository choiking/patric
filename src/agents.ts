import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PatricConfig } from "./config";
import { normalizeModelForProvider } from "./config";

export type AgentScope = "project" | "user" | "builtin";
export type AgentToolPolicy = "*" | string[];

export interface AgentSpec {
  name: string;
  description: string;
  prompt: string;
  tools?: AgentToolPolicy;
  model?: string;
  scope: AgentScope;
  sourcePath?: string;
}

export interface AgentRegistry {
  all: AgentSpec[];
  byName: Map<string, AgentSpec>;
}

export interface AgentRunStatus {
  id: string;
  name: string;
  task: string;
  state: "queued" | "running" | "done" | "error" | "cancelled";
  result?: string;
  error?: string;
  model?: string;
  scope: AgentScope;
  startedAt: number;
  finishedAt?: number;
}

export interface AgentRunResult {
  ok: boolean;
  content: string;
}

export interface AgentRunner {
  (spec: AgentSpec, task: string, signal: AbortSignal, runId: string): Promise<AgentRunResult>;
}

export interface AgentManager {
  spawn(name: string, task: string): AgentRunStatus;
  wait(id: string): Promise<AgentRunStatus>;
  cancel(id: string): AgentRunStatus;
  listRuns(): AgentRunStatus[];
  listAvailableAgents(): AgentSpec[];
  getAgent(name: string): AgentSpec | undefined;
}

interface AgentManagerOptions {
  registry: AgentRegistry;
  runner: AgentRunner;
  maxConcurrent?: number;
  onStatus?: (status: AgentRunStatus) => void;
}

interface FrontmatterResult {
  frontmatter: Record<string, unknown>;
  body: string;
}

interface InternalRun {
  status: AgentRunStatus;
  controller: AbortController;
  promise: Promise<AgentRunStatus>;
  cancelRequested: boolean;
}

const DEFAULT_MAX_CONCURRENT = 3;

export function getProjectAgentsDir(cwd: string): string {
  return path.join(cwd, ".patric", "agents");
}

export function getUserAgentsDir(): string {
  return path.join(os.homedir(), ".config", "patric", "agents");
}

function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase();
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith(`"`) && trimmed.endsWith(`"`)) ||
    (trimmed.startsWith(`'`) && trimmed.endsWith(`'`))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineArray(value: string): string[] {
  const inner = value.trim().slice(1, -1).trim();
  if (!inner) {
    return [];
  }
  return inner
    .split(",")
    .map((item) => stripMatchingQuotes(item))
    .filter(Boolean);
}

function parseYamlScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return parseInlineArray(trimmed);
  }
  return stripMatchingQuotes(trimmed);
}

function parseFrontmatterSection(raw: string): Record<string, unknown> {
  const lines = raw.split(/\r?\n/);
  const parsed: Record<string, unknown> = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      throw new Error(`Invalid frontmatter line: ${line}`);
    }

    const [, key, rawValue] = match;
    const trimmedValue = rawValue.trim();

    if (!trimmedValue) {
      const items: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length && /^\s*-\s+/.test(lines[cursor])) {
        items.push(stripMatchingQuotes(lines[cursor].replace(/^\s*-\s+/, "")));
        cursor += 1;
      }
      parsed[key] = items;
      index = cursor - 1;
      continue;
    }

    parsed[key] = parseYamlScalar(trimmedValue);
  }

  return parsed;
}

function parseMarkdownAgent(content: string): FrontmatterResult {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    throw new Error("Missing closing YAML frontmatter fence.");
  }

  const frontmatterRaw = normalized.slice(4, closingIndex);
  const body = normalized.slice(closingIndex + 5).trim();
  return {
    frontmatter: parseFrontmatterSection(frontmatterRaw),
    body
  };
}

function loadAgentFile(filePath: string, scope: AgentScope): AgentSpec {
  const raw = fs.readFileSync(filePath, "utf8");
  const { frontmatter, body } = parseMarkdownAgent(raw);
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  const model =
    typeof frontmatter.model === "string" && frontmatter.model.trim()
      ? frontmatter.model.trim()
      : undefined;

  if (!name) {
    throw new Error("Agent file is missing required `name`.");
  }
  if (!description) {
    throw new Error("Agent file is missing required `description`.");
  }

  let tools: AgentToolPolicy | undefined;
  if (frontmatter.tools === "*") {
    tools = "*";
  } else if (Array.isArray(frontmatter.tools)) {
    tools = frontmatter.tools
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  } else if (typeof frontmatter.tools === "string" && frontmatter.tools.trim()) {
    tools = [frontmatter.tools.trim()];
  }

  return {
    name,
    description,
    prompt: body,
    tools,
    model,
    scope,
    sourcePath: filePath
  };
}

function loadAgentsFromDir(dirPath: string, scope: AgentScope): AgentSpec[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const entries = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));

  return entries.map((entry) => loadAgentFile(path.join(dirPath, entry.name), scope));
}

const BUILTIN_AGENTS: AgentSpec[] = [
  {
    name: "explore",
    description:
      "Fast read-only codebase search and exploration. Use for file discovery, " +
      "code search, understanding architecture, and answering questions about the codebase. " +
      "Spawn multiple explore agents to search different areas in parallel.",
    prompt:
      "You are an exploration agent. Search the codebase thoroughly to answer the delegated question.\n" +
      "Use read_file, grep, glob, and list_directory to find relevant code.\n" +
      "Return concrete findings with file paths and line numbers.",
    tools: ["read_file", "grep", "glob", "list_directory", "web_search", "fetch_url"],
    scope: "builtin",
  },
  {
    name: "plan",
    description:
      "Research and design implementation plans. Use for gathering context, " +
      "understanding existing patterns, and proposing detailed implementation approaches.",
    prompt:
      "You are a planning agent. Research the codebase to understand existing patterns and design an implementation plan.\n" +
      "Use read_file, grep, glob, list_directory, and bash (read-only commands) to gather context.\n" +
      "Return a structured plan with file paths, functions to modify, and step-by-step instructions.",
    tools: ["read_file", "grep", "glob", "list_directory", "bash", "web_search", "fetch_url"],
    scope: "builtin",
  },
  {
    name: "general-purpose",
    description:
      "Complex multi-step tasks including code modifications, running commands, " +
      "and research. Spawn when the subtask requires both reading and writing files.",
    prompt:
      "You are a general-purpose agent. Handle the delegated task end-to-end.\n" +
      "You have access to all tools including file editing and bash.\n" +
      "Return a concise summary of what you did and the outcome.",
    tools: "*",
    scope: "builtin",
  },
];

export function loadAgentRegistry(cwd: string): AgentRegistry {
  const registry = new Map<string, AgentSpec>();

  // Built-ins first (lowest priority — overridden by user/project agents)
  for (const spec of BUILTIN_AGENTS) {
    registry.set(normalizeAgentName(spec.name), spec);
  }

  // User agents override built-ins
  const userAgents = loadAgentsFromDir(getUserAgentsDir(), "user");
  for (const spec of userAgents) {
    registry.set(normalizeAgentName(spec.name), spec);
  }

  // Project agents override everything
  const projectAgents = loadAgentsFromDir(getProjectAgentsDir(cwd), "project");
  for (const spec of projectAgents) {
    registry.set(normalizeAgentName(spec.name), spec);
  }

  const all = [...registry.values()].sort((left, right) => left.name.localeCompare(right.name));
  return {
    all,
    byName: registry
  };
}

export function getEffectiveAgentToolNames(
  spec: AgentSpec,
  parentAllowedToolNames: string[]
): string[] {
  if (!spec.tools || spec.tools === "*") {
    return [...parentAllowedToolNames];
  }
  const allowed = new Set(parentAllowedToolNames);
  return spec.tools.filter((toolName) => allowed.has(toolName));
}

export function buildAgentSystemPrompt(baseSystemPrompt: string, spec: AgentSpec): string {
  const parts = [
    baseSystemPrompt.trim(),
    `You are the Patric sub-agent "${spec.name}".`,
    `Specialization: ${spec.description}.`,
    "Work only on the delegated task and return a concise result for the parent agent.",
  ];

  if (spec.prompt.trim()) {
    parts.push(`Agent instructions:\n${spec.prompt.trim()}`);
  }

  return parts.filter(Boolean).join("\n\n");
}

export function buildAgentTaskPrompt(task: string): string {
  return [
    "Delegated task from the parent Patric agent:",
    task.trim(),
    "",
    "Return the useful result directly. Include concrete findings, file paths, commands, or edits when relevant."
  ].join("\n");
}

export function formatAgentList(registry: AgentRegistry): string {
  if (registry.all.length === 0) {
    return "No agents found.";
  }

  return registry.all
    .map((spec) => {
      const model = spec.model ? ` model=${spec.model}` : "";
      const tools =
        spec.tools === "*"
          ? " tools=*"
          : Array.isArray(spec.tools) && spec.tools.length > 0
            ? ` tools=${spec.tools.join(",")}`
            : "";
      return `${spec.name} [${spec.scope}]${model}${tools}\n  ${spec.description}`;
    })
    .join("\n");
}

export function formatAgentPromptSummary(registry: AgentRegistry): string {
  if (registry.all.length === 0) {
    return "";
  }

  return [
    "## Sub-Agent Delegation",
    "",
    "You have access to sub-agents via `spawn_agent`. Use them proactively:",
    "- When the user asks about multiple topics, repos, or files — spawn one agent per topic in parallel",
    "- When the task involves searching, exploring, or comparing codebases — use `explore` agents",
    "- When the task requires planning or research before implementation — use a `plan` agent",
    "- When the task involves independent subtasks that can run concurrently — spawn multiple agents",
    "",
    "Workflow: call `spawn_agent` for each subtask (they run in parallel), then `wait_agent` for each to collect results.",
    "",
    "Available agents:",
    ...registry.all.map((spec) => {
      const tools = spec.tools === "*" ? "all tools" :
        Array.isArray(spec.tools) ? spec.tools.join(", ") : "inherited";
      return `- **${spec.name}**: ${spec.description} (tools: ${tools})`;
    }),
  ].join("\n");
}

export function resolveAgentModel(config: PatricConfig, spec: AgentSpec): string {
  return spec.model ? normalizeModelForProvider(config.provider, spec.model) : config.model;
}

function cloneStatus(status: AgentRunStatus): AgentRunStatus {
  return { ...status };
}

function isFinalState(state: AgentRunStatus["state"]): boolean {
  return state === "done" || state === "error" || state === "cancelled";
}

export function createAgentManager(options: AgentManagerOptions): AgentManager {
  const runs = new Map<string, InternalRun>();
  const maxConcurrent = options.maxConcurrent || DEFAULT_MAX_CONCURRENT;
  let nextId = 1;

  const emit = (status: AgentRunStatus) => {
    options.onStatus?.(cloneStatus(status));
  };

  const countActiveRuns = () =>
    [...runs.values()].filter((run) => !isFinalState(run.status.state)).length;

  const getAgent = (name: string) => options.registry.byName.get(normalizeAgentName(name));

  return {
    spawn(name: string, task: string): AgentRunStatus {
      const spec = getAgent(name);
      if (!spec) {
        throw new Error(`Unknown agent: ${name}`);
      }
      if (!task.trim()) {
        throw new Error("spawn_agent requires a non-empty task.");
      }
      if (countActiveRuns() >= maxConcurrent) {
        throw new Error(`Agent concurrency limit reached (${maxConcurrent}). Wait for a worker first.`);
      }

      const id = `agent_${nextId++}`;
      const controller = new AbortController();
      const status: AgentRunStatus = {
        id,
        name: spec.name,
        task: task.trim(),
        state: "queued",
        model: spec.model,
        scope: spec.scope,
        startedAt: Date.now()
      };

      const run: InternalRun = {
        status,
        controller,
        cancelRequested: false,
        promise: Promise.resolve(cloneStatus(status))
      };

      runs.set(id, run);
      emit(status);

      run.promise = (async () => {
        if (run.cancelRequested) {
          return cloneStatus(run.status);
        }

        run.status.state = "running";
        emit(run.status);

        try {
          const result = await options.runner(spec, run.status.task, controller.signal, id);
          if (run.cancelRequested) {
            return cloneStatus(run.status);
          }
          run.status.finishedAt = Date.now();
          if (result.ok) {
            run.status.state = "done";
            run.status.result = result.content;
          } else {
            run.status.state = "error";
            run.status.error = result.content;
          }
        } catch (error: unknown) {
          if (run.cancelRequested) {
            return cloneStatus(run.status);
          }
          run.status.finishedAt = Date.now();
          run.status.state = "error";
          run.status.error = error instanceof Error ? error.message : String(error);
        }

        emit(run.status);
        return cloneStatus(run.status);
      })();

      return cloneStatus(status);
    },

    async wait(id: string): Promise<AgentRunStatus> {
      const run = runs.get(id);
      if (!run) {
        throw new Error(`Unknown agent run: ${id}`);
      }
      if (isFinalState(run.status.state)) {
        return cloneStatus(run.status);
      }
      return run.promise;
    },

    cancel(id: string): AgentRunStatus {
      const run = runs.get(id);
      if (!run) {
        throw new Error(`Unknown agent run: ${id}`);
      }
      if (isFinalState(run.status.state)) {
        return cloneStatus(run.status);
      }

      run.cancelRequested = true;
      run.controller.abort();
      run.status.state = "cancelled";
      run.status.finishedAt = Date.now();
      emit(run.status);
      return cloneStatus(run.status);
    },

    listRuns(): AgentRunStatus[] {
      return [...runs.values()]
        .map((run) => cloneStatus(run.status))
        .sort((left, right) => left.startedAt - right.startedAt);
    },

    listAvailableAgents(): AgentSpec[] {
      return [...options.registry.all];
    },

    getAgent
  };
}
