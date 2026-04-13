import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setStoredApiAuth, setStoredOAuthAuth } from "./auth";

export interface PatricConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  oauthToken: string;
  systemPrompt: string;
  recentModels: Record<string, string[]>;
}

const SUPPORTED_PROVIDERS = [
  "openai",
  "openai-codex",
  "openrouter",
  "anthropic",
  "ollama",
  "gemini"
] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

const CONFIG_DIR = path.join(os.homedir(), ".config", "patric");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: PatricConfig = {
  provider: "openai",
  model: "",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  oauthToken: "",
  systemPrompt:
    "You are Patric, a pragmatic coding assistant. Be concise, accurate, and action-oriented. " +
    "You have access to tools for coding tasks: bash (run shell commands), read_file, write_file, " +
    "edit_file (find-and-replace), glob (find files by pattern), grep (search file contents), " +
    "list_directory, web_search, fetch_url, and browser (navigate and control web pages). " +
    "Use these tools proactively to explore the codebase, make edits, and verify your work. " +
    "Prefer edit_file for surgical changes and write_file only for new files or complete rewrites. " +
    "For browser tasks: navigate to a page, take a snapshot to see numbered element refs, " +
    "then use click/type/select with ref numbers to interact with the page. " +
    "You have read_memory and save_memory tools for persistent memory (USER.md, SOUL.md, PATRIC.md).",
  recentModels: {}
};

function isKnownDefaultBaseUrl(baseUrl: string): boolean {
  return SUPPORTED_PROVIDERS.some((provider) => getDefaultBaseUrl(provider) === baseUrl);
}

export function getDefaultBaseUrl(provider: string): string {
  switch (provider.trim().toLowerCase()) {
    case "openai-codex":
      return "https://chatgpt.com/backend-api";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "anthropic":
      return "https://api.anthropic.com";
    case "ollama":
      return "http://localhost:11434";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "openai":
    default:
      return "https://api.openai.com/v1";
  }
}

export function normalizeProviderName(provider: string): SupportedProvider {
  const normalized = provider.trim().toLowerCase();
  if (SUPPORTED_PROVIDERS.includes(normalized as SupportedProvider)) {
    return normalized as SupportedProvider;
  }
  throw new Error(
    `Unsupported provider: ${provider}. Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`
  );
}

