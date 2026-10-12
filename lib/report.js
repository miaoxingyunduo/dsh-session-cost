/**
 * One conversation's cost report, shared by every surface.
 *
 * A live session is priced from its in-memory durable log (`eventAt`/`seq`),
 * which is exact and free. A session the Host no longer holds is priced from
 * disk, which is what makes `/cost` useful for yesterday's conversation too.
 *
 * @module @local/dsh-session-cost/report
 */

import {
	findDescendants,
	isInsideSessionsRoot,
	listSessionLogs,
	readSessionIndex,
	readSessionLog,
	resolveHome,
	resolveSession,
	sessionHeader,
} from "./engine.js";
import { costEvents } from "./usage.js";
import { MICRO_USD, formatMoney, formatTokens } from "./rates.js";

/** The four bucket labels, in the order every report shows them. */
export const BUCKET_LABELS = [
	["uncachedInputTokens", "输入(未命中缓存)"],
	["cacheReadTokens", "输入(命中缓存)"],
	["cacheWriteTokens", "输入(缓存写入)"],
	["outputTokens", "输出"],
];

/**
 * Collect a live session's events without copying the whole log when the
 * caller only needs a suffix (the `lastTurns` option).
 *
 * @param {object} session - a live session.
 * @returns {object[]} its durable events in seq order.
 */
export function liveEvents(session) {
	const events = [];
	if (session === null || typeof session !== "object") return events;
	const count = typeof session.seq === "number" ? session.seq : undefined;
	if (count === undefined || typeof session.eventAt !== "function") return events;
	for (let index = 0; index < count; index += 1) {
		const event = session.eventAt(index);
		if (event !== undefined) events.push(event);
	}
	return events;
}

/**
 * Keep only the events of the last N turns, counting `turn/start` boundaries.
 *
 * A turn's usage is fully described by its own events, so dropping earlier
 * turns is what makes "cost of the last 3 turns" cheap on a long conversation.
 * Note that a real conversation is often ONE turn with hundreds of steps (a
 * turn ends only when the model stops calling tools), so `trailingSteps` is the
 * scope a "recent cost" question usually wants.
 *
 * @param {object[]} events - durable events.
 * @param {number} turns - how many trailing turns to keep.
 * @returns {object[]} the retained suffix.
 */
export function trailingTurns(events, turns) {
	if (!(Number.isFinite(turns) && turns > 0)) return events;
	let seen = 0;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		if (events[index]?.type === "turn/start") {
			seen += 1;
			if (seen >= turns) return events.slice(index);
		}
	}
	return events;
}

/**
 * Keep only the events of the last N model calls.
 *
 * One `assistant/message` is one billed call, so counting those backwards and
 * slicing from the step's own `step/start` keeps whole steps — a step is the
 * unit the agent loop actually appends a bill for.
 *
 * @param {object[]} events - durable events.
 * @param {number} steps - how many trailing model calls to keep.
 * @returns {object[]} the retained suffix.
 */
export function trailingSteps(events, steps) {
	if (!(Number.isFinite(steps) && steps > 0)) return events;
	let seen = 0;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		if (events[index]?.type !== "assistant/message") continue;
		seen += 1;
		if (seen < steps) continue;
		// Walk back to the step boundary so the kept slice is a whole step.
		for (let start = index; start >= 0; start -= 1) {
			if (events[start]?.type === "step/start") return events.slice(start);
		}
		return events.slice(index);
	}
	return events;
}

/**
 * The one place the two scope options are applied.
 *
 * @param {object[]} events - durable events.
 * @param {object} scope - `{turns, steps}`, either optional.
 * @returns {object[]} the scoped events.
 */
function scoped(events, scope) {
	if (Number.isFinite(scope?.steps) && scope.steps > 0) return trailingSteps(events, scope.steps);
	return trailingTurns(events, scope?.turns);
}

