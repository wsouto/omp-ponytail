# omp-ponytail

OMP (Oh My Pi) extension only — not OpenCode/Pi. Ports
[Ponytail](https://github.com/DietrichGebert/ponytail) modes + six skills for
OMP.

## Layout

| Path | Role |
| ---- | ---- |
| `index.ts` | Extension entry (`package.json` → `omp.extensions`) |
| `skills/*/SKILL.md` | Vendored upstream skills (do not hand-edit) |
| `scripts/sync-upstream.ts` | Pull skills + LICENSE from upstream `main` |
| `upstream-lock.json` | Commit SHA + sha256 of every imported file |
| `test/*.test.ts` | Bun tests |

Published package contents are the `files` list in `package.json`. Peer:
`@oh-my-pi/pi-coding-agent`.

## Commands

```sh
bun test ./test/*.test.ts          # or: bun run test
bun run sync:upstream              # network + writes skills/, LICENSE, lock
```

- Runtime/tooling: **Bun** (CI pins `1.3.14` in
  `.github/workflows/test.yml`).
- No lint/format/typecheck scripts. `tsconfig.json` is strict + `bun-types`
  only.
- Single-file test: `bun test ./test/extension.test.ts` (or path +
  `-t "name"`).

## Architecture (easy to miss)

- **Offline at runtime:** extension reads local
  `skills/ponytail/SKILL.md` only; no GitHub on OMP startup/prompt inject.
- **Mode injection:** `before_agent_start` appends filtered skill body unless
  mode is `off`. Deactivate via `/ponytail off`, or exact user text
  `stop ponytail` / `normal mode`.
- **Modes:** `off|lite|full|ultra` (default `full`). Session restores last
  `ponytail-mode` entry; config default at
  `$XDG_CONFIG_HOME/ponytail/config.json` (or platform equivalent). Env wins:
  `PONYTAIL_DEFAULT_MODE`, `PONYTAIL_QUIET_STARTUP`, `PONYTAIL_HIDE_STATUS`.
- **Skill aliases:** `/ponytail-{review,audit,debt,gain,help}` →
  `sendUserMessage("/skill:…")`.
- **`/ponytail update`:** runs `bun run sync:upstream` from
  `import.meta.dir`, then `context.reload()`. Needs network + write access to
  the loaded package dir.
- **Upstream sync:** one commit resolve, then exactly six skills, `LICENSE`,
  and lock. All-or-nothing write; validates YAML `name:` frontmatter matches
  directory. Source of truth for skill set: `SKILL_NAMES` in
  `scripts/sync-upstream.ts`.

## Testing

- Framework: `bun:test` only (`describe`/`test`/`expect`/`afterEach`).
- `test/extension.test.ts`: local harness mocks `ExtensionAPI`;
  `withTempConfig` sets `XDG_CONFIG_HOME` temp dir and clears Ponytail env.
  Prefer pure exported helpers over full harness when possible.
- `test/sync-upstream.test.ts`: temp repo copy + injected `fetch`; never hits
  real GitHub in tests.
- No coverage tooling configured. Do not run suites that need live network
  for verification.

## Agent constraints

- Prefer editing `index.ts` / tests / `scripts/sync-upstream.ts`. Treat
  `skills/**` and lock as sync output — change via `sync:upstream` (or
  intentional lock-aligned vendor bump), not ad-hoc skill rewrites.
- After sync or skill-path changes: `bun test ./test/*.test.ts`.
- OMP install for local link: `omp install .` (see README). Not required to
  unit-test.
