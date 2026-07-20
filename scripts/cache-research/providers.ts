/**
 * Provider transports for the cache-research harness (v2).
 *
 * Three transports:
 *   - "anthropic":  first-party Messages API (api.anthropic.com), explicit
 *                   cache_control breakpoint, usage.cache_{creation,read}_input_tokens.
 *   - "openai":     first-party Chat Completions API (api.openai.com), automatic
 *                   prefix caching; we pass prompt_cache_key = cell salt (OpenAI's
 *                   documented routing-affinity lever) and an identical prefix.
 *   - "openrouter": OpenRouter chat completions (used ONLY for DeepSeek), with an
 *                   optional backend pin (`model@Backend`). provider.only pins an
 *                   endpoint, NOT a machine — so we record the served backend on
 *                   every call and callers must treat backend changes as invalid.
 *
 * Cost: Anthropic/OpenAI first-party responses carry no cost field, so cost is
 * computed from usage and a public price table (per 1M tokens, USD). OpenRouter
 * returns usage.cost, which we prefer; the table is the fallback. Output tokens
 * are recorded but not priced (max_tokens is tiny by design).
 */

export type Transport = "anthropic" | "openai" | "google" | "openrouter";

export interface ModelSpec {
	transport: Transport;
	/** API model id, e.g. claude-sonnet-4-5, gpt-5.1, deepseek/deepseek-v3.2 */
	id: string;
	/** OpenRouter backend pin (provider.only). Endpoint-level, not machine-level. */
	pin?: string;
	/** Stable label for records, e.g. "anthropic/claude-sonnet-4-5". */
	label: string;
}

export interface Keys {
	anthropic?: string;
	openai?: string;
	google?: string;
	openrouter?: string;
}

/** USD per 1M tokens. Verify before publication; last checked 2026-07. */
const PRICES: Record<string, { input: number; cacheRead: number; cacheWrite: number }> = {
	"claude-sonnet-4-5": { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75 },
	"gpt-5.1": { input: 1.25, cacheRead: 0.125, cacheWrite: 1.25 },
	// Gemini 2.5 Pro (<=200k context): implicit cache read is $0.31 vs $1.25 input,
	// so r ~= 0.25 here, much weaker than the 0.1 of the others.
	"gemini-2.5-pro": { input: 1.25, cacheRead: 0.31, cacheWrite: 1.25 },
	"deepseek/deepseek-v3.2": { input: 0.28, cacheRead: 0.028, cacheWrite: 0.28 },
};

export interface UsageNorm {
	/** Total input tokens the provider billed/processed (uncached + read + written). */
	promptTokens: number;
	/** Tokens read from cache (the hit metric). */
	cachedTokens: number;
	/** Tokens written to cache. */
	cacheWriteTokens: number;
	outputTokens: number;
	costUsd: number;
	costSource: "provider" | "price-table" | "none";
	/** Raw usage object, kept for audit. */
	raw: unknown;
}

export interface TransportResult {
	usage: UsageNorm;
	ttftMs?: number;
	/** Serving backend label (OpenRouter reports it; first-party is constant). */
	provider?: string;
	error?: string;
}

/**
 * Parse a model spec. Forms:
 *   anthropic:claude-sonnet-4-5
 *   openai:gpt-5.1
 *   openrouter:deepseek/deepseek-v3.2@DeepInfra
 *   deepseek/deepseek-v3.2@DeepInfra        (legacy: bare = openrouter)
 */
export function parseModelSpec(spec: string): ModelSpec {
	let transport: Transport = "openrouter";
	let rest = spec;
	const m = /^(anthropic|openai|google|openrouter):(.*)$/.exec(spec);
	if (m) {
		transport = m[1] as Transport;
		rest = m[2]!;
	}
	const at = rest.indexOf("@");
	const id = at < 0 ? rest : rest.slice(0, at);
	const pin = at < 0 ? undefined : rest.slice(at + 1);
	if (transport !== "openrouter" && pin) {
		throw new Error(`backend pin (@) only valid for openrouter specs: ${spec}`);
	}
	return { transport, id, pin, label: `${transport === "openrouter" ? "" : `${transport}:`}${id}` };
}

