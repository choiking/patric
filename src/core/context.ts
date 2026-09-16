import type { PatricConfig } from "../config/config.js";
import type { ChatMessage } from "./provider.js";

// ---------------------------------------------------------------------------
// Context window tracking
// ---------------------------------------------------------------------------

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  "gpt-3.5-turbo": 16_385,
  "o1": 200_000,
  "o1-mini": 128_000,
  "o1-pro": 200_000,
  "o3": 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,
  "gpt-4.1": 1_047_576,
  "gpt-4.1-mini": 1_047_576,
  "gpt-4.1-nano": 1_047_576,
  "gpt-5.4": 1_047_576,
  "gpt-5.1": 1_047_576,
  "gpt-5-mini": 1_047_576,
  "gpt-5-nano": 1_047_576,
  "gpt-5.3-codex": 1_047_576,
  // Anthropic
  "claude-3-opus-20240229": 200_000,
  "claude-3-sonnet-20240229": 200_000,
  "claude-3-haiku-20240307": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-opus-4-1-20250805": 200_000,
  // Gemini
  "gemini-2.5-pro": 1_048_576,
  "gemini-2.5-flash": 1_048_576,
  "gemini-2.0-flash": 1_048_576,
  "gemini-1.5-pro": 2_097_152,
  "gemini-1.5-flash": 1_048_576,
  // Ollama common defaults
  "llama3.2": 131_072,
  "qwen3": 131_072,
  "deepseek-r1": 131_072,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

function getContextWindowForModel(model: string): number {
  if (MODEL_CONTEXT_WINDOWS[model]) {
    return MODEL_CONTEXT_WINDOWS[model];
  }
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.startsWith(key)) {
      return value;
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Rough token estimation: ~4 characters per token for English text.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += msg.role.length + 4;
    chars += typeof msg.content === "string" ? msg.content.length : JSON.stringify(msg.content).length;
  }
  return Math.ceil(chars / 4);
}

export function getContextPercentage(config: PatricConfig, messages: ChatMessage[]): string {
  const model = config.model || "";
  const windowSize = getContextWindowForModel(model);
  const used = estimateTokens(messages);
  const raw = Math.min(100, (used / windowSize) * 100);
  if (raw === 0) return "0";
  if (raw < 10) return raw.toFixed(1);
  return String(Math.round(raw));
}

export function getContextPercentageNum(config: PatricConfig, messages: ChatMessage[]): number {
  const model = config.model || "";
  const windowSize = getContextWindowForModel(model);
  const used = estimateTokens(messages);
  return Math.min(100, (used / windowSize) * 100);
}
