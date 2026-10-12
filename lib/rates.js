/**
 * Pure pricing core: the rate table, the peak/off-peak window, and the money
 * arithmetic. Nothing here touches Cordis, the filesystem, or the clock — the
 * caller passes the timestamp and the token buckets, so every figure this
 * module produces is reproducible in a test.
 *
 * Money is kept in integer micro-USD (`usd * 1e6`): a fractional-cent total is
 * normal for one conversation, and integer arithmetic keeps a long session's
 * sum exact instead of accumulating binary-float drift.
 *
 * @module @local/dsh-session-cost/rates
 */

/** Micro-USD per USD. One unit is 0.000001 USD, so a whole conversation fits an integer. */
export const MICRO_USD = 1_000_000;

/** Input-token bucket keys every route prices. */
export const BUCKETS = ["uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"];

/**
 * Durable bucket → price field. The projection names a bucket by what it
 * measures (`uncachedInputTokens`), while a rate names the price it charges
 * (`input`); this is the one place the two vocabularies meet.
 */
export const BUCKET_PRICE_FIELD = {
	uncachedInputTokens: "input",
	cacheReadTokens: "cacheRead",
	cacheWriteTokens: "cacheWrite",
	outputTokens: "output",
};

/**
 * Default rate table, keyed `<provider>/<model>`.
 *
 * Values are the **account's own currency per 1M tokens** — here CNY, because a
 * DeepSeek account is denominated in CNY and its balance moves in CNY. Pricing a
 * CNY account in USD makes every readout disagree with the platform by the
 * exchange rate while looking like a counting error, which is exactly what
 * happened before this table was corrected.
 *
 * The stored figure is the **peak** price; `offPeakMultiplier` halves it in the
 * off-peak window — but only for a route that has such a window (`peakPricing`,
 * see {@link defaultPeakPricing}). A route with a single flat price is charged
 * the stored figure all day. Cache writes are not billed separately by
 * DeepSeek, so they are priced as an ordinary input token.
 *
 * Source: api-docs.deepseek.com/zh-cn/quick_start/pricing — Flash 高峰
 * 未命中 2 / 命中 0.04 / 输出 8 元；Pro 为其 3 倍。Verified against a real
 * account: today's sessions priced off-peak give 9.30 CNY against a 9.06 CNY
 * balance movement.
 */
export const DEFAULT_RATES = {
	"deepseek-official/deepseek-flash": {
		label: "DeepSeek-V4.1-Flash",
		input: 2,
		cacheRead: 0.04,
		output: 8,
	},
	"deepseek-official/deepseek-v4-pro": {
		label: "DeepSeek-V4-Pro",
		input: 9,
		cacheRead: 0.3,
		output: 27,
	},
};

/** Default currency presentation, kept as one place to change. */
export const DEFAULT_CURRENCY = { symbol: "¥", code: "CNY", perUsd: 1 };

/**
 * Chinese public holidays are billed at the off-peak rate for the whole day,
 * even though they are weekdays.
 *
 * The list cannot be derived — it is a State Council announcement published each
 * November for the following year — so it is data, and it goes stale. An unknown
 * holiday is priced at peak, which overstates rather than understates the bill.
 * The `offPeakHolidays` config field replaces this list.
 */
export const DEFAULT_OFF_PEAK_HOLIDAYS = [
	"2026-01-01", "2026-01-02", "2026-01-03",
	"2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
	"2026-04-04", "2026-04-05", "2026-04-06",
	"2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
	"2026-06-19", "2026-06-20", "2026-06-21",
	"2026-09-25", "2026-09-26", "2026-09-27",
	"2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07",
];

/** Default off-peak multiplier: DeepSeek's off-peak rates are half of peak. */
export const DEFAULT_OFF_PEAK_MULTIPLIER = 0.5;