/** Price per token for a model id, or undefined if unknown. */
function priceFor(id: string): { input: number; cacheRead: number; cacheWrite: number } | undefined {
	if (PRICES[id]) return PRICES[id];
	const key = Object.keys(PRICES).find((k) => id.startsWith(k));
	return key ? PRICES[key] : undefined;
}

function emptyUsage(raw: unknown): UsageNorm {
	return { promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0, costSource: "none", raw };
}

/**
 * The probe prefix: a unique salted header plus stable filler. ~4 chars/token.
 * Anthropic needs >= 1024 tokens at the cache breakpoint; OpenAI caches prefixes
 * >= 1024 tokens automatically; both are far below our sizes.
 */
export function buildMessages(spec: ModelSpec, sizeTokens: number, salt: string): unknown[] {
	const sentence = "The quick brown fox jumps over the lazy dog while the cache stays warm. ";
	const targetChars = Math.max(1, sizeTokens) * 4;
	const header = `Cell ${salt}. Reference material below, ignore it.\n`;
	let blob = header;
	while (blob.length < targetChars) blob += sentence;
	const ask = "Reply with exactly: ok";
	if (spec.transport === "openai") {
		// Automatic caching: no cache_control. Identical prefix bytes + prompt_cache_key
		// (set in the request body) are the documented affinity mechanisms.
		return [{ role: "user", content: `${blob}${ask}` }];
	}
	if (spec.transport === "google") {
		// Gemini implicit caching: automatic above ~2048 tokens for 2.5 Pro.
		return [{ role: "user", parts: [{ text: `${blob}${ask}` }] }];
	}
	// Anthropic (direct or via OpenRouter): explicit ephemeral breakpoint on the blob.
	return [
		{
			role: "user",
			content: [
				{ type: "text", text: blob, cache_control: { type: "ephemeral" } },
				{ type: "text", text: ask },
			],
		},
	];
}

/** Parse SSE `data:` lines from a streamed response body, invoking cb per JSON chunk. */
async function readSSE(
	body: ReadableStream<Uint8Array>,
	cb: (chunk: Record<string, unknown>) => void,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (data === "[DONE]") continue;
			let chunk: Record<string, unknown>;
			try {
				chunk = JSON.parse(data);
			} catch {
				continue;
			}
			cb(chunk);
		}
	}
}

async function callAnthropic(
	spec: ModelSpec,
	messages: unknown[],
	maxTokens: number,
	key: string,
	onFirstToken: () => void,
): Promise<TransportResult> {
	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": key,
			"anthropic-version": "2023-06-01",
			"Content-Type": "application/json",
			"X-Title": "pi-cache-research",
		},
		body: JSON.stringify({ model: spec.id, messages, max_tokens: maxTokens, temperature: 0, stream: true }),
	});
	if (!res.ok || !res.body) {
		const text = await res.text();
		return { usage: emptyUsage(undefined), error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
	}
	let usageRaw: Record<string, unknown> | undefined;
	let first = false;
	await readSSE(res.body, (chunk) => {
		const type = chunk.type as string | undefined;
		if (type === "message_start") {
			usageRaw = (chunk.message as Record<string, unknown>)?.usage as Record<string, unknown>;
		} else if (type === "message_delta" && chunk.usage) {
			usageRaw = { ...usageRaw, ...(chunk.usage as Record<string, unknown>) };
		} else if (type === "content_block_delta" && !first) {
			const delta = chunk.delta as { type?: string; text?: string } | undefined;
			if (delta?.type === "text_delta" && delta.text) {
				first = true;
				onFirstToken();
			}
		}
	});
	const input = Number(usageRaw?.input_tokens ?? 0);
	const read = Number(usageRaw?.cache_read_input_tokens ?? 0);
	const write = Number(usageRaw?.cache_creation_input_tokens ?? 0);
	const output = Number(usageRaw?.output_tokens ?? 0);
	const price = priceFor(spec.id);
	const usage: UsageNorm = {
		promptTokens: input + read + write,
		cachedTokens: read,
		cacheWriteTokens: write,
		outputTokens: output,
		costUsd: price ? (input * price.input + read * price.cacheRead + write * price.cacheWrite) / 1e6 : 0,
		costSource: price ? "price-table" : "none",
		raw: usageRaw,
	};
	return { usage, provider: "anthropic" };
}

