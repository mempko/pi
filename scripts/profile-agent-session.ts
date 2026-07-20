/**
 * End-to-end multi-turn agent session with a REAL long-running bash tool.
 *
 * Simulates a real session: prompt -> tool call -> reply, repeated for --turns
 * rounds (default 5) on ONE stateful agent, so the conversation (and its cached
 * prefix) grows each round. Every round the model calls a `bash` tool that runs
 * a real wait loop, and the loop's cache-keepalive pings fire during that wait.
 *
 * Per round we measure the RESUME request (the turn after the tool call): its
 * latency and its cache-read / input / cache-write split. Across configs:
 *   - baseline  : default retention ("short"), no keepalive.
 *   - long      : cacheRetention "long" (Anthropic 1h / OpenAI 24h TTL ceiling).
 *   - keepalive : default retention, prefix replayed during each tool call.
 *
 * A warm cache => resume `cacheRead` high, `input` low, resume latency low.
 * An evicted cache => resume `cacheRead` ~0 and `input` jumps to a full prefill.
 *
 * REAL, PAID requests. NOT for CI. Reads ANTHROPIC_API_KEY from the environment.
 *
 * Usage:
 *   node --import tsx scripts/profile-agent-session.ts \
 *     --turns 5 --wait 20 --keepalive-interval 5000 \
 *     --configs baseline,keepalive,long --prefix-tokens 6000 --model claude-sonnet-4-5
 *
 * To make each tool call cross Anthropic's ~5-min TTL: --wait 330 (and lower
 * --turns to keep total runtime sane, e.g. --turns 2 --wait 330).
 */

