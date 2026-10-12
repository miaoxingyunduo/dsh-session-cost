/**
 * Browser half of @local/dsh-session-cost.
 *
 * A compact capsule beside DSH's own stats shows what the open conversation
 * consumed and what it cost; opening it reveals the breakdown — a cost-share
 * bar, the per-token-kind rows, the cache-hit share, which price window
 * applied — plus copy and "与日志核对" actions. The second registration renders
 * the row's rate-table form on the Plugins page, with a live preview of what the
 * edited table actually prices.
 *
 * Styling uses DSH's theme tokens only (read from the running theme registry, so
 * the readout follows light/dark), and ships as a real stylesheet rather than
 * inline styles — that is what makes hover, focus-visible, and a popover
 * possible. The capsule, buttons, badge and tooltip come from
 * `@deepseek-ai/dsh-client-ui-primitives` when present and degrade to plain
 * elements when not.
 *
 * Where the numbers come from:
 *
 * - token buckets: the `tokenUsage` projection, which DSH's own `dsh-token-meter`
 *   folds from the durable log (cache reads included, exactly as the provider
 *   billed them);
 * - the model that spent them: the `modelSelection` projection;
 * - prices: this plugin's Host row config, fetched from
 *   `/api/session-cost/config` and refreshed on a slow interval so a rate edit
 *   reaches an open page without a reload.
 *
 * The pill prices the whole conversation at the conversation's current model.
 * That is exact for the ordinary case and documented as an approximation for a
 * conversation that switched models mid-flight; `session_cost` (and the
 * "与日志核对" button, which asks the Host to recompute from the log) gives the
 * exact per-route figures.
 *
 * The bundle is served as-is by the Web client's module loader, so it uses the
 * `window.__ModuleLoader__.load({ id, factory })` wrapper instead of a build step.
 */