async function callOpenAI(
	spec: ModelSpec,
	messages: unknown[],
	maxTokens: number,
	key: string,
	salt: string,
	onFirstToken: () => void,
): Promise<TransportResult> {
	const res = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: spec.id,
			messages,
			// gpt-5.1 is a reasoning model: max_completion_tokens, no temperature.
			max_completion_tokens: Math.max(16, maxTokens),
			stream: true,
			stream_options: { include_usage: true },
			// Documented routing-affinity lever: requests sharing a prompt_cache_key
			// are preferentially routed to a machine that recently served that key.
			prompt_cache_key: salt,
		}),
	});
	if (!res.ok || !res.body) {
		const text = await res.text();
		return { usage: emptyUsage(undefined), error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
	}
	let usageRaw: Record<string, unknown> | undefined;
	let first = false;
	await readSSE(res.body, (chunk) => {
		if (chunk.usage) usageRaw = chunk.usage as Record<string, unknown>;
		const choices = chunk.choices as Array<{ delta?: { content?: string; reasoning_content?: string } }> | undefined;
		const delta = choices?.[0]?.delta;
		if (!first && (delta?.content || delta?.reasoning_content)) {
			first = true;
			onFirstToken();
		}
	});
	const details = (usageRaw?.prompt_tokens_details ?? {}) as Record<string, unknown>;
	const prompt = Number(usageRaw?.prompt_tokens ?? 0);
	const cached = Number(details.cached_tokens ?? 0);
	const output = Number(usageRaw?.completion_tokens ?? 0);
	const price = priceFor(spec.id);
	const usage: UsageNorm = {
		promptTokens: prompt,
		cachedTokens: cached,
		cacheWriteTokens: 0,
		outputTokens: output,
		costUsd: price ? ((prompt - cached) * price.input + cached * price.cacheRead) / 1e6 : 0,
		costSource: price ? "price-table" : "none",
		raw: usageRaw,
	};
	return { usage, provider: "openai" };
}

