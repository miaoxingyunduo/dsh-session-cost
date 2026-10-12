/**
 * The disk half: decode a DSH session log, enumerate the sessions this machine
 * knows, and resolve a human target string to exactly one session.
 *
 * A session log is a sequence of concatenated zstd frames — the persistence
 * layer appends one frame per checkpoint — so decoding walks frames explicitly
 * instead of trusting a single-shot decompressor, which stops at the first one.
 *
 * Everything here is read-only and path-safe: a session id is validated before
 * it is ever joined onto a path.
 *
 * @module @local/dsh-session-cost/engine
 */

import { createZstdDecompress, zstdDecompressSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

/** The session log file names DSH has used, newest first. */
export const LOG_FILE_NAMES = ["session.v5.jsonl.zstd", "session.v4.jsonl.zstd", "session.v4.jsonl"];

/** Zstd frame magic number, little-endian. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** A session id is `session-<uuid>` or a bare uuid; nothing else may reach a path. */
const SESSION_ID_PATTERN = /^(session-)?[0-9a-fA-F-]{36}$/;

/**
 * Resolve the DSH home directory: an explicit config value, then `$DSH_HOME`,
 * then `~/.dsh`.
 *
 * @param {string} [configured] - row config value.
 * @returns {string} absolute home path.
 */
export function resolveHome(configured) {
	if (typeof configured === "string" && configured.trim().length > 0) return resolve(configured.trim());
	const fromEnv = process.env.DSH_HOME;
	if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return resolve(fromEnv.trim());
	return join(homedir(), ".dsh");
}

/**
 * Find every zstd frame-start magic in a buffer. Diagnostic only: those four
 * bytes can also occur inside a compressed block, so this count is an upper
 * bound on the number of frames, not a set of safe split points.
 *
 * @param {Buffer} buffer - the file's bytes.
 * @returns {number[]} ascending candidate offsets (includes 0 for a valid file).
 */
export function frameOffsets(buffer) {
	const offsets = [];
	for (let index = 0; index + 3 < buffer.length; index += 1) {
		// oxlint-disable-next-line no-bitwise -- byte comparison
		if (buffer[index] === ZSTD_MAGIC[0] && buffer[index + 1] === ZSTD_MAGIC[1]
			&& buffer[index + 2] === ZSTD_MAGIC[2] && buffer[index + 3] === ZSTD_MAGIC[3]) {
			offsets.push(index);
		}
	}
	return offsets;
}

/**
 * Decode a concatenated-frame zstd buffer, preserving order.
 *
 * Node's zstd decompressor stops at the end of the first frame, so this walks
 * the buffer one frame at a time: after each pass, `bytesWritten` is the exact
 * number of input bytes that frame consumed, and the next frame begins there.
 * That is more reliable than scanning for the frame magic, because those four
 * bytes can also occur inside a compressed block.
 *
 * @param {Buffer} buffer - raw file bytes.
 * @returns {Promise<Buffer>} concatenated plain bytes.
 * @throws when the buffer is not zstd, or a frame consumes no input (which would loop forever).
 */
export async function decodeZstdFrames(buffer) {
	if (typeof createZstdDecompress !== "function") {
		throw new Error("this Node.js runtime has no zstd support (node:zlib.createZstdDecompress is missing)");
	}
	if (frameOffsets(buffer).length === 0) throw new Error("not a zstd stream: no frame magic found");
	const parts = [];
	let offset = 0;
	let frames = 0;
	while (offset < buffer.length) {
		const stream = createZstdDecompress();
		const collected = [];
		const done = (async () => {
			for await (const chunk of stream) collected.push(chunk);
		})();
		stream.end(buffer.subarray(offset));
		await done;
		const consumed = stream.bytesWritten;
		if (!Number.isFinite(consumed) || consumed <= 0) {
			throw new Error(`zstd frame at byte ${offset} consumed no input; refusing to loop`);
		}
		parts.push(Buffer.concat(collected));
		offset += consumed;
		frames += 1;
	}
	if (frames === 0) throw new Error("not a zstd stream: no frame decoded");
	return Buffer.concat(parts);
}

/**
 * Parse decoded log text into events.
 *
 * @param {string} text - decoded JSONL.
 * @returns {{events: object[], skipped: number}} parsed events and the count of unusable lines.
 */
export function parseLog(text) {
	const events = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			events.push(JSON.parse(trimmed));
		} catch {
			skipped += 1;
		}
	}
	return { events, skipped };
}