window.__ModuleLoader__.load({
	id: "@local/dsh-session-cost",
	factory: (require) => {
		const react = require("react");
		/** Primitives are optional: without them everything degrades to plain elements. */
		let primitives;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch {
			primitives = undefined;
		}
		const Tag = primitives?.Tag;
		// `ActionButton` and `TextInput` fall back to their native tags: reading the
		// property off an absent module would yield `undefined`, and React needs a
		// tag name to render the element at all.
		const ActionButton = primitives?.Button ?? "button";
		const Tooltip = primitives?.Tooltip;
		// `Input` is a plain text-entry primitive; the form passes every native
		// input prop through, so using it when present is a drop-in.
		const TextInput = primitives?.Input ?? "input";

		const module = { exports: {} };
		const exports = module.exports;

		/** This package's name, used for the Plugins-page slot keys. */
		const PACKAGE_NAME = "@local/dsh-session-cost";
		/** Host routes registered by lib/index.js. */
		const CONFIG_PATH = "/api/session-cost/config";
		const VERIFY_PATH = "/api/session-cost/verify";
		const FAMILY_PATH = "/api/session-cost/family";
		/** How often the open page re-reads the rate table. */
		const CONFIG_REFRESH_MS = 30000;
		/**
		 * How long the Pill keeps a delegated-family answer.
		 *
		 * The family is asked for even while the panel is closed, because the pill
		 * is the number a reader takes away and it has to include what the
		 * conversation delegated. Re-asking on every render would hammer the Host,
		 * so an answer is reused for this long and every panel open re-reads it.
		 */
		const FAMILY_TTL_MS = 15000;
		/** Class prefix, so every rule is scoped to this package. */
		const NS = "dsh-cost";
		/** Remember the expanded state, so a reload keeps the reader's choice. */
		const OPEN_KEY = `${NS}:open`;
		/** Gap left between the panel's top edge and whatever clips it. */
		const PANEL_GAP = 8;
		/** Below this the readout is not worth opening, so the floor outranks a tiny room. */
		const PANEL_FLOOR = 220;

		/**
		 * The package stylesheet. Every colour is a theme token; only dynamic
		 * geometry (a bar segment's width) stays inline, because CSS cannot know it.
		 */
		const CSS = `
.${NS}-root { position: relative; display: block; }
.${NS}-pill {
  display: inline-flex; align-items: center; gap: 6px;
  height: 24px; padding: 0 8px; box-sizing: border-box;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11px; line-height: 1;
  cursor: pointer; white-space: nowrap;
  transition: background-color .12s ease, border-color .12s ease, color .12s ease;
}
.${NS}-pill:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.${NS}-pill:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.${NS}-pill[data-open="true"] {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
}
.${NS}-pill[data-tone="warn"] { border-color: var(--dsw-alias-state-warn-primary); }
.${NS}-pill[data-tone="warn"] .${NS}-amount { color: var(--dsw-alias-state-warn-primary); }
.${NS}-amount { color: var(--dsw-alias-label-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.${NS}-family {
  color: var(--dsw-alias-label-secondary);
  font-size: 10px; letter-spacing: .02em;
  padding: 1px 4px; border-radius: 3px;
  background: var(--dsw-alias-bg-layer-2);
}
.${NS}-self { color: var(--dsw-alias-brand-primary); }
.${NS}-derived { color: var(--dsw-alias-state-warn-primary); }
.${NS}-sep { color: var(--dsw-alias-border-l2); }
.${NS}-tokens { font-variant-numeric: tabular-nums; }
.${NS}-chevron { display: inline-block; color: var(--dsw-alias-label-secondary); transition: transform .12s ease; }
.${NS}-pill[data-open="true"] .${NS}-chevron { transform: rotate(180deg); }
.${NS}-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary); flex: none;
}
.${NS}-pill[data-running="true"] .${NS}-dot { background: var(--dsw-alias-state-success-primary); }

/* The panel opens upward from a pill that DSH mounts inside the conversation's
   scroll port, so the room above it ends at that port's top edge, not at the
   window's: a panel taller than the room would push its own header past the edge
   and out of sight. It therefore scrolls instead of growing — this rule is the
   first-paint ceiling, and the readout replaces it with a measured one as soon
   as it can see the DOM (see 'panelCeiling'). */
.${NS}-panel {
  position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 40;
  width: 344px; max-width: min(344px, 86vw);
  max-height: max(220px, min(64vh, calc(100vh - 200px)));
  overflow: hidden auto; overscroll-behavior: contain;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  --dsh-scrollbar-width: 6px;
  --dsh-scrollbar-thumb-border: 2px;
  --dsh-scrollbar-track-margin: 12px;
  padding: 10px 12px 11px; box-sizing: border-box;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font-size: 11px; line-height: 18px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 12%);
}
.${NS}-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.${NS}-title { font-size: 12px; font-weight: 600; }
.${NS}-sub { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); }
.${NS}-muted { color: var(--dsw-alias-label-secondary); }
.${NS}-error { color: var(--dsw-alias-state-error-primary); }
.${NS}-warn { color: var(--dsw-alias-state-warn-primary); }
.${NS}-ok { color: var(--dsw-alias-state-success-primary); }
.${NS}-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }

.${NS}-bar { display: flex; height: 6px; margin: 9px 0 5px; border-radius: 999px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); }
.${NS}-bar span { display: block; height: 100%; transition: width .18s ease; }
.${NS}-legend { display: flex; flex-wrap: wrap; gap: 3px 10px; }
.${NS}-legend span { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); }
.${NS}-swatch { width: 7px; height: 7px; border-radius: 2px; flex: none; }

.${NS}-rows { display: flex; flex-direction: column; gap: 2px; margin-top: 7px; }
.${NS}-row { display: flex; align-items: baseline; gap: 8px; }
.${NS}-row-label { flex: 1 1 auto; color: var(--dsw-alias-label-secondary); }
.${NS}-row-tokens { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.${NS}-row-amount { flex: none; min-width: 62px; text-align: right; font-variant-numeric: tabular-nums; }
.${NS}-section { margin-top: 9px; padding-top: 8px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.${NS}-route { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.${NS}-actions { display: flex; align-items: center; gap: 6px; margin-top: 9px; flex-wrap: wrap; }
.${NS}-pre {
  margin: 8px 0 0; padding: 6px 8px; max-height: 168px; overflow: auto;
  white-space: pre-wrap; word-break: break-all;
  background: var(--dsw-alias-bg-layer-2);
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px; line-height: 16px;
}
.${NS}-foot { margin-top: 8px; color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 15px; }
.${NS}-summary { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-top: 7px; }
.${NS}-total { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }

.${NS}-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; font-size: 12px; }
.${NS}-field > span:first-child { color: var(--dsw-alias-label-secondary); }
.${NS}-control {
  width: 100%; box-sizing: border-box; padding: 6px 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 20px; outline: none;
}
.${NS}-control:focus-visible { border-color: var(--dsw-alias-brand-primary); }
.${NS}-control[disabled] { opacity: .6; }
textarea.${NS}-control { min-height: 118px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 18px; }
.${NS}-preview { margin: 2px 0 6px; }
.${NS}-preview table { width: 100%; border-collapse: collapse; font-size: 11px; }
.${NS}-preview th, .${NS}-preview td { padding: 3px 6px; text-align: right; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
.${NS}-preview th:first-child, .${NS}-preview td:first-child { text-align: left; }
.${NS}-preview th { color: var(--dsw-alias-label-secondary); font-weight: 500; }

/* The price editor: a table of models, one row per model, so a price can be
   typed the way it is published rather than as JSON. */
.${NS}-rates { width: 100%; border-collapse: collapse; font-size: 12px; }
.${NS}-rates th {
  padding: 2px 4px; text-align: left; font-weight: 500;
  color: var(--dsw-alias-label-secondary); white-space: nowrap;
}
.${NS}-rates th.${NS}-num { text-align: right; }
.${NS}-rates td { padding: 2px 4px; vertical-align: middle; }
.${NS}-rates tr + tr td { border-top: 0.5px solid var(--dsw-alias-border-l1); }
.${NS}-rates input {
  width: 100%; box-sizing: border-box; padding: 3px 5px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; text-align: right;
  font-variant-numeric: tabular-nums; outline: none;
}
.${NS}-rates input[type="text"] { text-align: left; }
.${NS}-rates input:focus-visible { border-color: var(--dsw-alias-brand-primary); }
.${NS}-rates input[disabled] { opacity: .6; }
.${NS}-rates td.${NS}-key { min-width: 150px; }
.${NS}-rates td.${NS}-num { width: 74px; }
.${NS}-rates td.${NS}-act { width: 26px; text-align: right; }
.${NS}-drop {
  border: 0; padding: 1px 5px; border-radius: 4px; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 13px; line-height: 18px;
}
.${NS}-drop:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); }
.${NS}-drop[disabled] { cursor: default; opacity: .4; }
.${NS}-advanced > summary {
  cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 12px; margin-bottom: 6px;
}
.${NS}-advanced[open] > summary { margin-bottom: 8px; }
.${NS}-note {
  margin: 0 0 8px; padding: 6px 8px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px; line-height: 16px;
}
.${NS}-grid { display: flex; gap: 10px; flex-wrap: wrap; }
.${NS}-grid > * { flex: 1 1 160px; }
`;

		/**
		 * Ensure this package's stylesheet is in the document.
		 *
		 * The static client-bundle format has no `styles.insert` builtin (that
		 * belongs to dynamically defined packages), so the bundle owns one tagged
		 * `<style>` element. A duplicate boot replaces the tag's text instead of
		 * stacking a second copy of the rules.
		 */
		function sheet() {
			if (typeof document === "undefined" || document.head === undefined) return;
			const existing = document.head.querySelector("style[data-dsh-cost]");
			if (existing !== null) {
				if (existing.textContent !== CSS) existing.textContent = CSS;
				return;
			}
			const tag = document.createElement("style");
			tag.setAttribute("data-dsh-cost", "");
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** Durable buckets, in display order, with the price field and bar colour each maps to. */
		const BUCKETS = [
			{ key: "uncachedInputTokens", priceField: "input", label: "输入 · 未命中缓存", short: "未命中", color: "var(--dsw-alias-brand-primary)" },
			{ key: "cacheReadTokens", priceField: "cacheRead", label: "输入 · 命中缓存", short: "命中缓存", color: "var(--dsw-alias-state-success-primary)" },
			{ key: "cacheWriteTokens", priceField: "cacheWrite", label: "输入 · 缓存写入", short: "缓存写入", color: "var(--dsw-alias-state-warn-primary)" },
			{ key: "outputTokens", priceField: "output", label: "输出", short: "输出", color: "var(--dsw-alias-label-secondary)" },
		];

		/**
		 * The route a conversation is priced under, as `<provider>/<model>`.
		 *
		 * This is the key the rate table is written in, so it is what the readout
		 * shows: it names the entry to edit and it cannot be confused with another
		 * provider serving the same model name.
		 *
		 * @param {object} [route] - `{provider, model}` from the `modelSelection` projection.
		 * @returns {string} the route, or a placeholder when nothing has been used yet.
		 */
		function routeDisplay(route) {
			const provider = typeof route?.provider === "string" ? route.provider.trim() : "";
			const model = typeof route?.model === "string" ? route.model.trim() : "";
			if (provider !== "" && model !== "") return `${provider}/${model}`;
			if (model !== "") return model;
			if (provider !== "") return provider;
			return "未识别模型";
		}

		/** Format a token count compactly. */
		function formatTokens(tokens) {			const value = Number(tokens ?? 0);
			if (!Number.isFinite(value)) return "0";
			const abs = Math.abs(value);
			if (abs < 1000) return String(Math.round(value));
			if (abs < 1_000_000) return `${(value / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`;
			return `${(value / 1_000_000).toFixed(abs < 10_000_000 ? 2 : 1)}M`;
		}

		/** Group a token count with thousands separators. */
		function groupTokens(tokens) {
			return Math.round(Number(tokens ?? 0)).toLocaleString("en-US");
		}

		/**
		 * A context size against the model's window, e.g. `169k / 1.0M`.
		 *
		 * DSH's own stats show this pair, and it is the number a reader compares a
		 * token count against — so it is rendered here in the same shape, with the
		 * window kept explicit rather than left as a bare percentage.
		 */
		function formatContext(tokens, window) {
			const used = Number(tokens ?? 0);
			const max = Number(window ?? 0);
			if (!Number.isFinite(used) || used <= 0) return undefined;
			if (!Number.isFinite(max) || max <= 0) return formatTokens(used);
			return `${formatTokens(used)} / ${formatTokens(max)}`;
		}

		/** Format micro-USD in the configured display currency (mirrors lib/rates.js). */
		function formatMoney(microUsd, currency) {
			const amount = (Number(microUsd ?? 0) / 1_000_000) * (currency?.perUsd ?? 1);
			const digits = amount === 0 ? 2 : Math.abs(amount) >= 1 ? 4 : Math.min(8, Math.max(2, -Math.floor(Math.log10(Math.abs(amount))) + 2));
			return `${currency?.symbol ?? "$"}${amount.toFixed(digits)}`;
		}

		/** A price per million tokens, trimmed of float noise and shown in the display currency. */
		function formatPrice(pricePerMillion, currency) {
			const value = Number(pricePerMillion ?? 0);
			if (!Number.isFinite(value)) return "—";
			return `${currency?.symbol ?? ""}${Number(value.toPrecision(4))}`;
		}

		/**
		 * The tariff one priced result is on, in parentheses.
		 *
		 * A route with a single flat price has no window, so it gets neither
		 * "高峰价" nor "非高峰 ×0.5": naming one would describe a discount its
		 * provider does not offer, which is what made the panel claim an off-peak
		 * price for a model that bills one flat rate.
		 *
		 * @param {{peak: boolean, windowed: boolean, multiplier: number}} priced - one priced result.
		 * @returns {string} e.g. `（非高峰价 ×0.5）`, `（固定价）`.
		 */
		function priceWindowText(priced) {
			if (priced.windowed === false) return "（固定价）";
			return priced.peak ? "（高峰价）" : `（非高峰价 ×${priced.multiplier}）`;
		}

		/**
		 * Whether a model's price list has a peak/off-peak window, when the Host did
		 * not state it. Mirrors `defaultPeakPricing` in lib/rates.js: the window is
		 * DeepSeek's own billing rule, so a rate key that does not name DeepSeek is
		 * charged one flat price all day.
		 */
		function defaultPeakPricing(key) {
			return /deepseek/i.test(String(key ?? ""));
		}

		/**
		 * Whether an instant is in the provider's peak window (01:00–04:00 and
		 * 06:00–10:00 UTC, Monday–Friday, excluding Chinese public holidays).
		 * Mirrors lib/rates.js, holidays included — a holiday the Host treats as
		 * off-peak must not show a peak badge here, or the two halves disagree.
		 */
		function isPeak(timeMs, timezone, holidays) {
			const date = new Date(timeMs);
			let weekday = date.getUTCDay();
			let hour = date.getUTCHours();
			let day = date.toISOString().slice(0, 10);
			if (typeof timezone === "string" && timezone !== "" && timezone !== "UTC") {
				try {
					const parts = Object.fromEntries(
						new Intl.DateTimeFormat("en-CA", {
							timeZone: timezone,
							weekday: "short",
							hour: "2-digit",
							year: "numeric",
							month: "2-digit",
							day: "2-digit",
							hour12: false,
						})
							.formatToParts(date)
							.map((part) => [part.type, part.value]),
					);
					weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
					hour = Number(parts.hour) % 24;
					day = `${parts.year}-${parts.month}-${parts.day}`;
				} catch {
					// An unusable zone falls back to UTC rather than failing the readout.
				}
			}
			if (weekday === 0 || weekday === 6) return false;
			for (const holiday of holidays ?? []) {
				if (holiday === day) return false;
			}
			return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
		}

		/**
		 * Normalize the Host's rate table the way lib/rates.js does.
		 *
		 * `peakPricing` is resolved from the key when the Host did not send it, so
		 * the page reaches the same verdict as the Host even against a payload that
		 * predates the field: only a DeepSeek-priced route has an off-peak tariff.
		 */
		function normalizeRates(raw) {
			const table = {};
			if (raw === null || typeof raw !== "object") return table;
			for (const [key, entry] of Object.entries(raw)) {
				if (entry === null || typeof entry !== "object") continue;
				const input = Number(entry.input ?? 0);
				const peakPricing = typeof entry.peakPricing === "boolean" ? entry.peakPricing : defaultPeakPricing(key);
				table[key] = {
					label: entry.label,
					input,
					cacheRead: entry.cacheRead === undefined ? input : Number(entry.cacheRead),
					cacheWrite: entry.cacheWrite === undefined ? input : Number(entry.cacheWrite),
					output: Number(entry.output ?? 0),
					peakPricing,
					offPeakMultiplier: entry.offPeakMultiplier,
					inputOffPeak: entry.inputOffPeak,
					cacheReadOffPeak: entry.cacheReadOffPeak,
					cacheWriteOffPeak: entry.cacheWriteOffPeak,
					outputOffPeak: entry.outputOffPeak,
				};
			}
			return table;
		}

		/**
		 * Resolve the rate entry for a route: exact provider/model first, then a
		 * unique bare-model match. Mirrors the Host so the two halves agree.
		 */
		function resolveRates(table, provider, model) {
			if (typeof model !== "string" || model.length === 0) return undefined;
			const exact = `${provider ?? ""}/${model}`;
			if (Object.hasOwn(table, exact)) return table[exact];
			const candidates = Object.keys(table).filter((key) => key.slice(key.indexOf("/") + 1) === model);
			return candidates.length === 1 ? table[candidates[0]] : undefined;
		}

		/**
		 * Price one token-bucket set under one route, mirroring lib/rates.js.
		 * Peak/off-peak has no per-attempt instant on this side, so the caller
		 * passes one representative instant for the whole readout.
		 *
		 * A route whose price list has no window is charged its single price; the
		 * returned `windowed` is what keeps the panel from claiming an off-peak
		 * discount that its provider does not offer.
		 */
		function priceBuckets(buckets, rates, config) {
			const windowed = rates.peakPricing !== false;
			const peak = windowed ? isPeak(config.at ?? Date.now(), config.offPeakTimezone, config.offPeakHolidays) : true;
			const multiplier = windowed ? (rates.offPeakMultiplier ?? config.offPeakMultiplier ?? 1) : 1;
			let microUsd = 0;
			const rows = [];
			for (const bucket of BUCKETS) {
				const tokens = Math.max(0, Math.trunc(Number(buckets?.[bucket.key] ?? 0)));
				const peakPrice = Number(rates[bucket.priceField] ?? 0);
				const override = rates[`${bucket.priceField}OffPeak`];
				const price = peak ? peakPrice : Number(override === undefined ? peakPrice * multiplier : override);
				const micro = Math.round((tokens * price * 1_000_000) / 1_000_000);
				microUsd += micro;
				rows.push({ ...bucket, tokens, price, microUsd: micro });
			}
			return { microUsd, peak, windowed, rows, multiplier };
		}

		/**
		 * Read the Host's live rate configuration, refreshing on an interval so a
		 * saved rate edit reaches an already-open page.
		 */
		function useCostConfig() {
			const [state, setState] = react.useState({ status: "loading" });
			react.useEffect(() => {
				let alive = true;
				const load = () => {
					fetch(CONFIG_PATH, { credentials: "same-origin", headers: { accept: "application/json" } }).then(
						async (response) => {
							const data = await response.json().catch(() => undefined);
							if (!alive) return;
							if (data === undefined || data?.ok !== true) {
								setState({ status: "error", error: data?.error ?? `HTTP ${response.status}` });
								return;
							}
							setState((previous) => {
								if (previous.status === "ready" && previous.revision === data.revision) return previous;
								return {
									status: "ready",
									revision: data.revision,
									rates: normalizeRates(data.rates),
									currency: data.currency ?? { symbol: "¥", code: "CNY", perUsd: 1 },
									offPeakMultiplier: data.offPeakMultiplier ?? 0.5,
									offPeakTimezone: data.offPeakTimezone ?? "UTC",
									// The Host owns the holiday calendar; the page only mirrors it,
									// so the peak badge cannot drift from the bill.
									offPeakHolidays: Array.isArray(data.offPeakHolidays) ? data.offPeakHolidays : [],
									rateCount: Object.keys(data.rates ?? {}).length,
								};
							});
						},
						(error) => {
							if (alive) setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
						},
					);
				};
				load();
				const timer = setInterval(load, CONFIG_REFRESH_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);
			return state;
		}

		/**
		 * The cost readout for one conversation. Returns `null` while there is
		 * nothing to show, so the caller can render nothing at all.
		 */
		function useSessionCost(props, config, at) {
			const useProjection = props.useProjection;
			const usage = typeof useProjection === "function" ? useProjection("tokenUsage") : undefined;
			const selection = typeof useProjection === "function" ? useProjection("modelSelection") : undefined;
			// DSH's own meter reads a second projection: the size of the context the
			// next call will send, against the model's window. That is the number a
			// reader sees in DSH's own stats, and it is a completely different measure
			// from the cumulative bill — so the readout has to carry both, labelled.
			const pressure = typeof useProjection === "function" ? useProjection("contextPressure") : undefined;
			const useSession = props.useSession;
			const session = typeof useSession === "function" ? useSession((value) => value) : undefined;
			return react.useMemo(() => {
				if (config.status !== "ready") return null;
				const buckets = {
					uncachedInputTokens: Number(usage?.uncachedInputTokens ?? 0),
					cacheReadTokens: Number(usage?.cacheReadTokens ?? 0),
					cacheWriteTokens: Number(usage?.cacheWriteTokens ?? 0),
					outputTokens: Number(usage?.outputTokens ?? 0),
				};
				const total = BUCKETS.reduce((sum, bucket) => sum + buckets[bucket.key], 0);
				if (total === 0) return null;
				const route = selection?.lastUsed ?? selection?.next ?? undefined;
				const rates = route === undefined ? undefined : resolveRates(config.rates, route.provider, route.model);
				const priced = rates === undefined ? undefined : priceBuckets(buckets, rates, { ...config, at });
				// The same three answers DSH itself can give, kept apart on purpose:
				// what the next call sends, what this conversation newly generated, and
				// what the whole conversation was billed for (cache re-reads included).
				const surfaceTokens = Number(pressure?.surfaceTokens ?? 0);
				const contextWindow = Number(pressure?.contextWindow ?? 0);
				return {
					sessionId: props.sessionId,
					route,
					rates,
					buckets,
					total,
					// 新增：真正新产生的 token，不含重复发送的上下文
					freshTokens: buckets.uncachedInputTokens + buckets.cacheWriteTokens + buckets.outputTokens,
					contextTokens: surfaceTokens,
					contextWindow,
					priced,
					microUsd: priced?.microUsd ?? 0,
					billedInput: buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens,
					running: session?.running === true,
				};
			}, [config, usage, selection, pressure, session, props.sessionId, at]);
		}

		/** One labelled row: name on the left, tokens and amount on the right. */
		function bucketRow(label, tokens, amount, key) {
			return react.createElement(
				"div",
				{ className: `${NS}-row`, key },
				react.createElement("span", { className: `${NS}-row-label` }, label),
				react.createElement("span", { className: `${NS}-row-tokens` }, groupTokens(tokens)),
				react.createElement("span", { className: `${NS}-row-amount` }, amount),
			);
		}

		/**
		 * The y coordinate of the topmost edge that clips a popover anchored at
		 * `element`, in viewport coordinates.
		 *
		 * DSH mounts the composer inside the conversation's scroll port, so an
		 * absolutely positioned popover above the pill is clipped by that port and
		 * not by the window. Walking the ancestors for boxes that declare an
		 * overflow — every one of them clips, so the largest top wins, since it is
		 * the boundary nearest the anchor — finds the edge the panel actually has to
		 * fit under. The viewport (0) is the fallback for a surface that declares none.
		 *
		 * @param {Element} element - the popover's anchor, i.e. the pill's wrapper.
		 * @param {Function} getStyle - `getComputedStyle`, injected so a test can hand over boxes.
		 * @returns {number} the edge, or 0 when nothing above the anchor clips.
		 */
		function clipTopOf(element, getStyle) {
			let top = 0;
			try {
				for (let node = element?.parentElement ?? null; node !== null && node !== undefined; node = node.parentElement ?? null) {
					const overflowY = getStyle?.(node)?.overflowY;
					if (overflowY === undefined || overflowY === "visible") continue;
					const rect = node.getBoundingClientRect?.();
					if (typeof rect?.top === "number" && Number.isFinite(rect.top) && rect.top > top) top = rect.top;
				}
			} catch {
				// A box that refuses to be styled or measured keeps whatever was found.
			}
			return top;
		}

		/**
		 * How tall the panel may be: the room between its anchor and the edge that
		 * clips it, less the gap, floored so a window too small for any of it still
		 * shows a usable readout instead of a sliver.
		 *
		 * @param {object} input - geometry in viewport coordinates.
		 * @returns {number|undefined} the ceiling in pixels, or nothing when unmeasurable —
		 *   in which case the stylesheet's own ceiling stays in force.
		 */
		function panelCeiling({ anchorTop, clipTop, gap = PANEL_GAP, floor = PANEL_FLOOR }) {
			if (!Number.isFinite(anchorTop) || !Number.isFinite(clipTop)) return undefined;
			return Math.max(floor, Math.floor(anchorTop - clipTop - gap));
		}

		/**
		 * The capsule plus its breakdown popover.
		 *
		 * Registered in a list slot, so it owns its state outright: expansion is
		 * remembered across reloads, an outside pointer press or Escape closes it,
		 * and the readout tolerates a surface that passes no projection hooks.
		 */
		function CostPill(props) {
			const config = useCostConfig();
			const [open, setOpen] = react.useState(() => {
				try {
					return globalThis.localStorage?.getItem(OPEN_KEY) === "1";
				} catch {
					return false;
				}
			});
			const [verify, setVerify] = react.useState({ status: "idle" });
			const [copied, setCopied] = react.useState(false);
			const rootRef = react.useRef(null);
			// One instant for the whole readout: the peak/off-peak label must not
			// change under the reader while the panel is open. It is a display hint,
			// not a bill — the Host prices each attempt at its own timestamp.
			const [at] = react.useState(() => Date.now());
			const cost = useSessionCost(props, config, at);
			// Delegated sessions are other logs, so their totals cannot come from a
			// projection — the Host is asked once per open, for this session only.
			const [family, setFamily] = react.useState({ status: "idle" });
			const [familyOpen, setFamilyOpen] = react.useState(false);
			/** Bumped by the section's 刷新 button to re-read the family. */
			const [familyRefresh, setFamilyRefresh] = react.useState(0);

			const setOpenPersisted = (next) => {
				setOpen(next);
				try {
					globalThis.localStorage?.setItem(OPEN_KEY, next ? "1" : "0");
				} catch {
					// A storage-less page simply forgets the choice.
				}
			};

			react.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const root = rootRef.current;
					if (root !== null && root !== undefined && !root.contains(event.target)) setOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);

			// The panel has to fit above the pill, and how much room that is cannot be
			// known from CSS alone — the answer depends on where DSH's scroll port
			// ends. So the stylesheet's ceiling is only a first-paint bound, and every
			// open measures the real one. `useLayoutEffect` where the surface has it,
			// so the corrected ceiling is in place before the panel is painted.
			const [ceiling, setCeiling] = react.useState(undefined);
			const measureBeforePaint = react.useLayoutEffect ?? react.useEffect;
			measureBeforePaint(() => {
				if (!open) return undefined;
				const root = rootRef.current;
				if (root === null || root === undefined || typeof root.getBoundingClientRect !== "function") return undefined;
				const measure = () => {
					try {
						const rect = root.getBoundingClientRect();
						setCeiling(panelCeiling({
							anchorTop: rect.top,
							clipTop: clipTopOf(root, (node) => globalThis.getComputedStyle(node)),
						}));
					} catch {
						// A surface that will not be measured keeps the stylesheet's ceiling.
					}
				};
				measure();
				// A window that changes size moves the pill, and with it the room.
				globalThis.addEventListener?.("resize", measure);
				return () => globalThis.removeEventListener?.("resize", measure);
			}, [open]);

			// Ask for the delegated family as soon as there is an amount to show,
			// not only while the panel is open: the capsule is the number a reader
			// takes away, and it has to include what this conversation delegated
			// instead of quietly reporting the main session alone.
			//
			// The effect is deliberately keyed on primitives. `cost` is a fresh
			// object on every render, so depending on it would re-ask the Host on
			// every keystroke elsewhere in the composer; the session id and the
			// refresh counter are what actually mean "read it again". One answer per
			// session is kept, and the 刷新 button is the way to force a re-read.
			const answersAt = react.useRef(0);
			const askedFor = react.useRef(undefined);
			const sessionId = typeof props.sessionId === "string" && props.sessionId.length > 0 ? props.sessionId : undefined;
			const hasUsage = cost !== null;
			react.useEffect(() => {
				if (!hasUsage || typeof sessionId !== "string" || sessionId.length === 0) return undefined;
				// A refresh is an explicit "read it again"; a first read of this
				// session happens as soon as there is something to show.
				const first = askedFor.current !== sessionId;
				const forced = first || familyRefresh !== 0;
				if (!forced && Date.now() - answersAt.current < FAMILY_TTL_MS) return undefined;
				askedFor.current = sessionId;
				let alive = true;
				// A re-read keeps the previous figures on screen; a first read says
				// it is still working rather than showing a number that is too small.
				setFamily((previous) => (previous.status === "ready" ? previous : { status: "loading" }));
				fetch(FAMILY_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					credentials: "same-origin",
					body: JSON.stringify({ sessionId, fresh: forced }),
				}).then(
					async (response) => {
						const data = await response.json().catch(() => undefined);
						if (!alive) return;
						if (data === undefined || data?.ok !== true) {
							setFamily({ status: "error", error: data?.error ?? `HTTP ${response.status}` });
							return;
						}
						answersAt.current = Date.now();
						setFamily({ status: "ready", data });
					},
					(error) => {
						if (alive) setFamily({ status: "error", error: error instanceof Error ? error.message : String(error) });
					},
				);
				return () => {
					alive = false;
				};
			}, [hasUsage, sessionId, familyRefresh]);

			if (config.status === "error") {
				return react.createElement(
					"div",
					{ className: `${NS}-root` },
					react.createElement(
						"span",
						{ className: `${NS}-pill`, style: { cursor: "default" }, "data-tone": "warn" },
						react.createElement("span", { className: `${NS}-dot` }),
						react.createElement("span", { className: `${NS}-error` }, `金额统计不可用：${config.error}`),
					),
				);
			}
			if (cost === null) return null;

			const amount = formatMoney(cost.microUsd, config.currency);
			const cacheHit = cost.billedInput > 0 ? Math.round((cost.buckets.cacheReadTokens / cost.billedInput) * 100) : undefined;
			// `provider/model`, not the pretty label: two providers can serve the same
			// model name, and the key is what the rate table is written in — so the
			// readout points straight at the entry to edit. The label stays available
			// in full sentences, where it reads better.
			const routeName = routeDisplay(cost.route);
			const routeLong = `${routeName}${cost.rates?.label !== undefined && cost.rates.label !== routeName ? `（${cost.rates.label}）` : ""}`;
			const priced = cost.priced;
			// Bar shares come from priced amounts; an unpriced route contributes one
			// neutral segment so the bar still represents the conversation's tokens.
			const segments = priced === undefined
				? [{ key: "unpriced", color: "var(--dsw-alias-border-l2)", share: 100 }]
				: priced.rows
					.filter((entry) => entry.microUsd > 0)
					.map((entry) => ({
						key: entry.key,
						color: entry.color,
						share: cost.microUsd === 0 ? 0 : (entry.microUsd / cost.microUsd) * 100,
					}));

			// ---------------------------------------------------------------------
			// The family-inclusive readout.
			//
			// A subagent, workflow agent or teammate is a session of its own: its
			// tokens never appear in this conversation's `tokenUsage` projection, and
			// its bill is not this session's bill. A capsule that showed only the main
			// session would therefore understate what the conversation actually cost,
			// so the headline is the family total whenever the Host reports any
			// delegated session, and it says so instead of looking like the session
			// alone. Both halves stay on screen, so the number DSH's own stats show is
			// still there to compare against.
			//
			// The delegated figures come from the Host's family route (they live in
			// other logs, which a projection cannot see). The main session's figure
			// stays the live projection's, so this readout never lags a running
			// conversation to gain the descendants.
			const familyCost = family.status === "ready" && typeof family.data?.total?.descendantMicroUsd === "number"
				? { tokens: Number(family.data.total.descendantTokens ?? 0), microUsd: Number(family.data.total.descendantMicroUsd ?? 0) }
				: undefined;
			const delegatedCount = family.status === "ready" ? Number(family.data.descendantCount ?? 0) : 0;
			// A missing price table and a missing descendant figure are both
			// zero-amount cases, so this reads the object once and never dereferences
			// it twice.
			const derivedMicroUsd = familyCost === undefined ? 0 : familyCost.microUsd;
			const derivedTokens = familyCost === undefined ? 0 : familyCost.tokens;
			const hasFamily = familyCost !== undefined && delegatedCount > 0 && derivedMicroUsd > 0;
			const combinedMicroUsd = cost.microUsd + derivedMicroUsd;
			const combinedTokens = cost.total + derivedTokens;
			const headline = hasFamily ? formatMoney(combinedMicroUsd, config.currency) : amount;
			const selfShare = combinedMicroUsd === 0 ? 0 : (cost.microUsd / combinedMicroUsd) * 100;
			const derivedShare = combinedMicroUsd === 0 ? 0 : (derivedMicroUsd / combinedMicroUsd) * 100;
			// The amount attributable to tokens that were actually new, i.e. the same
			// price table with the cache-read share taken out. An unpriced route has no
			// number to give, and inventing one would be worse than saying "—".
			const freshMicroUsd = priced === undefined
				? 0
				: priced.rows
					.filter((entry) => entry.key !== "cacheReadTokens")
					.reduce((sum, entry) => sum + entry.microUsd, 0);
			const familyLines = hasFamily
				? [
					`本会话自身：${groupTokens(cost.total)} token · ${amount}`,
					`派生会话：${delegatedCount} 个 · ${groupTokens(derivedTokens)} token · ${formatMoney(derivedMicroUsd, config.currency)}`,
					`合计：${groupTokens(combinedTokens)} token · ${formatMoney(combinedMicroUsd, config.currency)}`,
				]
				: [];

			const copyText = () => {
				const text = [
					`会话 ${cost.sessionId ?? "?"} · ${routeName}`,
					`总 token ${groupTokens(cost.total)}（未命中缓存 ${groupTokens(cost.buckets.uncachedInputTokens)} · 命中缓存 ${groupTokens(cost.buckets.cacheReadTokens)} · 缓存写入 ${groupTokens(cost.buckets.cacheWriteTokens)} · 输出 ${groupTokens(cost.buckets.outputTokens)}）`,
					`本次新增 ${groupTokens(cost.freshTokens)} token（不含缓存重读）${formatContext(cost.contextTokens, cost.contextWindow) === undefined ? "" : ` · 当前上下文 ${formatContext(cost.contextTokens, cost.contextWindow)}`}`,
					`金额 ${priced === undefined ? "未配置价格" : `${amount}${priceWindowText(priced)}`}`,
					...familyLines,
				].join("\n");
				Promise.resolve(globalThis.navigator?.clipboard?.writeText?.(text)).then(
					() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					},
					() => setCopied(false),
				);
			};

			const runVerify = () => {
				if (verify.status === "busy") return;
				setVerify({ status: "busy" });
				fetch(VERIFY_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					credentials: "same-origin",
					body: JSON.stringify({ sessionId: cost.sessionId, detail: false }),
				}).then(
					async (response) => {
						const data = await response.json().catch(() => undefined);
						if (data === undefined || data === null || typeof data !== "object") {
							setVerify({ status: "error", text: `HTTP ${response.status}` });
							return;
						}
						if (data.ok !== true) {
							setVerify({ status: "error", text: String(data.error ?? "核对失败") });
							return;
						}
						setVerify({ status: "ready", data });
					},
					(error) => setVerify({ status: "error", text: error instanceof Error ? error.message : String(error) }),
				);
			};

			const contextText = formatContext(cost.contextTokens, cost.contextWindow);
			const capsule = react.createElement(
				"button",
				{
					type: "button",
					className: `${NS}-pill`,
					"data-session-cost": "pill",
					"data-open": String(open),
					"data-tone": cost.rates === undefined ? "warn" : "plain",
					"data-running": String(cost.running),
					"data-family": String(hasFamily),
					"aria-expanded": open,
					title: [
						routeName,
						hasFamily
							? `本会话 ${amount} + ${delegatedCount} 个派生会话 ${formatMoney(derivedMicroUsd, config.currency)} · 家族合计 ${headline}`
							: `${amount}`,
						`整段对话累计计费 ${groupTokens(combinedTokens)} tokens（含缓存重读）`,
						`本次新增 ${groupTokens(cost.freshTokens)} tokens`,
						contextText === undefined ? undefined : `当前上下文 ${contextText}`,
					].filter((part) => part !== undefined).join(" · "),
					onClick: () => setOpenPersisted(!open),
				},
				react.createElement("span", { className: `${NS}-dot`, "aria-hidden": "true" }),
				cost.rates === undefined
					? react.createElement("span", { className: `${NS}-tokens` }, `${formatTokens(cost.total)} tokens`)
					: react.createElement(
						react.Fragment,
						null,
						react.createElement("span", { className: `${NS}-amount` }, headline),
						hasFamily ? react.createElement("span", { className: `${NS}-family` }, `含派生 ${delegatedCount}`) : null,
						react.createElement("span", { className: `${NS}-sep` }, "·"),
						// DSH's own meter shows the context, not the bill, so the capsule
						// shows exactly that when the projection is available — otherwise the
						// two readouts look like they disagree when they answer different
						// questions. Where the context projection is absent, the cumulative
						// total stands in rather than leaving the capsule without a token
						// count at all, and `data-cost-tokens` records which one is shown.
						contextText === undefined
							? react.createElement("span", { className: `${NS}-tokens`, "data-cost-tokens": "cumulative" }, formatTokens(combinedTokens))
							: react.createElement("span", { className: `${NS}-tokens`, "data-cost-tokens": "context" }, contextText),
					),
				react.createElement("span", { className: `${NS}-chevron`, "aria-hidden": "true" }, "⌄"),
			);
			const labelled = typeof Tooltip === "function"
				? react.createElement(
					Tooltip,
					{
						text: [
							routeName,
							hasFamily
								? `本会话 ${amount} + 派生会话 ${formatMoney(derivedMicroUsd, config.currency)}`
								: `${amount}`,
							contextText === undefined ? undefined : `上下文 ${contextText}`,
							`累计 ${formatTokens(combinedTokens)}`,
							"点击查看明细",
						].filter((part) => part !== undefined).join(" · "),
					},
					capsule,
				)
				: capsule;

			if (!open) return react.createElement("div", { className: `${NS}-root`, ref: rootRef }, labelled);

			const panel = react.createElement(
				"div",
				{
					className: `${NS}-panel`,
					role: "dialog",
					"aria-label": "对话消耗明细",
					// The measured ceiling replaces the stylesheet's own, so the panel
					// scrolls instead of pushing its header out of the scroll port.
					style: ceiling === undefined ? undefined : { maxHeight: `${ceiling}px` },
				},
				react.createElement(
					"div",
					{ className: `${NS}-head` },
					react.createElement("span", { className: `${NS}-title` }, "对话消耗"),
					react.createElement(
						"span",
						{ className: `${NS}-sub`, "data-cost-route": routeName },
						routeLong,
						// The price window is part of the answer, not decoration, so it is
						// rendered as text and the Tag primitive only adds the pill styling
						// around it — never the fact itself.
						priced === undefined
							? null
							: typeof Tag === "function"
								// `Tag`'s palette is fixed by the primitive: status tones tint
								// their own token, so peak reads as a warning, off-peak as a
								// success, and a flat price as neutral — without this package
								// picking a colour.
								? react.createElement(Tag, { tone: priced.windowed === false ? "neutral" : priced.peak ? "warning" : "success" }, priceWindowText(priced).slice(1, -1))
								: react.createElement("span", { className: `${NS}-muted` }, priceWindowText(priced).slice(1, -1)),
					),
				),

				// Composition first: which part of the bill dominates is the question
				// this panel exists to answer.
				priced === undefined
					? null
					: react.createElement(
						react.Fragment,
						null,
						react.createElement(
							"div",
							{ className: `${NS}-bar`, "aria-hidden": "true" },
							...segments.map((segment) => react.createElement("span", {
								key: segment.key,
								style: { width: `${Math.max(0, Math.min(100, segment.share))}%`, background: segment.color },
							})),
						),
						react.createElement(
							"div",
							{ className: `${NS}-legend` },
							...priced.rows.filter((entry) => entry.microUsd > 0).map((entry) => react.createElement(
								"span",
								{ key: entry.key },
								react.createElement("i", { className: `${NS}-swatch`, style: { background: entry.color } }),
								`${entry.short} ${cost.microUsd === 0 ? 0 : Math.round((entry.microUsd / cost.microUsd) * 100)}%`,
							)),
						),
					),

				react.createElement(
					"div",
					{ className: `${NS}-rows` },
					...BUCKETS.map((bucket) => bucketRow(
						bucket.label,
						cost.buckets[bucket.key],
						priced === undefined ? "—" : formatMoney(priced.rows.find((entry) => entry.key === bucket.key)?.microUsd ?? 0, config.currency),
						bucket.key,
					)),
				),

				// Three different token counts, kept apart instead of collapsed into one
				// number that every reader then compares against a different meter:
				// the context DSH's own stats show, what this conversation newly
				// generated, and the cumulative figure the bill is computed from.
				react.createElement(
					"div",
					{ className: `${NS}-section`, "data-cost-tokens": "split" },
					contextText === undefined
						? null
						: bucketRow("当前上下文（DSH 统计口径）", cost.contextTokens, cost.contextWindow > 0 ? `窗口 ${formatTokens(cost.contextWindow)}` : "—", "context"),
					bucketRow("本次新增（不含缓存重读）", cost.freshTokens, priced === undefined ? "—" : formatMoney(freshMicroUsd, config.currency), "fresh"),
					bucketRow("整段累计计费（含缓存重读）", cost.total, priced === undefined ? "—" : amount, "cumulative"),
				),

				react.createElement(
					"div",
					{ className: `${NS}-summary` },
					react.createElement("span", { className: `${NS}-total` }, priced === undefined ? `${formatTokens(cost.total)} tokens` : amount),
					react.createElement(
						"span",
						{ className: `${NS}-muted` },
						priced === undefined
							? "未配置价格"
							: `累计 ${groupTokens(cost.total)} tokens${cacheHit === undefined ? "" : ` · 缓存命中 ${cacheHit}%`}${hasFamily ? " · 本会话自身" : ""}`,
					),
				),

				// Where the money went, once a delegated session is in the picture:
				// "this conversation" and "this session" stop being the same number.
				hasFamily
					? react.createElement(
						"div",
						{ className: `${NS}-section`, "data-cost-family": "split" },
						react.createElement(
							"div",
							{ className: `${NS}-bar`, "aria-hidden": "true" },
							react.createElement("span", { style: { width: `${Math.max(0, Math.min(100, selfShare))}%`, background: "var(--dsw-alias-brand-primary)" } }),
							react.createElement("span", { style: { width: `${Math.max(0, Math.min(100, derivedShare))}%`, background: "var(--dsw-alias-state-warn-primary)" } }),
						),
						react.createElement(
							"div",
							{ className: `${NS}-legend` },
							react.createElement(
								"span",
								null,
								react.createElement("i", { className: `${NS}-swatch`, style: { background: "var(--dsw-alias-brand-primary)" } }),
								`本会话 ${Math.round(selfShare)}%`,
							),
							react.createElement(
								"span",
								null,
								react.createElement("i", { className: `${NS}-swatch`, style: { background: "var(--dsw-alias-state-warn-primary)" } }),
								`派生会话 ${Math.round(derivedShare)}%`,
							),
						),
						bucketRow(`本会话自身`, cost.total, amount, "family-self"),
						bucketRow(`${delegatedCount} 个派生会话（独立计费）`, derivedTokens, formatMoney(derivedMicroUsd, config.currency), "family-derived"),
						react.createElement(
							"div",
							{ className: `${NS}-summary`, style: { marginTop: "4px" } },
							react.createElement("span", { className: `${NS}-total` }, formatMoney(combinedMicroUsd, config.currency)),
							react.createElement("span", { className: `${NS}-muted` }, `本会话 + 派生会话合计 · ${groupTokens(combinedTokens)} tokens`),
						),
					)
					: null,

				priced === undefined
					? react.createElement(
						"div",
						{ className: `${NS}-warn`, style: { marginTop: "6px" } },
						`未配置 ${routeName} 的单价 → 在「插件」页本插件的配置里补一条 rates（当前已配置 ${config.rateCount} 个模型）`,
					)
					: react.createElement(
						"div",
						{ className: `${NS}-foot` },
						hasFamily
							? "上方合计 = 本会话（整段按当前模型计价）+ 派生会话（宿主按各自日志、每次调用计价）；要精确到每次调用请用「与日志核对」或 /cost --family。"
							: "整段对话按当前模型计价；切换过模型、或要精确到每次调用，请用「与日志核对」或 /cost。",
					),

				// The three counts above differ by orders of magnitude, so the panel
				// states why instead of leaving a reader to reconcile them against a
				// meter that answers a different question.
				react.createElement(
					"div",
					{ className: `${NS}-foot` },
					"三个 token 数不是同一个量：当前上下文 = 下一次调用要发送的长度（DSH 自带统计显示的就是它）；本次新增 = 真正新产生、不重复的部分（未命中输入 + 缓存写入 + 输出）；整段累计 = 每次调用的完整输入相加，缓存命中的部分被反复计费，所以它可以是上下文的上千倍，也正是金额的计算依据。",
				),

				react.createElement(
					"div",
					{ className: `${NS}-actions` },
					react.createElement(
						ActionButton,
						{ type: "button", variant: "outline", onClick: runVerify, disabled: verify.status === "busy" },
						verify.status === "busy" ? "核对中…" : "与日志核对",
					),
					react.createElement(
						ActionButton,
						{ type: "button", variant: "ghost", onClick: copyText },
						copied ? "已复制" : "复制明细",
					),
					verify.status === "error" ? react.createElement("span", { className: `${NS}-error` }, verify.text) : null,
				),

				verify.status === "ready"
					? react.createElement(
						"div",
						{ className: `${NS}-section` },
						react.createElement(
							"div",
							{ className: `${NS}-route` },
							react.createElement("span", { className: `${NS}-muted` }, `宿主重算（${verify.data.source === "live" ? "内存" : "磁盘日志"}）`),
							react.createElement("span", { className: `${NS}-ok` }, `${verify.data.display} · ${formatTokens(verify.data.tokens)} tokens`),
						),
						react.createElement("pre", { className: `${NS}-pre` }, String(verify.data.text ?? "")),
					)
					: null,

				// Delegated sessions are separate logs and separate bills, so the panel
				// names them. The headline above already includes them (that is the
				// point), which is why this block reads as the detail of a number the
				// reader has already seen rather than as a warning about a missing one.
				react.createElement(
					"div",
					{ className: `${NS}-section` },
					family.status === "loading"
						? react.createElement("span", { className: `${NS}-muted` }, "正在统计派生会话…")
						: null,
					family.status === "error"
						? react.createElement("span", { className: `${NS}-muted` }, `派生会话统计不可用：${family.error}`)
						: null,
					family.status === "ready" && family.data.descendantCount === 0
						? react.createElement("span", { className: `${NS}-muted` }, "无派生会话（本对话没有 subagent / workflow agent 子会话，金额即本会话自身）")
						: null,
					family.status === "ready" && family.data.descendantCount > 0
						? react.createElement(
							"div",
							null,
							react.createElement(
								"div",
								{ className: `${NS}-route` },
								react.createElement(
									"span",
									{ className: `${NS}-warn` },
									`另有 ${family.data.descendantCount} 个派生会话（独立计费${hasFamily ? "，已计入上方金额" : "，但未配置单价"}）`,
								),
								react.createElement(
									"span",
									null,
									`+${formatTokens(family.data.total.descendantTokens)} · ${family.data.total.descendantDisplay}`,
								),
							),
							react.createElement(
								"div",
								{ className: `${NS}-route` },
								react.createElement("span", { className: `${NS}-muted` }, "本会话 + 派生会话合计"),
								react.createElement(
									"span",
									{ className: `${NS}-ok` },
									`${formatTokens(family.data.total.tokens)} · ${family.data.total.display}`,
								),
							),
							react.createElement(
								"div",
								{ className: `${NS}-actions` },
								react.createElement(
									ActionButton,
									{ type: "button", variant: "ghost", onClick: () => setFamilyOpen((previous) => !previous) },
									familyOpen ? "收起明细" : "展开明细",
								),
								react.createElement(
									ActionButton,
									{ type: "button", variant: "ghost", onClick: () => setFamilyRefresh((previous) => previous + 1) },
									"刷新",
								),
							),
							familyOpen
								? react.createElement(
									"div",
									{ className: `${NS}-rows` },
									...family.data.descendants.slice(0, 12).map((child) => react.createElement(
										"div",
										{ className: `${NS}-row`, key: child.sessionId },
										react.createElement(
											"span",
											{ className: `${NS}-row-label` },
											`${"　".repeat(Math.min(child.depth ?? 1, 3))}${child.origin ?? ""} ${child.sessionId.slice(0, 8)}`,
										),
										react.createElement("span", { className: `${NS}-row-tokens` }, formatTokens(child.tokens)),
										react.createElement("span", { className: `${NS}-row-amount` }, child.display ?? "未配置"),
									)),
									family.data.descendantCount > 12
										? react.createElement("span", { className: `${NS}-muted` }, `…另有 ${family.data.descendantCount - 12} 个（用 /cost --family 看全）`)
										: null,
								)
								: null,
							family.data.missingParents !== undefined && family.data.missingParents.length > 0
								? react.createElement(
									"div",
									{ className: `${NS}-foot` },
									`注意：${family.data.missingParents.length} 个父会话日志已不在本机，其更上层可能未计入。`,
								)
								: null,
						)
						: null,
				),

				react.createElement(
					"div",
					{ className: `${NS}-foot` },
					`单价来自插件配置（${config.rateCount} 个模型）· 每 ${Math.round(CONFIG_REFRESH_MS / 1000)}s 自动刷新 · 估算值，以厂商账单为准`,
				),
			);

			return react.createElement("div", { className: `${NS}-root`, ref: rootRef }, labelled, panel);
		}

		/** One labeled form field. */
		function field(label, control, hint, key) {
			return react.createElement(
				"label",
				{ className: `${NS}-field`, key },
				react.createElement("span", null, label),
				control,
				hint === undefined ? null : react.createElement("span", { className: `${NS}-hint` }, hint),
			);
		}

		/**
		 * A read-only preview of the rate table, so an edit can be checked before it
		 * is saved instead of after a wrong-amount surprise.
		 *
		 * Prices are shown in the display currency, because the table is the thing
		 * the reader is about to store and a `$` in front of a yuan figure is exactly
		 * the mistake this plugin already made once.
		 *
		 * @param {string} raw - the textarea's current JSON text.
		 * @param {object} currency - the draft display currency.
		 * @returns {object} the preview element, or the parse error.
		 */
		function ratePreview(raw, currency) {
			let table;
			try {
				table = JSON.parse(raw);
			} catch (error) {
				return react.createElement("span", { className: `${NS}-error` }, `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
			}
			if (table === null || typeof table !== "object" || Array.isArray(table)) {
				return react.createElement("span", { className: `${NS}-error` }, "需要一个 JSON 对象");
			}
			const keys = Object.keys(table);
			const problems = [];
			for (const key of keys) {
				if (!key.includes("/")) problems.push(`${key}：键名需要写成 <provider>/<model>`);
				const entry = table[key];
				if (entry === null || typeof entry !== "object") {
					problems.push(`${key}：值必须是对象`);
				}
			}
			// The same check the save path runs, so the preview cannot call a table
			// fine and then refuse to save it. `table` is already parsed here — passing
			// it through the text parser again would stringify it to "[object Object]"
			// and silently validate an empty table.
			const problem = validateRates(table);
			if (problem !== "") problems.push(problem);
			if (keys.length === 0) return react.createElement("span", { className: `${NS}-warn` }, "尚未配置任何模型");
			const cell = (value, fallback) => formatPrice(value === undefined ? fallback : Number(value), currency);
			return react.createElement(
				"div",
				{ className: `${NS}-preview` },
				react.createElement(
					"table",
					null,
					react.createElement(
						"thead",
						null,
						react.createElement(
							"tr",
							null,
							react.createElement("th", null, "模型"),
							react.createElement("th", null, "未命中"),
							react.createElement("th", null, "命中缓存"),
							react.createElement("th", null, "缓存写入"),
							react.createElement("th", null, "输出"),
							// The tariff is a property of the price list, so it is shown
							// next to the prices: a flat route is not discounted at night.
							react.createElement("th", null, "计价"),
						),
					),
					react.createElement(
						"tbody",
						null,
						...keys.map((key) => {
							const entry = table[key] ?? {};
							const input = Number(entry.input ?? 0);
							const windowed = typeof entry.peakPricing === "boolean" ? entry.peakPricing : defaultPeakPricing(key);
							return react.createElement(
								"tr",
								{ key },
								react.createElement("td", null, entry.label ?? key),
								react.createElement("td", null, cell(entry.input, 0)),
								react.createElement("td", null, cell(entry.cacheRead, input)),
								react.createElement("td", null, cell(entry.cacheWrite, input)),
								react.createElement("td", null, cell(entry.output, 0)),
								react.createElement("td", { "data-cost-preview-window": key }, windowed ? "峰谷价" : "固定价"),
							);
						}),
					),
				),
				react.createElement("span", { className: `${NS}-hint` }, `每 100 万 token 的单价（${currency?.code ?? ""}）· 共 ${keys.length} 个模型 · 缓存列为空时按「未命中」价 · 「峰谷价」仅用于 DeepSeek 这类有高峰/非高峰两档价的模型，其余按固定价（可在高级 JSON 里用 peakPricing 强制）`),
				...problems.map((item) => react.createElement("div", { className: `${NS}-warn`, key: item }, item)),
			);
		}

		/**
		 * The rate table as editable rows, so a price can be typed the way it is
		 * published instead of as JSON.
		 *
		 * Empty cache-hit / cache-write cells are reported as `""` on purpose: the
		 * plugin treats a missing cache price as "same as the input price", and a
		 * form that showed that inherited number in the cell would turn every save
		 * into an explicit override.
		 *
		 * @param {string} raw - the row's `rates` JSON text.
		 * @returns {Array<object>} rows, or an empty list when the text is unreadable.
		 */
		function rateRowsFromText(raw) {
			let table;
			try {
				table = JSON.parse(String(raw ?? ""));
			} catch {
				return [];
			}
			if (table === null || typeof table !== "object" || Array.isArray(table)) return [];
			return Object.entries(table).map(([key, entry]) => {
				const value = entry !== null && typeof entry === "object" ? entry : {};
				return {
					key,
					label: typeof value.label === "string" ? value.label : "",
					input: value.input === undefined ? "" : String(value.input),
					cacheRead: value.cacheRead === undefined ? "" : String(value.cacheRead),
					cacheWrite: value.cacheWrite === undefined ? "" : String(value.cacheWrite),
					output: value.output === undefined ? "" : String(value.output),
				};
			});
		}

		/**
		 * Read a `rates` JSON text as the plain object behind it, or `{}` when it is
		 * unreadable. Used to carry advanced per-model fields (off-peak overrides,
		 * custom keys) through an edit made in the table.
		 *
		 * @param {string} raw - the row's `rates` text.
		 * @returns {Record<string, object>} the table.
		 */
		function rateTableOf(raw) {
			try {
				const parsed = JSON.parse(String(raw ?? ""));
				if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
					// Non-object entries are kept on purpose: dropping them would make a
					// model silently disappear from the table and from every complaint
					// about it, so the reader would never learn which entry is wrong.
					return { ...parsed };
				}
			} catch {
				// An unreadable text means no previous fields to carry.
			}
			return {};
		}

		/**
		 * Like {@link rateTableOf}, but distinguishes "not an object" from "cannot be
		 * parsed": the caller needs that to tell a user's emptied table (`{}`, which is
		 * theirs to keep) from a typo (which the on-screen table can describe).
		 *
		 * @param {string} raw - the row's `rates` text.
		 * @returns {Record<string, object>|undefined} the table, or undefined when unreadable.
		 */
		function rateTableOrUndefined(raw) {
			try {
				const parsed = JSON.parse(String(raw ?? ""));
				if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
					return { ...parsed };
				}
			} catch {
				// Unreadable.
			}
			return undefined;
		}

		/** The price fields the Host will read as numbers, with their Chinese labels. */
		const RATE_NUMBER_FIELDS = [
			["input", "未命中价"],
			["output", "输出价"],
			["cacheRead", "命中缓存价"],
			["cacheWrite", "缓存写入价"],
			["offPeakMultiplier", "非高峰系数"],
			["inputOffPeak", "未命中非高峰价"],
			["cacheReadOffPeak", "命中缓存非高峰价"],
			["cacheWriteOffPeak", "缓存写入非高峰价"],
			["outputOffPeak", "输出非高峰价"],
		];

		/**
		 * Check that every model in a rate table has the two prices the Host needs,
		 * and that every price it does carry is a non-negative number.
		 *
		 * The Host enforces this at mount and would refuse to load the row, which
		 * takes the whole readout down — so the form catches it first and names the
		 * model and field. A missing cache price is fine (it means "same as input").
		 *
		 * @param {Record<string, object>} table - parsed rate table.
		 * @returns {string} "" when the table is usable, else the first problem.
		 */
		function validateRates(table) {
			const keys = Object.keys(table);
			if (keys.length === 0) return "至少要有一个模型，否则什么都算不出金额";
			for (const [key, entry] of Object.entries(table)) {
				if (!key.includes("/")) return `模型名 ${key} 需要写成 <provider>/<model>`;
				if (entry === null || typeof entry !== "object") return `${key} 的值必须是一个含 input / output 的对象`;
				for (const [field_, label] of RATE_NUMBER_FIELDS) {
					const value = entry[field_];
					if (value === undefined || value === null) continue;
					if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
						return `${key} 的${label}（${field_}）需要非负数字，收到 ${JSON.stringify(value)}`;
					}
				}
				for (const required of ["input", "output"]) {
					const value = entry[required];
					if (typeof value !== "number" || !Number.isFinite(value)) {
						return `${key} 缺少 ${required}（${required === "input" ? "未命中价" : "输出价"}）`;
					}
				}
				// A boolean, not a price: the Host reads it with `typeof === "boolean"`,
				// so a string here would fail the row at mount instead of here.
				if (entry.peakPricing !== undefined && typeof entry.peakPricing !== "boolean") {
					return `${key} 的 peakPricing（是否分高峰/非高峰价）需要 true 或 false，收到 ${JSON.stringify(entry.peakPricing)}`;
				}
			}
			return "";
		}

		/**
		 * Turn edited rows into a rate table, without judging the prices.
		 *
		 * Conversion and validation are separate on purpose: a cell the user is
		 * halfway through typing must still reach the staged value, so that the
		 * save path sees what they typed and can name the field. A function that
		 * refused to build anything would leave the save validating the old table.
		 *
		 * @param {Array<object>} rows - edited rows.
		 * @param {Record<string, object>} [previous] - the table the rows came from,
		 *   whose unedited fields are carried over.
		 * @returns {{table: Record<string, object>}|{error: string}} the table, or a
		 *   problem that makes the rows unmappable at all (an empty or duplicate key).
		 */
		function tableFromRows(rows, previous = {}) {
			const table = {};
			for (const [index, row] of rows.entries()) {
				const key = String(row.key ?? "").trim();
				const where = `第 ${index + 1} 行`;
				if (key === "") return { error: `${where}：模型名不能为空（写成 <provider>/<model>，如 deepseek-official/deepseek-flash）` };
				if (!key.includes("/")) return { error: `${where}：模型名 ${key} 需要写成 <provider>/<model>` };
				if (Object.hasOwn(table, key)) return { error: `${where}：模型名 ${key} 重复` };
				// Carry over everything the table does not own, then let its cells win.
				const entry = { ...(previous[key] ?? {}) };
				if (String(row.label ?? "").trim() !== "") entry.label = String(row.label).trim();
				for (const field_ of ["input", "output", "cacheRead", "cacheWrite"]) {
					const raw = String(row[field_] ?? "").trim();
					if (raw === "") {
						// An emptied cache price means "same as input", so an inherited
						// explicit value is dropped rather than silently kept.
						delete entry[field_];
						continue;
					}
					// Keep the raw text: `validateRates` decides whether it is a price.
					entry[field_] = Number.isFinite(Number(raw)) ? Number(raw) : raw;
				}
				table[key] = entry;
			}
			return { table };
		}

		/**
		 * Turn edited rows into the rate-table JSON text the row stores.
		 *
		 * @param {Array<object>} rows - edited rows.
		 * @param {Record<string, object>} [previous] - the table the rows came from.
		 * @returns {{text: string}|{error: string}} canonical JSON text, or the first problem.
		 */
		function buildRateRows(rows, previous = {}) {
			const built = tableFromRows(rows, previous);
			if (built.error !== undefined) return built;
			const problem = validateRates(built.table);
			if (problem !== "") return { error: problem };
			return { text: JSON.stringify(built.table) };
		}

		/** One cell of the price table: a labelled input with a `data-cost-*` hook. */
		function rateCell({ value, field_, row, index, placeholder, disabled, onChange, numeric = true }) {
			return react.createElement("input", {
				className: numeric ? `${NS}-num` : undefined,
				type: "text",
				inputMode: numeric ? "decimal" : undefined,
				"data-cost-rate": field_,
				"data-cost-row": String(index),
				"aria-label": `${field_} 第 ${index + 1} 行`,
				value,
				placeholder: placeholder ?? (numeric ? "—" : ""),
				disabled,
				onChange: (event) => onChange(index, field_, event.target.value),
			});
		}

		/**
		 * Editable price table: one row per model, add and remove included.
		 *
		 * This is the form's primary way to enter prices — the JSON textarea is kept
		 * below it as an advanced escape hatch for fields the table does not expose,
		 * such as per-model off-peak overrides.
		 *
		 * @param {object} props - editor props.
		 * @returns {object} the element.
		 */
		function RateEditor({ rows, writable, onRows }) {
			const change = (index, field_, value) => onRows(rows.map((row, at) => (at === index ? { ...row, [field_]: value } : row)));
			const remove = (index) => onRows(rows.filter((_row, at) => at !== index));
			const add = () => onRows([...rows, { key: "", label: "", input: "", cacheRead: "", cacheWrite: "", output: "" }]);
			const head = (label, numeric) => react.createElement("th", { className: numeric ? `${NS}-num` : undefined }, label);
			return react.createElement(
				"div",
				null,
				react.createElement(
					"table",
					{ className: `${NS}-rates`, "data-cost-rates": "table" },
					react.createElement(
						"thead",
						null,
						react.createElement(
							"tr",
							null,
							head("模型（<provider>/<model>）"),
							head("未命中", true),
							head("命中缓存", true),
							head("缓存写入", true),
							head("输出", true),
							head(""),
						),
					),
					react.createElement(
						"tbody",
						null,
						...rows.map((row, index) => react.createElement(
							"tr",
							{ key: index, "data-cost-rate-row": String(index) },
							react.createElement(
								"td",
								{ className: `${NS}-key` },
								rateCell({ value: row.key, field_: "key", row, index, placeholder: "provider/model", disabled: !writable, onChange: change, numeric: false }),
							),
							react.createElement("td", { className: `${NS}-num` }, rateCell({ value: row.input, field_: "input", row, index, placeholder: "必填", disabled: !writable, onChange: change })),
							react.createElement("td", { className: `${NS}-num` }, rateCell({ value: row.cacheRead, field_: "cacheRead", row, index, placeholder: "= 未命中", disabled: !writable, onChange: change })),
							react.createElement("td", { className: `${NS}-num` }, rateCell({ value: row.cacheWrite, field_: "cacheWrite", row, index, placeholder: "= 未命中", disabled: !writable, onChange: change })),
							react.createElement("td", { className: `${NS}-num` }, rateCell({ value: row.output, field_: "output", row, index, placeholder: "必填", disabled: !writable, onChange: change })),
							react.createElement(
								"td",
								{ className: `${NS}-act` },
								react.createElement(
									"button",
									{
										type: "button",
										className: `${NS}-drop`,
										"data-cost-rate-remove": String(index),
										title: `删除 ${row.key === "" ? `第 ${index + 1} 行` : row.key}`,
										disabled: !writable || rows.length <= 1,
										onClick: () => remove(index),
									},
									"×",
								),
							),
						)),
					),
				),
				react.createElement(
					"div",
					{ className: `${NS}-actions`, style: { marginTop: "6px" } },
					react.createElement(ActionButton, { type: "button", variant: "ghost", "data-cost-rate-add": "true", onClick: add, disabled: !writable }, "＋ 添加模型"),
					react.createElement("span", { className: `${NS}-hint` }, "留空的「命中缓存 / 缓存写入」= 与未命中同价"),
				),
			);
		}


		/**
		 * The row's configuration form. `props.view === "summary"` renders the
		 * row's one-liner; `"page"` renders the editable form.
		 */
		function ConfigForm(props) {
			const form = props.form;
			const state = form?.state;
			const [draft, setDraft] = react.useState({});
			const [status, setStatus] = react.useState("");

			if (props.view === "summary") {
				return react.createElement("span", null, "对话 token 与金额统计（session_cost / /cost）");
			}
			if (state === undefined) {
				return react.createElement("p", { className: `${NS}-hint` }, "配置暂不可用：Host 尚未提供该行的设置命名空间。");
			}
			const writable = state.writable !== false;
			const read = (name) => {
				if (Object.hasOwn(draft, name)) return draft[name];
				const value = state.value?.[name];
				if (value === undefined || value === null) return "";
				if (typeof value === "object") return JSON.stringify(value, null, 2);
				return value;
			};
			const set = (name, value) => setDraft((previous) => ({ ...previous, [name]: value }));

			// The structured editor and the advanced textarea are two views of one
			// value. Editing a row materializes the rows into `draft.rates`; editing
			// the textarea replaces that text and re-seeds the rows from it, so the two
			// never hold different tables.
			const ratesText = String(read("rates"));
			// The currency the preview prices are labelled with, taken from the same
			// draft the save would use, so the labels follow an edit immediately.
			const draftCurrency = (() => {
				try {
					const parsed = JSON.parse(String(read("currency")));
					if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
						// Mirror the Host: an omitted symbol or code falls back to the
						// default, so the preview shows what would really be stored.
						return {
							symbol: typeof parsed.symbol === "string" && parsed.symbol.length > 0 ? parsed.symbol : "¥",
							code: typeof parsed.code === "string" && parsed.code.length > 0 ? parsed.code : "CNY",
						};
					}
				} catch {
					// An unparseable currency is the save path's problem to report.
				}
				return { symbol: "¥", code: "CNY" };
			})();
			const [rows, setRows] = react.useState(() => rateRowsFromText(state.value?.rates));
			// The text the rows were seeded from, so the table can adopt a change made
			// anywhere. Done during render rather than in an effect: the table and the
			// text are two views of one value, and an effect would paint one frame with
			// the table disagreeing with the text.
			const [rowsSource, setRowsSource] = react.useState(() => String(state.value?.rates ?? ""));
			if (rowsSource !== ratesText) {
				setRowsSource(ratesText);
				setRows(rateRowsFromText(ratesText));
			}
			const setRowsAndRates = (next) => {
				setRows(next);
				// Stage what was typed even when it is not yet valid: the save path
				// validates the staged value, and it can only name the bad field if it
				// is looking at what the user actually typed.
				const mapped = tableFromRows(next, rateTableOf(ratesText));
				const text = mapped.error === undefined ? JSON.stringify(mapped.table) : ratesText;
				const problem = mapped.error ?? validateRates(mapped.table);
				setStatus(problem === "" ? "" : `价格表有问题：${problem}`);
				setRowsSource(text);
				set("rates", text);
			};

			const buildOps = () => {
				const ops = [];
				const specs = [
					["rates", "string"],
					["currency", "string"],
					["offPeakMultiplier", "number"],
					["offPeakTimezone", "string"],
					["offPeakHolidays", "string"],
					["dshHome", "string"],
				];
				for (const [name, kind] of specs) {
					if (!Object.hasOwn(draft, name)) continue;
					const raw = draft[name];
					let value = raw;
					if (kind === "number") {
						value = Number(raw);
						if (!Number.isFinite(value)) return { error: `${name} 需要数字` };
					}
					if (name === "rates" || name === "currency") {
						// The row stores both as JSON text; parse only to reject a typo
						// before it reaches the Host, then store the canonical text.
						try {
							value = JSON.stringify(JSON.parse(raw));
						} catch (error) {
							return { error: `${name} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
						}
					}
					if (typeof value === "string" && value.trim() === "" && name !== "dshHome" && name !== "offPeakHolidays") return { error: `${name} 不能为空` };
					ops.push({ op: "set", path: [name], value });
				}
				return { ops };
			};

			const save = () => {
				// The textarea is the row's real value, so it is what gets validated.
				// When the table was edited, the text already mirrors it; when the text
				// is unreadable, rebuilding from the table is the only way to say which
				// row is wrong instead of just "invalid JSON".
				const typed = String(read("rates"));
				if (rateTableOrUndefined(typed) === undefined) {
					const built = buildRateRows(rows, {});
					if (built.error !== undefined) {
						setStatus(`价格表有问题：${built.error}`);
						return;
					}
					set("rates", built.text);
				}
				// Validate the table that will actually be stored. The Host refuses a
				// row whose prices are not numbers, and that refusal takes the whole
				// readout down, so it is caught here where it can be explained.
				const problem = validateRates(rateTableOf(typed));
				if (problem !== "") {
					setStatus(`价格表有问题：${problem}`);
					return;
				}
				const { ops, error } = buildOps();
				if (error !== undefined) {
					setStatus(error);
					return;
				}
				if (ops.length === 0) {
					setStatus("没有改动");
					return;
				}
				setStatus("保存中…");
				Promise.resolve(form.mutate(ops, state.revision)).then(
					() => {
						setDraft({});
						setStatus("已保存，下一次调用即生效");
					},
					(error_) => setStatus(`保存失败：${error_ instanceof Error ? error_.message : String(error_)}`),
				);
			};

			return react.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", maxWidth: "720px" } },
				react.createElement(
					"p",
					{ className: `${NS}-note` },
					`在这里填每个模型每 100 万 token 的单价（单位与下面的 currency 一致，默认人民币元）。未命中/输出必填；命中缓存与缓存写入留空表示与未命中同价。填完点「保存」，下一次查询或下一次面板刷新即生效。`,
				),
				react.createElement(
					"div",
					{ className: `${NS}-field` },
					react.createElement("span", null, "模型单价"),
					react.createElement(RateEditor, { rows, writable, onRows: setRowsAndRates }),
					react.createElement("span", { className: `${NS}-hint` }, "模型名必须写成 <provider>/<model>（可直接复制下面「当前生效的单价」里的键名）"),
				),
				ratePreview(String(read("rates")), draftCurrency),
				react.createElement(
					"details",
					{ className: `${NS}-advanced` },
					react.createElement("summary", null, "高级：直接编辑 rates JSON（面板/命令行按这里的内容计价）"),
					react.createElement("textarea", {
						className: `${NS}-control`,
						"data-cost-field": "rates",
						rows: 9,
						value: String(read("rates")),
						disabled: !writable,
						onChange: (event) => {
							// Adopt the text as the new source and re-seed the table from it,
							// so the two views cannot drift apart.
							set("rates", event.target.value);
							setRowsSource(event.target.value);
							setRows(rateRowsFromText(event.target.value));
						},
					}),
					react.createElement(
						"span",
						{ className: `${NS}-hint` },
						"input = 未命中缓存 · cacheRead = 命中缓存 · cacheWrite = 缓存写入（缺省等于 input）· output = 输出；peakPricing = 该模型是否按高峰/非高峰两档价（不填则键名含 deepseek 时为 true，其余为固定价）；可加 offPeakMultiplier 或 inputOffPeak 等字段覆盖非高峰价",
					),
				),
				field("currency", react.createElement(TextInput, {
					className: `${NS}-control`,
					"data-cost-field": "currency",
					type: "text",
					value: String(read("currency")),
					disabled: !writable,
					onChange: (event) => set("currency", event.target.value),
				}), "单价的单位。如 {\"symbol\":\"¥\",\"code\":\"CNY\",\"perUsd\":1}；换成美元要连单价一起改", "currency"),
				field("offPeakMultiplier", react.createElement(TextInput, {
					className: `${NS}-control`,
					"data-cost-field": "offPeakMultiplier",
					type: "number",
					step: "0.05",
					value: String(read("offPeakMultiplier")),
					disabled: !writable,
					onChange: (event) => set("offPeakMultiplier", event.target.value),
				}), "非高峰价 = 高峰价 × 该系数（DeepSeek 为 0.5）。只对「峰谷价」的模型生效：固定价模型全天按原价", "offPeakMultiplier"),
				field("offPeakTimezone", react.createElement(TextInput, {
					className: `${NS}-control`,
					"data-cost-field": "offPeakTimezone",
					type: "text",
					value: String(read("offPeakTimezone")),
					disabled: !writable,
					onChange: (event) => set("offPeakTimezone", event.target.value),
				}), "判断高峰时段的 IANA 时区（官方窗口 01:00–04:00 / 06:00–10:00 即此区），默认 UTC", "offPeakTimezone"),
				field("offPeakHolidays", react.createElement(TextInput, {
					className: `${NS}-control`,
					"data-cost-field": "offPeakHolidays",
					type: "text",
					value: String(read("offPeakHolidays")),
					placeholder: "留空 = 用内置日历",
					disabled: !writable,
					onChange: (event) => set("offPeakHolidays", event.target.value),
				}), "中国法定节假日（全天按非高峰计价），YYYY-MM-DD 逗号分隔；留空用内置清单。每年 11 月国务院公布次年安排后需要更新", "offPeakHolidays"),
				field("dshHome", react.createElement(TextInput, {
					className: `${NS}-control`,
					"data-cost-field": "dshHome",
					type: "text",
					value: String(read("dshHome")),
					disabled: !writable,
					onChange: (event) => set("dshHome", event.target.value),
				}), "留空 = $DSH_HOME，再退回 ~/.dsh", "dshHome"),
				react.createElement(
					"div",
					{ className: `${NS}-actions` },
					react.createElement(ActionButton, { type: "button", variant: "primary", onClick: save, disabled: !writable }, "保存"),
					status === "" ? null : react.createElement("span", { className: `${NS}-hint` }, status),
				),
				writable ? null : react.createElement("p", { className: `${NS}-hint` }, "当前页面没有 Host 写权限，表单为只读。"),
			);
		}

		/**
		 * Register the cost pill and the Plugins-page form.
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register(
				{ name: "conversation.composer.dock", id: "session-cost", order: 60, label: "对话消耗" },
				CostPill,
			));
			const rows = [
				{ key: `${PACKAGE_NAME}#session-cost` },
				{ key: `${PACKAGE_NAME}#session-cost-command` },
			];
			for (const row of rows) {
				ctx.slots.inject("plugins.row.config", () => ctx.slots.register(
					{ name: "plugins.row.config", key: row.key },
					ConfigForm,
				));
			}
		}

		// Install the stylesheet when the bundle loads rather than when a slot is
		// mounted: the pill and the Plugins-page form are styled by the same sheet,
		// and the page may mount either one first.
		sheet();

		exports.CostPill = CostPill;
		exports.ConfigForm = ConfigForm;
		exports.clipTopOf = clipTopOf;
		exports.panelCeiling = panelCeiling;
		exports.formatMoney = formatMoney;
		exports.routeDisplay = routeDisplay;
		exports.formatTokens = formatTokens;
		exports.priceBuckets = priceBuckets;
		exports.resolveRates = resolveRates;
		exports.isPeak = isPeak;
		exports.defaultPeakPricing = defaultPeakPricing;
		exports.priceWindowText = priceWindowText;
		exports.CSS = CSS;
		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
