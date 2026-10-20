# Agent Guidance

This is the standalone `omp-devin-acp` extension, not the oh-my-pi monorepo. Keep changes here; do not patch the host or alter a user's global settings unless requested. Read README.md for installation, permission behavior, protocol evidence, and the feature verification map.

## Ownership And Contracts

- `src/index.ts` owns extension registration and a registry per omp session. Never move the registry to module scope: a subagent's shutdown must not terminate its parent's Devin process.
- `src/devin/agent.ts` owns ACP lifecycle and serializes turns; `src/acp/peer.ts` owns NDJSON JSON-RPC. Classify messages by field presence, not serialized field order.
- `src/devin/catalog.ts` derives accepted models/levels from ACP and prices/limits from the CLI. Never freeze an account-specific roster or infer allowed efforts from a model suffix. Keep discovery within the host's timeout and shut down all owned probes.
- `src/devin/provider.ts` owns omp effort routing, streaming, and token-rate estimates. Honor host `effortRouting` before resolving a wire id. Devin input tokens include both caches: subtract them before charging uncached input. USD estimates are not Devin ACU billing.
- `src/devin/history.ts` owns missed-history replay; preserve its limits and per-live-session delivery tracking. Prompts live in static Markdown files under `src/devin/prompts/`.
- `src/devin/launch.ts` owns launch configuration and isolation overlays. Preserve owner markers, credential access, and the documented limits of MCP isolation.

## Safety

Devin runs its own tools. omp approvals do not gate its actions in the default ACP mode. Never describe `ask` as an interactive approval mode or MCP isolation as complete sandboxing. Use disposable fixtures for QA and stop only processes created by the check. Do not kill a user's active omp/Devin session, clear their model databases, change their default model, or expose raw logs as a shortcut.

## Verification And Release

Run `bun run check` and `git diff --check`. There is no automated integration suite yet: a typecheck is not proof of ACP behavior. For runtime changes, exercise the affected real user path using the README feature map; record exact commands and observable results. Credentialed model calls can incur charges. Report untested paths explicitly and distinguish unrelated environment warnings from provider failures.

Keep README examples and migration notes aligned with the implementation; provider family ids differ from the exact Devin wire ids accepted by tool/command overrides. Update CHANGELOG.md and the package version together for releases. Review only intended changes, preserve concurrent work, and obtain authorization before pushing or publishing. Never replace an existing release tag. After an authorized push, verify the remote commit and tag. Running omp sessions need `/restart` to load updated extension code.
