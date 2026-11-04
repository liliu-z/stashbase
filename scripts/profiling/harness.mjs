// Launches an isolated StashBase for profiling: the host and Electron with a
// debugging port, plus Vite for the development renderer. Scenario scripts
// drive the window through `app.window` and call `app.stop()` when they finish.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

import { connectToWindow } from "./cdp.mjs";
import { isolatedEnvironment } from "../testing/environment.ts";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const VITE_URL = "http://localhost:5173/";
// Electron serves the production renderer from dist/renderer on this origin.
const APP_ORIGIN = "app://renderer";

// Not hidden and not under /tmp: projects inside hidden directories index no
// files, and /tmp is RAM-backed with a small quota on some systems.
export function profilingDirectory(scenario) {
  const directory = path.join(repositoryRoot, "profiling.nosync", scenario);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export function parseArguments(argv, defaults) {
  const options = { ...defaults };
  for (let index = 0; index < argv.length; index++) {
    const [name, inline] = argv[index].replace(/^--/u, "").split("=", 2);
    if (!Object.hasOwn(defaults, name)) throw new Error(`Unknown option --${name}`);
    if (typeof defaults[name] === "boolean") options[name] = inline === undefined || inline === "true";
    else {
      const value = inline ?? argv[++index];
      options[name] = typeof defaults[name] === "number" ? Number(value) : value;
    }
  }
  return options;
}

export function sourceRevision() {
  const git = (...args) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
  return `${git("rev-parse", "--short", "HEAD")}${dirty ? "+dirty" : ""}`;
}

async function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function respond(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

async function waitUntil(check, timeoutMs, what, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`${what} exited with code ${child.exitCode}.`);
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
}

function startProcess(command, args, { env, log }) {
  const output = fs.openSync(log, "a");
  // Its own process group, so stopping it also stops its children.
  return spawn(command, args, {
    cwd: repositoryRoot,
    env,
    detached: true,
    stdio: ["ignore", output, output],
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  const timedOut = await Promise.race([exited.then(() => false), delay(10_000).then(() => true)]);
  if (timedOut) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Builds the production renderer into dist/renderer. */
export function buildRenderer() {
  execFileSync("pnpm", ["build:web"], { cwd: repositoryRoot, stdio: "inherit" });
}

/**
 * The host and Electron see a private HOME and XDG directories under
 * `workDirectory`, so the real project registry, settings, session, and index
 * are never read or written. Vite is shared: it only serves renderer sources.
 *
 * - `renderer: "build"` loads the production bundle in dist/renderer instead
 *   of Vite. Build it first with `buildRenderer()`.
 * - `ownHost` lets Electron start the host itself, as a normal launch does,
 *   instead of the harness starting it first.
 * - `fresh: false` keeps the profile from an earlier launch, so the window
 *   restores its last project.
 */
export async function launchApp({
  workDirectory,
  hostPort = 8190,
  debugPort = 9333,
  renderer = "dev",
  ownHost = false,
  fresh = true,
}) {
  for (const port of [hostPort, debugPort]) {
    if (!(await portIsFree(port))) {
      throw new Error(`Port ${port} is in use. Stop the other StashBase or profiling run first.`);
    }
  }

  const profileRoot = path.join(workDirectory, "profile");
  const logDirectory = path.join(workDirectory, "logs");
  if (fresh) fs.rmSync(profileRoot, { recursive: true, force: true });
  for (const directory of ["home", "data", "config"]) {
    fs.mkdirSync(path.join(profileRoot, directory), { recursive: true });
  }
  fs.mkdirSync(logDirectory, { recursive: true });

  const environment = isolatedEnvironment(profileRoot);
  if (renderer === "dev") environment.STASHBASE_DEV_VITE = "1";
  else delete environment.STASHBASE_DEV_VITE;
  delete environment.ELECTRON_RUN_AS_NODE;
  if (renderer === "build" && !fs.existsSync(path.join(repositoryRoot, "dist", "renderer", "index.html"))) {
    throw new Error("dist/renderer is missing. Run `pnpm build:web` first.");
  }

  const children = [];
  const stop = async () => {
    for (const child of children.reverse()) await stopProcess(child);
    children.length = 0;
  };

  try {
    // Main and preload load these generated modules even when Vite serves the renderer.
    execFileSync(process.execPath, ["scripts/electron/boundary.mjs"], { cwd: repositoryRoot, stdio: "ignore" });

    if (renderer === "dev" && !(await respond(VITE_URL))) {
      const vite = startProcess("pnpm", ["dev:web"], { env: process.env, log: path.join(logDirectory, "vite.log") });
      vite.vite = true;
      children.push(vite);
      await waitUntil(() => respond(VITE_URL), 120_000, "Vite on :5173", vite);
    }

    const hostOrigin = `http://127.0.0.1:${hostPort}`;
    const health = `${hostOrigin}/api/health`;
    if (!ownHost) {
      // Run with this Node rather than a version-manager shim. Electron reuses
      // a healthy host on its port instead of starting its own.
      const host = startProcess(process.execPath, ["--import", "tsx", "server/index.ts", `--port=${hostPort}`], {
        env: environment,
        log: path.join(logDirectory, "host.log"),
      });
      children.push(host);
      await waitUntil(() => respond(health), 60_000, `the host on :${hostPort}`, host);
    }

    const launchedAt = Date.now();
    const electron = startProcess(
      electronPath,
      [
        ".",
        `--port=${hostPort}`,
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${path.join(profileRoot, "config", "stashbase")}`,
      ],
      { env: environment, log: path.join(logDirectory, "electron.log") },
    );
    children.push(electron);
    // Vite is a development tool, not part of the app's footprint.
    const appPids = children.filter((child) => child.vite !== true).map((child) => child.pid);
    if (ownHost) await waitUntil(() => respond(health), 60_000, `the host on :${hostPort}`, electron);

    const origin = renderer === "dev" ? hostOrigin : APP_ORIGIN;
    const window = await connectToWindow({ debugPort, origin });

    // Absolute URL: the production renderer's origin is not the host.
    const openProject = async (projectPath) => {
      const status = await window.evaluate(
        `fetch('${hostOrigin}/api/projects/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: ${JSON.stringify(projectPath)} }) }).then((response) => response.status)`,
      );
      if (status !== 200) throw new Error(`Opening ${projectPath} returned HTTP ${status}.`);
      // The window stays on Welcome until it reloads.
      await window.reload();
    };

    return {
      window,
      origin,
      hostOrigin,
      launchedAt,
      // Process-group leaders. Every StashBase process descends from one.
      rootPids: appPids,
      profileRoot,
      logDirectory,
      openProject,
      sessionFile: path.join(profileRoot, "config", "stashbase", "workspace-session.json"),
      stop: async () => {
        window.close();
        await stop();
      },
    };
  } catch (error) {
    await stop();
    throw new Error(`${error.message}\nLogs: ${logDirectory}`, { cause: error });
  }
}
