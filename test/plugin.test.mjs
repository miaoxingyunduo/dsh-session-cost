/**
 * Plugin-level tests: row config validation at mount, tool registration and
 * output schemas, the browser-facing Fetch routes, and both execute paths
 * (live session in memory, stored session on disk).
 *
 * The `@deepseek-ai/*` peer packages are stubbed under test/.deps; a junction at
 * test/node_modules makes Node resolve them from lib/, so the real
 * lib/index.js runs unchanged.
 *
 * Run: node --test --test-isolation=none test/plugin.test.mjs
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RATES, DEFAULT_CURRENCY } from "../lib/rates.js";
import { makeCtx, makeHome, makeLiveSession, makeSessionEvents } from "./helpers.js";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const stubDir = join(testDir, ".deps", "node_modules");

before(() => {
	// Node resolves a bare import by walking `node_modules` directories upward
	// from the importing file, and lib/index.js sits in lib/. So the stub tree is
	// linked at the package root (and at test/, for this file's own imports). The
	// links are created here and are excluded from the published files list.
	mkdirSync(stubDir, { recursive: true });
	for (const link of [join(packageDir, "node_modules"), join(testDir, "node_modules")]) {
		if (!existsSync(link)) symlinkSync(stubDir, link, "junction");
	}
});

/** The row config as DSH would hand it over: volatile refs with `.get()`. */
function liveConfig(overrides = {}) {
	const values = {
		rates: JSON.stringify(DEFAULT_RATES),
		currency: JSON.stringify(DEFAULT_CURRENCY),
		offPeakMultiplier: 0.5,
		offPeakTimezone: "UTC",
		dshHome: "",
		...overrides,
	};
	const config = {};
	for (const [key, value] of Object.entries(values)) config[key] = { get: () => value };
	return config;
}

