# omp-devin-acp

Delegate coding tasks from [omp](https://github.com/can1357/oh-my-pi) to the **Devin CLI** agent, driven over the Agent Client Protocol (`devin acp`).

This is an out-of-tree omp extension: it installs no patches into oh-my-pi and ships its own ACP client, because out-of-tree extensions cannot resolve host subpath packages such as `@oh-my-pi/pi-utils/acp` from a compiled omp binary.

## What it adds

| Surface | Name | Behavior |
|---|---|---|
| Tool | `devin` | Runs one Devin turn in the session's cwd. Streams Devin's tool activity into omp's tool preview and returns its final answer. |
| Command | `/devin` | Session status (session id, mode, model, effort); `/devin reset`, `/devin mode <id>`, `/devin model <id>`, `/devin effort <id>`. |

Devin keeps its own tool loop: it reads, edits, and executes with its own tools, in the omp session's working directory. Consecutive `devin` tool calls reuse one live ACP session per directory, so follow-up prompts keep Devin's context.

Sessions are scoped to the omp session that started them, not to the module: a subagent gets its own Devin session, and its teardown never touches the parent's. Each omp session's Devin processes stop on `session_shutdown`.

## Requirements

- `devin` on `PATH` (`devin --version`), authenticated: `devin auth login` (`devin auth status` must report a credentials file). Logged out, Devin still accepts `initialize` and `session/new` and only rejects the first `session/prompt` with code `-32000`, so the failure surfaces on the first tool call, not at startup; the extension rewrites that message because Devin's own text tells you to run `/login`, its TUI command, which does nothing from omp.
- omp ≥ 18.12.

## Install

```sh
git clone <this repo> ~/dev/omp-devin-acp
```

Then either link it as a plugin:

```sh
omp plugin link ~/dev/omp-devin-acp
```

or point omp's `extensions:` setting at it:

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/dev/omp-devin-acp
```

or load it for one run: `omp -e ~/dev/omp-devin-acp/src/index.ts`.

## Configuration

All settings are environment variables, read when a Devin session starts. Tool parameters (`mode`, `model`, `effort`, `reset`) override them. A `mode`, `model`, or `effort` passed to one call stays in effect for later calls on the same session — a Devin session is stateful; pass `reset: true` to go back to the env defaults. Unknown values are rejected with the list Devin advertises, because Devin silently ignores an unknown `modeId` and stays where it was.

`effort` is Devin's `thought_level` config option (`low`, `medium`, `high`, `xhigh`, `max`). Setting `model` resets it: a model id encodes a thought level in its suffix, so `claude-sonnet-5-5-medium` forces `medium` and `swe-2-high` forces `high`. Overrides are therefore applied model-first, effort-second, and the same order applies to `/devin` verbs — `/devin model …` after `/devin effort …` discards the effort.

| Variable | Default | Meaning |
|---|---|---|
| `OMP_DEVIN_BIN` | `devin` from `PATH` | Devin CLI binary. |
| `OMP_DEVIN_PERMISSION_MODE` | `auto` | CLI permission floor: `auto`, `accept-edits`, `smart`, `dangerous`. Passed before the `acp` subcommand, where Devin requires it. |
| `OMP_DEVIN_SESSION_MODE` | `accept-edits` | ACP session mode applied after `session/new`: `accept-edits`, `smart`, `ask` (read-only), `plan`. |
| `OMP_DEVIN_MODEL` | Devin's own default | Value for the `model` session config option (Devin does not implement `session/set_model`). |
| `OMP_DEVIN_THOUGHT_LEVEL` | Devin's own default | Value for the `thought_level` session config option. |
| `OMP_DEVIN_ISOLATE_MCP` | `1` | Hide `~/.config/devin/mcp_config.json` from the child so the delegate starts no foreign MCP servers. |
| `OMP_DEVIN_WORKSPACE_TRUST` | `1` | Set to `0` to pass `--respect-workspace-trust false` for directories you have not trusted interactively. |

Concurrent `devin` tool calls in one assistant message queue on the single Devin session for that directory instead of starting a second agent — an ACP session is one conversation.

### Permission behavior — read this

Devin's ACP sessions start in `accept-edits`, which auto-approves workspace edits **and** shell commands without sending `session/request_permission`. Measured: file writes, `rm` inside the workspace, and `curl` all ran unprompted; only an out-of-workspace `rm -rf` was refused by Devin itself.

The CLI permission floor does not change that. Driving `rm -f <file>` through a fresh session at each floor (devin 3000.11.92):

| `--permission-mode` | `session/request_permission` sent | File deleted |
|---|---|---|
| `auto` | 0 | yes |
| `accept-edits` | 0 | yes |
| `smart` | 0 | no — Devin refused on its own |
| `dangerous` | 0 | yes |

So omp's approval prompt is not a gate on Devin's actions. Every tool call Devin makes is still reported in the tool preview and in the result's `details.toolCalls`. `mode: "ask"` is **not** a prompting mode either: measured, Devin refuses the edit and replies with the shell command it would have run, without sending `session/request_permission`. No measured mode produces a permission prompt; the bridge exists for the protocol path (`ctx.ui.approve`, falling back to a selector) and closes the dialog when the turn is cancelled.

### MCP isolation

With `OMP_DEVIN_ISOLATE_MCP=1` (default) the extension mirrors the whole config root into a temp `XDG_CONFIG_HOME` overlay, created fresh per launch and removed when the session stops. Every entry of `~/.config` is symlinked through — including `gh/` and `git/`, which Devin's shell commands need — `~/.config/devin`'s entries are symlinked individually, and only `devin/mcp_config.json` is replaced with `{"mcpServers": {}}`. Credentials live under `XDG_DATA_HOME` (`~/.local/share/devin/credentials.toml`), so login is unaffected. Each overlay records its owning pid in `.omp-owner` before anything else is written; the next launch sweeps overlays whose owner is gone — that is how a `kill -9`'d omp's leftovers are reclaimed — and unmarked directories only after an hour, so a concurrent launch's half-built overlay is never deleted.

Limits, measured: isolation covers `~/.config/devin/mcp_config.json` only. Devin also loads MCP servers from `~/.claude.json`, which is under `$HOME`, not XDG, and those still start (observed: `agent-history` running with isolation on). Without isolation a delegated session inherits and spawns every MCP server in your Devin config as well.

## Protocol notes

Established against `devin` 3000.11.92 by driving the real binary:

- `devin acp` speaks newline-delimited JSON-RPC 2.0 at `protocolVersion: 1`; `agentInfo` is `{name: "affogato", title: "Devin Agent"}`.
- Client capabilities are declared `fs: {readTextFile: false, writeTextFile: false}, terminal: false` on purpose. Advertising `terminal: true` makes Devin route shell work through `terminal/create`; with no client terminal implementation the turn degrades with "the terminal failed to start".
- `session/set_model` returns `-32601`. Model, effort, and speed are `session/set_config_option` values (`model`, `thought_level`, `speed`); a fresh session advertises 94 model ids. That request names the option `configId`, not `optionId` — sending `optionId` fails with `-32602 missing field \`configId\``. Its reply carries the refreshed `configOptions` array and is the only refresh source: Devin emits no `config_option_update` notification for an option the client set itself, so a client that ignores the reply reports stale values forever.
- Agent→client requests may serialize `id` after `method`, so messages are classified by field presence, not key order.
- `session/cancel` is a notification; the in-flight `session/prompt` then resolves with `stopReason: "cancelled"`.
- Devin's stderr carries INFO tracing: noise goes to omp's debug log, other lines are logged at `warn`, and the last 20 non-noise lines are attached to transport and startup errors (a rejected flag kills the child before it speaks ACP, so stderr is the only diagnosis).
- `session/set_mode` accepts any `modeId` and answers `{}` even for nonsense, leaving the session in its previous mode; the driver validates against `availableModes` instead.
- Killing the child with SIGTERM alone leaves the shell commands Devin started running (measured: a backgrounded `sleep` kept going and wrote its file). Shutdown sends `session/cancel` first, waits for the turn to unwind, then terminates and reaps. A `kill -9` of omp itself cannot run that path, so Devin's shell grandchildren can survive it.
- Transport errors name the binary and its exit status (`exit code 1`, `killed by SIGKILL`) plus the last stderr lines; without that, a wrong `OMP_DEVIN_BIN`, a crash, and an external kill all read as "ACP connection closed".

## Layout

```
src/acp/types.ts      ACP (v1) wire types, the subset this client uses
src/acp/peer.ts       bidirectional NDJSON JSON-RPC peer
src/devin/launch.ts   argv/env resolution, MCP isolation overlay
src/devin/agent.ts    spawn, initialize, session lifecycle, prompt, cancel
src/devin/transcript.ts  session/update folding: live view, text, details
src/index.ts          extension factory: tool, command, teardown
```
