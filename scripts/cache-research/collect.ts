/**
 * Cross-provider prompt-cache retention harness, v2 (methodology-corrected).
 *
 * Research question: does a cached prompt prefix survive an idle gap (a long tool
 * call, think time between turns), and can a periodic keepalive read of the
 * prefix keep it warm when it otherwise would be evicted?
 *
 * v1 of this harness was invalidated by review. The defects and their fixes:
 *
 *  1. REQUEST QUEUEING (fatal). v1 started all cells at once; every reqA entered
 *     a global semaphore at t=0, and the call timer started only after acquiring
 *     a slot. reqB for a nominal 60s idle could execute ~6-10 minutes after reqA
 *     (measured reqA drain alone: 356-594s at concurrency 8), so "evicted under
 *     60s" and the idle=0 reference being 0/72 warm were queueing artifacts.
 *     Fixes:
 *       (a) Cells are launched staggered and in bounded sub-batches, so offered
 *           load stays below the HTTP concurrency limit (queue wait ~= 0 by
 *           construction).
 *       (b) Every call records queuedAt/startedAt/completedAt. A cell is VALID
 *           only if reqB's queue wait and the idle slip (true idle - nominal
 *           idle) are within tolerance. True idle is recorded per cell.
 *       (c) idle=0 warm-reference cells in every block act as a run-level sanity
 *           gate: an immediate re-read of a just-written prefix MUST be warm.
 *           If it is not, the run's timing is broken and the run is flagged.
 *
 *  2. UNRECORDED KEEPALIVE PINGS. v1 fired pings fire-and-forget through the
 *     same congested semaphore. v2 awaits every ping and records its full timing,
 *     usage, provider, cost, and errors; the keepalive schedule fidelity (max
 *     gap between warmth-refreshing calls) is reported and gated.
 *
 *  3. COST ACCOUNTING. v1 excluded pings from cost, making the keepalive look
 *     free (the "12.5x saving" was just Anthropic's write/read price ratio). v2
 *     records cost for every call and reports per-cell totals: reqA + pings +
 *     reqB, so strategy cost is compared honestly.
 *
 *  4. ROUTING SEMANTICS. OpenRouter's provider.only pins an endpoint, not a
 *     machine. Anthropic and OpenAI are now queried first-party (no router);
 *     OpenAI additionally gets prompt_cache_key (its documented affinity lever).
 *     DeepSeek stays on OpenRouter with a backend pin, and any cell whose served
 *     backend changes between reqA/pings/reqB is invalid.
 *
 *  5. INTERFERENCE + STATISTICAL INDEPENDENCE. v1 ran baseline and keepalive
 *     cells simultaneously, so keepalive traffic pressured the shared tier during
 *     baseline measurements, and Fisher/Mann-Whitney treated within-run
 *     observations as independent. v2 runs conditions in separate, time-blocked
 *     phases (order alternated across replicates), shuffles and staggers cells
 *     within a block with a seeded RNG, and leaves per-run replication to
 *     stats.py, which treats the run (not the sample) as the independence unit.
 *
 * Output: JSONL. First line is a run-meta header; then one object per cell;
 * final line is a run-meta summary with the warm-reference gate verdict and full
 * cost breakdown.
 *
 * Usage:
 *   node --import tsx scripts/cache-research/collect.ts \
 *     --models anthropic:claude-sonnet-4-5,openai:gpt-5.1,openrouter:deepseek/deepseek-v3.2@DeepInfra \
 *     --sizes 40000,100000 --idles 0,60,300,600 --samples 8 \
 *     --keepalive-interval 30000 --concurrency 6 --stagger-ms 1500 --subbatch-size 48 \
 *     --block-order baseline-first --out scripts/cache-research/data/run.jsonl
 *
 *   --check   preflight: one tiny call per model, prints reachability + usage.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	buildMessages,
	parseModelSpec,
	requiredKeys,
	transportCall,
	type Keys,
	type ModelSpec,
	type UsageNorm,
} from "./providers.ts";

interface Options {
	models: string[];
	sizes: number[];
	idles: number[];
	samples: number;
	keepAliveIntervalMs: number;
	concurrency: number;
	maxTokens: number;
	out: string;
	runId: string;
	staggerMs: number;
	subbatchSize: number;
	blockOrder: "baseline-first" | "keepalive-first";
	seed: number;
	maxQueueWaitMs: number;
	maxIdleSlipS: number;
	onlyBlock?: "baseline" | "keepalive";
	check: boolean;
	pressureQps: number;
	pressureSizeTokens: number;
	retryAttempts: number;
}

function parseArgs(argv: string[]): Options {
	const o: Options = {
		models: ["anthropic:claude-sonnet-4-5", "openai:gpt-5.1", "google:gemini-2.5-pro", "openrouter:deepseek/deepseek-v3.2@DeepInfra"],
		sizes: [40000, 100000],
		idles: [0, 60, 300, 600],
		samples: 8,
		keepAliveIntervalMs: 30_000,
		concurrency: 6,
		maxTokens: 8,
		out: "scripts/cache-research/data/run.jsonl",
		runId: `run-${Math.floor(Date.now() / 1000)}`,
		staggerMs: 1500,
		subbatchSize: 48,
		blockOrder: "baseline-first",
		seed: 0,
		maxQueueWaitMs: 5000,
		maxIdleSlipS: 10,
		check: false,
		pressureQps: 0,
		pressureSizeTokens: 40000,
		retryAttempts: 6,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`Missing value for ${arg}`);
			return v;
		};
		switch (arg) {
			case "--models":
				o.models = next().split(",").map((s) => s.trim()).filter(Boolean);
				break;
			case "--sizes":
				o.sizes = next().split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
				break;
			case "--idles":
				o.idles = next().split(",").map((s) => Number(s.trim())).filter((n) => n >= 0);
				break;
			case "--samples":
				o.samples = Number(next());
				break;
			case "--keepalive-interval":
				o.keepAliveIntervalMs = Number(next());
				break;
			case "--concurrency":
				o.concurrency = Number(next());
				break;
			case "--max-tokens":
				o.maxTokens = Number(next());
				break;
			case "--out":
				o.out = next();
				break;
			case "--run-id":
				o.runId = next();
				break;
			case "--stagger-ms":
				o.staggerMs = Number(next());
				break;
			case "--subbatch-size":
				o.subbatchSize = Number(next());
				break;
			case "--block-order": {
				const v = next();
				if (v !== "baseline-first" && v !== "keepalive-first") throw new Error(`bad --block-order ${v}`);
				o.blockOrder = v;
				break;
			}
			case "--seed":
				o.seed = Number(next());
				break;
			case "--max-queue-wait-ms":
				o.maxQueueWaitMs = Number(next());
				break;
			case "--max-idle-slip-s":
				o.maxIdleSlipS = Number(next());
				break;
			case "--only-block": {
				const v = next();
				if (v !== "baseline" && v !== "keepalive") throw new Error(`bad --only-block ${v}`);
				o.onlyBlock = v;
				break;
			}
			case "--check":
				o.check = true;
				break;
			case "--retry-attempts":
				o.retryAttempts = Number(next());
				break;
			case "--pressure-qps":
				o.pressureQps = Number(next());
				break;
			case "--pressure-size":
				o.pressureSizeTokens = Number(next());
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!o.seed) o.seed = [...o.runId].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
	return o;
}

/** ms since process start (monotonic). */
const now = (): number => performance.now();