export function normalizeModelForProvider(provider: string, model: string): string {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    return "";
  }

  switch (normalizeProviderName(provider)) {
    case "openai":
      return normalizedModel.replace(/^openai\//i, "");
    case "openai-codex":
      return normalizedModel.replace(/^openai-codex\//i, "");
    case "anthropic":
      return normalizedModel.replace(/^anthropic\//i, "");
    case "gemini":
      return normalizedModel.replace(/^google\//i, "");
    default:
      return normalizedModel;
  }
}

export function getModelCompatibilityError(provider: string, model: string): string | null {
  const normalizedProvider = normalizeProviderName(provider);
  const normalizedModel = normalizeModelForProvider(provider, model);

  if (!normalizedModel || normalizedProvider === "openrouter" || normalizedProvider === "ollama") {
    return null;
  }

  if (!normalizedModel.includes("/")) {
    return null;
  }

  switch (normalizedProvider) {
    case "openai":
      return `Model \`${model}\` is not a direct OpenAI model ID. Use models like \`gpt-5.4\` or switch provider to \`openrouter\`.`;
    case "openai-codex":
      return `Model \`${model}\` is not an OpenAI Codex model ID. Use models like \`gpt-5.4\` or \`gpt-5.3-codex\`.`;
    case "anthropic":
      return `Model \`${model}\` is not a direct Anthropic model ID. Use models like \`claude-sonnet-4-20250514\`.`;
    case "gemini":
      return `Model \`${model}\` is not a direct Gemini model ID. Use models like \`gemini-2.5-pro\` or \`gemini-2.5-flash\`.`;
    default:
      return null;
  }
}

const ALLOWED_CONFIG_KEYS = new Set<keyof PatricConfig>([
  "provider",
  "model",
  "baseUrl",
  "apiKey",
  "oauthToken",
  "systemPrompt",
  "recentModels"
]);

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function loadConfig(): PatricConfig {
  let fileConfig: Partial<PatricConfig> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    fileConfig = JSON.parse(raw) as Partial<PatricConfig>;
  }

  const provider = normalizeProviderName(
    process.env.PATRIC_PROVIDER || fileConfig.provider || DEFAULT_CONFIG.provider
  );
  const model = normalizeModelForProvider(
    provider,
    process.env.PATRIC_MODEL || fileConfig.model || DEFAULT_CONFIG.model
  );

  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    provider,
    model,
    baseUrl:
      process.env.PATRIC_BASE_URL || fileConfig.baseUrl || DEFAULT_CONFIG.baseUrl,
    apiKey: process.env.PATRIC_API_KEY || fileConfig.apiKey || DEFAULT_CONFIG.apiKey,
    oauthToken:
      process.env.PATRIC_OAUTH_TOKEN || fileConfig.oauthToken || DEFAULT_CONFIG.oauthToken,
    systemPrompt:
      process.env.PATRIC_SYSTEM_PROMPT ||
      fileConfig.systemPrompt ||
      DEFAULT_CONFIG.systemPrompt,
    recentModels: fileConfig.recentModels || DEFAULT_CONFIG.recentModels
  };
}

export function saveConfig(nextConfig: PatricConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
}

export function formatConfigSummary(config: PatricConfig): string {
  return [
    `provider: ${config.provider}`,
    `model: ${config.model || "(not set)"}`,
    `baseUrl: ${config.baseUrl}`
  ].join("\n");
}

export function rememberRecentModel(config: PatricConfig, provider: string, model: string): PatricConfig {
  const normalizedModel = normalizeModelForProvider(provider, model);
  if (!normalizedModel) {
    return config;
  }
  const normalizedProvider = normalizeProviderName(provider);
  const nextModels = [
    normalizedModel,
    ...(config.recentModels[normalizedProvider] || []).filter((item) => item !== normalizedModel)
  ].slice(0, 6);
  config.recentModels = {
    ...config.recentModels,
    [normalizedProvider]: nextModels
  };
  return config;
}

export function configureProvider(provider: string, model?: string): PatricConfig {
  const config = loadConfig();
  const oldProvider = normalizeProviderName(config.provider);
  const nextProvider = normalizeProviderName(provider);
  const oldDefaultBaseUrl = getDefaultBaseUrl(oldProvider);

  config.provider = nextProvider;
  if (!config.baseUrl || config.baseUrl === oldDefaultBaseUrl || isKnownDefaultBaseUrl(config.baseUrl)) {
    config.baseUrl = getDefaultBaseUrl(nextProvider);
  }
  if (model) {
    config.model = normalizeModelForProvider(nextProvider, model);
    rememberRecentModel(config, nextProvider, config.model);
  } else if (oldProvider !== nextProvider) {
    config.model = "";
  }

  saveConfig(config);
  return config;
}

export function setModel(model: string): PatricConfig {
  const config = loadConfig();
  config.model = normalizeModelForProvider(config.provider, model);
  rememberRecentModel(config, config.provider, config.model);
  saveConfig(config);
  return config;
}

export function setConfigValue(key: keyof PatricConfig | string, value: string): void {
  if (!ALLOWED_CONFIG_KEYS.has(key as keyof PatricConfig)) {
    throw new Error(`Unsupported config key: ${key}`);
  }
  if (key === "provider") {
    configureProvider(value);
  } else if (key === "apiKey") {
    const config = loadConfig();
    setStoredApiAuth(config.provider, value);
    config.apiKey = "";
    config.oauthToken = "";
    saveConfig(config);
  } else if (key === "oauthToken") {
    const config = loadConfig();
    setStoredOAuthAuth(config.provider, value);
    config.apiKey = "";
    config.oauthToken = "";
    saveConfig(config);
  } else {
    const config = loadConfig();
    config[key as keyof PatricConfig] = value;
    saveConfig(config);
  }
}
