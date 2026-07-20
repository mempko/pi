/**
 * End-to-end prompt-cache profiler.
 *
 * Measures whether keeping the provider prompt cache warm during a long tool
 * call actually improves the latency (and cache-read hit) of the *next* request.
 * It reproduces the scenario the keepalive targets:
 *
 *   1. reqA  - send a sizable prompt prefix (writes the provider cache).
 *   2. idle  - wait `--idle` seconds, simulating a long-running tool call.
 *              With the `keepalive` config, replay the prefix on a timer via the
 *              real `startCacheKeepAlive` (exactly what the agent loop does).
 *   3. reqB  - resend the identical prefix and measure time-to-first-token plus
 *              the cache-read / input token split reported by the provider.
 *
 * A warm cache shows high `cacheRead` and low TTFT on reqB; an evicted cache
 * shows `cacheRead` collapse to ~0 and TTFT rise to a full prefill.
 *
 * This makes REAL, PAID provider requests and is NOT part of CI. It reads API
 * keys from the environment the same way `pi` does (e.g. ANTHROPIC_API_KEY).
 *
 * Compared configs (default: all three):
 *   - baseline   : default cache retention ("short"), no keepalive.
 *   - long       : cacheRetention "long" (Anthropic 1h / OpenAI 24h TTL ceiling).
 *   - keepalive  : default retention, prefix replayed every --keepalive-interval ms.
 *
 * TTL is only a ceiling: on a capacity-bound cache the entry can be evicted by
 * LRU pressure well before it expires, which `long` cannot prevent but a
 * keepalive read can. To see the TTL effect specifically, run with an idle that
 * crosses the provider TTL (e.g. --idle 330 for Anthropic's 5-minute default).
 *
 * Usage:
 *   node --import tsx scripts/profile-session.ts \
 *     --provider anthropic --model claude-sonnet-4-5 \
 *     --idle 5,330 --configs baseline,long,keepalive \
 *     --keepalive-interval 60000 --prefix-tokens 4000 --runs 1
 */

import type { Api, AssistantMessage, CacheRetention, Context, Model, Usage } from "../packages/ai/src/types.ts";
import { getModel, streamSimple } from "../packages/ai/src/compat.ts";
import type { StreamFn } from "../packages/agent/src/types.ts";
import { startCacheKeepAlive } from "../packages/agent/src/harness/cache-keepalive.ts";

type ConfigName = "baseline" | "long" | "keepalive";

interface Options {
	provider: string;
	model: string;
	idleSeconds: number[];
	configs: ConfigName[];
	keepAliveIntervalMs: number;
	prefixTokens: number;
	runs: number;
	maxTokens: number;
}

interface Measurement {
	ttftMs: number;
	totalMs: number;
	usage: Usage;
}

interface CellResult {
	config: ConfigName;
	idleSeconds: number;
	reqB: Measurement[];
	pings: number;
}

function parseArgs(argv: string[]): Options {
	const opts: Options = {
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		idleSeconds: [5],
		configs: ["baseline", "long", "keepalive"],
		keepAliveIntervalMs: 60_000,
		prefixTokens: 4000,
		runs: 1,
		maxTokens: 32,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`Missing value for ${arg}`);
			return value;
		};
		switch (arg) {
			case "--provider":
				opts.provider = next();
				break;
			case "--model":
				opts.model = next();
				break;
			case "--idle":
				opts.idleSeconds = next()
					.split(",")
					.map((s) => Number(s.trim()))
					.filter((n) => Number.isFinite(n) && n >= 0);
				break;
			case "--configs":
				opts.configs = next()
					.split(",")
					.map((s) => s.trim() as ConfigName)
					.filter((c) => c === "baseline" || c === "long" || c === "keepalive");
				break;
			case "--keepalive-interval":
				opts.keepAliveIntervalMs = Number(next());
				break;
			case "--prefix-tokens":
				opts.prefixTokens = Number(next());
				break;
			case "--runs":
				opts.runs = Number(next());
				break;
			case "--max-tokens":
				opts.maxTokens = Number(next());
				break;
			case "--help":
			case "-h":
				printUsageAndExit();
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return opts;
}

