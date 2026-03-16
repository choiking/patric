import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { setStoredApiAuth, setStoredOAuthAuth, type OAuthAuth } from "./auth";

const GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/generative-language.retriever"
];
const OPENAI_ISSUER = "https://auth.openai.com";
const OPENAI_AUTH_URI = `${OPENAI_ISSUER}/oauth/authorize`;
const OPENAI_TOKEN_URI = `${OPENAI_ISSUER}/oauth/token`;
const OPENAI_CLIENT_ID =
  process.env.PATRIC_OPENAI_OAUTH_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_ORIGINATOR = "codex_cli_rs";
const OPENAI_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access"
];
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

interface GoogleClientConfig {
  clientId: string;
  clientSecret?: string;
  projectId?: string;
  authUri: string;
  tokenUri: string;
}

interface GoogleClientFile {
  installed?: {
    client_id?: string;
    client_secret?: string;
    project_id?: string;
    auth_uri?: string;
    token_uri?: string;
  };
}

interface LoopbackResult {
  server: http.Server;
  redirectUri: string;
  waitForCallback: Promise<{ code: string; state: string }>;
}

interface LoopbackServerOptions {
  port?: number;
  host?: string;
  redirectHost?: string;
  callbackPath?: string;
}

interface OpenAIOAuthTokens {
  access: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
}

export interface OAuthLoginResult {
  provider: string;
  openedBrowser: boolean;
  authUrl: string;
}

interface OpenAIJwtClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id?: string }>;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

function toBase64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createCodeVerifier(): string {
  return toBase64Url(crypto.randomBytes(48));
}

function createCodeChallenge(verifier: string): string {
  return toBase64Url(crypto.createHash("sha256").update(verifier).digest());
}

function parseJwtClaims(token: string): OpenAIJwtClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as OpenAIJwtClaims;
  } catch {
    return undefined;
  }
}

function extractOpenAIAccountIdFromClaims(claims: OpenAIJwtClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  );
}

export function extractOpenAIAccountId(token: string): string | undefined {
  if (!token.trim()) {
    return undefined;
  }
  const claims = parseJwtClaims(token);
  return claims ? extractOpenAIAccountIdFromClaims(claims) : undefined;
}

export function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const platform = process.platform;
    const command =
      platform === "darwin"
        ? { cmd: "open", args: [url] }
        : platform === "win32"
          ? { cmd: "cmd", args: ["/c", "start", "", url] }
          : { cmd: "xdg-open", args: [url] };
    const child = spawn(command.cmd, command.args, {
      stdio: "ignore",
      detached: platform !== "win32"
    });
    let settled = false;
    child.once("error", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
    child.once("spawn", () => {
      if (!settled) {
        settled = true;
        if (platform !== "win32") {
          child.unref();
        }
        resolve(true);
      }
    });
  });
}

function loadGoogleClientConfig(filePath: string): GoogleClientConfig {
  const fullPath = path.resolve(process.cwd(), filePath);
  const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8")) as GoogleClientFile;
  const installed = parsed.installed;
  if (!installed?.client_id) {
    throw new Error(`Invalid Google OAuth client file: ${fullPath}`);
  }
  return {
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
    projectId: installed.project_id,
    authUri: installed.auth_uri || GOOGLE_AUTH_URI,
    tokenUri: installed.token_uri || GOOGLE_TOKEN_URI
  };
}

function resolveGoogleClientFile(explicitPath?: string): string {
  const candidates = [
    explicitPath,
    process.env.PATRIC_GOOGLE_OAUTH_CLIENT_FILE,
    path.join(process.cwd(), "client_secret.json")
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const fullPath = path.resolve(process.cwd(), candidate);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  throw new Error(
    "Google OAuth client file not found. Pass `--client-file <path>` or set PATRIC_GOOGLE_OAUTH_CLIENT_FILE."
  );
}

function startLoopbackServer(options?: LoopbackServerOptions): Promise<LoopbackResult> {
  const callbackPath = options?.callbackPath || "/";
  const listenHost = options?.host;
  const redirectHost = options?.redirectHost || listenHost || "127.0.0.1";
  return new Promise((resolve, reject) => {
    let resolveCallback!: (value: { code: string; state: string }) => void;
    let rejectCallback!: (error: Error) => void;
    const waitForCallback = new Promise<{ code: string; state: string }>((resolveInner, rejectInner) => {
      resolveCallback = resolveInner;
      rejectCallback = rejectInner;
    });
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname !== callbackPath) {
        response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        response.end("<html><body><h1>Not found</h1></body></html>");
        return;
      }
      if (requestUrl.searchParams.get("error")) {
        const error = requestUrl.searchParams.get("error") || "OAuth error";
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(`<html><body><h1>Authentication failed</h1><p>${error}</p></body></html>`);
        rejectCallback(new Error(error));
        return;
      }
      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state");
      if (!code || !state) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end("<html><body><h1>Missing OAuth code</h1></body></html>");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<html><body><h1>Authentication complete</h1><p>You can return to Patric.</p></body></html>"
      );
      resolveCallback({ code, state });
    });

    server.once("error", (error) => reject(error));
    const onListen = () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind OAuth callback server."));
        return;
      }
      const normalizedPath = callbackPath.startsWith("/") ? callbackPath : `/${callbackPath}`;
      resolve({
        server,
        redirectUri: `http://${redirectHost}:${address.port}${normalizedPath}`,
        waitForCallback
      });
    };
    if (listenHost) {
      server.listen(options?.port || 0, listenHost, onListen);
      return;
    }
    server.listen(options?.port || 0, onListen);
  });
}

