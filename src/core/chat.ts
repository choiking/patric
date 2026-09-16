import { loadConfig, type PatricConfig } from "../config/config.js";
import { applyInstructions, loadInstructions } from "../config/instructions.js";
import { streamCompletion, type ChatMessage, type RuntimeContext, type ToolEvent } from "./provider.js";

/** Shared configuration and instruction loading for CLI and desktop entrypoints. */
export function loadChatConfig(cwd = process.cwd()) {
  const config = loadConfig();
  const { text, sources: instructionSources } = loadInstructions(cwd);
  return {
    config: { ...config, systemPrompt: applyInstructions(config.systemPrompt, text) },
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
