// Production composer + Chromium audio capture + the real local speech worker.
// The fixture device is controlled; this does not prove a physical microphone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SPEECH_MODEL } from '../../server/speech/model-manifest.ts';
import { launchApp, parseArguments, profilingDirectory, repositoryRoot } from './harness.mjs';

const options = parseArguments(process.argv.slice(2), { model: '', 'no-sandbox': false, seconds: 8 });
if (!options.model) throw new Error('Pass --model /path/to/the/verified/model.gguf.');
if (!Number.isFinite(options.seconds) || options.seconds < 1) throw new Error('Pass a positive recording duration with --seconds.');
const workDirectory = profilingDirectory('speech-ui');
const project = path.join(workDirectory, 'empty-project');
fs.mkdirSync(project, { recursive: true });
const app = await launchApp({
  workDirectory, renderer: 'build',
  electronEntry: path.join(repositoryRoot, 'scripts/profiling/speech-desktop.cjs'),
  electronArguments: [
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.join(repositoryRoot, 'scripts/fixtures/speech/jfk.wav')}`,
    ...(options['no-sandbox'] ? ['--no-sandbox'] : []),
  ],
  prepareProfile(profile) {
    const models = path.join(profile, 'home', '.stashbase', 'speech', 'models');
    fs.mkdirSync(models, { recursive: true });
    const destination = path.join(models, `${SPEECH_MODEL.sha256}.gguf`);
    try { fs.linkSync(path.resolve(options.model), destination); }
    catch { fs.copyFileSync(path.resolve(options.model), destination, fs.constants.COPYFILE_FICLONE); }
  },
});
const { window } = app;
const editor = "document.querySelector('.cm-content')";
const mic = "document.querySelector('button[aria-label=\"Dictate in English\"]')";
const stop = "document.querySelector('button[aria-label=\"Stop recording\"]')";
try {
  await app.openProject(project);
  await window.waitFor(`Boolean(${editor})`, { what: 'the shared agent composer' });
  await window.waitFor(`${mic} && !${mic}.disabled`, { timeoutMs: 60_000, what: 'the verified voice model' });
  await window.evaluate(`${editor}.focus()`);
  await window.type('Keep this typed idea.', 0);
  fs.writeFileSync(path.join(workDirectory, 'idle.png'), await window.screenshot());
  await window.evaluate(`${mic}.click()`);
  await window.waitFor("Boolean(document.querySelector('[role=timer]'))", { what: 'microphone capture through the native permission boundary' });
  await delay(options.seconds * 1000);
  const elapsed = await window.evaluate("document.querySelector('[role=timer]')?.textContent");
  assert.ok(elapsed, 'capture must remain active until Stop');
  const [minutes, seconds] = elapsed.split(':').map(Number);
  assert.ok(minutes * 60 + seconds >= options.seconds - 2, 'the microphone must keep delivering audio throughout the recording');
  assert.equal(await window.evaluate(`${editor}.textContent`), 'Keep this typed idea.');
  assert.equal(await window.evaluate(`${editor}.getAttribute('contenteditable')`), 'false');
  assert.equal(await window.evaluate(`Boolean(${mic})`), false);
  fs.writeFileSync(path.join(workDirectory, 'recording.png'), await window.screenshot());
  const stoppedAt = performance.now();
  await window.evaluate(`${stop}.click()`);
  fs.writeFileSync(path.join(workDirectory, 'processing.png'), await window.screenshot());
  await window.waitFor(`${mic} && ${editor}.textContent.length > 30`, { timeoutMs: 180_000, what: 'a completed local transcript in the original draft' });
  const draft = await window.evaluate(`${editor}.textContent`);
  assert.ok(draft.startsWith('Keep this typed idea.'), 'the original draft must be preserved');
  assert.match(draft, /fellow Americans|country can do/iu);
  assert.equal(await window.evaluate("document.querySelector('[role=log]')?.textContent.includes('Keep this typed idea.') ?? false"), false, 'dictation must never send a message');
  fs.writeFileSync(path.join(workDirectory, 'completed.png'), await window.screenshot());
  const stopToDraftMs = performance.now() - stoppedAt;
  process.kill(app.rootPids[1], 'SIGUSR2');
  await window.waitFor("document.querySelector('[role=dialog]')?.textContent.includes('Discard voice work and close?')", { what: 'the native close discard decision' });
  fs.writeFileSync(path.join(workDirectory, 'close-confirmation.png'), await window.screenshot());
  await delay(6000); // Longer than the normal five-second save acknowledgement.
  await window.evaluate("[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Keep working').click()");
  await window.waitFor("!document.querySelector('[role=dialog]')", { what: 'return to the retained draft' });
  assert.equal(await window.evaluate(`${editor}.textContent`), draft);
  await window.evaluate("[...document.querySelectorAll('button')].find(button => button.textContent.trim().startsWith('Settings')).click()");
  await window.waitFor("[...document.querySelectorAll('button')].some(button => button.textContent.trim().startsWith('General'))", { what: 'Settings navigation' });
  await window.evaluate("[...document.querySelectorAll('button')].find(button => button.textContent.trim().startsWith('General')).click()");
  await window.waitFor("document.body.textContent.includes('Ready · Works offline on this computer')", { what: 'the compact voice typing Settings row' });
  fs.writeFileSync(path.join(workDirectory, 'settings.png'), await window.screenshot());
  console.log(JSON.stringify({ scenario: 'speech-ui', platform: process.platform, arch: process.arch, controlledAudio: true, complete: true, stopToDraftMs, draftPreserved: true, automaticallySent: false, nativeCloseKeptDraft: true, settingsReady: true }));
} catch (error) {
  fs.writeFileSync(path.join(workDirectory, 'failure.png'), await window.screenshot().catch(() => Buffer.alloc(0)));
  console.error(await window.evaluate("document.body.innerText.slice(-3000)").catch(() => 'The renderer is unavailable.'));
  console.error(await window.evaluate("[...document.querySelectorAll('.cm-content, [role=textbox], textarea')].map(element => element.outerHTML.slice(0, 1200))").catch(() => []));
  throw error;
} finally { await app.stop(); }
