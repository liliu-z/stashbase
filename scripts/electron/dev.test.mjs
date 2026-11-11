import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
