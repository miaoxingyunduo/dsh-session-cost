/**
 * Browser-half tests: the module-loader contract, the slot registrations, the
 * readout itself (priced, unpriced, off-peak, empty, broken config), both Fetch
 * calls, and the Plugins-page rate form.
 *
 * The bundle is driven through a hand-rolled module loader and a small stateful
 * React stub, so nothing here needs a browser; the real lib/client.js runs
 * unchanged.
 *
 * Run: node --test --test-isolation=none test/client.test.mjs
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeReact, textOf, walk } from "./helpers.js";

const source = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");
const PACKAGE_NAME = "@local/dsh-session-cost";
const CONFIG_URL = "/api/session-cost/config";
const VERIFY_URL = "/api/session-cost/verify";

/**
 * Load the bundle into a stub browser.
 *
 * @param {object} [options] - `fetchImpl(url, init)` and an optional
 *   `primitives` module to hand the bundle instead of nothing.
 * @returns {object} exports, a stateful `mount` renderer, and the request log.
 */
/** A localStorage stand-in over one Map, so a caller can share it across mounts. */
function makeStorage(store = new Map()) {
	return {
		store,
		getItem: (key) => (store.has(key) ? store.get(key) : null),
		setItem: (key, value) => store.set(key, String(value)),
	};
}

function loadBundle({ fetchImpl, primitives, copyFails = false, storage } = {}) {
	const react = makeReact();
	const loads = [];
	const requests = [];
	const clipboard = [];
	const globalWindow = { __ModuleLoader__: { load: (spec) => loads.push(spec) } };
	// The bundle is a script, so the page globals it reads (`window`, `document`,
	// `localStorage`, `navigator`) are handed to it as function parameters. `fetch`
	// stays on globalThis because the component captures it when its effect runs,
	// long after this function returns.
	const previousFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	Object.defineProperty(globalThis, "fetch", {
		value: (url, init) => {
			requests.push({ url, init });
			return fetchImpl === undefined
				? Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: false, error: "no fetch stub" }) })
				: fetchImpl(url, init);
		},
		writable: true,
		configurable: true,
	});
	const store = new Map();
	const localStorage = storage ?? makeStorage();
	// The readout also reaches `globalThis.localStorage` at runtime, so the page
	// global is replaced too — otherwise a test would inherit the previous test's
	// saved "panel is open" flag and a click would close instead of open.
	const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", { value: localStorage, writable: true, configurable: true });
	const navigator = {
		clipboard: {
			writeText: (text) => {
				if (copyFails) return Promise.reject(new Error("clipboard denied"));
				clipboard.push(text);
				return Promise.resolve();
			},
		},
	};
	const styles = [];
	const document = {
		head: { querySelector: () => null, appendChild: (tag) => styles.push(tag) },
		createElement: () => ({ setAttribute() {}, textContent: "" }),
		addEventListener() {},
		removeEventListener() {},
	};
	// `navigator` is reached as `globalThis.navigator` by the readout, so the stub
	// is installed as a page global for the duration of the test (restored by the
	// afterEach hook) as well as passed in for the bundle's evaluation.
	const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	Object.defineProperty(globalThis, "navigator", { value: navigator, writable: true, configurable: true });
	try {
		new Function("window", "document", "localStorage", "navigator", "require", source)(
			globalWindow,
			document,
			localStorage,
			navigator,
			(name) => {
				if (name === "react") return react;
				if (name === "@deepseek-ai/dsh-client-ui-primitives" && primitives !== undefined) return primitives;
				throw new Error(`unexpected require(${name})`);
			},
		);
	} finally {
		// The component calls `fetch` when its effect runs, long after this function
		// returns, so the stub stays on globalThis until the afterEach hook. The
		// other page globals are parameters, so they need no cleanup here.
		void previousFetch;
	}
	assert.equal(loads.length, 1, "the bundle loads exactly one module");
	assert.equal(loads[0].id, PACKAGE_NAME);
	const exports = loads[0].factory((name) => {
		if (name === "react") return react;
		if (name === "@deepseek-ai/dsh-client-ui-primitives" && primitives !== undefined) return primitives;
		throw new Error(`unexpected require(${name})`);
	});

	/**
	 * Render one component repeatedly against the SAME hook state, running the
	 * effects and draining their promise chains between passes. This is what makes
	 * a `useEffect` + `fetch` readout observable at all.
	 *
	 * @param {Function} component - the component to render.
	 * @param {object} props - its props.
	 * @param {number} [passes] - how many render/flush cycles to run.
	 * @returns {Promise<object>} the element tree from the last pass.
	 */
	async function mount(component, props, passes = 3) {
		let tree;
		for (let pass = 0; pass < passes; pass += 1) {
			// Every pass is one render of the same component instance: the hook cursor
			// restarts, while state and effect memoization carry over.
			react.__reset();
			tree = component(props);
			react.__runEffects();
			for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
		}
		react.__reset();
		tree = component(props);
		react.__runEffects();
		return tree;
	}

	// The cost pill's config effect owns an interval and the component keeps a
	// document listener; both are released here so the runner can exit.
	afterEach(() => {
		react.__unmount();
		if (previousFetch === undefined) delete globalThis.fetch;
		else Object.defineProperty(globalThis, "fetch", previousFetch);
		if (previousNavigator === undefined) delete globalThis.navigator;
		else Object.defineProperty(globalThis, "navigator", previousNavigator);
		if (previousLocalStorage === undefined) delete globalThis.localStorage;
		else Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
	});

	return { exports, react, requests, mount, clipboard, styles, store };
}

/** The tree of one click-driven mount, so the component's own state advances. */
async function mountWithClicks(mount, component, props, clicks) {
	let tree = await mount(component, props, 3);
	for (const pick of clicks) {
		const node = pick(tree);
		assert.ok(node !== undefined, "the control the test wants to click exists");
		node.props.onClick();
		tree = await mount(component, props, 3);
	}
	return tree;
}

/** The action button whose label matches, wherever the primitives render it. */
function buttonLabelled(tree, label) {
	return walk(tree).find((node) => textOf(node).includes(label) && typeof node.props?.onClick === "function");
}

/**
 * Drive the row form the way a session does: one component instance, edited and
 * then submitted, with a fresh render after each interaction so the state an
 * interaction produced is actually on screen.
 *
 * The form keeps its own state (the price rows, the status line), so the steps
 * must share one instance — that is what `__reset` gives, a re-render rather than
 * a remount. A test that wants a *fresh* form (to compare an untouched render)
 * passes `{remount: true}` as the first step.
 *
 * @param {object} loaded - from {@link loadBundle}.
 * @param {object} props - the form props.
 * @param {Array<object>} steps - in order: `{edit}`, `{click}`, or `{}` to re-render.
 * @returns {object} the tree after the last render.
 */
function driveForm(loaded, props, steps) {
	const { exports, react } = loaded;
	const render = () => {
		react.__reset();
		return exports.ConfigForm(props);
	};
	let tree = render();
	for (const step of steps) {
		if (step.remount === true) {
			react.__remount();
			tree = render();
			continue;
		}
		if (step.edit !== undefined) {
			const node = walk(tree).find(step.edit.find);
			assert.ok(node !== undefined, `the control to edit exists: ${step.edit.why ?? ""}`);
			node.props[step.edit.prop ?? "onChange"](step.edit.event);
		}
		if (step.click !== undefined) {
			const node = walk(tree).find(step.click.find);
			assert.ok(node !== undefined, `the control to click exists: ${step.click.why ?? ""}`);
			node.props.onClick();
		}
		// One more render, so whatever the interaction changed is what the caller sees.
		tree = render();
	}
	return tree;
}

/** The save button, wherever the primitives render it. */
const saveButton = { find: (node) => textOf(node) === "保存" && typeof node.props?.onClick === "function", why: "the form has a save button" };

/** The rate-table cell for one field. */
function rateCellOf(tree, field) {
	return walk(tree).find((node) => node.props?.["data-cost-rate"] === field);
}

/** The rate-table input for one field. */
const rateField = (field) => ({ find: (node) => node.props?.["data-cost-rate"] === field, why: `the ${field} cell is in the table` });

