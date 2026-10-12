/**
 * Installer tests: the managed block must be valid YAML whose block scalars
 * decode to exactly the JSON text the row config expects, and applying it must
 * be idempotent, reversible, and safe on every patch-file shape DSH produces.
 *
 * The block builders are imported and driven in-process; a real YAML parser
 * (vendored beside the dsh-vision tests) checks the emitted patch instead of a
 * hand-rolled approximation. The CLI's end-to-end file effects were verified by
 * running it against a throwaway DSH home; they are not asserted here because
 * this sandbox blocks child processes.
 *
 * Run: node --test --test-isolation=none test/install.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { DEFAULT_CURRENCY, DEFAULT_OFF_PEAK_MULTIPLIER, DEFAULT_RATES } from "../lib/rates.js";
import { applyManagedBlock, buildManagedBlock } from "../install/install.mjs";

const yamlModule = fileURLToPath(new URL("../../dsh-vision/test/.vendor/yml/node_modules/yaml/dist/index.js", import.meta.url));
const { parse: parseYaml } = await import(`file://${yamlModule.replace(/\\/gu, "/")}`);

const START = "# >>> dsh-session-cost";
const END = "# <<< dsh-session-cost";

/** The block the installer writes by default. */
function defaultBlock(overrides = {}) {
	return buildManagedBlock({
		rates: DEFAULT_RATES,
		currency: DEFAULT_CURRENCY,
		offPeakMultiplier: DEFAULT_OFF_PEAK_MULTIPLIER,
		offPeakTimezone: "UTC",
		// Left empty, which is what the CLI does: the module's built-in holiday
		// calendar then applies, so a corrected list needs no profile edit.
		offPeakHolidays: "",
		dshHome: "",
		...overrides,
	});
}

/** The plugin rows of a patch document. */
function rowsOf(text) {
	const document = parseYaml(text);
	const rows = Array.isArray(document) ? document : [];
	return rows.filter((row) => row !== null && typeof row === "object" && String(row.name ?? "").includes("dsh-session-cost"));
}

test("the managed block is valid YAML and configures both rows", () => {
	const rows = rowsOf(defaultBlock());
	assert.deepEqual(rows.map((row) => row.id), ["session-cost", "session-cost-command"]);
	assert.deepEqual(rows.map((row) => row.name), ["@local/dsh-session-cost", "@local/dsh-session-cost"]);
});

test("the JSON block scalars decode to exactly what the plugin's parser expects", () => {
	for (const row of rowsOf(defaultBlock())) {
		// The row stores JSON *text*; the parsed block scalar must be that text, and
		// must itself parse to the configured object.
		assert.equal(typeof row.config.rates, "string");
		assert.deepEqual(JSON.parse(row.config.rates), DEFAULT_RATES);
		assert.deepEqual(JSON.parse(row.config.currency), DEFAULT_CURRENCY);
		assert.equal(row.config.offPeakMultiplier, DEFAULT_OFF_PEAK_MULTIPLIER);
		assert.equal(row.config.offPeakTimezone, "UTC");
		assert.equal(row.config.dshHome, "");
		assert.equal(row.config.offPeakHolidays, undefined, "an empty calendar is omitted, so the module's built-in list applies");
	}
});

test("a custom holiday calendar reaches the block", () => {
	const block = defaultBlock({ offPeakHolidays: "2027-01-01,2027-02-06" });
	for (const row of rowsOf(block)) {
		assert.equal(row.config.offPeakHolidays, "2027-01-01,2027-02-06");
	}
});

