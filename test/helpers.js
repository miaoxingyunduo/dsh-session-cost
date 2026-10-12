/**
 * Test doubles: a minimal Cordis context, a minimal schemastery `z`, a minimal
 * React hook runtime, and session-log fixtures.
 *
 * These exist so every assertion runs against this package's real code paths
 * without needing a running DSH, a profile, or the network.
 */

import { zstdCompressSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A schemastery stand-in good enough for the row `Config` objects. */
export const z = {
	object(shape) {
		return {
			shape,
			default(value) {
				const filled = {};
				for (const [key, field] of Object.entries(shape)) {
					filled[key] = field?.__default === undefined ? value : field.__default;
				}
				return { ...this, __default: filled };
			},
		};
	},
	string() {
		return field("", "string");
	},
	number() {
		return field(0, "number");
	},
	boolean() {
		return field(false, "boolean");
	},
};

function field(defaultValue, kind) {
	const self = {
		kind,
		__default: defaultValue,
		default(value) {
			return field(value, kind);
		},
		volatile() {
			return self;
		},
		role() {
			return self;
		},
		description() {
			return self;
		},
		optional() {
			return self;
		},
	};
	return self;
}

/**
 * A `defineTool` stand-in that keeps the definition and enforces the one rule
 * the registry enforces for us.
 *
 * @param {object} options - tool definition.
 * @returns {object} the same definition, captured.
 */
export function defineTool(options) {
	if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
		throw new TypeError(`tool "${options.name}" timeoutMs must be a positive finite number`);
	}
	if (typeof options.execute !== "function") throw new TypeError(`tool "${options.name}" needs execute`);
	return { ...options, __defined: true };
}

/**
 * A Cordis-context stand-in that records registrations.
 *
 * @param {object} [options] - what the context should offer.
 * @returns {object} the fake context.
 */
export function makeCtx(options = {}) {
	const ctx = {
		tools: [],
		commands: [],
		routes: [],
		logs: [],
		injects: [],
		logger: {
			info: (message) => ctx.logs.push(["info", message]),
			warn: (message) => ctx.logs.push(["warn", message]),
			error: (message) => ctx.logs.push(["error", message]),
		},
	};
	ctx.tools.register = (definition) => {
		ctx.tools.push(definition);
		return () => {};
	};
	ctx.commands.register = (definition) => {
		ctx.commands.push(definition);
		return () => {};
	};
	ctx.inject = (services, callback) => {
		ctx.injects.push(services);
		if (options.connection === true && services.includes("connection")) {
			callback({ connection: { fetch: { register: (route) => { ctx.routes.push(route); return Promise.resolve(() => {}); } } } });
		}
		return () => {};
	};
	ctx.get = (name) => (options.services ?? {})[name];
	return ctx;
}

/**
 * A React stand-in: hooks backed by a simple render cursor, and `createElement`
 * producing plain nodes the assertions can walk.
 *
 * `__runEffects` executes the pending effects and records the cleanups they
 * return, so a component that sets an interval (as the cost pill's config
 * refresh does) does not keep the test process alive.
 *
 * @returns {object} the fake React module plus its test drivers.
 */
