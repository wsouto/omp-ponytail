# omp-ponytail

A standalone [Oh My Pi](https://github.com/coder/oh-my-pi) (OMP) extension
port of [Ponytail](https://github.com/DietrichGebert/ponytail). It provides
Ponytail runtime modes, slash-command aliases, and a committed copy of
Ponytail's six skills. OMP startup and prompt injection read only local files;
they do not contact GitHub.

## Prerequisites

- [Bun](https://bun.sh/) available for installing Git dependencies and running
  tests or updates.

## Install from GitHub

Install directly from the public repository:

```sh
omp install github:wsouto/omp-ponytail
```

OMP accepts GitHub Git specs and installs this package through its plugin
manager. Confirm the extension is enabled, then restart or reload OMP so it
discovers the extension and root `skills/` directory:

```sh
omp plugin list
```

## Local Development

For local development, clone the repository:

```sh
git clone https://github.com/wsouto/omp-ponytail.git
```

Then use OMP's local plugin linker:

```sh
cd omp-ponytail
omp install .
omp plugin list
```

Remove the plugin with:

```sh
omp plugin uninstall omp-ponytail
```

## Commands and modes

Use `/ponytail` to select a runtime mode:

```text
/ponytail off
/ponytail lite
/ponytail full
/ponytail ultra
/ponytail status
/ponytail default <off|lite|full|ultra>
/ponytail update
```

`full` is the default. `off` prevents the extension from injecting Ponytail
instructions. Sending exactly `normal mode` or `stop ponytail` also turns
injection off. The extension saves mode entries in the OMP session and
restores the latest valid one on the next session start.

`/ponytail update` asks for confirmation in UI mode, then runs
`bun run sync:upstream` from loaded package directory. It needs GitHub network
access and write access to that
directory. On success, OMP reloads so refreshed skills are available immediately.

The extension aliases six vendored skills:

```text
/ponytail-review
/ponytail-audit
/ponytail-debt
/ponytail-gain
/ponytail-help
/skill:ponytail
```

The first five aliases dispatch their matching `/skill:ponytail-*` skill. The
primary `ponytail` skill is injected by the selected runtime mode.

## Configuration

The persisted config file is:

```text
<XDG_CONFIG_HOME|platform config root>/ponytail/config.json
```

Use `/ponytail default <mode>` to update its `defaultMode`. These environment
variables take precedence when present:

- `PONYTAIL_DEFAULT_MODE`: `off`, `lite`, `full`, or `ultra`.
- `PONYTAIL_QUIET_STARTUP`: truthy value suppresses the startup notification.
- `PONYTAIL_HIDE_STATUS`: truthy value hides the status indicator.

## Refresh the upstream snapshot

`/ponytail update` runs this package script from the loaded plugin:

```sh
bun run sync:upstream
```

It resolves upstream `main` once, then refreshes exactly six skill files,
`LICENSE`, and `upstream-lock.json` from that one commit. A local plugin link
updates tracked checkout files. A GitHub-installed plugin updates Bun/OMP-managed
files that reinstalling or updating the plugin can replace.

Run the script directly for durable maintainer work: review its diff, run tests,
commit, and publish the synchronized snapshot:

```sh
bun test ./test/*.test.ts
```

Ordinary OMP startup remains offline and keeps using the committed snapshot.
`upstream-lock.json` records the upstream commit and SHA-256 digest of every
imported file.

## Development

OMP extension behavior follows the
[extension authoring documentation](https://github.com/coder/oh-my-pi/blob/main/packages/coding-agent/docs/extensions.md)
and
[extension loading documentation](https://github.com/coder/oh-my-pi/blob/main/packages/coding-agent/docs/extension-loading.md).
Run the focused test suite with:

```sh
bun test ./test/*.test.ts
```

## Attribution

The vendored `skills/**` material comes from
[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) and is
available under its MIT license, reproduced in [LICENSE](LICENSE). See
[NOTICE](NOTICE) and [upstream-lock.json](upstream-lock.json) for provenance.
