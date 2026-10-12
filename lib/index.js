/**
 * `@local/dsh-session-cost` — what one conversation actually consumed.
 *
 * Two model-facing tools read the durable session log (in memory for a live
 * session, from disk for a stored one) and price each model call at its own
 * route's rates:
 *
 * - `session_cost` — one conversation, whole or by trailing turn count.
 * - `list_session_costs` — every conversation on this machine, one line each.
 *
 * The same module registers a small read-only Fetch route the browser half uses
 * to read the live rate table and to ask for a server-side verification of what
 * the page has already computed.
 *
 * DSH itself has no monetary pricing (`dsh-token-meter` prices images only, and
 * `tokenUsage` is a token-count projection), so rates are this plugin's own
 * configuration. They are validated at mount so a typo fails loudly instead of
 * silently pricing a conversation at zero.
 *
 * @module @local/dsh-session-cost
 */

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DEFAULT_CURRENCY, DEFAULT_RATES, MICRO_USD, formatMoney, formatTokens, parseConfig, readConfig } from "./rates.js";
import {
	BUCKET_LABELS,
	listStoredCosts,
	renderFamily,
	renderListing,
	renderReport,
	reportFamily,
	reportLiveSession,
	reportStoredSession,
	resolveHome,
} from "./report.js";

/** Cordis plugin name used by loader diagnostics. */
const name = "session-cost";

/** The tool registry is the only hard dependency; the connection is optional. */
const inject = ["tools"];

/** Route the browser half reads the live rate table from. */
export const CONFIG_PATH = "/api/session-cost/config";
/** Route the browser half posts a verification request to. */
export const VERIFY_PATH = "/api/session-cost/verify";
/** Route the browser half asks for a conversation's delegated sessions on. */
export const FAMILY_PATH = "/api/session-cost/family";

/** How long one cost query may take. Disk decoding dominates; a big log is still well under this. */
const TOOL_TIMEOUT_MS = 120_000;

/**
 * Row configuration.
 *
 * `rates` is one JSON object rather than a dozen volatile fields, because a
 * deployment prices several models and DSH's generated settings form renders
 * each field as a separate control. Every field is `.volatile()` and read
 * through `readConfig` at call time, so a Plugins-page edit applies to the next
 * call without remounting the row.
 */
const Config = z.object({
	rates: z.string().default(JSON.stringify(DEFAULT_RATES, null, 2)).volatile(),
	currency: z.string().default(JSON.stringify(DEFAULT_CURRENCY)).volatile(),
	offPeakMultiplier: z.number().default(0.5).volatile(),
	offPeakTimezone: z.string().default("UTC").volatile(),
	// A calendar, not a rule: a weekday holiday is off-peak for the whole day, and
	// the list is republished each year, so it is configurable data. Empty means
	// "use the built-in list"; a stale list overstates the bill at peak rates.
	offPeakHolidays: z.string().default("").volatile(),
	dshHome: z.string().default("").volatile(),
});

/**
 * The normalized pricing configuration, parsed once per call.
 *
 * @param {object} config - the row config.
 * @returns {object} normalized config (rates, currency, multiplier, timezone).
 */
function pricing(config) {
	return parseConfig(config);
}

/** Resolve this deployment's DSH home. */
function home(config) {
	return resolveHome(readConfig(config, "dshHome"));
}

/**
 * The live session the calling tool executes inside, when there is one.
 *
 * @param {object} exec - tool execution context.
 * @returns {object|undefined} a live session.
 */
function callerSession(exec) {
	return exec?.agent?.session ?? undefined;
}

/** One JSON response for a Fetch route. */
function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

/**
 * Answer one `/api/session-cost/config` request: the live rate table the page
 * prices with. Never throws upward — a broken config is reported as an error
 * payload the page can show.
 *
 * @param {object} config - row config.
 * @returns {Response} JSON.
 */
