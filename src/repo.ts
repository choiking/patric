import fs from "node:fs";
import path from "node:path";
import { execCommand, resolvePath, tryExecCommand } from "./utils";

export interface RepoInfo {
  root: string | null;
  branch: string | null;
  status: string[];
  isGitRepo: boolean;
}

const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build"]);

function walkFiles(baseDir: string, relativeDir = "", results: string[] = [], limit = 200): string[] {
  const currentDir = path.join(baseDir, relativeDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    // Skip directories that are unreadable (EPERM/EACCES on macOS-protected paths)
    return results;
  }
  for (const entry of entries) {
    if (results.length >= limit) {
      break;
    }
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(baseDir, relativePath, results, limit);
    } else {
      results.push(relativePath);
    }
  }
  return results;
}

export function findRepoRoot(cwd: string): string | null {
  const result = tryExecCommand("git rev-parse --show-toplevel", cwd);
  return result.ok ? result.stdout.trim() : null;
}

export function getRepoInfo(cwd: string): RepoInfo {
  const root = findRepoRoot(cwd);
  if (!root) {
    return {
      root: null,
      branch: null,
      status: [],
      isGitRepo: false
    };
  }

  const branch = execCommand("git rev-parse --abbrev-ref HEAD", root).trim();
  const statusOutput = execCommand("git status --short", root).trim();
  const status = statusOutput ? statusOutput.split("\n") : [];

  return {
    root,
    branch,
    status,
    isGitRepo: true
  };
}

export function listRepoFiles(cwd: string, pattern = ""): string[] {
  const root = findRepoRoot(cwd);
  let files: string[] = [];

  if (root) {
    const output = execCommand("git ls-files", root).trim();
    files = output ? output.split("\n") : [];
  } else {
    files = walkFiles(cwd);
  }

  return pattern ? files.filter((file) => file.includes(pattern)) : files;
}

function truncateContent(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return content;
  }
  return `${content.slice(0, maxBytes)}\n\n...[truncated]`;
}

export function collectContext(cwd: string, targets: string[] = [], maxBytes = 12000): string {
  const root = findRepoRoot(cwd) || cwd;
  const repoInfo = getRepoInfo(cwd);
  const selectedTargets = targets.length > 0 ? targets : listRepoFiles(cwd).slice(0, 8);
  const parts: string[] = [];
  let remaining = maxBytes;

  parts.push(`Repository root: ${root}`);
  if (repoInfo.isGitRepo) {
    parts.push(`Branch: ${repoInfo.branch}`);
    if (repoInfo.status.length > 0) {
      parts.push(`Git status:\n${repoInfo.status.slice(0, 20).join("\n")}`);
    }
  }

  for (const target of selectedTargets) {
    if (remaining <= 0) {
      break;
    }
    const fullPath = resolvePath(target, cwd);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      continue;
    }
    const raw = fs.readFileSync(fullPath, "utf8");
    const clipped = truncateContent(raw, Math.min(remaining, 3000));
    parts.push(`File: ${path.relative(root, fullPath)}\n${clipped}`);
    remaining -= Buffer.byteLength(clipped, "utf8");
  }

  return parts.join("\n\n");
}
