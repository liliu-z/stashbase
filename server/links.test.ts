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

test('angle-bracket destinations follow a rename and keep their form', async () => {
  assert.equal(
    await rewrittenIndex('[c](<My Note.md> "Title")\n![i](<img/old pic.png>)\n', ['My Note.md'], { kind: 'file', old: 'My Note.md', new: 'Final <v2> Note.md' }),
    '[c](<Final %3Cv2%3E Note.md> "Title")\n![i](<img/old pic.png>)\n',
  );
});

test('single-quoted and parenthesised titles no longer hide a link from a rename', async () => {
  assert.equal(
    await rewrittenIndex("[e](other.md 'Title')\n[p](other.md (Title))\n", ['other.md'], { kind: 'file', old: 'other.md', new: 'next.md' }),
    "[e](next.md 'Title')\n[p](next.md (Title))\n",
  );
});

test('balanced parentheses in a destination are part of the path', async () => {
  assert.equal(
    await rewrittenIndex('[f](paren(1).md) and (see [g](paren(1).md))\n', ['paren(1).md'], { kind: 'file', old: 'paren(1).md', new: 'paren(2).md' }),
    '[f](paren%282%29.md) and (see [g](paren%282%29.md))\n',
  );
});

test('an HTML href may contain the other quote character', async () => {
  const root = fs.mkdtempSync(path.join(scratch, 'project-'));
  fs.writeFileSync(path.join(root, 'page.html'), `<a href="It's.md">a</a><a href='say "hi".md'>b</a>`);
  fs.writeFileSync(path.join(root, "It's.md"), 'note');
  const plan = await runWithFolderRoot(root, () =>
    planRenameLinksAsync([{ kind: 'file', old: "It's.md", new: 'Final.md' }]));
  assert.equal(plan[0]?.newContent, `<a href="Final.md">a</a><a href='say "hi".md'>b</a>`);
});


test('rename preserves literal link examples inside inline, fenced and indented code', async () => {
  const literals = [
    String.raw`\[example](<old.md>)`,
    '[example]\\(<old.md>)',
    '`[example](<old.md>)`',
    '``[example](old.md) ` more``',
    '~~~md\n[example](<old.md>)\n~~~',
    '```md\n[example](old.md)\n```',
    '    [example](<old.md>)',
    '> ```md\n> [example](<old.md>)\n> ```',
    '```md\n[example](<old.md>)',
  ];
  for (const literal of literals) {
    const input = '[live](<old.md>)\n\n' + literal + '\n';
    assert.equal(
      await rewrittenIndex(input, ['old.md'], { kind: 'file', old: 'old.md', new: 'new.md' }),
      '[live](<new.md>)\n\n' + literal + '\n',
    );
  }
});
