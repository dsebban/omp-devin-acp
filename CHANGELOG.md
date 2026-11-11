# Changelog

## Unreleased

- Follow Devin's own permission configuration. The session starts in the ACP mode matching Devin's `permission_mode` (`DEVIN_PERMISSION_MODE` or `~/.config/devin/config.json`) instead of a forced `--permission-mode auto` and `accept-edits`; `dangerous` maps to `bypass`. Devin's `permissions` rules decide first.
- Show Devin's own permission choices (once, always for the project, reject) when Devin asks, on both the `devin` tool and the `/model` provider path. Previously the provider path answered every request `cancelled`, so Devin silently dropped those tool calls. A dismissed dialog now selects Devin's reject option; without an interactive UI the request is refused and logged.
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
