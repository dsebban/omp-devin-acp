import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Launch-time knobs; every field has an env-var default (see README). */
export interface DevinLaunchConfig {
	/** `devin` binary path. */
	binary: string;
	/** CLI permission floor, passed as `--permission-mode` only when set; unset, Devin reads its own config. */
	permissionMode?: string;
	/** ACP session mode the caller asked for; an unknown id is an error. */
	sessionMode?: string;
	/**
	 * ACP session mode matching Devin's own `permission_mode` (config file or
	 * `DEVIN_PERMISSION_MODE`). Devin's ACP server ignores that setting and always
	 * starts in `accept-edits`, so the extension applies it — when advertised.
	 */
	configuredSessionMode?: string;
	/** Value for the `model` session config option (Devin has no `session/set_model`). */
	model?: string;
	/** Value for the `thought_level` session config option. */
	thoughtLevel?: string;
	/** Hide the user's `mcp_config.json` from the child so omp's delegate runs with no foreign MCP servers. */
	isolateMcp: boolean;
	/** Pass `--respect-workspace-trust false` for directories the user has not trusted interactively. */
	respectWorkspaceTrust: boolean;
}

export interface PreparedLaunch {
	argv: string[];
	env: Record<string, string>;
	/** Temp overlay root to remove once the child exits, when one was built. */
	overlayRoot?: string;
}

/** Overrides accepted per tool call; anything omitted falls back to the env/default config. */
export interface DevinLaunchOverrides {
	permissionMode?: string;
	sessionMode?: string;
	model?: string;
	thoughtLevel?: string;
}

/**
 * Devin's `permission_mode` values and the ACP session mode each corresponds to.
 * ACP has no mode that prompts for workspace edits, so `normal`/`auto` keep
 * Devin's ACP default (`accept-edits`).
 */
const SESSION_MODE_FOR_PERMISSION_MODE: Record<string, string | undefined> = {
	"accept-edits": "accept-edits",
	smart: "smart",
	dangerous: "bypass",
	bypass: "bypass",
};
/** Temp-dir prefix and owner marker of the MCP isolation overlays. */
const OVERLAY_PREFIX = "omp-devin-acp-";
const OWNER_FILE = ".omp-owner";
/** Age at which an overlay with no owner marker is assumed abandoned, not mid-creation. */
const UNOWNED_GRACE_MS = 60 * 60 * 1000;

function envFlag(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	return !(raw === "0" || raw.toLowerCase() === "false" || raw.toLowerCase() === "no");
}

export function resolveLaunchConfig(overrides: DevinLaunchOverrides = {}): DevinLaunchConfig {
	const binary = process.env.OMP_DEVIN_BIN || Bun.which("devin") || "devin";
	const permissionMode = overrides.permissionMode ?? (process.env.OMP_DEVIN_PERMISSION_MODE || undefined);
	// Same precedence as Devin's own `--permission-mode`: flag, env, config file.
	const devinPermissionMode = permissionMode ?? (process.env.DEVIN_PERMISSION_MODE || devinConfigPermissionMode());
	return {
		binary,
		permissionMode,
		sessionMode: overrides.sessionMode ?? (process.env.OMP_DEVIN_SESSION_MODE || undefined),
		configuredSessionMode: devinPermissionMode ? SESSION_MODE_FOR_PERMISSION_MODE[devinPermissionMode] : undefined,
		model: overrides.model ?? process.env.OMP_DEVIN_MODEL ?? undefined,
		thoughtLevel: overrides.thoughtLevel ?? process.env.OMP_DEVIN_THOUGHT_LEVEL ?? undefined,
		isolateMcp: envFlag("OMP_DEVIN_ISOLATE_MCP", true),
		respectWorkspaceTrust: envFlag("OMP_DEVIN_WORKSPACE_TRUST", true),
	};
}