/**
 * When a model's price follows the peak/off-peak window, if `peakPricing` is not
 * set explicitly.
 *
 * The window is a **DeepSeek billing rule**, not a property of counting tokens:
 * DeepSeek publishes a peak list price and a cheaper off-peak one, while every
 * other provider here quotes a single flat price. Applying the halving to a flat
 * price is not a rounding detail — it understates that route's bill by half and
 * makes the panel claim "非高峰 ×0.5" for a model that has no off-peak price at
 * all (`our-free-model/mimo-v2.6-flash-free` on this machine was exactly that).
 *
 * So the default is derived from the key the price is filed under: a key naming
 * DeepSeek gets the window, every other key is flat. A deployment whose
 * DeepSeek route is named differently, or a reseller that bills flat, says so
 * per model with `peakPricing: true|false`.
 */
const OFF_PEAK_PRICE_KEY = /deepseek/i;

/**
 * Whether one rate key follows the peak/off-peak window by default.
 *
 * @param {string} key - `<provider>/<model>`.
 * @returns {boolean} true when the peak/off-peak window applies.
 */
export function defaultPeakPricing(key) {
	return OFF_PEAK_PRICE_KEY.test(String(key ?? ""));
}

/** Fields the rate schema accepts per model entry. */
const RATE_FIELDS = new Set([
	"label",
	"input",
	"cacheRead",
	"cacheWrite",
	"output",
	"peakPricing",
	"offPeakMultiplier",
	"inputOffPeak",
	"cacheReadOffPeak",
	"cacheWriteOffPeak",
	"outputOffPeak",
]);

const RATE_NUMBERS = [
	"input",
	"cacheRead",
	"cacheWrite",
	"output",
	"offPeakMultiplier",
	"inputOffPeak",
	"cacheReadOffPeak",
	"cacheWriteOffPeak",
	"outputOffPeak",
];

/**
 * Require a finite, non-negative number.
 *
 * @param {unknown} value - candidate.
 * @param {string} where - label used in the thrown message.
 * @returns {number} the validated number.
 */