/** One throwaway DSH home with a single priced session. */
function fixtureHome() {
	const root = mkdtempSync(join(tmpdir(), "dsh-cost-plugin-"));
	const events = makeSessionEvents({ turns: 2, id: "session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
	const { home } = makeHome({
		root,
		sessions: [{ id: "session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", title: "被统计的对话", events }],
	});
	return home;
}

/** Load the plugin module once. */
async function loadPlugin() {
	return import("../lib/index.js");
}

test("apply mounts with defaults and registers exactly the two cost tools", async () => {
	const { apply, Config, inject, name } = await loadPlugin();
	assert.equal(name, "session-cost");
	assert.deepEqual(inject, ["tools"]);
	assert.ok(Config.shape.rates, "the rates field is part of the row config");
	const ctx = makeCtx();
	apply(ctx, liveConfig());
	assert.deepEqual(ctx.tools.map((tool) => tool.name), ["session_cost", "list_session_costs"]);
	assert.equal(ctx.logs.length, 1, "mount logs one line naming the loaded pricing");
	assert.match(ctx.logs[0][1], /2 priced model\(s\)/);
});

test("apply fails loudly at mount on a broken rate table instead of pricing everything at zero", async () => {
	const { apply } = await loadPlugin();
	assert.throws(() => apply(makeCtx(), liveConfig({ rates: "{not json" })), /rates is not valid JSON/);
	assert.throws(() => apply(makeCtx(), liveConfig({ rates: JSON.stringify({ "p/m": { input: -1, output: 1 } }) })), /must be a finite number >= 0/);
	assert.throws(() => apply(makeCtx(), liveConfig({ currency: "{\"perUsd\":0}" })), /perUsd must be greater than 0/);
});

test("the tools declare their parameters and a required text output", async () => {
	const { apply } = await loadPlugin();
	const ctx = makeCtx();
	apply(ctx, liveConfig());
	const [sessionCost, listing] = ctx.tools;
	assert.deepEqual(Object.keys(sessionCost.parameters).sort(), ["detail", "includeDescendants", "session", "steps", "turns"]);
	assert.equal(sessionCost.output.schema.properties.text.required, true);
	assert.equal(typeof sessionCost.output.render, "function");
	assert.match(sessionCost.description, /per-model rates/);
	assert.deepEqual(Object.keys(listing.parameters), ["limit"]);
	assert.equal(listing.output.schema.properties.rows.items.properties.sessionId.required, true);
});

test("session_cost prices the calling conversation from host memory", async () => {
	const { apply } = await loadPlugin();
	const ctx = makeCtx();
	apply(ctx, liveConfig());
	const tool = ctx.tools.find((row) => row.name === "session_cost");
	const events = makeSessionEvents({ turns: 2 });
	const value = await tool.execute({}, { agent: { session: makeLiveSession(events) } });
	assert.equal(value.source, "live");
	assert.equal(value.attempts, 2);
	assert.equal(value.uncachedInputTokens, 300);
	assert.equal(value.cacheReadTokens, 3000);
	assert.equal(value.outputTokens, 60);
	assert.equal(value.tokens, 3360);
	assert.equal(value.sessionId, "session-11111111-1111-1111-1111-111111111111");
	assert.deepEqual(value.pricedModels, ["deepseek-official/deepseek-flash"]);
	assert.deepEqual(value.unpricedModels, []);
	assert.ok(value.usd > 0);
	assert.equal(value.amountText, value.amountText.replace(/^\$/, "$"), "amount text is formatted in the display currency");
	assert.match(value.text, /来源：宿主内存/);
	assert.match(value.text, /输入\(命中缓存\)/);
});

test("session_cost scopes to the trailing turns it is asked for", async () => {
	const { apply } = await loadPlugin();
	const ctx = makeCtx();
	apply(ctx, liveConfig());
	const tool = ctx.tools.find((row) => row.name === "session_cost");
	const value = await tool.execute({ turns: 1 }, { agent: { session: makeLiveSession(makeSessionEvents({ turns: 3 })) } });
	assert.equal(value.attempts, 1);
	assert.equal(value.uncachedInputTokens, 300);
	assert.match(value.text, /最近 1 轮/);
});

test("session_cost scopes to the trailing model calls when asked for steps", async () => {
	const { apply } = await loadPlugin();
	const ctx = makeCtx();
	apply(ctx, liveConfig());
	const tool = ctx.tools.find((row) => row.name === "session_cost");
	const value = await tool.execute({ steps: 2 }, { agent: { session: makeLiveSession(makeSessionEvents({ turns: 3 })) } });
	assert.equal(value.attempts, 2);
	assert.equal(value.uncachedInputTokens, 500, "the last two steps' 200 + 300 input tokens");
	assert.match(value.text, /最近 2 次模型调用/);
});

test("session_cost with includeDescendants adds the family and keeps the two figures apart", async () => {
	const { apply } = await loadPlugin();
	// A root with one delegated child, so the rollup has something to add.
	const root = mkdtempSync(join(tmpdir(), "dsh-cost-plugin-family-"));
	const parentId = "session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
	const childId = "session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
	const { home } = makeHome({
		root,
		sessions: [
			{ id: parentId, title: "带子代理的对话", events: makeSessionEvents({ turns: 1, id: parentId }) },
			{ id: childId, title: "子代理", events: makeSessionEvents({ turns: 1, id: childId, parentSession: parentId, origin: "subagent", delegationDepth: 1 }) },
		],
	});
	const ctx = makeCtx();
	apply(ctx, liveConfig({ dshHome: home }));
	const tool = ctx.tools.find((row) => row.name === "session_cost");

	const alone = await tool.execute({ session: "带子代理的对话" }, {});
	assert.equal(alone.source, "stored");
	assert.equal(alone.tokens, 1120, "without the flag, the session alone");

	const family = await tool.execute({ session: "带子代理的对话", includeDescendants: true }, {});
	assert.equal(family.source, "family");
	assert.equal(family.selfTokens, 1120);
	assert.equal(family.descendantCount, 1);
	assert.equal(family.descendantTokens, 1120);
	assert.equal(family.tokens, 2240, "the combined total is what the flag is for");
	assert.ok(family.usd > alone.usd);
	assert.match(family.text, /本会话自身：1,120 token/);
	assert.match(family.text, /派生会话：1 个/);
	assert.match(family.text, /合计：2,240 token/);
	assert.deepEqual(family.missingParents, []);
});

test("includeDescendants on a leaf conversation says there is no family", async () => {
	const { apply } = await loadPlugin();
	const home = fixtureHome();
	const ctx = makeCtx();
	apply(ctx, liveConfig({ dshHome: home }));
	const tool = ctx.tools.find((row) => row.name === "session_cost");
	const value = await tool.execute({ session: "被统计的对话", includeDescendants: true }, {});
	assert.equal(value.descendantCount, 0);
	assert.equal(value.tokens, value.selfTokens, "no family means the total equals the session");
	assert.match(value.text, /派生会话：无/);
});

test("session_cost prices a stored conversation by title or id", async () => {
	const { apply } = await loadPlugin();
	const home = fixtureHome();
	const ctx = makeCtx();
	apply(ctx, liveConfig({ dshHome: home }));
	const tool = ctx.tools.find((row) => row.name === "session_cost");
	const byTitle = await tool.execute({ session: "被统计的对话" }, {});
	assert.equal(byTitle.source, "stored");
	assert.equal(byTitle.title, "被统计的对话");
	assert.equal(byTitle.attempts, 2);
	const byId = await tool.execute({ session: "session-aaaaaaaa", detail: true }, {});
	assert.equal(byId.sessionId, "session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
	assert.match(byId.text, /按模型/);
});

test("session_cost refuses an ambiguous target and lists the candidates", async () => {
	const { apply } = await loadPlugin();
	const root = mkdtempSync(join(tmpdir(), "dsh-cost-ambiguous-"));
	const { home } = makeHome({
		root,
		sessions: [
			{ id: "session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "两个中的第一个", events: makeSessionEvents({ turns: 1, id: "session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }) },
			{ id: "session-cccccccc-cccc-cccc-cccc-cccccccccccc", title: "两个中的第二个", events: makeSessionEvents({ turns: 1, id: "session-cccccccc-cccc-cccc-cccc-cccccccccccc" }) },
		],
	});
	const ctx = makeCtx();
	apply(ctx, liveConfig({ dshHome: home }));
	const tool = ctx.tools.find((row) => row.name === "session_cost");
	await assert.rejects(() => tool.execute({ session: "session-" }, {}), /matches 2 conversations/);
	await assert.rejects(() => tool.execute({ session: "两个" }, {}), /matches 2 conversations/);
});

test("session_cost reports a missing target with the known conversations", async () => {
	const { apply } = await loadPlugin();
	const home = fixtureHome();
	const ctx = makeCtx();
	apply(ctx, liveConfig({ dshHome: home }));
	const tool = ctx.tools.find((row) => row.name === "session_cost");
	await assert.rejects(() => tool.execute({ session: "does-not-exist" }, {}), /no conversation matches/);
});

test("session_cost counts an unconfigured model's tokens but prices them at nothing", async () => {
	const { apply } = await loadPlugin();
	const ctx = makeCtx();
	const rates = JSON.stringify({ "deepseek-official/deepseek-flash": { input: 1, output: 1 } });
	apply(ctx, liveConfig({ rates }));
	const tool = ctx.tools.find((row) => row.name === "session_cost");
	// One priced conversation plus one call on a model with no configured rate.
	const events = [
		...makeSessionEvents({ turns: 1 }),
		{
			type: "assistant/message",
			seq: 99,
			time: Date.UTC(2026, 0, 5, 12, 0),
			data: { turn: 2, step: 1, usage: { inputTokens: 500, outputTokens: 500 }, message: { source: { provider: "vendor-x", model: "mystery" } } },
		},
	];
	const value = await tool.execute({}, { agent: { session: makeLiveSession(events) } });
	assert.deepEqual(value.unpricedModels, ["vendor-x/mystery"]);
	assert.deepEqual(value.pricedModels, ["deepseek-official/deepseek-flash"]);
	assert.equal(value.tokens, 1120 + 1000, "the unpriced route's tokens are still counted");
	assert.equal(value.attempts, 2);
	assert.match(value.text, /未配置价格/);
	assert.match(value.text, /1,000 token 未配置价格/, "the report names how many tokens went unpriced");
});

test("list_session_costs lists every stored conversation and totals them", async () => {
	const { apply } = await loadPlugin();
	const home = fixtureHome();
	const ctx = makeCtx();
	apply(ctx, liveConfig({ dshHome: home }));
	const tool = ctx.tools.find((row) => row.name === "list_session_costs");
	const value = await tool.execute({}, {});
	assert.equal(value.count, 1);
	assert.equal(value.rows.length, 1);
	assert.equal(value.rows[0].sessionId, "session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
	assert.equal(value.rows[0].title, "被统计的对话");
	assert.equal(value.rows[0].priced, true);
	assert.ok(value.totalTokens > 0);
	assert.ok(value.totalAmount > 0);
	assert.match(value.text, /共 1 个对话/);
});

test("an empty home yields an empty listing rather than an error", async () => {
	const { apply } = await loadPlugin();
	const empty = mkdtempSync(join(tmpdir(), "dsh-cost-empty-home-"));
	const ctx = makeCtx();
	apply(ctx, liveConfig({ dshHome: empty }));
	const tool = ctx.tools.find((row) => row.name === "list_session_costs");
	const value = await tool.execute({}, {});
	assert.equal(value.count, 0);
	assert.equal(value.totalTokens, 0);
	assert.equal(value.totalAmount, 0);
});

test("the browser routes are optional: no connection service means no route and no failure", async () => {
	const { apply } = await loadPlugin();
	const ctx = makeCtx({ connection: false });
	apply(ctx, liveConfig());
	assert.deepEqual(ctx.injects, [["connection"]]);
	assert.equal(ctx.routes.length, 0);
	assert.equal(ctx.tools.length, 2, "the tools still mount on a Host with no browser transport");
});

test("the config route hands the page the live rate table and its revision", async () => {
	const { apply, CONFIG_PATH, VERIFY_PATH, FAMILY_PATH } = await loadPlugin();
	const ctx = makeCtx({ connection: true });
	apply(ctx, liveConfig());
	assert.deepEqual(ctx.routes.map((route) => route.path).sort(), [CONFIG_PATH, FAMILY_PATH, VERIFY_PATH].sort());
	// `requestBody` is the connection's body READ mode, and the shipped contract
	// allows exactly two values. A third value made the shared handler build a GET
	// Request with a stream body, which the platform rejects with HTTP 400 — the
	// page then showed "金额统计不可用：HTTP 400". Guard the contract, not just the value.
	const CONNECTION_REQUEST_BODY_MODES = ["buffered", "streaming"];
	for (const row of ctx.routes) {
		assert.ok(
			CONNECTION_REQUEST_BODY_MODES.includes(row.requestBody),
			`${row.path} declares requestBody "${row.requestBody}", which is not one of ${CONNECTION_REQUEST_BODY_MODES.join(", ")}`,
		);
	}
	const route = ctx.routes.find((row) => row.path === CONFIG_PATH);
	assert.deepEqual(route.methods, ["GET"]);
	assert.equal(route.requestBody, "buffered");
	// A GET route must tolerate a body-less request: the connection hands the
	// handler the Request it built, and this handler never reads the body.
	const response = await route.fetch(new Request(`http://localhost${CONFIG_PATH}`, { method: "GET" }));
	const body = await response.json();
	assert.equal(body.ok, true);
	assert.ok(body.revision.length > 0);
	// The defaults describe the account: CNY list prices, peak column stored.
	assert.equal(body.rates["deepseek-official/deepseek-flash"].cacheRead, 0.04);
	assert.equal(body.currency.code, "CNY");
	assert.equal(body.currency.symbol, "¥");
	assert.equal(body.offPeakTimezone, "UTC");
	// The page mirrors the Host's peak decision, so the holiday calendar rides along.
	assert.ok(Array.isArray(body.offPeakHolidays) && body.offPeakHolidays.includes("2026-10-05"));
});

test("a broken rate table fails at mount, before any route or tool can serve a wrong price", async () => {
	const { apply } = await loadPlugin();
	assert.throws(() => apply(makeCtx({ connection: true }), liveConfig({ rates: "{broken" })), /rates is not valid JSON/);
});

test("the config route validates at answer time too, so a hot config edit cannot crash the page", async () => {
	const { apply, CONFIG_PATH } = await loadPlugin();
	// Mount with a valid table, then flip the live ref to a broken value: this is
	// what a Plugins-page edit that lands a typo looks like from the row's side.
	let rates = JSON.stringify(DEFAULT_RATES);
	const config = liveConfig();
	config.rates = { get: () => rates };
	const ctx = makeCtx({ connection: true });
	apply(ctx, config);
	const route = ctx.routes.find((row) => row.path === CONFIG_PATH);
	assert.equal((await (await route.fetch()).json()).ok, true);
	rates = "{broken";
	const body = await (await route.fetch()).json();
	assert.equal(body.ok, false);
	assert.match(body.error, /not valid JSON/);
});

test("the verify route recomputes a stored conversation from the log", async () => {
	const { apply, VERIFY_PATH } = await loadPlugin();
	const home = fixtureHome();
	const ctx = makeCtx({ connection: true });
	apply(ctx, liveConfig({ dshHome: home }));
	const route = ctx.routes.find((row) => row.path === VERIFY_PATH);
	const response = await route.fetch(new Request("http://localhost/api/session-cost/verify", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ target: "被统计的对话", detail: true }),
	}));
	const body = await response.json();
	assert.equal(body.ok, true);
	assert.equal(body.sessionId, "session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
	assert.equal(body.tokens, 3360);
	assert.equal(body.buckets.cacheReadTokens, 3000);
	assert.ok(body.microUsd > 0);
	assert.match(body.text, /被统计的对话/);
	assert.equal(body.routes.length, 1);
});

