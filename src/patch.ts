import fs from "node:fs";
import path from "node:path";
import type { PatricConfig } from "./config";
import { collectContext, findRepoRoot } from "./repo";
import { requestCompletion, streamCompletion, type CompletionResult, type ChatMessage } from "./provider";
import { execCommand, tryExecCommand } from "./utils";

export interface PatchResult extends CompletionResult {
  patchPath?: string;
}

function extractDiffBlock(text: string): string {
  const fencedMatch = text.match(/```(?:diff|patch)?\n([\s\S]*?)```/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }
  if (text.includes("--- ") || text.includes("diff --git ")) {
    return text.trim();
  }
  return "";
}

function getPatchDir(cwd: string): string {
  const root = findRepoRoot(cwd) || cwd;
  return path.join(root, ".patric", "patches");
}

function timestamp(): string {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    `${now.getMonth() + 1}`.padStart(2, "0"),
    `${now.getDate()}`.padStart(2, "0"),
    `${now.getHours()}`.padStart(2, "0"),
    `${now.getMinutes()}`.padStart(2, "0"),
    `${now.getSeconds()}`.padStart(2, "0")
  ];
  return `${parts[0]}${parts[1]}${parts[2]}-${parts[3]}${parts[4]}${parts[5]}`;
}

function patchPrompt(userPrompt: string, context: string): string {
  return [
    "You are generating a unified diff patch for a software repository.",
    "Return only a valid patch inside a ```diff fenced block.",
    "Use paths relative to the repository root.",
    "Do not include explanations outside the patch.",
    "",
    "Task:",
    userPrompt,
    "",
    "Repository context:",
    context
  ].join("\n");
}

export async function generatePatch(
  config: PatricConfig,
  cwd: string,
  userPrompt: string,
  useStream = true
): Promise<PatchResult> {
  const context = collectContext(cwd);
  const messages: ChatMessage[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: patchPrompt(userPrompt, context) }
  ];

  const result = useStream
    ? await streamCompletion(config, messages)
    : await requestCompletion(config, messages);

  if (!result.ok) {
    return result;
  }

  const patchText = extractDiffBlock(result.content);
  if (!patchText) {
    return {
      ok: false,
      content: "Model response did not contain a valid diff block."
    };
  }

  const patchDir = getPatchDir(cwd);
  fs.mkdirSync(patchDir, { recursive: true });
  const patchPath = path.join(patchDir, `${timestamp()}.patch`);
  fs.writeFileSync(patchPath, `${patchText}\n`, "utf8");

  return {
    ok: true,
    content: patchText,
    patchPath
  };
}

export function applyPatch(cwd: string, patchFile: string): { root: string; patchFile: string } {
  const root = findRepoRoot(cwd) || cwd;
  const fullPath = path.resolve(cwd, patchFile);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Patch file not found: ${fullPath}`);
  }

  const check = tryExecCommand(`git apply --check "${fullPath}"`, root);
  if (!check.ok) {
    throw new Error(check.stderr.trim() || "Patch validation failed.");
  }

  execCommand(`git apply "${fullPath}"`, root);
  return {
    root,
    patchFile: fullPath
  };
}
