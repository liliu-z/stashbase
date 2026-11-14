import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import electronPath from "electron";

const VITE_URL = "http://localhost:5173/";
const SERVER_HEALTH_URL = "http://127.0.0.1:8090/api/health";

export function developmentElectronEnvironment(baseEnvironment = process.env) {
  const environment = { ...baseEnvironment, STASHBASE_DEV_VITE: "1" };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

async function endpointIsReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForDevelopmentServers(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [viteReady, serverReady] = await Promise.all([
      endpointIsReady(VITE_URL),
      endpointIsReady(SERVER_HEALTH_URL),
    ]);
    if (viteReady && serverReady) return;
    await delay(100);
  }
  throw new Error(
    `Vite and the StashBase server did not become ready within ${timeoutMs} milliseconds.`,
  );
}

export async function runDevelopmentElectron() {
  // Main and preload load generated modules even when Vite serves the renderer.
  await import("./boundary.mjs");
  await waitForDevelopmentServers();
  await runForwardedChild(electronPath, ["."], developmentElectronEnvironment());
}

/** Runs one development child in this terminal, forwards Ctrl+C/termination
 * to it, and exits with its result so `concurrently -k` sees the real outcome. */
export async function runForwardedChild(command, args, env, stdio = "inherit") {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio,
  });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  process.removeListener("SIGINT", forwardSignal);
  process.removeListener("SIGTERM", forwardSignal);
  if (result.signal) process.kill(process.pid, result.signal);
  process.exitCode = result.code ?? 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runDevelopmentElectron();
}
