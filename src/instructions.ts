import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { findRepoRoot } from "./repo.js";

const MAX_BYTES = 10_000;

export interface InstructionSources {
  patric?: string;
  patricUser?: string;
  soul?: string;
  user?: string;
}

export function loadInstructions(cwd: string): { text: string; sources: InstructionSources } {
  const sources: InstructionSources = {};
  const root = findRepoRoot(cwd) || cwd;
  const configDir = join(process.env.HOME || "", ".config", "patric");

  // USER.md — user-level identity (from ~/.config/patric/USER.md)
  const userPath = join(configDir, "USER.md");
  let userText = "";
  if (existsSync(userPath)) {
    userText = readSafe(userPath);
    sources.user = userPath;
  }

  // SOUL.md — user-level personality (from ~/.config/patric/)
  const soulPath = join(configDir, "SOUL.md");
  let soulText = "";
  if (existsSync(soulPath)) {
    soulText = readSafe(soulPath);
    sources.soul = soulPath;
  }

  // PATRIC.md — user-level instructions (from ~/.config/patric/PATRIC.md)
  const patricUserPath = join(configDir, "PATRIC.md");
  let patricUserText = "";
  if (existsSync(patricUserPath)) {
    patricUserText = readSafe(patricUserPath);
    sources.patricUser = patricUserPath;
  }

  // PATRIC.md — project-level instructions (from repo root)
  const patricPath = join(root, "PATRIC.md");
  let patricText = "";
  if (existsSync(patricPath) && patricPath !== patricUserPath) {
    patricText = readSafe(patricPath);
    sources.patric = patricPath;
  }

  // Assemble: user identity → soul/personality → user instructions → project instructions
  const parts: string[] = [];
  if (userText) parts.push(`User profile:\n${userText}`);
  if (soulText) parts.push(`Personality:\n${soulText}`);
  if (patricUserText) parts.push(`User instructions:\n${patricUserText}`);
  if (patricText) parts.push(`Project instructions:\n${patricText}`);

  return { text: parts.join("\n\n"), sources };
}

function readSafe(path: string): string {
  try {
    let content = readFileSync(path, "utf8").trim();
    if (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
      content = content.slice(0, MAX_BYTES) + "\n...[truncated]";
    }
    return content;
  } catch {
    return "";
  }
}

export function applyInstructions(systemPrompt: string, instructionsText: string): string {
  if (!instructionsText) return systemPrompt;
  return `${systemPrompt}\n\n${instructionsText}`;
}