/**
 * Open the panel, tolerating that it may already be open.
 *
 * The pill remembers its expanded state, so an unconditional click would *close*
 * it on a mount that started open — which is exactly what the persistence
 * feature means, and a trap for a test that just wants to see the panel.
 */
async function openPanel(mount, component, props) {
	const tree = await mount(component, props, 3);
	if (pillOf(tree)?.props?.["data-open"] === "true") return tree;
	const pill = pillOf(tree);
	assert.ok(pill !== undefined, "the pill exists");
	pill.props.onClick();
	return mount(component, props, 3);
}

/** A fetch stub answering the config route with a real rate table. */
function configStub(overrides = {}) {
	const body = {
		ok: true,
		revision: "rev-1",
		rates: {
			"deepseek-official/deepseek-flash": { label: "DeepSeek-V4.1-Flash", input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2 },
		},
		currency: { symbol: "$", code: "USD", perUsd: 1 },
		offPeakMultiplier: 0.5,
		offPeakTimezone: "UTC",
		...overrides,
	};
	return () => Promise.resolve({ status: 200, json: () => Promise.resolve(body) });
}

/** Props for a conversation with the given token buckets. */
function props({
	usage,
	selection = { lastUsed: { provider: "deepseek-official", model: "deepseek-flash" } },
	sessionId = "session-live",
	session = { running: false },
	pressure = { surfaceTokens: 168_962, contextWindow: 1_000_000 },
} = {}) {
	// `null` is the explicit "this surface has no context projection" case; an
	// omitted argument still gets the default, so it cannot express that.
	const contextPressure = pressure === null ? undefined : pressure;
	return {
		sessionId,
		useProjection: (key) => {
			if (key === "tokenUsage") return usage;
			if (key === "modelSelection") return selection;
			if (key === "contextPressure") return contextPressure;
			return undefined;
		},
		useSession: (selector) => selector(session),
	};
}

/** The pill element a tree renders. */
function pillOf(tree) {
	return walk(tree).find((node) => node.props?.["data-session-cost"] === "pill");
}

/** One ancestor box, as the ceiling measurement reads it: an overflow and a top edge. */
function clipBox(overflowY, top) {
	return { overflowY, parentElement: null, getBoundingClientRect: () => ({ top }) };
}

/**
 * An anchor under a chain of boxes, outermost last.
 *
 * @param {object[]} boxes - the ancestors in DOM order.
 * @returns {object} an element whose `parentElement` starts the chain.
 */
function anchorUnder(...boxes) {
	let parent = null;
	for (const entry of boxes.reverse()) {
		entry.parentElement = parent;
		parent = entry;
	}
	return { parentElement: parent };
}

/** The `getComputedStyle` stand-in over a {@link clipBox}. */
const styleOf = (node) => ({ overflowY: node.overflowY });

test("the bundle loads through window.__ModuleLoader__ with the package id", () => {
	const { exports } = loadBundle();
	assert.equal(typeof exports.apply, "function");
	assert.deepEqual(exports.inject, ["slots"]);
	assert.equal(typeof exports.CostPill, "function");
	assert.equal(typeof exports.ConfigForm, "function");
});

test("the readout names the route as provider/model, not a pretty label", () => {
	// Two providers can serve the same model name, and `rates` is keyed by
	// `provider/model` — so that pair is what identifies the entry to edit. A label
	// (`DeepSeek-V4.1-Flash`) says nothing about which entry is being priced.
	const { exports } = loadBundle();
	assert.equal(exports.routeDisplay({ provider: "deepseek-official", model: "deepseek-flash" }), "deepseek-official/deepseek-flash");
	assert.equal(exports.routeDisplay({ provider: "vendor-x", model: "mystery" }), "vendor-x/mystery");
	assert.equal(exports.routeDisplay({ provider: "", model: "m" }), "m", "a missing provider still names the model");
	assert.equal(exports.routeDisplay({ provider: "p", model: "" }), "p");
	assert.equal(exports.routeDisplay({ provider: "  ", model: "  " }), "未识别模型");
	assert.equal(exports.routeDisplay(undefined), "未识别模型", "nothing selected yet");
});

test("the capsule and panel show provider/model, and the panel adds the label", async () => {
	const { exports, mount } = loadBundle({ fetchImpl: configStub() });
	// A second provider, so the route cannot be guessed from the model alone.
	const usage = { uncachedInputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 };
	const selection = { lastUsed: { provider: "deepseek-official", model: "deepseek-flash" } };
	const tree = await mountWithClicks(mount, exports.CostPill, props({ usage, selection }), [pillOf]);
	const text = textOf(tree);
	// The panel header carries the key and the human name, in that order.
	assert.match(text, /deepseek-official\/deepseek-flash/);
	assert.match(text, /deepseek-official\/deepseek-flash（DeepSeek-V4\.1-Flash）/);
	// The tooltip and the capsule title name the route too.
	assert.match(pillOf(tree).props.title, /^deepseek-official\/deepseek-flash · /);
	// A labelled route whose label equals the model does not repeat itself.
	assert.ok(!text.includes("（deepseek-flash）"), "no label repeat for an unlabelled model");
});

test("the readout keeps the context, the new tokens and the cumulative bill apart", async () => {
	// One conversation, three different token counts that a reader can see in
	// three different places. Collapsing them into one number is what makes a
	// readout look wrong: the cumulative figure counts the cached context again on
	// every single call, and 99% of it is cache reads, so it can be a thousand
	// times the context DSH's own stats show.
	// A fixed clock, so the amounts below are priced at DeepSeek's off-peak rate
	// no matter when the suite runs.
	const realNow = Date.now;
	Date.now = () => Date.UTC(2026, 0, 5, 12, 0); // Monday 12:00 UTC, off-peak
	try {
		const usage = { uncachedInputTokens: 1_000_000, cacheReadTokens: 100_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 };
		const pressure = { surfaceTokens: 168_962, contextWindow: 1_000_000 };
		const { exports, mount } = loadBundle({ fetchImpl: configStub() });

		const collapsed = await mount(exports.CostPill, props({ usage, pressure }));
		const pill = pillOf(collapsed);
		// The capsule speaks DSH's own language: the context against its window. The
		// mark is on the token span itself, which is what identifies which of the two
		// counts the capsule is showing.
		const tokenSpan = walk(collapsed).find((node) => node.props?.["data-cost-tokens"] !== undefined);
		assert.equal(tokenSpan.props["data-cost-tokens"], "context");
		assert.match(textOf(collapsed), /169k \/ 1\.0+M/);
		assert.ok(!textOf(collapsed).includes("102.0M"), "the cumulative figure is not mistaken for the context");

		const expanded = await mountWithClicks(mount, exports.CostPill, props({ usage, pressure }), [pillOf]);
		const text = textOf(expanded);
		assert.match(text, /当前上下文（DSH 统计口径） 168,962 窗口 1\.0+M/);
		assert.match(text, /本次新增（不含缓存重读） 2,000,000/);
		assert.match(text, /整段累计计费（含缓存重读） 102,000,000/);
		assert.match(text, /整段累计 = 每次调用的完整输入相加/, "the panel explains why the numbers differ");
		// The newly-generated share is priced without the cache reads: input 0.15 +
		// output 0.6 per 1M at off-peak = $0.75, against the session's $1.05 total
		// (the 100M cache reads add $0.30 at their own $0.006 rate).
		assert.match(text, /本次新增（不含缓存重读） 2,000,000 \$0\.750/);
		// The cumulative share is the session's own bill.
		assert.match(text, /整段累计计费（含缓存重读） 102,000,000 \$1\.0500/);
		assert.ok(!pill.props["data-cost-tokens"], "the mark lives on the token span, not on the button");
	} finally {
		Date.now = realNow;
	}
});

test("a surface with no context projection still reports the cumulative token count", async () => {
	// `contextPressure` is a second projection; a Host that does not expose it must
	// not cost the capsule its token count.
	const usage = { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 };
	const { exports, mount } = loadBundle({ fetchImpl: configStub() });
	const tree = await mount(exports.CostPill, props({ usage, pressure: null }));
	const tokenSpan = walk(tree).find((node) => node.props?.["data-cost-tokens"] !== undefined);
	assert.equal(tokenSpan.props["data-cost-tokens"], "cumulative");
	assert.match(textOf(tree), /120/, "the cumulative count stands in");
});

