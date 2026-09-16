# Patric

`patric` is a Coding Cli works like a OpenClaw

It is not a wrapper around Claude. It has its own entrypoint, command parser,
interactive mode, local file helpers, shell helpers, and a provider layer for
connecting to direct OpenAI, ChatGPT Codex, OpenRouter, Anthropic, Ollama, and Gemini models.

## Features

- Interactive REPL with slash commands
- One-shot chat mode
- Streaming model output
- Repository inspection and context collection
- Patch generation and patch application
- Saved sub-agents with parallel delegation
- Local file read and write commands
- Shell command execution
- Config file stored at `~/.config/patric/config.json`
- Multi-provider support: direct OpenAI, OpenAI Codex, OpenRouter, Anthropic, Ollama, Gemini

## Desktop app

Patric includes an Electron desktop app with streaming chat, project selection,
per-project conversation history, provider/model settings, live model discovery,
and tool activity. File changes and command execution require an **Allow once**
decision in the desktop window. Existing CLI credentials are reused; API keys are
not sent back to the renderer.

```bash
bun install
bun run desktop
```

The first launch downloads Electron if needed. Desktop development and packaging
require Bun and Node.js 22.12+ (the CLI still supports its existing runtime).
Build a native app for the current platform and architecture:

```bash
bun run desktop:build
```

On Apple Silicon, open `dist/Patric-darwin-arm64/Patric.app`. The bundle includes
Bun, so the packaged app does not require a separate Bun installation. Builds are
unsigned local builds; signing, notarization, installers, and automatic updates
are not configured. Other platforms have not been tested.

Choose a project using the workspace button. Settings share the CLI config at
`~/.config/patric/config.json`; environment overrides apply to both interfaces.
OAuth login still runs through the CLI (`patric auth login openai-codex` or the
existing Gemini login flow). Conversation text is stored locally in Electron's
app data, with up to 50 recent conversations. Tool logs are shown for the current
turn but are not persisted. `Cmd/Ctrl+N` starts a conversation, `Cmd/Ctrl+,` opens
settings, Enter sends, and Shift+Enter adds a newline.

**Stop** cancels model output and prevents subsequent tools from starting. An
already-running shell command or browser action may finish. Closing the app while
working asks for confirmation. Desktop approvals are scoped to a single action;
saved CLI tool allowances are not automatically applied in the desktop app.
Browser tools retain the CLI's existing Playwright/browser setup requirements.

