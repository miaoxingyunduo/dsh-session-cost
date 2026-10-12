/**
 * Install / uninstall the cost-accounting plugin in a DSH profile.
 *
 * Three steps, each backed up, each reversible by `--uninstall`:
 *
 * 1. copy the package into `<profile>/node_modules/@local/dsh-session-cost`
 *    (real files, never a junction: DSH resolves a plugin's bare imports
 *    through the profile's own `node_modules`, and a link back to the source
 *    tree has emptied that tree before);
 * 2. record `"@local/dsh-session-cost": "file:<abs path>"` in the profile
 *    manifest and append the package to `dsh.profile.bundles` — that selection
 *    is what makes the Plugins page list it under Installed with a toggle;
 * 3. write a managed block into the profile patch that configures both rows by
 *    id: the rate table, the display currency, and the off-peak window.
 *
 * Re-run it after editing this package to refresh the copy.
 *
 * Usage:
 *   node install/install.mjs
 *   node install/install.mjs --dry-run
 *   node install/install.mjs --currency '{"symbol":"¥","code":"CNY","perUsd":7.2}'
 *   node install/install.mjs --rate 'deepseek-official/deepseek-flash={"input":0.3,"cacheRead":0.006,"output":1.2}'
 *   node install/install.mjs --off-peak-multiplier 0.5 --off-peak-timezone Asia/Shanghai
 *   node install/install.mjs --uninstall
 *
 * Options:
 *   --profile <name>        profile under $DSH_HOME/profiles (default desktop)
 *   --profile-dir <path>    explicit profile directory (overrides --profile)
 *   --rates <json file>     rate table to install instead of the built-in defaults
 *   --rate <key=json>       one rate entry; repeatable, and merges over --rates
 *   --currency <json>       display currency, e.g. {"symbol":"¥","perUsd":7.2}
 *   --off-peak-multiplier <n>   off-peak price = peak price × n
 *   --off-peak-timezone <zone>  IANA zone for the peak window
 *   --dsh-home-config <path>    pin `dshHome` in the row (default: empty = $DSH_HOME)
 *   --dry-run               print the planned changes instead of writing
 *   --uninstall             remove the rows, the copy and the manifest entry
 *   --force                 refresh the copy even when nothing appears to change
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CURRENCY, DEFAULT_OFF_PEAK_MULTIPLIER, DEFAULT_RATES } from "../lib/rates.js";

/** Package name; the copy's directory, the patch rows, and the manifest must agree. */
const PACKAGE_NAME = "@local/dsh-session-cost";
/** The two rows the bundle declares, in bundle order. */
const ROWS = ["session-cost", "session-cost-command"];
/** Copied into the profile; the rest of the package is developer tooling. */
const PACKAGE_FILES = ["lib", "cordis.patch.yml", "package.json", "README.md"];

const START = "# >>> dsh-session-cost (managed block: rewrite with install/install.mjs --force, remove with --uninstall)";
const END = "# <<< dsh-session-cost";

/** Quote a YAML scalar with single quotes. */
const yamlString = (value) => `'${String(value).replace(/'/gu, "''")}'`;

/**
 * Emit a JSON value as a YAML block scalar under `key`.
 *
 * A block scalar is used rather than raw JSON because a raw nested JSON object
 * would depend on the indentation matching this script's, while `|` hands the
 * plugin the exact JSON *text* — which is also the form the row stores and the
 * form the plugin's settings textarea shows.
 *
 * @param {string} key - config field name.
 * @param {unknown} value - value to serialize.
 * @param {number} keyIndent - indentation of the key itself.
 * @returns {string[]} the emitted lines.
 */
function yamlJsonValue(key, value, keyIndent) {
	const pad = " ".repeat(keyIndent);
	const body = " ".repeat(keyIndent + 2);
	return [
		`${pad}${key}: |`,
		...JSON.stringify(value, null, 2).split("\n").map((line) => `${body}${line}`),
	];
}

/**
 * Build the managed patch block for one set of values.
 *
 * Exported because it is the part worth proving: a malformed block would break
 * the profile's patch file, so the test suite parses the emitted YAML with a
 * real parser rather than a hand-rolled approximation.
 *
 * @param {object} input - the values to install.
 * @param {object} input.rates - rate table.
 * @param {object} input.currency - display currency.
 * @param {number} input.offPeakMultiplier - off-peak price multiplier.
 * @param {string} input.offPeakTimezone - IANA zone for the peak window.
 * @param {string} input.offPeakHolidays - comma-separated dates billed off-peak all day.
 * @param {string} input.dshHome - pinned DSH home, or "" for the default.
 * @returns {string} the block text, ending in a newline.
 */