function userConfigRoot(): string {
	return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

/** `permission_mode` from Devin's user config (JSON with comments); a user-only setting. */
function devinConfigPermissionMode(): string | undefined {
	try {
		const text = readFileSync(path.join(userConfigRoot(), "devin", "config.json"), "utf8");
		const value = (Bun.JSONC.parse(text) as { permission_mode?: unknown } | null)?.permission_mode;
		return typeof value === "string" ? value : undefined;
	} catch {
		// No config file, or one Devin itself would reject: Devin's defaults apply.
		return undefined;
	}
}

/**
 * Mirror `~/.config` into a temp root with only `devin/mcp_config.json` blanked.
 *
 * `XDG_CONFIG_HOME` is the whole config root, not Devin's slice of it: a naive
 * override also hides `gh/`, `git/`, and every other tool Devin shells out to
 * (measured: `gh auth status` inside Devin reported no GitHub hosts). So every
 * entry of the real root is symlinked through, `devin/` is rebuilt entry by
 * entry, and only the MCP file is replaced. Credentials live under
 * `XDG_DATA_HOME` (`~/.local/share/devin/credentials.toml`), so authentication
 * is unaffected.
 */
async function prepareMcpIsolationRoot(): Promise<string> {
	const configRoot = userConfigRoot();
	const devinConfig = path.join(configRoot, "devin");
	// A fresh directory per launch: a shared path would make concurrent tool
	// calls collide on symlink creation and let a later launch delete the
	// overlay a running child is reading.
	const overlayRoot = await fs.mkdtemp(path.join(os.tmpdir(), OVERLAY_PREFIX));
	// Written before the contents: the sweep treats an unmarked overlay as
	// possibly mid-creation, so the marker must exist from the first moment.
	await Bun.write(path.join(overlayRoot, OWNER_FILE), `${process.pid}\n`);
	const overlayDevin = path.join(overlayRoot, "devin");
	await fs.mkdir(overlayDevin, { recursive: true });

	for (const entry of await readdirSafe(configRoot)) {
		if (entry === "devin") continue;
		await fs.symlink(path.join(configRoot, entry), path.join(overlayRoot, entry));
	}
	for (const entry of await readdirSafe(devinConfig)) {
		if (entry === "mcp_config.json") continue;
		await fs.symlink(path.join(devinConfig, entry), path.join(overlayDevin, entry));
	}
	await Bun.write(path.join(overlayDevin, "mcp_config.json"), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
	return overlayRoot;
}

/**
 * Remove overlays whose owning process is gone.
 *
 * A SIGKILLed omp cannot clean up after itself, so each launch sweeps the
 * leftovers of dead owners. Live overlays of other omp processes are kept, and
 * an unmarked directory is only reclaimed once it is too old to be mid-creation.
 */
export async function sweepStaleOverlays(): Promise<void> {
	const tmp = os.tmpdir();
	for (const entry of await readdirSafe(tmp)) {
		if (!entry.startsWith(OVERLAY_PREFIX)) continue;
		const root = path.join(tmp, entry);
		const owner = Number((await Bun.file(path.join(root, OWNER_FILE)).text().catch(() => "")).trim());
		if (!Number.isFinite(owner) || owner <= 0) {
			const stat = await fs.stat(root).catch(() => undefined);
			if (stat && Date.now() - stat.mtimeMs > UNOWNED_GRACE_MS) {
				await fs.rm(root, { recursive: true, force: true }).catch(() => {});
			}
			continue;
		}
		try {
			// Signal 0 only probes: it throws ESRCH when the process is gone.
			process.kill(owner, 0);
		} catch {
			await fs.rm(root, { recursive: true, force: true }).catch(() => {});
		}
	}
}

/** Directory entries, or none when the directory does not exist. */
async function readdirSafe(dir: string): Promise<string[]> {
	try {
		return await fs.readdir(dir);
	} catch {
		// Nothing to mirror: an empty overlay level is still correct.
		return [];
	}
}

export async function prepareLaunch(config: DevinLaunchConfig): Promise<PreparedLaunch> {
	const argv = [config.binary];
	if (config.permissionMode) argv.push("--permission-mode", config.permissionMode);
	if (!config.respectWorkspaceTrust) argv.push("--respect-workspace-trust", "false");
	argv.push("acp");

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	if (!config.isolateMcp) return { argv, env };
	// Off the critical path: reclaims overlays left by SIGKILLed omp processes.
	void sweepStaleOverlays().catch(() => {});
	const overlayRoot = await prepareMcpIsolationRoot();
	env.XDG_CONFIG_HOME = overlayRoot;
	return { argv, env, overlayRoot };
}
