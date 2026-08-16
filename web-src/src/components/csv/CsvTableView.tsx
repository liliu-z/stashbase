import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import DataEditor, {
  type GridCell,
  GridCellKind,
  type GridColumn,
  type Item,
  type Theme,
  type EditableGridCell,
  type GridSelection,
  CompactSelection,
} from '@glideapps/glide-data-grid';
import type { CsvSourceAnalysis } from './sourceModel';
import { Button } from '../ui/button';
import { PlusIcon, TrashIcon } from '../../icons';

import './glide-grid.css';

export interface CsvTableSessionState {
  selectedCell?: [number, number];
  columnWidths?: Record<number, number>;
}

export interface CsvTableViewProps {
  analysis: CsvSourceAnalysis;
  readOnly: boolean;
  onCellEdited: (col: number, row: number, value: string) => void;
  onPaste: (startCol: number, startRow: number, values: readonly (readonly string[])[]) => void;
  onRowInserted: (insertIndex: number) => void;
  onRowDeleted: (deleteIndex: number) => void;
  session: CsvTableSessionState;
  onSessionChange: (session: CsvTableSessionState) => void;
}

export function CsvTableView({
  analysis,
  readOnly,
  onCellEdited,
  onPaste,
  onRowInserted,
  onRowDeleted,
  session,
  onSessionChange,
}: CsvTableViewProps) {
  const [gridSelection, setGridSelection] = useState<GridSelection>(() => {
    if (session.selectedCell) {
      return {
        current: {
          cell: session.selectedCell,
          range: {
            x: session.selectedCell[0],
            y: session.selectedCell[1],
            width: 1,
            height: 1,
          },
          rangeStack: [],
        },
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
      };
    }
    return {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
    };
  });

  const [scale, setScale] = useState(1.0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setScale((prev) => {
          const delta = e.deltaY < 0 ? 0.1 : -0.1;
          const next = Math.min(2.0, Math.max(0.5, prev + delta));
          return Math.round(next * 10) / 10;
        });
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          setScale((prev) => Math.min(2.0, Math.round((prev + 0.1) * 10) / 10));
        } else if (e.key === '-') {
          e.preventDefault();
          setScale((prev) => Math.max(0.5, Math.round((prev - 0.1) * 10) / 10));
        } else if (e.key === '0') {
          e.preventDefault();
          setScale(1.0);
        }
      }
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      el.removeEventListener('wheel', handleWheel);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, []);

  const columns = useMemo<GridColumn[]>(() => {
    return analysis.columns.map((title, idx) => ({
      id: `col-${idx}`,
      title,
      width: Math.round((session.columnWidths?.[idx] ?? 120) * scale),
    }));
  }, [analysis.columns, session.columnWidths, scale]);

  const numRows = analysis.rows.length;

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      if (row >= analysis.rows.length) {
        return {
          kind: GridCellKind.Text,
          allowOverlay: !readOnly,
          displayData: '',
          data: '',
          allowWrapping: true,
        };
      }
      const rowSpan = analysis.rows[row];
      const cell = rowSpan.cells[col];
      const val = cell ? cell.value : '';
      return {
        kind: GridCellKind.Text,
        allowOverlay: !readOnly,
        displayData: val,
        data: val,
        allowWrapping: true,
      };
    },
    [analysis.rows, readOnly],
  );

  const handleCellEdited = useCallback(
    ([col, row]: Item, newValue: EditableGridCell) => {
      if (readOnly) return;
      const val = newValue.data != null ? String(newValue.data) : '';
      onCellEdited(col, row, val);
    },
    [readOnly, onCellEdited],
  );

  const handleGridSelectionChange = useCallback(
    (newSelection: GridSelection) => {
      setGridSelection(newSelection);
      const selected = newSelection.current?.cell;
      const curSelected = session.selectedCell;
      if (
        (!selected && !curSelected) ||
        (selected && curSelected && selected[0] === curSelected[0] && selected[1] === curSelected[1])
      ) {
        return;
      }
      onSessionChange({
        ...session,
        selectedCell: selected ? [selected[0], selected[1]] : undefined,
      });
    },
    [session, onSessionChange],
  );

  useEffect(() => {
    if (session.selectedCell) {
      const [col, row] = session.selectedCell;
      setGridSelection((prev) => {
        const cur = prev.current?.cell;
        if (cur && cur[0] === col && cur[1] === row) {
          return prev;
        }
        return {
          current: {
            cell: [col, row],
            range: { x: col, y: row, width: 1, height: 1 },
            rangeStack: [],
          },
          columns: CompactSelection.empty(),
          rows: CompactSelection.empty(),
        };
      });
    }
  }, [session.selectedCell]);

  const handleColumnResize = useCallback(
    (column: GridColumn, newSize: number, colIndex: number) => {
      const unscaledSize = Math.round(newSize / scale);
      onSessionChange({
        ...session,
        columnWidths: {
          ...(session.columnWidths ?? {}),
          [colIndex]: unscaledSize,
        },
      });
    },
    [session, onSessionChange, scale],
  );

  const handlePaste = useCallback(
    (target: Item, values: readonly (readonly string[])[]) => {
      if (readOnly) return false;
      onPaste(target[0], target[1], values);
      return true;
    },
    [readOnly, onPaste],
  );

  const [theme, setTheme] = useState<Partial<Theme>>(() => resolveGridTheme(scale));

  useEffect(() => {
    const updateTheme = () => setTheme(resolveGridTheme(scale));
    updateTheme();

    const observer = new MutationObserver(() => updateTheme());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style'],
    });

    const mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
    mediaQuery?.addEventListener?.('change', updateTheme);

    return () => {
      observer.disconnect();
      mediaQuery?.removeEventListener?.('change', updateTheme);
    };
  }, [scale]);

  const selectedRowIndex = gridSelection.current?.cell?.[1];

  return (
    <div className="flex h-full w-full flex-col overflow-hidden" ref={containerRef}>
      <div className="flex items-center gap-2 border-b border-border bg-pane px-3 py-1.5 text-xs">
        {!readOnly && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={() => onRowInserted(numRows)}
            >
              <PlusIcon className="size-3.5" />
              Add Row
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs text-destructive hover:text-destructive"
              disabled={selectedRowIndex === undefined || selectedRowIndex >= numRows}
              onClick={() => {
                if (selectedRowIndex !== undefined && selectedRowIndex < numRows) {
                  onRowDeleted(selectedRowIndex);
                }
              }}
            >
              <TrashIcon className="size-3.5" />
              Delete Row
            </Button>
          </>
        )}
        <span className="ml-auto text-muted-foreground select-none">
          Zoom {Math.round(scale * 100)}% | {numRows} row{numRows === 1 ? '' : 's'} × {analysis.maxColumns} column{analysis.maxColumns === 1 ? '' : 's'}
        </span>
      </div>
      <div className="relative h-full w-full flex-1 overflow-hidden">
        <DataEditor
          width="100%"
          height="100%"
          columns={columns}
          rows={numRows}
          getCellContent={getCellContent}
          onCellEdited={handleCellEdited}
          gridSelection={gridSelection}
          onGridSelectionChange={handleGridSelectionChange}
          onColumnResize={handleColumnResize}
          onPaste={handlePaste}
          onRowAppended={() => onRowInserted(numRows)}
          rowMarkers="number"
          theme={theme}
          smoothScrollX
          smoothScrollY
          isDraggable={false}
          getCellsForSelection
          rowHeight={Math.round(34 * scale)}
          headerHeight={Math.round(36 * scale)}
        />
      </div>
    </div>
  );
}

