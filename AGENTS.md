# omp-ponytail

OMP (Oh My Pi) extension only — not OpenCode/Pi. Ports
[Ponytail](https://github.com/DietrichGebert/ponytail) modes + six skills for
OMP.

## Git Workflow

This repository uses local branch merges. A remote may be configured, and in
this case, we can do remote work.

1. Start from `main`. Preserve pre-existing user changes and stop if they
   overlap the task.
2. Create a short-lived branch named `<type>/<short-kebab-slug>`, such as
   `feat/add-dev-vm` or `docs/update-workflow`.
3. Keep changes focused: one logical task per branch and one self-contained
   change per commit, with no unrelated edits mixed in.
4. Add a `CHANGELOG.md` entry under `## [Unreleased]` for user-visible
   behavior, security, or compatibility changes. Documentation, formatting,
   and internal maintenance changes do not require an entry.
5. Run every check relevant to the changed files. Do not merge while a
   relevant check fails.
6. Merge into `main` with `git merge --no-ff`, then delete the task branch.
7. Finish on `main` with no changes from this task. Leave unrelated user
   changes untouched.

## Notes

- Use the primary working tree for normal sequential work. Create and remove
  a separate Git worktree only when the task explicitly needs parallel
  branches.
- Write commit messages as
  [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
- Follow the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
  format, using `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and
  `Security` sections.
- Commits and tags must be signed.
- Complete the Git Workflow and verify clean `main`.

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
