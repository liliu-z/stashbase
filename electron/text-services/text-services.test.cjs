'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { editableContextMenu } = require('../../dist/electron/text-services/context-menu.cjs');
const { registerTextServices } = require('../../dist/electron/text-services/ipc.cjs');
const { listSystemFonts, parseFontFamilies } = require('../../dist/electron/text-services/system-fonts.cjs');

test('installed fonts are listed once, sorted, and only as names Settings can store', async () => {
  assert.deepEqual(
    parseFontFamilies('Zilla Slab\nInter\n.SF NS\n\ninter\nBad;Name\nInter\r\nIosevka Aile\n'),
    ['Inter', 'inter', 'Iosevka Aile', 'Zilla Slab'],
  );
  const calls = [];
  const families = await listSystemFonts('linux', async (command, args) => {
    calls.push([command, args]);
    return 'Noto Serif\nDejaVu Sans\n';
  });
  assert.deepEqual(families, ['DejaVu Sans', 'Noto Serif']);
  assert.deepEqual(calls, [['fc-list', ['--format=%{family[0]}\n']]]);
  assert.deepEqual(await listSystemFonts('aix', async () => 'Never Asked'), []);
});

function services({ capability = 'text.services', listFonts, languages = ['en-US', 'bad lang'] } = {}) {
  const handlers = new Map();
  const frame = { url: 'app://renderer/' };
  const webContents = { mainFrame: frame };
  const window = {};
  registerTextServices({
    BrowserWindow: { fromWebContents: (candidate) => (candidate === webContents ? window : null) },
    expectedOrigins: new Set(['app://renderer']),
    hasCapability: (_window, granted) => granted === capability,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    isLiveWindow: (candidate) => candidate === window,
    listFonts,
    spellcheckLanguages: () => languages,
  });
  const event = { sender: webContents, senderFrame: frame };
  return {
    fonts: () => handlers.get('text-services:fonts')(event),
    languages: () => handlers.get('text-services:spellcheck-languages')(event),
  };
}

test('the font list is enumerated once per session and a failure is retried', async () => {
  let calls = 0;
  const window = services({
    listFonts: async () => {
      calls += 1;
      if (calls === 1) throw new Error('fc-list missing');
      return ['Inter'];
    },
  });
  assert.equal((await window.fonts()).ok, false);
  assert.deepEqual(await window.fonts(), { ok: true, families: ['Inter'] });
  assert.deepEqual(await window.fonts(), { ok: true, families: ['Inter'] });
  assert.equal(calls, 2);
  assert.deepEqual(window.languages(), { ok: true, languages: ['en-US'] });
});

test('a window without the capability learns nothing about the system', async () => {
  let asked = false;
  const window = services({ capability: 'other', listFonts: async () => { asked = true; return []; } });
  assert.equal((await window.fonts()).ok, false);
  assert.equal(window.languages().ok, false);
  assert.equal(asked, false);
});

test('a misspelling offers its suggestions and the dictionary before the edit commands', () => {
  const replaced = [];
  const added = [];
  const menu = editableContextMenu(
    { dictionarySuggestions: ['their', 'there'], isEditable: true, misspelledWord: 'thier' },
    { replaceMisspelling: (word) => replaced.push(word) },
    { addWordToSpellCheckerDictionary: (word) => added.push(word) },
  );
  assert.deepEqual(menu.slice(0, 3).map((item) => item.label), ['their', 'there', 'Add to Dictionary']);
  menu[1].click();
  menu[2].click();
  assert.deepEqual(replaced, ['there']);
  assert.deepEqual(added, ['thier']);
  assert.deepEqual(menu.filter((item) => item.role).map((item) => item.role), ['cut', 'copy', 'paste', 'selectAll']);
  assert.equal(editableContextMenu({ dictionarySuggestions: [], isEditable: false, misspelledWord: '' }, {}, {}), null);
});
