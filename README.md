# omp-devin-acp

Delegate coding tasks from [omp](https://github.com/can1357/oh-my-pi) to the **Devin CLI** agent, driven over the Agent Client Protocol (`devin acp`).

This is an out-of-tree omp extension: it installs no patches into oh-my-pi and ships its own ACP client, because out-of-tree extensions cannot resolve host subpath packages such as `@oh-my-pi/pi-utils/acp` from a compiled omp binary.

Current release: **v0.2.0**. See [CHANGELOG.md](CHANGELOG.md) for release notes and [AGENTS.md](AGENTS.md) for coding-agent guidance.

## What it adds

| Surface | Name | Behavior |
|---|---|---|
| Tool | `devin` | Runs one Devin turn in the session's cwd. Streams Devin's tool activity into omp's tool preview and returns its final answer. |
| Command | `/devin` | Session status (session id, mode, model, effort). `/devin mode`, `/devin model`, `/devin effort` open a picker of the values Devin advertises, with the active one marked; append an id (`/devin model swe-2-high`) to set it without the dialog. `/devin reset` drops the session. |
| Provider | `devin/<model>` | Devin's own models in omp's `/model` picker. Selecting one routes every omp turn through a Devin ACP session instead of a completion endpoint. |

Devin keeps its own tool loop: it reads, edits, and executes with its own tools, in the omp session's working directory. Consecutive `devin` tool calls reuse one live ACP session per directory, so follow-up prompts keep Devin's context.

Picking a `devin/<id>` model (`/model`, or `omp --model devin/gpt-6-1-sol`) hands the whole turn to Devin: it plans, edits, and runs commands with its own tools, and omp renders the streamed answer as a normal assistant message, with each finished Devin tool call as a `✓ exec: …` line as it happens. The provider and the `devin` tool share one session per directory, so switching to a Devin model continues whatever session the tool already started — and `/devin status` still reports it.

- The catalog comes from the live binary and is cached in omp's model DB for 24 h (`omp models devin` lists it, `omp models refresh` refetches). Devin's roster is account-specific and changes. Two sources feed it: the ACP `model` option (what Devin accepts) and `devin models list --format json` (prices, context windows, labels). Reading each model's levels costs one ~0.5 s `set_config_option` round trip, and omp drops a model fetch after 15 s, so the extension starts 8 probe sessions and spreads the models across them (82 models: 29 s serial, 9 s parallel).
- One omp model per Devin family: `gpt-6-1-sol`, not `gpt-6-1-sol-medium`. The suffix on Devin's ids is only the family's default level, so the omp row carries the family's real level set as efforts and the effort control picks the level (`swe-2`: medium/high/max; GPT and recent Claude: low through max). Devin's `none` level is omp's `minimal`. Families with no levels (`claude-opus-4-6`) get no effort control; omp's own rules collapse such pairs (`claude-opus-4-6` + `claude-opus-4-6-thinking`) into one row whose effort routes to the sibling id, and the provider follows that route.
- Usage is priced: Devin reports token counts per turn (`usage_update`, input inclusive of cache reads and writes) and the catalog carries Devin's per-million rates, so omp shows a real turn cost. omp's pricing rules may fill rates Devin's summary omits (cache write, long context). Devin itself bills in ACUs; the omp figure is a token-rate estimate.
- A Devin session that has not seen the conversation (the first Devin turn after other models answered, a new or reset session, a resumed omp session) receives the earlier transcript once, inside a `<omp-transcript>` block ahead of the request, so it doesn't re-investigate what omp already established. Later turns send only the new user message.
- An `enabledModels` whitelist in `~/.omp/agent/config.yml` hides the provider from `/model` and from `omp models` until it lists `devin/*`; an explicit `--model devin/<id>` selector still works.
- Cancelling a turn ends the stream as `aborted` with the text Devin had already streamed; Devin's own cancel acknowledgement can take a few seconds.

Sessions are scoped to the omp session that started them, not to the module: a subagent gets its own Devin session, and its teardown never touches the parent's. Each omp session's Devin processes stop on `session_shutdown`.

## Requirements

- `devin` on `PATH` (`devin --version`), authenticated: `devin auth login` (`devin auth status` must report a credentials file). Logged out, Devin still accepts `initialize` and `session/new` and only rejects the first `session/prompt` with code `-32000`, so the failure surfaces on the first tool call, not at startup; the extension rewrites that message because Devin's own text tells you to run `/login`, its TUI command, which does nothing from omp.
- omp ≥ 18.12.

## Install

```sh
omp plugin install "git+ssh://git@github.com/dsebban/omp-devin-acp.git"
```

Installs into `~/.omp/plugins/node_modules/omp-devin-acp`; omp then discovers the `omp.extensions` entry in `package.json` on every run, so no `extensions:` config line is needed. Add `--scope project` to install it for one repo instead of the user.

The repo is private, so the SSH URL is required: bun resolves the `github:dsebban/omp-devin-acp` shorthand through `api.github.com/.../tarball`, which returns 404 without a token. `git+ssh://` clones over your SSH key instead.

Updating and removing:

```sh
omp plugin upgrade omp-devin-acp
omp plugin uninstall omp-devin-acp
```

bun caches git dependencies, so a reinstall on a machine that already fetched this repo can restore the cached revision instead of current `main`; `omp plugin upgrade` forces the refetch.

After upgrading, run `/restart` in each open omp session to load the new extension while resuming the conversation. An already running process retains its loaded code; `/mcp reload` reloads MCP tools, not this extension.

### Migrating from v0.1.0

Provider model names now identify families: replace saved provider selectors such as `devin/gpt-6-1-sol-medium` with `devin/gpt-6-1-sol`. Check `modelRoles` in `~/.omp/agent/config.yml`, launch flags, and saved shortcuts. Keep `enabledModels: devin/*` if you already use it. After `/restart`, select the new name with `/model` if a resumed session still references the old one. Do not delete conversation history or clear databases to migrate.

```sh
omp models refresh
omp models devin
omp --model devin/gpt-6-1-sol --thinking medium
```

This rename applies to omp provider selectors only. `/devin model`, the `devin` tool's `model` argument, and `OMP_DEVIN_MODEL` still take the exact wire ids advertised by Devin (which can include an effort suffix).

For development against a working copy, skip the install and link or load the source directly:

```sh
omp plugin link ~/dev/omp-devin-acp          # or
omp -e ~/dev/omp-devin-acp/src/index.ts      # single run
```

## Verification And Troubleshooting

Run `bun run check` for the TypeScript check. For a real integration check, use an authenticated Devin CLI and `omp -e ./src/index.ts` from this checkout; avoid simultaneously loading a second installed copy of the extension. A model turn can incur Devin charges and can act in the selected directory.

| Feature | How to reach or drive it | Observable proof |
|---|---|---|
| Catalog | `omp models devin` (or refresh first) | Family ids, available efforts, and context/output limits; roster size is account-specific. |
| Provider and effort | `omp --model devin/gpt-6-1-sol --thinking high` | A completed reply; provider log records the selected `wireModel`, `thoughtLevel`, and `end_turn`. Use an available model if this example is absent. |
| History replay | Start on another provider, supply a unique codeword, then switch using `/model` and ask for it | Correct recall; first provider completion records `replayed > 0`. Subsequent uninterrupted Devin turns normally record `replayed: 0`. |
| Tool activity | Ask Devin to list a disposable directory | Finished tool activity appears in the thinking block, with a final answer; completion log records tool calls. |
| Usage | Complete a provider turn | Saved omp assistant message has token counts and estimated cost; compare with catalog rates, not ACU billing. |
| Commands and lifecycle | `/devin status`, advertised mode/model/effort pickers, `/devin reset` | Status reflects selections; reset stops the owned session and the next turn creates a new one. |
| Cancellation | Cancel an active turn | Partial output is retained and the turn ends as `aborted`. |

omp logs are under `~/.omp/logs/`; Devin CLI logs are under `~/.local/share/devin/cli/logs/` with the default data directory. Match the active omp pid and its Devin child rather than reading an old probe's log. `devin-acp: initialized` proves the handshake, and `devin-acp: provider turn complete` records model, effort, history replay, tool count, elapsed time, and stop reason. Inspect the saved omp message for token usage and pricing. Do not publish raw logs: they can contain prompts, commands, and private paths.

Observed non-fatal warnings are not a blanket health check: a feature-flag refresh timeout explicitly keeping a last-good value is different from an ACP disconnect or model-request failure. Skill-discovery errors can mean missing skills even when ordinary turns work. A project-local custom-tool load failure or Tern frame-acknowledgement warning belongs to that surface, not automatically to this provider. Diagnose each warning before claiming the whole environment is healthy.

Live validation on 2026-10-20 with omp 18.12.3 and Devin 3000.11.92 confirmed the updated family selector, medium effort, 88 replayed messages, normal completion in 3.3 s, saved token counts, and a nonzero estimated cost. Earlier installed-copy checks covered high effort, mid-conversation switching, streamed tool activity, and a cold catalog in about 9 s. The on-screen Tern model picker was not directly verified.

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
- `session/set_model` returns `-32601`. Model, effort, and speed are `session/set_config_option` values (`model`, `thought_level`, `speed`); a fresh session advertises the account's whole model roster (78 ids when last measured, 94 a day earlier — it changes). That request names the option `configId`, not `optionId` — sending `optionId` fails with `-32602 missing field \`configId\``. Its reply carries the refreshed `configOptions` array and is the only refresh source: Devin emits no `config_option_update` notification for an option the client set itself, so a client that ignores the reply reports stale values forever.
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
src/devin/catalog.ts     model catalog: parallel level probe, CLI prices and limits
src/devin/history.ts     replays omp's transcript into a session that has not seen it
src/devin/provider.ts    omp provider: Devin's models in `/model`, turn streaming, cost
src/index.ts          extension factory: tool, command, provider, teardown
```