function requireNonNegative(value, where) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${where} must be a finite number >= 0; received ${JSON.stringify(value)}`);
	}
	return value;
}

/**
 * Parse one model's rate entry, applying the input rate to any omitted cache
 * bucket and dropping unknown keys instead of letting a typo silently become an
 * unpriced bucket.
 *
 * @param {string} key - `<provider>/<model>` for messages.
 * @param {unknown} raw - the entry as configured.
 * @returns {object} normalized rates.
 */
function parseModelRates(key, raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`rates["${key}"] must be an object`);
	}
	for (const field of Object.keys(raw)) {
		if (!RATE_FIELDS.has(field)) {
			throw new Error(`rates["${key}"].${field} is not a known field (known: ${[...RATE_FIELDS].join(", ")})`);
		}
	}
	const input = requireNonNegative(raw.input, `rates["${key}"].input`);
	const rates = {
		...(typeof raw.label === "string" && raw.label.length > 0 ? { label: raw.label } : {}),
		input,
		cacheRead: raw.cacheRead === undefined ? input : requireNonNegative(raw.cacheRead, `rates["${key}"].cacheRead`),
		// A cache write is billed as an ordinary input token unless a deployment pins a price.
		cacheWrite: raw.cacheWrite === undefined ? input : requireNonNegative(raw.cacheWrite, `rates["${key}"].cacheWrite`),
		output: requireNonNegative(raw.output, `rates["${key}"].output`),
	};
	for (const field of ["offPeakMultiplier", "inputOffPeak", "cacheReadOffPeak", "cacheWriteOffPeak", "outputOffPeak"]) {
		if (raw[field] !== undefined) rates[field] = requireNonNegative(raw[field], `rates["${key}"].${field}`);
	}
	// Resolved once here so both halves price identically and the panel does not
	// have to re-derive the rule from the key name.
	if (raw.peakPricing !== undefined && typeof raw.peakPricing !== "boolean") {
		throw new Error(`rates["${key}"].peakPricing must be true or false; received ${JSON.stringify(raw.peakPricing)}`);
	}
	rates.peakPricing = raw.peakPricing === undefined ? defaultPeakPricing(key) : raw.peakPricing;
	return rates;
}

/**
 * Read a volatile config value: Cordis hands a `.volatile()` field to the plugin
 * as a ref with `.get()`, while plain values (defaults, tests, non-volatile
 * rows) arrive as themselves.
 *
 * @param {object} config - the row config.
 * @param {string} field - field name.
 * @returns {*} the live value.
 */
export function readConfig(config, field) {
	const value = config?.[field];
	return value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
}

/**
 * Parse the `rates` config value (a JSON object or its string form).
 *
 * @param {unknown} value - configured value.
 * @param {string} where - label used in thrown messages.
 * @returns {Record<string, object>} normalized, provider-qualified rate table.
 */
export function parseRateTable(value, where = "rates") {
	if (value === null || value === undefined || value === "") {
		throw new Error(`${where} is empty; provide a JSON object of model rates`);
	}
	let parsed = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch (error) {
			throw new Error(`${where} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${where} must be a JSON object keyed "<provider>/<model>"`);
	}
	const table = {};
	for (const [key, raw] of Object.entries(parsed)) {
		if (!key.includes("/")) {
			throw new Error(`${where} key "${key}" must be "<provider>/<model>"`);
		}
		table[key] = parseModelRates(key, raw);
	}
	if (Object.keys(table).length === 0) throw new Error(`${where} declares no models`);
	return table;
}

/**
 * Normalize the `offPeakHolidays` config field: a comma/newline separated string
 * or an array of `YYYY-MM-DD` dates that are off-peak for the whole day.
 *
 * @param {unknown} raw - the config value.
 * @returns {string[]} the validated dates.
 */
function parseHolidays(raw) {
	if (raw === undefined || raw === null || raw === "") return [...DEFAULT_OFF_PEAK_HOLIDAYS];
	const list = Array.isArray(raw) ? raw : String(raw).split(/[\s,;]+/u);
	const holidays = [];
	for (const item of list) {
		const date = String(item).trim();
		if (date === "") continue;
		if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error(`offPeakHolidays entry ${JSON.stringify(date)} is not a YYYY-MM-DD date`);
		holidays.push(date);
	}
	return holidays;
}

/**
 * Validate the whole rate-related config once, at mount, so a typo fails loudly
 * in the loader log instead of silently pricing everything as unknown.
 *
 * @param {object} config - the row config.
 * @returns {{rates: Record<string, object>, currency: object, offPeakMultiplier: number, offPeakTimezone: string, offPeakHolidays: string[]}} normalized config.
 */
export function parseConfig(config) {
	const rawCurrency = readConfig(config, "currency");
	let currency = DEFAULT_CURRENCY;
	if (rawCurrency !== undefined && rawCurrency !== null && rawCurrency !== "") {
		let parsed = rawCurrency;
		if (typeof rawCurrency === "string") {
			try {
				parsed = JSON.parse(rawCurrency);
			} catch (error) {
				throw new Error(`currency is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("currency must be a JSON object like {\"symbol\":\"¥\",\"code\":\"CNY\",\"perUsd\":1}");
		}
		const perUsd = parsed.perUsd === undefined ? 1 : requireNonNegative(parsed.perUsd, "currency.perUsd");
		if (perUsd === 0) throw new Error("currency.perUsd must be greater than 0");
		currency = {
			symbol: typeof parsed.symbol === "string" && parsed.symbol.length > 0 ? parsed.symbol : DEFAULT_CURRENCY.symbol,
			code: typeof parsed.code === "string" && parsed.code.length > 0 ? parsed.code : DEFAULT_CURRENCY.code,
			perUsd,
		};
	}
	const multiplier = readConfig(config, "offPeakMultiplier");
	const timezone = readConfig(config, "offPeakTimezone");
	return {
		rates: parseRateTable(readConfig(config, "rates")),
		currency,
		offPeakMultiplier: multiplier === undefined || multiplier === null
			? DEFAULT_OFF_PEAK_MULTIPLIER
			: requireNonNegative(Number(multiplier), "offPeakMultiplier"),
		offPeakTimezone: typeof timezone === "string" && timezone.length > 0 ? timezone : "UTC",
		offPeakHolidays: parseHolidays(readConfig(config, "offPeakHolidays")),
	};
}

