/**
 * Disk-engine tests: multi-frame log decoding, the session index, target
 * resolution, and the stored-session report.
 *
 * Run: node --test --test-isolation=none test/engine.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import {
	decodeZstdFrames,
	frameOffsets,
	isInsideSessionsRoot,
	listSessionLogs,
	parseLog,
	readSessionIndex,
	readSessionLog,
	resolveHome,
	resolveSession,
	sessionHeader,
} from "../lib/engine.js";
import { listStoredCosts, renderListing, renderReport, reportStoredSession, trailingSteps, trailingTurns } from "../lib/report.js";
import { costEvents, foldUsage } from "../lib/usage.js";
import { DEFAULT_RATES, parseRateTable } from "../lib/rates.js";
import { makeHome, makeSessionEvents } from "./helpers.js";

const currency = { symbol: "$", code: "USD", perUsd: 1 };
const rates = parseRateTable(DEFAULT_RATES);

/** Build one throwaway DSH home with two sessions. */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "dsh-cost-"));
	const first = makeSessionEvents({ turns: 3, id: "session-11111111-1111-1111-1111-111111111111" });
	const second = makeSessionEvents({ turns: 1, id: "session-22222222-2222-2222-2222-222222222222" });
	const { home } = makeHome({
		root,
		sessions: [
			{ id: "session-11111111-1111-1111-1111-111111111111", title: "昂贵的那次对话", events: first },
			{ id: "session-22222222-2222-2222-2222-222222222222", title: "便宜的那次对话", events: second },
		],
	});
	return { root, home };
}

test("frameOffsets finds the leading magic of a concatenated stream", async () => {
	const text = `${Array.from({ length: 500 }, (_, index) => JSON.stringify({ type: "x", index, pad: "y".repeat(50) })).join("\n")}\n`;
	const bytes = Buffer.from(text, "utf8");
	const frames = [];
	for (let offset = 0; offset < bytes.length; offset += 4000) {
		frames.push(zstdCompressSync(bytes.subarray(offset, Math.min(bytes.length, offset + 4000))));
	}
	const buffer = Buffer.concat(frames);
	// The count is an upper bound: the four magic bytes can occur inside a
	// compressed block, which is why decoding streams the buffer instead of
	// splitting on them.
	assert.ok(frameOffsets(buffer).length >= frames.length);
	assert.equal(frameOffsets(buffer)[0], 0);
	const decoded = await decodeZstdFrames(buffer);
	assert.equal(decoded.toString("utf8"), text, "a single-shot decompressor would stop at the first frame");
});

test("decodeZstdFrames refuses a buffer that is not a zstd stream", async () => {
	await assert.rejects(() => decodeZstdFrames(Buffer.from("plain text")), /not a zstd stream/);
});

test("parseLog counts unusable lines instead of throwing", () => {
	const { events, skipped } = parseLog("{\"a\":1}\n\nnot json\n{\"b\":2}\n");
	assert.equal(events.length, 2);
	assert.equal(skipped, 1);
});

test("readSessionLog decodes a real multi-frame session log end to end", async () => {
	const { home } = fixture();
	const entry = listSessionLogs(home).find((row) => row.sessionId === "session-11111111-1111-1111-1111-111111111111");
	assert.ok(entry !== undefined, "the three-turn session is on disk");
	const log = await readSessionLog(entry.file);
	assert.equal(log.skipped, 0);
	assert.equal(log.events.length, 1 + 3 * 5, "every frame is decoded, not just the first");
	const header = sessionHeader(log.events);
	assert.equal(header.id, entry.sessionId);
	assert.equal(header.cwd, "D:\\work");
	assert.ok(header.createdAt > 0);
});

test("listSessionLogs enumerates only session directories and sorts newest first", () => {
	const { home } = fixture();
	const logs = listSessionLogs(home);
	assert.equal(logs.length, 2);
	assert.ok(logs.every((entry) => entry.sessionId.startsWith("session-")));
	assert.ok(logs[0].mtimeMs >= logs[1].mtimeMs);
});

