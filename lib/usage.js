/**
 * The usage fold: turn a list of durable session events into exact per-route
 * token buckets and money.
 *
 * The fold's input is the raw event list, so the same code prices a live
 * in-memory session (`session.eventAt(i)` for `i` below `session.seq`) and a
 * session log decoded from disk. Each Settled step contributes the usage its
 * `assistant/message` reports — taken from the event's own `usage` field when
 * present, otherwise from the last `usage` chunk embedded in its stream, which
 * is how `dsh-token-meter`'s `tokenUsage` projection obtains the same numbers.
 *
 * Attribution is per **attempt**, not per session: the route comes from the
 * assistant message's own `source`, so a conversation that switches models
 * prices each model at its own rate. The representative instant for
 * peak/off-peak is the event's own `time`.
 *
 * @module @local/dsh-session-cost/usage
 */

import { BUCKETS, BUCKET_PRICE_FIELD, MICRO_USD, priceBuckets, resolveRates } from "./rates.js";

/** A usage record's bucket fields, in the order every surface shows them. */
const BUCKET_FIELDS = {
	uncachedInputTokens: "inputTokens",
	cacheReadTokens: "cacheReadTokens",
	cacheWriteTokens: "cacheWriteTokens",
	outputTokens: "outputTokens",
};

/**
 * Read a non-negative safe integer, or undefined.
 *
 * @param {unknown} value - candidate.
 * @returns {number|undefined} the count.
 */