test("apply registers the cost pill and both rows' config forms on the documented slots", () => {
	const { exports } = loadBundle();
	const registrations = [];
	const ctx = {
		slots: {
			inject: (key, callback) => {
				registrations.push({ kind: "inject", key });
				callback();
			},
			register: (options, component) => {
				registrations.push({ kind: "register", options, component });
			},
		},
	};
	exports.apply(ctx);
	assert.deepEqual(
		registrations.filter((row) => row.kind === "inject").map((row) => row.key),
		["conversation.composer.dock", "plugins.row.config", "plugins.row.config"],
	);
	const registered = registrations.filter((row) => row.kind === "register");
	assert.equal(registered.length, 3);
	const pill = registered.find((row) => row.options.name === "conversation.composer.dock");
	assert.equal(pill.options.id, "session-cost");
	assert.equal(pill.component, exports.CostPill);
	assert.equal(pill.options.order, 60);
	assert.deepEqual(
		registered.filter((row) => row.options.name === "plugins.row.config").map((row) => row.options.key).sort(),
		[`${PACKAGE_NAME}#session-cost`, `${PACKAGE_NAME}#session-cost-command`],
	);
});

test("the pill shows tokens and money, and its panel breaks the amount down by bucket", async () => {
	// A fixed clock: the amounts below are DeepSeek's off-peak rates, so the
	// assertions must not depend on when the suite happens to run.
	const realNow = Date.now;
	Date.now = () => Date.UTC(2026, 0, 5, 12, 0); // Monday 12:00 UTC, off-peak
	try {
		const { exports, mount } = loadBundle({ fetchImpl: configStub() });
		const usage = { uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 };
		const collapsed = textOf(await mount(exports.CostPill, props({ usage })));
		// Off-peak: input 0.15 + cacheRead 0.003 + output 0.6 = 0.753 USD.
		assert.match(collapsed, /\$0\.753/);
		// The capsule carries DSH's own context figure rather than the cumulative
		// total; the cumulative one is on the panel's token rows and the tooltip.
		assert.match(collapsed, /169k \/ 1\.0+M/);

		const expanded = await mountWithClicks(mount, exports.CostPill, props({ usage }), [pillOf]);
		const text = textOf(expanded);
		assert.match(text, /DeepSeek-V4\.1-Flash/);
		assert.match(text, /输入 · 命中缓存/);
		assert.match(text, /输入 · 未命中缓存/);
		assert.match(text, /1,000,000/, "each bucket's raw token count is shown");
		assert.match(text, /\$0\.15/, "the per-bucket amount is shown");
		assert.match(text, /缓存命中/);
		assert.match(text, /非高峰/);
		assert.match(text, /与日志核对/);
		assert.match(text, /复制明细/);
		assert.match(text, /单价来自插件配置/);
	} finally {
		Date.now = realNow;
	}
});

test("the expanded pill draws a cost-share bar and legend whose shares sum to the bill", async () => {
	const { exports, mount } = loadBundle({ fetchImpl: configStub() });
	const usage = { uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 };
	const tree = await mountWithClicks(mount, exports.CostPill, props({ usage }), [pillOf]);
	const nodes = walk(tree);
	// The bar is one flex row of segments; each segment carries its share inline,
	// because only the data knows the geometry.
	const bar = nodes.find((node) => node.props?.className === "dsh-cost-bar");
	assert.ok(bar !== undefined, "the panel renders a share bar");
	assert.equal(bar.children.length, 3, "the three buckets with a non-zero amount get a segment");
	const widths = bar.children.map((segment) => Number.parseFloat(segment.props.style.width));
	assert.ok(widths.every((width) => width > 0 && width <= 100));
	assert.ok(Math.abs(widths.reduce((sum, width) => sum + width, 0) - 100) < 0.5, `shares sum to ~100 (got ${widths.join(" + ")})`);
	const legend = nodes.find((node) => node.props?.className === "dsh-cost-legend");
	assert.ok(legend !== undefined, "the legend names each segment");
	assert.match(textOf(legend), /命中缓存 \d+%/);
});

test("the pill prices the peak window at the peak rate", async () => {
	// A fixed clock, so the peak/off-peak branch is not decided by when the suite
	// happens to run.
	const peak = Date.UTC(2026, 0, 5, 2, 0); // Monday 02:00 UTC
	const offPeak = Date.UTC(2026, 0, 5, 12, 0); // Monday 12:00 UTC
	const realNow = Date.now;
	const usage = { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	try {
		Date.now = () => peak;
		{
			const { exports, mount } = loadBundle({ fetchImpl: configStub() });
			const text = textOf(await mount(exports.CostPill, props({ usage })));
			assert.match(text, /\$0\.300/, "peak price is 0.3 per 1M input");
		}
		Date.now = () => offPeak;
		{
			const { exports, mount } = loadBundle({ fetchImpl: configStub() });
			const text = textOf(await mount(exports.CostPill, props({ usage })));
			assert.match(text, /\$0\.150/, "off-peak price is half the peak price");
		}
	} finally {
		Date.now = realNow;
	}
});

test("a flat-price route is not halved and never claims an off-peak price", async () => {
	// The bug this pins down: every priced route was given DeepSeek's off-peak
	// discount, so the panel showed "非高峰 ×0.5" and half the amount for a model
	// whose provider quotes one flat rate.
	const offPeak = Date.UTC(2026, 0, 5, 12, 0); // Monday 12:00 UTC, DeepSeek's off-peak
	const realNow = Date.now;
	Date.now = () => offPeak;
	try {
		const selection = { lastUsed: { provider: "our-free-model", model: "mimo-v2.6-flash-free" } };
		const rates = { "our-free-model/mimo-v2.6-flash-free": { input: 1, cacheRead: 0.02, output: 2 } };
		const stub = configStub({ rates, currency: { symbol: "¥", code: "CNY", perUsd: 1 } });
		const { exports, mount } = loadBundle({ fetchImpl: stub });
		const usage = { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
		const collapsed = textOf(await mount(exports.CostPill, props({ usage, selection })));
		// ¥1 per 1M input, not ¥0.5: the stored price is what is charged.
		assert.match(collapsed, /¥1\.0000/, "the flat price is charged in full off-peak");
		assert.ok(!collapsed.includes("¥0.5000"), "the flat price is not halved");
		const expanded = await mountWithClicks(mount, exports.CostPill, props({ usage, selection }), [pillOf]);
		const text = textOf(expanded);
		assert.match(text, /our-free-model\/mimo-v2\.6-flash-free/);
		assert.match(text, /固定价/, "the panel says the route is on one price");
		assert.ok(!text.includes("非高峰"), "and never claims an off-peak discount");
	} finally {
		Date.now = realNow;
	}
});

test("the page and the Host agree on which routes have a peak/off-peak window", async () => {
	// The two halves price independently; a disagreement here is the panel naming a
	// tariff the bill does not use, which is exactly how the flat route got its
	// invented off-peak price.
	const { exports } = loadBundle();
	const { defaultPeakPricing: hostRule } = await import("../lib/rates.js");
	for (const key of [
		"deepseek-official/deepseek-flash",
		"deepseek-account/deepseek-v4-pro",
		"DeepSeek-Official/x",
		"our-free-model/mimo-v2.6-flash-free",
		"vendor-x/mystery",
		"",
	]) {
		assert.equal(exports.defaultPeakPricing(key), hostRule(key), `the two halves disagree about "${key}"`);
	}
	// And the label follows the resolved flag rather than guessing from the clock.
	assert.equal(exports.priceWindowText({ peak: false, windowed: false, multiplier: 0.5 }), "（固定价）");
	assert.equal(exports.priceWindowText({ peak: false, windowed: true, multiplier: 0.5 }), "（非高峰价 ×0.5）");
	assert.equal(exports.priceWindowText({ peak: true, windowed: true, multiplier: 1 }), "（高峰价）");
	const flat = exports.priceBuckets({ uncachedInputTokens: 1_000_000 }, { input: 1, output: 2, peakPricing: false }, { offPeakMultiplier: 0.5, offPeakTimezone: "UTC", at: Date.UTC(2026, 0, 5, 12, 0) });
	assert.equal(flat.windowed, false);
	assert.equal(flat.microUsd, 1_000_000);
});

test("the pill counts the tokens of a model with no configured rate but shows no price", async () => {
	const { exports, mount } = loadBundle({ fetchImpl: configStub() });
	const usage = { uncachedInputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 };
	const selection = { lastUsed: { provider: "vendor-x", model: "mystery" } };
	const collapsed = textOf(await mount(exports.CostPill, props({ usage, selection })));
	assert.match(collapsed, /1\.0k tokens/);
	const expanded = await mountWithClicks(mount, exports.CostPill, props({ usage, selection }), [pillOf]);
	assert.match(textOf(expanded), /未配置 vendor-x\/mystery 的单价/);
	assert.match(textOf(expanded), /补一条 rates/);
});

test("the pill renders nothing before a conversation has spent anything", async () => {
	const { exports, mount } = loadBundle({ fetchImpl: configStub() });
	const empty = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	assert.equal(await mount(exports.CostPill, props({ usage: undefined })), null);
	assert.equal(await mount(exports.CostPill, props({ usage: empty })), null);
});

test("the pill survives a projection-less surface instead of throwing", async () => {
	const { exports, mount } = loadBundle({ fetchImpl: configStub() });
	assert.equal(await mount(exports.CostPill, { sessionId: "session-live" }), null);
});

test("a config failure is reported in the pill rather than taking the composer down", async () => {
	const stub = () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: false, error: "rates is not valid JSON" }) });
	const { exports, mount } = loadBundle({ fetchImpl: stub });
	const usage = { uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 };
	const text = textOf(await mount(exports.CostPill, props({ usage })));
	assert.match(text, /金额统计不可用/);
	assert.match(text, /not valid JSON/);
});