export function makeReact() {
	let cursor = 0;
	let states = [];
	let effects = [];
	let cleanups = [];
	let previousDeps = [];
	let pendingDeps = [];
	const sameDeps = (left, right) => left !== undefined && right !== undefined
		&& left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
	const react = {
		createElement(type, props, ...children) {
			const flat = children.flat().filter((child) => child !== null && child !== undefined && child !== false && child !== true);
			// A function component is invoked the way React invokes it, and its own
			// element output replaces the call site — otherwise a `Tag`/`Button`
			// primitive would sit in the tree as an unrendered function type.
			if (typeof type === "function") {
				const merged = { ...(props ?? {}) };
				if (flat.length === 1) merged.children = flat[0];
				else if (flat.length > 1) merged.children = flat;
				return type(merged);
			}
			return { type, props: props ?? {}, children: flat };
		},
		memo: (component) => component,
		useState(initial) {
			const index = cursor;
			cursor += 1;
			if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
			const set = (next) => {
				states[index] = typeof next === "function" ? next(states[index]) : next;
			};
			return [states[index], set];
		},
		useMemo(factory) {
			cursor += 1;
			return factory();
		},
		useEffect(effect, deps) {
			const index = cursor;
			cursor += 1;
			pendingDeps[index] = deps;
			// React semantics: an effect whose dependency array is unchanged since the
			// last render does not run again. Getting this wrong would make a
			// `useEffect(..., [])` look like it re-registers its interval on every render.
			if (deps !== undefined && sameDeps(previousDeps[index], deps)) return;
			effects.push({ index, effect });
		},
		useRef(initial) {
			cursor += 1;
			return { current: initial };
		},
		Fragment: "Fragment",
		__reset() {
			// Reset the hook cursor but keep state and effects: a "render" in a test
			// is one more pass over the same component instance, not a remount.
			cursor = 0;
			pendingDeps = [];
		},
		/**
		 * Forget all hook state, as mounting a brand new component instance would.
		 *
		 * `__reset` deliberately keeps state so a test can re-render one instance.
		 * A test that renders a component *again* as a fresh mount (calling
		 * `ConfigForm(...)` a second time, say) needs this instead — otherwise the
		 * second call inherits the first one's `useState` values, which no real page
		 * would do, and a stateful form looks like it lost the user's edits.
		 */
		__remount() {
			cursor = 0;
			states = [];
			effects = [];
			for (const [index, cleanup] of cleanups.entries()) {
				if (typeof cleanup === "function") cleanup();
				cleanups[index] = undefined;
			}
			previousDeps = [];
			pendingDeps = [];
		},
		__runEffects() {
			const pending = effects;
			effects = [];
			for (const entry of pending) {
				// A re-running effect replaces its own cleanup, as React does.
				if (cleanups[entry.index] !== undefined) {
					cleanups[entry.index]();
					cleanups[entry.index] = undefined;
				}
				const cleanup = entry.effect();
				if (typeof cleanup === "function") cleanups[entry.index] = cleanup;
			}
			previousDeps = pendingDeps.slice();
		},
		/** Run every recorded cleanup, as unmounting the component would. */
		__unmount() {
			for (const [index, cleanup] of cleanups.entries()) {
				if (typeof cleanup === "function") cleanup();
				cleanups[index] = undefined;
			}
		},
	};
	return react;
}

/** Walk a rendered element tree, collecting every node. */
export function walk(node, out = []) {
	if (node === null || node === undefined || typeof node !== "object") return out;
	out.push(node);
	for (const child of node.children ?? []) walk(child, out);
	return out;
}

/** The text content of a rendered element tree. */
export function textOf(node) {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (node === null || node === undefined || typeof node !== "object") return "";
	return (node.children ?? []).map(textOf).join(" ");
}

/**
 * Build one `assistant/message` event with provider-reported usage.
 *
 * @param {object} input - event input.
 * @returns {object} a durable event.
 */
export function assistantEvent({ seq, time, turn = 1, step = 1, provider = "deepseek-official", model = "deepseek-flash", usage }) {
	return {
		type: "assistant/message",
		seq,
		time,
		data: {
			turn,
			step,
			usage,
			message: { source: { provider, model } },
		},
	};
}

/**
 * Build a session event list, optionally as a delegated child.
 *
 * @param {object} [options] - fixture options.
 * @param {string} [options.parentSession] - the parent's session id, which is what
 *   makes this session part of that conversation's family.
 * @param {string} [options.origin] - `subagent` for a delegated session.
 * @param {number} [options.delegationDepth] - the depth DSH records.
 * @returns {object[]} events in seq order.
 */
