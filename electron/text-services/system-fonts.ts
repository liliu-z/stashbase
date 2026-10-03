import { execFile } from 'node:child_process';

import { fontFamilySchema } from '../../shared/protocols/http/appearance.ts';

type Run = (command: string, args: readonly string[]) => Promise<string>;

/** Asks the operating system rather than Chromium's font access API, which
 *  needs a permission the application window is deliberately never granted. */
const COMMANDS: Partial<Record<NodeJS.Platform, readonly [string, readonly string[]]>> = {
  // Fontconfig is also what Chromium draws Linux text with, so the list
  // matches what the page can render.
  linux: ['fc-list', ['--format=%{family[0]}\n']],
  darwin: [
    'osascript',
    [
      '-l',
      'JavaScript',
      '-e',
      "ObjC.import('AppKit'); $.NSFontManager.sharedFontManager.availableFontFamilies.js.map((name) => name.js).join('\\n')",
    ],
  ],
  win32: [
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }',
    ],
  ],
};

const run: Run = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15_000, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/** Family names a reader could choose: sorted, unique, and only those the
 *  appearance schema can store. Names macOS hides (a leading dot) are the
 *  system's private UI fonts, not choices. */
export function parseFontFamilies(output: string): string[] {
  const families = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const name = line.trim();
    if (!name || name.startsWith('.')) continue;
    if (fontFamilySchema.safeParse(name).success) families.add(name);
  }
  return [...families].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

export function listSystemFonts(platform: NodeJS.Platform, runCommand: Run = run) {
  const command = COMMANDS[platform];
  if (!command) return Promise.resolve([]);
  return runCommand(command[0], command[1]).then(parseFontFamilies);
}
