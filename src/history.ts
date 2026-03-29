import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HISTORY_DIR = path.join(os.homedir(), ".local", "share", "patric");
const HISTORY_FILE = path.join(HISTORY_DIR, "history.json");
const MAX_HISTORY = 500;

export function loadHistory(): string[] {
  try {
    const data = fs.readFileSync(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
    return [];
  } catch {
    return [];
  }
}

export function appendHistory(prompt: string): void {
  try {
    const history = loadHistory();
    history.push(prompt);
    const trimmed = history.length > MAX_HISTORY ? history.slice(-MAX_HISTORY) : history;
    if (!fs.existsSync(HISTORY_DIR)) {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed), "utf8");
  } catch {
    // Silently ignore write failures
  }
}
