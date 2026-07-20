/**
 * Provider prompt-cache keepalive.
 *
 * Provider prompt caches (Anthropic, OpenAI, Bedrock, Google, ...) are stateless
 * and prefix-addressed: there is no live per-session KV cache to hold open. The
 * only lever a client has is that *reading* a cached prefix refreshes it - both
 * its TTL and, on a capacity-bound (LRU) cache, its eviction recency. A long
 * `cacheRetention` raises the TTL ceiling but does nothing against LRU pressure
 * from other tenants; a periodic read touches recency as well as TTL.
 *
 * While a long-running tool call blocks the turn, the conversation prefix goes
 * cold and can be evicted before the next real request. `startCacheKeepAlive`
 * replays the exact request prefix (the `Context` that produced the current
 * assistant turn) on a timer, with minimal generation, and discards the result.
 * The replay is byte-identical to the just-sent request, so it hits the same
 * cache prefix and keeps it warm.
 */

import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { CacheKeepAlive, CacheKeepAliveHandle } from "../types.ts";

/**
 * Begin pinging the provider cache with the given request prefix until `stop()`.
 *
 * Pings never overlap: if a ping is still in flight when the next interval
 * elapses, that tick is skipped. Ping failures are swallowed - keepalive is
 * best-effort and must never disrupt the turn. If `parentSignal` aborts, all
 * pings are cancelled.
 */
export function startCacheKeepAlive(
	keepAlive: CacheKeepAlive,
	model: Model<Api>,
	context: Context,
	parentSignal: AbortSignal | undefined,
): CacheKeepAliveHandle {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let inFlight: { controller: AbortController; done: Promise<void> } | null = null;
	let pingIndex = 0;

	const onParentAbort = () => {
		void stop();
	};

	function schedule(delay: number): void {
		timer = setTimeout(tick, delay);
	}

	function tick(): void {
		if (stopped) return;
		// Keep a fixed cadence: schedule the next tick before firing this one.
		schedule(keepAlive.intervalMs);
		// Overlap guard: a slow ping must not stack up behind itself.
		if (inFlight) return;
		void fire();
	}

	function fire(): Promise<void> {
		const controller = new AbortController();
		const index = pingIndex++;
		const done = (async () => {
			try {
				keepAlive.onPing?.({ index });
				const stream = await keepAlive.streamFn(model, context, {
					maxTokens: 1,
					signal: controller.signal,
				});
				// Drain and discard: the response is irrelevant, only the cache read matters.
				for await (const _event of stream) {
					// discard
				}
			} catch {
				// Best-effort: ignore ping failures.
			}
		})();
		inFlight = { controller, done };
		return done.finally(() => {
			if (inFlight?.done === done) inFlight = null;
		});
	}

	async function stop(): Promise<void> {
		if (stopped) return;
		stopped = true;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		parentSignal?.removeEventListener("abort", onParentAbort);
		const current = inFlight;
		if (current) {
			current.controller.abort();
			try {
				await current.done;
			} catch {
				// already swallowed in fire()
			}
		}
	}

	if (parentSignal) {
		if (parentSignal.aborted) {
			stopped = true;
			return { stop };
		}
		parentSignal.addEventListener("abort", onParentAbort, { once: true });
	}

	schedule(keepAlive.initialDelayMs ?? keepAlive.intervalMs);

	return { stop };
}