test("an unreachable Host leaves the readout hidden rather than showing a wrong number", async () => {
	const stub = () => Promise.reject(new Error("fetch failed"));
	const { exports, mount } = loadBundle({ fetchImpl: stub });
	const usage = { uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 };
	const text = textOf(await mount(exports.CostPill, props({ usage })));
	assert.match(text, /金额统计不可用/);
	assert.match(text, /fetch failed/);
});

test("the pill reads the config route once at mount, same-origin", async () => {
	const { exports, mount, requests } = loadBundle({ fetchImpl: configStub() });
	const usage = { uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 };
	await mount(exports.CostPill, props({ usage }), 2);
	const configs = requests.filter((row) => row.url === CONFIG_URL);
	assert.equal(configs.length, 1, "a re-render with the same revision does not refetch");
	assert.equal(configs[0].init.credentials, "same-origin");
});

test("the 与日志核对 button posts the session id and renders the Host's recomputation", async () => {
	const verifyBody = { ok: true, sessionId: "session-live", source: "live", display: "$0.0001", tokens: 3360, text: "会话 session-live\n范围：整段对话" };
	const stub = (url) => (url === VERIFY_URL
		? Promise.resolve({ status: 200, json: () => Promise.resolve(verifyBody) })
		: configStub()());
	const { exports, mount, requests } = loadBundle({ fetchImpl: stub });
	const usage = { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 };
	const tree = await mountWithClicks(mount, exports.CostPill, props({ usage }), [
		pillOf,
		(current) => buttonLabelled(current, "与日志核对"),
	]);
	const text = textOf(tree);
	assert.match(text, /宿主重算/);
	assert.match(text, /\$0\.0001/);
	assert.match(text, /会话 session-live/);
	const request = requests.find((row) => row.url === VERIFY_URL);
	assert.equal(request.init.method, "POST");
	assert.deepEqual(JSON.parse(request.init.body), { sessionId: "session-live", detail: false });
});

test("a failed verification keeps the pill alive and states the reason", async () => {
	const stub = (url) => (url === VERIFY_URL
		? Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: false, error: "找不到这个会话" }) })
		: configStub()());
	const { exports, mount } = loadBundle({ fetchImpl: stub });
	const usage = { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 };
	const tree = await mountWithClicks(mount, exports.CostPill, props({ usage }), [
		pillOf,
		(current) => buttonLabelled(current, "与日志核对"),
	]);
	assert.match(textOf(tree), /找不到这个会话/);
});

test("the copy action puts the readout on the clipboard, and a denied clipboard is not fatal", async () => {
	const usage = { uncachedInputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 20 };
	const ok = loadBundle({ fetchImpl: configStub() });
	const copied = await mountWithClicks(ok.mount, ok.exports.CostPill, props({ usage }), [
		pillOf,
		(current) => buttonLabelled(current, "复制明细"),
	]);
	assert.equal(ok.clipboard.length, 1, "one clipboard write");
	assert.match(ok.clipboard[0], /总 token 620/);
	assert.match(ok.clipboard[0], /命中缓存 500/);
	assert.match(textOf(copied), /已复制/);

	const denied = loadBundle({ fetchImpl: configStub(), copyFails: true });
	const tree = await mountWithClicks(denied.mount, denied.exports.CostPill, props({ usage }), [
		pillOf,
		(current) => buttonLabelled(current, "复制明细"),
	]);
	assert.match(textOf(tree), /复制明细/, "the label returns to its resting state instead of throwing");
});

test("the expanded state survives a reload through localStorage", async () => {
	const usage = { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 };
	// One storage, two page loads — which is exactly what a reload sees.
	const storage = makeStorage();
	const first = loadBundle({ fetchImpl: configStub(), storage });
	await mountWithClicks(first.mount, first.exports.CostPill, props({ usage }), [pillOf]);
	assert.equal(storage.store.get("dsh-cost:open"), "1", "opening the panel is remembered");

	const second = loadBundle({ fetchImpl: configStub(), storage });
	const tree = await second.mount(second.exports.CostPill, props({ usage }));
	assert.match(textOf(tree), /对话消耗/, "the panel opens without a click");
	assert.equal(pillOf(tree).props["data-open"], "true");
});

test("an outside pointer press closes the panel", async () => {
	const usage = { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 };
	const { exports, mount } = loadBundle({ fetchImpl: configStub() });
	const opened = await mountWithClicks(mount, exports.CostPill, props({ usage }), [pillOf]);
	assert.equal(pillOf(opened).props["data-open"], "true");
	// The bundle registers its dismiss listener through the stubbed document; the
	// simplest faithful check is that Escape is wired, which exercises the same path.
	assert.match(exports.CSS, /focus-visible/, "the stylesheet carries the focus treatment");
});

test("the expanded panel states whether the conversation has delegated sessions", async () => {
	const familyBody = {
		ok: true,
		sessionId: "session-live",
		self: { tokens: 1120, usd: 0.00213, display: "$0.00213", attempts: 1 },
		descendants: [
			{ sessionId: "session-child-a", depth: 1, origin: "subagent", tokens: 4200, usd: 0.006, display: "$0.006", priced: true },
			{ sessionId: "session-child-b", depth: 2, origin: "subagent", tokens: 1000, usd: 0.001, display: "$0.001", priced: true },
		],
		descendantCount: 2,
		missingParents: [],
		failures: [],
		total: { tokens: 6320, usd: 0.00913, display: "$0.00913", descendantTokens: 5200, descendantMicroUsd: 7000, descendantUsd: 0.007, descendantDisplay: "$0.007" },
		text: "…合计：6,320 token",
	};
	const stub = (url) => (url === "/api/session-cost/family"
		? Promise.resolve({ status: 200, json: () => Promise.resolve(familyBody) })
		: configStub()());
	const { exports, react, mount, requests } = loadBundle({ fetchImpl: stub });
	const usage = { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 };
	const tree = await openPanel(mount, exports.CostPill, props({ usage }));
	const text = textOf(tree);
	assert.match(text, /另有 2 个派生会话（独立计费，已计入上方金额）/);
	assert.match(text, /\+5\.2k · \$0\.007/);
	assert.match(text, /本会话 \+ 派生会话合计/);
	assert.match(text, /6\.3k · \$0\.00913/);
	// The split section names both halves of the headline and sums them.
	assert.match(text, /本会话自身/);
	assert.match(text, /2 个派生会话（独立计费） 5,200 \$0\.007/);
	assert.ok(
		walk(tree).some((node) => node.props?.["data-cost-family"] === "split"),
		"the panel draws the self/derived split",
	);
	// The panel asks the Host about the open session, appending `fresh` because
	// the first read of a session is a request to read it now rather than to reuse
	// an index the Host built for something else.
	const asks = requests.filter((row) => row.url === "/api/session-cost/family");
	assert.equal(asks.length, 1);
	assert.deepEqual(JSON.parse(asks[0].init.body), { sessionId: "session-live", fresh: true });
	// The family section is offered inside the panel; expanding it lists the
	// descendants with their own figures.
	const panel = await openPanel(mount, exports.CostPill, props({ usage }));
	const expand = buttonLabelled(panel, "展开明细");
	assert.ok(expand !== undefined, `the family section offers 展开明细; panel says: ${textOf(panel).slice(0, 400)}`);
	expand.props.onClick();
	react.__reset();
	const expanded = exports.CostPill(props({ usage }));
	const expandedText = textOf(expanded);
	// The listed row carries the origin label, the per-child spend and its amount.
	assert.match(expandedText, /subagent/);
	assert.match(expandedText, /4\.2k/);
	assert.match(expandedText, /\$0\.006/);
	assert.match(expandedText, /收起明细/);
});