Validation: `bun test` includes mock-provider desktop integration tests for
credential redaction, input validation, overlapping requests, denied/approved
file writes, and stopping at an approval prompt. These tests need permission to
bind a localhost port. The renderer uses a sandboxed preload bridge and context
isolation following [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

## Usage

```bash
patric
patric settings
patric status
patric models
patric use ollama qwen3
patric use anthropic claude-sonnet-4-20250514
patric chat "summarize this repository"
patric chat --context "review the current repo"
patric repo
patric context package.json src
patric agents list
patric agents show reviewer
patric agents run reviewer "review src/provider.ts for correctness issues"
patric patch "rename the config loader to settings loader"
patric apply .patric/patches/20260310-123000.patch
patric read src/index.js
patric exec "npm test"
patric config show
```

## Configuration

Preferred UI:

```bash
patric settings
```

This opens a separate full-screen terminal settings view for provider, model,
API key, and base URL.

The model picker fetches the active provider's live catalog each time it opens.
This supports OpenAI, ChatGPT Codex, OpenRouter, Anthropic, Ollama, and Gemini.
Use `/models` in chat, or choose **Model** in settings; press **R** to refresh
without leaving the picker. Arrow keys scroll through the full list. Use
`patric models` to fetch the catalog from the command line.

Successful responses replace the built-in fallback suggestions. Your selected
model stays available, and **Custom model...** lets you enter an ID manually.
If discovery fails, the picker keeps its last successful list for that session,
or shows fallback suggestions if none were loaded. Catalog requests time out
after 15 seconds. Discovery does not change your selected model.

Codex discovery uses the ChatGPT backend catalog and your Patric browser login;
that endpoint is separate from the public OpenAI Models API and may change.
`PATRIC_CODEX_CLIENT_VERSION` overrides its catalog compatibility version
(default `0.153.4`) if the backend requires a newer client version.

Environment variables:

- `PATRIC_API_KEY`
- `PATRIC_OAUTH_TOKEN`
- `PATRIC_GOOGLE_OAUTH_CLIENT_FILE`
- `PATRIC_OPENAI_OAUTH_CLIENT_ID`
- `PATRIC_PROVIDER`
- `PATRIC_BASE_URL`
- `PATRIC_MODEL`
- `PATRIC_SYSTEM_PROMPT`

Recommended setup:

```bash
patric use openai-codex gpt-5.4
patric auth login openai-codex
```

Or:

```bash
patric use ollama qwen3
patric status
```

Low-level config is still available:

```bash
patric config set provider openai
patric config set model gpt-5.4
patric config set baseUrl https://api.openai.com/v1
```

Provider values:

- `openai`
- `openai-codex`
- `openrouter`
- `anthropic`
- `ollama`
- `gemini`

Examples:

```bash
patric use openrouter openai/gpt-4.1-mini
patric config set apiKey <openrouter-key>

patric use anthropic claude-sonnet-4-20250514
patric config set apiKey <anthropic-key>

patric use ollama qwen3

patric use gemini gemini-2.5-flash
patric config set apiKey <gemini-key>

patric use gemini gemini-2.5-flash
patric auth login gemini --client-file ./client_secret.json

patric use openai gpt-5.4
patric config set apiKey <openai-key>

patric use openai-codex gpt-5.4
patric auth login openai-codex

patric auth list
patric auth path
patric auth clear gemini
```

Notes:

- `openai` is the direct OpenAI Platform API path in Patric and uses API keys.
- `openai-codex` is the ChatGPT/Codex path in Patric and uses browser OAuth against `auth.openai.com`, with requests routed to the ChatGPT Codex backend.
- `patric auth login openai-codex` opens a localhost browser flow and stores the resulting OpenAI Codex OAuth credential in Patric's auth store.
- `patric auth login gemini` requires a Google desktop OAuth client JSON file.
- `anthropic` remains API-key only in Patric because this provider path uses Anthropic's public API directly.

## Interactive Commands

- `/help`
- `/pwd`
- `/cd <dir>`
- `/ls [dir]`
- `/read <file>`
- `/write <file> <content>`
- `/exec <command>`
- `/repo`
- `/context [paths...]`
- `/agents`
- `/agent run <name> <prompt>`
- `/patch <prompt>`
- `/apply <patch-file>`
- `/settings`
- `/model [name]`
- `/models`
- `/exit`

## Project Layout

- `bin/patric`: shell launcher
- `src/cli.ts`: command router
- `src/repl.ts`: interactive shell
- `src/provider.ts`: LLM provider client
- `src/config.ts`: config loading and saving
- `src/settings.ts`: full-screen settings UI
- `src/repo.ts`: repository inspection and context building
- `src/patch.ts`: patch generation and application helpers

## Sub-Agents

Patric can load saved sub-agents from:

- `.patric/agents/*.md` in the current project
- `~/.config/patric/agents/*.md` for user-wide agents

Project agents override user agents with the same `name`.

Agent files use Markdown with YAML frontmatter:

```md
---
name: reviewer
description: Review code for bugs and regressions
tools:
  - read_file
  - grep
  - bash
model: gpt-5.4
---
Focus on correctness, behavioral regressions, and missing tests.
```

CLI:

- `patric agents list`
- `patric agents show <name>`
- `patric agents run <name> <prompt>`

In chat, Patric can automatically delegate to saved agents with `spawn_agent`, `wait_agent`, `list_agents`, and `cancel_agent`.
