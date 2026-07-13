# Repository Guidelines

## Project Overview

`omp-ponytail` is a private TypeScript Oh My Pi (OMP) extension. It supplies
Ponytail operating modes and skill aliases, persists the selected mode, injects
mode-specific instructions into agent prompts, and can refresh vendored skills
from the upstream Ponytail repository.

## Architecture & Data Flow

- `index.ts` is the only application source and the OMP extension entry point
  (`package.json` → `omp.extensions: ["./index.ts"]`). There is no `src/`
  directory.
- `ponytailExtension(pi)` owns closure-scoped runtime state and registers
  `/ponytail`, five skill aliases, and `input`, `session_start`,
  `agent_start`, `agent_end`, and `before_agent_start` hooks.
- Mode resolution: environment variables override JSON config; on session
  start, the latest `ponytail-mode` custom session entry can restore a mode.
  `/ponytail` changes append that entry. The before-agent hook injects the
  filtered contents of `skills/ponytail/SKILL.md` unless the mode is `off`.
- Configuration path: `$XDG_CONFIG_HOME/ponytail/config.json`; Windows falls
  back to `APPDATA`, otherwise `~/.config/ponytail/config.json`.
- `scripts/sync-upstream.ts` fetches one resolved upstream commit, validates
  the LICENSE and six skill files, stages an atomic replacement, rolls back on
  failure, serializes writers with `.upstream-sync.lock`, and writes
  `upstream-lock.json` SHA-256 provenance.

## Key Directories

- `test/` — Bun behavioral and integration-style tests (`*.test.ts`).
- `scripts/` — maintainer automation; currently `sync-upstream.ts`.
- `skills/` — vendored Ponytail `SKILL.md` files consumed at runtime. Treat as
  synchronized upstream content; refresh with `sync:upstream` rather than
  hand-editing synchronized files.
- `.github/workflows/` — CI test workflow.

## Development Commands

Use Bun directly; the repository defines no build, typecheck, lint, or format
script.

```sh
# Run the complete focused test suite (also the CI command)
bun test ./test/*.test.ts

# Refresh vendored skills, LICENSE, and provenance metadata
bun run sync:upstream
# Equivalent direct script invocation
bun run ./scripts/sync-upstream.ts
```

For local OMP plugin use, see `README.md`; common commands include
`omp install ./omp-ponytail` and `omp plugin list`.

## Code Conventions & Common Patterns

- Use TypeScript ESM and Node built-ins; keep the extension dependency-free.
- Keep extension behavior in `index.ts` and expose only intentional helpers.
  Runtime behavior is event-driven through `ExtensionAPI`, not a framework.
- Validate unknown host/config input at boundaries. Follow the existing
  `normalizeMode` / `normalizePersistedMode` pattern before branching on a
  string value.
- Model partial host capabilities with narrow local types and optional methods;
  use optional chaining for UI/session hooks.
- Guard filesystem, UI, and host-execution boundaries with focused `try/catch`.
  Invalid or unreadable configuration must degrade safely rather than crash the
  extension.
- Persist by merging the existing JSON object so unrelated config keys survive.
  Environment values take precedence: `PONYTAIL_DEFAULT_MODE`,
  `PONYTAIL_QUIET_STARTUP`, and `PONYTAIL_HIDE_STATUS`.
- Prefer dependency injection for external effects. Tests inject fake extension
  APIs, fetchers, renames, logging, UI callbacks, and execution hooks instead
  of using a mocking library.
- Keep upstream publishing atomic. Do not weaken validation, staging,
  rollback, lock-file, or digest behavior in `scripts/sync-upstream.ts`.

## Important Files

- `index.ts` — extension entry point; modes, config persistence, commands,
  hooks, status UI, and prompt injection.
- `package.json` — OMP registration, package publication allowlist, and Bun
  scripts.
- `skills/ponytail/SKILL.md` — primary instruction text filtered by runtime
  mode; sibling `skills/ponytail-*/SKILL.md` files back slash-command aliases.
- `scripts/sync-upstream.ts` — upstream synchronization and transactional
  publishing.
- `upstream-lock.json` — upstream commit and file hashes; update only via the
  synchronization flow.
- `test/extension.test.ts` — extension harness and behavior coverage.
- `test/sync-upstream.test.ts` — synchronization failure, rollback, locking,
  retry, and provenance coverage.
- `README.md` — installation, runtime command, configuration, and maintainer
  workflow reference.

## Runtime/Tooling Preferences

- Required runtime and package tool: **Bun**. CI pins Bun `1.3.14` in
  `.github/workflows/test.yml`.
- The package is private and ESM (`"type": "module"`) with peer dependency
  `@oh-my-pi/pi-coding-agent`.
- No lockfile, workspace declaration, `tsconfig`, bundler, linter, or formatter
  configuration is present. Do not introduce tooling or dependencies without a
  concrete need.
- Upstream sync requires GitHub network access and writes vendored artifacts;
  run it deliberately and review the resulting diff and `upstream-lock.json`.

## Testing & QA

- Use Bun's built-in `bun:test` (`describe`, `test`, `expect`, `afterEach`).
- Place tests in `test/` as `*.test.ts`; keep helpers local unless a real shared
  abstraction emerges.
- Test observable behavior and failure paths. Existing tests use temporary
  XDG/repository directories, reset environment state in `afterEach`, and
  inject dependencies for deterministic tests.
- For extension changes, cover command parsing, mode/session persistence,
  configuration precedence, prompt injection, and UI/execution failures as
  applicable. For sync changes, cover malformed input, atomicity, rollback,
  lock contention, retry, and lockfile provenance.
- There is no coverage tool or threshold. Run `bun test ./test/*.test.ts`
  before submitting changes; CI runs the same command on `main` pushes and pull
  requests.