test("readSessionIndex reads membership, archived flags, and cached titles", () => {
	const { home } = fixture();
	const index = readSessionIndex(home);
	assert.equal(index.size, 2);
	assert.equal(index.get("session-11111111-1111-1111-1111-111111111111").title, "昂贵的那次对话");
	assert.equal(index.get("session-11111111-1111-1111-1111-111111111111").archived, false);
	assert.equal(index.get("session-11111111-1111-1111-1111-111111111111").workspaceId, "ws-0000-0000-0000-000000000001");
});

test("readSessionIndex marks an archived session from the v2 global block", () => {
	const { home } = fixture();
	const file = join(home, "storages", "workspace.json");
	const raw = JSON.parse(readFileSync(file, "utf8"));
	raw.global.archivedSessionIds.push("session-22222222-2222-2222-2222-222222222222");
	writeFileSync(file, JSON.stringify(raw));
	assert.equal(readSessionIndex(home).get("session-22222222-2222-2222-2222-222222222222").archived, true);
});

test("readSessionIndex tolerates a missing or malformed registry", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-cost-empty-"));
	assert.equal(readSessionIndex(root).size, 0);
	const bad = mkdtempSync(join(tmpdir(), "dsh-cost-bad-"));
	writeFileSync(join(bad, "workspace.json"), "{not json");
	assert.equal(readSessionIndex(bad).size, 0);
});

test("resolveSession resolves an exact id, an id prefix, and a unique title fragment", () => {
	const { home } = fixture();
	const exact = resolveSession({ home, target: "session-11111111-1111-1111-1111-111111111111" });
	assert.equal(exact.kind, "found");
	assert.equal(exact.session.title, "昂贵的那次对话");
	const prefix = resolveSession({ home, target: "session-2222" });
	assert.equal(prefix.kind, "found");
	assert.equal(prefix.session.sessionId, "session-22222222-2222-2222-2222-222222222222");
	const byTitle = resolveSession({ home, target: "便宜" });
	assert.equal(byTitle.kind, "found");
	const byIdField = resolveSession({ home, sessionId: "session-11111111-1111-1111-1111-111111111111" });
	assert.equal(byIdField.kind, "found");
});

test("resolveSession refuses to guess: an ambiguous fragment lists candidates", () => {
	const { home } = fixture();
	const ambiguous = resolveSession({ home, target: "session-" });
	assert.equal(ambiguous.kind, "ambiguous");
	assert.equal(ambiguous.candidates.length, 2);
});

test("resolveSession reports not-found with the known list instead of picking a session", () => {
	const { home } = fixture();
	const missing = resolveSession({ home, target: "does-not-exist" });
	assert.equal(missing.kind, "not-found");
	assert.equal(missing.known.length, 2);
	const noTarget = resolveSession({ home });
	assert.equal(noTarget.kind, "not-found");
});

