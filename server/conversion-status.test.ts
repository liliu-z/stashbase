import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const nodeRequire = createRequire(import.meta.url);

test('conversion progress and durable failures use filesystem path identity', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-status-path-'));
  const previousDataRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = temp;
  t.after(async () => {
    const { closeStateDb } = await import('./state-db.ts');
    closeStateDb();
    if (previousDataRoot == null) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousDataRoot;
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const source = process.platform === 'win32'
    ? 'C:/Users/Alice/Folder/Report.docx'
    : path.join(temp, 'Folder', 'Report.docx');
  const legacyVariant = process.platform === 'win32'
    ? 'c:\\users\\alice\\folder\\REPORT.docx'
    : `${temp}/Folder/../Folder/Report.docx`;
  const variant = process.platform === 'win32'
    ? 'c:\\users\\alice\\folder\\REPORT.docx'
    : source;
  const folderVariant = process.platform === 'win32'
    ? 'c:\\USERS\\ALICE\\FOLDER'
    : path.dirname(source);

  // Seed the pre-path_identity schema with two spellings of one logical path.
  // Startup migration must retain the newest spelling and the highest attempt
  // count before normal status operations begin.
  const stateDir = path.join(temp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const Database = nodeRequire('better-sqlite3') as new (filename: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): unknown };
    close(): void;
  };
  const legacyDb = new Database(path.join(stateDir, 'state.db'));
  legacyDb.exec(`
    CREATE TABLE conversions (
      path TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at TEXT NOT NULL,
      done_at TEXT
    )
  `);
  const insertLegacy = legacyDb.prepare(`
    INSERT INTO conversions (path, status, attempts, last_error, last_attempt_at, done_at)
    VALUES (?, 'failed', ?, ?, ?, NULL)
  `);
  insertLegacy.run(legacyVariant, 4, 'older spelling', '2026-01-01T00:00:00.000Z');
  insertLegacy.run(source, 2, 'newer spelling', '2026-02-01T00:00:00.000Z');
  legacyDb.close();

  const status = await import('./conversion-status.ts');

  status.markFailed(source, 'initial fixture failure');
  status.markInFlight(source);
  status.setProgress(variant, { phase: 'indexing' });
  assert.deepEqual(status.readProgress(source), { phase: 'indexing' });
  status.markFailed(variant, 'fixture failure');
  assert.equal(status.isPendingOrFailed(source), true);
  assert.equal(status.hasFailed(source), true);
  assert.equal(
    status.listFailed()[0]?.path,
    process.platform === 'win32' ? source : variant.replace(/\\/g, '/'),
  );
  assert.equal(status.listFailed()[0]?.entry.attempts, 6);

  status.markCancelled(source);
  assert.deepEqual(status.listFailed(), []);
  assert.equal(status.listPreparationProblems()[0]?.entry.status, 'cancelled');
  assert.equal(status.isPendingOrFailed(source), true);

  status.clearRecordsUnder(folderVariant);
  assert.equal(status.isPendingOrFailed(source), false);
  assert.deepEqual(status.listFailed(), []);
});
