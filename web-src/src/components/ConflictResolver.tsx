import React, { useMemo } from 'react';
import { useApp } from '../store/AppContext';
import { computeLineDiff } from '../store/conflictDiff';
import { Button } from './ui/button';

export function ConflictResolver({ tabId }: { tabId: string }) {
  const { state, actions } = useApp();
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab?.conflict || !tab.file) return null;

  const { diskContent, editorContent } = tab.conflict;
  const fileName = tab.file.name;
  const resolving = tab.conflict.resolving === true;

  const diffRows = useMemo(() => {
    // Left = Disk (Newer version), Right = Editor (Your unsaved changes)
    return computeLineDiff(editorContent, diskContent);
  }, [diskContent, editorContent]);

  return (
    <div
      className="flex h-full flex-col bg-background text-foreground"
      role="region"
      aria-labelledby={`conflict-title-${tabId}`}
      aria-busy={resolving}
    >
      {/* Banner bar */}
      <div className="flex items-center justify-between border-b border-muted bg-accent/5 px-4 py-3 shrink-0">
        <div className="min-w-0 flex-1">
          <h3 id={`conflict-title-${tabId}`} className="text-sm font-semibold truncate text-foreground">
            Conflict detected in {fileName}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            This file has been modified on disk by another program or agent. Choose how to resolve the conflict.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-4">
          <Button
            variant="default"
            size="sm"
            disabled={resolving}
            onClick={() => void actions.resolveConflictReload(tabId)}
          >
            Reload from Disk
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={resolving}
            onClick={() => void actions.resolveConflictMerge(tabId)}
          >
            Merge and Edit
          </Button>
          <Button
            variant="destructive-outline"
            size="sm"
            disabled={resolving}
            onClick={() => void actions.resolveConflictOverwrite(tabId)}
          >
            Overwrite Disk
          </Button>
        </div>
      </div>

      {/* Comparison diff view */}
      <div className="flex-1 overflow-auto font-mono text-xs select-text">
        <table className="w-full border-collapse table-fixed min-w-[800px]">
          <thead>
            <tr className="sticky top-0 bg-muted/20 border-b border-muted font-sans font-semibold text-muted-foreground text-[10px] uppercase tracking-wider select-none">
              <th className="w-12 border-r border-muted/30 py-1.5 bg-background"></th>
              <th className="w-[calc(50%-24px)] text-left pl-3 py-1.5 bg-background">On Disk (Newer)</th>
              <th className="w-12 border-l border-muted border-r border-muted/30 py-1.5 bg-background"></th>
              <th className="w-[calc(50%-24px)] text-left pl-3 py-1.5 bg-background">Your Changes (Editor)</th>
            </tr>
          </thead>
          <tbody>
            {diffRows.map((row, idx) => {
              let leftBg = '';
              let rightBg = '';
              if (row.type === 'delete') {
                rightBg = 'bg-green-500/10 text-green-500';
              } else if (row.type === 'insert') {
                leftBg = 'bg-red-500/10 text-red-500';
              } else if (row.type === 'modify') {
                leftBg = 'bg-amber-500/10 text-amber-500';
                rightBg = 'bg-amber-500/10 text-amber-500';
              }

              return (
                <tr key={idx} className="border-b border-muted/10 hover:bg-muted/5 leading-relaxed">
                  {/* Left Line Num */}
                  <td className="w-12 select-none border-r border-muted/30 text-right pr-2 text-[10px] text-muted-foreground/60 py-0.5 font-light align-top bg-muted/5">
                    {row.diskLineNumber ?? ''}
                  </td>
                  {/* Left Content (Disk Version) */}
                  <td className={`pl-3 pr-2 py-0.5 whitespace-pre-wrap break-all align-top ${leftBg}`}>
                    {row.diskText ?? ''}
                  </td>
                  {/* Right Line Num */}
                  <td className="w-12 select-none border-l border-muted border-r border-muted/30 text-right pr-2 text-[10px] text-muted-foreground/60 py-0.5 font-light align-top bg-muted/5">
                    {row.editorLineNumber ?? ''}
                  </td>
                  {/* Right Content (Editor/Your Version) */}
                  <td className={`pl-3 pr-2 py-0.5 whitespace-pre-wrap break-all align-top ${rightBg}`}>
                    {row.editorText ?? ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