/**
 * Read and decode one session log file.
 *
 * @param {string} file - absolute log path.
 * @returns {Promise<{events: object[], skipped: number, bytes: number}>} the decoded log.
 */
export async function readSessionLog(file) {
	const buffer = readFileSync(file);
	if (buffer.length === 0) return { events: [], skipped: 0, bytes: 0 };
	if (file.endsWith(".zstd")) {
		const { events, skipped } = parseLog((await decodeZstdFrames(buffer)).toString("utf8"));
		return { events, skipped, bytes: buffer.length };
	}
	const { events, skipped } = parseLog(buffer.toString("utf8"));
	return { events, skipped, bytes: buffer.length };
}

/** The first `session` event of a log, if any. */
export function sessionHeader(events) {
	if (!Array.isArray(events)) return undefined;
	const header = events.find((event) => event !== null && typeof event === "object" && event.type === "session");
	if (header === undefined) return undefined;
	return {
		id: typeof header.id === "string" ? header.id : undefined,
		createdAt: Number.isFinite(header.createdAt) ? header.createdAt : undefined,
		cwd: typeof header.cwd === "string" ? header.cwd : undefined,
		agentPreset: typeof header.agentPreset === "string" ? header.agentPreset : undefined,
		// The durable delegation link: a delegated session names its parent here,
		// and `origin`/`delegationDepth` say what it is. This is what makes a
		// conversation's whole family recoverable without guessing from log text.
		parentSession: typeof header.parentSession === "string" ? header.parentSession : undefined,
		origin: typeof header.origin === "string" ? header.origin : undefined,
		delegationDepth: Number.isFinite(header.delegationDepth) ? header.delegationDepth : undefined,
	};
}

/**
 * Read only the log's first JSONL line — the `session` header — without decoding
 * the rest.
 *
 * A session log is many concatenated zstd frames and the header sits in the
 * first line, so this decodes frames until a newline appears and then stops.
 * That is what keeps a whole-machine family scan in tens of milliseconds
 * instead of decoding every conversation.
 *
 * A damaged frame does not have to lose the delegation link: the raw bytes are
 * tried as plain JSONL before giving up, because a header that parses still
 * names its parent even when the rest of the log is unreadable. Silently
 * dropping the link would under-count a family with no visible symptom.
 *
 * @param {string} file - absolute log path.
 * @returns {Promise<object|undefined>} the raw header event.
 */
export async function readSessionHeader(file) {
	const buffer = readFileSync(file);
	if (buffer.length === 0) return undefined;
	/** Parse the first line of some text, or undefined. */
	const firstEvent = (text) => {
		const line = text.split("\n", 1)[0];
		if (line.trim() === "") return undefined;
		try {
			return JSON.parse(line);
		} catch {
			return undefined;
		}
	};
	if (!file.endsWith(".zstd")) return firstEvent(buffer.toString("utf8"));
	let offset = 0;
	let text = "";
	try {
		while (offset < buffer.length) {
			const stream = createZstdDecompress();
			const chunks = [];
			const done = (async () => {
				for await (const chunk of stream) chunks.push(chunk);
			})();
			stream.end(buffer.subarray(offset));
			await done;
			text += Buffer.concat(chunks).toString("utf8");
			if (text.includes("\n")) break;
			const consumed = stream.bytesWritten;
			if (!Number.isFinite(consumed) || consumed <= 0) break;
			offset += consumed;
		}
	} catch {
		// Fall through to the raw bytes below.
	}
	return firstEvent(text) ?? firstEvent(buffer.toString("utf8"));
}

