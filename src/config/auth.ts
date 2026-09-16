import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SUPPORTED_PROVIDERS = [
  "openai",
  "openai-codex",
  "openrouter",
  "anthropic",
  "ollama",
  "gemini"
] as const;
type AuthProvider = (typeof SUPPORTED_PROVIDERS)[number];

export interface ApiAuth {
  type: "api";
  key: string;
}

export interface OAuthAuth {
  type: "oauth";
  access: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
  clientId?: string;
  clientSecret?: string;
  tokenUri?: string;
  projectId?: string;
  scopes?: string[];
}

export type ProviderAuth = ApiAuth | OAuthAuth;
type AuthStore = Partial<Record<AuthProvider, ProviderAuth>>;

const AUTH_DIR = path.join(os.homedir(), ".local", "share", "patric");
const AUTH_FILE = path.join(AUTH_DIR, "auth.json");

interface LegacyCredentialInput {
  apiKey?: string;
  oauthToken?: string;
}

function normalizeProvider(provider: string): AuthProvider {
  const normalized = provider.trim().toLowerCase();
  if (SUPPORTED_PROVIDERS.includes(normalized as AuthProvider)) {
    return normalized as AuthProvider;
  }
  throw new Error(
    `Unsupported provider: ${provider}. Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`
  );
}

function loadAuthStore(): AuthStore {
  if (!fs.existsSync(AUTH_FILE)) {
    return {};
  }

  const raw = fs.readFileSync(AUTH_FILE, "utf8");
  const parsed = JSON.parse(raw) as AuthStore;
  return parsed || {};
}

function saveAuthStore(store: AuthStore): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(AUTH_FILE, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(AUTH_FILE, 0o600);
}

function getLegacyAuth(provider: string, legacy?: LegacyCredentialInput): ProviderAuth | undefined {
  const normalized = normalizeProvider(provider);
  if (!legacy) {
    return undefined;
  }
  if (normalized === "anthropic") {
    return legacy.apiKey ? { type: "api", key: legacy.apiKey } : undefined;
  }
  if (legacy.oauthToken) {
    return { type: "oauth", access: legacy.oauthToken };
  }
  if (legacy.apiKey) {
    return { type: "api", key: legacy.apiKey };
  }
  return undefined;
}

export function getAuthPath(): string {
  return AUTH_FILE;
}

export function getStoredAuth(provider: string): ProviderAuth | undefined {
  const normalized = normalizeProvider(provider);
  const store = loadAuthStore();
  const direct = store[normalized];
  if (direct) {
    return direct;
  }
  if (normalized === "openai-codex") {
    const legacyOpenAI = store.openai;
    if (legacyOpenAI?.type === "oauth") {
      return legacyOpenAI;
    }
  }
  return undefined;
}

export function getEffectiveAuth(
  provider: string,
  legacy?: LegacyCredentialInput
): ProviderAuth | undefined {
  return getStoredAuth(provider) || getLegacyAuth(provider, legacy);
}

export function hasEffectiveAuth(
  provider: string,
  legacy?: LegacyCredentialInput
): boolean {
  const normalized = normalizeProvider(provider);
  if (normalized === "ollama") {
    return true;
  }
  const auth = getEffectiveAuth(normalized, legacy);
  if (normalized === "anthropic" || normalized === "openai") {
    return auth?.type === "api" && Boolean(auth.key);
  }
  if (normalized === "openai-codex") {
    return auth?.type === "oauth" && Boolean(auth.access);
  }
  if (auth?.type === "oauth") {
    return Boolean(auth.access);
  }
  if (auth?.type === "api") {
    return Boolean(auth.key);
  }
  return false;
}

export function getEffectiveAuthStatus(
  provider: string,
  legacy?: LegacyCredentialInput
): string {
  const normalized = normalizeProvider(provider);
  if (normalized === "ollama") {
    return "local";
  }
  const auth = getEffectiveAuth(normalized, legacy);
  if (normalized === "anthropic") {
    return auth?.type === "api" && auth.key ? "ready" : "needs api key";
  }
  if (normalized === "openai") {
    return auth?.type === "api" && auth.key ? "ready" : "needs api key";
  }
  if (normalized === "openai-codex") {
    return auth?.type === "oauth" && auth.access ? "oauth" : "needs browser login";
  }
  if (!auth) {
    return "needs auth";
  }
  return auth.type === "oauth" ? "oauth" : "ready";
}

export function setStoredApiAuth(provider: string, key: string): void {
  const normalized = normalizeProvider(provider);
  const store = loadAuthStore();
  store[normalized] = { type: "api", key };
  saveAuthStore(store);
}

export function setStoredOAuthAuth(
  provider: string,
  access: string,
  options?: Omit<OAuthAuth, "type" | "access">
): void {
  const normalized = normalizeProvider(provider);
  const store = loadAuthStore();
  if (normalized === "openai-codex" && store.openai?.type === "oauth") {
    delete store.openai;
  }
  store[normalized] = {
    type: "oauth",
    access,
    ...(options || {})
  };
  saveAuthStore(store);
}

export function clearStoredAuth(provider: string): void {
  const normalized = normalizeProvider(provider);
  const store = loadAuthStore();
  if (normalized === "openai-codex" && store.openai?.type === "oauth") {
    delete store.openai;
  }
  delete store[normalized];
  saveAuthStore(store);
}

export function listStoredAuth(): Array<{ provider: string; type: ProviderAuth["type"] }> {
  const store = loadAuthStore();
  return Object.entries(store)
    .filter((entry): entry is [string, ProviderAuth] => Boolean(entry[1]))
    .map(([provider, auth]) => ({
      provider,
      type: auth.type
    }));
}