test("custom rates, currency, multiplier, timezone and home reach the block", () => {
	const rates = { ...DEFAULT_RATES, "vendor-x/mystery": { input: 1, output: 2 } };
	const block = defaultBlock({
		rates,
		currency: { symbol: "¥", code: "CNY", perUsd: 7.2 },
		offPeakMultiplier: 0.75,
		offPeakTimezone: "Asia/Shanghai",
		dshHome: "D:\\dsh-home",
	});
	for (const row of rowsOf(block)) {
		assert.deepEqual(JSON.parse(row.config.rates), rates);
		assert.equal(JSON.parse(row.config.currency).symbol, "¥");
		assert.equal(row.config.offPeakMultiplier, 0.75);
		assert.equal(row.config.offPeakTimezone, "Asia/Shanghai");
		assert.equal(row.config.dshHome, "D:\\dsh-home");
	}
});

test("a value containing a single quote survives YAML quoting", () => {
	const block = defaultBlock({ offPeakTimezone: "It's/UTC" });
	const [row] = rowsOf(block);
	assert.equal(row.config.offPeakTimezone, "It's/UTC");
});

test("applying to a fresh empty patch replaces the `[]` instead of appending to it", () => {
	const original = "# Your patch layer for this dsh profile\n[]\n";
	const result = applyManagedBlock(original, defaultBlock());
	assert.equal(result.changed, true);
	assert.equal(result.hasBlock, false);
	assert.match(result.text, /# Your patch layer/);
	assert.ok(!result.text.includes("[]"), "the empty flow sequence is gone");
	assert.deepEqual(rowsOf(result.text).length, 2);
});

test("applying to an existing patch document appends without breaking it", () => {
	const original = [
		"# user patch",
		"- id: ui-chat",
		"  name: \"@deepseek-ai/dsh-client-ui-chat\"",
		"  config:",
		"    transcriptView: standard",
		"",
	].join("\n");
	const result = applyManagedBlock(original, defaultBlock());
	const document = parseYaml(result.text);
	assert.equal(document.length, 3, "the user's row is still the first one");
	assert.equal(document[0].id, "ui-chat");
	assert.deepEqual(rowsOf(result.text).map((row) => row.id), ["session-cost", "session-cost-command"]);
});

test("re-applying replaces the block in place, so re-installing is idempotent", () => {
	const first = applyManagedBlock("# user patch\n[]\n", defaultBlock());
	assert.equal(first.changed, true);
	const again = applyManagedBlock(first.text, defaultBlock());
	assert.equal(again.changed, false, "the same values produce byte-identical text");
	assert.equal(again.text, first.text);
	assert.equal((again.text.match(new RegExp(START.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu")) ?? []).length, 1, "exactly one block");
	// Different values rewrite the block in place rather than adding a second one.
	const changed = applyManagedBlock(first.text, defaultBlock({ offPeakMultiplier: 0.6 }));
	assert.equal(changed.changed, true);
	assert.equal((changed.text.match(new RegExp(START.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu")) ?? []).length, 1);
	const [row] = rowsOf(changed.text);
	assert.equal(row.config.offPeakMultiplier, 0.6);
});

test("removing the block restores the surrounding document", () => {
	const original = "# user patch\n- id: keep-me\n  name: 'x'\n";
	const installed = applyManagedBlock(original, defaultBlock());
	const removed = applyManagedBlock(installed.text, "");
	assert.equal(removed.changed, true);
	assert.ok(!removed.text.includes(START));
	assert.ok(!removed.text.includes(END));
	assert.deepEqual(parseYaml(removed.text).map((row) => row.id), ["keep-me"]);
});

test("removing a block that was never installed is a no-op", () => {
	const original = "# user patch\n[]\n";
	const result = applyManagedBlock(original, "");
	assert.equal(result.changed, false);
	assert.equal(result.text, original);
});

test("a block installs cleanly over a patch that only holds the mcp-config markers", () => {
	const original = [
		"# user patch",
		"# >>> dsh-mcp-config (managed)",
		"# <<< dsh-mcp-config",
		"",
	].join("\n");
	const result = applyManagedBlock(original, defaultBlock());
	const document = parseYaml(result.text);
	assert.equal(document.length, 2);
	assert.match(result.text, /dsh-mcp-config/);
});