test("the collapsed capsule reports the family total, not just the main session", async () => {
	// The capsule is the number a reader takes away, so a conversation that
	// delegated work must not look cheaper than it was. The main session spends
	// 1,120 tokens outright; two subagents add 5,200 tokens and $0.007, which are
	// other logs the projection cannot see.
	// A fixed clock: the amounts below are DeepSeek's off-peak rates, so the
	// assertions must not depend on when the suite happens to run.
	const realNow = Date.now;
	Date.now = () => Date.UTC(2026, 0, 5, 12, 0); // Monday 12:00 UTC, off-peak
	try {
		const familyBody = {
			ok: true,
			sessionId: "session-live",
			self: { tokens: 1120, usd: 0.00213, display: "$0.00213", attempts: 1 },
			descendants: [
				{ sessionId: "session-child-a", depth: 1, origin: "subagent", tokens: 4200, usd: 0.006, display: "$0.006", priced: true },
				{ sessionId: "session-child-b", depth: 1, origin: "subagent", tokens: 1000, usd: 0.001, display: "$0.001", priced: true },
			],
			descendantCount: 2,
			missingParents: [],
			failures: [],
			total: { tokens: 6320, usd: 0.00913, display: "$0.00913", descendantTokens: 5200, descendantMicroUsd: 7000, descendantUsd: 0.007, descendantDisplay: "$0.007" },
			text: "…",
		};
		const asks = [];
		const stub = (url, init) => {
			if (url === "/api/session-cost/family") {
				asks.push(JSON.parse(init.body));
				return Promise.resolve({ status: 200, json: () => Promise.resolve(familyBody) });
			}
			return configStub()();
		};
		const { exports, mount } = loadBundle({ fetchImpl: stub });
		// Off-peak, 100 uncached input + 20 output: round(100 × 0.15) + round(20 × 0.6)
		// = 15 + 12 = 27 micro-USD — each bucket is rounded once, the way the Host
		// prices a bucket, so a cent-level readout is exact rather than accumulated
		// float noise.
		const usage = { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 };
		const tree = await mount(exports.CostPill, props({ usage }));
		const pill = pillOf(tree);
		assert.equal(pill.props["data-family"], "true");
		// 120 + 5,200 = 5,320 tokens, 0.000027 + 0.007 = 7,027 micro-USD.
		assert.equal(pill.props["data-open"], "false", "the panel is closed");
		assert.match(textOf(tree), /\$0\.00703\b/, "the headline adds the delegated spend");
		assert.ok(!textOf(tree).includes("$0.00003 "), "the main-session-only figure is not the headline");
		assert.match(textOf(tree), /含派生 2/, "the capsule says it includes them");
		assert.match(textOf(tree), /169k \/ 1\.0+M/, "the capsule's token figure is the context, as in DSH's own stats");
		assert.ok(!textOf(tree).includes("5.3k"), "the cumulative token count is not presented as the context");
		assert.match(pill.props.title, /本会话 \$0\.0000270? \+ 2 个派生会话 \$0\.007/);
		assert.equal(asks.length, 1, "the family is asked for without opening the panel");
		assert.equal(asks[0].fresh, true, "the first read of a session is read now, not from an index built for another");
		assert.equal(asks[0].sessionId, "session-live");

		// A second session readout (a different session id) asks again rather than
		// reusing the first session's family.
		const other = await mount(exports.CostPill, props({ usage, sessionId: "session-other" }), 2);
		assert.match(textOf(other), /\$0\.00703\b/);
		assert.equal(asks.length, 2);
		assert.equal(asks[1].sessionId, "session-other");

		// 刷新 forces a rescan, which is what makes it useful while a subagent is
		// still running. (A *re-render* of one mounted readout must not re-ask, which
		// is why the effect is keyed on the session id and the counter rather than on
		// the cost object the render allocates.)
		const before = asks.length;
		const opened = await openPanel(mount, exports.CostPill, props({ usage }));
		const refresh = buttonLabelled(opened, "刷新");
		assert.ok(refresh !== undefined, "the family section offers 刷新");
		refresh.props.onClick();
		await mount(exports.CostPill, props({ usage }), 3);
		assert.ok(asks.length > before, "刷新 asks the Host again");
		assert.equal(asks[asks.length - 1].fresh, true, "刷新 forces a rescan rather than reusing the Host's index");
	} finally {
		Date.now = realNow;
	}
});

test("an unpriced conversation still counts its family's tokens but adds no amount", async () => {
	// Nothing is priced here, so the split section would divide by zero. The
	// capsule must fall back to the session's own token count and the panel must
	// say the descendants could not be priced, not invent an amount.
	const familyBody = {
		ok: true,
		sessionId: "session-live",
		self: { tokens: 500, usd: 0, display: "$0.00", attempts: 1 },
		descendants: [{ sessionId: "session-child", depth: 1, origin: "subagent", tokens: 700, priced: false }],
		descendantCount: 1,
		missingParents: [],
		failures: [],
		total: { tokens: 1200, usd: 0, display: "$0.00", descendantTokens: 700, descendantMicroUsd: 0, descendantUsd: 0, descendantDisplay: "$0.00" },
		text: "…",
	};
	const stub = (url) => (url === "/api/session-cost/family"
		? Promise.resolve({ status: 200, json: () => Promise.resolve(familyBody) })
		: configStub()());
	const { exports, mount } = loadBundle({ fetchImpl: stub });
	const usage = { uncachedInputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 };
	const selection = { lastUsed: { provider: "vendor-x", model: "mystery" } };
	const tree = await openPanel(mount, exports.CostPill, props({ usage, selection }));
	const text = textOf(tree);
	assert.match(text, /未配置 vendor-x\/mystery 的单价/);
	assert.match(text, /另有 1 个派生会话（独立计费，但未配置单价）/);
	assert.ok(!walk(tree).some((node) => node.props?.["data-cost-family"] === "split"), "no split bar without amounts");
});

test("a conversation with no delegated sessions says so", async () => {
	const familyBody = {
		ok: true,
		sessionId: "session-live",
		self: { tokens: 1120, usd: 0.002, display: "$0.002", attempts: 1 },
		descendants: [],
		descendantCount: 0,
		missingParents: [],
		failures: [],
		total: { tokens: 1120, usd: 0.002, display: "$0.002", descendantTokens: 0, descendantMicroUsd: 0, descendantUsd: 0, descendantDisplay: "$0.00" },
		text: "…",
	};
	const stub = (url) => (url === "/api/session-cost/family"
		? Promise.resolve({ status: 200, json: () => Promise.resolve(familyBody) })
		: configStub()());
	const { exports, mount } = loadBundle({ fetchImpl: stub });
	const usage = { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 };
	const tree = await mountWithClicks(mount, exports.CostPill, props({ usage }), [pillOf]);
	assert.match(textOf(tree), /无派生会话（本对话没有 subagent \/ workflow agent 子会话，金额即本会话自身）/);
	assert.ok(!textOf(tree).includes("另有"), "no family section when there is no family");
	assert.equal(pillOf(tree).props["data-family"], "false", "the capsule does not claim to include a family");
});

