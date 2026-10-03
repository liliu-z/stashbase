import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

interface EditableContents {
  replaceMisspelling(text: string): void;
}

interface Dictionary {
  addWordToSpellCheckerDictionary(word: string): boolean;
}

/**
 * The menu a right-click in editable text opens: spelling suggestions for a
 * misspelled word, then the standard edit commands. Chromium draws no menu of
 * its own in Electron, so without this a misspelling is underlined with no way
 * to correct it. Null where the page's own menu, or none, belongs.
 */
export function editableContextMenu(
  params: Pick<ContextMenuParams, 'dictionarySuggestions' | 'isEditable' | 'misspelledWord'>,
  contents: EditableContents,
  dictionary: Dictionary,
): MenuItemConstructorOptions[] | null {
  if (!params.isEditable) return null;
  const spelling: MenuItemConstructorOptions[] = [];
  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 6)) {
      spelling.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
    }
    if (spelling.length === 0) spelling.push({ enabled: false, label: 'No suggestions' });
    spelling.push(
      {
        label: 'Add to Dictionary',
        click: () => dictionary.addWordToSpellCheckerDictionary(params.misspelledWord),
      },
      { type: 'separator' },
    );
  }
  return [
    ...spelling,
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { type: 'separator' },
    { role: 'selectAll' },
  ];
}
