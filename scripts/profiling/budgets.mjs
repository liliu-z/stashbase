// Measures the performance budgets against the production renderer build.
// See scripts/profiling/README.md.
//
//   node scripts/profiling/budgets.mjs --label after [--runs 2] [--skip-build]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { BUDGET_MARKERS, writeBudgetProject } from "./fixtures.mjs";
import { buildRenderer, launchApp, parseArguments, profilingDirectory, repositoryRoot, sourceRevision } from "./harness.mjs";

// Informational limits: the report marks a run over a limit, but nothing
// gates on them yet. `metric` is a path into one run's result; a run is within
// a budget when that value is at or under `limit`.
const BUDGETS = [
  { name: "Open small file", metric: "open.small.settledMs", limit: 50, unit: "ms" },
  { name: "Open 120 KB file", metric: "open.big.settledMs", limit: 200, unit: "ms" },
  { name: "Switch to small file tab", metric: "open.switchSmall.settledMs", limit: 50, unit: "ms" },
  { name: "Switch to 120 KB file tab", metric: "open.switchBig.settledMs", limit: 50, unit: "ms" },
  { name: "Folder expand", metric: "folderExpand.settledMs", limit: 16, unit: "ms" },
  { name: "Long tasks while idle, 10 s", metric: "idle.longTasks", limit: 0, unit: "" },
  { name: "Typing in editor, p99", metric: "typing.editor.p99", limit: 16, unit: "ms" },
  { name: "Typing in chat, p99", metric: "typing.chat.p99", limit: 16, unit: "ms" },
  { name: "Cold start to interactive", metric: "coldStartMs", limit: 1000, unit: "ms" },
  { name: "Idle memory", metric: "memory.totalMB", limit: 600, unit: "MB" },
  { name: "Startup JS", metric: "startupJs.kb", limit: 350, unit: "KB" },
];

const KEYSTROKES = 150;
const KEY_INTERVAL_MS = 60;
const IDLE_MS = 10_000;
// After a file or folder appears, long tasks within this window still count
// toward its time: a freeze right after the first paint is part of opening.
const SETTLE_MS = 2_000;

const options = parseArguments(process.argv.slice(2), { label: "", runs: 2, "skip-build": false });
if (!options.label) throw new Error("Pass --label, for example --label before or --label after.");

const workDirectory = profilingDirectory("budgets");
const projectDirectory = path.join(workDirectory, "project");
const resultsFile = path.join(workDirectory, "results.jsonl");
const rendererRoot = path.join(repositoryRoot, "dist", "renderer");

const get = (value, metric) => metric.split(".").reduce((entry, key) => entry?.[key], value);
const round = (value) => Math.round(value * 10) / 10;

// ---- Page-side helpers, installed once per launch -------------------------

const PAGE_HELPERS = `(() => {
  window.__budget = { longTasks: [] };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__budget.longTasks.push([entry.startTime, entry.duration]);
  }).observe({ type: 'longtask' });

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));

  // The document editor: an editable root outside the chat composer that is
  // visible and shows the marker. Only the first text nodes are read, so the
  // check stays cheap on a large document.
  window.__budget.documentShows = (marker) => {
    for (const root of document.querySelectorAll('[contenteditable=true]')) {
      if (root.closest('[aria-label=Message]') || !root.checkVisibility()) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(), seen = 0; node && seen < 50; node = walker.nextNode(), seen++) {
        if (node.data.includes(marker)) return node;
      }
    }
    return null;
  };

  // Runs \`trigger\`, waits for \`ready\` on animation frames, then for the
  // frame after it. settledMs also covers long tasks that start within the
  // settle window, so a freeze right after the first paint counts.
  window.__budget.measure = async (trigger, ready, settleMs) => {
    const start = performance.now();
    trigger();
    const deadline = start + 15000;
    while (!ready()) {
      if (performance.now() > deadline) throw new Error('Timed out waiting for the result to appear.');
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await nextFrame();
    const visibleMs = performance.now() - start;
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    const tasks = window.__budget.longTasks.filter(([at]) => at >= start - 1 && at <= start + visibleMs + settleMs);
    return {
      visibleMs,
      settledMs: Math.max(visibleMs, ...tasks.map(([at, duration]) => at + duration - start)),
      longTasks: tasks.length,
      longTaskMs: tasks.reduce((sum, [, duration]) => sum + duration, 0),
    };
  };

  window.__budget.startLatency = () => {
    window.__budget.latencies = [];
    window.__budget.onInput = () => {
      const start = performance.now();
      requestAnimationFrame(() => setTimeout(() => window.__budget.latencies.push(performance.now() - start)));
    };
    window.addEventListener('beforeinput', window.__budget.onInput, true);
  };
  window.__budget.stopLatency = () => {
    window.removeEventListener('beforeinput', window.__budget.onInput, true);
    return window.__budget.latencies;
  };
})()`;

