/**
 * Command-surface tests: `/cost` input parsing, the live and stored paths, the
 * `--all` listing, and the fail-soft behaviour when the config is broken.
 *
 * Run: node --test --test-isolation=none test/command.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CURRENCY, DEFAULT_RATES } from "../lib/rates.js";
import { makeCtx, makeHome, makeLiveSession, makeSessionEvents } from "./helpers.js";

const testDir = new URL(".", import.meta.url).pathname;

/** The row config as DSH hands it over. */
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

function fixtureHome() {
	const root = mkdtempSync(join(tmpdir(), "dsh-cost-cmd-"));
	const events = makeSessionEvents({ turns: 2, id: "session-dddddddd-dddd-dddd-dddd-dddddddddddd" });
	const { home } = makeHome({
		root,
		sessions: [{ id: "session-dddddddd-dddd-dddd-dddd-dddddddddddd", title: "命令行统计的对话", events }],
	});
	return home;
}

async function loadCommand() {
	return import("../lib/command.js");
}

test("parseCostInput splits flags from the target", async () => {
	const { parseCostInput } = await loadCommand();
	assert.deepEqual(parseCostInput(""), { all: false, detail: false, family: false, target: "" });
	assert.deepEqual(parseCostInput("--detail"), { all: false, detail: true, family: false, target: "" });
	assert.deepEqual(parseCostInput("--family"), { all: false, detail: false, family: true, target: "" });
	assert.deepEqual(parseCostInput("--turns 3 --detail"), { all: false, detail: true, family: false, turns: 3, target: "" });
	assert.deepEqual(parseCostInput("--steps 10"), { all: false, detail: false, family: false, steps: 10, target: "" });
	assert.deepEqual(parseCostInput("--turns=5 我的对话"), { all: false, detail: false, family: false, turns: 5, target: "我的对话" });
	assert.deepEqual(parseCostInput("--all --limit 5"), { all: true, detail: false, family: false, limit: 5, target: "" });
	assert.deepEqual(parseCostInput("某个标题"), { all: false, detail: false, family: false, target: "某个标题" });
	// `--family` combines with a target and does not leak into it.
	assert.deepEqual(parseCostInput("--family 某个标题"), { all: false, detail: false, family: true, target: "某个标题" });
	// A malformed number is ignored rather than becoming a NaN limit.
	assert.deepEqual(parseCostInput("--turns 0"), { all: false, detail: false, family: false, target: "" });
	assert.deepEqual(parseCostInput("--limit abc"), { all: false, detail: false, family: false, target: "" });
	assert.deepEqual(parseCostInput("--steps -3"), { all: false, detail: false, family: false, target: "" });
});

test("the command row mounts, registers /cost, and reports usable config", async () => {
	const { apply, inject, name, Config } = await loadCommand();
	assert.equal(name, "command-session-cost");
	assert.deepEqual(inject, ["commands"]);
	assert.ok(Config.shape.rates);
	const ctx = makeCtx();
	apply(ctx, liveConfig());
	assert.deepEqual(ctx.commands.map((command) => command.name), ["cost"]);
	assert.match(ctx.commands[0].description, /token/);
	assert.equal(ctx.commands[0].input.hint.includes("--detail"), true);
});

test("/cost with no target reports the calling conversation", async () => {
	const { apply } = await loadCommand();
	const ctx = makeCtx();
	apply(ctx, liveConfig());
	const command = ctx.commands[0];
	const result = await command.handler({ agent: { session: makeLiveSession(makeSessionEvents({ turns: 2 })) }, rawInput: "" });
	assert.equal(result.kind, "success");
	assert.match(result.text, /总 token：3,360/);
	// The installed default table is the account's CNY list, so the readout is ¥.
	assert.match(result.text, /金额：¥/);
	assert.match(result.text, /来源：宿主内存/);
});
test("/cost --turns 1 scopes the report", async () => {
	const { apply } = await loadCommand();
	const ctx = makeCtx();
	apply(ctx, liveConfig());
	const result = await ctx.commands[0].handler({ agent: { session: makeLiveSession(makeSessionEvents({ turns: 3 })) }, rawInput: "--turns 1" });
	assert.equal(result.kind, "success");
	assert.match(result.text, /最近 1 轮/);
	assert.match(result.text, /1 次模型调用/);
	// Turn 3 of the fixture carries 300 input, 60 output, 3000 cache reads.
	assert.match(result.text, /总 token：3,360/);
});