/**
 * Describe a scope for the report header.
 *
 * @param {object} scope - `{turns, steps}`.
 * @returns {string|undefined} e.g. `最近 3 次模型调用`.
 */
function scopeLabel(scope) {
	if (Number.isFinite(scope?.steps) && scope.steps > 0) return `最近 ${scope.steps} 次模型调用`;
	if (Number.isFinite(scope?.turns) && scope.turns > 0) return `最近 ${scope.turns} 轮`;
	return undefined;
}

/**
 * Price one live session.
 *
 * @param {object} input - see {@link costEvents} plus `session` and the scope.
 * @param {object} input.session - the live session.
 * @returns {object} the report.
 */
export function reportLiveSession({ session, rates, currency, timezone, offPeakMultiplier, holidays, turns, steps, at }) {
	const events = liveEvents(session);
	const selected = scoped(events, { turns, steps });
	const header = sessionHeader(events);
	const report = costEvents({
		events: selected,
		rates,
		currency,
		timezone,
offPeakMultiplier,
holidays,
		at: header?.createdAt,
	});
	return {
		...report,
		source: "live",
		scopeLabel: scopeLabel({ turns, steps }),
		session: {
			id: header?.id ?? session?.header?.id ?? session?.id,
			title: undefined,
			cwd: header?.cwd,
			createdAt: header?.createdAt,
		},
	};
}

/**
 * Price one session from disk.
 *
 * @param {object} input - resolution + pricing input.
 * @param {string} input.home - DSH home.
 * @param {string} [input.sessionId] - exact session id.
 * @param {string} [input.target] - id, prefix, or title fragment.
 * @returns {Promise<{kind: string, report?: object, session?: object, candidates?: object[], known?: object[]}>} the outcome.
 */
export async function reportStoredSession({ home, sessionId, target, rates, currency, timezone, offPeakMultiplier, holidays, turns, steps, at }) {
	const resolution = resolveSession({ home, sessionId, target });
	if (resolution.kind !== "found") return resolution;
	const { session } = resolution;
	if (!isInsideSessionsRoot(home, session.file)) {
		return { kind: "refused", reason: `refusing to read ${session.file}: outside the sessions root of ${home}` };
	}
	const log = await readSessionLog(session.file);
	const header = sessionHeader(log.events);
	const selected = scoped(log.events, { turns, steps });
	const report = costEvents({
		events: selected,
		rates,
		currency,
		timezone,
offPeakMultiplier,
holidays,
		at: header?.createdAt ?? session.mtimeMs,
	});
	return {
		kind: "found",
		session,
		report: {
			...report,
			source: "stored",
			scopeLabel: scopeLabel({ turns, steps }),
			events: selected.length,
			session: {
				id: session.sessionId,
				title: session.title,
				cwd: header?.cwd,
				createdAt: header?.createdAt,
				bytes: session.bytes,
				mtimeMs: session.mtimeMs,
				archived: session.archived,
			},
		},
	};
}

/**
 * List every conversation on disk with its cost.
 *
 * @param {object} input - listing input.
 * @param {string} input.home - DSH home.
 * @param {number} [input.limit] - cap on returned rows.
 * @returns {Promise<{rows: object[], failures: Array<{sessionId: string, error: string}>}>} the listing.
 */