/**
 * Resolve the rate entry for one route.
 *
 * Exact `<provider>/<model>` wins. Otherwise a unique bare-model match is used,
 * so a `"deepseek-flash"` entry applies to every provider that serves it; when
 * two providers both declare that model the lookup refuses to guess.
 *
 * @param {Record<string, object>} table - parsed rate table.
 * @param {string} provider - route provider.
 * @param {string} model - route model.
 * @returns {{key: string, rates: object} | {key: string, rates: undefined, ambiguous: string[]}} resolution.
 */
export function resolveRates(table, provider, model) {
	if (typeof model !== "string" || model.length === 0) return { key: "", rates: undefined, ambiguous: [] };
	const exact = `${provider ?? ""}/${model}`;
	if (Object.hasOwn(table, exact)) return { key: exact, rates: table[exact] };
	const candidates = Object.keys(table).filter((key) => key.slice(key.indexOf("/") + 1) === model);
	if (candidates.length === 1) return { key: candidates[0], rates: table[candidates[0]] };
	if (candidates.length > 1) return { key: exact, rates: undefined, ambiguous: candidates };
	return { key: exact, rates: undefined, ambiguous: [] };
}

/**
 * Resolve a wall-clock timestamp to a civil weekday and hour in one timezone.
 *
 * @param {number} timeMs - epoch milliseconds.
 * @param {string} timezone - IANA zone id (`UTC` needs no database).
 * @returns {{weekday: number, hour: number}} 0 = Sunday … 6 = Saturday.
 */
export function civilTime(timeMs, timezone) {
	const date = new Date(timeMs);
	if (timezone === "UTC" || timezone === "") {
		return { weekday: date.getUTCDay(), hour: date.getUTCHours(), date: date.toISOString().slice(0, 10) };
	}
	let formatted;
	try {
		formatted = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			weekday: "short",
			hour: "2-digit",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour12: false,
		}).formatToParts(date);
	} catch (error) {
		throw new Error(`offPeakTimezone "${timezone}" is not a usable IANA time zone: ${error instanceof Error ? error.message : String(error)}`);
	}
	const parts = Object.fromEntries(formatted.map((part) => [part.type, part.value]));
	const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
	// `hour12: false` renders midnight as "24" in some ICU versions; both mean 0.
	const hour = Number(parts.hour) % 24;
	if (weekday < 0 || !Number.isFinite(hour)) {
		throw new Error(`could not resolve civil time in "${timezone}" from ${JSON.stringify(formatted)}`);
	}
	return { weekday, hour, date: `${parts.year}-${parts.month}-${parts.day}` };
}

/**
 * Whether one instant falls in DeepSeek's peak window: 01:00–04:00 and
 * 06:00–10:00 UTC, Monday through Friday, excluding Chinese public holidays
 * (which are off-peak for the whole day).
 *
 * The window is a rule; the holidays are a calendar, so they come in as data.
 * A weekday holiday missing from that list is priced at peak, which overstates
 * the bill rather than understating it.
 *
 * @param {number} timeMs - epoch milliseconds.
 * @param {string} timezone - IANA zone id the window is expressed in.
 * @param {Iterable<string>} [holidays] - `YYYY-MM-DD` dates that are off-peak all day.
 * @returns {boolean} true when the peak price applies.
 */