/** One executed HTTP call with full queueing observability. */
interface CallRecord {
	/** Wall-clock schedule target for keepalive pings (ms since run start). */
	scheduledAtMs?: number;
	queuedAtMs: number;
	startedAtMs: number;
	completedAtMs: number;
	ttftMs?: number;
	provider?: string;
	promptTokens: number;
	cachedTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	costUsd: number;
	costSource: string;
	error?: string;
}

type Condition = "warm" | "baseline" | "keepalive";

interface CellSpec {
	model: string; // spec string
	sizeTokens: number;
	idleSeconds: number;
	condition: Condition;
	sample: number;
	block: "A" | "B";
}

interface Validity {
	reqAOk: boolean;
	reqBOk: boolean;
	queueOk: boolean;
	idleOk: boolean;
	backendOk: boolean;
	keepaliveScheduleOk: boolean;
	overall: boolean;
}

interface CellResult {
	v: 2;
	runId: string;
	model: string; // label without pin
	transport: string;
	sizeTokens: number;
	idleSeconds: number;
	condition: Condition;
	sample: number;
	block: "A" | "B";
	cellStartedAtMs: number;
	reqA?: CallRecord;
	pings: CallRecord[];
	pingsPlanned: number;
	reqB?: CallRecord;
	/** The idle the cache entry actually experienced: reqB start - reqA end. */
	trueIdleSeconds?: number;
	/** Time reqB spent waiting for a local HTTP slot. */
	reqBQueueWaitMs?: number;
	/** Longest gap between consecutive successful cache-touching calls. */
	maxRefreshGapMs?: number;
	backendMismatch?: boolean;
	validity: Validity;
	cost: { reqA: number; pings: number; reqB: number; total: number };
	error?: string;
}