export function buildManagedBlock({ rates, currency, offPeakMultiplier, offPeakTimezone, offPeakHolidays = "", dshHome }) {
	const lines = [START];
	for (const id of ROWS) {
		// Both rows carry the same config: either row can be toggled independently,
		// so either must be able to price on its own.
		lines.push(`- id: ${id}`, `  name: ${yamlString(PACKAGE_NAME)}`, "  config:");
		lines.push(...yamlJsonValue("rates", rates, 4));
		lines.push(...yamlJsonValue("currency", currency, 4));
		lines.push(`    offPeakMultiplier: ${offPeakMultiplier}`);
		lines.push(`    offPeakTimezone: ${yamlString(offPeakTimezone)}`);
		// Empty means "use the module's built-in list"; a non-empty value replaces it.
		if (offPeakHolidays !== "") lines.push(`    offPeakHolidays: ${yamlString(offPeakHolidays)}`);
		lines.push(`    dshHome: ${yamlString(dshHome)}`);
	}
	lines.push(END, "");
	return lines.join("\n");
}

/**
 * Apply a managed block to patch text, replacing one already present.
 *
 * @param {string} original - the current patch file content.
 * @param {string} block - the block to install, or "" to remove the block.
 * @returns {{text: string, hasBlock: boolean, changed: boolean}} the result.
 */
export function applyManagedBlock(original, block) {
	const startIndex = original.indexOf(START);
	const endIndex = original.indexOf(END);
	const hasBlock = startIndex !== -1 && endIndex !== -1 && endIndex > startIndex;
	if (hasBlock) {
		const afterEnd = endIndex + END.length;
		const blockEnd = original[afterEnd] === "\n" ? afterEnd + 1 : afterEnd;
		const text = original.slice(0, startIndex) + block + original.slice(blockEnd);
		return { text, hasBlock, changed: text !== original };
	}
	if (block === "") return { text: original, hasBlock: false, changed: false };
	// A freshly initialized profile is a bare `[]` (plus comments); appending a
	// block sequence after an empty flow sequence is invalid YAML.
	const withoutComments = original.replace(/^[ \t]*#.*$/gmu, "").trim();
	if (withoutComments === "[]") {
		const emptyIndex = original.indexOf("[]");
		const head = original.slice(0, emptyIndex).replace(/[ \t]*$/u, "");
		return {
			text: `${head}${head.length > 0 && !head.endsWith("\n") ? "\n" : ""}${block}`,
			hasBlock: false,
			changed: true,
		};
	}
	const separator = original.endsWith("\n") ? "\n" : "\n\n";
	return { text: `${original}${separator}${block}`, hasBlock: false, changed: true };
}

/** Parse argv into options. */
function parseArgs(args) {
	const options = {
		profile: "desktop",
		profileDir: undefined,
		ratesFile: undefined,
		rate: [],
		currency: undefined,
		offPeakMultiplier: undefined,
		offPeakTimezone: undefined,
		offPeakHolidays: undefined,
		dshHomeConfig: undefined,
		dryRun: false,
		uninstall: false,
		force: false,
	};
	const flagsWithValue = new Map([
		["--profile", "profile"],
		["--profile-dir", "profileDir"],
		["--rates", "ratesFile"],
		["--currency", "currency"],
		["--off-peak-multiplier", "offPeakMultiplier"],
		["--off-peak-timezone", "offPeakTimezone"],
		["--off-peak-holidays", "offPeakHolidays"],
		["--dsh-home-config", "dshHomeConfig"],
	]);
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--dry-run") options.dryRun = true;
		else if (argument === "--uninstall") options.uninstall = true;
		else if (argument === "--force") options.force = true;
		else if (argument === "--rate") {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("--")) {
				console.error("--rate requires <provider/model>=<json>");
				process.exit(2);
			}
			index += 1;
			const split = value.indexOf("=");
			if (split < 1) {
				console.error(`--rate needs <provider/model>=<json>; received "${value}"`);
				process.exit(2);
			}
			options.rate.push([value.slice(0, split), value.slice(split + 1)]);
		} else if (argument === "--help" || argument === "-h") {
			console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*/u, "").trim());
			process.exit(0);
		} else if (flagsWithValue.has(argument)) {
			const key = flagsWithValue.get(argument);
			const value = args[index + 1];
			if (value === undefined || value.startsWith("--")) {
				console.error(`${argument} requires a value`);
				process.exit(2);
			}
			index += 1;
			options[key] = key === "offPeakMultiplier" ? Number(value) : value;
		} else {
			console.error(`unknown argument: ${argument}`);
			process.exit(2);
		}
	}
	return options;
}

/**
 * Resolve the rate table the installer will write.
 *
 * @param {object} options - parsed argv.
 * @returns {Record<string, object>} the table.
 */
