import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function print(text = ""): void {
  process.stdout.write(`${text}\n`);
}

export function printError(text: string): void {
  process.stderr.write(`${text}\n`);
}

export function resolvePath(targetPath: string, cwd: string): string {
  return path.resolve(cwd, targetPath);
}

export function readFileSafe(targetPath: string, cwd: string): { fullPath: string; content: string } {
  const fullPath = resolvePath(targetPath, cwd);
  return {
    fullPath,
    content: fs.readFileSync(fullPath, "utf8")
  };
}

export function writeFileSafe(targetPath: string, content: string, cwd: string): string {
  const fullPath = resolvePath(targetPath, cwd);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

export function listDir(targetPath: string, cwd: string): string[] {
  const base = targetPath ? resolvePath(targetPath, cwd) : cwd;
  return fs.readdirSync(base).sort();
}

export function execCommand(command: string, cwd: string): string {
  return execSync(command, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4
  });
}

export function tryExecCommand(command: string, cwd: string): ExecResult {
  try {
    return {
      ok: true,
      stdout: execCommand(command, cwd),
      stderr: ""
    };
  } catch (error: any) {
    return {
      ok: false,
      stdout: error.stdout?.toString?.() || "",
      stderr: error.stderr?.toString?.() || error.message || String(error)
    };
  }
}