/** Global semaphore bounding in-flight HTTP calls. */
class Semaphore {
	private available: number;
	private readonly queue: Array<() => void> = [];
	constructor(count: number) {
		this.available = count;
	}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.available <= 0) {
			await new Promise<void>((resolve) => this.queue.push(resolve));
		}
		this.available--;
		try {
			return await fn();
		} finally {
			this.available++;
			this.queue.shift()?.();
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** mulberry32: deterministic shuffle so runs are reproducible from --seed. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffled<T>(items: T[], rand: () => number): T[] {
	const a = [...items];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[a[i], a[j]] = [a[j]!, a[i]!];
	}
	return a;
}

const KEYS: Keys = {
	anthropic: process.env.ANTHROPIC_API_KEY,
	openai: process.env.OPENAI_API_KEY,
	google: process.env.GEMINI_API_KEY,
	openrouter: process.env.OPENROUTER_API_KEY,
};

let http = new Semaphore(1); // rebound in main()

/** One metered call: stamps queue/start/end around the transport. */
async function meteredCall(
	spec: ModelSpec,
	messages: unknown[],
	maxTokens: number,
	salt: string,
	scheduledAtMs?: number,
): Promise<CallRecord> {
	const queuedAtMs = now();
	let ttftMs: number | undefined;
	const inner = await http.run(async () => {
		const startedAtMs = now();
		const result = await transportCall(spec, messages, maxTokens, KEYS, salt, () => {
			ttftMs = now() - startedAtMs;
		});
		return { result, startedAtMs };
	});
	const completedAtMs = now();
	const u: UsageNorm = inner.result.usage;
	return {
		scheduledAtMs,
		queuedAtMs,
		startedAtMs: inner.startedAtMs,
		completedAtMs,
		ttftMs,
		provider: inner.result.provider,
		promptTokens: u.promptTokens,
		cachedTokens: u.cachedTokens,
		cacheWriteTokens: u.cacheWriteTokens,
		outputTokens: u.outputTokens,
		costUsd: u.costUsd,
		costSource: u.costSource,
		error: inner.result.error,
	};
}

/** Retry transient failures (overloaded / 429 / 5xx / network) with backoff. */
async function callWithRetry(
	spec: ModelSpec,
	messages: unknown[],
	maxTokens: number,
	salt: string,
	scheduledAtMs?: number,
	attempts = 6,
): Promise<CallRecord> {
	let last: CallRecord | undefined;
	for (let attempt = 0; attempt < attempts; attempt++) {
		last = await meteredCall(spec, messages, maxTokens, salt, scheduledAtMs);
		if (!last.error) return last;
		const transient = /HTTP (429|5\d\d)|overload|timeout|network|fetch failed|ECONN|socket/i.test(last.error);
		if (!transient) return last;
		// 429 quota windows are per-minute; give them room to clear.
		await sleep(Math.min(90_000, 2000 * 2 ** attempt));
	}
	return last!;
}

