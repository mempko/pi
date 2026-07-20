/**
 * Probe: can we observe prompt-cache hits per provider through OpenRouter?
 * Sends a large prompt twice per model and prints the raw usage object from
 * each call. A warm second call should report cached prompt tokens.
 */

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
	console.error("OPENROUTER_API_KEY not set");
	process.exit(1);
}

const MODELS = ["anthropic/claude-sonnet-4.5", "openai/gpt-5.1", "google/gemini-2.5-pro"];

// ~3000 tokens of stable filler so caching is meaningful and above OpenAI's ~1024 min.
const sentence = "The quick brown fox jumps over the lazy dog while the cache stays warm. ";
let blob = "";
while (blob.length < 3000 * 4) blob += sentence;

async function call(model: string): Promise<unknown> {
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: `Reference (ignore):\n${blob}`, cache_control: { type: "ephemeral" } },
						{ type: "text", text: "Reply with exactly: ok" },
					],
				},
			],
			max_tokens: 8,
			temperature: 0,
			usage: { include: true },
		}),
	});
	const json = (await res.json()) as { usage?: unknown; error?: unknown; provider?: unknown };
	if (json.error) return { error: json.error };
	return { provider: json.provider, usage: json.usage };
}

for (const model of MODELS) {
	console.log(`\n=== ${model} ===`);
	try {
		const first = await call(model);
		console.log("call 1:", JSON.stringify(first));
		const second = await call(model);
		console.log("call 2:", JSON.stringify(second));
	} catch (error) {
		console.log("failed:", error instanceof Error ? error.message : String(error));
	}
}
