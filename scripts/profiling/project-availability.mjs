// Controlled slow-storage scenario; no provider, indexer, or user Settings.
// Run with node --import tsx --import ./server/__tests__/isolated-home.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArguments, profilingDirectory } from './harness.mjs';
import { writeAppConfigStrict } from '../../server/app-config.ts';
import { exactRegisteredFolderRootAsync } from '../../server/folder.ts';
import { filesystemPath } from '../../server/filesystem-path.ts';
import { listScheduledProjects } from '../../server/scheduled-tasks.ts';

assert.ok(process.execArgv.some((arg) => arg.replaceAll('\\', '/').endsWith('/isolated-home.ts')), 'Use the isolated-home preload.');
const options = parseArguments(process.argv.slice(2), { label: 'after', runs: 2 });
const output = profilingDirectory('project-availability');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-project-availability-'));
const healthy = filesystemPath.absolute(path.join(root, 'healthy'));
const slow = filesystemPath.absolute(path.join(root, 'slow'));
for (const project of [slow, healthy]) {
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, '.schedules.json'), JSON.stringify({ tasks: [{ id: 'brief', name: 'Brief', time: '08:00', prompt: 'Write a brief.' }] }));
}
const stat = fs.promises.stat;
try {
  writeAppConfigStrict({ recentFolders: [slow, healthy].map((folder) => ({ path: folder, openedAt: new Date().toISOString() })) });
  for (let run = 1; run <= options.runs; run++) {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    fs.promises.stat = async function (file, ...args) {
      if (filesystemPath.absolute(String(file)) === slow) await held;
      return stat.call(this, file, ...args);
    };
    const started = performance.now();
    const lookup = exactRegisteredFolderRootAsync(healthy);
    let lookupMs = null;
    void lookup.then(() => { lookupMs = performance.now() - started; });
    await Promise.race([lookup, delay(400)]);
    const returnedWhileOtherProjectBlocked = lookupMs !== null;
    release();
    assert.equal(await lookup, healthy);
    fs.promises.stat = async function (file, ...args) {
      if (filesystemPath.absolute(String(file)) === slow) await delay(3000);
      return stat.call(this, file, ...args);
    };
    const listedAt = performance.now();
    const schedules = await listScheduledProjects();
    assert.ok(schedules.some((project) => project.folderPath === healthy && project.tasks.length === 1));
    const result = { scenario: 'project-availability', label: options.label, run,
      returnedWhileOtherProjectBlocked, lookupMs, listMs: performance.now() - listedAt,
      returnedProjects: schedules.length, injectedStatDelayMs: 3000 };
    fs.appendFileSync(path.join(output, 'results.jsonl'), JSON.stringify(result) + '\n');
    console.log(JSON.stringify(result));
    // Let the deliberately delayed filesystem call settle before the next run.
    fs.promises.stat = stat;
    await delay(3100 - Math.min(result.listMs, 3100));
  }
} finally {
  fs.promises.stat = stat;
  fs.rmSync(root, { recursive: true, force: true });
}