const treeItem = (relative) => `document.querySelector('[role=treeitem][data-path=${JSON.stringify(relative)}]')`;
const documentTab = (name) =>
  `[...document.querySelectorAll('[role=tablist][aria-label="Open documents"] [role=tab]')].find((tab) => tab.textContent.includes(${JSON.stringify(name)}))`;

async function measure(window, trigger, ready) {
  const result = await window.evaluate(`window.__budget.measure(() => { ${trigger} }, () => Boolean(${ready}), ${SETTLE_MS})`);
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, round(value)]));
}

// A single click opens a preview tab, which the next file replaces. A double
// click, sent after the measurement, keeps the tab so the switch can return.
async function openFile(window, name, marker) {
  const result = await measure(window, `${treeItem(name)}.click()`, `window.__budget.documentShows(${JSON.stringify(marker)})`);
  await window.evaluate(`${treeItem(name)}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))`);
  await delay(SETTLE_MS);
  return result;
}
const switchTab = (window, name, marker) =>
  measure(window, `${documentTab(name)}.click()`, `window.__budget.documentShows(${JSON.stringify(marker)})`);

async function typingLatency(window, focus) {
  await window.evaluate(focus);
  await delay(500);
  await window.evaluate("window.__budget.startLatency()");
  const text = "the quick brown fox jumps over the lazy dog ".repeat(4).slice(0, KEYSTROKES);
  await window.type(text, KEY_INTERVAL_MS);
  await delay(1000);
  const latencies = await window.evaluate("window.__budget.stopLatency()");
  if (latencies.length < KEYSTROKES * 0.9) throw new Error(`Only ${latencies.length} of ${KEYSTROKES} keystrokes reached the page.`);
  const sorted = [...latencies].sort((a, b) => a - b);
  const percentile = (p) => round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
  return { keys: sorted.length, p50: percentile(0.5), p99: percentile(0.99), max: round(sorted.at(-1)) };
}

// Caret at the end of the marker sentence.
const focusDocument = (marker) => `(() => {
  const node = window.__budget.documentShows(${JSON.stringify(marker)});
  node.parentElement.closest('[contenteditable=true]').focus();
  const range = document.createRange();
  range.setStart(node, node.data.indexOf(${JSON.stringify(marker)}) + ${marker.length});
  range.collapse(true);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
})()`;
const FOCUS_CHAT = `document.querySelector('[role=textbox][aria-label=Message]').focus()`;

// ---- Process memory --------------------------------------------------------

function processTable() {
  const output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,args="], { encoding: "utf8" });
  return output.trim().split("\n").map((line) => {
    const [, pid, ppid, rss, args] = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u);
    return { pid: Number(pid), ppid: Number(ppid), rssKb: Number(rss), args };
  });
}

// Proportional set size counts shared pages once across Chromium's
// processes; RSS counts them in every process. Linux only.
function pssKb(pid) {
  try {
    const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    return Number(rollup.match(/^Pss:\s+(\d+)/mu)?.[1]);
  } catch {
    return undefined;
  }
}

function classify(args) {
  if (/opencode|codex|claude|antigravity/iu.test(args)) return "agents";
  if (/python|stashbase-daemon/iu.test(args)) return "python";
  if (/server\/index/u.test(args)) return "host";
  // Chromium's helper processes re-execute the Electron binary as /proc/self/exe.
  if (/electron|^\/proc\/self\/exe/iu.test(args)) return "electron";
  return "other";
}

