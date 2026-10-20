/**
 * Builds omp's `devin/*` model list from two Devin sources:
 *
 * - the ACP session, which is authoritative for what `session/set_config_option`
 *   accepts: one `model` value per family (its suffix is only the family's
 *   default level, e.g. `gpt-6-1-sol-medium`) plus a per-model `thought_level`
 *   option whose allowed values differ by family (`swe-2`: medium/high/max,
 *   `claude-opus-4-6`: none at all);
 * - `devin models list --format json`, the only source of prices, context
 *   windows, and display labels.
 *
 * Each ACP model becomes one omp model named after its family (`gpt-6-1-sol`),
 * carrying that family's levels as omp efforts, so the effort control picks the
 * level instead of a pinned id hiding it.
 */
import type { Effort } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type { DevinAgent, DevinLogger } from "./agent";

/** Devin's level names that are also omp effort names, in omp's order. */
const OMP_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** Devin's lowest level on families that can skip reasoning; omp calls it `minimal`. */
const DEVIN_NONE = "none";

const FALLBACK_CONTEXT_WINDOW = 200_000;
const FALLBACK_MAX_TOKENS = 64_000;
const LIST_TIMEOUT_MS = 30_000;

export interface DevinPrice {
	/** USD per million tokens, the unit omp's `cost` fields use. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface CliVariant {
	model_uid: string;
	label?: string;
	cost_summary?: string;
	max_context_tokens?: number;
	max_output_tokens?: number;
}

interface CliModelList {
	families?: { family_uid: string; variants?: CliVariant[] }[];
}

interface ProbedModel {
	wireId: string;
	levels: string[];
	defaultLevel?: string;
}

/**
 * Parses `"$2 / 1M Input · $0.1 / 1M Cached input · $10 / 1M Output"`. Returns
 * undefined for anything without an input and output rate rather than guessing.
 */
export function parseCostSummary(summary: string | undefined): DevinPrice | undefined {
	if (!summary) return undefined;
	const price: DevinPrice = { input: Number.NaN, output: Number.NaN, cacheRead: 0, cacheWrite: 0 };
	for (const match of summary.matchAll(/\$([\d.]+)\s*\/\s*1M\s+([A-Za-z ]+?)\s*(?:·|$)/g)) {
		const rate = Number(match[1]);
		const label = match[2]?.trim().toLowerCase();
		if (!Number.isFinite(rate) || !label) continue;
		if (label === "input") price.input = rate;
		else if (label === "output") price.output = rate;
		else if (label.startsWith("cached input") || label.startsWith("cache read")) price.cacheRead = rate;
		else if (label.startsWith("cache write") || label.startsWith("cached write")) price.cacheWrite = rate;
	}
	return Number.isFinite(price.input) && Number.isFinite(price.output) ? price : undefined;
}

/** `gpt-6-1-sol-medium` with default level `medium` → `gpt-6-1-sol`; anything else stays whole. */
export function familyId(wireId: string, defaultLevel: string | undefined): string {
	if (!defaultLevel) return wireId;
	const suffix = `-${defaultLevel}`;
	return wireId.endsWith(suffix) && wireId.length > suffix.length ? wireId.slice(0, -suffix.length) : wireId;
}

/**
 * The ACP `model` value behind an omp id: the id itself (fusion models, models
 * without levels, ids selected before families existed) or `<family>-<level>`.
 */
export function resolveWireModel(id: string, offered: readonly string[]): string | undefined {
	if (offered.includes(id)) return id;
	return offered.find(value => value.startsWith(`${id}-`) && isLevelName(value.slice(id.length + 1)));
}

function isLevelName(value: string): boolean {
	return value === DEVIN_NONE || (OMP_EFFORTS as readonly string[]).includes(value);
}

/** omp effort → the Devin level the model accepts, via the model's `effortMap`. */
export function levelForEffort(
	effort: Effort | undefined,
	effortMap: Partial<Record<Effort, string>> | undefined,
): string | undefined {
	if (!effort) return undefined;
	return effortMap?.[effort] ?? effort;
}

/**
 * Sessions probed in parallel. Each `set_config_option` costs ~0.5 s and the
 * host drops a `fetchDynamicModels` that exceeds 15 s; 82 models probed
 * serially took 29 s. Eight sessions keep each one to ~11 sets.
 */
const PROBE_SESSIONS = 8;

/**
 * Reads every model's level set. The level set and default exist only once the
 * model is selected, and only the `set_config_option` reply carries them, so
 * each model needs one round trip on some session. Every session advertises
 * the same `model` values, so the sessions drain one shared queue.
 */
async function probeModels(start: () => Promise<DevinAgent>, logger: DevinLogger): Promise<ProbedModel[]> {
	const started = await Promise.allSettled(Array.from({ length: PROBE_SESSIONS }, () => start()));
	const agents = started.flatMap(result => (result.status === "fulfilled" ? [result.value] : []));
	try {
		const first = agents[0];
		if (!first) {
			const failure = started.find(result => result.status === "rejected");
			throw failure?.status === "rejected" ? failure.reason : new Error("No Devin probe session started");
		}
		if (agents.length < PROBE_SESSIONS) {
			logger.warn("devin-acp: some catalog probe sessions failed to start", {
				started: agents.length,
				wanted: PROBE_SESSIONS,
			});
		}
		const queue = first.configValues("model");
		const probed = new Map<string, ProbedModel>();
		let next = 0;
		await Promise.all(
			agents.map(async agent => {
				while (next < queue.length) {
					const wireId = queue[next++] as string;
					if (agent.configValue("model") !== wireId) await agent.setConfigOption("model", wireId);
					probed.set(wireId, {
						wireId,
						levels: agent.configValues("thought_level"),
						defaultLevel: agent.configValue("thought_level"),
					});
				}
			}),
		);
		// Keep Devin's advertised order, which is its own recommendation order.
		return queue.flatMap(wireId => {
			const entry = probed.get(wireId);
			return entry ? [entry] : [];
		});
	} finally {
		await Promise.all(agents.map(agent => agent.shutdown("model catalog probe complete")));
	}
}

/** Prices and limits keyed by every variant id `devin models list` reports. */
async function listCliVariants(binary: string, logger: DevinLogger): Promise<Map<string, CliVariant>> {
	const variants = new Map<string, CliVariant>();
	const child = Bun.spawn([binary, "models", "list", "--format", "json"], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		timeout: LIST_TIMEOUT_MS,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		logger.warn("devin-acp: `devin models list` failed; Devin models will show no prices", {
			exitCode,
			stderr: stderr.slice(-500),
		});
		return variants;
	}
	try {
		const list = JSON.parse(stdout) as CliModelList;
		for (const family of list.families ?? []) {
			for (const variant of family.variants ?? []) variants.set(variant.model_uid, variant);
		}
	} catch (error) {
		logger.warn("devin-acp: unparseable `devin models list` output; Devin models will show no prices", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return variants;
}

/**
 * Price, limits, and label for an ACP model. Variants of one family share a
 * price, so a family whose ACP id is missing from the CLI list (`claude-opus-5`)
 * borrows any `<family>-<level>` sibling's numbers.
 */
function cliVariantFor(probed: ProbedModel, family: string, variants: Map<string, CliVariant>): CliVariant | undefined {
	const exact = variants.get(probed.wireId);
	if (exact) return exact;
	for (const [uid, variant] of variants) {
		if (uid.startsWith(`${family}-`) && isLevelName(uid.slice(family.length + 1))) return variant;
	}
	return undefined;
}

function displayName(variant: CliVariant | undefined, family: string, wireId: string): string {
	const label = variant?.label;
	if (!label) return family;
	// Labels name the level ("GPT-6.1 Sol Medium"); the family model picks it via effort.
	return family === wireId ? label : label.replace(/\s+(None|Minimal|Low|Medium|High|XHigh|Max)$/i, "");
}

function toModelConfig(probed: ProbedModel, variants: Map<string, CliVariant>): ProviderModelConfig {
	const family = familyId(probed.wireId, probed.defaultLevel);
	const variant = cliVariantFor(probed, family, variants);
	const price = parseCostSummary(variant?.cost_summary);
	const efforts: Effort[] = [];
	const effortMap: Partial<Record<Effort, string>> = {};
	for (const effort of OMP_EFFORTS) {
		if (probed.levels.includes(effort)) efforts.push(effort as Effort);
		else if (effort === "minimal" && probed.levels.includes(DEVIN_NONE)) {
			efforts.push(effort as Effort);
			effortMap[effort as Effort] = DEVIN_NONE;
		}
	}
	const defaultEffort =
		probed.defaultLevel === DEVIN_NONE ? "minimal" : (OMP_EFFORTS as readonly string[]).includes(probed.defaultLevel ?? "")
			? probed.defaultLevel
			: undefined;
	return {
		id: family,
		name: displayName(variant, family, probed.wireId),
		reasoning: efforts.length > 0,
		...(efforts.length > 0
			? {
					thinking: {
						mode: "effort" as const,
						efforts,
						...(defaultEffort ? { defaultLevel: defaultEffort as Effort } : {}),
						...(Object.keys(effortMap).length > 0 ? { effortMap } : {}),
					},
				}
			: {}),
		input: ["text"],
		cost: price ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: variant?.max_context_tokens ?? FALLBACK_CONTEXT_WINDOW,
		maxTokens: variant?.max_output_tokens ?? FALLBACK_MAX_TOKENS,
	};
}

/** The omp model list for `fetchDynamicModels`; every probe session is shut down here. */
export async function fetchDevinCatalog(
	startProbe: () => Promise<DevinAgent>,
	binary: string,
	logger: DevinLogger,
): Promise<ProviderModelConfig[]> {
	const [probed, variants] = await Promise.all([
		probeModels(startProbe, logger),
		listCliVariants(binary, logger),
	]);
	const seen = new Set<string>();
	const models: ProviderModelConfig[] = [];
	for (const entry of probed) {
		const model = toModelConfig(entry, variants);
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}