async function runCell(o: Options, cell: CellSpec): Promise<CellResult> {
	const spec = parseModelSpec(cell.model);
	const salt = `${o.runId}|${spec.label}|${cell.sizeTokens}|${cell.idleSeconds}|${cell.condition}|${cell.sample}`;
	const messages = buildMessages(spec, cell.sizeTokens, salt);
	const result: CellResult = {
		v: 2,
		runId: o.runId,
		model: spec.label,
		transport: spec.transport,
		sizeTokens: cell.sizeTokens,
		idleSeconds: cell.idleSeconds,
		condition: cell.condition,
		sample: cell.sample,
		block: cell.block,
		cellStartedAtMs: now(),
		pings: [],
		pingsPlanned: 0,
		validity: {
			reqAOk: false,
			reqBOk: false,
			queueOk: false,
			idleOk: false,
			backendOk: true,
			keepaliveScheduleOk: true,
			overall: false,
		},
		cost: { reqA: 0, pings: 0, reqB: 0, total: 0 },
	};

	// reqA: write the cache.
	result.reqA = await callWithRetry(spec, messages, o.maxTokens, salt, undefined, o.retryAttempts);
	result.cost.reqA = result.reqA.costUsd;
	result.validity.reqAOk = !result.reqA.error && result.reqA.promptTokens > 0;
	if (!result.validity.reqAOk) {
		result.error = `reqA: ${result.reqA.error ?? "no tokens"}`;
		result.cost.total = result.cost.reqA;
		return result;
	}

	// idle phase. All times anchored to reqA completion: this, not wall-clock
	// cell start, is what the cache entry experiences.
	const aEnd = result.reqA.completedAtMs;
	const bTime = aEnd + cell.idleSeconds * 1000;
	if (cell.condition === "keepalive" && cell.idleSeconds > 0) {
		// Pings at exact offsets from reqA end; skip any that would land within
		// 1.5s of reqB (reqB is itself the refresh at that point). Every ping is
		// awaited and recorded — no fire-and-forget.
		const stop = bTime - 1500;
		for (let t = aEnd + o.keepAliveIntervalMs; t < stop; t += o.keepAliveIntervalMs) {
			result.pingsPlanned++;
			await sleep(Math.max(0, t - now()));
			const ping = await callWithRetry(spec, messages, o.maxTokens, salt, t, o.retryAttempts);
			result.pings.push(ping);
			result.cost.pings += ping.costUsd;
		}
	} else if (cell.idleSeconds > 0) {
		await sleep(Math.max(0, bTime - now()));
	}

	// reqB: the measured probe. Fire at bTime; any remaining delay is recorded
	// as queue wait and gated.
	await sleep(Math.max(0, bTime - now()));
	result.reqB = await callWithRetry(spec, messages, o.maxTokens, salt, undefined, o.retryAttempts);
	result.cost.reqB = result.reqB.costUsd;
	result.cost.total = result.cost.reqA + result.cost.pings + result.cost.reqB;

	// ---- measurement integrity ----
	result.validity.reqBOk = !result.reqB.error && result.reqB.promptTokens > 0;
	result.reqBQueueWaitMs = result.reqB.startedAtMs - result.reqB.queuedAtMs;
	result.trueIdleSeconds = (result.reqB.startedAtMs - aEnd) / 1000;
	result.validity.queueOk = result.reqBQueueWaitMs <= o.maxQueueWaitMs;
	result.validity.idleOk = result.trueIdleSeconds - cell.idleSeconds <= o.maxIdleSlipS;

	// Backend consistency across every call of the cell (router scatter check).
	const backends = [result.reqA, ...result.pings, result.reqB]
		.filter((c): c is CallRecord => Boolean(c) && !c.error)
		.map((c) => c.provider)
		.filter((p): p is string => Boolean(p));
	result.validity.backendOk = new Set(backends).size <= 1;
	result.backendMismatch = !result.validity.backendOk;

	// Keepalive schedule fidelity: longest gap between consecutive successful
	// cache-touching calls (reqA -> pings -> reqB). A keepalive that silently
	// failed for several intervals is not a keepalive.
	const touches = [result.reqA, ...result.pings, result.reqB]
		.filter((c): c is CallRecord => Boolean(c))
		.sort((x, y) => x.completedAtMs - y.completedAtMs);
	let maxGap = 0;
	for (let i = 1; i < touches.length; i++) {
		if (touches[i]!.error) continue;
		// gap from previous successful touch start to this touch start
		let prev = i - 1;
		while (prev > 0 && touches[prev]!.error) prev--;
		if (!touches[prev]!.error) maxGap = Math.max(maxGap, touches[i]!.startedAtMs - touches[prev]!.startedAtMs);
	}
	result.maxRefreshGapMs = maxGap;
	if (cell.condition === "keepalive" && cell.idleSeconds > 0) {
		result.validity.keepaliveScheduleOk = maxGap <= 2.5 * o.keepAliveIntervalMs + o.maxQueueWaitMs;
	}

	result.validity.overall =
		result.validity.reqAOk &&
		result.validity.reqBOk &&
		result.validity.queueOk &&
		result.validity.idleOk &&
		result.validity.backendOk &&
		result.validity.keepaliveScheduleOk;
	if (!result.validity.reqBOk) result.error = `reqB: ${result.reqB.error ?? "no tokens"}`;
	return result;
}