function resolveGridTheme(scale: number): Partial<Theme> {
  const baseFontSize = Math.round(13 * scale);
  const baseFontStyle = `${baseFontSize}px`;
  const headerFontStyle = `600 ${baseFontSize}px`;
  const markerFontStyle = `${Math.round(9 * scale)}px`;

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return {
      bgCell: '#ffffff',
      bgCellMedium: '#ffffff',
      bgHeader: '#f3f5f7',
      bgHeaderHasFocus: '#f3f5f7',
      bgHeaderHovered: '#eaedf0',
      textHeader: '#68737a',
      textHeaderSelected: '#202427',
      textDark: '#202427',
      textMedium: '#202427',
      textLight: '#68737a',
      accentColor: '#0891b2',
      accentLight: 'rgba(8, 145, 178, 0.15)',
      borderColor: '#d9e0e3',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      editorFontSize: `${baseFontSize}px`,
      baseFontStyle,
      headerFontStyle,
      markerFontStyle,
    };
  }

  const el = document.documentElement;
  const style = getComputedStyle(el);
  const dataTheme = el.getAttribute('data-theme');
  const isDark =
    dataTheme === 'dark' ||
    (!dataTheme && window.matchMedia?.('(prefers-color-scheme: dark)').matches);

  const getComputed = (name: string, fallback: string) => {
    let val = style.getPropertyValue(name).trim();
    if (!val) return fallback;
    while (val.startsWith('var(')) {
      const inner = val.slice(4, -1).trim();
      val = style.getPropertyValue(inner).trim();
    }
    return val || fallback;
  };

  const bgCell = getComputed('--surface-base', isDark ? '#1b1f22' : '#ffffff');
  const bgHeader = getComputed('--surface-sunken', isDark ? '#13181c' : '#f3f5f7');
  const textDark = getComputed('--text-primary', isDark ? '#edf2f3' : '#202427');
  const textMuted = getComputed('--text-secondary', isDark ? '#aab5ba' : '#68737a');
  const border = getComputed('--stroke-subtle', isDark ? '#39444a' : '#d9e0e3');
  const accent = getComputed('--accent', isDark ? '#22b8d8' : '#0891b2');

  return {
    bgCell,
    bgCellMedium: bgCell,
    bgHeader,
    bgHeaderHasFocus: bgHeader,
    bgHeaderHovered: isDark ? '#30383d' : '#eaedf0',
    textHeader: textMuted,
    textHeaderSelected: textDark,
    textDark,
    textMedium: textDark,
    textLight: textMuted,
    accentColor: accent,
    accentLight: isDark ? 'rgba(34, 184, 216, 0.2)' : 'rgba(8, 145, 178, 0.15)',
    borderColor: border,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    editorFontSize: `${baseFontSize}px`,
    baseFontStyle,
    headerFontStyle,
    markerFontStyle,
  };
}