import { spawn } from "node:child_process";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import type { Api, CacheRetention, Model, Usage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";

type ConfigName = "baseline" | "long" | "keepalive";

interface Options {
	provider: string;
	model: string;
	turns: number;
	waitSeconds: number;
	configs: ConfigName[];
	keepAliveIntervalMs: number;
	prefixTokens: number;
	maxRetries: number;
}

interface RoundResult {
	round: number;
	toolRan: boolean;
	pings: number;
	resumeLatencyMs?: number;
	resumeUsage?: Usage;
	/** stopReason of the resume assistant turn; "error"/"aborted" marks a bad sample. */
	resumeStopReason?: string;
	/** Provider error text from any error/aborted assistant turn in this round. */
	errors: string[];
}

interface SessionResult {
	config: ConfigName;
	rounds: RoundResult[];
}

function parseArgs(argv: string[]): Options {
	const opts: Options = {
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		turns: 5,
		waitSeconds: 20,
		configs: ["baseline", "keepalive"],
		keepAliveIntervalMs: 5000,
		prefixTokens: 6000,
		maxRetries: 6,
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
			case "--turns":
				opts.turns = Number(next());
				break;
			case "--wait":
				opts.waitSeconds = Number(next());
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
			case "--max-retries":
				opts.maxRetries = Number(next());
				break;
			case "--help":
			case "-h":
				console.log("See header comment for usage.");
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return opts;
}

/** A real bash tool that runs a command and returns its combined output. Honors abort. */
const bashTool: AgentTool<ReturnType<typeof Type.Object>> = {
	name: "bash",
	label: "Bash",
	description: "Run a bash command and return its stdout and stderr.",
	parameters: Type.Object({ command: Type.String({ description: "The bash command to run" }) }),
	async execute(_toolCallId, params, signal) {
		const command = (params as { command: string }).command;
		return await new Promise((resolve) => {
			const child = spawn("bash", ["-c", command], { signal });
			let output = "";
			child.stdout?.on("data", (d) => {
				output += String(d);
			});
			child.stderr?.on("data", (d) => {
				output += String(d);
			});
			child.on("close", (code) => {
				resolve({ content: [{ type: "text", text: output || `(exit ${code})` }], details: {} });
			});
			child.on("error", (error) => {
				resolve({ content: [{ type: "text", text: `error: ${String(error)}` }], details: {} });
			});
		});
	},
};

/** Large, stable system prompt so the cached prefix is big enough to matter. */
function buildSystemPrompt(approxTokens: number): string {
	const sentence = "You are a careful benchmark agent operating on cached context. ";
	const targetChars = Math.max(1, approxTokens) * 4;
	let blob = "";
	while (blob.length < targetChars) blob += sentence;
	return `You run tools exactly as instructed.\n\nReference context (ignore, do not summarize):\n${blob}`;
}

function retentionFor(config: ConfigName): CacheRetention {
	return config === "long" ? "long" : "short";
}

function roundPrompt(round: number, opts: Options): string {
	const waitCommand = `for i in $(seq 1 ${opts.waitSeconds}); do sleep 1; done; echo round-${round}-complete`;
	return (
		`Round ${round} of ${opts.turns}. Call the bash tool exactly once with this exact command, unchanged:\n\n` +
		`${waitCommand}\n\n` +
		`When it returns, reply with only: ROUND ${round} DONE`
	);
}

async function runSession(model: Model<Api>, opts: Options, config: ConfigName): Promise<SessionResult> {
	let pings = 0;
	// Count keepalive pings: the loop issues them with maxTokens === 1.
	const streamFn: StreamFn = (m, context, streamOptions) => {
		if (streamOptions?.maxTokens === 1) pings++;
		// Ride out transient Anthropic 529 "overloaded_error"s within the request,
		// like real pi does, instead of failing the round on the first blip.
		return streamSimple(m, context, {
			...streamOptions,
			maxRetries: streamOptions?.maxRetries ?? opts.maxRetries,
			maxRetryDelayMs: streamOptions?.maxRetryDelayMs ?? 30_000,
		});
	};

	const agent = new Agent({
		initialState: {
			systemPrompt: buildSystemPrompt(opts.prefixTokens),
			model,
			thinkingLevel: "off",
			tools: [bashTool],
		},
		streamFn,
		sessionId: `agent-session-${config}`,
		cacheRetention: retentionFor(config),
		cacheKeepAliveIntervalMs: config === "keepalive" ? opts.keepAliveIntervalMs : undefined,
	});

	// Per-round accumulator, reset before each prompt. The single subscription
	// writes into whichever round is currently active.
	let current: {
		toolEndAt: number;
		expectingResume: boolean;
		sawResume: boolean;
		result: RoundResult;
	} | null = null;

	agent.subscribe((event) => {
		if (!current) return;
		// Capture the provider error text from any failed assistant turn (the
		// tool-call turn or the resume turn), so we know WHY a round failed.
		if (
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			(event.message.stopReason === "error" || event.message.stopReason === "aborted") &&
			event.message.errorMessage
		) {
			current.result.errors.push(`[${event.message.stopReason}] ${event.message.errorMessage}`);
		}
		if (event.type === "tool_execution_end") {
			current.result.toolRan = true;
			current.toolEndAt = performance.now();
			current.expectingResume = true;
		} else if (
			event.type === "message_start" &&
			event.message.role === "assistant" &&
			current.expectingResume &&
			!current.sawResume &&
			current.result.resumeLatencyMs === undefined
		) {
			current.result.resumeLatencyMs = performance.now() - current.toolEndAt;
		} else if (
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			current.expectingResume &&
			!current.sawResume
		) {
			current.result.resumeUsage = event.message.usage;
			current.result.resumeStopReason = event.message.stopReason;
			current.sawResume = true;
			current.expectingResume = false;
		}
	});

	const rounds: RoundResult[] = [];
	for (let round = 1; round <= opts.turns; round++) {
		const pingsBefore = pings;
		current = {
			toolEndAt: 0,
			expectingResume: false,
			sawResume: false,
			result: { round, toolRan: false, pings: 0, errors: [] },
		};
		await agent.prompt(roundPrompt(round, opts));
		await agent.waitForIdle();
		current.result.pings = pings - pingsBefore;
		rounds.push(current.result);
		const bad = current.result.resumeStopReason === "error" || current.result.resumeStopReason === "aborted";
		console.log(
			`   round ${round}/${opts.turns}: tool=${current.result.toolRan} pings=${current.result.pings} ` +
				`resumeLat=${current.result.resumeLatencyMs?.toFixed(0) ?? "n/a"}ms ` +
				`cacheRead=${current.result.resumeUsage?.cacheRead ?? "n/a"} ` +
				`input=${current.result.resumeUsage?.input ?? "n/a"}` +
				(bad ? `  [BAD SAMPLE: resume stopReason=${current.result.resumeStopReason}]` : ""),
		);
		for (const error of current.result.errors) {
			console.log(`     error: ${error.replace(/\s+/g, " ").slice(0, 300)}`);
		}
		current = null;
	}

	return { config, rounds };
}

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function printReport(sessions: SessionResult[]): void {
	const statusOf = (r: RoundResult): string => {
		if (r.resumeStopReason === "error" || r.resumeStopReason === "aborted") return r.resumeStopReason;
		if (!r.toolRan) return "no-tool";
		if (r.resumeUsage === undefined) return "no-resume";
		return "ok";
	};
	const isBad = (r: RoundResult) => statusOf(r) !== "ok";
	const widths = [12, 6, 8, 6, 14, 10, 8, 11, 8];
	const headers = ["config", "round", "toolRan", "pings", "resumeLat(ms)", "cacheRead", "input", "cacheWrite", "status"];
	console.log("\n=== per-round resume request (turn after each bash wait) ===");
	console.log(headers.map((h, i) => pad(h, widths[i]!)).join(""));
	for (const session of sessions) {
		for (const r of session.rounds) {
			console.log(
				[
					r.round === 1 ? session.config : "",
					String(r.round),
					String(r.toolRan),
					String(r.pings),
					r.resumeLatencyMs?.toFixed(0) ?? "n/a",
					String(r.resumeUsage?.cacheRead ?? "n/a"),
					String(r.resumeUsage?.input ?? "n/a"),
					String(r.resumeUsage?.cacheWrite ?? "n/a"),
					statusOf(r),
				]
					.map((v, i) => pad(v, widths[i]!))
					.join(""),
			);
		}
	}
	console.log("\n=== session totals (bad samples excluded) ===");
	for (const session of sessions) {
		const good = session.rounds.filter((r) => !isBad(r));
		const badCount = session.rounds.length - good.length;
		const pings = session.rounds.reduce((sum, r) => sum + r.pings, 0);
		const cacheRead = good.reduce((sum, r) => sum + (r.resumeUsage?.cacheRead ?? 0), 0);
		const input = good.reduce((sum, r) => sum + (r.resumeUsage?.input ?? 0), 0);
		const cacheWrite = good.reduce((sum, r) => sum + (r.resumeUsage?.cacheWrite ?? 0), 0);
		const cost = good.reduce((sum, r) => sum + (r.resumeUsage?.cost.total ?? 0), 0);
		const latencies = good.flatMap((r) => (r.resumeLatencyMs === undefined ? [] : [r.resumeLatencyMs]));
		const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
		console.log(
			`  ${pad(session.config, 12)} pings=${pings} goodRounds=${good.length}` +
				(badCount > 0 ? ` badRounds=${badCount}` : "") +
				` avgResumeLat=${avgLatency.toFixed(0)}ms resumeCacheRead=${cacheRead} resumeInput=${input} ` +
				`resumeCacheWrite=${cacheWrite} resumeCost=$${cost.toFixed(5)}`,
		);
	}
	const allErrors = sessions.flatMap((s) => s.rounds).flatMap((r) => r.errors);
	if (allErrors.length > 0) {
		console.log("\n=== errors ===");
		const counts = new Map<string, number>();
		for (const error of allErrors) {
			const key = error.replace(/\s+/g, " ").slice(0, 200);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		for (const [error, count] of counts) {
			console.log(`  x${count}: ${error}`);
		}
	}
	console.log(
		"\nWarm cache => high resume cacheRead and low input each round. If baseline's cacheRead\n" +
			"collapses (input jumps) on rounds whose tool wait exceeds the TTL while keepalive holds\n" +
			"it, the keepalive kept the KV cache warm across the long tool calls.",
	);
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	const model = getModel(opts.provider as never, opts.model as never) as Model<Api> | undefined;
	if (!model) {
		console.error(`Unknown model: ${opts.provider}/${opts.model}`);
		process.exit(1);
	}

	console.log(
		`Agent session keepalive test | ${opts.provider}/${opts.model} | turns=${opts.turns} | wait=${opts.waitSeconds}s | ` +
			`prefix~${opts.prefixTokens}tok | configs=[${opts.configs.join(",")}] | keepalive=${opts.keepAliveIntervalMs}ms`,
	);

	const sessions: SessionResult[] = [];
	for (const config of opts.configs) {
		console.log(`\n-- ${config}: ${opts.turns} rounds, ${opts.waitSeconds}s bash wait each ...`);
		try {
			sessions.push(await runSession(model, opts, config));
		} catch (error) {
			console.error(`   failed: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		}
	}

	printReport(sessions);
}

void main();
