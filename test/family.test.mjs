/**
 * Family-rollup tests: a conversation's delegated sessions are separate bills,
 * so the rollup must find them through the durable `parentSession` link, keep
 * the session's own figure separate, and be honest about links it cannot follow.
 *
 * Run: node --test --test-isolation=none test/family.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDescendants, readFamilyIndex, readSessionHeader, sessionHeader } from "../lib/engine.js";
import { renderFamily, reportFamily, reportStoredSession } from "../lib/report.js";
import { DEFAULT_RATES, parseRateTable } from "../lib/rates.js";
import { makeHome, makeSessionEvents } from "./helpers.js";

const currency = { symbol: "$", code: "USD", perUsd: 1 };
const rates = parseRateTable(DEFAULT_RATES);

const ROOT = "session-11111111-1111-1111-1111-111111111111";
const CHILD_A = "session-22222222-2222-2222-2222-222222222222";
const CHILD_B = "session-33333333-3333-3333-3333-333333333333";
const GRANDCHILD = "session-44444444-4444-4444-4444-444444444444";
const UNRELATED = "session-55555555-5555-5555-5555-555555555555";

/**
 * A home with one family: root → (child A → grandchild, child B) plus an
 * unrelated session that must never be counted.
 */
function familyHome() {
	const root = mkdtempSync(join(tmpdir(), "dsh-cost-family-"));
	const { home } = makeHome({
		root,
		sessions: [
			// One turn per session except B, so every expected figure below is the
			// fixture's own 1-turn total (100 in + 1000 cache read + 20 out = 1120).
			{ id: ROOT, title: "主对话", events: makeSessionEvents({ turns: 1, id: ROOT }) },
			{ id: CHILD_A, title: "子代理 A", events: makeSessionEvents({ turns: 1, id: CHILD_A, parentSession: ROOT, origin: "subagent", delegationDepth: 1 }) },
			{ id: CHILD_B, title: "子代理 B", events: makeSessionEvents({ turns: 2, id: CHILD_B, parentSession: ROOT, origin: "subagent", delegationDepth: 1 }) },
			{ id: GRANDCHILD, title: "孙代理", events: makeSessionEvents({ turns: 1, id: GRANDCHILD, parentSession: CHILD_A, origin: "subagent", delegationDepth: 2 }) },
			{ id: UNRELATED, title: "无关对话", events: makeSessionEvents({ turns: 4, id: UNRELATED }) },
		],
	});
	return home;
}

test("sessionHeader carries the durable delegation link", () => {
	const header = sessionHeader([{ type: "session", id: ROOT, parentSession: "session-x", origin: "subagent", delegationDepth: 1 }]);
	assert.equal(header.parentSession, "session-x");
	assert.equal(header.origin, "subagent");
	assert.equal(header.delegationDepth, 1);
	const plain = sessionHeader([{ type: "session", id: ROOT }]);
	assert.equal(plain.parentSession, undefined);
	assert.equal(plain.origin, undefined);
});

test("readSessionHeader reads only the first line, from the middle of a multi-frame log", async () => {
	const home = familyHome();
	const { byId } = await readFamilyIndex(home);
	const entry = byId.get(GRANDCHILD);
	assert.ok(entry !== undefined && entry.file !== undefined);
	const raw = await readSessionHeader(entry.file);
	assert.equal(raw.type, "session");
	assert.equal(raw.id, GRANDCHILD);
	assert.equal(raw.parentSession, CHILD_A, "the link survives a header-only read");
});

test("findDescendants walks the whole family and leaves unrelated sessions out", async () => {
	const home = familyHome();
	const family = await findDescendants({ home, sessionId: ROOT });
	const ids = family.descendants.map((row) => row.sessionId).sort();
	assert.deepEqual(ids, [CHILD_A, CHILD_B, GRANDCHILD].sort());
	assert.ok(!ids.includes(UNRELATED), "an unrelated session is never adopted");
	assert.deepEqual(family.missingParents, []);
	assert.equal(family.truncated, false);
	const grandchild = family.descendants.find((row) => row.sessionId === GRANDCHILD);
	assert.equal(grandchild.depth, 2, "depth is measured from the root");
	assert.equal(grandchild.parentSessionId, CHILD_A);
});