export async function listStoredCosts({ home, rates, currency, timezone, offPeakMultiplier, holidays, limit }) {
	const index = readSessionIndex(home);
	const logs = listSessionLogs(home);
	const rows = [];
	const failures = [];
	for (const entry of logs) {
		try {
			const log = await readSessionLog(entry.file);
			const header = sessionHeader(log.events);
			const report = costEvents({
				events: log.events,
				rates,
				currency,
				timezone,
offPeakMultiplier,
holidays,
				at: header?.createdAt ?? entry.mtimeMs,
			});
			rows.push({
				sessionId: entry.sessionId,
				title: index.get(entry.sessionId)?.title,
				archived: index.get(entry.sessionId)?.archived === true,
				mtimeMs: entry.mtimeMs,
				createdAt: header?.createdAt,
				events: log.events.length,
				attempts: report.attempts,
				tokens: report.totals.tokens,
				uncachedInputTokens: report.totals.uncachedInputTokens,
				cacheReadTokens: report.totals.cacheReadTokens,
				cacheWriteTokens: report.totals.cacheWriteTokens,
				outputTokens: report.totals.outputTokens,
				microUsd: report.totals.microUsd,
				priced: report.priced,
				unpriced: report.unpriced,
				routes: report.routes.map((route) => `${route.provider}/${route.model}`),
			});
		} catch (error) {
			failures.push({ sessionId: entry.sessionId, error: error instanceof Error ? error.message : String(error) });
		}
	}
	rows.sort((left, right) => right.mtimeMs - left.mtimeMs);
	return { rows: Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows, failures };
}

/**
 * Price one session together with everything it delegated to.
 *
 * A delegated session (subagent, workflow agent, teammate) is a session of its
 * own with its own log and its own bill, so "what did this conversation cost"
 * has two honest answers: the session alone, and the session plus its family.
 * Both are returned; neither is presented as the other.
 *
 * @param {object} input - pricing input plus resolution.
 * @param {string} input.home - DSH home.
 * @param {string} [input.sessionId] - exact session id.
 * @param {string} [input.target] - id, prefix, or title fragment.
 * @param {boolean} [input.fresh] - re-scan the family instead of reusing the short-lived index.
 * @returns {Promise<object>} `{kind, session, self, descendants, totals, ...}` on success.
 */
export async function reportFamily({ home, sessionId, target, rates, currency, timezone, offPeakMultiplier, holidays, turns, steps, at, fresh = false }) {
	const outcome = await reportStoredSession({ home, sessionId, target, rates, currency, timezone, offPeakMultiplier, holidays, turns, steps, at });
	if (outcome.kind !== "found") return outcome;
	const rootId = outcome.report.session.id;
	const family = await findDescendants({ home, sessionId: rootId, fresh });
	const children = [];
	const failures = [];
	for (const descendant of family.descendants) {
		try {
			const log = await readSessionLog(descendant.file);
			const header = sessionHeader(log.events);
			const report = costEvents({
				events: scoped(log.events, { turns, steps }),
				rates,
				currency,
				timezone,
offPeakMultiplier,
holidays,
				at: header?.createdAt ?? descendant.mtimeMs,
			});
			children.push({
				sessionId: descendant.sessionId,
				parentSessionId: descendant.parentSessionId,
				depth: descendant.depth,
				origin: descendant.origin,
				createdAt: header?.createdAt,
				tokens: report.totals.tokens,
				microUsd: report.totals.microUsd,
				attempts: report.attempts,
				priced: report.priced,
				unpriced: report.unpriced,
			});
		} catch (error) {
			failures.push({ sessionId: descendant.sessionId, error: error instanceof Error ? error.message : String(error) });
		}
	}
	children.sort((left, right) => right.tokens - left.tokens);
	const descendantTokens = children.reduce((sum, row) => sum + row.tokens, 0);
	const descendantMicroUsd = children.reduce((sum, row) => sum + row.microUsd, 0);
	const totalMicroUsd = outcome.report.totals.microUsd + descendantMicroUsd;
	return {
		kind: "found",
		session: outcome.session,
		self: outcome.report,
		descendants: children,
		failures,
		missingParents: family.missingParents,
		truncated: family.truncated,
		totals: {
			tokens: outcome.report.totals.tokens + descendantTokens,
			microUsd: totalMicroUsd,
			usd: totalMicroUsd / MICRO_USD,
			descendantTokens,
			descendantMicroUsd,
			descendantUsd: descendantMicroUsd / MICRO_USD,
			descendantCount: children.length,
			priced: outcome.report.priced && children.every((child) => child.priced),
			unpriced: [...new Set([...(outcome.report.unpriced ?? []), ...children.flatMap((child) => child.unpriced)])],
		},
	};
}

