import type { FindOptions } from '../../store/AppContext';

export type CsvDelimiter = ',' | ';' | '\t' | '|';
export type CsvLineEnding = '\r\n' | '\n' | '\r';

export interface CsvCellSpan {
  value: string;
  rawValue: string;
  isQuoted: boolean;
  start: number;
  end: number;
}

export interface CsvRowSpan {
  cells: CsvCellSpan[];
  start: number;
  end: number;
  lineEnding: CsvLineEnding | '';
}

export interface CsvSourceAnalysis {
  ok: boolean;
  error?: string;
  rows: CsvRowSpan[];
  columns: string[];
  maxColumns: number;
  delimiter: CsvDelimiter;
  hasBom: boolean;
  lineEnding: CsvLineEnding;
  byteLength: number;
}

const MAX_TABLE_BYTES = 10 * 1024 * 1024; // 10 MB

export function detectLineEnding(text: string): CsvLineEnding {
  if (text.includes('\r\n')) return '\r\n';
  if (text.includes('\r')) return '\r';
  return '\n';
}

export function detectDelimiter(text: string): CsvDelimiter {
  const clean = text.startsWith('\uFEFF') ? text.slice(1) : text;
  let inQuotes = false;
  let firstRecord = '';
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '"') {
      if (inQuotes && clean[i + 1] === '"') {
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
      firstRecord = clean.slice(0, i);
      break;
    }
  }
  if (!firstRecord) firstRecord = clean.slice(0, 4096);

  const counts: Record<CsvDelimiter, number> = {
    ',': 0,
    ';': 0,
    '\t': 0,
    '|': 0,
  };

  let quote = false;
  for (let i = 0; i < firstRecord.length; i++) {
    const ch = firstRecord[i];
    if (ch === '"') {
      if (quote && firstRecord[i + 1] === '"') i++;
      else quote = !quote;
    } else if (!quote) {
      if (ch === ',') counts[',']++;
      else if (ch === ';') counts[';']++;
      else if (ch === '\t') counts['\t']++;
      else if (ch === '|') counts['|']++;
    }
  }

  let bestDelim: CsvDelimiter = ',';
  let maxCount = -1;
  const delims: CsvDelimiter[] = [',', '\t', ';', '|'];
  for (const d of delims) {
    if (counts[d] > maxCount && counts[d] > 0) {
      maxCount = counts[d];
      bestDelim = d;
    }
  }
  return bestDelim;
}

export function analyzeCsvSource(source: string): CsvSourceAnalysis {
  const hasBom = source.startsWith('\uFEFF');
  const byteLength = new TextEncoder().encode(source).length;
  const lineEnding = detectLineEnding(source);
  const delimiter = detectDelimiter(source);

  if (byteLength > MAX_TABLE_BYTES) {
    return {
      ok: false,
      error: `File size (${(byteLength / (1024 * 1024)).toFixed(1)} MB) exceeds Table View limit of 10 MB. Use Source View.`,
      rows: [],
      columns: [],
      maxColumns: 0,
      delimiter,
      hasBom,
      lineEnding,
      byteLength,
    };
  }

  const text = hasBom ? source.slice(1) : source;
  const offsetBase = hasBom ? 1 : 0;

  const rows: CsvRowSpan[] = [];
  let rowStart = offsetBase;
  let cellStart = offsetBase;
  let inQuotes = false;
  let currentCells: CsvCellSpan[] = [];
  let cellRawChars: string[] = [];
  let maxCols = 0;

  for (let i = 0; i < text.length; i++) {
    const absIdx = offsetBase + i;
    const ch = text[i];

    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cellRawChars.push('""');
        i++;
      } else {
        inQuotes = !inQuotes;
        cellRawChars.push('"');
      }
    } else if (!inQuotes && ch === delimiter) {
      const rawVal = cellRawChars.join('');
      currentCells.push(parseCellSpan(rawVal, cellStart, absIdx));
      cellRawChars = [];
      cellStart = absIdx + 1;
    } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
      let rowEnding: CsvLineEnding = '\n';
      let nextI = i;
      if (ch === '\r' && text[i + 1] === '\n') {
        rowEnding = '\r\n';
        nextI = i + 1;
      } else if (ch === '\r') {
        rowEnding = '\r';
      }

      const rawVal = cellRawChars.join('');
      currentCells.push(parseCellSpan(rawVal, cellStart, absIdx));
      const rowEnd = offsetBase + nextI + 1;
      rows.push({
        cells: currentCells,
        start: rowStart,
        end: rowEnd,
        lineEnding: rowEnding,
      });

      if (currentCells.length > maxCols) maxCols = currentCells.length;

      currentCells = [];
      cellRawChars = [];
      i = nextI;
      rowStart = offsetBase + i + 1;
      cellStart = rowStart;
    } else {
      cellRawChars.push(ch);
    }
  }

  if (inQuotes) {
    return {
      ok: false,
      error: 'Unclosed quote detected in CSV source. Please fix in Source View.',
      rows: [],
      columns: [],
      maxColumns: 0,
      delimiter,
      hasBom,
      lineEnding,
      byteLength,
    };
  }

  if (cellRawChars.length > 0 || cellStart < source.length || rows.length === 0) {
    const rawVal = cellRawChars.join('');
    currentCells.push(parseCellSpan(rawVal, cellStart, source.length));
    rows.push({
      cells: currentCells,
      start: rowStart,
      end: source.length,
      lineEnding: '',
    });
    if (currentCells.length > maxCols) maxCols = currentCells.length;
  }

  const columns: string[] = [];
  for (let c = 0; c < maxCols; c++) {
    columns.push(toColumnHeader(c));
  }

  return {
    ok: true,
    rows,
    columns,
    maxColumns: maxCols,
    delimiter,
    hasBom,
    lineEnding,
    byteLength,
  };
}