function resolveRates(options) {
	let table = { ...DEFAULT_RATES };
	if (options.ratesFile !== undefined) {
		const file = resolve(options.ratesFile);
		if (!existsSync(file)) {
			console.error(`--rates file not found: ${file}`);
			process.exit(3);
		}
		try {
			table = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			console.error(`--rates file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(3);
		}
	}
	for (const [key, json] of options.rate) {
		try {
			table[key] = JSON.parse(json);
		} catch (error) {
			console.error(`--rate ${key} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(3);
		}
	}
	if (Object.keys(table).length === 0) {
		console.error("the rate table is empty; add at least one model or drop --rates");
		process.exit(3);
	}
	return table;
}

/** Run the installer's CLI. Importing this module for its exports does not run it. */
function main() {
	const options = parseArgs(process.argv.slice(2));
	const packageRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const profileDir = options.profileDir !== undefined ? resolve(options.profileDir) : join(dshHome, "profiles", options.profile);
	const patchPath = join(profileDir, "cordis.patch.yml");
	const manifestPath = join(profileDir, "package.json");
	const installPath = join(profileDir, "node_modules", ...PACKAGE_NAME.split("/"));

	if (!options.uninstall) {
		for (const file of PACKAGE_FILES) {
			if (!existsSync(join(packageRoot, file))) {
				console.error(`package file missing next to the installer: ${file}`);
				process.exit(3);
			}
		}
		if (options.offPeakMultiplier !== undefined && (!Number.isFinite(options.offPeakMultiplier) || options.offPeakMultiplier < 0)) {
			console.error(`--off-peak-multiplier must be a finite number >= 0; received "${options.offPeakMultiplier}"`);
			process.exit(2);
		}
		if (options.currency !== undefined) {
			try {
				const currency = JSON.parse(options.currency);
				if (currency === null || typeof currency !== "object" || Array.isArray(currency)) throw new Error("not an object");
			} catch (error) {
				console.error(`--currency must be a JSON object: ${error instanceof Error ? error.message : String(error)}`);
				process.exit(2);
			}
		}
	}

	if (!existsSync(patchPath)) {
		console.error(`profile patch not found: ${patchPath}`);
		console.error("check --profile / --profile-dir, or start DSH once so it initializes the profile");
		process.exit(3);
	}

	/** The managed block for this run, or "" for --uninstall. */
	const block = options.uninstall
		? ""
		: buildManagedBlock({
			rates: resolveRates(options),
			currency: options.currency === undefined ? DEFAULT_CURRENCY : JSON.parse(options.currency),
			offPeakMultiplier: options.offPeakMultiplier ?? DEFAULT_OFF_PEAK_MULTIPLIER,
			offPeakTimezone: options.offPeakTimezone ?? "UTC",
			// Left empty on purpose: an empty value means the module's built-in
			// calendar applies, so a rebuilt installer picks up a corrected list
			// without the profile pinning a stale copy.
			offPeakHolidays: options.offPeakHolidays ?? "",
			dshHome: options.dshHomeConfig ?? "",
		});

	const patchOriginal = readFileSync(patchPath, "utf8");
	const patch = applyManagedBlock(patchOriginal, block);

	/** The profile manifest: local dependency plus the bundle selection. */
	const manifestOriginal = readFileSync(manifestPath, "utf8");
	const manifest = JSON.parse(manifestOriginal);
	manifest.dependencies = manifest.dependencies ?? {};
	const fileSpec = `file:${packageRoot.replace(/\\/gu, "/")}`;
	manifest.dsh = manifest.dsh ?? {};
	manifest.dsh.profile = manifest.dsh.profile ?? {};
	const selectedBundles = Array.isArray(manifest.dsh.profile.bundles) ? [...manifest.dsh.profile.bundles] : [];
	const wasSelected = selectedBundles.includes(PACKAGE_NAME);
	if (options.uninstall) {
		delete manifest.dependencies[PACKAGE_NAME];
		if (wasSelected) manifest.dsh.profile.bundles = selectedBundles.filter((name) => name !== PACKAGE_NAME);
	} else {
		manifest.dependencies[PACKAGE_NAME] = fileSpec;
		if (!wasSelected) manifest.dsh.profile.bundles = [...selectedBundles, PACKAGE_NAME];
	}
	const manifestNext = `${JSON.stringify(manifest, null, 2)}\n`;

	/** Describe what currently sits at the install path. */
	const installState = () => {
		if (!existsSync(installPath)) return "absent";
		try {
			if (lstatSync(installPath).isSymbolicLink()) return "link";
		} catch {
			return "unreadable";
		}
		try {
			const installed = JSON.parse(readFileSync(join(installPath, "package.json"), "utf8"));
			return installed.name === PACKAGE_NAME ? "copy" : `other-package (${installed.name})`;
		} catch {
			return "not-a-package";
		}
	};
	const currentState = installState();

	if (options.dryRun) {
		console.log(`profile:      ${profileDir}`);
		console.log(`install path: ${installPath}`);
		console.log(`current:      ${currentState}`);
		console.log(`bundle:       ${wasSelected ? "selected" : "not selected"}`);
		console.log(`action:       ${options.uninstall ? "remove copy + rows + dependency + bundle selection" : "copy package, write both rows, dependency and bundle selection"}`);
		console.log(`\n--- ${patchPath} ---\n${patch.text}`);
		console.log(`--- ${manifestPath} ---\n${manifestNext}`);
		process.exit(0);
	}

	const upToDate = patch.hasBlock
		&& !patch.changed
		&& currentState === "copy"
		&& manifest.dependencies[PACKAGE_NAME] === fileSpec
		&& wasSelected
		&& !options.uninstall;
	if (upToDate && !options.force) {
		console.log("already installed and unchanged; nothing to write (use --force to refresh the copy)");
		process.exit(0);
	}

	const stamp = Date.now();
	if (patch.changed) {
		copyFileSync(patchPath, `${patchPath}.dsh-session-cost-${stamp}.bak`);
		writeFileSync(patchPath, patch.text);
	}
	if (manifestNext !== manifestOriginal) {
		copyFileSync(manifestPath, `${manifestPath}.dsh-session-cost-${stamp}.bak`);
		writeFileSync(manifestPath, manifestNext);
	}

	// A failed delete is not always a running DSH: an agent's own file sandbox, a
	// read-only mount, or a permission-restricted install directory all refuse the
	// unlink while still allowing a plain file overwrite. Try the overwrite before
	// reporting failure, and name the likely cause.
	let removed = true;
	let denied;
	try {
		rmSync(installPath, { recursive: true, force: true });
	} catch (error) {
		if (error?.code !== "EPERM" && error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY" && error?.code !== "EIO") throw error;
		removed = false;
		denied = error;
	}
	if (options.uninstall) {
		console.log(`wrote ${patchPath} (rows removed)`);
		if (manifestNext !== manifestOriginal) console.log(`wrote ${manifestPath} (dependency and bundle selection removed)`);
		if (removed) {
			console.log(`removed ${installPath}`);
		} else {
			console.log(`could not remove ${installPath}: ${denied.code}`);
			console.log("quit DSH and rerun this installer; if it still refuses, the directory is permission-restricted or read-only");
		}
	} else {
		mkdirSync(dirname(installPath), { recursive: true });
		const locked = [];
		const deniedFiles = [];
		// Copy file by file rather than with `cpSync`: on Windows, `cpSync` refuses a
		// destination directory it cannot fully enumerate and would abort the whole
		// install, while per-file writes are exactly what the reader needs.
		const copyInto = (source, target) => {
			const stat = statSync(source);
			if (stat.isDirectory()) {
				mkdirSync(target, { recursive: true });
				for (const entry of readdirSync(source)) copyInto(join(source, entry), join(target, entry));
				return;
			}
			copyFileSync(source, target);
		};
		for (const file of PACKAGE_FILES) {
			const source = join(packageRoot, file);
			try {
				copyInto(source, join(installPath, file));
			} catch (error) {
				if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "EROFS") {
					// A permission denial is not a lock: the bytes on disk may simply be
					// unreachable from here, so the caller must finish the job with
					// enough access rather than waiting for DSH to exit.
					deniedFiles.push(statSync(source).isDirectory() ? `${file}/` : file);
					continue;
				}
				if (error?.code === "EBUSY" || error?.code === "EIO") {
					locked.push(statSync(source).isDirectory() ? `${file}/` : file);
					continue;
				}
				throw error;
			}
		}
		console.log(`wrote ${patchPath} (rate table + both rows)`);
		if (manifestNext !== manifestOriginal) console.log(`wrote ${manifestPath} (dependency + bundle selection)`);
		console.log(removed ? `copied ${PACKAGE_NAME} -> ${installPath}` : `updated ${PACKAGE_NAME} in place -> ${installPath}`);
		if (deniedFiles.length > 0) {
			console.log(`NOT updated (permission denied): ${deniedFiles.join(", ")}`);
			console.log("the rows are patched but the module next to them is still the old copy — rerun with enough file access (an agent must use its wider sandbox mode)");
		}
		if (locked.length > 0) {
			console.log(`NOT updated (in use by a running DSH): ${locked.join(", ")} — quit DSH and rerun`);
		}
		console.log("installed as a DSH bundle: tools session_cost / list_session_costs, command /cost");
		console.log("restart DSH completely, then hard-refresh the page (Ctrl+R) for the cost pill");
		console.log(`backups: *.dsh-session-cost-${stamp}.bak beside each file`);
	}
}

// Only run when invoked directly; `import` stays side-effect free.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