async function callGoogle(
	spec: ModelSpec,
	messages: unknown[],
	maxTokens: number,
	key: string,
	onFirstToken: () => void,
): Promise<TransportResult> {
	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${spec.id}:streamGenerateContent?alt=sse`,
		{
			method: "POST",
			headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: messages,
				generationConfig: { temperature: 0, maxOutputTokens: Math.max(8, maxTokens) },
			}),
		},
	);
	if (!res.ok || !res.body) {
		const text = await res.text();
		return { usage: emptyUsage(undefined), error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
	}
	let usageRaw: Record<string, unknown> | undefined;
	let first = false;
	await readSSE(res.body, (chunk) => {
		if (chunk.usageMetadata) usageRaw = chunk.usageMetadata as Record<string, unknown>;
		if (!first) {
			const candidates = chunk.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
			if (candidates?.[0]?.content?.parts?.some((p) => p.text)) {
				first = true;
				onFirstToken();
			}
		}
	});
	const prompt = Number(usageRaw?.promptTokenCount ?? 0);
	const cached = Number(usageRaw?.cachedContentTokenCount ?? 0);
	const output = Number(usageRaw?.candidatesTokenCount ?? 0) + Number(usageRaw?.thoughtsTokenCount ?? 0);
	const price = priceFor(spec.id);
	const usage: UsageNorm = {
		promptTokens: prompt,
		cachedTokens: cached,
		cacheWriteTokens: 0,
		outputTokens: output,
		costUsd: price ? ((prompt - cached) * price.input + cached * price.cacheRead) / 1e6 : 0,
		costSource: price ? "price-table" : "none",
		raw: usageRaw,
	};
	return { usage, provider: "google" };
}

async function callOpenRouter(
	spec: ModelSpec,
	messages: unknown[],
	maxTokens: number,
	key: string,
	onFirstToken: () => void,
): Promise<TransportResult> {
	const body: Record<string, unknown> = {
		model: spec.id,
		messages,
		max_tokens: maxTokens,
		temperature: 0,
		stream: true,
		usage: { include: true },
	};
	// Endpoint-level pin only: OpenRouter does not expose machine/shard selection.
	// We therefore record the served backend per call and let the caller invalidate
	// cells whose backend changed mid-cell.
	if (spec.pin) body.provider = { only: [spec.pin], allow_fallbacks: false };
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "pi-cache-research" },
		body: JSON.stringify(body),
	});
	if (!res.ok || !res.body) {
		const text = await res.text();
		return { usage: emptyUsage(undefined), error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
	}
	let usageRaw: Record<string, unknown> | undefined;
	let provider: string | undefined;
	let first = false;
	await readSSE(res.body, (chunk) => {
		if (typeof chunk.provider === "string" && !provider) provider = chunk.provider;
		if (chunk.usage) usageRaw = chunk.usage as Record<string, unknown>;
		const choices = chunk.choices as Array<{ delta?: { content?: string; reasoning?: string } }> | undefined;
		const delta = choices?.[0]?.delta;
		if (!first && (delta?.content || delta?.reasoning)) {
			first = true;
			onFirstToken();
		}
	});
	const details = (usageRaw?.prompt_tokens_details ?? {}) as Record<string, unknown>;
	const prompt = Number(usageRaw?.prompt_tokens ?? 0);
	const cached = Number(details.cached_tokens ?? 0);
	const write = Number(details.cache_write_tokens ?? 0);
	const output = Number(usageRaw?.completion_tokens ?? 0);
	const providerCost = Number(usageRaw?.cost ?? 0);
	const price = priceFor(spec.id);
	const usage: UsageNorm = {
		promptTokens: prompt,
		cachedTokens: cached,
		cacheWriteTokens: write,
		outputTokens: output,
		costUsd:
			providerCost > 0
				? providerCost
				: price
					? ((prompt - cached - write) * price.input + cached * price.cacheRead + write * price.cacheWrite) / 1e6
					: 0,
		costSource: providerCost > 0 ? "provider" : price ? "price-table" : "none",
		raw: usageRaw,
	};
	return { usage, provider };
}

/**
 * One timed call. TTFT is stamped by the transport when the first content or
 * reasoning delta arrives; the caller stamps queue/start/end around it.
 */
export async function transportCall(
	spec: ModelSpec,
	messages: unknown[],
	maxTokens: number,
	keys: Keys,
	salt: string,
	onFirstToken: () => void,
): Promise<TransportResult> {
	try {
		if (spec.transport === "anthropic") {
			if (!keys.anthropic) return { usage: emptyUsage(undefined), error: "ANTHROPIC_API_KEY not set" };
			return await callAnthropic(spec, messages, maxTokens, keys.anthropic, onFirstToken);
		}
		if (spec.transport === "openai") {
			if (!keys.openai) return { usage: emptyUsage(undefined), error: "OPENAI_API_KEY not set" };
			return await callOpenAI(spec, messages, maxTokens, keys.openai, salt, onFirstToken);
		}
		if (spec.transport === "google") {
			if (!keys.google) return { usage: emptyUsage(undefined), error: "GEMINI_API_KEY not set" };
			return await callGoogle(spec, messages, maxTokens, keys.google, onFirstToken);
		}
		if (!keys.openrouter) return { usage: emptyUsage(undefined), error: "OPENROUTER_API_KEY not set" };
		return await callOpenRouter(spec, messages, maxTokens, keys.openrouter, onFirstToken);
	} catch (error) {
		return { usage: emptyUsage(undefined), error: error instanceof Error ? error.message : String(error) };
	}
}

export function requiredKeys(specs: ModelSpec[]): Array<keyof Keys> {
	const need = new Set<keyof Keys>();
	for (const s of specs) {
		if (s.transport === "anthropic") need.add("anthropic");
		else if (s.transport === "openai") need.add("openai");
		else if (s.transport === "google") need.add("google");
		else need.add("openrouter");
	}
	return [...need];
}