function parseCellSpan(raw: string, start: number, end: number): CsvCellSpan {
  const isQuoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2;
  let val = raw;
  if (isQuoted) {
    val = raw.slice(1, -1).replace(/""/g, '"');
  }
  return {
    value: val,
    rawValue: raw,
    isQuoted,
    start,
    end,
  };
}

export function toColumnHeader(index: number): string {
  let title = '';
  let i = index;
  while (i >= 0) {
    title = String.fromCharCode((i % 26) + 65) + title;
    i = Math.floor(i / 26) - 1;
  }
  return title;
}

export function formatCellValue(value: string, delimiter: CsvDelimiter): string {
  const needsQuotes =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r');
  if (!needsQuotes) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function replaceCsvCell(
  source: string,
  analysis: CsvSourceAnalysis,
  col: number,
  row: number,
  nextValue: string,
): string {
  if (row < 0 || row >= analysis.rows.length) return source;
  const rowSpan = analysis.rows[row];
  const formatted = formatCellValue(nextValue, analysis.delimiter);

  if (col < rowSpan.cells.length) {
    const cell = rowSpan.cells[col];
    return source.slice(0, cell.start) + formatted + source.slice(cell.end);
  }

  // Column extends beyond row length - append missing delimiters
  const missingDelimiters = analysis.delimiter.repeat(col - rowSpan.cells.length);
  const insertPos = rowSpan.lineEnding ? rowSpan.end - rowSpan.lineEnding.length : rowSpan.end;
  return (
    source.slice(0, insertPos) +
    analysis.delimiter +
    missingDelimiters +
    formatted +
    source.slice(insertPos)
  );
}

export function insertCsvRow(
  source: string,
  analysis: CsvSourceAnalysis,
  insertIndex: number,
  values: string[] = [],
): string {
  const delim = analysis.delimiter;
  const le = analysis.lineEnding || '\n';
  const numCols = values.length > 0 ? values.length : Math.max(1, analysis.maxColumns);
  const rowCells: string[] = [];
  for (let c = 0; c < numCols; c++) {
    rowCells.push(formatCellValue(values[c] ?? '', delim));
  }
  const newRowText = rowCells.join(delim) + le;

  if (analysis.rows.length === 0) {
    return (analysis.hasBom ? '\uFEFF' : '') + newRowText;
  }

  if (insertIndex <= 0) {
    const startPos = analysis.hasBom ? 1 : 0;
    return source.slice(0, startPos) + newRowText + source.slice(startPos);
  }

  if (insertIndex >= analysis.rows.length) {
    const lastRow = analysis.rows[analysis.rows.length - 1];
    if (lastRow.lineEnding) {
      return source + newRowText;
    }
    return source + le + newRowText;
  }

  const targetRow = analysis.rows[insertIndex];
  return source.slice(0, targetRow.start) + newRowText + source.slice(targetRow.start);
}

export function deleteCsvRow(
  source: string,
  analysis: CsvSourceAnalysis,
  deleteIndex: number,
): string {
  if (deleteIndex < 0 || deleteIndex >= analysis.rows.length) return source;
  if (analysis.rows.length === 1) {
    return analysis.hasBom ? '\uFEFF' : '';
  }
  const row = analysis.rows[deleteIndex];
  return source.slice(0, row.start) + source.slice(row.end);
}

export function pasteCsvMatrix(
  source: string,
  analysis: CsvSourceAnalysis,
  startCol: number,
  startRow: number,
  matrix: readonly (readonly string[])[],
): string {
  if (matrix.length === 0) return source;

  let currentSource = source;
  let currentAnalysis = analysis;

  for (let r = 0; r < matrix.length; r++) {
    const targetRow = startRow + r;
    if (targetRow >= currentAnalysis.rows.length) {
      currentSource = insertCsvRow(currentSource, currentAnalysis, targetRow, []);
      currentAnalysis = analyzeCsvSource(currentSource);
      if (!currentAnalysis.ok) return currentSource;
    }

    const rowData = matrix[r];
    for (let c = rowData.length - 1; c >= 0; c--) {
      const targetCol = startCol + c;
      currentSource = replaceCsvCell(
        currentSource,
        currentAnalysis,
        targetCol,
        targetRow,
        rowData[c],
      );
      currentAnalysis = analyzeCsvSource(currentSource);
      if (!currentAnalysis.ok) return currentSource;
    }
  }

  return currentSource;
}

export function matchingCsvCells(
  analysis: CsvSourceAnalysis,
  query: string,
  options?: FindOptions,
): Array<{ col: number; row: number; start: number; end: number }> {
  if (!query || !analysis.ok) return [];

  const matches: Array<{ col: number; row: number; start: number; end: number }> = [];
  const caseSensitive = options?.caseSensitive ?? false;
  const wholeWord = options?.wholeWord ?? false;

  for (let r = 0; r < analysis.rows.length; r++) {
    const row = analysis.rows[r];
    for (let c = 0; c < row.cells.length; c++) {
      const cell = row.cells[c];
      if (textMatches(cell.value, query, caseSensitive, wholeWord)) {
        matches.push({
          col: c,
          row: r,
          start: cell.start,
          end: cell.end,
        });
      }
    }
  }

  return matches;
}

function textMatches(
  text: string,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
): boolean {
  if (!text) return false;
  const target = caseSensitive ? text : text.toLowerCase();
  const search = caseSensitive ? query : query.toLowerCase();

  if (!wholeWord) {
    return target.includes(search);
  }

  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(?<=^|[^\\p{L}\\p{N}_])${escaped}(?=[^\\p{L}\\p{N}_]|$)`, 'u');
  return regex.test(target);
}
