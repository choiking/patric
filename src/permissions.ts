// ---------------------------------------------------------------------------
// Permission controls — Claude Code-style tool approval system
// ---------------------------------------------------------------------------

export type ToolPermissionLevel = "read-only" | "write" | "execute";

export const TOOL_PERMISSIONS: Record<string, ToolPermissionLevel> = {
  // Read-only (auto-allowed, no prompt)
  web_search: "read-only",
  fetch_url: "read-only",
  read_file: "read-only",
  glob: "read-only",
  grep: "read-only",
  list_directory: "read-only",
  read_memory: "read-only",
  list_agents: "read-only",
  wait_agent: "read-only",
  cancel_agent: "read-only",

  // Write tools (need permission)
  write_file: "write",
  edit_file: "write",
  save_memory: "write",

  // Execute tools (need permission)
  bash: "execute",
  open_file: "execute",
  browser: "execute",
  spawn_agent: "execute",
};

export function isToolReadOnly(toolName: string): boolean {
  return TOOL_PERMISSIONS[toolName] === "read-only" || !(toolName in TOOL_PERMISSIONS);
}

export type PermissionDecision = "allow-once" | "allow-session" | "allow-always" | "deny";

export interface PermissionRequest {
  toolName: string;
  arguments: Record<string, any>;
  summary: string;
}

export interface PermissionPromptFn {
  (request: PermissionRequest): Promise<PermissionDecision>;
}

export interface PermissionStateOptions {
  configAllowed?: string[];
  promptFn?: PermissionPromptFn | null;
  isSubAgent?: boolean;
}

export class PermissionState {
  private sessionAllowed: Set<string> = new Set();
  private configAllowed: Set<string>;
  private promptFn: PermissionPromptFn | null;
  private isSubAgent: boolean;

  constructor(opts: PermissionStateOptions) {
    this.configAllowed = new Set(opts.configAllowed || []);
    this.promptFn = opts.promptFn || null;
    this.isSubAgent = opts.isSubAgent || false;
  }

  async checkPermission(
    request: PermissionRequest
  ): Promise<{ allowed: boolean; decision: PermissionDecision }> {
    const { toolName } = request;

    // Read-only tools always pass
    if (isToolReadOnly(toolName)) {
      return { allowed: true, decision: "allow-once" };
    }

    // Already allowed in config (persistent)
    if (this.configAllowed.has(toolName)) {
      return { allowed: true, decision: "allow-always" };
    }

    // Already allowed for this session
    if (this.sessionAllowed.has(toolName)) {
      return { allowed: true, decision: "allow-session" };
    }

    // Sub-agents: auto-deny (no interactive prompt)
    if (this.isSubAgent) {
      return { allowed: false, decision: "deny" };
    }

    // Non-interactive mode: auto-deny
    if (!this.promptFn) {
      return { allowed: false, decision: "deny" };
    }

    // Prompt the user
    const decision = await this.promptFn(request);

    if (decision === "allow-session") {
      this.sessionAllowed.add(toolName);
    }
    if (decision === "allow-always") {
      this.sessionAllowed.add(toolName);
      this.configAllowed.add(toolName);
    }

    return {
      allowed: decision !== "deny",
      decision,
    };
  }

  getConfigAllowed(): string[] {
    return [...this.configAllowed];
  }

  getSessionAllowed(): string[] {
    return [...this.sessionAllowed];
  }
}

export function formatPermissionSummary(
  toolName: string,
  args: Record<string, any>
): string {
  switch (toolName) {
    case "bash": {
      const cmd = typeof args?.command === "string" ? args.command.trim() : "";
      return cmd ? `bash: ${cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd}` : "bash";
    }
    case "write_file": {
      const p = typeof args?.path === "string" ? args.path : "";
      return p ? `write_file: ${p}` : "write_file";
    }
    case "edit_file": {
      const p = typeof args?.path === "string" ? args.path : "";
      return p ? `edit_file: ${p}` : "edit_file";
    }
    case "open_file": {
      const p = typeof args?.path === "string" ? args.path : "";
      return p ? `open_file: ${p}` : "open_file";
    }
    case "browser": {
      const action = typeof args?.action === "string" ? args.action : "";
      const url = typeof args?.url === "string" ? args.url : "";
      if (action === "navigate" && url) return `browser: navigate ${url}`;
      return action ? `browser: ${action}` : "browser";
    }
    case "save_memory": {
      const target = typeof args?.target === "string" ? args.target : "";
      return target ? `save_memory: ${target}` : "save_memory";
    }
    case "spawn_agent": {
      const name = typeof args?.name === "string" ? args.name : "";
      return name ? `spawn_agent: ${name}` : "spawn_agent";
    }
    default:
      return toolName;
  }
}