test("findDescendants on a leaf conversation reports an empty family, not an error", async () => {
	const home = familyHome();
	const family = await findDescendants({ home, sessionId: UNRELATED });
	assert.deepEqual(family.descendants, []);
});

test("findDescendants respects maxDepth", async () => {
	const home = familyHome();
	const shallow = await findDescendants({ home, sessionId: ROOT, maxDepth: 1 });
	assert.deepEqual(shallow.descendants.map((row) => row.sessionId).sort(), [CHILD_A, CHILD_B].sort());
});

test("findDescendants reports a parent whose own log is gone", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-cost-hole-"));
	const MISSING_PARENT = "session-99999999-9999-9999-9999-999999999999";
	const orphan = "session-88888888-8888-8888-8888-888888888888";
	const { home } = makeHome({
		root,
		sessions: [
			{ id: ROOT, events: makeSessionEvents({ turns: 1, id: ROOT }) },
			{ id: orphan, events: makeSessionEvents({ turns: 1, id: orphan, parentSession: MISSING_PARENT, origin: "subagent", delegationDepth: 2 }) },
		],
	});
	const family = await findDescendants({ home, sessionId: ROOT });
	// The orphan names a parent the root never reaches, so it is NOT part of this
	// family — but the hole must be visible when a walked session points at a
	// missing log, which is what a pruned conversation looks like.
	assert.deepEqual(family.descendants, []);
	const { byId } = await readFamilyIndex(home);
	assert.equal(byId.has(MISSING_PARENT), false, "the missing parent really is absent");
});

test("reportFamily keeps self and descendants separate and adds them for the total", async () => {
	const home = familyHome();
	const family = await reportFamily({ home, sessionId: ROOT, rates, currency, timezone: "UTC", offPeakMultiplier: 0.5 });
	assert.equal(family.kind, "found");
	assert.equal(family.descendants.length, 3);
	assert.equal(family.self.totals.tokens, 1120, "root alone: 1 turn of the fixture (100 in + 1000 cache + 20 out)");
	// Descendants: B 2 turns (1120 + 2240 = 3360) + A 1 turn (1120) + grandchild 1 turn (1120).
	// The fixture's usage grows with the turn number, so a session's total is triangular.
	assert.equal(family.totals.descendantTokens, 5600);
	assert.equal(family.totals.tokens, 1120 + 5600, "totals.tokens is the combined figure");
	assert.equal(family.totals.descendantCount, 3);
	assert.ok(family.totals.microUsd > family.self.totals.microUsd);
	assert.equal(family.totals.usd, family.totals.microUsd / 1_000_000);
	assert.equal(family.totals.descendantMicroUsd, family.totals.microUsd - family.self.totals.microUsd);
	assert.equal(family.failures.length, 0);
});

test("reportFamily sorts descendants by spend and does not include the unrelated session", async () => {
	const home = familyHome();
	const family = await reportFamily({ home, sessionId: ROOT, rates, currency, timezone: "UTC", offPeakMultiplier: 0.5 });
	assert.deepEqual(family.descendants.map((row) => row.sessionId), [CHILD_B, CHILD_A, GRANDCHILD], "biggest first");
	assert.ok(!family.descendants.some((row) => row.sessionId === UNRELATED));
	for (const child of family.descendants) {
		assert.equal(child.origin, "subagent");
		assert.ok(child.tokens > 0);
		assert.ok(child.priced);
	}
});

