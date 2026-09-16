import chalk from "chalk";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

// marked-terminal uses chalk which auto-detects color level at import time.
// In the TUI's alternate screen buffer, chalk may detect level 0 (no color).
// Force truecolor support since we only render in TTY mode.
chalk.level = 3;

export function invert(text: string): string {
  return `\x1b[7m${text}\x1b[0m`;
}

export function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}

export function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

export function color(text: string, code: number): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

export function cyan(text: string): string {
  return color(text, 36);
}

export function gray(text: string): string {
  return color(text, 90);
}

export function red(text: string): string {
  return color(text, 31);
}

export function yellow(text: string): string {
  return color(text, 33);
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

export function style(text: string, ...codes: number[]): string {
  return `\x1b[${codes.join(";")}m${text}\x1b[0m`;
}

export const theme = {
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

export function visibleWidth(value: string): number {
  return stripAnsi(value).length;
}

export function truncatePlain(value: string, width: number): string {
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

export function truncateAnsi(value: string, width: number): string {
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

export function padLine(value: string, width: number): string {
  const gap = Math.max(0, width - visibleWidth(value));
  return `${value}${" ".repeat(gap)}`;
}

export function frameLine(left: string, content: string, right: string, width: number): string {
  const innerWidth = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
  return `${left}${padLine(content, innerWidth)}${right}`;
}

export function alignSides(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

export function panel(lines: string[], width: number): string[] {
  const innerWidth = Math.max(1, width - 4);
  const top = `${theme.border("┌")}${theme.border("─".repeat(width - 2))}${theme.border("┐")}`;
  const bottom = `${theme.border("└")}${theme.border("─".repeat(width - 2))}${theme.border("┘")}`;
  const body = lines.map((line) =>
    frameLine(theme.border("│ "), truncateAnsi(line, innerWidth), theme.border(" │"), width)
  );
  return [top, ...body, bottom];
}

export function divider(width: number, label?: string): string {
  const ruleWidth = Math.max(0, width);
  if (!label) {
    return theme.border("─".repeat(ruleWidth));
  }
  const text = ` ${label} `;
  const left = Math.max(2, Math.floor((ruleWidth - text.length) / 2));
  const right = Math.max(0, ruleWidth - text.length - left);
  return `${theme.border("─".repeat(left))}${theme.muted(text)}${theme.border("─".repeat(right))}`;
}

export function renderListRow(left: string, right: string, width: number, selected = false): string {
  const row = padLine(alignSides(left, right, width), width);
  return selected ? theme.selected(row) : row;
}

export function renderChip(label: string, value: string): string {
  return `${theme.muted(label)} ${theme.chip(value)}`;
}

export function renderInputWithCursor(value: string, cursor: number, placeholder: string): string {
  if (!value) {
    return `${invert(" ")}${theme.muted(placeholder)}`;
  }
  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  const before = value.slice(0, safeCursor);
  const current = value[safeCursor] || " ";
  const after = safeCursor < value.length ? value.slice(safeCursor + 1) : "";
  return `${theme.text(before)}${invert(current)}${theme.text(after)}`;
}

export function formatToolCallSummary(name: string, args?: Record<string, any>): string {
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

export function wrapText(text: string, width: number): string[] {
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

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

// ---------------------------------------------------------------------------
// Markdown → ANSI rendering (using marked-terminal)
// ---------------------------------------------------------------------------

export function renderMarkdown(text: string, width: number): string[] {
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

