// Starts the hot-reloading host for `pnpm dev`. The Vite flag is set here,
// not as a `STASHBASE_DEV_VITE=1 tsx ...` prefix in package.json: pnpm runs
// scripts through cmd.exe on Windows, which cannot parse that prefix. Node
// runs tsx's CLI directly, so no shell has to quote a spaced checkout path.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { runForwardedChild } from "./electron/dev.mjs";

const require = createRequire(import.meta.url);

export function developmentServerCommand(baseEnvironment = process.env) {
  return {
    command: process.execPath,
    args: [require.resolve("tsx/cli"), "watch", "server/index.ts"],
    env: { ...baseEnvironment, STASHBASE_DEV_VITE: "1" },
    // No stdin, as Electron's own server launch does. `tsx watch` reads stdin
    // (Enter reruns) and its server child inherits the same handle. Under
    // `concurrently` that is a pipe nobody writes, and on Windows the child's
    // startup then blocks behind tsx's pending read, so the server never
    // listens. Output stays in this terminal.
    stdio: ["ignore", "inherit", "inherit"],
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { command, args, env, stdio } = developmentServerCommand();
  await runForwardedChild(command, args, env, stdio);
}