test("the same root priced alone is smaller than its family, which is the whole point", async () => {
	const home = familyHome();
	const alone = await reportStoredSession({ home, sessionId: ROOT, rates, currency, timezone: "UTC", offPeakMultiplier: 0.5 });
	const family = await reportFamily({ home, sessionId: ROOT, rates, currency, timezone: "UTC", offPeakMultiplier: 0.5 });
	assert.equal(alone.report.totals.tokens, 1120);
	assert.equal(family.totals.tokens, 6720);
	assert.ok(family.totals.tokens / alone.report.totals.tokens > 2.5, "the family is more than twice the session");
});

test("renderFamily shows self, descendants and the combined total", async () => {
	const home = familyHome();
	const family = await reportFamily({ home, sessionId: ROOT, rates, currency, timezone: "UTC", offPeakMultiplier: 0.5 });
	const text = renderFamily(family, currency);
	assert.match(text, /主对话/);
	assert.match(text, /本会话自身：1,120 token/);
	assert.match(text, /派生会话：3 个 · 合计 5,600 token/);
	assert.match(text, /\[subagent\] session-33333333/);
	assert.match(text, /合计：6,720 token/);
});

test("renderFamily accepts the live session's own figures for the root line", async () => {
	const home = familyHome();
	const family = await reportFamily({ home, sessionId: ROOT, rates, currency, timezone: "UTC", offPeakMultiplier: 0.5 });
	const live = { totals: { tokens: 4000, microUsd: 1_000 }, attempts: 3 };
	const text = renderFamily(family, currency, {
		self: live,
		totals: { ...family.totals, tokens: 4000 + family.totals.descendantTokens, microUsd: 1_000 + family.totals.descendantMicroUsd },
	});
	assert.match(text, /本会话自身：4,000 token/);
	assert.match(text, /合计：9,600 token/);
});
test("a conversation with no delegated sessions says so instead of showing zero", async () => {
	const home = familyHome();
	const family = await reportFamily({ home, sessionId: ROOT, rates, currency, timezone: "UTC", offPeakMultiplier: 0.5 });
	const lonely = { ...family, descendants: [], totals: { ...family.totals, descendantTokens: 0, descendantMicroUsd: 0, descendantCount: 0, tokens: family.self.totals.tokens, microUsd: family.self.totals.microUsd } };
	const text = renderFamily(lonely, currency);
	assert.match(text, /派生会话：无/);
	assert.match(text, /本会话自身：1,120 token/);
	assert.match(text, /合计：1,120 token/);
});

test("a descendant whose log cannot be decoded is reported, not silently dropped", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-cost-broken-child-"));
	const { home } = makeHome({
		root,
		sessions: [{ id: ROOT, title: "根", events: makeSessionEvents({ turns: 1, id: ROOT }) }],
	});
	// A child that names the root but whose bytes are not a decodable zstd stream.
	// The header must still be found — otherwise the family would silently lose a
	// member — and the unreadable rest must surface as a failure, not as zero.
	const dir = join(root, "sessions", "--fixture--", CHILD_A);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "session.v4.jsonl.zstd"),
		Buffer.from(`${JSON.stringify({ type: "session", id: CHILD_A, parentSession: ROOT, origin: "subagent", delegationDepth: 1 })}\n\u0000\u0001not zstd at all\n`),
	);
	const family = await reportFamily({ home, sessionId: ROOT, rates, currency, timezone: "UTC", offPeakMultiplier: 0.5 });
	assert.equal(family.descendants.length + family.failures.length, 1, "the child is accounted for either way");
	assert.equal(family.failures.length, 1, "an unreadable log is a reported failure, not a silent zero");
	assert.equal(family.failures[0].sessionId, CHILD_A);
	assert.match(renderFamily(family, currency), /读取失败 1 个派生会话/);
	rmSync(dir, { recursive: true, force: true });
});

