/**
 * The panel's height ceiling, checked in a real browser layout.
 *
 * The unit tests prove the arithmetic; this proves the geometry. It writes a page
 * shaped like DSH's conversation panel — the composer inside an `overflow-y: auto`
 * scroll port, with a sticky seat at the bottom — and loads the **shipped**
 * stylesheet and the **shipped** ceiling functions into it (extracted from
 * lib/client.js, never retyped). The page then reports three geometries:
 *
 *   natural     — no ceiling at all: the shape of the bug, where the panel's own
 *                 header ends up above the edge the scroll port clips at;
 *   stylesheet  — the first-paint ceiling the CSS declares;
 *   measured    — the ceiling the readout measures off the DOM.
 *
 * Run:
 *   node test/ceiling-check.mjs                        # writes the page, says how to open it
 *   node test/ceiling-check.mjs <path-to-msedge.exe>    # also runs it and checks the result
 *
 * The browser run is optional on purpose: no test in this package needs a browser,
 * and this file is a script, not a `.test.mjs`, so `npm test` never picks it up.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const SOURCE = fileURLToPath(new URL("../lib/client.js", import.meta.url));
const OUT = fileURLToPath(new URL("./ceiling-check.html", import.meta.url));

/** The window sizes the check runs at: a maximized window, then a half-height one. */
const WINDOWS = ["2582,1485", "1600,780"];

const text = readFileSync(SOURCE, "utf8");

/** The stylesheet, exactly as the bundle ships it, with the class prefix resolved. */
function shippedCss() {
	const start = text.indexOf("const CSS = `");
	if (start < 0) throw new Error("the bundle has no CSS literal");
	const from = start + "const CSS = `".length;
	const end = text.indexOf("`;", from);
	if (end < 0) throw new Error("the CSS literal is unterminated");
	return text.slice(from, end).replaceAll("${NS}", "dsh-cost");
}

/** The brace-balanced source of one function declaration. */
function shippedFunction(name) {
	const start = text.indexOf(`function ${name}(`);
	if (start < 0) throw new Error(`the bundle has no ${name}`);
	// The body starts at the first `{` after the parameter list closes — not at the
	// first `{` overall, which a destructured parameter object would claim.
	let parens = 0;
	let body = -1;
	for (let index = text.indexOf("(", start); index < text.length; index += 1) {
		if (text[index] === "(") parens += 1;
		else if (text[index] === ")") {
			parens -= 1;
			if (parens === 0) {
				body = text.indexOf("{", index);
				break;
			}
		}
	}
	if (body < 0) throw new Error(`${name} has no body`);
	let depth = 0;
	for (let index = body; index < text.length; index += 1) {
		if (text[index] === "{") depth += 1;
		else if (text[index] === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(start, index + 1);
		}
	}
	throw new Error(`${name} is not brace-balanced`);
}

/** One constant declaration, verbatim. */
function shippedConstant(name) {
	const match = new RegExp(`const ${name} = [^;]+;`).exec(text);
	if (match === null) throw new Error(`the bundle has no ${name}`);
	return match[0];
}

const logic = [
	shippedConstant("PANEL_GAP"),
	shippedConstant("PANEL_FLOOR"),
	shippedFunction("clipTopOf"),
	shippedFunction("panelCeiling"),
].join("\n\n");

const page = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>ceiling check</title>
<style>
  html, body { margin: 0; height: 100%; }
  /* The handful of theme tokens the panel reads. This page has no theme registry,
     so they are given plain values only so the geometry is visible in a shot. */
  :root {
    --dsw-alias-bg-overlay: #23262b;
    --dsw-alias-bg-layer-1: #1b1e22;
    --dsw-alias-bg-layer-2: #2a2e34;
    --dsw-alias-border-l1: #33383f;
    --dsw-alias-border-l2: #4a5158;
    --dsw-alias-label-primary: #e8eaed;
    --dsw-alias-label-secondary: #9aa0a6;
    --dsw-alias-brand-primary: #4c8dff;
    --dsw-alias-state-warn-primary: #e5a50a;
    --dsw-alias-state-success-primary: #34a853;
    --dsw-alias-state-error-primary: #ea4335;
    --dsw-alias-scrollbar-bg-l2: #4a5158;
    --dsw-alias-scrollbar-hover-l2: #6b737b;
  }
  /* DSH's conversation panel: chrome above, then the scroll port that clips the
     composer — the box the popover has to stay inside. */
  #root { height: 100vh; display: flex; flex-direction: column; }
  #header { flex: none; height: 141px; background: #202020; color: #777; font: 12px system-ui; }
  #scrollBody { flex: 1; min-height: 0; overflow-y: auto; }
  #filler { height: 2000px; background: #101010; }
  /* The composer seat: sticky at the bottom of the scroll port, so the pill sits
     at a fixed place on screen while the conversation scrolls behind it. */
  #seat { position: sticky; bottom: 0; display: flex; flex-direction: column; }
  #card { height: 146px; background: #171717; }
  #dock { display: flex; justify-content: center; align-items: center; gap: 12px; padding: 4px 0 8px; }
  /* The readout with its family list expanded and a verify result: taller than the
     room above the pill, which is the reported case. */
  #filler-in-panel { height: 1250px; background: linear-gradient(#2b3a4a, #3a2b3a); }