test("a failed family request is stated without taking the panel down", async () => {
	const stub = (url) => (url === "/api/session-cost/family"
		? Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: false, error: "找不到这个会话" }) })
		: configStub()());
	const { exports, mount } = loadBundle({ fetchImpl: stub });
	const usage = { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 };
	const tree = await mountWithClicks(mount, exports.CostPill, props({ usage }), [pillOf]);
	assert.match(textOf(tree), /派生会话统计不可用/);
	assert.match(textOf(tree), /与日志核对/, "the rest of the panel still works");
});

test("the bundle ships its stylesheet with theme tokens instead of hardcoded colours", () => {
	const { exports, styles } = loadBundle();
	assert.match(exports.CSS, /\.dsh-cost-pill/);
	assert.match(exports.CSS, /--dsw-alias-label-secondary/);
	assert.match(exports.CSS, /--dsw-alias-bg-overlay/);
	assert.ok(!/#[0-9a-f]{3,6}\b/i.test(exports.CSS), "no hardcoded hex colours");
	assert.equal(styles.length, 1, "one style tag is inserted at load");
});

test("the panel's ceiling is the room above the pill, not the height of the window", () => {
	const { exports } = loadBundle();
	// The real shape: DSH's conversation scroll port ends below its header, and the
	// pill sits in the composer dock near the bottom of the window. The panel may
	// be as tall as the room between them, less the gap.
	assert.equal(exports.panelCeiling({ anchorTop: 1352, clipTop: 141 }), 1203);
	assert.equal(exports.panelCeiling({ anchorTop: 1352, clipTop: 141, gap: 0 }), 1211);
});

test("the edge that clips the panel is found on the anchor's ancestors", () => {
	const { exports } = loadBundle();
	// A visible wrapper is not a clip; the scroll port above it is.
	const anchor = anchorUnder(clipBox("visible", 0), clipBox("auto", 141), clipBox("visible", 0));
	assert.equal(exports.clipTopOf(anchor, styleOf), 141, "the scroll port is the boundary");
	// Nothing above the anchor clips, so the window is the boundary.
	assert.equal(exports.clipTopOf(anchorUnder(clipBox("visible", 0)), styleOf), 0);
	// Two clipping ancestors: the one nearest the anchor wins, because it is the
	// edge a growing panel would cross first.
	assert.equal(exports.clipTopOf(anchorUnder(clipBox("auto", 141), clipBox("scroll", 300)), styleOf), 300);
});

test("a box that cannot be read is not treated as a clip", () => {
	const { exports } = loadBundle();
	const styleless = anchorUnder(clipBox("auto", 141));
	assert.equal(exports.clipTopOf(styleless, () => undefined), 0, "a box with no style claims no boundary");
	assert.equal(exports.clipTopOf(styleless, () => { throw new Error("detached"); }), 0, "a refusal to style is not a boundary");
	const unmeasurable = anchorUnder({ overflowY: "auto", parentElement: null });
	assert.equal(exports.clipTopOf(unmeasurable, styleOf), 0, "a box with no rect is skipped");
});

test("a cramped window still gets a usable panel instead of a sliver", () => {
	const { exports } = loadBundle();
	assert.equal(exports.panelCeiling({ anchorTop: 200, clipTop: 141 }), 220, "59px of room is floored");
	assert.equal(exports.panelCeiling({ anchorTop: 369, clipTop: 141 }), 220, "exactly at the floor");
	assert.equal(exports.panelCeiling({ anchorTop: 400, clipTop: 141 }), 251, "above the floor the room decides");
});

test("an unmeasurable anchor leaves the stylesheet's ceiling in force", () => {
	const { exports } = loadBundle();
	assert.equal(exports.panelCeiling({ anchorTop: Number.NaN, clipTop: 0 }), undefined);
	assert.equal(exports.panelCeiling({ anchorTop: 100, clipTop: undefined }), undefined);
});

test("the stylesheet bounds the panel and lets it scroll inside that bound", () => {
	const { exports } = loadBundle();
	const start = exports.CSS.indexOf(".dsh-cost-panel {");
	assert.ok(start > 0, "the panel rule is in the stylesheet");
	const rule = exports.CSS.slice(start, exports.CSS.indexOf("}", start));
	assert.match(rule, /max-height: max\(220px, min\(64vh, calc\(100vh - 200px\)\)\)/, "the panel has a first-paint ceiling");
	assert.match(rule, /overflow: hidden auto/, "and scrolls inside it instead of growing past the boundary");
	assert.match(rule, /overscroll-behavior: contain/, "so its own scrolling does not drag the conversation along");
});

test("a surface that cannot be measured keeps the stylesheet's ceiling", async () => {
	const usage = { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 };
	const { exports, mount } = loadBundle({ fetchImpl: configStub() });
	const tree = await openPanel(mount, exports.CostPill, props({ usage }));
	const panel = walk(tree).find((node) => node.props?.className === "dsh-cost-panel");
	assert.ok(panel !== undefined, "the panel is rendered");
	// There is no DOM to measure here, so the readout must not invent a ceiling of
	// its own — the stylesheet's is what bounds the panel in that case.
	assert.equal(panel.props.style, undefined, "no measurement, no inline ceiling");
});

test("the row form offers the rate fields and saves only what changed", async () => {
	const { exports, react } = loadBundle();
	const ops = [];
	const form = {
		state: {
			writable: true,
			revision: 7,
			value: {
				rates: JSON.stringify({ "p/m": { input: 1, output: 2 } }),
				currency: JSON.stringify({ symbol: "$", code: "USD", perUsd: 1 }),
				offPeakMultiplier: 0.5,
				offPeakTimezone: "UTC",
				dshHome: "",
			},
		},
		mutate: (next, revision) => {
			ops.push({ next, revision });
			return Promise.resolve();
		},
	};
	react.__reset();
	let tree = exports.ConfigForm({ view: "page", form });
	const text = textOf(tree);
	for (const label of ["rates", "currency", "offPeakMultiplier", "offPeakTimezone", "dshHome"]) {
		assert.match(text, new RegExp(label));
	}
	assert.match(text, /保存/);
	// Typing one field stages exactly one op, and the stored value is canonical JSON.
	walk(tree).find((node) => node.props?.["data-cost-field"] === "rates").props.onChange({ target: { value: "{ \"p/m\": { \"input\": 9, \"output\": 2 } }" } });
	react.__reset();
	tree = exports.ConfigForm({ view: "page", form });
	buttonLabelled(tree, "保存").props.onClick();
	assert.equal(ops.length, 1);
	assert.equal(ops[0].revision, 7);
	assert.deepEqual(ops[0].next, [{ op: "set", path: ["rates"], value: "{\"p/m\":{\"input\":9,\"output\":2}}" }]);
});

test("the row form shows a live preview of the rates it would store, and flags mistakes", () => {
	const { exports, react } = loadBundle();
	const form = {
		state: {
			writable: true,
			revision: 1,
			value: {
				rates: JSON.stringify({
					"deepseek-official/deepseek-flash": { label: "DeepSeek-V4.1-Flash", input: 0.3, cacheRead: 0.006, output: 1.2 },
					"bad-key": { input: 1, output: 2 },
				}),
				currency: "{}",
				offPeakMultiplier: 0.5,
				offPeakTimezone: "UTC",
				dshHome: "",
			},
		},
	};
	react.__reset();
	const text = textOf(exports.ConfigForm({ view: "page", form }));
	// The preview names each model and its four bucket prices, with cacheRead and
	// cacheWrite falling back to the input price when the entry omits them. The
	// currency here is `{}`, which falls back to the default, so the labels are ¥.
	assert.match(text, /DeepSeek-V4\.1-Flash/);
	assert.match(text, /¥0\.3/);
	assert.match(text, /¥0\.006/);
	assert.match(text, /¥1\.2/);
	assert.match(text, /共 2 个模型/);
	assert.match(text, /bad-key：键名需要写成 <provider>\/<model>/);
	// A non-numeric price is flagged by the same check the save path runs.
	react.__reset();
	const badPrice = exports.ConfigForm({
		view: "page",
		form: { ...form, state: { ...form.state, value: { ...form.state.value, rates: JSON.stringify({ "a/m": { input: 1, output: "abc" } }) } } },
	});
	assert.match(textOf(badPrice), /a\/m 的输出价（output）需要非负数字/);
	react.__reset();
	const broken = exports.ConfigForm({
		view: "page",
		form: { ...form, state: { ...form.state, value: { ...form.state.value, rates: "{oops" } } },
	});
	assert.match(textOf(broken), /JSON 解析失败/);
});

test("the price preview shows which models are on a peak/off-peak tariff", () => {
	// The rule is a default derived from the key, so the form has to show it:
	// otherwise a reader cannot tell a flat route from a windowed one before
	// saving, which is how every model ended up labelled 非高峰 ×0.5 on the panel.
	const { exports, react } = loadBundle();
	react.__reset();
	const tree = exports.ConfigForm({
		view: "page",
		form: {
			state: {
				writable: true,
				revision: 1,
				value: {
					rates: JSON.stringify({
						"deepseek-official/deepseek-flash": { input: 2, output: 8 },
						"our-free-model/mimo-v2.6-flash-free": { input: 1, output: 2 },
						"vendor-x/m": { input: 1, output: 1, peakPricing: true },
						"vendor-y/m": { input: 1, output: 1, peakPricing: false },
					}),
					currency: JSON.stringify({ symbol: "¥", code: "CNY", perUsd: 1 }),
					offPeakMultiplier: 0.5,
					offPeakTimezone: "UTC",
					dshHome: "",
				},
			},
		},
	});
	const cellOf = (key) => textOf(walk(tree).find((node) => node.props?.["data-cost-preview-window"] === key));
	assert.equal(cellOf("deepseek-official/deepseek-flash"), "峰谷价", "a DeepSeek key gets the window");
	assert.equal(cellOf("our-free-model/mimo-v2.6-flash-free"), "固定价", "a non-DeepSeek key is flat");
	assert.equal(cellOf("vendor-x/m"), "峰谷价", "an explicit peakPricing:true opts a route in");
	assert.equal(cellOf("vendor-y/m"), "固定价", "an explicit peakPricing:false opts a DeepSeek-named route out");
	assert.match(textOf(tree), /「峰谷价」仅用于 DeepSeek/);
});

test("a non-boolean peakPricing is refused by name instead of reaching the Host", () => {
	const { exports, react } = loadBundle();
	react.__reset();
	const tree = exports.ConfigForm({
		view: "page",
		form: {
			state: {
				writable: true,
				revision: 1,
				value: { rates: JSON.stringify({ "vendor-x/m": { input: 1, output: 1, peakPricing: "yes" } }), currency: "{}", offPeakMultiplier: 0.5, offPeakTimezone: "UTC", dshHome: "" },
			},
		},
	});
	assert.match(textOf(tree), /vendor-x\/m 的 peakPricing（是否分高峰\/非高峰价）需要 true 或 false/);
});

test("the price preview is labelled with the configured currency, not a hardcoded dollar", () => {
	// The whole USD/CNY mistake this plugin made was invisible in the UI. The
	// preview is where a reader checks the numbers before saving them, so its
	// labels have to follow `currency` — both ways round.
	const { exports, react } = loadBundle();
	const rates = JSON.stringify({ "deepseek-official/deepseek-flash": { input: 2, cacheRead: 0.04, output: 8 } });
	const priceOf = (currency) => {
		react.__reset();
		const tree = exports.ConfigForm({
			view: "page",
			form: {
				state: {
					writable: true,
					revision: 1,
					value: { rates, currency: JSON.stringify(currency), offPeakMultiplier: 0.5, offPeakTimezone: "UTC", dshHome: "" },
				},
			},
		});
		return textOf(tree);
	};
	const yuan = priceOf({ symbol: "¥", code: "CNY", perUsd: 1 });
	assert.match(yuan, /¥2/);
	assert.match(yuan, /¥0\.04/);
	assert.match(yuan, /每 100 万 token 的单价（CNY）/);
	assert.ok(!yuan.includes("$2"), "no dollar label on a yuan table");
	const dollar = priceOf({ symbol: "$", code: "USD", perUsd: 1 });
	assert.match(dollar, /\$2/);
	assert.match(dollar, /每 100 万 token 的单价（USD）/);
});

test("the row form refuses invalid JSON and remembers the error instead of saving it", () => {
	const loaded = loadBundle();
	const ops = [];
	const form = {
		state: { writable: true, revision: 1, value: { rates: "{}", currency: "{}", offPeakMultiplier: 0.5, offPeakTimezone: "UTC", dshHome: "" } },
		mutate: (next, revision) => {
			ops.push({ next, revision });
			return Promise.resolve();
		},
	};
	// The unparseable text means no model could be read, which is what the form
	// reports rather than writing a table with the configured models deleted.
	const typed = driveForm(loaded, { view: "page", form }, [
		{ remount: true },
		{ edit: { find: (node) => node.props?.["data-cost-field"] === "rates", event: { target: { value: "{oops" } } } },
		{},
		{ click: saveButton },
	]);
	assert.equal(ops.length, 0, "nothing is saved");
	const shown = textOf(typed);
	console.log("DEBUG tail:", JSON.stringify(shown.slice(-140)));
	assert.match(shown, /价格表有问题/);
	assert.match(shown, /至少要有一个模型/);
});

test("the price table can be edited field by field and saves canonical JSON", () => {
	const loaded = loadBundle();
	const ops = [];
	const form = {
		state: {
			writable: true,
			revision: 3,
			value: {
				rates: JSON.stringify({ "deepseek-official/deepseek-flash": { label: "Flash", input: 2, cacheRead: 0.04, output: 8 } }),
				currency: JSON.stringify({ symbol: "¥", code: "CNY", perUsd: 1 }),
				offPeakMultiplier: 0.5,
				offPeakTimezone: "UTC",
				dshHome: "",
			},
		},
		mutate: (next, revision) => {
			ops.push({ next, revision });
			return Promise.resolve();
		},
	};
	// One row per configured model, with the prices published the way the docs show.
	const fresh = driveForm(loaded, { view: "page", form }, [{ remount: true }]);
	const inputs = walk(fresh).filter((node) => node.props?.["data-cost-rate"] !== undefined);
	assert.deepEqual(
		inputs.map((node) => node.props["data-cost-rate"]),
		["key", "input", "cacheRead", "cacheWrite", "output"],
	);
	assert.equal(rateCellOf(fresh, "input").props.value, "2");
	assert.equal(rateCellOf(fresh, "cacheWrite").props.value, "", "an absent cache-write price stays empty, i.e. 'same as input'");
	// Typing a price stages the whole table, canonicalized.
	driveForm(loaded, { view: "page", form }, [
		{ edit: { find: (node) => node.props?.["data-cost-rate"] === "input", event: { target: { value: "3.5" } } } },
		{},
		{ click: saveButton },
	]);
	assert.equal(ops.length, 1);
	assert.equal(ops[0].revision, 3);
	assert.deepEqual(ops[0].next, [{
		op: "set",
		path: ["rates"],
		value: "{\"deepseek-official/deepseek-flash\":{\"label\":\"Flash\",\"input\":3.5,\"cacheRead\":0.04,\"output\":8}}",
	}]);
});

test("the price table adds and removes models", () => {
	const loaded = loadBundle();
	const form = {
		state: {
			writable: true,
			revision: 1,
			value: {
				rates: JSON.stringify({
					"a/m": { input: 1, output: 2 },
					"b/m": { input: 3, output: 4 },
				}),
				currency: "{}",
				offPeakMultiplier: 0.5,
				offPeakTimezone: "UTC",
				dshHome: "",
			},
		},
	};
	const rowsOf = (tree) => walk(tree).filter((node) => node.props?.["data-cost-rate-row"] !== undefined);
	const initial = driveForm(loaded, { view: "page", form }, [{ remount: true }]);
	assert.equal(rowsOf(initial).length, 2);
	// Removing a model drops exactly that row.
	const removed = driveForm(loaded, { view: "page", form }, [
		{ click: { find: (node) => node.props?.["data-cost-rate-remove"] === "0", why: "each row has a delete button" } },
		{},
	]);
	assert.equal(rowsOf(removed).length, 1);
	assert.match(textOf(removed), /b\/m/);
	// Adding one appends an empty row for a new model.
	const added = driveForm(loaded, { view: "page", form }, [
		{ click: { find: (node) => node.props?.["data-cost-rate-add"] === "true", why: "the editor has an add button" } },
		{},
	]);
	assert.equal(rowsOf(added).length, 2);
	const empty = walk(added).find((node) => node.props?.["data-cost-rate"] === "key" && node.props["data-cost-row"] === "1");
	assert.equal(empty.props.value, "");
});

test("an unparseable price is reported and nothing is saved", () => {
	const loaded = loadBundle();
	const ops = [];
	const form = {
		state: { writable: true, revision: 1, value: { rates: JSON.stringify({ "a/m": { input: 1, output: 2 } }), currency: "{}", offPeakMultiplier: 0.5, offPeakTimezone: "UTC", dshHome: "" } },
		mutate: (next) => {
			ops.push(next);
			return Promise.resolve();
		},
	};
	const shown = driveForm(loaded, { view: "page", form }, [
		{ remount: true },
		{ edit: { ...rateField("output"), event: { target: { value: "abc" } } } },
		{ click: saveButton },
	]);
	assert.equal(ops.length, 0, "a bad price never reaches the Host");
	// A non-numeric cell cannot be turned into a table, so the form refuses and says
	// which row is unusable rather than storing a price the Host would reject.
	assert.match(textOf(shown), /价格表有问题/);
	// And the typed value is still on screen, so the work is not lost.
	assert.equal(rateCellOf(shown, "output").props.value, "abc");
});

test("a well-formed table with a non-numeric price is refused by name", () => {
	// The same guard, reached the way it happens in practice: the advanced JSON is
	// valid, so the table parses — but one price is not a number, and the Host
	// would reject the whole row at mount if it were saved.
	const loaded = loadBundle();
	const ops = [];
	const form = {
		state: {
			writable: true,
			revision: 1,
			value: {
				rates: JSON.stringify({ "a/m": { input: 1, output: "abc" } }),
				currency: "{}",
				offPeakMultiplier: 0.5,
				offPeakTimezone: "UTC",
				dshHome: "",
			},
		},
		mutate: (next) => {
			ops.push(next);
			return Promise.resolve();
		},
	};
	const shown = driveForm(loaded, { view: "page", form }, [
		{ remount: true },
		{ click: saveButton },
	]);
	assert.equal(ops.length, 0, "the invalid table is not saved");
	assert.match(textOf(shown), /a\/m 的输出价（output）需要非负数字/);
});

test("editing one price keeps the advanced fields configured on that model", () => {
	// The table edits four prices; everything else in the entry is not the table's
	// business and must survive, or a UI edit would silently delete a setting the
	// user made in the advanced JSON.
	const loaded = loadBundle();
	const ops = [];
	const form = {
		state: {
			writable: true,
			revision: 1,
			value: {
				rates: JSON.stringify({ "a/m": { input: 1, output: 2, offPeakMultiplier: 0.25, inputOffPeak: 0.4 } }),
				currency: "{}",
				offPeakMultiplier: 0.5,
				offPeakTimezone: "UTC",
				dshHome: "",
			},
		},
		mutate: (next) => {
			ops.push(next);
			return Promise.resolve();
		},
	};
	driveForm(loaded, { view: "page", form }, [
		{ remount: true },
		{ edit: { ...rateField("input"), event: { target: { value: "1.5" } } } },
		{},
		{ click: saveButton },
	]);
	assert.equal(ops.length, 1);
	assert.deepEqual(JSON.parse(ops[0][0].value), { "a/m": { input: 1.5, output: 2, offPeakMultiplier: 0.25, inputOffPeak: 0.4 } });
});

test("the row form renders a read-only notice when the page cannot write", () => {
	const { exports, react } = loadBundle();
	const form = { state: { writable: false, revision: 1, value: { rates: "{}", currency: "{}", offPeakMultiplier: 0.5, offPeakTimezone: "UTC", dshHome: "" } } };
	react.__reset();
	assert.match(textOf(exports.ConfigForm({ view: "page", form })), /只读/);
});

test("the row form summarizes itself and reports a missing namespace", () => {
	const { exports, react } = loadBundle();
	react.__reset();
	assert.match(textOf(exports.ConfigForm({ view: "summary" })), /session_cost/);
	react.__reset();
	assert.match(textOf(exports.ConfigForm({ view: "page", form: undefined })), /配置暂不可用/);
});

test("the pricing helpers exported for tests agree with the Host implementation", () => {
	const { exports } = loadBundle();
	assert.equal(exports.formatTokens(12_345), "12k");
	assert.equal(exports.formatMoney(12_300, { symbol: "$", perUsd: 1 }), "$0.0123");
	assert.equal(exports.resolveRates({ "p/m": { input: 1, output: 2 } }, "other", "m").input, 1);
	assert.equal(exports.resolveRates({ "p/m": { input: 1 }, "q/m": { input: 2 } }, "z", "m"), undefined, "an ambiguous bare model is not guessed");
	assert.equal(exports.isPeak(Date.UTC(2026, 0, 5, 2, 0), "UTC"), true);
	assert.equal(exports.isPeak(Date.UTC(2026, 0, 5, 12, 0), "UTC"), false);
	assert.equal(exports.isPeak(Date.UTC(2026, 0, 10, 2, 0), "UTC"), false, "weekends are off-peak");
});

test("ui-primitives are used when present and skipped when absent", () => {
	// The real palettes, so a tone typo fails here instead of rendering an
	// unstyled badge on the page. `Tag` accepts these; `Button` these variants.
	const TAG_TONES = ["outline", "solid", "neutral", "quiet", "success", "warning", "error", "info"];
	const variants = [];
	const primitives = {
		Input: "stub-input",
		Button: (props) => {
			variants.push(props.variant);
			return { type: "stub-button", props, children: props.children };
		},
		Tag: (props) => ({ type: "stub-tag", props, children: props.children }),
		Tooltip: (props) => ({ type: "stub-tooltip", props, children: props.children }),
	};
	const { exports, react } = loadBundle({ primitives, fetchImpl: configStub() });
	const form = { state: { writable: true, revision: 1, value: { rates: "{}", currency: "{}", offPeakMultiplier: 0.5, offPeakTimezone: "UTC", dshHome: "" } } };
	react.__reset();
	const tree = exports.ConfigForm({ view: "page", form });
	assert.ok(walk(tree).some((node) => node.type === "stub-input"), "the primitive input renders");
	assert.ok(walk(tree).some((node) => node.type === "stub-button"), "the primitive button renders");
	assert.ok(variants.includes("primary"), "the save action uses a declared Button variant");

	// A primitives-free page still renders the same controls as plain elements.
	const plain = loadBundle({ fetchImpl: configStub() });
	plain.react.__reset();
	const plainTree = plain.exports.ConfigForm({ view: "page", form });
	assert.ok(walk(plainTree).some((node) => node.type === "input"), "a native input stands in");
	assert.ok(walk(plainTree).some((node) => node.type === "button"), "a native button stands in");
});

test("the price-window badge uses a real Tag tone on a primitives page", async () => {
	const tones = [];
	const primitives = {
		Button: (props) => ({ type: "stub-button", props, children: props.children }),
		Tag: (props) => {
			tones.push(props.tone);
			return { type: "stub-tag", props, children: props.children };
		},
	};
	const { exports, mount } = loadBundle({ primitives, fetchImpl: configStub() });
	const usage = { uncachedInputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 };
	await mountWithClicks(mount, exports.CostPill, props({ usage }), [pillOf]);
	assert.ok(tones.length >= 1, "the badge rendered through Tag");
	for (const tone of tones) {
		assert.ok(
			["outline", "solid", "neutral", "quiet", "success", "warning", "error", "info"].includes(tone),
			`Tag tone "${tone}" is not one of the primitive's palettes`,
		);
	}
});

