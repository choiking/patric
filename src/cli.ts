import process from "node:process";
import type { PatricConfig } from "./config";
import { clearStoredAuth, getAuthPath, getEffectiveAuthStatus, hasEffectiveAuth, listStoredAuth } from "./auth";
import {
  configureProvider,
  formatConfigSummary,
  getConfigPath,
  loadConfig,
  setConfigValue,
  setModel
} from "./config";
import { loginWithAnthropicApiKey, loginWithGoogleOAuth, loginWithOpenAIOAuth } from "./oauth";
import { applyPatch, generatePatch } from "./patch";
import { startTui } from "./tui";
import { collectContext, getRepoInfo, listRepoFiles } from "./repo";
import { streamCompletion, type ToolEvent } from "./provider";
import { listDir, print, printError, readFileSafe, writeFileSafe, execCommand } from "./utils";

function usage(): string {
  return [
    "patric 0.3.0",
    "",
    "Usage:",
    "  patric                         Start interactive mode",
    "  patric chat <prompt>           Send a one-shot prompt",
    "  patric chat --context <prompt> Include repository context",
    "  patric repo                    Show repository status",
    "  patric context [paths...]      Print repository context",
    "  patric patch <prompt>          Generate a patch file from a prompt",
    "  patric apply <patch-file>      Validate and apply a patch file",
    "  patric settings                Open provider/model settings screen",
    "  patric status                  Show active model/provider setup",
    "  patric use <provider> [model]  Switch provider and optionally model",
    "  patric provider [name]         Show or set provider",
    "  patric model [name]            Show or set model",
    "  patric read <file>             Read a file",
    "  patric write <file> <content>  Write a file",
    "  patric exec <command>          Run a shell command",
    "  patric ls [dir]                List a directory",
    "  patric ls --repo [pattern]     List repository files",
    "  patric config show             Show active config",
    "  patric config path             Show config path",
    "  patric config set <k> <v>      Persist config value",
    "  patric auth login [provider]   Start browser OAuth login",
    "  patric auth list               Show stored provider credentials",
    "  patric auth path               Show auth store path",
    "  patric auth clear [provider]   Remove stored credentials",
    "  patric help                    Show this help",
    "",
    "Environment:",
    "  PATRIC_PROVIDER, PATRIC_API_KEY, PATRIC_OAUTH_TOKEN, PATRIC_GOOGLE_OAUTH_CLIENT_FILE, PATRIC_OPENAI_OAUTH_CLIENT_ID, PATRIC_BASE_URL, PATRIC_MODEL, PATRIC_SYSTEM_PROMPT"
  ].join("\n");
}

async function runChat(config: PatricConfig, rest: string[]): Promise<number> {
  const withContext = rest[0] === "--context";
  const prompt = (withContext ? rest.slice(1) : rest).join(" ").trim();
  if (!prompt) {
    printError("Usage: patric chat [--context] <prompt>");
    return 1;
  }

  const userContent = withContext
    ? `${prompt}\n\nRepository context:\n${collectContext(process.cwd())}`
    : prompt;
  const result = await streamCompletion(
    config,
    [
      { role: "system", content: config.systemPrompt },
      { role: "user", content: userContent }
    ],
    (chunk: string) => {
      process.stdout.write(chunk);
    },
    (event: ToolEvent) => {
      if (event.type === "tool_start") {
        process.stderr.write(`[tool] ${event.name}...\n`);
      } else if (event.type === "tool_end") {
        process.stderr.write(`[tool] ${event.name} done\n`);
      }
    }
  );

  if (result.ok && result.content) {
    print();
  }
  if (!result.ok) {
    print(result.content);
  }
  return result.ok ? 0 : 1;
}