function processMemory(rootPids) {
  const table = processTable();
  const included = new Set(rootPids);
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of table) {
      if (!included.has(entry.pid) && included.has(entry.ppid)) {
        included.add(entry.pid);
        grew = true;
      }
    }
  }
  const groups = {};
  let pssAvailable = true;
  for (const entry of table.filter((candidate) => included.has(candidate.pid))) {
    const pss = pssKb(entry.pid);
    if (pss === undefined) pssAvailable = false;
    const name = classify(entry.args);
    const group = (groups[name] ??= { processes: 0, rssMB: 0, pssMB: 0 });
    group.processes++;
    if (name === "other") (group.commands ??= []).push(entry.args.slice(0, 120));
    group.rssMB += entry.rssKb / 1024;
    group.pssMB += (pss ?? entry.rssKb) / 1024;
  }
  for (const group of Object.values(groups)) {
    group.rssMB = Math.round(group.rssMB);
    group.pssMB = Math.round(group.pssMB);
  }
  const sum = (key) => Object.values(groups).reduce((total, group) => total + group[key], 0);
  return { totalMB: pssAvailable ? sum("pssMB") : sum("rssMB"), measure: pssAvailable ? "pss" : "rss", rssMB: sum("rssMB"), groups };
}

// ---- Startup JavaScript ----------------------------------------------------