function count(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Take the last `usage` chunk embedded in an assistant stream.
 *
 * The stream is either an array of chunks or an object carrying one; both shapes
 * exist in the log, and the newest sample is the one that was billed.
 *
 * @param {unknown} stream - the event's `stream` field.
 * @returns {object|undefined} the usage record.
 */
export function streamUsage(stream) {
	const chunks = Array.isArray(stream) ? stream : Array.isArray(stream?.chunks) ? stream.chunks : undefined;
	if (chunks === undefined) return undefined;
	for (let index = chunks.length - 1; index >= 0; index -= 1) {
		const chunk = chunks[index];
		if (chunk !== null && typeof chunk === "object" && chunk.type === "usage" && chunk.usage !== undefined) {
			return chunk.usage;
		}
	}
	return undefined;
}

/**
 * Normalize one provider usage record into the four durable buckets.
 *
 * A record without a usable `inputTokens`/`outputTokens` pair is unusable and
 * yields undefined rather than a partial (and therefore wrong) price.
 *
 * @param {unknown} usage - provider-reported usage.
 * @returns {{uncachedInputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number}|undefined} buckets.
 */
export function normalizeUsage(usage) {
	if (usage === null || typeof usage !== "object") return undefined;
	const inputTokens = count(usage.inputTokens);
	const outputTokens = count(usage.outputTokens);
	if (inputTokens === undefined || outputTokens === undefined) return undefined;
	return {
		uncachedInputTokens: inputTokens,
		cacheReadTokens: count(usage.cacheReadTokens) ?? 0,
		cacheWriteTokens: count(usage.cacheWriteTokens) ?? 0,
		outputTokens,
	};
}

/** Sum bucket fields without losing integer safety. */
function addBuckets(target, source) {
	for (const bucket of BUCKETS) target[bucket] += source[bucket];
	return target;
}

/** A route key that is stable regardless of the provider string's presence. */
function routeKey(provider, model) {
	return `${provider ?? ""}/${model ?? ""}`;
}

/** Total tokens across every bucket (cache traffic included, as the provider bills it). */
export function totalTokens(buckets) {
	let total = 0;
	for (const bucket of BUCKETS) total += Number(buckets?.[bucket] ?? 0);
	return total;
}

/**
 * Fold durable events into per-route token buckets.
 *
 * Only `assistant/message` events carry a reconciled bill; `assistant/attempt`
 * carries an in-flight sample that a retry replaces or discards, and counting
 * both would double-bill the retried step.
 *
 * @param {Iterable<object>} events - session events in seq order.
 * @returns {{routes: Array<object>, totals: object, attempts: number, events: number}} the fold.
 */
export function foldUsage(events) {
	const byRoute = new Map();
	const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	let attempts = 0;
	let seen = 0;
	for (const event of events) {
		if (event === null || typeof event !== "object") continue;
		seen += 1;
		if (event.type !== "assistant/message") continue;
		const buckets = normalizeUsage(event.data?.usage) ?? normalizeUsage(streamUsage(event.data?.stream));
		if (buckets === undefined) continue;
		const provider = event.data?.message?.source?.provider;
		const model = event.data?.message?.source?.model;
		const key = routeKey(provider, model);
		let row = byRoute.get(key);
		if (row === undefined) {
			row = {
				provider: typeof provider === "string" ? provider : "",
				model: typeof model === "string" ? model : "",
				attempts: 0,
				firstTime: Number.isFinite(event.time) ? event.time : undefined,
				lastTime: Number.isFinite(event.time) ? event.time : undefined,
				samples: [],
				buckets: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
			};
			byRoute.set(key, row);
		}
		row.attempts += 1;
		// `firstTime` is set once at creation; only `lastTime` can advance, and the
		// fold walks events in seq order, so the newest event owns it.
		if (Number.isFinite(event.time)) row.lastTime = event.time;
		// The sample is kept per attempt so pricing can resolve peak/off-peak at
		// the instant each attempt was actually billed, not once per route.
		row.samples.push({ time: Number.isFinite(event.time) ? event.time : undefined, buckets });
		addBuckets(row.buckets, buckets);
		addBuckets(totals, buckets);
		attempts += 1;
	}
	const routes = [...byRoute.values()].sort((left, right) => totalTokens(right.buckets) - totalTokens(left.buckets));
	return { routes, totals, attempts, events: seen };
}

/**
 * Price a fold against a rate table.
 *
 * @param {object} input - pricing input.
 * @param {ReturnType<typeof foldUsage>} input.fold - the usage fold.
 * @param {Record<string, object>} input.rates - parsed rate table.
 * @param {object} input.currency - display currency.
 * @param {string} input.timezone - IANA zone for the peak window.
 * @param {number} input.offPeakMultiplier - deployment-wide off-peak multiplier.
 * @param {Iterable<string>} [input.holidays] - dates that are off-peak for the whole day.
 * @param {number} [input.at] - instant used for routes whose events carry no time.
 * @returns {{routes: Array<object>, totals: object, priced: boolean, unpriced: string[], ambiguity: Array<object>}} the cost report.
 */
export function costUsage({ fold, rates, currency, timezone, offPeakMultiplier, holidays, at }) {
	const fallbackTime = Number.isFinite(at) ? at : Date.now();
	const routes = [];
	const totals = {
		...fold.totals,
		microUsd: 0,
		tokens: totalTokens(fold.totals),
		pricedTokens: 0,
		unpricedTokens: 0,
		peakTokens: 0,
		offPeakTokens: 0,
		flatTokens: 0,
	};
	const unpriced = [];
	const ambiguity = [];
	for (const row of fold.routes) {
		const resolution = resolveRates(rates, row.provider, row.model);
		if (resolution.ambiguous !== undefined && resolution.ambiguous.length > 0) {
			ambiguity.push({ provider: row.provider, model: row.model, candidates: resolution.ambiguous });
		}
		const priced = { microUsd: 0, tokens: 0, peakTokens: 0, offPeakTokens: 0, flatTokens: 0 };
		// A route whose price list has no peak/off-peak window is charged its single
		// price at every instant; its tokens are neither peak nor off-peak, and
		// saying either would misreport the tariff it is actually on.
		const windowed = resolution.rates !== undefined && resolution.rates.peakPricing !== false;
		const breakdown = {};
		if (resolution.rates !== undefined) {
			for (const bucket of BUCKETS) {
				breakdown[bucket] = {
					tokens: row.buckets[bucket],
					microUsd: 0,
					pricePerMillion: resolution.rates[BUCKET_PRICE_FIELD[bucket]],
				};
			}
			for (const sample of row.samples) {
				const result = priceBuckets({
					tokens: sample.buckets,
					rates: resolution.rates,
					timeMs: sample.time ?? fallbackTime,
					timezone,
					offPeakMultiplier,
					holidays,
				});
				const sampleTokens = totalTokens(sample.buckets);
				priced.microUsd += result.microUsd;
				priced.tokens += sampleTokens;
				if (!result.windowed) priced.flatTokens += sampleTokens;
				else if (result.peak) priced.peakTokens += sampleTokens;
				else priced.offPeakTokens += sampleTokens;
				for (const bucket of BUCKETS) {
					breakdown[bucket].microUsd += result.buckets[bucket].microUsd;
					// A route that straddles peak and off-peak has no single price;
					// report the observed blend instead of one misleading figure.
					breakdown[bucket].pricePerMillion = breakdown[bucket].tokens === 0
						? result.buckets[bucket].pricePerMillion
						: (breakdown[bucket].microUsd * 1_000_000) / breakdown[bucket].tokens / MICRO_USD;
				}
			}
		} else {
			const tokens = totalTokens(row.buckets);
			priced.tokens = 0;
			totals.unpricedTokens += tokens;
			unpriced.push(routeKey(row.provider, row.model));
		}
		totals.microUsd += priced.microUsd;
		totals.pricedTokens += priced.tokens;
		totals.peakTokens += priced.peakTokens;
		totals.offPeakTokens += priced.offPeakTokens;
		totals.flatTokens += priced.flatTokens;
		routes.push({
			provider: row.provider,
			model: row.model,
			label: resolution.rates?.label,
			rateKey: resolution.rates === undefined ? null : resolution.key,
			attempts: row.attempts,
			firstTime: row.firstTime,
			lastTime: row.lastTime,
			buckets: row.buckets,
			tokens: totalTokens(row.buckets),
			microUsd: priced.microUsd,
			usd: priced.microUsd / MICRO_USD,
			pricedTokens: priced.tokens,
			peakTokens: priced.peakTokens,
			offPeakTokens: priced.offPeakTokens,
			flatTokens: priced.flatTokens,
			// Whether this route's price list has a peak/off-peak window at all;
			// `false` means one flat price, and no window label applies.
			windowed: resolution.rates === undefined ? false : resolution.rates.peakPricing !== false,
			priced: resolution.rates !== undefined,
			breakdown,
		});
	}
	const priced = unpriced.length === 0;
	const currencyTotals = {
		...totals,
		usd: totals.microUsd / MICRO_USD,
		display: totals.microUsd / MICRO_USD * (currency?.perUsd ?? 1),
	};
	return { routes, totals: currencyTotals, priced, unpriced, ambiguity };
}

/**
 * Fold and price in one call.
 *
 * @param {object} input - see {@link foldUsage} and {@link costUsage}.
 * @returns {{routes: Array<object>, totals: object, priced: boolean, unpriced: string[], ambiguity: Array<object>, attempts: number, events: number}} the report.
 */
export function costEvents({ events, rates, currency, timezone, offPeakMultiplier, holidays, at }) {
	const fold = foldUsage(events);
	return { ...costUsage({ fold, rates, currency, timezone, offPeakMultiplier, holidays, at }), attempts: fold.attempts, events: fold.events };
}

export { BUCKET_FIELDS };
