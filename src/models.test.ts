import { afterEach, expect, spyOn, test } from "bun:test";
import { fetchModelCatalog, getModelOptions, getModelPickerWindow } from "./models.js";
import type { PatricConfig } from "./config.js";

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => fetchSpy?.mockRestore());

function mockCatalog(handler: (url: URL, init: RequestInit) => any) {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: RequestInit = {}) => {
    const result = handler(new URL(String(input)), init);
    return result instanceof Response ? result : Response.json(result);
  });
}

function discover(provider: string, signal?: AbortSignal) {
  const prefix = ["anthropic", "ollama", "openai-codex"].includes(provider) ? "" : "/v1";
  return fetchModelCatalog({ provider, baseUrl: `https://provider.example${prefix}/`, headers: { authorization: "Bearer test" }, signal });
}

test("OpenAI ranks newly released models first without a fixed model list", async () => {
  mockCatalog((url, init) => {
    expect(url.pathname).toBe("/v1/models");
    expect(init.headers).toEqual({ authorization: "Bearer test" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return { data: [
      { id: "gpt-5.4", created: 100 },
      { id: "gpt-future", created: 200 },
      { id: "gpt-future", created: 200 },
      { id: "text-embedding-3-small", created: 300 },
      { id: "gpt-image-1", created: 300 },
      { id: "ft:gpt-4o:custom", created: 150 },
      { id: "" }, null
    ] };
  });
  expect(await discover("openai")).toEqual(["gpt-future", "ft:gpt-4o:custom", "gpt-5.4"]);
});

test("Codex uses its own catalog, hides hidden models, and preserves provider priority", async () => {
  mockCatalog((url) => {
    expect(url.pathname).toBe("/codex/models");
    expect(url.searchParams.get("client_version")).toBeTruthy();
    return { models: [
      { slug: "older-model", priority: 20, visibility: "list" },
      { slug: "internal", priority: 0, visibility: "hide" },
      { slug: "new-model", priority: 1, visibility: "list" }
    ] };
  });
  expect(await discover("openai-codex")).toEqual(["new-model", "older-model"]);
});

test("Anthropic follows pagination and deduplicates models", async () => {
  const cursors: Array<string | null> = [];
  mockCatalog((url) => {
    cursors.push(url.searchParams.get("after_id"));
    expect(url.pathname).toBe("/v1/models");
    expect(url.searchParams.get("limit")).toBe("1000");
    return cursors.length === 1
      ? { data: [{ id: "claude-new" }], has_more: true, last_id: "claude-new" }
      : { data: [{ id: "claude-new" }, { id: "claude-older" }], has_more: false };
  });
  expect(await discover("anthropic")).toEqual(["claude-new", "claude-older"]);
  expect(cursors).toEqual([null, "claude-new"]);
});

test("Gemini follows page tokens and only offers content generation models", async () => {
  mockCatalog((url) => url.searchParams.has("pageToken")
    ? { models: [{ name: "models/gemini-next", supportedGenerationMethods: ["generateContent"] }] }
    : { models: [
      { name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-current", supportedGenerationMethods: ["generateContent"] }
    ], nextPageToken: "next page" });
  expect(await discover("gemini")).toEqual(["gemini-current", "gemini-next"]);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

test("OpenRouter retains provider-qualified model IDs", async () => {
  mockCatalog(() => ({ data: [{ id: "vendor/z-model" }, { id: "vendor/a-model" }] }));
  expect(await discover("openrouter")).toEqual(["vendor/a-model", "vendor/z-model"]);
});

test("Ollama lists installed model names and tags", async () => {
  mockCatalog((url) => {
    expect(url.pathname).toBe("/api/tags");
    return { models: [{ name: "qwen3:8b" }, { name: "qwen3:4b" }] };
  });
  expect(await discover("ollama")).toEqual(["qwen3:4b", "qwen3:8b"]);
});

test("HTTP and malformed catalog errors remain visible to the caller", async () => {
  mockCatalog(() => new Response("unauthorized", { status: 401 }));
  await expect(discover("openai")).rejects.toThrow("401");
  fetchSpy?.mockRestore();
  mockCatalog(() => ({ unexpected: [] }));
  await expect(discover("openai")).rejects.toThrow("invalid model list");
});

test("repeated and missing pagination cursors fail instead of looping or returning partial data", async () => {
  mockCatalog(() => ({ data: [], has_more: true, last_id: "same" }));
  await expect(discover("anthropic")).rejects.toThrow("cursor");
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  fetchSpy?.mockRestore();
  mockCatalog(() => ({ data: [], has_more: true }));
  await expect(discover("anthropic")).rejects.toThrow("cursor");
});

test("cancellation reaches the catalog fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  mockCatalog((_url, init) => {
    init.signal!.throwIfAborted();
    return { data: [] };
  });
  await expect(discover("openai", controller.signal)).rejects.toThrow();
});

const config = {
  provider: "openai", model: "selected", recentModels: { openai: ["retired", "live"] }
} as PatricConfig;

test("live catalogs replace stale suggestions but keep the selected model", () => {
  expect(getModelOptions(config, ["new", "live"], ["fallback"]))
    .toEqual(["selected", "live", "new", "Custom model..."]);
  expect(getModelOptions(config, undefined, ["fallback"]))
    .toEqual(["selected", "retired", "live", "fallback", "Custom model..."]);
  expect(getModelOptions(config, [], ["fallback"]))
    .toEqual(["selected", "Custom model..."]);
});

test("every model remains reachable in a terminal-sized scrolling window", () => {
  for (const rows of [18, 24, 40]) {
    for (let selected = 0; selected < 1000; selected++) {
      const { start, end } = getModelPickerWindow(1000, selected, rows);
      expect(start).toBeLessThanOrEqual(selected);
      expect(end).toBeGreaterThan(selected);
      expect(end - start).toBeLessThanOrEqual(rows - 15);
      expect(end).toBeLessThanOrEqual(1000);
    }
  }
});
