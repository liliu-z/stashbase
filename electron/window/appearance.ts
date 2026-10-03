import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { themeBackgrounds } from '../../shared/appearance-themes.ts';
import {
  normalizeAppearancePreferences,
} from '../../shared/protocols/http/appearance.ts';
import { RENDERER_APPEARANCE_ARGUMENT } from '../../shared/protocols/electron/runtime.ts';
import {
  type WindowAppearance,
  WINDOW_APPEARANCE_CHANNEL,
  WINDOW_LIFECYCLE_CAPABILITY,
  windowAppearanceResponseSchema,
  windowAppearanceSchema,
} from '../../shared/protocols/electron/window-lifecycle.ts';
import { authorizeSender, type SenderAuthorization } from '../project/dialog.ts';

interface NativeTheme {
  themeSource: WindowAppearance['theme'];
  readonly shouldUseDarkColors: boolean;
  on(event: 'updated', listener: () => void): unknown;
}

interface Spellchecker {
  readonly availableSpellCheckerLanguages: readonly string[];
  setSpellCheckerEnabled(enabled: boolean): void;
  setSpellCheckerLanguages(languages: string[]): void;
}

interface ThemedWindow {
  isDestroyed(): boolean;
  setBackgroundColor(color: string): void;
}

interface AppearanceFileSystem {
  readFileSync(file: string, encoding: 'utf8'): string;
  promises: {
    mkdir(directory: string, options: { recursive: true }): Promise<unknown>;
    rename(from: string, to: string): Promise<void>;
    writeFile(file: string, contents: string, encoding: 'utf8'): Promise<void>;
  };
}

export interface AppearanceDependencies extends SenderAuthorization {
  allWindows(): readonly ThemedWindow[];
  /** Main keeps its own copy because the server's settings are unreachable
   *  before the first window paints; every window re-sends what it applied,
   *  so a stale copy lasts at most one launch. */
  filePath: string;
  fileSystem?: AppearanceFileSystem;
  ipcMain: Pick<IpcMain, 'handle'>;
  nativeTheme: NativeTheme;
  platform: NodeJS.Platform;
  spellchecker: Spellchecker;
}

function readRemembered(
  filePath: string,
  fileSystem: AppearanceFileSystem,
): WindowAppearance | null {
  try {
    const parsed = windowAppearanceSchema.safeParse(
      JSON.parse(fileSystem.readFileSync(filePath, 'utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Makes the saved appearance reach what the stylesheet cannot: native chrome,
 * the window background shown before and around the page, the page's own
 * `prefers-color-scheme` (which follows `themeSource`), and the spellchecker.
 * The remembered record is also what a new window paints first.
 */
export function registerAppearance(dependencies: AppearanceDependencies) {
  const { filePath, nativeTheme, spellchecker } = dependencies;
  const fileSystem = dependencies.fileSystem ?? fs;
  let current = readRemembered(filePath, fileSystem);
  let backgrounds = themeBackgrounds('stashbase-light', 'stashbase-dark');

  const backgroundColor = () =>
    nativeTheme.shouldUseDarkColors ? backgrounds.dark : backgrounds.light;

  const repaint = () => {
    const color = backgroundColor();
    for (const window of dependencies.allWindows()) {
      if (!window.isDestroyed()) window.setBackgroundColor(color);
    }
  };

  const apply = (appearance: WindowAppearance) => {
    backgrounds = themeBackgrounds(appearance.lightTheme, appearance.darkTheme);
    spellchecker.setSpellCheckerEnabled(appearance.spellcheck);
    // macOS checks with the system's own language detection and has no
    // language list to choose from.
    if (dependencies.platform !== 'darwin') {
      const language = appearance.spellcheckLanguage;
      if (language && spellchecker.availableSpellCheckerLanguages.includes(language)) {
        spellchecker.setSpellCheckerLanguages([language]);
      }
    }
    if (nativeTheme.themeSource === appearance.theme) repaint();
    else nativeTheme.themeSource = appearance.theme;
  };

  nativeTheme.on('updated', repaint);
  if (current) apply(current);

  let writes = Promise.resolve();
  const remember = (appearance: WindowAppearance) => {
    writes = writes
      .then(async () => {
        await fileSystem.promises.mkdir(path.dirname(filePath), { recursive: true });
        const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
        await fileSystem.promises.writeFile(temporary, JSON.stringify(appearance), 'utf8');
        await fileSystem.promises.rename(temporary, filePath);
      })
      // swallowed: the copy only speeds up the next window's first paint.
      .catch(() => undefined);
    return writes;
  };

  dependencies.ipcMain.handle(
    WINDOW_APPEARANCE_CHANNEL,
    async (event: IpcMainInvokeEvent, rawRequest) => {
      const ok = windowAppearanceResponseSchema.parse({ ok: true });
      if (!authorizeSender(event, dependencies, WINDOW_LIFECYCLE_CAPABILITY)) return ok;
      const request = windowAppearanceSchema.safeParse(rawRequest);
      if (!request.success) return ok;
      const next = normalizeAppearancePreferences(request.data);
      if (current && JSON.stringify(current) === JSON.stringify(next)) return ok;
      current = next;
      apply(next);
      await remember(next);
      return ok;
    },
  );

  return {
    backgroundColor,
    /** The window argument that carries the remembered appearance, if any. */
    windowArguments(): string[] {
      return current ? [`${RENDERER_APPEARANCE_ARGUMENT}${JSON.stringify(current)}`] : [];
    },
  };
}