async function exchangeGoogleCode(
  client: GoogleClientConfig,
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<OAuthAuth> {
  const body = new URLSearchParams({
    code,
    client_id: client.clientId,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier
  });
  if (client.clientSecret) {
    body.set("client_secret", client.clientSecret);
  }

  const response = await fetch(client.tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  if (typeof data.access_token !== "string") {
    throw new Error("Google OAuth token exchange returned no access token.");
  }

  return {
    type: "oauth",
    access: data.access_token,
    refresh: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expires: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    tokenUri: client.tokenUri,
    projectId: client.projectId,
    scopes: GOOGLE_SCOPES
  };
}

async function exchangeOpenAICode(
  code: string,
  codeVerifier: string
): Promise<OpenAIOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: OPENAI_REDIRECT_URI,
    client_id: OPENAI_CLIENT_ID,
    code_verifier: codeVerifier
  });
  const response = await fetch(OPENAI_TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) {
    throw new Error(`OpenAI token exchange failed (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  if (typeof data.access_token !== "string") {
    throw new Error("OpenAI OAuth token exchange returned no access token.");
  }

  return {
    access: data.access_token,
    refresh: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expires: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
    accountId: extractOpenAIAccountId(data.access_token)
  };
}

export async function refreshGoogleOAuth(auth: OAuthAuth): Promise<OAuthAuth> {
  if (!auth.refresh || !auth.clientId) {
    return auth;
  }
  if (!auth.expires || auth.expires > Date.now() + 30_000) {
    return auth;
  }

  const body = new URLSearchParams({
    client_id: auth.clientId,
    refresh_token: auth.refresh,
    grant_type: "refresh_token"
  });
  if (auth.clientSecret) {
    body.set("client_secret", auth.clientSecret);
  }

  const response = await fetch(auth.tokenUri || GOOGLE_TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) {
    throw new Error(`Google OAuth refresh failed (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  if (typeof data.access_token !== "string") {
    throw new Error("Google OAuth refresh returned no access token.");
  }

  return {
    ...auth,
    access: data.access_token,
    expires: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : auth.expires,
    refresh: typeof data.refresh_token === "string" ? data.refresh_token : auth.refresh
  };
}

export async function refreshOpenAIOAuth(auth: OAuthAuth): Promise<OAuthAuth> {
  if (!auth.refresh) {
    return auth;
  }
  if (!auth.expires || auth.expires > Date.now() + 30_000) {
    return auth;
  }

  const body = new URLSearchParams({
    client_id: auth.clientId || OPENAI_CLIENT_ID,
    refresh_token: auth.refresh,
    grant_type: "refresh_token"
  });
  const response = await fetch(auth.tokenUri || OPENAI_TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) {
    throw new Error(`OpenAI OAuth refresh failed (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  if (typeof data.access_token !== "string") {
    throw new Error("OpenAI OAuth refresh returned no access token.");
  }

  return {
    ...auth,
    access: data.access_token,
    expires: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : auth.expires,
    refresh: typeof data.refresh_token === "string" ? data.refresh_token : auth.refresh,
    accountId: extractOpenAIAccountId(data.access_token) || auth.accountId,
    clientId: auth.clientId || OPENAI_CLIENT_ID,
    tokenUri: auth.tokenUri || OPENAI_TOKEN_URI,
    scopes: auth.scopes || OPENAI_SCOPES
  };
}

export async function loginWithGoogleOAuth(options?: {
  clientFile?: string;
  noBrowser?: boolean;
  onAuthUrl?: (url: string, openedBrowser: boolean) => void | Promise<void>;
}): Promise<OAuthLoginResult> {
  const clientFile = resolveGoogleClientFile(options?.clientFile);
  const client = loadGoogleClientConfig(clientFile);
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  const state = toBase64Url(crypto.randomBytes(24));
  const loopback = await startLoopbackServer();
  const authUrl = new URL(client.authUri || GOOGLE_AUTH_URI);
  authUrl.searchParams.set("client_id", client.clientId);
  authUrl.searchParams.set("redirect_uri", loopback.redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  const openedBrowser = options?.noBrowser ? false : await openBrowser(authUrl.toString());
  await options?.onAuthUrl?.(authUrl.toString(), openedBrowser);

  let callback;
  try {
    callback = await Promise.race([
      loopback.waitForCallback,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for OAuth callback.")), AUTH_TIMEOUT_MS)
      )
    ]);
  } finally {
    await new Promise<void>((resolveClose) => {
      loopback.server.close(() => resolveClose());
    });
  }

  if (callback.state !== state) {
    throw new Error("OAuth state verification failed.");
  }

  const tokens = await exchangeGoogleCode(client, callback.code, codeVerifier, loopback.redirectUri);
  setStoredOAuthAuth("gemini", tokens.access, {
    refresh: tokens.refresh,
    expires: tokens.expires,
    clientId: tokens.clientId,
    clientSecret: tokens.clientSecret,
    tokenUri: tokens.tokenUri,
    projectId: tokens.projectId,
    scopes: tokens.scopes
  });

  return {
    provider: "gemini",
    openedBrowser,
    authUrl: authUrl.toString()
  };
}

const ANTHROPIC_KEYS_URL = "https://console.anthropic.com/settings/keys";

export async function loginWithAnthropicApiKey(options?: {
  noBrowser?: boolean;
}): Promise<{ provider: string; openedBrowser: boolean }> {
  const openedBrowser = options?.noBrowser ? false : await openBrowser(ANTHROPIC_KEYS_URL);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true
  });

  const key = await new Promise<string>((resolve, reject) => {
    // Disable echo so the key is not visible while pasting
    if (process.stdin.isTTY) {
      process.stdin.setRawMode?.(true);
    }
    process.stderr.write("Paste your Anthropic API key: ");
    let input = "";
    const onData = (chunk: Buffer) => {
      const str = chunk.toString();
      for (const ch of str) {
        if (ch === "\n" || ch === "\r") {
          process.stderr.write("\n");
          process.stdin.removeListener("data", onData);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode?.(false);
          }
          rl.close();
          resolve(input.trim());
          return;
        }
        if (ch === "\u0003") {
          // Ctrl+C
          process.stderr.write("\n");
          process.stdin.removeListener("data", onData);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode?.(false);
          }
          rl.close();
          reject(new Error("Cancelled."));
          return;
        }
        if (ch === "\u007F" || ch === "\b") {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
          }
          continue;
        }
        input += ch;
      }
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });

  if (!key) {
    throw new Error("No API key provided.");
  }

  setStoredApiAuth("anthropic", key);
  return { provider: "anthropic", openedBrowser };
}

export async function loginWithOpenAIOAuth(options?: {
  provider?: "openai" | "openai-codex";
  noBrowser?: boolean;
  onAuthUrl?: (url: string, openedBrowser: boolean) => void | Promise<void>;
}): Promise<OAuthLoginResult> {
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  const state = toBase64Url(crypto.randomBytes(24));
  let loopback: LoopbackResult;
  try {
    loopback = await startLoopbackServer({
      port: 1455,
      host: "localhost",
      redirectHost: "localhost",
      callbackPath: "/auth/callback"
    });
  } catch (error: unknown) {
    const bindError = error as { code?: string } | null;
    if (bindError?.code === "EADDRINUSE") {
      throw new Error("OpenAI OAuth callback port 1455 is already in use. Close the other process and retry.");
    }
    throw error;
  }
  const authUrl = new URL(OPENAI_AUTH_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", OPENAI_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", OPENAI_REDIRECT_URI);
  authUrl.searchParams.set("scope", OPENAI_SCOPES.join(" "));
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("id_token_add_organizations", "true");
  authUrl.searchParams.set("codex_cli_simplified_flow", "true");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("originator", OPENAI_ORIGINATOR);

  const openedBrowser = options?.noBrowser ? false : await openBrowser(authUrl.toString());
  await options?.onAuthUrl?.(authUrl.toString(), openedBrowser);

  let callback;
  try {
    callback = await Promise.race([
      loopback.waitForCallback,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for OAuth callback.")), AUTH_TIMEOUT_MS)
      )
    ]);
  } finally {
    await new Promise<void>((resolveClose) => {
      loopback.server.close(() => resolveClose());
    });
  }

  if (callback.state !== state) {
    throw new Error("OAuth state verification failed.");
  }

  const tokens = await exchangeOpenAICode(callback.code, codeVerifier);
  const provider = options?.provider || "openai-codex";
  setStoredOAuthAuth(provider, tokens.access, {
    refresh: tokens.refresh,
    expires: tokens.expires,
    accountId: tokens.accountId,
    clientId: OPENAI_CLIENT_ID,
    tokenUri: OPENAI_TOKEN_URI,
    scopes: OPENAI_SCOPES
  });

  return {
    provider,
    openedBrowser,
    authUrl: authUrl.toString()
  };
}
