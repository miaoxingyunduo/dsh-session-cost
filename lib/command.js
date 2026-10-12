/**
 * The `/cost` slash command: the zero-token surface for the same report the
 * `session_cost` tool returns.
 *
 * A command runs directly against the receiving agent — no model message, no
 * token cost — which makes it the right entry point for "what has this
 * conversation cost so far" while a turn is streaming.
 *
 * Mounted as its own Cordis row so the `commands` dependency stays separate
 * from the tools row: a composition with a command registry but no tool
 * registry still gets `/cost`, and vice versa.
 *
 * @module @local/dsh-session-cost/command
 */

import z from "@deepseek-ai/schemastery";
import { parseConfig, readConfig, formatMoney, DEFAULT_RATES, DEFAULT_CURRENCY } from "./rates.js";
import { listStoredCosts, renderFamily, renderListing, renderReport, reportFamily, reportLiveSession, reportStoredSession, resolveHome } from "./report.js";

/** Cordis plugin name used by loader diagnostics. */
const name = "command-session-cost";

/** The only service this row needs. */
const inject = ["commands"];

/** Row configuration; mirrors the tools row. */
const Config = z.object({
	rates: z.string().default(JSON.stringify(DEFAULT_RATES, null, 2)).volatile(),
	currency: z.string().default(JSON.stringify(DEFAULT_CURRENCY)).volatile(),
	offPeakMultiplier: z.number().default(0.5).volatile(),
	offPeakTimezone: z.string().default("UTC").volatile(),
	offPeakHolidays: z.string().default("").volatile(),
	dshHome: z.string().default("").volatile(),
});

const USAGE = [
	"用法:",
	"  /cost                    当前对话的总消耗（token + 金额）",
	"  /cost --family           再加上本对话派生出的子代理会话（subagent / workflow agent）",
	"  /cost --turns 3          只看最近 3 轮",
	"  /cost --steps 10         只看最近 10 次模型调用（长对话常用）",
	"  /cost --detail           附上按模型、按 token 类型的单价表",
	"  /cost --all [--limit 20] 列出本机所有对话的消耗",
	"  /cost <标题或ID>          查询另一个对话（会话日志仍在本机时）",
	"",
	"提示：一轮（turn）可能包含几百次模型调用，只想看「刚才花了多少」时用 --steps。",
	"      子代理是独立会话、独立计费，不加 --family 时不会算进本对话。",
].join("\n");

/**
 * Parse `/cost` input into a scope, a target, and flags.
 *
 * @param {string} raw - the raw command input.
 * @returns {{all: boolean, detail: boolean, family: boolean, turns?: number, steps?: number, limit?: number, target: string}} parsed input.
 */
export function parseCostInput(raw) {
	const text = typeof raw === "string" ? raw : "";
	const all = /(^|\s)--all(\s|$)/u.test(text);
	const detail = /(^|\s)--detail(\s|$)/u.test(text);
	const family = /(^|\s)--family(\s|$)/u.test(text);
	const number = (flag) => {
		const match = new RegExp(`(^|\\s)--${flag}[=\\s]+(\\S+)`, "u").exec(text);
		if (match === null) return undefined;
		const value = Number(match[2]);
		return Number.isFinite(value) && value > 0 ? value : undefined;
	};
	const turns = number("turns");
	const steps = number("steps");
	const limit = number("limit");
	const target = text
		.replace(/(^|\s)--(all|detail|family)(?=\s|$)/gu, " ")
		// A malformed value is still stripped, so it never becomes a target string.
		.replace(/(^|\s)--(turns|steps|limit)[=\s]+\S+/gu, " ")
		.trim();
	return {
		all,
		detail,
		family,
		...(turns === undefined ? {} : { turns }),
		...(steps === undefined ? {} : { steps }),
		...(limit === undefined ? {} : { limit }),
		target,
	};
}

/**
 * Register `/cost`.
 *
 * @param {object} ctx - the Cordis context providing `ctx.commands`.
 * @param {object} config - the resolved row configuration.
 */
