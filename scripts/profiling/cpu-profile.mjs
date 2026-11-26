// Records renderer CPU profiles and summarizes where the time went.
//
//   node scripts/profiling/cpu-profile.mjs <file.cpuprofile> [--top 25] [--callers <function>]
//
// Open the same file in Chrome DevTools (Performance → Load profile) for a
// flame chart.

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { parseArguments } from "./harness.mjs";

export async function startCpuProfile(window, { intervalMicroseconds = 200 } = {}) {
  await window.send("Profiler.enable");
  await window.send("Profiler.setSamplingInterval", { interval: intervalMicroseconds });
  await window.send("Profiler.start");
}

export async function stopCpuProfile(window, file) {
  const { profile } = await window.send("Profiler.stop");
  fs.writeFileSync(file, JSON.stringify(profile));
  return profile;
}

function frameName({ functionName, url, lineNumber }) {
  const source = url.replace(/^.*\/(node_modules\/\.vite\/deps|src)\//u, "").split("?")[0];
  return `${functionName || "(anonymous)"} ${source || "(native)"}:${lineNumber + 1}`;
}

function sampleTimes(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const samples = profile.samples.map((id, index) => ({ node: nodes.get(id), ms: (profile.timeDeltas[index] ?? 0) / 1000 }));
  return { nodes, parents, samples };
}

// Garbage collection is real work and stays in the function list.
const IDLE = new Set(["(idle)", "(program)"]);

/** Self time per function, busiest first. Idle and program time are reported separately. */
function selfTimes(profile, top = 25) {
  const { samples } = sampleTimes(profile);
  const totals = new Map();
  let idle = 0;
  let total = 0;
  for (const { node, ms } of samples) {
    total += ms;
    if (IDLE.has(node.callFrame.functionName)) {
      idle += ms;
      continue;
    }
    const name = frameName(node.callFrame);
    totals.set(name, (totals.get(name) ?? 0) + ms);
  }
  const functions = [...totals].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, ms]) => ({ name, ms }));
  return { totalMs: total, idleMs: idle, functions };
}

/** The heaviest caller chains (innermost first) that end in `functionName`. */
function callerChains(profile, functionName, { depth = 8, top = 5 } = {}) {
  const { nodes, parents, samples } = sampleTimes(profile);
  const chains = new Map();
  for (const { node, ms } of samples) {
    if (node.callFrame.functionName !== functionName) continue;
    const chain = [];
    for (let parent = parents.get(node.id); parent && chain.length < depth; parent = parents.get(parent)) {
      chain.push(frameName(nodes.get(parent).callFrame));
    }
    const key = chain.join("\n    ← ");
    chains.set(key, (chains.get(key) ?? 0) + ms);
  }
  return [...chains].sort((a, b) => b[1] - a[1]).slice(0, top).map(([chain, ms]) => ({ chain, ms }));
}

export function printSummary(profile, { top = 25, callers } = {}) {
  const { totalMs, idleMs, functions } = selfTimes(profile, top);
  console.log(`sampled ${totalMs.toFixed(0)} ms, idle ${idleMs.toFixed(0)} ms, busy ${(totalMs - idleMs).toFixed(0)} ms`);
  for (const { name, ms } of functions) console.log(`${ms.toFixed(0).padStart(7)} ms  ${name}`);
  const target = callers ?? functions[0]?.name.split(" ")[0];
  if (!target) return;
  console.log(`\nheaviest callers of ${target}:`);
  for (const { chain, ms } of callerChains(profile, target)) console.log(`${ms.toFixed(0).padStart(7)} ms  ${chain}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) throw new Error("Usage: cpu-profile.mjs <file.cpuprofile> [--top 25] [--callers <function>]");
  const options = parseArguments(rest, { top: 25, callers: "" });
  printSummary(JSON.parse(fs.readFileSync(file, "utf8")), { top: options.top, callers: options.callers || undefined });
}
