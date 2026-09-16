import type { PatricConfig } from "../config/config.js";

// Catalog protocol baseline, independent of the model IDs returned by the server.
const CODEX_CATALOG_VERSION = "0.153.4";

export interface ModelCatalogRequest {
  provider: string;
  baseUrl: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

interface CatalogModel {
  id?: string;
  name?: string;
  slug?: string;
  created?: number;
  visibility?: string;
  priority?: number;
  supportedGenerationMethods?: string[];
}

function modelId(model: CatalogModel, provider: string): string {
  const id = provider === "openai-codex" ? model.slug
    : provider === "gemini" || provider === "ollama" ? model.name : model.id;
  return typeof id === "string" ? id.trim().replace(/^models\//, "") : "";
}

function isChatModel(model: CatalogModel, provider: string): boolean {
  if (provider === "openai-codex") return model.visibility !== "hide";
  if (provider === "gemini") return model.supportedGenerationMethods?.includes("generateContent") === true;
  if (provider !== "openai") return true;
  const id = modelId(model, provider).toLowerCase();
  return /^(gpt|o[1-9]|codex|chatgpt|ft:)/.test(id)
    && !/(embedding|whisper|tts|transcri|moderation|image|realtime|audio|search|computer-use)/.test(id);
}

function sortCatalog(models: CatalogModel[], provider: string): string[] {
  const sorted = models.filter((model) => model && modelId(model, provider) && isChatModel(model, provider));
  if (provider === "openai-codex") {
    sorted.sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
  } else if (provider === "openai") {
    sorted.sort((a, b) => (b.created ?? 0) - (a.created ?? 0)
      || modelId(b, provider).localeCompare(modelId(a, provider), undefined, { numeric: true }));
  } else if (provider === "openrouter" || provider === "ollama") {
    sorted.sort((a, b) => modelId(a, provider).localeCompare(modelId(b, provider), undefined, { numeric: true }));
  }
  return [...new Set(sorted.map((model) => modelId(model, provider)))];
}

export async function fetchModelCatalog(request: ModelCatalogRequest): Promise<string[]> {
  const { provider, headers } = request;
  const baseUrl = request.baseUrl.replace(/\/+$/, "");
  const endpoint = provider === "ollama" ? "/api/tags"
    : provider === "openai-codex" ? "/codex/models"
    : provider === "anthropic" ? "/v1/models" : "/models";
  const url = new URL(`${baseUrl}${endpoint}`);
  if (provider === "openai-codex") {
    url.searchParams.set("client_version", process.env.PATRIC_CODEX_CLIENT_VERSION || CODEX_CATALOG_VERSION);
  }
  if (provider === "anthropic") url.searchParams.set("limit", "1000");
  if (provider === "gemini") url.searchParams.set("pageSize", "1000");
  const signal = request.signal
    ? AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
  const models: CatalogModel[] = [];
  const seenCursors = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const response = await fetch(url, { headers, signal });
    if (!response.ok) throw new Error(`Model list request failed (${response.status}).`);
    const data = await response.json();
    const items = ["ollama", "gemini", "openai-codex"].includes(provider) ? data?.models : data?.data;
    if (!Array.isArray(items)) throw new Error("Provider returned an invalid model list.");
    models.push(...items);
    const cursor = provider === "gemini" ? data.nextPageToken
      : provider === "anthropic" && data.has_more ? data.last_id : undefined;
    if (provider === "anthropic" && data.has_more && !cursor) {
      throw new Error("Provider returned an invalid model list cursor.");
    }
    if (!cursor) return sortCatalog(models, provider);
    if (typeof cursor !== "string" || seenCursors.has(cursor)) throw new Error("Provider repeated an invalid model list cursor.");
    seenCursors.add(cursor);
    url.searchParams.set(provider === "gemini" ? "pageToken" : "after_id", cursor);
  }
  throw new Error("Model list exceeded the pagination limit.");
}

export function getModelOptions(config: PatricConfig, discovered?: string[], fallback: string[] = []): string[] {
  const recent = config.recentModels[config.provider] || [];
  const available = discovered === undefined ? fallback : discovered;
  const current = config.model ? [config.model] : [];
  const validRecent = discovered === undefined ? recent : recent.filter((id) => available.includes(id));
  return [...new Set([...current, ...validRecent, ...available]), "Custom model..."];
}

export function getModelPickerWindow(count: number, selected: number, rows: number): { start: number; end: number } {
  const size = Math.max(1, rows - 15);
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), count - size));
  return { start, end: Math.min(count, start + size) };
}