/**
 * Render a family report as text: the session's own line, its delegated
 * sessions, then the combined total.
 *
 * @param {object} family - from {@link reportFamily}.
 * @param {object} currency - display currency.
 * @param {object} [root] - overrides for the root's own figures, so a caller that
 *   priced the live session from memory can render that number instead of the
 *   one read back from its log.
 * @param {object} [root.self] - the root's own report.
 * @param {object} [root.totals] - the combined totals to print.
 * @param {string} [root.title] - the root's title.
 * @returns {string} multi-line text.
 */
export function renderFamily(family, currency, root = {}) {
	const self = root.self ?? family.self;
	const totals = root.totals ?? family.totals;
	const descendants = family.descendants;
	const title = root.title ?? self.session?.title;
	const id = self.session?.id ?? family.session?.sessionId ?? "?";
	const lines = [];
	lines.push(`会话 ${id}${title === undefined || title === "" ? "" : ` 「${title}」`} 及其派生会话`);
	lines.push("");
	lines.push(`本会话自身：${self.totals.tokens.toLocaleString("en-US")} token · ${formatMoney(self.totals.microUsd, currency)}（${self.attempts} 次模型调用）`);
	if (descendants.length === 0) {
		lines.push("派生会话：无（这个会话没有 subagent / workflow agent 子会话）");
	} else {
		lines.push(`派生会话：${descendants.length} 个 · 合计 ${totals.descendantTokens.toLocaleString("en-US")} token · ${formatMoney(totals.descendantMicroUsd, currency)}`);
		for (const child of descendants.slice(0, 15)) {
			const indent = "  ".repeat(Math.min(child.depth, 3));
			const label = child.origin === undefined ? "" : `[${child.origin}] `;
			const cost = child.priced ? formatMoney(child.microUsd, currency) : "未配置价格";
			lines.push(`${indent}${label}${child.sessionId}  ${child.tokens.toLocaleString("en-US")} token · ${cost}`);
		}
		if (descendants.length > 15) lines.push(`  …另有 ${descendants.length - 15} 个未列出`);
	}
	if (family.missingParents !== undefined && family.missingParents.length > 0) {
		lines.push("");
		lines.push(`注意：${family.missingParents.length} 个被引用的父会话日志已不在本机，其更上层可能还有未计入的消耗（删过会话时会出现）。`);
	}
	if (family.failures !== undefined && family.failures.length > 0) {
		lines.push("");
		lines.push(`读取失败 ${family.failures.length} 个派生会话：${family.failures.map((row) => row.sessionId).join(", ")}`);
	}
	if (totals.unpriced !== undefined && totals.unpriced.length > 0) {
		lines.push("");
		lines.push(`其中未配置单价的模型：${totals.unpriced.join(", ")}`);
	}
	lines.push("");
	lines.push(`合计：${totals.tokens.toLocaleString("en-US")} token · ${formatMoney(totals.microUsd, currency)}`);
	return lines.join("\n");
}

/**
 * Render one report as the text a person or a model reads.
 *
 * @param {object} report - a report from this module.
 * @param {object} currency - display currency.
 * @param {object} [options] - rendering options.
 * @param {boolean} [options.detail] - include the per-bucket table.
 * @returns {string} multi-line text.
 */