export function makeSessionEvents(options = {}) {
	const turns = options.turns ?? 3;
	const provider = options.provider ?? "deepseek-official";
	const model = options.model ?? "deepseek-flash";
	const base = options.time ?? Date.UTC(2026, 0, 5, 12, 0, 0); // Monday 12:00 UTC = off-peak
	const events = [
		{
			type: "session",
			version: 4,
			id: options.id ?? "session-11111111-1111-1111-1111-111111111111",
			createdAt: base,
			cwd: options.cwd ?? "D:\\work",
			...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
			...(options.origin === undefined ? {} : { origin: options.origin }),
			...(options.delegationDepth === undefined ? {} : { delegationDepth: options.delegationDepth }),
		},
	];
	let seq = 1;
	for (let turn = 1; turn <= turns; turn += 1) {
		events.push({ type: "turn/start", seq: seq++, time: base + turn * 1000, data: { turn } });
		events.push({ type: "step/start", seq: seq++, time: base + turn * 1000 + 1, data: { turn, step: 1 } });
		events.push(assistantEvent({
			seq: seq++,
			time: base + turn * 1000 + 500,
			turn,
			step: 1,
			provider,
			model,
			usage: {
				inputTokens: 100 * turn,
				outputTokens: 20 * turn,
				cacheReadTokens: 1000 * turn,
				cacheWriteTokens: 0,
			},
		}));
		events.push({ type: "step/end", seq: seq++, time: base + turn * 1000 + 600, data: { turn, step: 1 } });
		events.push({ type: "turn/end", seq: seq++, time: base + turn * 1000 + 700, data: { turn } });
	}
	return events;
}

/**
 * A live-session stand-in exposing exactly what the report reads off a real
 * `Session`: `seq`, `eventAt(index)`, and `header.id`.
 *
 * @param {object[]} events - durable events in seq order.
 * @returns {object} the fake session.
 */
export function makeLiveSession(events) {
	return {
		seq: events.length,
		eventAt: (index) => events[index],
		header: { id: events[0]?.id ?? "session-live", cwd: events[0]?.cwd },
	};
}

/**
 * Write a fake DSH home with session logs and a workspace registry.
 *
 * @param {object} input - fixture input.
 * @param {string} input.root - directory to build the home in.
 * @param {Array<object>} input.sessions - `{id, title, events, slug}` rows.
 * @returns {{home: string, files: Map<string, string>}} the home path and a map of session id → log file.
 */
export function makeHome({ root, sessions }) {
	mkdirSync(join(root, "storages", "session_projcache", "sessions"), { recursive: true });
	const files = new Map();
	const workspaces = {};
	const defaultWorkspaceId = "ws-0000-0000-0000-000000000001";
	workspaces[defaultWorkspaceId] = { path: root, title: "fixture", sessionIds: [] };
	for (const session of sessions) {
		const slug = session.slug ?? "--fixture--";
		const dir = join(root, "sessions", slug, session.id);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "session.v4.jsonl.zstd");
		const jsonl = `${session.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
		// Two concatenated frames on purpose: this is how DSH appends, and a
		// single-shot decompressor would silently return only the first one.
		const bytes = Buffer.from(jsonl, "utf8");
		const half = Math.max(1, Math.floor(bytes.length / 2));
		const frame = Buffer.concat([
			zstdCompressSync(bytes.subarray(0, half)),
			zstdCompressSync(bytes.subarray(half)),
		]);
		writeFileSync(file, frame);
		files.set(session.id, file);
		workspaces[defaultWorkspaceId].sessionIds.push(session.id);
		if (session.title !== undefined) {
			writeFileSync(
				join(root, "storages", "session_projcache", "sessions", `${session.id}.json`),
				JSON.stringify({ version: 7, record: { rows: { title: { ver: 1, seq: 1, val: session.title } } } }),
			);
		}
	}
	writeFileSync(
		join(root, "storages", "workspace.json"),
		JSON.stringify({
			unit: { name: "workspace", version: 2 },
			global: { initialized: true, defaultWorkspaceId, workspaceIds: [defaultWorkspaceId], archivedSessionIds: [], pinnedSessionIds: [] },
			tables: { workspaces },
		}),
	);
	return { home: root, files };
}