function answerConfig(config) {
	try {
		const normalized = pricing(config);
		return jsonResponse({
			ok: true,
			revision: rateRevision(config),
			rates: normalized.rates,
			currency: normalized.currency,
			offPeakMultiplier: normalized.offPeakMultiplier,
			offPeakTimezone: normalized.offPeakTimezone,
			// The page mirrors the Host's peak/off-peak decision, so it needs the
			// same holiday calendar or its peak badge would disagree with the bill.
			offPeakHolidays: normalized.offPeakHolidays,
			dshHome: home(config),
		});
	} catch (error) {
		return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}

/**
 * A cheap revision for the rate table, so the page can skip re-rendering when
 * nothing changed. Derived from the raw configured value rather than a counter,
 * because the config can also change through a profile file edit.
 *
 * @param {object} config - row config.
 * @returns {string} revision string.
 */
function rateRevision(config) {
	const raw = [
		String(readConfig(config, "rates") ?? ""),
		String(readConfig(config, "currency") ?? ""),
		String(readConfig(config, "offPeakMultiplier") ?? ""),
		String(readConfig(config, "offPeakTimezone") ?? ""),
	].join("\u0000");
	let hash = 0;
	for (let index = 0; index < raw.length; index += 1) {
		// oxlint-disable-next-line no-bitwise -- a 32-bit string hash
		hash = (Math.imul(hash, 31) + raw.charCodeAt(index)) | 0;
	}
	return `${hash.toString(36)}-${raw.length.toString(36)}`;
}

/**
 * Answer one family request: the page asks which sessions this conversation
 * delegated to and what they spent.
 *
 * The page cannot answer this itself — a projection carries only the current
 * session's totals, and the family lives in other logs — so this reads the
 * durable `parentSession` chain and prices it with the same code the tool uses.
 *
 * @param {Request} request - the buffered Request.
 * @param {object} config - row config.
 * @returns {Promise<Response>} JSON.
 */
async function answerFamily(request, config) {
	let payload = {};
	try {
		const parsed = await request.json();
		if (parsed !== null && typeof parsed === "object") payload = parsed;
	} catch {
		return jsonResponse({ ok: false, error: "request body is not JSON" }, 400);
	}
	let normalized;
	try {
		normalized = pricing(config);
	} catch (error) {
		return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
	}
	const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
	if (sessionId.length === 0) return jsonResponse({ ok: false, error: "sessionId is required" }, 400);
	try {
		const outcome = await reportFamily({
			home: home(config),
			sessionId,
			rates: normalized.rates,
			currency: normalized.currency,
			timezone: normalized.offPeakTimezone,
			offPeakMultiplier: normalized.offPeakMultiplier,
			holidays: normalized.offPeakHolidays,
			fresh: payload.fresh === true,
		});
		if (outcome.kind !== "found") {
			return jsonResponse({ ok: false, kind: outcome.kind, error: "找不到这个会话" });
		}
		return jsonResponse({
			ok: true,
			sessionId: outcome.self.session.id,
			self: {
				tokens: outcome.self.totals.tokens,
				microUsd: outcome.self.totals.microUsd,
				usd: outcome.self.totals.usd,
				display: formatMoney(outcome.self.totals.microUsd, normalized.currency),
				attempts: outcome.self.attempts,
			},
			descendants: outcome.descendants.slice(0, 50).map((child) => ({
				sessionId: child.sessionId,
				depth: child.depth,
				origin: child.origin,
				tokens: child.tokens,
				usd: child.microUsd / MICRO_USD,
				display: child.priced ? formatMoney(child.microUsd, normalized.currency) : undefined,
				priced: child.priced,
			})),
			descendantCount: outcome.descendants.length,
			missingParents: outcome.missingParents,
			failures: outcome.failures,
			total: {
				tokens: outcome.totals.tokens,
				microUsd: outcome.totals.microUsd,
				usd: outcome.totals.usd,
				display: formatMoney(outcome.totals.microUsd, normalized.currency),
				descendantTokens: outcome.totals.descendantTokens,
				// In base currency units: the page adds this to the live session's own
				// figure, which it holds as micro-USD, so a display string would not do.
				descendantMicroUsd: outcome.totals.descendantMicroUsd,
				descendantUsd: outcome.totals.descendantUsd,
				descendantDisplay: formatMoney(outcome.totals.descendantMicroUsd, normalized.currency),
			},
			text: renderFamily(outcome, normalized.currency),
		});
	} catch (error) {
		return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}

/**
 * Answer one verification request: the page sends the figures it computed and
 * the Host recomputes the same conversation from the durable log, so a UI
 * number can be checked against the source it claims to summarize.
 *
 * @param {Request} request - the buffered Request.
 * @param {object} config - row config.
 * @returns {Promise<Response>} JSON.
 */
async function answerVerify(request, config) {
	let payload = {};
	try {
		const parsed = await request.json();
		if (parsed !== null && typeof parsed === "object") payload = parsed;
	} catch {
		return jsonResponse({ ok: false, error: "request body is not JSON" }, 400);
	}
	let normalized;
	try {
		normalized = pricing(config);
	} catch (error) {
		return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
	}
	const target = typeof payload.target === "string" ? payload.target : "";
	const turns = Number.isFinite(payload.turns) ? payload.turns : undefined;
	const steps = Number.isFinite(payload.steps) ? payload.steps : undefined;
	try {
		const outcome = await reportStoredSession({
			home: home(config),
			sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
			target,
			rates: normalized.rates,
			currency: normalized.currency,
			timezone: normalized.offPeakTimezone,
			offPeakMultiplier: normalized.offPeakMultiplier,
			holidays: normalized.offPeakHolidays,
			turns,
			steps,
		});
		if (outcome.kind !== "found") {
			return jsonResponse({
				ok: false,
				kind: outcome.kind,
				error: outcome.kind === "ambiguous" ? "目标不唯一" : "找不到这个会话",
				candidates: outcome.candidates,
				known: outcome.known,
			});
		}
		const report = outcome.report;
		return jsonResponse({
			ok: true,
			sessionId: report.session.id,
			title: report.session.title,
			source: report.source,
			attempts: report.attempts,
			events: report.events,
			tokens: report.totals.tokens,
			buckets: {
				uncachedInputTokens: report.totals.uncachedInputTokens,
				cacheReadTokens: report.totals.cacheReadTokens,
				cacheWriteTokens: report.totals.cacheWriteTokens,
				outputTokens: report.totals.outputTokens,
			},
			microUsd: report.totals.microUsd,
			usd: report.totals.usd,
			display: formatMoney(report.totals.microUsd, normalized.currency),
			priced: report.priced,
			unpriced: report.unpriced,
			routes: report.routes.map((route) => ({
				provider: route.provider,
				model: route.model,
				label: route.label,
				attempts: route.attempts,
				tokens: route.tokens,
				microUsd: route.microUsd,
				display: route.priced ? formatMoney(route.microUsd, normalized.currency) : undefined,
				priced: route.priced,
			})),
			text: renderReport(report, normalized.currency, { detail: payload.detail === true }),
		});
	} catch (error) {
		return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}

/**
 * Register the cost tools and the browser-facing routes.
 *
 * @param {object} ctx - the Cordis context providing `ctx.tools`.
 * @param {object} config - the resolved row configuration.
 */
function apply(ctx, config) {
	// Mount-time validation: a bad rate table or time zone must fail in the
	// loader log, not on the first user question.
	const initial = pricing(config);
	const windowed = Object.values(initial.rates).filter((rates) => rates.peakPricing !== false).length;
	ctx.logger?.info?.(
		`[session-cost] loaded: ${Object.keys(initial.rates).length} priced model(s) (${windowed} on a peak/off-peak window, ${Object.keys(initial.rates).length - windowed} flat), currency ${initial.currency.code}, off-peak ×${initial.offPeakMultiplier} (${initial.offPeakTimezone})`,
	);

	ctx.tools.register(defineTool({
		name: "session_cost",
		description: [
			"Report how many tokens a conversation consumed and what it cost, in money, using the deployment's configured per-model rates.",
			"Prices each model call at its own provider/model rate, so a conversation that switched models is billed per model rather than at one blended rate.",
			"Reads the durable session log: the live conversation from memory, or a stored one from disk by session id, id prefix, or title fragment.",
			"Use it to answer \"how much did this conversation cost\" or \"what did the last 3 turns cost\".",
			"Amounts are an estimate: rates come from the plugin's configuration. A model whose price list has a peak/off-peak window (DeepSeek's, and anything with peakPricing:true) is charged the peak price in the peak hours and the off-peak price otherwise; every other model is charged one flat price all day.",
		].join(" "),
		parameters: {
			session: {
				type: "string",
				description: "Session id, id prefix, or title fragment of a stored conversation. Omit to report the current conversation.",
			},
			turns: {
				type: "number",
				description: "Limit the report to the last N turns instead of the whole conversation.",
			},
			steps: {
				type: "number",
				description: "Limit the report to the last N model calls. A long conversation is often a single turn with hundreds of steps, so this is usually the scope you want for \"recent cost\".",
			},
			detail: {
				type: "boolean",
				description: "Include a per-model, per-bucket price table.",
			},
			includeDescendants: {
				type: "boolean",
				description: "Also count the sessions this conversation delegated to (subagents, workflow agents, teammates). They are separate sessions with separate bills, so a whole-conversation total must include them; the report then shows self / descendants / total separately.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: { type: "string", required: true, description: "The human-readable report." },
					sessionId: { type: "string", description: "The conversation the report describes." },
					title: { type: "string", description: "The conversation's title, when known." },
					source: { type: "string", description: "`live` (host memory) or `stored` (disk log)." },
					attempts: { type: "number", description: "Model calls counted." },
					tokens: { type: "number", description: "Total billed tokens." },
					uncachedInputTokens: { type: "number" },
					cacheReadTokens: { type: "number" },
					cacheWriteTokens: { type: "number" },
					outputTokens: { type: "number" },
					usd: { type: "number", description: "Cost in USD." },
					amount: { type: "number", description: "Cost in the configured display currency." },
					amountText: { type: "string", description: "Cost formatted in the display currency." },
					pricedModels: {
						type: "array",
						items: { type: "string" },
						description: "The provider/model routes that were priced.",
					},
					unpricedModels: {
						type: "array",
						items: { type: "string" },
						description: "Routes with no configured rate; their tokens are counted but not priced.",
					},
					selfTokens: { type: "number", description: "With includeDescendants: the session's own tokens." },
					selfUsd: { type: "number", description: "With includeDescendants: the session's own cost." },
					descendantCount: { type: "number", description: "With includeDescendants: how many delegated sessions were counted." },
					descendantTokens: { type: "number", description: "With includeDescendants: tokens spent by those sessions." },
					descendantUsd: { type: "number", description: "With includeDescendants: their combined cost." },
					missingParents: {
						type: "array",
						items: { type: "string" },
						description: "Delegated sessions whose own log is missing, so their descendants cannot be found.",
					},
				},
			},
			render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
		},
		timeoutMs: TOOL_TIMEOUT_MS,
		async execute(args, exec) {
			const normalized = pricing(config);
			const turns = Number.isFinite(args.turns) && args.turns > 0 ? Math.trunc(args.turns) : undefined;
			const steps = Number.isFinite(args.steps) && args.steps > 0 ? Math.trunc(args.steps) : undefined;
			const target = typeof args.session === "string" ? args.session.trim() : "";
			const detail = args.detail === true;
			const includeDescendants = args.includeDescendants === true;
			const session = callerSession(exec);
			const live = target === "" ? session : undefined;
			let report;
			let family;
			let sessionId;
			let title;
			if (live !== undefined) {
				report = reportLiveSession({
					session: live,
					rates: normalized.rates,
					currency: normalized.currency,
					timezone: normalized.offPeakTimezone,
					offPeakMultiplier: normalized.offPeakMultiplier,
			holidays: normalized.offPeakHolidays,
					turns,
					steps,
				});
				sessionId = report.session.id;
			} else {
				const outcome = await reportStoredSession({
					home: home(config),
					sessionId: target === "" ? (session?.header?.id ?? session?.id) : undefined,
					target: target === "" ? undefined : target,
					rates: normalized.rates,
					currency: normalized.currency,
					timezone: normalized.offPeakTimezone,
					offPeakMultiplier: normalized.offPeakMultiplier,
			holidays: normalized.offPeakHolidays,
					turns,
					steps,
				});
				if (outcome.kind === "ambiguous") {
					throw new Error(`"${target}" matches ${outcome.candidates.length} conversations; use a full session id:\n${outcome.candidates.map((row) => `  ${row.sessionId}  ${row.title ?? ""}`).join("\n")}`);
				}
				if (outcome.kind !== "found") {
					throw new Error(`no conversation matches "${target}"${outcome.kind === "refused" ? ` (${outcome.reason})` : ""}; known conversations:\n${(outcome.known ?? []).slice(0, 20).map((row) => `  ${row.sessionId}  ${row.title ?? ""}`).join("\n")}`);
				}
				report = outcome.report;
				sessionId = report.session.id;
				title = report.session.title;
			}
			if (includeDescendants && sessionId !== undefined) {
				// The rollup reads the family from disk; a live session's own number
				// still comes from memory, so the two halves stay exact.
				family = await reportFamily({
					home: home(config),
					sessionId,
					rates: normalized.rates,
					currency: normalized.currency,
					timezone: normalized.offPeakTimezone,
					offPeakMultiplier: normalized.offPeakMultiplier,
			holidays: normalized.offPeakHolidays,
					turns,
					steps,
				});
			}
			if (family !== undefined && family.kind === "found") {
				const { totals } = family;
				return {
					text: renderFamily(family, normalized.currency),
					...(sessionId === undefined ? {} : { sessionId }),
					...(title === undefined || title === "" ? {} : { title }),
					source: "family",
					attempts: report.attempts,
					tokens: totals.tokens,
					uncachedInputTokens: report.totals.uncachedInputTokens,
					cacheReadTokens: report.totals.cacheReadTokens,
					cacheWriteTokens: report.totals.cacheWriteTokens,
					outputTokens: report.totals.outputTokens,
					usd: totals.usd,
					amount: totals.usd * normalized.currency.perUsd,
					amountText: formatMoney(totals.microUsd, normalized.currency),
					selfTokens: report.totals.tokens,
					selfUsd: report.totals.usd,
					descendantCount: totals.descendantCount,
					descendantTokens: totals.descendantTokens,
					descendantUsd: totals.descendantUsd,
					missingParents: family.missingParents,
					pricedModels: report.routes.filter((route) => route.priced).map((route) => `${route.provider}/${route.model}`),
					unpricedModels: totals.unpriced,
				};
			}
			const amount = report.totals.usd * normalized.currency.perUsd;
			return {
				text: renderReport(report, normalized.currency, { detail }),
				...(sessionId === undefined ? {} : { sessionId }),
				...(title === undefined || title === "" ? {} : { title }),
				source: report.source,
				attempts: report.attempts,
				tokens: report.totals.tokens,
				uncachedInputTokens: report.totals.uncachedInputTokens,
				cacheReadTokens: report.totals.cacheReadTokens,
				cacheWriteTokens: report.totals.cacheWriteTokens,
				outputTokens: report.totals.outputTokens,
				usd: report.totals.usd,
				amount,
				amountText: formatMoney(report.totals.microUsd, normalized.currency),
				pricedModels: report.routes.filter((route) => route.priced).map((route) => `${route.provider}/${route.model}`),
				unpricedModels: report.unpriced,
			};
		},
	}));

	ctx.tools.register(defineTool({
		name: "list_session_costs",
		description: [
			"List every conversation stored on this machine with its token total and cost, most recently active first.",
			"Use it to find the most expensive conversations or to locate the session id that `session_cost` needs.",
			"Amounts are estimates from the plugin's configured rates; conversations whose model has no configured rate are listed with their tokens and counted as unpriced.",
		].join(" "),
		parameters: {
			limit: { type: "number", description: "Maximum rows to return (default 20)." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: { type: "string", required: true, description: "The listing." },
					count: { type: "number", description: "Rows returned." },
					totalTokens: { type: "number" },
					totalUsd: { type: "number" },
					totalAmount: { type: "number", description: "Total in the display currency." },
					rows: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								sessionId: { type: "string", required: true },
								title: { type: "string" },
								tokens: { type: "number", required: true },
								amount: { type: "number", required: true },
								usd: { type: "number", required: true },
								priced: { type: "boolean", required: true },
								archived: { type: "boolean" },
								models: { type: "array", items: { type: "string" } },
							},
						},
					},
				},
			},
			render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
		},
		timeoutMs: TOOL_TIMEOUT_MS,
		async execute(args) {
			const normalized = pricing(config);
			const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.trunc(args.limit) : 20;
			const listing = await listStoredCosts({
				home: home(config),
				rates: normalized.rates,
				currency: normalized.currency,
				timezone: normalized.offPeakTimezone,
				offPeakMultiplier: normalized.offPeakMultiplier,
			holidays: normalized.offPeakHolidays,
				limit,
			});
			const totalTokens = listing.rows.reduce((sum, row) => sum + row.tokens, 0);
			const totalMicroUsd = listing.rows.reduce((sum, row) => sum + row.microUsd, 0);
			const header = [
				`共 ${listing.rows.length} 个对话 · ${formatTokens(totalTokens)} token · 合计 ${formatMoney(totalMicroUsd, normalized.currency)}`,
				listing.rows.some((row) => !row.priced)
					? "（含未配置价格的模型，其 token 已计入、金额未计入）"
					: "",
			].filter((line) => line !== "").join("\n");
			return {
				text: `${header}\n${renderListing(listing, normalized.currency)}`,
				count: listing.rows.length,
				totalTokens,
				totalUsd: totalMicroUsd / 1_000_000,
				totalAmount: (totalMicroUsd / 1_000_000) * normalized.currency.perUsd,
				rows: listing.rows.map((row) => ({
					sessionId: row.sessionId,
					...(row.title === undefined || row.title === "" ? {} : { title: row.title }),
					tokens: row.tokens,
					amount: (row.microUsd / 1_000_000) * normalized.currency.perUsd,
					usd: row.microUsd / 1_000_000,
					priced: row.priced,
					archived: row.archived,
					models: row.routes,
				})),
			};
		},
	}));

	// The browser half needs the live rate table, and the key-free "verify this
	// page's number against the log" path. Both are read-only, so they ride the
	// connection's /api channel, which authenticates with the page's own session.
	// Optional injection keeps the row mountable on a Host with no browser
	// transport (CLI/TUI), where simply no route exists.
	ctx.inject(["connection"], (connectionCtx) => {
		connectionCtx.connection.fetch.register({
			path: CONFIG_PATH,
			methods: ["GET"],
			// `requestBody` is the connection's body READ mode, not "does this route
			// accept a body": it must be exactly `buffered` or `streaming`
			// (`ConnectionRequestBodyMode`). Any other value makes the shared handler
			// take its streaming branch and construct a GET Request with a stream
			// body, which the platform rejects — the page then sees HTTP 400 instead
			// of the rate table. A GET's buffered body is simply empty, and this
			// handler never reads it.
			requestBody: "buffered",
			fetch: () => Promise.resolve(answerConfig(config)),
		});
		connectionCtx.connection.fetch.register({
			path: VERIFY_PATH,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: (request) => answerVerify(request, config),
		});
		connectionCtx.connection.fetch.register({
			path: FAMILY_PATH,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: (request) => answerFamily(request, config),
		});
	});
}

export { Config, BUCKET_LABELS, apply, inject, name, rateRevision };

