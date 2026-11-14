import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { developmentServerCommand } from "../dev-server.mjs";
import { developmentElectronEnvironment } from "./dev.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

function developmentFixture(context) {
  const root = mkdtempSync(path.join(os.tmpdir(), "stashbase-dev-launch-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (relativePath, source) => {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, source);
  };

  mkdirSync(path.join(root, "scripts/electron"), { recursive: true });
  for (const script of ["dev.mjs", "boundary.mjs", "entries.mjs"]) {
    copyFileSync(path.join(repositoryRoot, "scripts/electron", script), path.join(root, "scripts/electron", script));
  }
  for (const directory of ["electron", "server", "shared"]) {
    symlinkSync(path.join(repositoryRoot, directory), path.join(root, directory), "junction");
  }
  // Build the real sources, but use Node as the desktop child so this test
  // needs neither a display nor the developer's running servers/profile.
  write("node_modules/electron/index.js", "module.exports = process.execPath;\n");
  symlinkSync(path.dirname(require.resolve("esbuild/package.json")), path.join(root, "node_modules/esbuild"), "junction");
  write("package.json", JSON.stringify({ main: "desktop.cjs" }));
  write("desktop.cjs", `
    const assert = require('node:assert/strict');
    console.log('desktop child started');
    const appearance = require('./dist/electron/window/appearance.cjs');
    assert.equal(typeof appearance.registerAppearance, 'function');
    console.log('desktop boundary loaded');
  `);
  write("launch.mjs", `
    globalThis.fetch = async () => ({ ok: true });
    const { runDevelopmentElectron } = await import('./scripts/electron/dev.mjs');
    await runDevelopmentElectron();
  `);

  return {
    root,
    write,
    launch() {
      const result = spawnSync(process.execPath, ["launch.mjs"], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
      });
      assert.ifError(result.error);
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    },
  };
}

for (const output of ["missing", "stale"]) {
  test(`development startup rebuilds ${output} Electron modules before launching`, (context) => {
    const fixture = developmentFixture(context);
    if (output === "stale") {
      fixture.write("dist/electron/window/appearance.cjs", "throw new Error('stale boundary');\n");
    }

    const result = fixture.launch();

    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /desktop boundary loaded/u);
  });
}

test("a boundary build failure prevents development Electron from launching", (context) => {
  const fixture = developmentFixture(context);
  rmSync(path.join(fixture.root, "electron"));

  const result = fixture.launch();

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /Build failed/u);
  assert.doesNotMatch(result.output, /desktop child started/u);
});

test("the default development command includes the Electron host", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );

  assert.match(packageJson.scripts.dev, /npm:dev:desktop/u);
  assert.equal(packageJson.scripts["dev:desktop"], "node scripts/electron/dev.mjs");
});

test("the development Electron host enables Vite without inheriting embedded Node mode", () => {
  const environment = developmentElectronEnvironment({
    ELECTRON_RUN_AS_NODE: "1",
    EXISTING: "kept",
  });

  assert.equal(environment.STASHBASE_DEV_VITE, "1");
  assert.equal(environment.EXISTING, "kept");
  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
});

test("package scripts set environment variables in Node, not with a POSIX prefix", () => {
  // pnpm runs scripts through cmd.exe on Windows, where `NAME=value command`
  // is "not recognized as an internal or external command".
  const { scripts } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const prefixed = Object.entries(scripts)
    .filter(([, command]) => /(^|&&|\|\||;)\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s/u.test(command))
    .map(([name]) => name);
  assert.deepEqual(prefixed, []);
  assert.equal(scripts["dev:server"], "node scripts/dev-server.mjs");
});

test("the development server runs tsx watch directly with the Vite flag", (context) => {
  const { command, args, env, stdio } = developmentServerCommand({ EXISTING: "kept" });
  assert.equal(command, process.execPath);
  assert.deepEqual(args.slice(1), ["watch", "server/index.ts"]);
  assert.equal(env.STASHBASE_DEV_VITE, "1");
  assert.equal(env.EXISTING, "kept");
  // An inherited, never-written stdin pipe (as under `concurrently`) blocked
  // the watched server's startup on Windows.
  assert.equal(stdio[0], "ignore");

  // The resolved tsx CLI runs TypeScript and sees the flag without a shell,
  // including from a checkout path that contains spaces.
  const root = mkdtempSync(path.join(os.tmpdir(), "stashbase dev server "));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const probe = path.join(root, "probe.ts");
  writeFileSync(probe, "const flag: string | undefined = process.env.STASHBASE_DEV_VITE;\nconsole.log(`flag=${flag}`);\n");
  const result = spawnSync(command, [args[0], probe], { env, encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /flag=1/u);
});