function planCells(o: Options): CellSpec[] {
	const cells: CellSpec[] = [];
	const baseBlock: "A" | "B" = o.blockOrder === "baseline-first" ? "A" : "B";
	const kaBlock: "A" | "B" = o.blockOrder === "baseline-first" ? "B" : "A";
	let warmIdx = 0;
	for (const model of o.models) {
		for (const sizeTokens of o.sizes) {
			for (const sample of Array.from({ length: o.samples }, (_, i) => i)) {
				for (const idleSeconds of o.idles) {
					if (idleSeconds === 0) {
						// Warm references split across both blocks so each block has a
						// harness-timing sanity gate.
						cells.push({ model, sizeTokens, idleSeconds, condition: "warm", sample, block: warmIdx++ % 2 === 0 ? "A" : "B" });
					} else {
						cells.push({ model, sizeTokens, idleSeconds, condition: "baseline", sample, block: baseBlock });
						cells.push({ model, sizeTokens, idleSeconds, condition: "keepalive", sample, block: kaBlock });
					}
				}
			}
		}
	}
	return cells;
}

/**
 * Optional pressure generator: an independent stream of unique junk prefixes
 * against the first configured model, for the honest version of the
 * load-dependence experiment. Off by default; when on, its calls share the HTTP
 * semaphore (they ARE the load) and are accounted separately.
 */
async function runPressure(o: Options, spec: ModelSpec, stop: { done: boolean }): Promise<{ calls: number; promptTokens: number; costUsd: number }> {
	let calls = 0;
	let promptTokens = 0;
	let costUsd = 0;
	const periodMs = 1000 / o.pressureQps;
	let i = 0;
	while (!stop.done) {
		const salt = `${o.runId}|pressure|${i++}`;
		const messages = buildMessages(spec, o.pressureSizeTokens, salt);
		const rec = await callWithRetry(spec, messages, 1, salt);
		calls++;
		promptTokens += rec.promptTokens;
		costUsd += rec.costUsd;
		// period is from call START to call START (load rate, not call count)
		await sleep(Math.max(0, periodMs - (rec.completedAtMs - rec.queuedAtMs)));
	}
	return { calls, promptTokens, costUsd };
}

async function preflight(o: Options): Promise<void> {
	for (const m of o.models) {
		const spec = parseModelSpec(m);
		const salt = `${o.runId}|preflight|${spec.label}`;
		// Above every provider's cache minimum (Anthropic 1024, OpenAI 1024,
		// Gemini 2.5 Pro implicit ~2048): 6000 tokens.
		const messages = buildMessages(spec, 6000, salt);
		console.log(`\n=== ${m} ===`);
		const a = await meteredCall(spec, messages, 8, salt);
		console.log(`call1: ${a.error ?? `ok provider=${a.provider} prompt=${a.promptTokens} cached=${a.cachedTokens} wrote=${a.cacheWriteTokens} cost=$${a.costUsd.toFixed(5)} ttft=${a.ttftMs?.toFixed(0)}ms`}`);
		if (a.error) continue;
		const b = await meteredCall(spec, messages, 8, salt);
		const hit = b.promptTokens > 0 ? ((b.cachedTokens / b.promptTokens) * 100).toFixed(0) : "n/a";
		console.log(`call2 (immediate re-read): ${b.error ?? `hit=${hit}% provider=${b.provider} cached=${b.cachedTokens}/${b.promptTokens} cost=$${b.costUsd.toFixed(5)} ttft=${b.ttftMs?.toFixed(0)}ms`}`);
		if (b.promptTokens > 0 && b.cachedTokens / b.promptTokens < 0.9) {
			console.log("WARNING: immediate re-read was NOT a cache hit — investigate before running");
		}
	}
}

