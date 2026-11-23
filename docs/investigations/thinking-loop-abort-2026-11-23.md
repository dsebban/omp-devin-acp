# Investigation: omp thinking-loop guard aborts Devin `gemini-4-neon` turns

## Summary
omp's stream-level thinking-loop guard aborts long Devin agent turns on Gemini-class models. Root cause and the extension-side remedy are open; see Investigator Findings.

## Symptoms
- Session `01a1ba4a-e716-7663-947e-e9685b9e274a` (`~/.omp/agent/sessions/-dev-slowq/…`): two consecutive `devin`/`gemini-4-neon` turns ended `stopReason:error`, "Thinking loop detected … (4, then 5 near-identical segments within the last 16)", empty content, zero usage.
- omp log `~/.omp/logs/omp.2026-11-23.2679.log` 10:57:30 and 10:58:43: `Thinking loop detected; aborting stream for retry`.
- An earlier `gemini-4-neon` turn in the same session completed (150k tokens).

## Background / Prior Research
- Guard: `node_modules/@oh-my-pi/pi-ai/src/utils/thinking-loop.ts`. Wraps every provider stream (`stream.ts:837`). Semantic heuristics only for identity class gemini/deepseek/xai (`isLoopGuardedModel`). Near-dup rule: paragraphs split on blank lines or 700 chars, >=8 substantial segments warm-up, cluster >=4 with trigram Jaccard >=0.8 among last 16. Code-shaped lines and `**Title**`/`#` lines are stripped. Also scans `text_delta` (`checkAssistantContent`).
- Opt-outs are host-side only: setting `model.loopGuard.enabled`, env `PI_NO_THINKING_LOOP_GUARD=1`, `model.loopGuard.checkAssistantContent`.
- Model `compat: {}` does not stop the guard (tested with `buildModel`; identity class still `gemini`).
- Devin CLI log `~/.local/share/devin/cli/logs/devin_20261123-105535_3343.log`: only ~3 tool calls before the first abort; Devin kept running afterwards.
- Extension forwards `agent_thought_chunk` -> thinking, `agent_message_chunk` -> text, settled tool calls -> one thinking line each (`src/devin/provider.ts` `onChunk`, `src/devin/agent.ts:458-482`).

## Investigator Findings
<!-- pair appends here -->

### Verdict (2026-11-23, read-only, no credentialed calls)
The guard tripped on **the extension's own settled-tool status lines**, not on Devin's reasoning. Gemini's thought paragraphs only filled the 8-segment warm-up. Identical MCP status lines made the near-duplicate cluster. Replaying the recovered turns through the real `ThinkingLoopDetector` gives both aborts exactly: the same detail strings at the same timestamps.

| Hypothesis | Result | Evidence |
|---|---|---|
| (A) thoughts are near-duplicate paragraphs | **Disproved** | Thoughts-only replay never trips in any of the 4 attempts. The successful turn's real 5,688-char thinking (session jsonl line 11522) does not trip. Thoughts are distinct Gemini summaries (`**Title**\n\nparagraph\n\n`). They still count toward the 8-segment warm-up: attempt 2 does not trip on tool lines alone. |
| (B) `agent_message_chunk` narration trips the text detector | **Disproved** | Both failed attempts streamed no text (`chars:0`: omp log lines 267 and 367; DB `content` is empty for every step before the abort). The successful turn's 6,527-char text does not trip. |
| (C) tool lines do not contribute | **Disproved: they are the cause** | See below. Attempt 1 had **15** settled tool calls (omp log line 267 `toolCalls`; DB steps 39/45/53), not ~3. The Devin log lists permission decisions, not every settle. |

