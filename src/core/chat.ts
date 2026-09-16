import { loadConfig, type PatricConfig } from "../config/config.js";
import { applyInstructions, loadInstructions } from "../config/instructions.js";
import { streamCompletion, type ChatMessage, type RuntimeContext, type ToolEvent } from "./provider.js";

/**
 * Code mode works inside a bound project with the full tool set.
 * Chat mode is a plain conversation: no tools, no project, no working directory.
 */
export type ChatMode = "code" | "chat";

const CHAT_MODE_PROMPT =
  "You are Patric, a thoughtful conversational assistant. Be concise, accurate, and direct. " +
  "In this mode you have no tools: you cannot read or write files, run commands, browse the web, " +
  "or read and save memory. Answer from the conversation and your own knowledge, and say plainly " +
  "when something needs information you do not have. If the request needs a local project — reading " +
  "or changing files, running commands, or exploring a repository — tell the user to switch to " +
  "Code mode and open the project folder there.";

export function isChatMode(mode: unknown): mode is ChatMode {
  return mode === "code" || mode === "chat";
}

/** Shared configuration and instruction loading for CLI and desktop entrypoints. */
export function loadChatConfig(cwd = process.cwd(), mode: ChatMode = "code") {
  const config = loadConfig();
  // Chat mode keeps the user's own identity and personality files but drops project instructions.
  const { text, sources: instructionSources } = loadInstructions(cwd, { includeProject: mode === "code" });
  const systemPrompt = mode === "chat" ? CHAT_MODE_PROMPT : config.systemPrompt;
  return {
    config: { ...config, systemPrompt: applyInstructions(systemPrompt, text) },
    instructionSources
  };
}

/** Interfaces own their transcript and callbacks; the model request uses one path. */
export function streamChatTurn(
  config: PatricConfig,
  history: ChatMessage[],
  onChunk?: (chunk: string) => void,
  onToolEvent?: (event: ToolEvent) => void,
  signal?: AbortSignal,
  runtimeContext?: RuntimeContext
) {
  // Replace any old system entry so settings changes cannot leave a stale prompt.
  const messages: ChatMessage[] = [
    { role: "system", content: config.systemPrompt },
    ...history.filter(message => message.role !== "system")
  ];
  return streamCompletion(config, messages, onChunk, onToolEvent, signal, runtimeContext);
}