export function isPeak(timeMs, timezone = "UTC", holidays) {
	const { weekday, hour, date } = civilTime(timeMs, timezone);
	if (weekday === 0 || weekday === 6) return false;
	if (holidays !== undefined && holidays !== null) {
		for (const holiday of holidays) {
			if (holiday === date) return false;
		}
	}
	return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/**
 * The per-bucket price for one instant, before token multiplication.
 *
 * `overrides` (explicit `*OffPeak` figures) win over the multiplier, and a
 * per-model `offPeakMultiplier` wins over the deployment-wide one.
 *
 * @param {object} rates - one model's normalized rates.
 * @param {boolean} peak - whether the peak price applies.
 * @param {number} fallbackMultiplier - deployment-wide off-peak multiplier.
 * @returns {{input: number, cacheRead: number, cacheWrite: number, output: number, multiplier: number}} prices per 1M tokens.
 */
export function bucketPrices(rates, peak, fallbackMultiplier) {
	const multiplier = rates.offPeakMultiplier ?? fallbackMultiplier;
	if (peak) {
		return { input: rates.input, cacheRead: rates.cacheRead, cacheWrite: rates.cacheWrite, output: rates.output, multiplier: 1 };
	}
	return {
		input: rates.inputOffPeak ?? rates.input * multiplier,
		cacheRead: rates.cacheReadOffPeak ?? rates.cacheRead * multiplier,
		cacheWrite: rates.cacheWriteOffPeak ?? rates.cacheWrite * multiplier,
		output: rates.outputOffPeak ?? rates.output * multiplier,
		multiplier,
	};
}

/**
 * Price one set of token buckets under one route and instant.
 *
 * @param {object} input - costing input.
 * @param {Record<string, number>} input.tokens - bucket totals.
 * @param {object} input.rates - the route's normalized rates.
 * @param {number} input.timeMs - representative instant for peak/off-peak.
 * @param {string} input.timezone - IANA zone id.
 * @param {number} input.offPeakMultiplier - deployment-wide off-peak multiplier.
 * @param {Iterable<string>} [input.holidays] - dates that are off-peak for the whole day.
 * @returns {{microUsd: number, usd: number, peak: boolean, windowed: boolean, prices: object, buckets: Record<string, {tokens: number, pricePerMillion: number, microUsd: number}>}} the priced result. `windowed` is false for a flat-price route, where `peak` is true only in the sense that the stored price is the one charged all day.
 */
export function priceBuckets({ tokens, rates, timeMs, timezone, offPeakMultiplier, holidays }) {
	// A route with no peak/off-peak list (`peakPricing: false`) is charged its one
	// stored price at every instant. Pricing it off-peak would halve a bill that
	// was never discounted, so the window is skipped rather than applied.
	const windowed = rates.peakPricing !== false;
	const peak = windowed ? isPeak(timeMs, timezone, holidays) : true;
	const prices = bucketPrices(rates, peak, offPeakMultiplier);
	const priced = {};
	let microUsd = 0;
	for (const bucket of BUCKETS) {
		const pricePerMillion = prices[BUCKET_PRICE_FIELD[bucket]];
		const count = Math.max(0, Math.trunc(Number(tokens?.[bucket] ?? 0)));
		// Round each bucket once (a bucket is the granularity that was billed), so
		// the per-row figures a reader adds up equal the total shown.
		const bucketMicro = Math.round((count * pricePerMillion * MICRO_USD) / 1_000_000);
		priced[bucket] = { tokens: count, pricePerMillion, microUsd: bucketMicro };
		microUsd += bucketMicro;
	}
	return { microUsd, usd: microUsd / MICRO_USD, peak, windowed, prices, buckets: priced };
}

/**
 * Convert micro-USD into the display currency and format it.
 *
 * Digits are chosen so a sub-cent total still shows its first significant
 * digit: `$0.0123` for a fraction of a cent, `$1.5000` for a dollar figure.
 *
 * @param {number} microUsd - integer micro-USD.
 * @param {object} currency - `{symbol, code, perUsd}`.
 * @param {number} [decimals] - fraction digits; defaults to enough to show a non-zero figure.
 * @returns {string} e.g. `$0.0123`.
 */
export function formatMoney(microUsd, currency, decimals) {
	const usd = microUsd / MICRO_USD;
	const amount = usd * (currency?.perUsd ?? 1);
	let digits = decimals;
	if (digits === undefined) {
		if (amount === 0) digits = 2;
		else if (Math.abs(amount) >= 1) digits = 4;
		else digits = Math.min(8, Math.max(2, -Math.floor(Math.log10(Math.abs(amount))) + 2));
	}
	return `${currency?.symbol ?? "$"}${amount.toFixed(digits)}`;
}

/**
 * Format a token count compactly for a pill (`12.3k`, `1.2M`).
 *
 * @param {number} tokens - integer token count.
 * @returns {string} compact text.
 */
export function formatTokens(tokens) {
	const value = Number(tokens ?? 0);
	if (!Number.isFinite(value)) return "0";
	const abs = Math.abs(value);
	if (abs < 1000) return String(Math.round(value));
	if (abs < 1_000_000) return `${(value / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(abs < 10_000_000 ? 2 : 1)}M`;
}
