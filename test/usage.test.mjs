/**
 * Usage-fold tests: what counts as a bill, which route pays it, and how a
 * multi-model conversation is priced.
 *
 * Run: node --test --test-isolation=none test/usage.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { costEvents, costUsage, foldUsage, normalizeUsage, streamUsage, totalTokens } from "../lib/usage.js";
import { DEFAULT_RATES, parseRateTable } from "../lib/rates.js";
import { renderReport } from "../lib/report.js";
import { assistantEvent, makeSessionEvents } from "./helpers.js";

const currency = { symbol: "$", code: "USD", perUsd: 1 };
// A US-dollar price list on purpose: these tests are about the money arithmetic,
// not about DeepSeek's default table (which is CNY, because the account is). The
// figures below are the published USD list prices, so the expected amounts stay
// readable and the currency handling stays exercised.
const rates = parseRateTable({
	"deepseek-official/deepseek-flash": { label: "DeepSeek-V4.1-Flash", input: 0.3, cacheRead: 0.006, output: 1.2 },
	"deepseek-official/deepseek-v4-pro": { label: "DeepSeek-V4-Pro", input: 1.32, cacheRead: 0.044, output: 3.96 },
});
// 2026-01-05 is a Monday and not a Chinese public holiday, so these two instants
// differ only by the peak window — which is the variable under test.
const OFF_PEAK = Date.UTC(2026, 0, 5, 12, 0); // Monday 12:00 UTC
const PEAK = Date.UTC(2026, 0, 5, 2, 0); // Monday 02:00 UTC

test("normalizeUsage requires a usable input/output pair and defaults absent cache buckets to 0", () => {
	assert.equal(normalizeUsage(undefined), undefined);
	assert.equal(normalizeUsage({ inputTokens: 10 }), undefined, "output is required");
	assert.equal(normalizeUsage({ inputTokens: 1.5, outputTokens: 2 }), undefined, "counts must be integers");
	assert.equal(normalizeUsage({ inputTokens: -1, outputTokens: 2 }), undefined);
	assert.deepEqual(normalizeUsage({ inputTokens: 10, outputTokens: 2 }), {
		uncachedInputTokens: 10,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 2,
	});
	assert.deepEqual(normalizeUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }), {
		uncachedInputTokens: 1,
		cacheReadTokens: 3,
		cacheWriteTokens: 4,
		outputTokens: 2,
	});
});

test("streamUsage takes the newest usage chunk in either stream shape", () => {
	assert.deepEqual(streamUsage([{ type: "delta" }, { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } }]), {
		inputTokens: 1,
		outputTokens: 2,
	});
	assert.deepEqual(streamUsage({ chunks: [{ type: "usage", usage: { inputTokens: 9, outputTokens: 9 } }] }), {
		inputTokens: 9,
		outputTokens: 9,
	});
	assert.equal(streamUsage([{ type: "delta" }]), undefined);
	assert.equal(streamUsage(undefined), undefined);
});

test("foldUsage sums per route and ignores in-flight assistant/attempt events", () => {
	const events = [
		...makeSessionEvents({ turns: 2 }),
		// An attempt carries an in-flight sample that a retry would replace;
		// counting it would double-bill the step.
		{ type: "assistant/attempt", seq: 99, time: OFF_PEAK, data: { turn: 3, step: 1, stream: [{ type: "usage", usage: { inputTokens: 9999, outputTokens: 9999 } }] } },
	];
	const fold = foldUsage(events);
	assert.equal(fold.attempts, 2);
	assert.equal(fold.routes.length, 1);
	assert.equal(fold.routes[0].buckets.uncachedInputTokens, 300);
	assert.equal(fold.routes[0].buckets.outputTokens, 60);
	assert.equal(fold.routes[0].buckets.cacheReadTokens, 3000);
	assert.equal(fold.totals.uncachedInputTokens, 300);
	assert.equal(totalTokens(fold.totals), 3360);
});

test("foldUsage falls back to a usage chunk embedded in the message stream", () => {
	const events = [
		{ type: "session", id: "session-1", createdAt: OFF_PEAK },
		{
			type: "assistant/message",
			seq: 1,
			time: OFF_PEAK,
			data: {
				turn: 1,
				step: 1,
				message: { source: { provider: "p", model: "m" } },
				stream: [{ type: "text" }, { type: "usage", usage: { inputTokens: 5, outputTokens: 6 } }],
			},
		},
	];
	const fold = foldUsage(events);
	assert.equal(fold.attempts, 1);
	assert.equal(fold.routes[0].buckets.uncachedInputTokens, 5);
	assert.equal(fold.routes[0].buckets.outputTokens, 6);
});

test("foldUsage keeps a route per provider/model, so a switched model is billed separately", () => {
	const events = [
		assistantEvent({ seq: 1, time: OFF_PEAK, provider: "deepseek-official", model: "deepseek-flash", usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }),
		assistantEvent({ seq: 2, time: OFF_PEAK, provider: "deepseek-official", model: "deepseek-v4-pro", usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }),
		assistantEvent({ seq: 3, time: OFF_PEAK, provider: "vendor-x", model: "mystery", usage: { inputTokens: 10, outputTokens: 10 } }),
	];
	const report = costEvents({ events, rates, currency, timezone: "UTC", offPeakMultiplier: 0.5, at: OFF_PEAK });
	assert.equal(report.routes.length, 3);
	const flash = report.routes.find((route) => route.model === "deepseek-flash");
	const pro = report.routes.find((route) => route.model === "deepseek-v4-pro");
	const unknown = report.routes.find((route) => route.model === "mystery");
	// Off-peak flash: input 0.15 + output 0.6 per 1M.
	assert.equal(flash.microUsd, 750_000);
	// Off-peak v4-pro: input 0.66 + output 1.98.
	assert.equal(pro.microUsd, 2_640_000);
	assert.equal(unknown.priced, false);
	assert.equal(unknown.microUsd, 0);
	assert.deepEqual(report.unpriced, ["vendor-x/mystery"]);
	assert.equal(report.priced, false, "one unpriced route makes the whole report not fully priced");
	assert.equal(report.totals.unpricedTokens, 20);
	assert.equal(report.totals.microUsd, 3_390_000, "unpriced tokens add nothing to the money total");
	assert.equal(report.totals.tokens, 4_000_020);
	assert.equal(report.totals.pricedTokens, 4_000_000);
});

test("costEvents prices each attempt in the window it actually ran in", () => {
	const events = [
		assistantEvent({ seq: 1, time: PEAK, usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
		assistantEvent({ seq: 2, time: OFF_PEAK, usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
	];
	const report = costEvents({ events, rates, currency, timezone: "UTC", offPeakMultiplier: 0.5, at: OFF_PEAK });
	// Peak 0.3 + off-peak 0.15 = 0.45 USD for the same one million input tokens.
	assert.equal(report.totals.microUsd, 450_000);
	const route = report.routes[0];
	assert.equal(route.peakTokens, 1_000_000);
	assert.equal(route.offPeakTokens, 1_000_000);
	// The blended observed price is the average of the two windows.
	assert.equal(route.breakdown.uncachedInputTokens.pricePerMillion, 0.225);
});

test("costEvents bills a flat-price route at one rate, and says so instead of naming a window", () => {
	// The real shape of the bug this guards: a non-DeepSeek provider with a single
	// price was being halved off-peak, and the panel then advertised
	// "非高峰 ×0.5" for a tariff that does not exist.
	const flatRates = parseRateTable({ "our-free-model/free": { input: 1, output: 2 } });
	const report = costEvents({
		events: [assistantEvent({ seq: 1, time: OFF_PEAK, provider: "our-free-model", model: "free", usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } })],
		rates: flatRates,
		currency,
		timezone: "UTC",
		offPeakMultiplier: 0.5,
		at: OFF_PEAK,
	});
	const route = report.routes[0];
	assert.equal(route.windowed, false);
	assert.equal(route.flatTokens, 2_000_000, "flat tokens are neither peak nor off-peak");
	assert.equal(route.peakTokens, 0);
	assert.equal(route.offPeakTokens, 0);
	assert.equal(route.microUsd, 3_000_000, "1 + 2 USD per 1M, not halved");
	assert.equal(report.totals.flatTokens, 2_000_000);
	assert.equal(report.totals.offPeakTokens, 0);
	const text = renderReport(report, currency, { detail: true });
	assert.match(text, /固定价：该模型不分高峰\/非高峰/);
	assert.ok(!text.includes("全部按非高峰价"), "a flat route never claims an off-peak price");
	assert.ok(!text.includes("非高峰 ×"), "and never quotes an off-peak multiplier");
});

test("costEvents reports price ambiguity instead of guessing between two providers", () => {
	const ambiguousRates = parseRateTable({
		"provider-a/shared": { input: 1, output: 1 },
		"provider-b/shared": { input: 2, output: 2 },
	});
	const events = [assistantEvent({ seq: 1, time: OFF_PEAK, provider: "provider-c", model: "shared", usage: { inputTokens: 10, outputTokens: 10 } })];
	const report = costEvents({ events, rates: ambiguousRates, currency, timezone: "UTC", offPeakMultiplier: 1, at: OFF_PEAK });
	assert.equal(report.routes[0].priced, false);
	assert.equal(report.ambiguity.length, 1);
	assert.deepEqual(report.ambiguity[0].candidates.sort(), ["provider-a/shared", "provider-b/shared"]);
});

test("costEvents reaches an exact zero for a conversation with no billable call", () => {
	const report = costEvents({ events: makeSessionEvents({ turns: 0 }), rates, currency, timezone: "UTC", offPeakMultiplier: 0.5, at: OFF_PEAK });
	assert.equal(report.attempts, 0);
	assert.equal(report.totals.tokens, 0);
	assert.equal(report.totals.microUsd, 0);
	assert.equal(report.priced, true);
	assert.deepEqual(report.routes, []);
});

test("costUsage tolerates events with no time by pricing at the fallback instant", () => {
	const events = [assistantEvent({ seq: 1, time: undefined, usage: { inputTokens: 1_000_000, outputTokens: 0 } })];
	const report = costEvents({ events, rates, currency, timezone: "UTC", offPeakMultiplier: 0.5, at: PEAK });
	assert.equal(report.totals.microUsd, 300_000, "priced at the peak fallback instant");
});

test("costUsage treats a route with a configured label as priced and carries the label through", () => {
	const fold = foldUsage([assistantEvent({ seq: 1, time: OFF_PEAK, usage: { inputTokens: 1, outputTokens: 1 } })]);
	const report = costUsage({ fold, rates, currency, timezone: "UTC", offPeakMultiplier: 0.5, at: OFF_PEAK });
	assert.equal(report.routes[0].label, "DeepSeek-V4.1-Flash");
	assert.equal(report.routes[0].rateKey, "deepseek-official/deepseek-flash");
});