/**
 * Whole-machine family indexes, held so a page with many mounted readouts does
 * not rescan every session's header for each one.
 *
 * The key carries the log list's identity (path, size, mtime for every session
 * log), so a new, removed or rewritten log is a different key rather than a
 * stale answer — which is what keeps a refresh button honest and what keeps the
 * tests independent, since a fresh home directory is always a fresh key. Within
 * one unchanged snapshot the promise is cached rather than the result, so
 * parallel callers share a single scan instead of racing to repeat it.
 *
 * The honest limit: an append to a log changes size and mtime, so a busy
 * conversation never gets a cache hit. The reuse is for the idle sessions a
 * session-list page mounts beside the open one, and for repeated reads inside
 * one request. The map is capped, so a stream of distinct snapshots cannot grow
 * it without bound.
 */
const FAMILY_INDEX_LIMIT = 64;
const familyIndexCache = new Map();

/** Forget every cached family index (tests, and any caller that needs it now). */
export function clearFamilyIndexCache() {
	familyIndexCache.clear();
}

/** The identity of one log list: enough to notice any new, gone or rewritten log. */
function familyIndexKey(home, logs) {
	return `${home}\u0000${logs.map((entry) => `${entry.file}:${entry.bytes}:${entry.mtimeMs}`).join("|")}`;
}

/**
 * Every session's delegation header, read from the first line of each log.
 *
 * @param {string} home - DSH home.
 * @param {object} [options] - read options.
 * @param {boolean} [options.fresh] - bypass the short-lived index cache.
 * @returns {Promise<{byId: Map<string, object>, parents: Map<string, string[]>, logs: Array<object>}>} the family index.
 */
export async function readFamilyIndex(home, options = {}) {
	const logs = listSessionLogs(home);
	const key = familyIndexKey(home, logs);
	const cached = familyIndexCache.get(key);
	if (options.fresh !== true && cached !== undefined) return cached;
	const pending = buildFamilyIndex(logs);
	familyIndexCache.set(key, pending);
	if (familyIndexCache.size > FAMILY_INDEX_LIMIT) {
		// Map iteration is insertion-ordered, so the first key is the oldest.
		familyIndexCache.delete(familyIndexCache.keys().next().value);
	}
	try {
		return await pending;
	} catch (error) {
		familyIndexCache.delete(key);
		throw error;
	}
}

/**
 * Scan each listed log's header and index the delegation links.
 *
 * @param {Array<object>} logs - from {@link listSessionLogs}.
 * @returns {Promise<object>} the family index.
 */
async function buildFamilyIndex(logs) {
	const byId = new Map();
	const parents = new Map();
	for (const entry of logs) {
		let raw;
		try {
			raw = await readSessionHeader(entry.file);
		} catch {
			raw = undefined;
		}
		const header = {
			sessionId: entry.sessionId,
			file: entry.file,
			bytes: entry.bytes,
			mtimeMs: entry.mtimeMs,
			workspaceSlug: entry.workspaceSlug,
			...sessionHeader(raw === undefined ? [] : [raw]) ?? {},
		};
		byId.set(entry.sessionId, header);
		const parent = header.parentSession;
		if (typeof parent === "string" && parent.length > 0) {
			if (!parents.has(parent)) parents.set(parent, []);
			parents.get(parent).push(entry.sessionId);
		}
	}
	return { byId, parents, logs };
}

/**
 * A session's whole delegated family, breadth-first.
 *
 * The link is the durable `parentSession` field a delegated session writes into
 * its own header, so this survives restarts and needs no live registry. A
 * delegated session whose own log is gone cannot be expanded further, which the
 * caller must report rather than silently under-count.
 *
 * @param {object} input - discovery input.
 * @param {string} input.home - DSH home.
 * @param {string} input.sessionId - the root session id.
 * @param {number} [input.maxDepth] - how deep to walk (default 4).
 * @param {boolean} [input.fresh] - bypass the short-lived index cache.
 * @returns {Promise<{descendants: Array<object>, missingParents: string[], truncated: boolean}>} the family.
 */