function printUsageAndExit(): never {
	console.log(
		[
			"Usage: node --import tsx scripts/profile-session.ts [options]",
			"",
			"  --provider <name>            Provider id (default: anthropic)",
			"  --model <id>                 Model id (default: claude-sonnet-4-5)",
			"  --idle <secs,secs,...>       Idle durations to test (default: 5)",
			"  --configs <a,b,...>          baseline,long,keepalive (default: all)",
			"  --keepalive-interval <ms>    Ping interval for keepalive (default: 60000)",
			"  --prefix-tokens <n>          Approx cached prefix size (default: 4000)",
			"  --runs <n>                   Repetitions per cell (default: 1)",
			"  --max-tokens <n>             Output cap per request (default: 32)",
		].join("\n"),
	);
	process.exit(0);
}

/** Build a context with a large, stable user prefix so prompt caching is meaningful. */
function buildContext(approxTokens: number): Context {
	// ~4 characters per token; a repeated, deterministic sentence keeps the
	// prefix byte-identical across requests so the provider cache can match it.
	const sentence = "The quick brown fox jumps over the lazy dog while the cache stays warm. ";
	const targetChars = Math.max(1, approxTokens) * 4;
	let blob = "";
	while (blob.length < targetChars) blob += sentence;
	return {
		systemPrompt: "You are a latency benchmark target. Answer in one short word.",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: `Reference material (ignore):\n${blob}\n\nReply with the single word: ok` }],
				timestamp: 0,
			},
		],
	};
}

function retentionFor(config: ConfigName): CacheRetention {
	return config === "long" ? "long" : "short";
}