${shippedCss()
	.split("\n")
	.map((line) => `  ${line}`)
	.join("\n")}
</style>
</head>
<body>
<div id="root">
  <div id="header">DSH chrome above the conversation scroll port</div>
  <div id="scrollBody">
    <div id="filler"></div>
    <div id="seat">
      <div id="card">composer card</div>
      <div id="dock">
        <div class="dsh-cost-root" id="anchor">
          <button class="dsh-cost-pill" type="button">&#165;12.8194</button>
          <div class="dsh-cost-panel" id="panel" role="dialog">
            <div id="filler-in-panel"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<pre id="report" hidden></pre>
<script>
window.addEventListener("error", (event) => {
	document.getElementById("report").textContent = "CEILING-ERROR " + event.message;
});

${logic}

const panel = document.getElementById("panel");
const anchor = document.getElementById("anchor");
const port = document.getElementById("scrollBody");
const rect = (element) => element.getBoundingClientRect();
const round = (value) => Math.round(value);

/** What the panel is doing at its current ceiling. */
function state(ceiling, extra = {}) {
	const box = rect(panel);
	return {
		ceiling,
		height: round(box.height),
		top: round(box.top),
		portTop: round(rect(port).top),
		// Inside the port means the whole panel is visible: its top edge is at or
		// below the boundary the scroll port clips at.
		insidePort: box.top >= rect(port).top - 0.5,
		overflow: round(box.top - rect(port).top),
		scrollable: panel.scrollHeight > panel.clientHeight + 1,
		...extra,
	};
}

const report = { viewport: [innerWidth, innerHeight] };

// 1. Uncapped: the shape of the bug — the panel's own header ends up above the port.
panel.style.maxHeight = "none";
report.natural = state("none");

// 2. The stylesheet's own ceiling, which is what the first paint gets.
panel.style.maxHeight = "";
report.stylesheet = state(getComputedStyle(panel).maxHeight);

// 3. The measured ceiling, applied exactly as the readout applies it.
const ceiling = panelCeiling({
	anchorTop: rect(anchor).top,
	clipTop: clipTopOf(anchor, (node) => getComputedStyle(node)),
});
panel.style.maxHeight = ceiling + "px";
report.measured = state(ceiling);

// And the content is reachable: scrolling the panel to its end shows the last row.
panel.scrollTop = panel.scrollHeight;
report.measured.reachedBottom = panel.scrollTop > 0;

// Which ceiling the page is left in, so a screenshot can show any of the three.
const mode = new URLSearchParams(location.search).get("ceiling") ?? "measured";
panel.style.maxHeight = mode === "none" ? "none" : mode === "stylesheet" ? "" : ceiling + "px";
report.shown = mode;

document.getElementById("report").textContent = "CEILING-REPORT " + JSON.stringify(report);
document.title = JSON.stringify(report);
</script>
</body>
</html>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, page, "utf8");

const browser = process.argv[2];
if (browser === undefined) {
	console.log(`wrote ${OUT}`);
	console.log("open it in any Chromium browser — append ?ceiling=none to see the bug — or");
	console.log("pass a browser path to check it here: node test/ceiling-check.mjs <msedge.exe>");
	process.exit(0);
}

/** Run the page in the browser and return its report. */
function run(size) {
	const result = spawnSync(browser, [
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		`--window-size=${size}`,
		"--dump-dom",
		"--virtual-time-budget=2000",
		pathToFileURL(OUT).href,
	], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	const found = /CEILING-REPORT (\{.*?\})<\/pre>/s.exec(result.stdout ?? "");
	if (found === null) {
		console.error(`no report from ${size}:\n${(result.stderr ?? "").slice(0, 400)}`);
		process.exitCode = 1;
		return undefined;
	}
	return { size, report: JSON.parse(found[1]) };
}

let failed = false;
for (const size of WINDOWS) {
	const outcome = run(size);
	if (outcome === undefined) continue;
	const { natural, stylesheet, measured } = outcome.report;
	console.log(`\n== window ${size} (viewport ${outcome.report.viewport.join("x")}) ==`);
	console.log(`  natural    ${natural.height}px tall, top ${natural.top} vs port ${natural.portTop} → insidePort ${natural.insidePort}`);
	console.log(`  stylesheet ${stylesheet.ceiling} tall, top ${stylesheet.top} → insidePort ${stylesheet.insidePort}, scrollable ${stylesheet.scrollable}`);
	console.log(`  measured   ${measured.ceiling}px tall, top ${measured.top} → insidePort ${measured.insidePort}, scrollable ${measured.scrollable}, reachedBottom ${measured.reachedBottom}`);
	const checks = [
		["an uncapped panel crosses the port's edge", natural.insidePort === false],
		["the stylesheet alone keeps it inside", stylesheet.insidePort === true],
		["the measurement keeps it inside", measured.insidePort === true],
		["the capped panel scrolls instead", measured.scrollable === true],
		["its last row is reachable", measured.reachedBottom === true],
	];
	for (const [what, ok] of checks) {
		console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
		if (!ok) failed = true;
	}
}
process.exit(failed ? 1 : 0);
