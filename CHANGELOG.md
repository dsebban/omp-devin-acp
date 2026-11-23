# Changelog

## Unreleased

- Stream Devin's tool calls incrementally on every lifecycle transition (`pending`/`in_progress` → `completed`/`failed`) into omp's working message and an above-editor live widget (`devin-activity`, capped to 8 lines with an earlier-calls summary), clearing both when the turn finishes.
- Include compact tool targets (relative paths from `locations`/`rawInput`, commands, patterns/queries) in `toolCallLine` when Devin's title is generic (e.g. `▸ read: src/index.ts` instead of `▸ read: Read file`).
- Track the set of delivered user-message timestamps per live Devin session rather than only the most recent one, so ephemeral host side turns such as `<composer-prediction>` no longer invalidate tracking and trigger a full `<omp-transcript>` replay on the next real user turn.
- Substitute `{{history}}` and `{{request}}` in a single pass when building history-replay prompts, so a literal `{{request}}` inside replayed messages does not capture the user's request and leave the template's placeholder unreplaced.
- Show Devin's finished tool calls in omp's working message instead of the thinking block. omp's thinking-loop guard counted repeated status lines (`✓ mcp__…: Called history_sql …`, `✓ read: Read file`) as a reasoning loop, aborted the turn, cancelled Devin, and retried; Gemini-class models tripped after a few identical MCP calls, and any model after ten identical lines in a row.
- Record history delivery when the prompt is sent, so a host retry that starts before a cancelled prompt settles no longer replays the history into the same session. A prompt Devin rejects outright still replays next turn.
- Tell Devin when the host re-sends a message whose previous attempt was cancelled, so it continues from that attempt's completed edits and commands instead of repeating them.
- Follow Devin's own permission configuration. The session starts in the ACP mode matching Devin's `permission_mode` (`DEVIN_PERMISSION_MODE` or `~/.config/devin/config.json`) instead of a forced `--permission-mode auto` and `accept-edits`; `dangerous` maps to `bypass`. Devin's `permissions` rules decide first.
- Show Devin's own permission choices (once, always for the project, reject) when Devin asks, on both the `devin` tool and the `/model` provider path. Previously the provider path answered every request `cancelled`, so Devin silently dropped those tool calls. A dismissed dialog now selects Devin's reject option; without an interactive UI the request is refused and logged.
- Name the command in the permission dialog. Devin's request carries it only in `_meta`, so the dialog previously read "Devin wants to run: tool call".
- `OMP_DEVIN_PERMISSION_MODE` and `OMP_DEVIN_SESSION_MODE` no longer have defaults; set them to override Devin's configuration.

## 0.2.0 - 2026-10-20

- Expose one omp provider model per Devin family, with advertised effort levels and host effort routing.
- Discover prices and limits from `devin models list --format json`; record token usage and estimated USD costs, distinct from Devin ACU billing.
- Replay missed omp history when entering a new Devin session or returning from another provider.
- Stream completed Devin tool activity alongside the answer, retaining partial output on cancellation.
- Probe model levels across eight temporary ACP sessions to fit the host discovery timeout; a measured cold catalog completed in about 9 seconds.
- Document upgrade/restart steps, verification paths, troubleshooting boundaries, and repository agent guidance.

### Migration

Replace saved omp provider ids such as `devin/gpt-6-1-sol-medium` with `devin/gpt-6-1-sol`, then choose effort separately. Exact Devin wire ids remain valid for `/devin model`, tool overrides, and `OMP_DEVIN_MODEL`. Upgrade the plugin, refresh models, and run `/restart` in open omp sessions. See README.md for details.