export async function findDescendants({ home, sessionId, maxDepth = 4, fresh = false }) {
	const { byId, parents } = await readFamilyIndex(home, { fresh });
	const descendants = [];
	const missingParents = new Set();
	const seen = new Set([sessionId]);
	let frontier = [sessionId];
	for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
		const next = [];
		for (const parent of frontier) {
			for (const child of parents.get(parent) ?? []) {
				if (seen.has(child)) continue;
				seen.add(child);
				const header = byId.get(child);
				descendants.push({
					sessionId: child,
					parentSessionId: parent,
					depth,
					origin: header?.origin,
					delegationDepth: header?.delegationDepth,
					createdAt: header?.createdAt,
					cwd: header?.cwd,
					file: header?.file,
					bytes: header?.bytes,
					mtimeMs: header?.mtimeMs,
				});
				next.push(child);
			}
		}
		frontier = next;
	}
	// A parent named by someone we walked through, whose own log is missing, means
	// the family may continue behind a hole.
	for (const parent of seen) {
		if (parent === sessionId) continue;
		if (!byId.has(parent)) missingParents.add(parent);
	}
	return {
		descendants,
		missingParents: [...missingParents],
		truncated: frontier.length > 0,
	};
}

/**
 * The workspace registry and projection cache, for the titles and archived
 * flags the session list shows.
 *
 * `storages/workspace.json` is a v2 storage-hub document: membership lives in
 * `tables.workspaces.<id>.sessionIds` and the archive set lives under
 * `global.archivedSessionIds`. Titles are not stored there — a session's row
 * title is a projection, checkpointed per session under
 * `storages/session_projcache/sessions/<id>.json` — so that cache is read as
 * the title source when it exists.
 *
 * @param {string} home - DSH home.
 * @returns {Map<string, {title?: string, workspaceId?: string, workspacePath?: string, archived: boolean, pinned: boolean}>} by session id.
 */
export function readSessionIndex(home) {
	const byId = new Map();
	const ensure = (id) => {
		let row = byId.get(id);
		if (row === undefined) {
			row = { archived: false, pinned: false };
			byId.set(id, row);
		}
		return row;
	};
	let raw;
	try {
		raw = JSON.parse(readFileSync(join(home, "storages", "workspace.json"), "utf8"));
	} catch {
		raw = undefined;
	}
	const global = raw?.global ?? {};
	const archived = new Set((Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : []).map(String));
	const pinned = new Set((Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds : []).map(String));
	for (const id of archived) ensure(id).archived = true;
	for (const id of pinned) ensure(id).pinned = true;
	const workspaces = raw?.tables?.workspaces;
	if (workspaces !== null && typeof workspaces === "object") {
		for (const [workspaceId, workspace] of Object.entries(workspaces)) {
			if (workspace === null || typeof workspace !== "object") continue;
			for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
				const row = ensure(String(sessionId));
				row.workspaceId = workspaceId;
				if (typeof workspace.path === "string") row.workspacePath = workspace.path;
				if (typeof workspace.title === "string" && workspace.title.length > 0) row.workspaceTitle = workspace.title;
			}
		}
	}
	// Titles come from the persisted projection checkpoint, one small file each.
	const cacheDir = join(home, "storages", "session_projcache", "sessions");
	let cacheFiles;
	try {
		cacheFiles = readdirSync(cacheDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
	} catch {
		cacheFiles = [];
	}
	for (const file of cacheFiles) {
		const id = file.name.slice(0, -".json".length);
		const row = byId.get(id);
		if (row === undefined || row.title !== undefined) continue;
		try {
			const checkpoint = JSON.parse(readFileSync(join(cacheDir, file.name), "utf8"));
			const title = checkpoint?.record?.rows?.title?.val;
			if (typeof title === "string" && title.length > 0) row.title = title;
		} catch {
			continue;
		}
	}
	return byId;
}

/**
 * The session id a log directory name carries.
 *
 * @param {string} directory - directory name, e.g. `session-<uuid>` or `<uuid>`.
 * @returns {string|undefined} the session id.
 */
function sessionIdOfDirectory(directory) {
	const bare = directory.startsWith("session-") ? directory.slice("session-".length) : directory;
	return SESSION_ID_PATTERN.test(bare) ? directory : undefined;
}