async function measure(
	model: Model<Api>,
	context: Context,
	cacheRetention: CacheRetention,
	sessionId: string,
	maxTokens: number,
): Promise<Measurement> {
	const start = performance.now();
	const stream = streamSimple(model, context, { cacheRetention, sessionId, maxTokens });
	let ttftMs: number | undefined;
	let finalMessage: AssistantMessage | undefined;
	for await (const event of stream) {
		if (
			ttftMs === undefined &&
			(event.type === "text_delta" ||
				event.type === "thinking_delta" ||
				event.type === "text_start" ||
				event.type === "thinking_start" ||
				event.type === "toolcall_start")
		) {
			ttftMs = performance.now() - start;
		}
		if (event.type === "done") finalMessage = event.message;
		else if (event.type === "error") finalMessage = event.error;
	}
	const totalMs = performance.now() - start;
	if (!finalMessage) throw new Error("Stream produced no final message");
	if (finalMessage.stopReason === "error") {
		throw new Error(`Provider error: ${finalMessage.errorMessage ?? "unknown"}`);
	}
	return { ttftMs: ttftMs ?? totalMs, totalMs, usage: finalMessage.usage };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCell(
	model: Model<Api>,
	opts: Options,
	config: ConfigName,
	idleSeconds: number,
	runIndex: number,
): Promise<CellResult> {
	const context = buildContext(opts.prefixTokens);
	const cacheRetention = retentionFor(config);
	// A distinct session id per (config, idle, run) isolates cache namespaces so
	// providers that key the cache on session id (e.g. OpenAI prompt_cache_key)
	// do not cross-contaminate cells.
	const sessionId = `profile-${config}-${idleSeconds}-${runIndex}`;
	const reqB: Measurement[] = [];
	let pings = 0;

	// reqA: warm the cache.
	await measure(model, context, cacheRetention, sessionId, opts.maxTokens);

	// idle: simulate a long tool call, optionally keeping the cache warm.
	const idleMs = idleSeconds * 1000;
	if (config === "keepalive" && idleMs > 0) {
		const keepAliveStreamFn: StreamFn = (m, ctx, streamOptions) =>
			streamSimple(m, ctx, { ...streamOptions, cacheRetention, sessionId });
		const handle = startCacheKeepAlive(
			{
				streamFn: keepAliveStreamFn,
				intervalMs: opts.keepAliveIntervalMs,
				onPing: () => {
					pings++;
				},
			},
			model,
			context,
			undefined,
		);
		try {
			await sleep(idleMs);
		} finally {
			await handle.stop();
		}
	} else {
		await sleep(idleMs);
	}

	// reqB: the request whose latency the keepalive is meant to protect.
	reqB.push(await measure(model, context, cacheRetention, sessionId, opts.maxTokens));

	return { config, idleSeconds, reqB, pings };
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function printReport(results: CellResult[]): void {
	const headers = ["config", "idle(s)", "ttft(ms)", "total(ms)", "cacheRead", "input", "cacheWrite", "cost($)", "pings"];
	const widths = [12, 8, 10, 10, 10, 8, 11, 10, 6];
	console.log("\n=== reqB (post-idle request) ===");
	console.log(headers.map((h, i) => pad(h, widths[i]!)).join(""));
	console.log(widths.map((w) => "-".repeat(w - 1) + " ").join(""));
	for (const cell of results) {
		const ttft = median(cell.reqB.map((m) => m.ttftMs));
		const total = median(cell.reqB.map((m) => m.totalMs));
		const cacheRead = median(cell.reqB.map((m) => m.usage.cacheRead));
		const input = median(cell.reqB.map((m) => m.usage.input));
		const cacheWrite = median(cell.reqB.map((m) => m.usage.cacheWrite));
		const cost = median(cell.reqB.map((m) => m.usage.cost.total));
		const row = [
			cell.config,
			String(cell.idleSeconds),
			ttft.toFixed(0),
			total.toFixed(0),
			cacheRead.toFixed(0),
			input.toFixed(0),
			cacheWrite.toFixed(0),
			cost.toFixed(5),
			String(cell.pings),
		];
		console.log(row.map((v, i) => pad(v, widths[i]!)).join(""));
	}
	console.log(
		"\nInterpretation: within an idle row, a warm cache keeps cacheRead high and ttft low.\n" +
			"If baseline's cacheRead collapses at a large idle while keepalive/long hold it, the cache was being evicted.",
	);
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	const model = getModel(opts.provider as never, opts.model as never) as Model<Api> | undefined;
	if (!model) {
		console.error(`Unknown model: ${opts.provider}/${opts.model}. Pass a valid --provider/--model.`);
		process.exit(1);
	}

	console.log(
		`Profiling ${opts.provider}/${opts.model} | prefix~${opts.prefixTokens}tok | ` +
			`idle=[${opts.idleSeconds.join(",")}]s | configs=[${opts.configs.join(",")}] | ` +
			`keepalive=${opts.keepAliveIntervalMs}ms | runs=${opts.runs}`,
	);

	const results: CellResult[] = [];
	for (const idleSeconds of opts.idleSeconds) {
		for (const config of opts.configs) {
			const cells: CellResult[] = [];
			for (let run = 0; run < opts.runs; run++) {
				process.stdout.write(`  running ${config} idle=${idleSeconds}s run=${run + 1}/${opts.runs} ...\n`);
				try {
					cells.push(await runCell(model, opts, config, idleSeconds, run));
				} catch (error) {
					console.error(`  failed: ${error instanceof Error ? error.message : String(error)}`);
					process.exit(1);
				}
			}
			// Merge repeated runs of the same cell into one row.
			results.push({
				config,
				idleSeconds,
				reqB: cells.flatMap((c) => c.reqB),
				pings: cells.length > 0 ? cells[cells.length - 1]!.pings : 0,
			});
		}
	}

	printReport(results);
}

void main();
