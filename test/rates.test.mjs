/**
 * Pricing-core tests: config parsing, route resolution, the peak window, the
 * money arithmetic, and the formatters.
 *
 * Run: node --test test/
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	BUCKET_PRICE_FIELD,
	DEFAULT_RATES,
	bucketPrices,
	civilTime,
	defaultPeakPricing,
	formatMoney,
	formatTokens,
	isPeak,
	parseConfig,
	parseRateTable,
	priceBuckets,
	readConfig,
	resolveRates,
} from "../lib/rates.js";

test("parseRateTable rejects a non-object, an empty table, and a key without a provider", () => {
	assert.throws(() => parseRateTable(""), /is empty/);
	assert.throws(() => parseRateTable("not json"), /not valid JSON/);
	assert.throws(() => parseRateTable("{}"), /declares no models/);
	assert.throws(() => parseRateTable({ "deepseek-flash": { input: 1, output: 2 } }), /must be "<provider>\/<model>"/);
});

test("parseRateTable rejects a negative or non-numeric price and an unknown field", () => {
	assert.throws(() => parseRateTable({ "p/m": { input: -1, output: 2 } }), /rates\["p\/m"\]\.input must be a finite number >= 0/);
	assert.throws(() => parseRateTable({ "p/m": { input: 1, output: "2" } }), /output must be a finite number >= 0/);
	assert.throws(() => parseRateTable({ "p/m": { input: 1, output: 2, intput: 3 } }), /intput is not a known field/);
	assert.throws(() => parseRateTable({ "p/m": 5 }), /must be an object/);
});

test("parseRateTable defaults cacheRead and cacheWrite to the input price", () => {
	const table = parseRateTable({ "p/m": { input: 3, output: 9 } });
	assert.equal(table["p/m"].cacheRead, 3);
	assert.equal(table["p/m"].cacheWrite, 3);
	assert.equal(table["p/m"].output, 9);
});

test("parseRateTable accepts a JSON string, which is how the row stores it", () => {
	const table = parseRateTable(JSON.stringify({ "p/m": { input: 1, output: 2 } }));
	assert.equal(table["p/m"].input, 1);
});

test("parseRateTable keeps the default DeepSeek table valid", () => {
	const table = parseRateTable(DEFAULT_RATES);
	assert.deepEqual(Object.keys(table).sort(), ["deepseek-official/deepseek-flash", "deepseek-official/deepseek-v4-pro"]);
	// The defaults are the account's own CNY list prices, peak column stored;
	// off-peak is the multiplier halving them. Flash peak: miss 2 / hit 0.04 / out 8.
	assert.equal(table["deepseek-official/deepseek-flash"].cacheRead, 0.04);
	assert.equal(table["deepseek-official/deepseek-flash"].input, 2);
	assert.equal(table["deepseek-official/deepseek-flash"].output, 8);
});

test("parseConfig reads through volatile refs and validates the currency", () => {
	const config = parseConfig({
		rates: { get: () => JSON.stringify(DEFAULT_RATES) },
		currency: { get: () => "{\"symbol\":\"¥\",\"code\":\"CNY\",\"perUsd\":7.2}" },
		offPeakMultiplier: { get: () => 0.5 },
		offPeakTimezone: { get: () => "Asia/Shanghai" },
	});
	assert.equal(config.currency.symbol, "¥");
	assert.equal(config.currency.perUsd, 7.2);
	assert.equal(config.offPeakTimezone, "Asia/Shanghai");
	assert.equal(config.offPeakMultiplier, 0.5);
	assert.equal(readConfig({ value: 3 }, "value"), 3);
});

test("parseConfig rejects perUsd = 0, which would silently price everything at zero", () => {
	assert.throws(
		() => parseConfig({ rates: JSON.stringify(DEFAULT_RATES), currency: "{\"perUsd\":0}" }),
		/perUsd must be greater than 0/,
	);
});

test("resolveRates prefers an exact provider/model key, then a unique bare model", () => {
	const table = parseRateTable({ "p/m": { input: 1, output: 2 } });
	assert.equal(resolveRates(table, "p", "m").rates.input, 1);
	assert.equal(resolveRates(table, "other", "m").rates.input, 1, "a unique bare-model entry applies to every provider");
	const both = parseRateTable({ "p/m": { input: 1, output: 2 }, "q/m": { input: 3, output: 4 } });
	const ambiguous = resolveRates(both, "other", "m");
	assert.equal(ambiguous.rates, undefined);
	assert.deepEqual(ambiguous.ambiguous.sort(), ["p/m", "q/m"]);
	assert.equal(resolveRates(table, "p", "nope").rates, undefined);
	assert.equal(resolveRates(table, "p", "").rates, undefined);
});

test("civilTime and isPeak follow 01:00-04:00 and 06:00-10:00 on weekdays", () => {
	// 2026-01-05 is a Monday.
	const monday = Date.UTC(2026, 0, 5, 0, 0, 0);
	assert.deepEqual(civilTime(monday, "UTC"), { weekday: 1, hour: 0, date: "2026-01-05" });
	assert.equal(isPeak(Date.UTC(2026, 0, 5, 0, 30), "UTC", []), false, "before 01:00 is off-peak");
	assert.equal(isPeak(Date.UTC(2026, 0, 5, 1, 0), "UTC", []), true, "01:00 inclusive");
	assert.equal(isPeak(Date.UTC(2026, 0, 5, 3, 59), "UTC", []), true);
	assert.equal(isPeak(Date.UTC(2026, 0, 5, 4, 0), "UTC", []), false, "04:00 exclusive");
	assert.equal(isPeak(Date.UTC(2026, 0, 5, 6, 0), "UTC", []), true);
	assert.equal(isPeak(Date.UTC(2026, 0, 5, 10, 0), "UTC", []), false);
	assert.equal(isPeak(Date.UTC(2026, 0, 5, 12, 0), "UTC", []), false, "midday is off-peak");
	// Saturday 2026-01-10 02:00 UTC would be peak on a weekday.
	assert.equal(isPeak(Date.UTC(2026, 0, 10, 2, 0), "UTC", []), false, "weekends are off-peak all day");
	// Asia/Shanghai is UTC+8: 01:00 UTC Monday is 09:00 local Monday.
	assert.equal(isPeak(Date.UTC(2026, 0, 5, 1, 0), "Asia/Shanghai", []), true);
	assert.equal(isPeak(Date.UTC(2026, 0, 4, 17, 0), "Asia/Shanghai", []), true, "01:00 Tuesday local = 17:00 Monday UTC");
});

test("a Chinese public holiday is off-peak for the whole day", () => {
	// 2026-10-05 is a Monday inside the 国庆 holiday, which the official pricing
	// footnote excludes from peak. Without the calendar a weekday holiday is
	// priced at peak and the bill is overstated by 2×.
	const holidayMonday = Date.UTC(2026, 9, 5, 2, 0); // 02:00 UTC = inside the peak window
	assert.equal(isPeak(holidayMonday, "UTC", []), true, "the same instant is peak without the calendar");
	assert.equal(isPeak(holidayMonday, "UTC", ["2026-10-05"]), false, "the calendar makes it off-peak");
	// The window itself is unaffected on a normal weekday.
	assert.equal(isPeak(Date.UTC(2026, 9, 6, 2, 0), "UTC", ["2026-10-05"]), true, "another day is still peak");
	// And the holiday is recognised in a non-UTC zone too.
	assert.equal(isPeak(Date.UTC(2026, 9, 4, 17, 0), "Asia/Shanghai", ["2026-10-05"]), false, "01:00 on 10-05 in Shanghai");
});

test("parseConfig normalizes the holiday calendar", () => {
	const withDefaults = parseConfig({ rates: JSON.stringify(DEFAULT_RATES) });
	assert.ok(withDefaults.offPeakHolidays.includes("2026-10-05"), "an empty field means the built-in calendar");
	const custom = parseConfig({ rates: JSON.stringify(DEFAULT_RATES), offPeakHolidays: "2027-01-01, 2027-02-06" });
	assert.deepEqual(custom.offPeakHolidays, ["2027-01-01", "2027-02-06"]);
	const array = parseConfig({ rates: JSON.stringify(DEFAULT_RATES), offPeakHolidays: ["2027-01-01"] });
	assert.deepEqual(array.offPeakHolidays, ["2027-01-01"]);
	assert.throws(
		() => parseConfig({ rates: JSON.stringify(DEFAULT_RATES), offPeakHolidays: "2027/01/01" }),
		/is not a YYYY-MM-DD date/,
	);
});

test("civilTime rejects an unusable time zone instead of silently pricing at UTC", () => {
	assert.throws(() => civilTime(Date.now(), "Not/AZone"), /not a usable IANA time zone/);
});

test("bucketPrices halves the peak price off-peak and honours explicit overrides", () => {
	const rates = parseRateTable({ "p/m": { input: 1, cacheRead: 0.1, output: 2 } })["p/m"];
	const peak = bucketPrices(rates, true, 0.5);
	assert.deepEqual([peak.input, peak.cacheRead, peak.output], [1, 0.1, 2]);
	const off = bucketPrices(rates, false, 0.5);
	assert.deepEqual([off.input, off.cacheRead, off.output], [0.5, 0.05, 1]);
	const override = bucketPrices({ ...rates, inputOffPeak: 0.123 }, false, 0.5);
	assert.equal(override.input, 0.123, "an explicit off-peak price wins over the multiplier");
	const own = bucketPrices({ ...rates, offPeakMultiplier: 0.25 }, false, 0.5);
	assert.equal(own.input, 0.25, "a per-model multiplier wins over the deployment-wide one");
});

test("priceBuckets prices each bucket at its own rate and maps bucket names to price fields", () => {
	// A DeepSeek key, because the peak/off-peak window is that provider's own
	// billing rule; `peakPricing` is what states it (see the default test below).
	const rates = parseRateTable({ "deepseek-official/m": { input: 0.3, cacheRead: 0.006, output: 1.2 } })["deepseek-official/m"];
	const result = priceBuckets({
		tokens: { uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 },
		rates,
		timeMs: Date.UTC(2026, 0, 5, 12, 0),
		timezone: "UTC",
		offPeakMultiplier: 0.5,
	});
	assert.equal(result.windowed, true);
	assert.equal(result.peak, false);
	// Off-peak: input 0.15, cacheRead 0.003, output 0.6 per 1M.
	assert.equal(result.buckets.uncachedInputTokens.microUsd, 150_000);
	assert.equal(result.buckets.cacheReadTokens.microUsd, 3_000);
	assert.equal(result.buckets.outputTokens.microUsd, 600_000);
	assert.equal(result.microUsd, 753_000);
	assert.equal(BUCKET_PRICE_FIELD.cacheReadTokens, "cacheRead");
});

test("priceBuckets charges the peak price inside the peak window", () => {
	const rates = parseRateTable({ "deepseek-official/m": { input: 0.3, output: 1.2 } })["deepseek-official/m"];
	const result = priceBuckets({
		tokens: { uncachedInputTokens: 1_000_000, outputTokens: 1_000_000 },
		rates,
		timeMs: Date.UTC(2026, 0, 5, 2, 0),
		timezone: "UTC",
		offPeakMultiplier: 0.5,
	});
	assert.equal(result.peak, true);
	assert.equal(result.microUsd, 1_500_000);
});

test("a flat-price route is never halved: the window is DeepSeek's, not a global rule", () => {
	// `our-free-model/mimo-v2.6-flash-free` on this machine was being charged
	// off-peak half price — its provider quotes one flat rate, so the discount was
	// invented and the panel advertised it.
	const rates = parseRateTable({ "our-free-model/free": { input: 1, cacheRead: 0.02, output: 2 } })["our-free-model/free"];
	assert.equal(rates.peakPricing, false, "a key that does not name DeepSeek defaults to a flat price");
	const offPeak = priceBuckets({
		tokens: { uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 },
		rates,
		timeMs: Date.UTC(2026, 0, 5, 12, 0),
		timezone: "UTC",
		offPeakMultiplier: 0.5,
	});
	assert.equal(offPeak.windowed, false);
	// 1 + 0.02 + 2 CNY, the stored prices, at an instant DeepSeek would call off-peak.
	assert.equal(offPeak.microUsd, 3_020_000);
	// The same buckets inside the peak window cost exactly the same, which is the
	// point: a flat route has no cheaper hour.
	const peak = priceBuckets({
		tokens: { uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 },
		rates,
		timeMs: Date.UTC(2026, 0, 5, 2, 0),
		timezone: "UTC",
		offPeakMultiplier: 0.5,
	});
	assert.equal(peak.microUsd, offPeak.microUsd);
	// An explicit switch wins both ways, for a DeepSeek route billed flat and a
	// differently-named provider that really does have two prices.
	const flatDeepSeek = parseRateTable({ "deepseek-official/m": { input: 1, output: 1, peakPricing: false } })["deepseek-official/m"];
	assert.equal(flatDeepSeek.peakPricing, false);
	assert.equal(priceBuckets({ tokens: { outputTokens: 1_000_000 }, rates: flatDeepSeek, timeMs: Date.UTC(2026, 0, 5, 12, 0), timezone: "UTC", offPeakMultiplier: 0.5 }).microUsd, 1_000_000);
	const windowedOther = parseRateTable({ "vendor-x/m": { input: 1, output: 1, peakPricing: true } })["vendor-x/m"];
	assert.equal(windowedOther.peakPricing, true);
	assert.equal(priceBuckets({ tokens: { outputTokens: 1_000_000 }, rates: windowedOther, timeMs: Date.UTC(2026, 0, 5, 12, 0), timezone: "UTC", offPeakMultiplier: 0.5 }).microUsd, 500_000);
});

test("peakPricing must be a boolean, so a typo fails at mount instead of pricing wrongly", () => {
	assert.throws(
		() => parseRateTable({ "deepseek-official/m": { input: 1, output: 1, peakPricing: "false" } }),
		/peakPricing must be true or false/,
	);
	assert.equal(defaultPeakPricing("deepseek-account/deepseek-flash"), true);
	assert.equal(defaultPeakPricing("DeepSeek-Official/x"), true, "the name match is case-insensitive");
	assert.equal(defaultPeakPricing("our-free-model/mimo-v2.6-flash-free"), false);
	assert.equal(defaultPeakPricing(""), false);
});

test("priceBuckets rounds each bucket once so the rows a reader adds up equal the total", () => {
	const rates = parseRateTable({ "deepseek-official/m": { input: 0.3, output: 1.2 } })["deepseek-official/m"];
	const result = priceBuckets({
		tokens: { uncachedInputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 7 },
		rates,
		timeMs: Date.UTC(2026, 0, 5, 12, 0),
		timezone: "UTC",
		offPeakMultiplier: 1,
	});
	const sum = Object.values(result.buckets).reduce((total, row) => total + row.microUsd, 0);
	assert.equal(result.microUsd, sum);
});

test("formatMoney scales into the display currency and picks readable digits", () => {
	assert.equal(formatMoney(0, { symbol: "$", perUsd: 1 }), "$0.00");
	assert.equal(formatMoney(12_300, { symbol: "$", perUsd: 1 }), "$0.0123");
	assert.equal(formatMoney(1_500_000, { symbol: "$", perUsd: 1 }), "$1.5000");
	assert.equal(formatMoney(1_000_000, { symbol: "¥", perUsd: 7.2 }), "¥7.2000");
	// A small total still shows its first significant digit.
	assert.equal(formatMoney(123, { symbol: "$", perUsd: 1 }), "$0.000123");
	assert.equal(formatMoney(123, { symbol: "$", perUsd: 1 }, 2), "$0.00");
	assert.equal(formatMoney(20_000_000, { symbol: "$", perUsd: 1 }, 2), "$20.00");
});

test("formatTokens compacts at the thousand and million boundaries", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1000), "1.0k");
	assert.equal(formatTokens(12_345), "12k");
	assert.equal(formatTokens(999_999), "1000k");
	assert.equal(formatTokens(1_500_000), "1.50M");
	assert.equal(formatTokens(Number.NaN), "0");
});
