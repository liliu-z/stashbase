import { useEffect, useMemo, useRef, useState } from 'react';
import { commandDefinitions, rankCommandPalette, routeQuickAccess } from '../commandPalette';
import { rankQuickOpen } from '../quickOpen';
import { useApp } from '../store/AppContext';
import { openLibrarySearch } from './LibrarySearch';
import { openSettings } from './SettingsModal';
import {
  PICKER_EMPTY_ROW_CLASS,
  PICKER_LABEL_CLASS,
  PICKER_RESULTS_CLASS,
  PICKER_ROW_CLASS,
  PICKER_ROW_DETAIL_CLASS,
  PICKER_VEIL_CLASS,
  pickerPanelClass,
} from './pickerChrome';

let recentCommandIdsMemory: string[] = [];

/** Quick Open calls the sidebar's document-selection action, preserving its
 * save guards, folder-generation checks, and persistent-tab reuse. */
export default function ManagedQuickOpen({
  commandsOnly,
  onClose,
}: {
  commandsOnly: boolean;
  onClose: () => void;
}) {
  const { state, actions, activeTab } = useApp();
  const [query, setQuery] = useState(commandsOnly ? '>' : '');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const paths = useMemo(() => state.files.map((file) => file.name), [state.files]);
  const recentPaths = state.recentFilePaths;
  const [recentCommandIds, setRecentCommandIds] = useState<string[]>(() => recentCommandIdsMemory);
  const route = routeQuickAccess(query);
  const commandContext = {
    hasFolder: Boolean(state.folder),
    hasActiveTab: Boolean(state.activeTabId),
    // Out-of-folder or external tabs are read-only — keep Toggle Editing off the palette.
    activeFileIsMarkdown: activeTab?.file?.format === 'md' && !activeTab.file.folder && !activeTab.file.isExternal && !activeTab.file.isReadOnly,
  };
  const fileItems = useMemo(
    () => rankQuickOpen(paths, route.provider === 'files' ? route.query : '', recentPaths),
    [paths, recentPaths, route.provider, route.query],
  );
  const commands = useMemo(
    () => rankCommandPalette(commandDefinitions.filter((command) => command.available(commandContext)), route.query, recentCommandIds),
    [commandContext.activeFileIsMarkdown, commandContext.hasActiveTab, commandContext.hasFolder, recentCommandIds, route.query],
  );
  const itemCount = route.provider === 'files' ? fileItems.length : route.provider === 'commands' ? commands.length : 0;
  const close = () => { setQuery(''); setActive(0); onClose(); };
  const accept = (path: string) => { close(); void actions.selectFile(path); };
  const runCommand = (id: string) => {
    setRecentCommandIds((recent) => {
      const next = [id, ...recent.filter((candidate) => candidate !== id)];
      recentCommandIdsMemory = next;
      return next;
    });
    close();
    switch (id) {
      case 'document.new-note': void actions.newNote(); break;
      case 'document.save': void actions.flushSave(); break;
      case 'document.close-editor': void actions.closeActiveTab(); break;
      case 'document.toggle-editing': void actions.toggleEditMode(); break;
      case 'document.find': actions.openFind(); break;
      // rAF: the palette veil is still in the DOM this tick (React hasn't
      // flushed the close yet) and the search opener refuses to stack on
      // an open picker — defer one frame so the handoff isn't swallowed.
      case 'search.open': requestAnimationFrame(() => openLibrarySearch()); break;
      case 'agent.show-claude': actions.openAgent('claude'); break;
      case 'agent.show-codex': actions.openAgent('codex'); break;
      case 'settings.open': openSettings(); break;
    }
  };

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { if (active >= itemCount) setActive(Math.max(0, itemCount - 1)); }, [active, itemCount]);

  return <div className={`quick-open-veil ${PICKER_VEIL_CLASS}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className={pickerPanelClass('wide')} role="dialog" aria-label={route.provider === 'commands' ? 'Command Palette' : 'Quick Open'}>
      <input ref={inputRef} className="w-full border-0 border-b border-solid border-border bg-transparent px-3.75 py-3.25 [font-family:inherit] text-xl text-foreground outline-0 placeholder:text-placeholder" role="combobox" aria-autocomplete="list" aria-controls="quick-open-results" aria-expanded="true" aria-activedescendant={itemCount ? `quick-open-${active}` : undefined} placeholder={route.provider === 'commands' ? 'Type a command' : 'Search files by name or path'} value={query}
        onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(index + 1, itemCount - 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
          else if (event.key === 'Home') { event.preventDefault(); setActive(0); }
          else if (event.key === 'End') { event.preventDefault(); setActive(Math.max(0, itemCount - 1)); }
          else if (event.key === 'Enter' && route.provider === 'files' && fileItems[active]) { event.preventDefault(); accept(fileItems[active].path); }
          else if (event.key === 'Enter' && route.provider === 'commands' && commands[active]) { event.preventDefault(); runCommand(commands[active].id); }
        }} />
      <div className={PICKER_LABEL_CLASS}>{route.provider === 'files' ? (route.query.trim() ? 'Files' : 'Recent editors') : route.provider === 'commands' ? 'Commands' : 'Quick Access'}</div>
      <ul id="quick-open-results" className={PICKER_RESULTS_CLASS} role="listbox" aria-label="Quick Open results">
        {route.provider === 'files' && fileItems.map((item, index) => <li key={item.path} id={`quick-open-${index}`} role="option" aria-selected={index === active} className={PICKER_ROW_CLASS} onMouseMove={() => setActive(index)} onMouseDown={(event) => { event.preventDefault(); accept(item.path); }}><span>{item.basename}</span><small className={PICKER_ROW_DETAIL_CLASS}>{item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : 'Active Library'}</small></li>)}
        {route.provider === 'files' && fileItems.length === 0 && <li className={PICKER_EMPTY_ROW_CLASS} role="option" aria-disabled="true">{route.query.trim() ? 'No matching source files' : 'No recently used editors'}</li>}
        {route.provider === 'commands' && commands.map((command, index) => <li key={command.id} id={`quick-open-${index}`} role="option" aria-selected={index === active} className={PICKER_ROW_CLASS} onMouseMove={() => setActive(index)} onMouseDown={(event) => { event.preventDefault(); runCommand(command.id); }}><span>{command.label}</span><small className={PICKER_ROW_DETAIL_CLASS}>{command.shortcut ?? command.category}</small></li>)}
        {route.provider === 'commands' && commands.length === 0 && <li className={PICKER_EMPTY_ROW_CLASS} role="option" aria-disabled="true">No matching available commands</li>}
      </ul>
      {route.provider === 'help' && <div className="px-2.5 py-3.5 leading-normal text-muted-foreground [&_kbd]:[font-family:inherit] [&_kbd]:font-semibold [&_kbd]:text-foreground" role="note">Type a file name to open a source file, or <kbd>&gt;</kbd> to run a command. Cmd/Ctrl+Shift+P and F1 open commands directly.</div>}
    </div>
  </div>;
}
