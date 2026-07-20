import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	EventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCacheKeepAlive } from "../src/harness/cache-keepalive.ts";
import { Agent, type AgentTool, type StreamFn } from "../src/index.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const FAKE_MODEL = {
	id: "fake",
	name: "fake",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} as unknown as Model<Api>;

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "fake",
		usage: EMPTY_USAGE,
		stopReason,
		timestamp: 0,
	};
}

function toolCallMessage(name: string, id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: {} }],
		api: "openai-responses",
		provider: "openai",
		model: "fake",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: 0,
	};
}

/** A stream that immediately resolves to a trivial assistant message. */
function doneStream(): AssistantMessageEventStream {
	const stream = new MockAssistantStream();
	queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistantMessage("", "stop") }));
	return stream;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("startCacheKeepAlive", () => {
	it("pings on a fixed cadence, passing the context and maxTokens:1", async () => {
		vi.useFakeTimers();
		const calls: { context: Context; options?: SimpleStreamOptions }[] = [];
		const streamFn: StreamFn = (_model, context, options) => {
			calls.push({ context, options });
			return doneStream();
		};
		const context: Context = { systemPrompt: "sys", messages: [], tools: [] };

		const handle = startCacheKeepAlive({ streamFn, intervalMs: 1000 }, FAKE_MODEL, context, undefined);
		try {
			// First ping fires after the default initial delay (= intervalMs), then every interval.
			await vi.advanceTimersByTimeAsync(3000);
			expect(calls).toHaveLength(3);
			expect(calls[0]!.context).toBe(context);
			expect(calls[0]!.options?.maxTokens).toBe(1);
		} finally {
			await handle.stop();
		}
	});

	it("honors a custom initialDelayMs before the first ping", async () => {
		vi.useFakeTimers();
		const calls: number[] = [];
		const streamFn: StreamFn = () => {
			calls.push(1);
			return doneStream();
		};
		const context: Context = { systemPrompt: "", messages: [], tools: [] };
		const handle = startCacheKeepAlive(
			{ streamFn, intervalMs: 1000, initialDelayMs: 5000 },
			FAKE_MODEL,
			context,
			undefined,
		);
		try {
			await vi.advanceTimersByTimeAsync(4999);
			expect(calls).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(1);
			expect(calls).toHaveLength(1);
		} finally {
			await handle.stop();
		}
	});

	it("does not overlap pings when a ping is slower than the interval", async () => {
		vi.useFakeTimers();
		let issued = 0;
		const release = createDeferred();
		const streamFn: StreamFn = () => {
			issued++;
			const stream = new MockAssistantStream();
			void release.promise.then(() =>
				stream.push({ type: "done", reason: "stop", message: assistantMessage("", "stop") }),
			);
			return stream;
		};
		const context: Context = { systemPrompt: "", messages: [], tools: [] };
		const handle = startCacheKeepAlive({ streamFn, intervalMs: 1000 }, FAKE_MODEL, context, undefined);
		try {
			// Ping 1 fires at t=1000 and stays in flight; ticks at 2000/3000 are skipped.
			await vi.advanceTimersByTimeAsync(3000);
			expect(issued).toBe(1);
			release.resolve();
			await vi.advanceTimersByTimeAsync(1000);
			expect(issued).toBe(2);
		} finally {
			release.resolve();
			await handle.stop();
		}
	});

	it("stops firing after stop()", async () => {
		vi.useFakeTimers();
		let issued = 0;
		const streamFn: StreamFn = () => {
			issued++;
			return doneStream();
		};
		const context: Context = { systemPrompt: "", messages: [], tools: [] };
		const handle = startCacheKeepAlive({ streamFn, intervalMs: 1000 }, FAKE_MODEL, context, undefined);
		await vi.advanceTimersByTimeAsync(2000);
		expect(issued).toBe(2);
		await handle.stop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(issued).toBe(2);
	});

	it("stops when the parent signal aborts", async () => {
		vi.useFakeTimers();
		let issued = 0;
		const streamFn: StreamFn = () => {
			issued++;
			return doneStream();
		};
		const controller = new AbortController();
		const context: Context = { systemPrompt: "", messages: [], tools: [] };
		const handle = startCacheKeepAlive({ streamFn, intervalMs: 1000 }, FAKE_MODEL, context, controller.signal);
		try {
			await vi.advanceTimersByTimeAsync(1000);
			expect(issued).toBe(1);
			controller.abort();
			await vi.advanceTimersByTimeAsync(5000);
			expect(issued).toBe(1);
		} finally {
			await handle.stop();
		}
	});
});