test("readSessionLog reads a plain JSONL log when the file is not compressed", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-cost-plain-"));
	const dir = join(root, "sessions", "--fixture--", "session-44444444-4444-4444-4444-444444444444");
	mkdirSync(dir, { recursive: true });
	const events = makeSessionEvents({ turns: 1, id: "session-44444444-4444-4444-4444-444444444444" });
	writeFileSync(join(dir, "session.v4.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
	const log = await readSessionLog(join(dir, "session.v4.jsonl"));
	assert.equal(log.events.length, events.length);
});

test("trailingTurns keeps exactly the requested trailing turns", () => {
	const full = makeSessionEvents({ turns: 4 });
	const lastTwo = trailingTurns(full, 2);
	assert.equal(lastTwo.filter((event) => event.type === "turn/start").length, 2);
	assert.equal(trailingTurns(full, 99).length, full.length, "asking for more turns than exist returns everything");
	assert.equal(trailingTurns(full, 0).length, full.length);
});

test("trailingSteps keeps whole steps, which is the scope a long single-turn session needs", () => {
	const full = makeSessionEvents({ turns: 4 });
	const lastTwo = trailingSteps(full, 2);
	assert.equal(lastTwo.filter((event) => event.type === "assistant/message").length, 2);
	assert.equal(lastTwo[0].type, "step/start", "the slice starts at a step boundary");
	assert.equal(trailingSteps(full, 99).length, full.length);
	assert.equal(trailingSteps(full, 0).length, full.length);
	// A real conversation is often ONE turn with many steps: turn scoping cannot
	// narrow it, step scoping can.
	const stepsOf = (count) => Array.from({ length: count }, (_, index) => [
		{ type: "step/start", data: { turn: 1, step: index + 1 } },
		{ type: "assistant/message", data: { turn: 1, step: index + 1, usage: { inputTokens: 10, outputTokens: 5 }, message: { source: { provider: "p", model: "m" } } } },
		{ type: "step/end", data: { turn: 1, step: index + 1 } },
	]).flat();
	const singleTurn = [
		{ type: "session", id: "session-single" },
		{ type: "turn/start", data: { turn: 1 } },
		...stepsOf(5),
	];
	assert.equal(
		trailingTurns(singleTurn, 1).filter((event) => event.type === "assistant/message").length,
		5,
		"one turn spans the whole conversation, so turn scoping keeps every call",
	);
	const lastTwoCalls = trailingSteps(singleTurn, 2);
	assert.equal(lastTwoCalls.filter((event) => event.type === "assistant/message").length, 2);
	assert.equal(lastTwoCalls[0].type, "step/start");
	// The cost of the last two calls is what a "recent cost" question wants: 2 ×
	// (10 input + 5 output).
	const fold = foldUsage(lastTwoCalls);
	assert.equal(fold.totals.uncachedInputTokens, 20);
	assert.equal(fold.totals.outputTokens, 10);
});

test("reportStoredSession prices a session from disk and renders a readable report", async () => {
	const { home } = fixture();
	const outcome = await reportStoredSession({
		home,
		target: "session-11111111-1111-1111-1111-111111111111",
		rates,
		currency,
		timezone: "UTC",
		offPeakMultiplier: 0.5,
	});
	assert.equal(outcome.kind, "found");
	assert.equal(outcome.report.source, "stored");
	assert.equal(outcome.report.attempts, 3);
	// Three turns: input 100+200+300=600, output 20+40+60=120, cacheRead 1000+2000+3000=6000.
	assert.equal(outcome.report.totals.uncachedInputTokens, 600);
	assert.equal(outcome.report.totals.cacheReadTokens, 6000);
	assert.equal(outcome.report.totals.outputTokens, 120);
	assert.equal(outcome.report.totals.tokens, 6720);
	assert.ok(outcome.report.totals.microUsd > 0);
	const text = renderReport(outcome.report, currency, { detail: true });
	assert.match(text, /昂贵的那次对话/);
	assert.match(text, /输入\(命中缓存\)/);
	assert.match(text, /按模型/);
	// The route is named `<provider>/<model>` with the configured label after it:
	// the key is what the rate table is written in, and two providers can serve the
	// same model name (this machine really bills `deepseek-account/deepseek-flash`
	// and `deepseek-official/deepseek-flash` in different conversations).
	assert.match(text, /deepseek-official\/deepseek-flash（DeepSeek-V4\.1-Flash）/);
	assert.match(text, /非高峰/);
});

test("reportStoredSession honours a trailing-turn scope", async () => {
	const { home } = fixture();
	const outcome = await reportStoredSession({
		home,
		target: "session-11111111-1111-1111-1111-111111111111",
		rates,
		currency,
		timezone: "UTC",
		offPeakMultiplier: 0.5,
		turns: 1,
	});
	assert.equal(outcome.report.attempts, 1);
	assert.equal(outcome.report.totals.uncachedInputTokens, 300, "only the last turn's 300 input tokens");
	assert.match(renderReport(outcome.report, currency), /最近 1 轮/);
});

test("reportStoredSession honours a trailing-step scope and labels it as model calls", async () => {
	const { home } = fixture();
	const outcome = await reportStoredSession({
		home,
		target: "session-11111111-1111-1111-1111-111111111111",
		rates,
		currency,
		timezone: "UTC",
		offPeakMultiplier: 0.5,
		steps: 2,
	});
	assert.equal(outcome.report.attempts, 2);
	assert.equal(outcome.report.totals.uncachedInputTokens, 500, "the last two steps' 200 + 300 input tokens");
	assert.match(renderReport(outcome.report, currency), /最近 2 次模型调用/);
});

test("reportStoredSession propagates a failed resolution without reading anything", async () => {
	const { home } = fixture();
	const outcome = await reportStoredSession({ home, target: "nope", rates, currency, timezone: "UTC", offPeakMultiplier: 0.5 });
	assert.equal(outcome.kind, "not-found");
	assert.equal(outcome.report, undefined);
});

test("listStoredCosts returns one priced row per session, newest first, and renders", async () => {
	const { home } = fixture();
	const listing = await listStoredCosts({ home, rates, currency, timezone: "UTC", offPeakMultiplier: 0.5 });
	assert.equal(listing.rows.length, 2);
	assert.equal(listing.failures.length, 0);
	for (const row of listing.rows) {
		assert.ok(row.tokens > 0);
		assert.equal(row.priced, true);
		assert.ok(row.microUsd > 0);
	}
	const expensive = listing.rows.find((row) => row.title === "昂贵的那次对话");
	const cheap = listing.rows.find((row) => row.title === "便宜的那次对话");
	assert.ok(expensive.tokens > cheap.tokens);
	const text = renderListing(listing, currency);
	assert.match(text, /昂贵的那次对话/);
	assert.match(text, /token/);
});

test("listStoredCosts caps the row count with limit", async () => {
	const { home } = fixture();
	const listing = await listStoredCosts({ home, rates, currency, timezone: "UTC", offPeakMultiplier: 0.5, limit: 1 });
	assert.equal(listing.rows.length, 1);
});

test("listStoredCosts reports an undecodable log as a failure instead of failing the whole listing", async () => {
	const { home, root } = fixture();
	const broken = join(root, "sessions", "--fixture--", "session-33333333-3333-3333-3333-333333333333");
	mkdirSync(broken, { recursive: true });
	writeFileSync(join(broken, "session.v4.jsonl.zstd"), Buffer.from("not zstd at all"));
	assert.ok(isInsideSessionsRoot(home, join(broken, "session.v4.jsonl.zstd")));
	const listing = await listStoredCosts({ home, rates, currency, timezone: "UTC", offPeakMultiplier: 0.5 });
	assert.equal(listing.failures.length, 1);
	assert.match(listing.failures[0].error, /not a zstd stream/);
	assert.equal(listing.rows.length, 2, "the readable sessions still come back");
});

test("isInsideSessionsRoot rejects a path outside the sessions root", () => {
	const { home } = fixture();
	assert.equal(isInsideSessionsRoot(home, join(home, "sessions", "a", "b", "session.v4.jsonl.zstd")), true);
	assert.equal(isInsideSessionsRoot(home, join(home, "storages", "workspace.json")), false);
	assert.equal(isInsideSessionsRoot(home, join(home, "..", "outside")), false);
});

test("resolveHome prefers an explicit value, then $DSH_HOME, then ~/.dsh", () => {
	const saved = process.env.DSH_HOME;
	try {
		assert.equal(resolveHome("D:\\custom"), "D:\\custom");
		process.env.DSH_HOME = "D:\\from-env";
		assert.equal(resolveHome(""), "D:\\from-env");
		delete process.env.DSH_HOME;
		assert.match(resolveHome(""), /\.dsh$/);
	} finally {
		if (saved === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = saved;
	}
});

test("the durable fold reproduces DSH's own tokenUsage projection on a real log", async () => {
	// fixtures/real-deepseek.* comes from a real DSH session: only the events the
	// fold reads, verbatim. `.expected.json` carries the `tokenUsage` totals DSH's
	// own dsh-token-meter projection had checkpointed for that session, which is
	// the independent ground truth this plugin's numbers are measured against.
	const { events } = await readSessionLog(fileURLToPath(new URL("./fixtures/real-deepseek.jsonl.zstd", import.meta.url)));
	const expected = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/real-deepseek.expected.json", import.meta.url)), "utf8"));
	const fold = foldUsage(events);
	assert.equal(fold.attempts, expected.attempts);
	assert.deepEqual(fold.totals, expected.totals);
	assert.deepEqual(fold.totals, expected.projected, "the fold must equal DSH's projection, not merely be self-consistent");
});
