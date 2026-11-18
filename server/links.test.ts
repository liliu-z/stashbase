import './__tests__/isolated-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { runWithFolderRoot } from './folder.ts';
import { planRenameLinksAsync, type RenameEntry } from './links.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-links-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** Plans one rename in a fresh project and returns `index.md` as rewritten. */
async function rewrittenIndex(index: string, files: string[], rename: RenameEntry): Promise<string> {
  const root = fs.mkdtempSync(path.join(scratch, 'project-'));
  fs.writeFileSync(path.join(root, 'index.md'), index);
  for (const name of files) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), name);
  }
  return runWithFolderRoot(root, async () => {
    const plan = await planRenameLinksAsync([rename]);
    return plan.find((entry) => entry.fromName === 'index.md')?.newContent ?? index;
  });
}

test('a percent-encoded link follows its renamed target and stays a valid link', async () => {
  assert.equal(
    await rewrittenIndex('[a](My%20Note.md)\n', ['My Note.md'], { kind: 'file', old: 'My Note.md', new: 'Final Note.md' }),
    '[a](Final%20Note.md)\n',
  );
  assert.equal(
    await rewrittenIndex('[a](Old%20Folder/plan.md#goals)\n', ['Old Folder/plan.md'], { kind: 'folder', old: 'Old Folder', new: 'New Folder' }),
    '[a](New%20Folder/plan.md#goals)\n',
  );
});

test('renaming a plain link target to a spaced name writes an encoded destination', async () => {
  assert.equal(
    await rewrittenIndex('[h](plain.md "Title")\n<a href="plain.md">h</a>\n', ['plain.md'], { kind: 'file', old: 'plain.md', new: "Bob's (draft) #1.md" }),
    "[h](Bob's%20%28draft%29%20%231.md \"Title\")\n<a href=\"plain.md\">h</a>\n",
  );
});

test('non-ASCII names stay readable and encoded separators are not followed', async () => {
  assert.equal(
    await rewrittenIndex('[d](笔记.md)\n', ['笔记.md'], { kind: 'file', old: '笔记.md', new: '新 笔记.md' }),
    '[d](新%20笔记.md)\n',
  );
  // `a%2Fb.md` is not a link to `a/b.md` in the reader, so a rename of that
  // file must not touch it.
  assert.equal(
    await rewrittenIndex('[s](a%2Fb.md)\n', ['a/b.md'], { kind: 'file', old: 'a/b.md', new: 'a/c.md' }),
    '[s](a%2Fb.md)\n',
  );
});

test('HTML links decode before matching and escape their own delimiters when rewritten', async () => {
  const root = fs.mkdtempSync(path.join(scratch, 'project-'));
  fs.writeFileSync(path.join(root, 'page.html'), `<a href="My%20Note.md">n</a>`);
  fs.writeFileSync(path.join(root, 'My Note.md'), 'note');
  const plan = await runWithFolderRoot(root, () =>
    planRenameLinksAsync([{ kind: 'file', old: 'My Note.md', new: `It's done.md` }]));
  assert.equal(plan[0]?.newContent, `<a href="It%27s%20done.md">n</a>`);
});