/**
 * Enumerate every session log under one DSH home.
 *
 * @param {string} home - DSH home.
 * @returns {Array<{sessionId: string, workspaceSlug: string, dir: string, file: string, name: string, bytes: number, mtimeMs: number}>} entries, newest first.
 */
export function listSessionLogs(home) {
	const root = join(home, "sessions");
	let slugs;
	try {
		slugs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
	} catch {
		return [];
	}
	const found = [];
	for (const slug of slugs) {
		const slugDir = join(root, slug.name);
		let sessionDirs;
		try {
			sessionDirs = readdirSync(slugDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
		} catch {
			continue;
		}
		for (const sessionDir of sessionDirs) {
			if (sessionIdOfDirectory(sessionDir.name) === undefined) continue;
			const dir = join(slugDir, sessionDir.name);
			for (const name of LOG_FILE_NAMES) {
				const file = join(dir, name);
				try {
					const stat = statSync(file);
					if (!stat.isFile()) continue;
					found.push({
						sessionId: sessionDir.name,
						workspaceSlug: slug.name,
						dir,
						file,
						name,
						bytes: stat.size,
						mtimeMs: stat.mtimeMs,
					});
					break;
				} catch {
					continue;
				}
			}
		}
	}
	return found.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

/**
 * Resolve a caller-supplied target to exactly one session.
 *
 * Resolution is deliberately strict: an exact id wins, then a unique id prefix,
 * then a unique title fragment. Anything ambiguous resolves to nothing and
 * reports the candidates, because guessing here means billing the wrong
 * conversation.
 *
 * @param {object} input - resolution input.
 * @param {string} input.home - DSH home.
 * @param {string} [input.sessionId] - explicit id (from the calling agent).
 * @param {string} [input.target] - user-supplied id, prefix, or title fragment.
 * @returns {{kind: 'found', session: object}|{kind: 'ambiguous', candidates: object[]}|{kind: 'not-found', known: object[]}} the resolution.
 */
export function resolveSession({ home, sessionId, target }) {
	const logs = listSessionLogs(home);
	const index = readSessionIndex(home);
	const describe = (entry) => {
		const meta = index.get(entry.sessionId) ?? {};
		return {
			sessionId: entry.sessionId,
			title: meta.title,
			workspaceSlug: entry.workspaceSlug,
			file: entry.file,
			bytes: entry.bytes,
			mtimeMs: entry.mtimeMs,
			archived: meta.archived === true,
		};
	};
	const wanted = typeof target === "string" ? target.trim() : "";
	if (wanted === "") {
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			return { kind: "not-found", known: logs.slice(0, 20).map(describe) };
		}
		const match = logs.find((entry) => entry.sessionId === sessionId);
		return match === undefined ? { kind: "not-found", known: logs.slice(0, 20).map(describe) } : { kind: "found", session: describe(match) };
	}
	const exact = logs.filter((entry) => entry.sessionId === wanted);
	if (exact.length === 1) return { kind: "found", session: describe(exact[0]) };
	const byPrefix = logs.filter((entry) => entry.sessionId.includes(wanted));
	if (byPrefix.length === 1) return { kind: "found", session: describe(byPrefix[0]) };
	if (byPrefix.length > 1) return { kind: "ambiguous", candidates: byPrefix.map(describe) };
	const needle = wanted.toLowerCase();
	const byTitle = logs.filter((entry) => {
		const title = index.get(entry.sessionId)?.title;
		return typeof title === "string" && title.toLowerCase().includes(needle);
	});
	if (byTitle.length === 1) return { kind: "found", session: describe(byTitle[0]) };
	if (byTitle.length > 1) return { kind: "ambiguous", candidates: byTitle.map(describe) };
	return { kind: "not-found", known: logs.slice(0, 20).map(describe) };
}

/**
 * Guard a path this module is about to read: it must live under the sessions
 * root and its basename must be the resolved session id or a known log name.
 *
 * @param {string} home - DSH home.
 * @param {string} file - candidate path.
 * @returns {boolean} whether the read is inside the sessions root.
 */
export function isInsideSessionsRoot(home, file) {
	const root = resolve(join(home, "sessions")) + sep;
	return resolve(file).startsWith(root);
}

export { basename };