### Mechanism (file:line)
1. `src/devin/agent.ts:480-481` emits one `toolCallLine` per settled call. `src/devin/transcript.ts:180` renders it as `✓ <tool>: <title>`. For MCP calls the settled update renders as `✓ mcp__agent-history__history_sql: Called history_sql from agent-history` (seen verbatim in the successful turn's thinking). The DB `tool_call_state` keeps only the initial `mcp_call_tool` / `Calling …` title.
2. `src/devin/provider.ts:192` appends each line as a `thinking_delta`: a `\n` prefix while thinking is open, plus a `\n` suffix. Two consecutive lines therefore form `…\n\n✓ …`. The guard splits on `\n\s*\n` (`_ref/thinking-loop.ts.txt:188`), so **every tool line is its own segment**.
3. The lines are not stripped. They don't match `CODE_LINE` (`:120`) or the title patterns. They normalize to 67–87 chars, above `SEGMENT_MIN_NORM_CHARS = 60` (`:79`, `:244`). Identical lines have trigram Jaccard 1.0.
4. The provider never closes the thinking block between Devin steps and never emits `toolcall_*`. One detector therefore covers the whole Devin turn (`:400-460`). Thought paragraphs from earlier steps fill `SEGMENT_MIN_COUNT = 8` (`:85`), and the 4th or 5th identical MCP line reaches `SEGMENT_MIN_CLUSTER = 4` (`:296`).
   - Attempt 1 trips on `history_list_sessions` (4 in step 45, 1 in step 53) at Devin ts 1795424250, which is 10:57:30. Detail: "4 near-identical".
   - Attempt 2 trips on `history_sql` (4 in step 62, then 3 in step 70) at 1795424323, which is 10:58:43. Detail: "5 near-identical".
   - Attempt 3 (17 calls, mostly short `read`/`exec` lines of 14–25 normalized chars) does not trip, matching the real success.
5. A latent issue exists for **every** Devin model. The exact-suffix-cycle detector runs even when the semantic heuristics are off (`:62-75`, `ThinkingLoopDetector(false)`). With semantic off, 10 back-to-back `✓ read: Read file` settles trip `repeated an exact 19-character cycle 10×`; 9 do not. Devin's `read` title is always "Read file", and step 115 here had 6 in a row. A Claude or GPT Devin turn that reads 10 files in parallel would be aborted the same way.

### Abort wiring and host retry
- **Abort cancels Devin.** `withThinkingLoopGuard` merges its controller into `options.signal` (`_ref/thinking-loop.ts.txt:495`) and aborts it on a hit (`:447`). The provider passes that signal to `agent.prompt` (`provider.ts:198`). That triggers `agent.ts:371` → `#cancelTurn` (`:364`) → `session/cancel` (`:400`). Devin logged `Canceling stop token` 1 ms after each detection (Devin log lines 222 and 317). The prompt resolved `cancelled` 9 ms after the hit (omp log lines 267 and 367), well inside `CANCEL_GRACE_MS` (`agent.ts:79`). No orphaned turn kept running.
- **The retry re-sends the bare request into the same Devin session.**
  - `delivered.set` (`provider.ts:204`) ran before the retry was scheduled (+420 ms; omp log line 277). The retry's `buildTurnInput` (`provider.ts:133`) therefore sent only the 90-char request (`replayed:0`).
  - Devin's DB shows the user request three times: node 2 (with the 48k-char history), then nodes 60 and 75 (10:57:31, 10:58:44). Each landed on top of the cancelled attempt's tool results.
  - The host's hidden `thinking-loop-redirect` (`turn-recovery.ts:2946`) becomes role `developer` (`pi-agent-core/src/compaction/messages.ts:224`). `history.ts` never renders it (no `developer` case; `:63`), so Devin never sees it. That is harmless here.
- **Side effects.** This incident only used read-only MCP/`exec`/`read` calls, so nothing was duplicated. In general, edits or commands from a cancelled attempt persist in the workspace. The retry then re-asks the same task in a session that already holds partial results, so writes can repeat.
- **Race (not observed).** If Devin answers `session/cancel` more slowly than the retry delay, the retry builds its input before `delivered.set` and replays the full history into a session that already holds it. If cancel goes unanswered for 10 s, the agent is killed and the replay is correct for the new session.
- **Accounting.** The guard's synthetic error has zero usage (`_ref/thinking-loop.ts.txt:506-516`). The two cancelled attempts (48k-char prompt plus 24 tool calls) consumed Devin tokens and ACUs that omp never records.

### Extension-side options
| Option | Fixes this incident | Tradeoffs | Verdict |
|---|---|---|---|
| Stop sending settled-tool lines as `thinking_delta`. Show them on a surface the guard does not scan, e.g. the existing `TurnTranscript.liveView` via `ctx.ui.setStatus`/working message, like the tool path. | Yes, both aborts. Also removes the all-model exact-cycle risk. | Tool activity disappears from the persisted thinking block. `history.ts` ignores thinking, so replay loses nothing. Needs a UI hook on `DevinProviderHost`. | **Safe; recommended.** The lines are extension-synthesized, not model output, so excluding them keeps the guard's intent for Devin's real thoughts. |
| Make each line distinct (append path, command head, or query head). | Mostly | Same tool + same args (polling, retried query) stays identical. Digits are stripped by normalization, so counters don't help semantically. Lines get longer. | Partial: only a complement to the option above. |
| Collapse repeats per step (`✓ history_sql ×4`). | Attempt 1/2 yes | Identical summary lines across steps can still cluster on long turns. | Weak |
| Shape lines to match host internals (end with `)`, indent so `CODE_LINE` strips them). | Semantic only | Depends on a private host regex; the exact-cycle detector still sees them. | Not recommended |
| Drop or transform `agent_thought_chunk`. | Yes, but only by starving the warm-up | Removes real Gemini loop protection and the reasoning view. Thoughts were never the duplicated content. | Not safe; unnecessary |
| Thought titles only | No | Titles are stripped by the guard anyway. In replay, titles-only still tripped attempt 1 and tripped attempt 2 *earlier*, via an exact cycle of tool lines. | Not safe |
| Text handling changes | n/a | Text never appeared in the failed attempts. The text detector stays armed all turn because no `toolcall_*` events are emitted, but this incident never reached it. | No change needed |
| Host opt-outs (`model.loopGuard.enabled=false`, `PI_NO_THINKING_LOOP_GUARD=1`) | Yes | Global; disables protection for every model. AGENTS.md forbids changing the user's global settings. | User's choice only |

Retry hardening, separate from the trip:
- When `buildTurnInput` sees the same `deliveredAt` as a turn that ended `cancelled`, mark the prompt as a resumption ("previous attempt was interrupted by the host; continue, don't redo completed side effects"), or skip re-sending the request.
- Record delivery when `session/prompt` is sent, not when it resolves, to close the replay race. The cost: a request Devin rejected before accepting it would not be replayed.

### Reproduction (scratch dir, outside the repo)
- Scripts and dumps are in `/Users/daniels/scratch/thinking-loop-probe/`. The DB was opened with `file:…/sessions.db?mode=ro`.
- `build_events.py` turns the `message_nodes`/`tool_call_state` rows of session `veiled-hoodie` into steps. Stream and final nodes are deduplicated: each step is stored twice with identical thinking.
- `steps_rendered.json` applies the rendered MCP title form.
- `bun replay.ts steps_rendered.json full 16` follows the event order of `provider.ts` `onChunk` and feeds 16-char deltas to the real `node_modules/@oh-my-pi/pi-ai/src/utils/thinking-loop.ts` (identical to `_ref`).
  - Variants: `no-tools` (never trips), `tools-only`, `thoughts-dup`, `titles-only`.
  - `thoughts-dup` models Devin re-sending each thought. It trips attempt 1 at 10:56:50 (wrong time) and trips attempt 3 (which succeeded), so ACP sends each thought once.
- `bun replay_text.ts success_thinking.txt|success_text.txt` replays the real successful turn: neither trips.
- `bun synth.ts` runs the non-Gemini exact-cycle check.

### Not verified
- The live ACP `tool_call_update` payloads were not captured. The settled MCP title and tool name are inferred from the successful turn's rendered thinking, which matches DB attempt 3 line for line.
- Step-internal timing of thought chunks versus tool settles is approximated as: thought, then that step's tools.
- No live Devin run was made.

## Investigation Log

## Root Cause
The extension streams every settled Devin tool call into the thinking block as its own paragraph (`provider.ts:192`, `agent.ts:480-481`, `transcript.ts:180`). Repeated MCP calls (`history_list_sessions`, `history_sql`) yield identical 67-87 char paragraphs. After thought paragraphs fill the guard's 8-segment warm-up, 4-5 identical ones trip the near-duplicate rule. Replay (`~/scratch/thinking-loop-probe`, `bun replay.ts steps_rendered.json full 16`) reproduces both aborts and does not trip without tool lines.
The abort cancels Devin (`session/cancel`), and the retry resends the bare request into the same session (`provider.ts:204` marks delivery before the retry).

## Recommendations
1. Stop emitting settled-tool lines as `thinking_delta`; surface them via the live-view/status path (needs a UI hook on `DevinProviderHost`). Also removes the exact-cycle risk for non-Gemini models (10 identical `✓ read: Read file` lines).
2. Harden the retry: mark a resumed prompt after a cancelled attempt, and record delivery at send time.
3. Do not drop/trim thoughts; do not disable the host guard globally.

Note: an earlier session note claimed ~3 tool calls before the abort; that was wrong (15). The first hypothesis (tool lines) was correct.

## Resolution
- `src/devin/provider.ts`: settled tool lines go to `host.showActivity` (omp working message via `setWorkingMessage`, wired in `src/index.ts`), never to `thinking_delta`.
- Delivery is recorded at send time (restored if `session/prompt` throws); an attempt is marked unfinished at send time, so a same-message host retry is prefixed with `src/devin/prompts/resume.md`.
- Verified: real provider `streamSimple` wrapped in pi-ai `withThinkingLoopGuard`, fed the recorded incident events: HEAD trips attempts 1/2 (4 and 5 near-identical), working tree trips none. Retry race with a 300 ms cancel: HEAD replays history twice; working tree sends the resume prompt, then bare. Real `devin/gemini-4-neon` turn (`omp --no-extensions -e src/index.ts`): 3 tool calls, thinking has no tool lines, log `resumed:false`, `end_turn`.