async function main(): Promise<void> {
	const o = parseArgs(process.argv.slice(2));
	const specs = o.models.map(parseModelSpec);
	for (const k of requiredKeys(specs)) {
		if (!KEYS[k]) {
			console.error(`${k.toUpperCase()}_API_KEY not set (needed by ${specs.filter((s) => s.transport === k).map((s) => s.id).join(", ")})`);
			process.exit(1);
		}
	}
	http = new Semaphore(o.concurrency);

	if (o.check) {
		await preflight(o);
		return;
	}

	mkdirSync(dirname(o.out), { recursive: true });
	const cells = planCells(o);
	const blockA = cells.filter((c) => c.block === "A");
	const blockB = cells.filter((c) => c.block === "B");
	const condOf = (b: CellSpec[]) => (b.some((c) => c.condition === "baseline") ? "baseline" : "keepalive");

	writeFileSync(
		o.out,
		`${JSON.stringify({
			type: "run-meta",
			phase: "start",
			v: 2,
			runId: o.runId,
			wallClockStart: new Date().toISOString(),
			options: { ...o, models: o.models },
			cells: cells.length,
		})}\n`,
	);
	console.log(
		`run ${o.runId} | ${cells.length} cells | blockA=${condOf(blockA)}(${blockA.length}) blockB=${condOf(blockB)}(${blockB.length}) | ` +
			`sizes=[${o.sizes.join(",")}] idles=[${o.idles.join(",")}]s samples=${o.samples} keepalive=${o.keepAliveIntervalMs}ms ` +
			`concurrency=${o.concurrency} stagger=${o.staggerMs}ms subbatch=${o.subbatchSize} seed=${o.seed}`,
	);
	console.log(`writing ${o.out}`);

	const rand = mulberry32(o.seed);
	const totals = { reqA: 0, pings: 0, reqB: 0, pressure: 0 };
	const invalidReasons: Record<string, number> = {};
	let done = 0;
	let pressureStats = { calls: 0, promptTokens: 0, costUsd: 0 };

	const runBlock = async (name: string, blockCells: CellSpec[]): Promise<void> => {
		const ordered = shuffled(blockCells, rand);
		const batches: CellSpec[][] = [];
		for (let i = 0; i < ordered.length; i += o.subbatchSize) batches.push(ordered.slice(i, i + o.subbatchSize));
		console.log(`\n--- block ${name} (${condOf(blockCells)}): ${blockCells.length} cells in ${batches.length} sub-batches ---`);
		for (let bi = 0; bi < batches.length; bi++) {
			const batch = batches[bi]!;
			const t0 = now();
			await Promise.all(
				batch.map(async (cell, idx) => {
					await sleep(idx * o.staggerMs);
					const result = await runCell(o, cell);
					appendFileSync(o.out, `${JSON.stringify(result)}\n`);
					done++;
					totals.reqA += result.cost.reqA;
					totals.pings += result.cost.pings;
					totals.reqB += result.cost.reqB;
					if (!result.validity.overall) {
						for (const [k, v] of Object.entries(result.validity)) {
							if (k !== "overall" && v === false) invalidReasons[k] = (invalidReasons[k] ?? 0) + 1;
						}
					}
					const b = result.reqB;
					const hit = b && b.promptTokens > 0 ? ((b.cachedTokens / b.promptTokens) * 100).toFixed(0) : "n/a";
					const flags = result.validity.overall
						? ""
						: ` INVALID(${Object.entries(result.validity).filter(([k, v]) => k !== "overall" && !v).map(([k]) => k).join(",")})`;
					console.log(
						`[${done}/${cells.length}] ${name} ${result.model} sz=${cell.sizeTokens} idle=${cell.idleSeconds}s ` +
							`${cell.condition} s${cell.sample}: hit=${hit}% trueIdle=${result.trueIdleSeconds?.toFixed(1) ?? "n/a"}s ` +
							`qWait=${result.reqBQueueWaitMs?.toFixed(0) ?? "n/a"}ms pings=${result.pings.length}/${result.pingsPlanned} ` +
							`ttft=${b?.ttftMs?.toFixed(0) ?? "n/a"}ms cost=$${result.cost.total.toFixed(4)}${flags}` +
							(result.error ? ` ERROR: ${result.error.slice(0, 100)}` : ""),
					);
				}),
			);
			console.log(`--- block ${name} sub-batch ${bi + 1}/${batches.length} done in ${((now() - t0) / 1000).toFixed(0)}s ---`);
		}
	};

	const pressureStop = { done: false };
	const pressurePromise =
		o.pressureQps > 0
			? runPressure(o, specs[0]!, pressureStop).then((p) => {
					pressureStats = p;
					totals.pressure = p.costUsd;
				})
			: Promise.resolve();

	const blocks: Array<[string, CellSpec[]]> = (
		[
			["A", blockA],
			["B", blockB],
		] as Array<[string, CellSpec[]]>
	).filter(([, cs]) => !o.onlyBlock || condOf(cs) === o.onlyBlock);
	for (const [name, blockCells] of blocks) {
		await runBlock(name, blockCells);
	}
	pressureStop.done = true;
	await pressurePromise;

	// ---- run-level sanity gate: warm references must be warm ----
	// An immediate re-read of a just-written prefix has no idle; a miss means the
	// harness timing broke or the provider's cache write is not immediately
	// readable. Either way the run's other numbers cannot be trusted at face value.
	const fs = await import("node:fs");
	const lines = fs.readFileSync(o.out, "utf8").split("\n").filter((l) => l.trim());
	const warmByModel: Record<string, { warm: number; n: number; basis: string }> = {};
	for (const line of lines) {
		const c = JSON.parse(line) as CellResult;
		if (c.v !== 2 || !c.reqB || c.reqB.error || !c.reqB.promptTokens) continue;
		// Gemini's implicit cache commits ~1 min late, so its "immediate" re-read
		// is expected cold: use its idle=60 baseline cells as the warm reference.
		const isGoogle = c.model.startsWith("google:");
		const use = isGoogle
			? c.condition === "baseline" && c.idleSeconds === 60
			: c.condition === "warm" && c.idleSeconds === 0;
		if (!use) continue;
		const e = (warmByModel[c.model] ??= { warm: 0, n: 0, basis: isGoogle ? "idle=60" : "idle=0" });
		e.n++;
		if (c.reqB.cachedTokens / c.reqB.promptTokens >= 0.9) e.warm++;
	}
	let gateOk = true;
	console.log(`\nwarm-reference gate (must be ~100%):`);
	for (const [model, e] of Object.entries(warmByModel)) {
		const rate = e.n ? e.warm / e.n : 0;
		// Only Anthropic has explicit write-then-read semantics, so only it gets
		// the strict gate. Automatic caches (OpenAI, DeepSeek) commit
		// asynchronously and miss occasionally even when healthy; Gemini commits
		// ~1 min late and is judged on its idle=60 cells.
		const strict = model.startsWith("anthropic:");
		const ok = strict ? rate >= 0.99 : model.startsWith("google:") ? rate >= 0.5 : rate >= 0.8;
		if (!ok) gateOk = false;
		console.log(`  ${model}: ${e.warm}/${e.n} warm (${e.basis}) ${ok ? "OK" : "*** FAIL — RUN SUSPECT ***"}`);
	}

	const grand = totals.reqA + totals.pings + totals.reqB + totals.pressure;
	const summary = {
		type: "run-meta",
		phase: "end",
		runId: o.runId,
		wallClockEnd: new Date().toISOString(),
		cells: done,
		invalidReasons,
		warmRef: warmByModel,
		warmRefGateOk: gateOk,
		pressure: pressureStats,
		cost: { ...totals, total: grand },
	};
	appendFileSync(o.out, `${JSON.stringify(summary)}\n`);
	console.log(
		`\ndone: ${done} cells | invalid by reason: ${JSON.stringify(invalidReasons)} | warm-ref gate: ${gateOk ? "PASS" : "FAIL"}`,
	);
	console.log(
		`cost: reqA=$${totals.reqA.toFixed(2)} pings=$${totals.pings.toFixed(2)} reqB=$${totals.reqB.toFixed(2)} ` +
			`${o.pressureQps > 0 ? `pressure=$${totals.pressure.toFixed(2)} ` : ""}total=$${grand.toFixed(2)}`,
	);
}

void main();
