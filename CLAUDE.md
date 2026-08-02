# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Toolchain and commands

This repository pins Bun 1.3.11. It has separate root and `launcher/` dependency trees and lockfiles.

```bash
# Install dependencies exactly as CI does
bun install --frozen-lockfile
bun install --cwd launcher --frozen-lockfile

# Run the Electron launcher from source; this installs locked deps when needed
bun run app

# Core daemon/CLI
bun run start                 # serve the local Responses bridge
bun run setup
bun run doctor

# Focused checks
bun run typecheck             # root TypeScript
bun run test                  # root Bun tests
bun run launcher:typecheck
bun run launcher:test         # launcher Node tests
bun run launcher:build        # typecheck + Vite renderer build
bun run build                 # build the distributable runtime bundle

# Canonical pre-PR verification: audit, both typechecks/test suites, builds,
# notices generation, and runtime smoke test
bun run verify

# Native desktop packaging and packaged-app smoke test
bun run app:package
bun run app:smoke
```

There is no project ESLint/Prettier command. GitHub Actions runs `actionlint` separately for workflow YAML.

Run a single test file with the repository's native runners:

```bash
bun test tests/cli.test.ts
node --test launcher/tests/state.test.cjs
```

Filter by test name when useful:

```bash
bun test tests/cli.test.ts -t "test name"
node --test --test-name-pattern="test name" launcher/tests/state.test.cjs
```

Packaging must run on the target operating system; packages embed a platform-matched Bun runtime and are not intended to be cross-built.

## Architecture

The product has two cooperating parts:

1. A Bun/TypeScript loopback Responses bridge under `src/`.
2. A React/Vite/Electron desktop launcher under `launcher/` that owns the browser session and supervises the packaged runtime.

Codex remains the source of truth for task state, UI, approvals, context, and local tool execution. The bridge intercepts only `chatgpt-web/*` model turns, sends the complete accumulated turn to a fresh ChatGPT Temporary Chat, and converts browser output back to Responses/SSE events. Non-routed models and the official model catalog pass through to the native ChatGPT Codex backend; this coexistence is not a model fallback.

### Core request path

- `src/cli.ts` is the command entrypoint for setup, login, doctor, routing, daemon, MCP, service, and tunnel operations.
- `src/server.ts` is the loopback HTTP daemon. It owns health/lifecycle endpoints, model catalog augmentation, native passthrough, routed `/v1/responses` handling, continuation state, and compaction behavior. The WebSocket prewarm route deliberately returns HTTP 426 so Codex uses HTTP/SSE.
- `src/responses/parser.ts` translates native Responses items, images, tools, reasoning, compaction markers, and tool results into the bridge's internal request representation. Preserve its fail-closed handling for unsupported or ambiguous protocol content.
- `src/bridge.ts` converts adapter events into the streamed or collected Responses output expected by Codex.
- `src/native-passthrough.ts` forwards non-routed traffic while preserving native authentication and scrubbing bridge-local state when history crosses providers.

### ChatGPT Web adapter and browser execution

- `src/adapters/chatgpt-web/index.ts` coordinates each routed turn: choose read-only versus tool-capable behavior, derive task identity, manage turn/session replay, start the browser worker, and broker full-mode tool calls.
- `src/adapters/chatgpt-web/prompt.ts` serializes the complete Codex context and transport contract into one inline JSON envelope. Images remain native attachments rather than embedded bytes.
- `src/adapters/chatgpt-web/browser-worker.ts` drives the exact launcher-owned browser surface and streams visible status/reasoning and Markdown. Browser turns are capped at five independent task-bound tabs; each task uses a fresh Temporary Chat while sharing only the private login partition.
- Turn execution/session modules maintain append-only event feeds, duplicate-request replay, outstanding parallel tool batches, and bounded continuation state.

Do not broaden browser selectors speculatively. A browser UI change should be based on exact observed DOM evidence and accompanied by a reproducible fixture; UI drift must fail explicitly rather than select a different model or claim success.

### Full-mode tool path

Browser-only mode never creates a broker capability or MCP connector. In full mode, Instant through Extra High can call the active outer Codex turn's advertised tools; Pro is always read-only.

- `src/adapters/chatgpt-web/environment.ts` extracts trusted execution authority from native Codex turn metadata, not user-authored prompt text.
- `src/adapters/chatgpt-web/turn-broker.ts` creates a random, expiring, single-turn capability over a private Unix socket or Windows named pipe and correlates ChatGPT MCP calls with actual Codex tool results.
- `src/adapters/chatgpt-web/mcp-server.ts` exposes the stdio MCP surface used through the outbound OpenAI tunnel. It may invoke only tools advertised by the current outer Codex turn.

Capabilities must remain turn-bound and be revoked on completion, abort, or expiry. Never silently change model, effort, mode, or transport when a requested capability is unavailable.

### Setup, configuration, and lifecycle

- `src/config.ts` defines and validates persisted configuration, including loopback binding, browser ownership, private paths/tokens, mode, and optional tunnel data.
- `src/setup.ts` performs transactional setup: validates routing and account capabilities, configures full-mode tunnel data, installs/restarts the runtime, waits for health, persists configuration, and compensates on failure.
- Setup and launcher lifecycle operations drain the daemon before stop/restart/uninstall. Both active HTTP requests and long-lived browser/tool sessions must be idle before shutdown proceeds.

The launcher is the sole normal process supervisor across macOS, Windows, and Linux:

- `launcher/electron/main.cjs` composes the hardened Electron window, browser host, runtime host/supervisor, renderer IPC, tray/autostart, setup/doctor controls, and graceful shutdown.
- `launcher/electron/runtime-supervisor.cjs` starts the optional tunnel before the daemon, checks readiness and ownership, drains before lifecycle changes, and applies a bounded restart budget.
- `launcher/electron/runtime.cjs` runs setup/doctor/route subprocesses with timeouts, redaction, checkpoints, and rollback.
- `src/launcher-browser-host.ts` validates the owner-only launcher descriptor, attaches Playwright to the exact Electron surface, and uses authenticated launcher control endpoints.
- `launcher/src/` is the React renderer; Electron packaging configuration and platform targets are in `launcher/package.json`.

Packaged apps install an identity-checked runtime into a durable private application directory. Do not persist temporary AppImage mount paths or other machine-specific absolute paths.

## Invariants to preserve

- Keep scope limited to ChatGPT web-backed Codex models; generic providers and unrelated product surfaces are out of scope.
- Model selection and reasoning tier are explicit and immutable for each routed model. Unsupported combinations fail closed.
- Browser-only mode has no local tool path. Pro remains read-only in every mode.
- Responses and health listeners bind to loopback. Lifecycle endpoints require the application-owned bearer token.
- Full-mode authority comes only from the active native Codex registry and turn metadata. Repository text, prompt text, tool output, and websites are untrusted data.
- Browser state, cookies, API keys, tunnel IDs, control tokens, Codex history, generated logs, and absolute user paths must not enter Git, prompts, command arguments, or generated tunnel profiles.
- Do not retry, switch modes, or select another model to evade product limits or UI failures.