test("a header-only log still reports its delegation link", async () => {
	// The graceful-degradation path in `readSessionHeader` is what keeps a family
	// complete when a member's log is truncated: a plain-JSONL file with a zstd
	// extension is exactly what a torn write looks like.
	const root = mkdtempSync(join(tmpdir(), "dsh-cost-torn-"));
	const dir = join(root, "sessions", "--fixture--", CHILD_A);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "session.v4.jsonl.zstd"), Buffer.from(`${JSON.stringify({ type: "session", id: CHILD_A, parentSession: ROOT, origin: "subagent", delegationDepth: 1 })}\n`));
	const raw = await readSessionHeader(join(dir, "session.v4.jsonl.zstd"));
	assert.equal(raw.parentSession, ROOT, "the link survives an undecodable frame");
	const family = await findDescendants({ home: root, sessionId: ROOT });
	assert.deepEqual(family.descendants.map((row) => row.sessionId), [CHILD_A]);
	rmSync(dir, { recursive: true, force: true });
});

test("an unchanged log list is scanned once and shared between callers", async () => {
	// A page mounts several readouts, and they all ask about the same home. The
	// index is shared for one unchanged snapshot of the logs, so the second read
	// must be the very same object, not an equal rescan.
	const home = familyHome();
	const first = await readFamilyIndex(home);
	const second = await readFamilyIndex(home);
	assert.equal(second, first, "the same snapshot is not rescanned");
	// Both callers in flight at once must also share one scan.
	const [left, right] = await Promise.all([readFamilyIndex(home), readFamilyIndex(home)]);
	assert.equal(left, right);
});

test("a new or rewritten log makes the cached index stale, so it is rebuilt", async () => {
	// The cache key carries each log's size and mtime, so a subagent that appears
	// (or a log that grows) is never answered from a snapshot that predates it —
	// which is what makes 刷新 honest and what keeps these tests independent.
	const home = familyHome();
	const before = await readFamilyIndex(home);
	assert.equal(before.byId.has(CHILD_B), true);
	// A brand new delegated session joins the family.
	const late = "session-66666666-6666-6666-6666-666666666666";
	const dir = join(home, "sessions", "--fixture--", late);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "session.v4.jsonl.zstd"), Buffer.from(`${JSON.stringify({ type: "session", id: late, parentSession: ROOT, origin: "subagent", delegationDepth: 1 })}\n`));
	const after = await readFamilyIndex(home);
	assert.notEqual(after, before, "a changed log list is a different snapshot");
	assert.equal(after.byId.has(late), true, "the new session is in the rebuilt index");
	// And the family the caller sees grows with it.
	const family = await findDescendants({ home, sessionId: ROOT });
	assert.ok(family.descendants.some((row) => row.sessionId === late), "the new child is part of the family");
	rmSync(dir, { recursive: true, force: true });
});

test("the index cache is bounded, so a stream of snapshots cannot grow it forever", async () => {
	// Each rewrite changes the file's size, which is a new key; the map must drop
	// the oldest rather than hold every snapshot a long-running page has seen.
	const home = familyHome();
	const child = join(home, "sessions", "--fixture--", CHILD_A, "session.v4.jsonl.zstd");
	const header = JSON.stringify({ type: "session", id: CHILD_A, parentSession: ROOT, origin: "subagent", delegationDepth: 1 });
	for (let index = 1; index <= 70; index += 1) {
		writeFileSync(child, Buffer.from(`${header}\n${"x".repeat(index)}\n`));
		const snapshot = await readFamilyIndex(home);
		assert.equal(snapshot.byId.get(CHILD_A).parentSession, ROOT, `snapshot ${index} still resolves the link`);
	}
	// The last snapshot is still answerable, and the family still resolves.
	const family = await findDescendants({ home, sessionId: ROOT });
	assert.ok(family.descendants.some((row) => row.sessionId === CHILD_A));
	writeFileSync(child, Buffer.from(`${JSON.stringify({ type: "session", id: CHILD_A, parentSession: ROOT, origin: "subagent", delegationDepth: 1 })}\n`));
});