function apply(ctx, config) {
	ctx.commands.register({
		name: "cost",
		description: "统计对话消耗的 token 与金额",
		input: { hint: "[标题或 session-id] [--turns N | --steps N] [--detail] [--all] [--limit N]" },
		async handler({ agent, rawInput }) {
			let normalized;
			try {
				normalized = parseConfig(config);
			} catch (error) {
				return { kind: "error", text: `价格配置有误：${error instanceof Error ? error.message : String(error)}\n\n${USAGE}` };
			}
			const parsed = parseCostInput(rawInput);
			const base = {
				rates: normalized.rates,
				currency: normalized.currency,
				timezone: normalized.offPeakTimezone,
				offPeakMultiplier: normalized.offPeakMultiplier,
				holidays: normalized.offPeakHolidays,
				turns: parsed.turns,
				steps: parsed.steps,
			};
			try {
				if (parsed.all) {
					const listing = await listStoredCosts({ home: home(config), ...base, limit: parsed.limit ?? 20 });
					const totalMicroUsd = listing.rows.reduce((sum, row) => sum + row.microUsd, 0);
					return {
						kind: "success",
						text: `合计 ${formatMoney(totalMicroUsd, normalized.currency)}\n${renderListing(listing, normalized.currency)}`,
					};
				}
				const session = agent?.session;
				const liveSessionId = session?.header?.id ?? session?.id;
				// `--family` needs the family's logs, so it always resolves through the
				// stored path; the session's own number still comes from memory when the
				// caller is looking at the live conversation.
				if (parsed.family) {
					const outcome = await reportFamily({
						home: home(config),
						sessionId: parsed.target === "" ? liveSessionId : undefined,
						target: parsed.target === "" ? undefined : parsed.target,
						...base,
					});
					if (outcome.kind === "ambiguous") {
						const lines = outcome.candidates.map((row) => `  ${row.sessionId}  ${row.title ?? ""}`);
						return { kind: "error", text: `「${parsed.target}」不唯一，请用完整 session id：\n${lines.join("\n")}` };
					}
					if (outcome.kind !== "found") {
						const lines = (outcome.known ?? []).slice(0, 20).map((row) => `  ${row.sessionId}  ${row.title ?? ""}`);
						return { kind: "error", text: `找不到匹配「${parsed.target}」的对话；已知对话：\n${lines.join("\n")}` };
					}
					// Prefer the in-memory figure for the session's own line, so a live
					// conversation is not reported from a slightly older log.
					if (parsed.target === "" && session !== undefined) {
						const live = reportLiveSession({ session, ...base });
						const descendantTokens = outcome.totals.descendantTokens;
						const descendantMicroUsd = outcome.totals.descendantMicroUsd;
						const microUsd = live.totals.microUsd + descendantMicroUsd;
						return {
							kind: "success",
							text: renderFamily(outcome, normalized.currency, {
								self: live,
								title: outcome.self.session?.title,
								totals: {
									...outcome.totals,
									tokens: live.totals.tokens + descendantTokens,
									microUsd,
									usd: microUsd / 1_000_000,
								},
							}),
						};
					}
					return { kind: "success", text: renderFamily(outcome, normalized.currency) };
				}
				if (parsed.target === "" && session !== undefined) {
					const report = reportLiveSession({ session, ...base });
					return { kind: "success", text: renderReport(report, normalized.currency, { detail: parsed.detail }) };
				}
				const outcome = await reportStoredSession({
					home: home(config),
					sessionId: parsed.target === "" ? (session?.header?.id ?? session?.id) : undefined,
					target: parsed.target === "" ? undefined : parsed.target,
					...base,
				});
				if (outcome.kind === "ambiguous") {
					const lines = outcome.candidates.map((row) => `  ${row.sessionId}  ${row.title ?? ""}`);
					return { kind: "error", text: `「${parsed.target}」不唯一，请用完整 session id：\n${lines.join("\n")}` };
				}
				if (outcome.kind !== "found") {
					const lines = (outcome.known ?? []).slice(0, 20).map((row) => `  ${row.sessionId}  ${row.title ?? ""}`);
					const reason = outcome.kind === "refused" ? `（${outcome.reason}）` : "";
					return { kind: "error", text: `找不到匹配「${parsed.target}」的对话${reason}\n已知对话：\n${lines.join("\n")}` };
				}
				return { kind: "success", text: renderReport(outcome.report, normalized.currency, { detail: parsed.detail }) };
			} catch (error) {
				return { kind: "error", text: `统计失败：${error instanceof Error ? error.message : String(error)}` };
			}
		},
	});
}

/** Resolve this deployment's DSH home. */
function home(config) {
	return resolveHome(readConfig(config, "dshHome"));
}

export { Config, USAGE, apply, inject, name };