function printSetupHint(config: PatricConfig): void {
  if (!hasEffectiveAuth(config.provider, config)) {
    if (config.provider === "gemini") {
      print("Next: patric auth login gemini --client-file <client_secret.json> or patric config set apiKey <gemini-key>");
    } else if (config.provider === "openai-codex") {
      print("Next: patric auth login openai-codex");
    } else if (config.provider === "openai") {
      print("Next: patric config set apiKey <openai-key> or patric use openai-codex gpt-5.4");
    } else if (config.provider === "anthropic") {
      print("Next: patric auth login anthropic or patric config set apiKey <anthropic-key>");
    } else if (config.provider !== "ollama") {
      print(`Next: patric config set apiKey <${config.provider}-key>`);
    }
  }
  if (!config.model) {
    print(`Next: patric model <name>`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = loadConfig();

  if (args.length === 0) {
    await startTui(config);
    return;
  }

  const [command, ...rest] = args;

  if (command === "help" || command === "--help" || command === "-h") {
    print(usage());
    return;
  }

  if (command === "--version" || command === "-v") {
    print("patric 0.3.0");
    return;
  }

  if (command === "chat") {
    process.exitCode = await runChat(config, rest);
    return;
  }

  if (command === "settings") {
    await startTui(config, { openSettings: true, closeAfterSettings: true });
    return;
  }

  if (command === "status") {
    print(`${formatConfigSummary(config)}\nauth: ${getEffectiveAuthStatus(config.provider, config)}`);
    return;
  }

  if (command === "use") {
    const provider = rest[0];
    const model = rest[1];
    if (!provider) {
      printError("Usage: patric use <provider> [model]");
      process.exitCode = 1;
      return;
    }
    try {
      const nextConfig = configureProvider(provider, model);
      print(`Using ${nextConfig.provider}${model ? ` with ${nextConfig.model}` : ""}`);
      print(formatConfigSummary(nextConfig));
      printSetupHint(nextConfig);
    } catch (error: unknown) {
      printError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  if (command === "provider") {
    const provider = rest[0];
    if (!provider) {
      print(config.provider);
      return;
    }
    try {
      const nextConfig = configureProvider(provider);
      print(`Provider set to ${nextConfig.provider}`);
      print(formatConfigSummary(nextConfig));
      printSetupHint(nextConfig);
    } catch (error: unknown) {
      printError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  if (command === "model") {
    const model = rest.join(" ").trim();
    if (!model) {
      print(config.model || "(not set)");
      return;
    }
    const nextConfig = setModel(model);
    print(`Model set to ${nextConfig.model}`);
    print(formatConfigSummary(nextConfig));
    return;
  }

  if (command === "repo") {
    const info = getRepoInfo(process.cwd());
    if (!info.isGitRepo) {
      print(`Repository root: ${process.cwd()}\nGit: not detected`);
      return;
    }
    print(
      [
        `Repository root: ${info.root}`,
        `Branch: ${info.branch}`,
        `Changed files: ${info.status.length}`,
        info.status.length ? `Status:\n${info.status.slice(0, 20).join("\n")}` : "Status: clean"
      ].join("\n")
    );
    return;
  }

  if (command === "context") {
    print(collectContext(process.cwd(), rest));
    return;
  }

  if (command === "patch") {
    const prompt = rest.join(" ").trim();
    if (!prompt) {
      printError("Usage: patric patch <prompt>");
      process.exitCode = 1;
      return;
    }
    const result = await generatePatch(config, process.cwd(), prompt, true);
    if (!result.ok) {
      printError(result.content);
      process.exitCode = 1;
      return;
    }
    print(`Saved patch: ${result.patchPath}`);
    return;
  }

  if (command === "apply") {
    const patchFile = rest[0];
    if (!patchFile) {
      printError("Usage: patric apply <patch-file>");
      process.exitCode = 1;
      return;
    }
    const result = applyPatch(process.cwd(), patchFile);
    print(`Applied patch: ${result.patchFile}`);
    print(`Repository root: ${result.root}`);
    return;
  }

  if (command === "read") {
    const target = rest[0];
    if (!target) {
      printError("Usage: patric read <file>");
      process.exitCode = 1;
      return;
    }
    const result = readFileSafe(target, process.cwd());
    print(result.content);
    return;
  }

  if (command === "write") {
    const target = rest[0];
    const content = rest.slice(1).join(" ");
    if (!target || !content) {
      printError("Usage: patric write <file> <content>");
      process.exitCode = 1;
      return;
    }
    print(writeFileSafe(target, content, process.cwd()));
    return;
  }

  if (command === "exec") {
    const shellCommand = rest.join(" ").trim();
    if (!shellCommand) {
      printError("Usage: patric exec <command>");
      process.exitCode = 1;
      return;
    }
    print(execCommand(shellCommand, process.cwd()));
    return;
  }

  if (command === "ls") {
    const target = rest[0] || "";
    if (target === "--repo") {
      print(listRepoFiles(process.cwd(), rest[1] || "").join("\n"));
      return;
    }
    print(listDir(target, process.cwd()).join("\n"));
    return;
  }

  if (command === "config") {
    const subcommand = rest[0];
    if (subcommand === "show") {
      print(formatConfigSummary(config));
      return;
    }
    if (subcommand === "path") {
      print(getConfigPath());
      return;
    }
    if (subcommand === "set") {
      const key = rest[1];
      const value = rest.slice(2).join(" ");
      if (!key || !value) {
        printError("Usage: patric config set <key> <value>");
        process.exitCode = 1;
        return;
      }
      try {
        setConfigValue(key, value);
        print(`Saved ${key}`);
      } catch (error: unknown) {
        printError(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
      return;
    }
    printError("Usage: patric config <show|path|set>");
    process.exitCode = 1;
    return;
  }

  if (command === "auth") {
    const subcommand = rest[0];
    if (subcommand === "login") {
      let provider = config.provider;
      let clientFile = "";
      let noBrowser = false;
      let sawProvider = false;
      for (let index = 1; index < rest.length; index += 1) {
        const arg = rest[index];
        if (arg === "--client-file") {
          clientFile = rest[index + 1] || "";
          index += 1;
          continue;
        }
        if (arg === "--no-browser") {
          noBrowser = true;
          continue;
        }
        if (!sawProvider && !arg.startsWith("--")) {
          provider = arg;
          sawProvider = true;
          continue;
        }
        printError("Usage: patric auth login [provider] [--client-file <path>] [--no-browser]");
        process.exitCode = 1;
        return;
      }
      if (provider !== "gemini") {
        if (provider === "openai") {
          printError(
            "`openai` now means the direct OpenAI Platform API and uses API keys here. Use `patric auth login openai-codex` for ChatGPT browser OAuth."
          );
          process.exitCode = 1;
          return;
        }
        if (provider === "openai-codex") {
          if (clientFile) {
            printError("`--client-file` is only supported for `gemini`.");
            process.exitCode = 1;
            return;
          }
          try {
            print("Starting OpenAI Codex OAuth login...");
            const result = await loginWithOpenAIOAuth({
              provider: "openai-codex",
              noBrowser,
              onAuthUrl: (url, openedBrowser) => {
                if (openedBrowser) {
                  print("Opened browser for OpenAI Codex OAuth login.");
                  return;
                }
                print("Open this URL in your browser to continue:");
                print(url);
              }
            });
            print(`Stored ${result.provider} OAuth credentials.`);
          } catch (error: unknown) {
            printError(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
          }
          return;
        }
        if (provider === "anthropic") {
          if (clientFile) {
            printError("`--client-file` is only supported for `gemini`.");
            process.exitCode = 1;
            return;
          }
          try {
            const result = await loginWithAnthropicApiKey({ noBrowser });
            if (result.openedBrowser) {
              print("Opened browser to Anthropic API keys page.");
            } else {
              print("Visit https://console.anthropic.com/settings/keys to get your API key.");
            }
            print(`Stored ${result.provider} API credentials.`);
          } catch (error: unknown) {
            printError(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
          }
          return;
        }
        printError("Browser login is currently supported for `anthropic`, `gemini`, and `openai-codex` only.");
        process.exitCode = 1;
        return;
      }
      try {
        print("Starting Gemini OAuth login...");
        const result = await loginWithGoogleOAuth({
          clientFile: clientFile || undefined,
          noBrowser,
          onAuthUrl: (url, openedBrowser) => {
            if (openedBrowser) {
              print("Opened browser for Gemini OAuth login.");
              return;
            }
            print("Open this URL in your browser to continue:");
            print(url);
          }
        });
        print(`Stored ${result.provider} OAuth credentials.`);
      } catch (error: unknown) {
        printError(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
      return;
    }
    if (subcommand === "list") {
      const entries = listStoredAuth();
      if (entries.length === 0) {
        print("No stored credentials.");
        return;
      }
      print(entries.map((entry) => `${entry.provider}: ${entry.type}`).join("\n"));
      return;
    }
    if (subcommand === "path") {
      print(getAuthPath());
      return;
    }
    if (subcommand === "clear") {
      const provider = rest[1] || config.provider;
      clearStoredAuth(provider);
      print(`Cleared stored auth for ${provider}`);
      return;
    }
    printError("Usage: patric auth <login [provider] [--client-file <path>] [--no-browser]|list|path|clear [provider]>");
    process.exitCode = 1;
    return;
  }

  printError(`Unknown command: ${command}`);
  print(usage());
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  printError(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