test("/cost --detail adds the per-bucket price table", async () => {
	const { apply } = await loadCommand();
	const ctx = makeCtx();
	apply(ctx, liveConfig());
	const result = await ctx.commands[0].handler({ agent: { session: makeLiveSession(makeSessionEvents({ turns: 1 })) }, rawInput: "--detail" });
	assert.match(result.text, /按模型/);
	// Off-peak flash cache-miss price from the installed CNY table: 1 元/1M.
	assert.match(result.text, /× ¥1\/1M/);
});

test("/cost <title> reads a stored conversation from disk", async () => {
	const { apply } = await loadCommand();
	const home = fixtureHome();
	const ctx = makeCtx();
	apply(ctx, liveConfig({ dshHome: home }));
	const result = await ctx.commands[0].handler({ agent: undefined, rawInput: "命令行统计的对话" });
	assert.equal(result.kind, "success");
	assert.match(result.text, /命令行统计的对话/);
	assert.match(result.text, /来源：磁盘日志/);
});

test("/cost --all lists stored conversations with a total", async () => {
	const { apply } = await loadCommand();
	const home = fixtureHome();
	const ctx = makeCtx();
	apply(ctx, liveConfig({ dshHome: home }));
	const result = await ctx.commands[0].handler({ agent: undefined, rawInput: "--all" });
	assert.equal(result.kind, "success");
	assert.match(result.text, /合计 ¥/);
	assert.match(result.text, /命令行统计的对话/);
});

test("/cost reports an unknown target and an ambiguous one as errors with candidates", async () => {
	const { apply } = await loadCommand();
	const root = mkdtempSync(join(tmpdir(), "dsh-cost-cmd-amb-"));
	const { home } = makeHome({
		root,
		sessions: [
			{ id: "session-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", title: "重复标题", events: makeSessionEvents({ turns: 1, id: "session-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" }) },
			{ id: "session-ffffffff-ffff-ffff-ffff-ffffffffffff", title: "重复标题二号", events: makeSessionEvents({ turns: 1, id: "session-ffffffff-ffff-ffff-ffff-ffffffffffff" }) },
		],
	});
	const ctx = makeCtx();
	apply(ctx, liveConfig({ dshHome: home }));
	const missing = await ctx.commands[0].handler({ agent: undefined, rawInput: "没有这个对话" });
	assert.equal(missing.kind, "error");
	assert.match(missing.text, /找不到匹配/);
	assert.match(missing.text, /已知对话/);
	const ambiguous = await ctx.commands[0].handler({ agent: undefined, rawInput: "重复标题" });
	assert.equal(ambiguous.kind, "error");
	assert.match(ambiguous.text, /不唯一/);
	assert.match(ambiguous.text, /session-eeeeeeee/);
});

test("/cost fails soft with a readable error when the rate table is broken", async () => {
	const { apply } = await loadCommand();
	const ctx = makeCtx();
	apply(ctx, liveConfig({ rates: "{oops" }));
	const result = await ctx.commands[0].handler({ agent: { session: makeLiveSession(makeSessionEvents({ turns: 1 })) }, rawInput: "" });
	assert.equal(result.kind, "error");
	assert.match(result.text, /价格配置有误/);
	assert.match(result.text, /用法/);
});

test("/cost with no agent and no target explains itself instead of throwing", async () => {
	const { apply } = await loadCommand();
	const home = fixtureHome();
	const ctx = makeCtx();
	apply(ctx, liveConfig({ dshHome: home }));
	const result = await ctx.commands[0].handler({ agent: undefined, rawInput: "" });
	assert.equal(result.kind, "error");
	assert.match(result.text, /找不到匹配/);
});