// Every script the window had parsed when it became interactive, sized from
// the minified files on disk. Resource Timing does not report app:// loads;
// enabling the debugger replays a scriptParsed event for each parsed script.
async function startupJavaScript(window, origin) {
  const urls = new Set();
  const stop = window.on((message) => {
    if (message.method === "Debugger.scriptParsed" && message.params.url.startsWith(origin)) urls.add(message.params.url);
  });
  await window.send("Debugger.enable");
  await window.send("Debugger.disable");
  stop();
  const files = [...urls]
    .map((url) => decodeURIComponent(new URL(url).pathname).replace(/^\//u, ""))
    .filter((file) => /\.m?js$/u.test(file) && fs.existsSync(path.join(rendererRoot, file)));
  const bytes = files.reduce((total, file) => total + fs.statSync(path.join(rendererRoot, file)).size, 0);
  return { files: files.length, kb: Math.round(bytes / 1024), names: files.sort() };
}

// ---- One run ---------------------------------------------------------------

async function waitForIndex(app, total, timeoutMs) {
  return app.window
    .waitFor(`fetch('${app.hostOrigin}/api/index-status').then((response) => response.json()).then((status) => status.total >= ${total})`, { timeoutMs })
    .then(() => true, () => false);
}

// Every run starts from the state the priming launch left: the project open
// and indexed, no documents open. Typing autosaves and the session keeps open
// tabs, so both the documents and the profile are restored first.
const profileDirectory = path.join(workDirectory, "profile");
const primedProfile = path.join(workDirectory, "profile.primed");

async function run(runNumber, fixture) {
  writeBudgetProject(projectDirectory);
  fs.rmSync(profileDirectory, { recursive: true, force: true });
  fs.cpSync(primedProfile, profileDirectory, { recursive: true });
  const app = await launchApp({ workDirectory, renderer: "build", ownHost: true, fresh: false });
  try {
    const { window } = app;
    // Interactive: the restored project's tree shows its files.
    const deadline = Date.now() + 60_000;
    while (!(await window.evaluate(`Boolean(${treeItem(fixture.small)})`))) {
      if (Date.now() > deadline) throw new Error("The project did not reopen on launch.");
      await delay(20);
    }
    const coldStartMs = Date.now() - app.launchedAt;
    const startupJs = await startupJavaScript(window, app.origin);
    const indexSettled = await waitForIndex(app, fixture.markdownFiles, 60_000);
    await delay(2000);
    await window.evaluate(PAGE_HELPERS);

    // Before any document opens, so a document's background work cannot land
    // in the folder's settle window.
    const folder = "folder-05";
    const folderExpand = await measure(window, `${treeItem(folder)}.click()`, treeItem(`${folder}/note-1.md`));

    const open = {};
    open.small = await openFile(window, fixture.small, BUDGET_MARKERS.small);
    open.big = await openFile(window, fixture.big, BUDGET_MARKERS.big);
    open.switchSmall = await switchTab(window, fixture.small, BUDGET_MARKERS.small);
    open.switchBig = await switchTab(window, fixture.big, BUDGET_MARKERS.big);

    // Idle with the long document in front.
    const idleStart = await window.evaluate("performance.now()");
    await delay(IDLE_MS);
    const idleTasks = await window.evaluate(`window.__budget.longTasks.filter(([at]) => at >= ${idleStart})`);
    const idle = { longTasks: idleTasks.length, longTaskMs: round(idleTasks.reduce((sum, [, duration]) => sum + duration, 0)) };

    // Memory after the idle period, before typing starts a burst of work.
    const memory = processMemory(app.rootPids);

    const typing = {
      editor: await typingLatency(window, focusDocument(BUDGET_MARKERS.big)),
      chat: await typingLatency(window, FOCUS_CHAT),
    };

    return {
      scenario: "budgets",
      label: options.label,
      run: runNumber,
      revision: rendererRevision,
      at: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      indexSettled,
      coldStartMs,
      startupJs,
      open,
      folderExpand,
      idle,
      typing,
      memory,
    };
  } finally {
    await app.stop();
  }
}

// ---- Report ----------------------------------------------------------------

function report(results) {
  const rows = [["Budget", "Target", "Measured", "Result"]];
  let over = 0;
  for (const budget of BUDGETS) {
    const values = results.map((result) => get(result, budget.metric)).filter((value) => typeof value === "number");
    const worst = Math.max(...values);
    const low = Math.min(...values);
    const within = values.length > 0 && worst <= budget.limit;
    if (!within) over++;
    const unit = budget.unit ? ` ${budget.unit}` : "";
    rows.push([budget.name, `≤ ${budget.limit}${unit}`, `${low === worst ? worst : `${low}–${worst}`}${unit}`, within ? "within" : "over"]);
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) console.log(row.map((cell, column) => cell.padEnd(widths[column])).join("  "));
  const memory = results.at(-1).memory;
  console.log(
    `\nMemory (${memory.measure.toUpperCase()}, last run): ` +
      Object.entries(memory.groups).map(([name, group]) => `${name} ${group.pssMB} MB (${group.processes})`).join(", "),
  );
  console.log(`${over} of ${BUDGETS.length} budgets over their informational limit. Ranges cover ${results.length} runs; the worst run decides.`);
}

// The revision the measured bundle was built from. Every renderer build empties
// dist/renderer, so the stamp written after the runner's own build cannot
// outlive a later rebuild; a bundle built some other way reads as unknown.
const buildStamp = path.join(repositoryRoot, "dist", "renderer", ".budget-revision");
let rendererRevision;
if (options["skip-build"]) {
  rendererRevision = fs.existsSync(buildStamp) ? fs.readFileSync(buildStamp, "utf8").trim() : "unknown";
} else {
  buildRenderer();
  rendererRevision = sourceRevision();
  fs.writeFileSync(buildStamp, rendererRevision);
}

// First launch: open and index the project, so later launches restore it the
// way a returning user's window does.
const fixture = writeBudgetProject(projectDirectory);
const prime = await launchApp({ workDirectory, renderer: "build", ownHost: true });
try {
  await prime.openProject(projectDirectory);
  if (!(await waitForIndex(prime, fixture.markdownFiles, 180_000))) {
    console.warn(`Indexing did not finish; see ${prime.logDirectory}.`);
  }
} finally {
  await prime.stop();
}
fs.rmSync(primedProfile, { recursive: true, force: true });
fs.cpSync(profileDirectory, primedProfile, { recursive: true });

const results = [];
for (let runNumber = 1; runNumber <= options.runs; runNumber++) {
  const result = await run(runNumber, fixture);
  fs.appendFileSync(resultsFile, `${JSON.stringify(result)}\n`);
  results.push(result);
  console.log(`${options.label} #${runNumber} done`);
}
console.log("");
report(results);
console.log(`Results appended to ${resultsFile}`);