test("the family route reports a conversation's delegated sessions to the page", async () => {
	const { apply, FAMILY_PATH } = await loadPlugin();
	const root = mkdtempSync(join(tmpdir(), "dsh-cost-family-route-"));
	const parentId = "session-cccccccc-cccc-cccc-cccc-cccccccccccc";
	const childId = "session-dddddddd-dddd-dddd-dddd-dddddddddddd";
	const { home } = makeHome({
		root,
		sessions: [
			{ id: parentId, title: "父", events: makeSessionEvents({ turns: 1, id: parentId }) },
			{ id: childId, events: makeSessionEvents({ turns: 1, id: childId, parentSession: parentId, origin: "subagent", delegationDepth: 1 }) },
		],
	});
	const ctx = makeCtx({ connection: true });
	apply(ctx, liveConfig({ dshHome: home }));
	const route = ctx.routes.find((row) => row.path === FAMILY_PATH);
	const response = await route.fetch(new Request(`http://localhost${FAMILY_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId: parentId }),
	}));
	const body = await response.json();
	assert.equal(body.ok, true);
	assert.equal(body.sessionId, parentId);
	assert.equal(body.self.tokens, 1120);
	assert.equal(body.descendantCount, 1);
	assert.equal(body.descendants[0].sessionId, childId);
	assert.equal(body.descendants[0].origin, "subagent");
	assert.equal(body.total.tokens, 2240);
	// The browser half adds `total.descendantMicroUsd` to the live session's own
	// figure, so the route must keep sending it — without it the pill would
	// silently go back to showing the main session alone.
	assert.equal(typeof body.total.descendantMicroUsd, "number");
	assert.equal(body.total.descendantTokens, 1120);
	// The combined figure is the session's own plus the descendants', and the
	// route states all three so the page never has to infer one from the others.
	assert.equal(body.total.microUsd, body.self.microUsd + body.total.descendantMicroUsd);
	assert.equal(body.total.usd, body.total.microUsd / 1_000_000);
	assert.match(body.total.display, /^¥/);
	assert.match(body.text, /合计：2,240 token/);
});

test("the family route rejects a request without a session id", async () => {
	const { apply, FAMILY_PATH } = await loadPlugin();
	const home = fixtureHome();
	const ctx = makeCtx({ connection: true });
	apply(ctx, liveConfig({ dshHome: home }));
	const route = ctx.routes.find((row) => row.path === FAMILY_PATH);
	const bad = await route.fetch(new Request("http://localhost/x", { method: "POST", body: "not json" }));
	assert.equal(bad.status, 400);
	const empty = await route.fetch(new Request("http://localhost/x", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({}),
	}));
	assert.equal(empty.status, 400);
	const unknown = await route.fetch(new Request("http://localhost/x", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId: "session-00000000-0000-0000-0000-000000000000" }),
	}));
	const body = await unknown.json();
	assert.equal(body.ok, false);
});

test("the verify route answers a malformed body and an unknown target as errors, not crashes", async () => {
	const { apply, VERIFY_PATH } = await loadPlugin();
	const home = fixtureHome();
	const ctx = makeCtx({ connection: true });
	apply(ctx, liveConfig({ dshHome: home }));
	const route = ctx.routes.find((row) => row.path === VERIFY_PATH);
	const bad = await route.fetch(new Request("http://localhost/x", { method: "POST", body: "not json" }));
	assert.equal(bad.status, 400);
	const unknown = await route.fetch(new Request("http://localhost/x", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ target: "nowhere" }),
	}));
	const body = await unknown.json();
	assert.equal(body.ok, false);
	assert.equal(body.kind, "not-found");
});