export function renderReport(report, currency, options = {}) {
	const lines = [];
	const title = report.session?.title;
	const id = report.session?.id ?? "?";
	lines.push(`会话 ${id}${title === undefined || title === "" ? "" : ` 「${title}」`}`);
	const scope = report.scopeLabel ?? "整段对话";
	lines.push(`范围：${scope}（${report.attempts} 次模型调用，${report.events} 条事件，来源：${report.source === "live" ? "宿主内存" : "磁盘日志"}）`);
	lines.push("");
	lines.push(`总 token：${report.totals.tokens.toLocaleString("en-US")}（可读：${formatTokens(report.totals.tokens)}）`);
	for (const [bucket, label] of BUCKET_LABELS) {
		lines.push(`  ${label.padEnd(18, " ")} ${String(report.totals[bucket]).padStart(10, " ")}`);
	}
	const display = formatMoney(report.totals.microUsd, currency);
	lines.push(`金额：${display}${report.totals.usd === 0 ? "（未配置价格的模型不计金额）" : ""}`);
	if (report.totals.unpricedTokens > 0) {
		lines.push(`注意：${report.totals.unpricedTokens.toLocaleString("en-US")} token 未配置价格 → ${report.unpriced.join(", ")}`);
	}
	if (report.routes.length > 1 || options.detail === true) {
		lines.push("");
		lines.push("按模型：");
		for (const route of report.routes) {
			// `<provider>/<model>` first: that is the key the rate table is written in
			// and the only thing that tells two providers serving one model apart.
			// The configured label is extra context, so it comes after, and is left out
			// when it would just repeat the model.
			const key = route.provider === undefined || route.provider === "" ? route.model : `${route.provider}/${route.model}`;
			const label = route.label !== undefined && route.label !== route.model && route.label !== key ? `（${route.label}）` : "";
			const cost = route.priced ? formatMoney(route.microUsd, currency) : "未配置价格";
			lines.push(`  ${key}${label}  ${route.attempts} 次 · ${route.tokens.toLocaleString("en-US")} token · ${cost}`);
			if (options.detail === true && route.priced) {
				for (const [bucket, label] of BUCKET_LABELS) {
					const cell = route.breakdown[bucket];
					if (cell === undefined) continue;
					lines.push(`      ${label}: ${cell.tokens.toLocaleString("en-US")} × ${currency?.symbol ?? ""}${cell.pricePerMillion}/1M = ${formatMoney(cell.microUsd, currency)}`);
				}
				// A route whose price list has no peak/off-peak window is on one flat
				// price, so naming a window here would invent a tariff that does not
				// exist — the same mistake as halving a flat price.
				const peakNote = route.windowed === false
					? "（固定价：该模型不分高峰/非高峰）"
					: route.peakTokens > 0 && route.offPeakTokens > 0
						? `（高峰 ${route.peakTokens.toLocaleString("en-US")} · 非高峰 ${route.offPeakTokens.toLocaleString("en-US")}）`
						: route.peakTokens > 0 ? "（全部按高峰价）" : "（全部按非高峰价）";
				lines.push(`      ${peakNote}`);
			}
		}
	}
	if (report.ambiguity.length > 0) {
		lines.push("");
		for (const row of report.ambiguity) {
			lines.push(`价格歧义：${row.model} 同时匹配 ${row.candidates.join(", ")}；请在 rates 里写全 "<provider>/<model>" 键`);
		}
	}
	return lines.join("\n");
}

/**
 * Render a stored-cost listing as text.
 *
 * @param {object} listing - from {@link listStoredCosts}.
 * @param {object} currency - display currency.
 * @returns {string} multi-line text.
 */
export function renderListing(listing, currency) {
	const lines = ["对话（按最近活动排序）："];
	const width = listing.rows.reduce((max, row) => Math.max(max, (row.title ?? row.sessionId).length), 0);
	for (const row of listing.rows) {
		const name = (row.title === undefined || row.title === "" ? row.sessionId : row.title).padEnd(Math.min(width, 30), " ");
		const cost = row.priced ? formatMoney(row.microUsd, currency) : "未配置价格";
		lines.push(`  ${name}  ${formatTokens(row.tokens).padStart(7, " ")} token  ${cost.padStart(10, " ")}  ${row.archived ? "[已归档] " : ""}${row.sessionId}`);
	}
	if (listing.failures.length > 0) {
		lines.push("");
		lines.push(`读取失败 ${listing.failures.length} 个：${listing.failures.map((failure) => failure.sessionId).join(", ")}`);
	}
	return lines.join("\n");
}

export { resolveHome };