describe("Agent cache keepalive", () => {
	const toolSchema = Type.Object({});

	function blockingTool(started: { resolve: () => void }, release: Promise<void>): AgentTool<typeof toolSchema> {
		return {
			name: "slow_tool",
			label: "Slow Tool",
			description: "Blocks until released",
			parameters: toolSchema,
			async execute() {
				started.resolve();
				await release;
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
	}

	it("replays the turn prefix while a tool runs and stops when it completes", async () => {
		vi.useFakeTimers();
		const started = createDeferred();
		const release = createDeferred();
		const realContexts: Context[] = [];
		const pings: { context: Context; options?: SimpleStreamOptions }[] = [];
		let realTurns = 0;

		const streamFn: StreamFn = (_model, context, options) => {
			if (options?.maxTokens === 1) {
				pings.push({ context, options });
				return doneStream();
			}
			realContexts.push(context);
			realTurns++;
			const stream = new MockAssistantStream();
			const message = realTurns === 1 ? toolCallMessage("slow_tool", "call-1") : assistantMessage("final", "stop");
			const reason = realTurns === 1 ? "toolUse" : "stop";
			queueMicrotask(() => stream.push({ type: "done", reason, message }));
			return stream;
		};

		const agent = new Agent({
			initialState: { tools: [blockingTool(started, release.promise)] },
			streamFn,
			sessionId: "sess-1",
			cacheRetention: "long",
			cacheKeepAliveIntervalMs: 1000,
		});

		const promptPromise = agent.prompt("go");
		await started.promise;

		await vi.advanceTimersByTimeAsync(3000);
		expect(pings.length).toBe(3);
		// Pings replay the exact request prefix of the turn that made the tool call.
		expect(pings[0]!.context).toBe(realContexts[0]);
		expect(pings[0]!.options?.maxTokens).toBe(1);
		expect(pings[0]!.options?.sessionId).toBe("sess-1");
		expect(pings[0]!.options?.cacheRetention).toBe("long");

		// Tool finishes -> keepalive stops, no further pings.
		release.resolve();
		await promptPromise;
		const pingsAtCompletion = pings.length;
		await vi.advanceTimersByTimeAsync(5000);
		expect(pings.length).toBe(pingsAtCompletion);
		expect(realTurns).toBe(2);
	});

	it("fires no pings when cacheKeepAliveIntervalMs is unset", async () => {
		vi.useFakeTimers();
		const started = createDeferred();
		const release = createDeferred();
		let pings = 0;
		let realTurns = 0;

		const streamFn: StreamFn = (_model, _context, options) => {
			if (options?.maxTokens === 1) {
				pings++;
				return doneStream();
			}
			realTurns++;
			const stream = new MockAssistantStream();
			const message = realTurns === 1 ? toolCallMessage("slow_tool", "call-1") : assistantMessage("final", "stop");
			const reason = realTurns === 1 ? "toolUse" : "stop";
			queueMicrotask(() => stream.push({ type: "done", reason, message }));
			return stream;
		};

		const agent = new Agent({
			initialState: { tools: [blockingTool(started, release.promise)] },
			streamFn,
			sessionId: "sess-1",
		});

		const promptPromise = agent.prompt("go");
		await started.promise;
		await vi.advanceTimersByTimeAsync(10000);
		expect(pings).toBe(0);
		release.resolve();
		await promptPromise;
	});
});
