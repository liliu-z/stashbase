import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { spreadsheetPreviewSchema } from '../shared/protocols/http/files.ts';
import type { GenericFilePreview } from '../shared/project-files.ts';

type Workbook = Extract<GenericFilePreview, { kind: 'spreadsheet' }>['workbook'];
// Resolved on first parse, not at import: a server or MCP bundle that loads
// this module never fails to start over the parser.
let xlsxModule: string | null = null;
const cache = new Map<string, Workbook>();

export function isSpreadsheetFile(name: string): boolean {
  return /\.xlsx$/i.test(name) && !/(?:^|[/\\])~\$/.test(name);
}

// Resolve the installed parser explicitly, as DOCX does, so this worker works
// in both the source host and the bundled server. Only plain display strings
// cross the boundary; workbook HTML, links and formulas are never executed.
// Formula text is reported beside the value so readers can tell a saved
// result from a typed one.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { inflateRawSync } = require('node:zlib');
// The preview holds at most ROWS rows and COLUMNS columns of a worksheet.
// SheetJS is asked for only the rows shown, and the cells in them are counted
// from the XML first: a worker out of memory can abort the whole host.
const ROWS = 1000, COLUMNS = 64, CELL_BUDGET = 500000;
const tooLarge = () => new Error('This workbook is too large to preview. Open it in a spreadsheet app.');

/** The cells a worksheet's XML lists, whatever its <dimension> claims: their
 *  extent, how many lie in the first ROWS rows, and how many in the ROWS rows
 *  from the first cell. A cell without a reference follows the one before it. */
function scanCells(data) {
  const tag = /<(?:[\w.-]+:)?(row|c)\b([^>]*)>/g, ref = /\sr="([A-Za-z]*)(\d*)"/;
  const text = data.toString('latin1');
  const found = { cells: 0, early: 0, window: 0, firstRow: Infinity, lastRow: -1, firstColumn: Infinity, lastColumn: -1 };
  let row = -1, column = -1, start = -1;
  for (let match; (match = tag.exec(text)); ) {
    const at = ref.exec(match[2]);
    if (match[1] === 'row') {
      row = at && at[2] ? Number(at[2]) - 1 : row + 1;
      column = -1;
      continue;
    }
    if (at && at[1]) {
      column = 0;
      for (const letter of at[1].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
      column -= 1;
      row = Number(at[2]) - 1;
    } else column += 1;
    if (found.cells++ === 0) start = row;
    found.firstRow = Math.min(found.firstRow, row);
    found.lastRow = Math.max(found.lastRow, row);
    found.firstColumn = Math.min(found.firstColumn, column);
    found.lastColumn = Math.max(found.lastColumn, column);
    // A self-closed cell is formatting without a value; SheetJS creates none.
    if (match[2].endsWith('/')) continue;
    if (row < ROWS) found.early++;
    // Rows are listed in order; one out of order leaves no window to trust.
    if (row < start) found.window = Infinity;
    else if (row < start + ROWS) found.window++;
  }
  return found;
}

try {
  const bytes = Buffer.from(workerData.bytes);
  // Bound expansion before the parser inflates OOXML entries. SheetJS reads
  // the last end-of-directory record in the file, so that record must be the
  // one that ends the file; another inside its comment could list entries
  // this check never saw. ZIP64 and encrypted containers are not supported.
  let end = bytes.length - 4;
  const floor = Math.max(0, bytes.length - 22 - 65535);
  while (end >= floor && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < floor || end + 22 > bytes.length || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length
    || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10))
    throw new Error('This file is not a supported XLSX workbook.');
  const count = bytes.readUInt16LE(end + 10);
  const directoryStart = bytes.readUInt32LE(end + 16);
  const worksheets = new Map(), parts = new Map();
  let offset = directoryStart, expanded = 0;
  if (count > 10000) throw new Error('This workbook is too complex to preview.');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('This workbook is damaged or uses an unsupported archive format.');
    const uncompressed = bytes.readUInt32LE(offset + 24);
    const compressed = bytes.readUInt32LE(offset + 20);
    expanded += uncompressed;
    if (expanded > 64 * 1024 * 1024 || (bytes.readUInt16LE(offset + 8) & 1))
      throw new Error('This workbook is too large or encrypted. Open it in a spreadsheet app.');
    const local = bytes.readUInt32LE(offset + 42);
    if (local + 30 > directoryStart || bytes.readUInt32LE(local) !== 0x04034b50)
      throw new Error('This workbook archive is damaged.');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressed > directoryStart) throw new Error('This workbook archive is damaged.');
    const method = bytes.readUInt16LE(offset + 10);
    if (bytes.readUInt16LE(local + 8) !== method || ![0, 8].includes(method))
      throw new Error('This workbook uses unsupported archive compression.');
    // Check the actual expansion too: declared ZIP sizes alone cannot bound
    // a damaged or adversarial archive before SheetJS decompresses it.
    const packed = bytes.subarray(start, start + compressed);
    const unpacked = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, uncompressed) });
    if (unpacked.length !== uncompressed) throw new Error('This workbook archive is damaged.');
    const name = bytes.toString('utf8', offset + 46, offset + 46 + bytes.readUInt16LE(offset + 28)).toLowerCase();
    if (/^xl\/(?:worksheets|macrosheets)\/[^/]+\.xml$/.test(name)) worksheets.set(name, scanCells(unpacked));
    else if (name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels') parts.set(name, unpacked.toString('utf8'));
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  // SheetJS parses every worksheet, hidden ones too, up to the rows asked for.
  let early = 0;
  for (const found of worksheets.values()) early += found.early;
  if (early > CELL_BUDGET) throw tooLarge();
  // Each sheet's XML by workbook order, as its relationship names it.
  const targets = new Map();
  for (const [relationship] of (parts.get('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g)) {
    const id = /\sId="([^"]*)"/.exec(relationship)?.[1], target = /\sTarget="([^"]*)"/.exec(relationship)?.[1];
    if (id && target) targets.set(id, (target.startsWith('/') ? target.slice(1) : 'xl/' + target).toLowerCase());
  }
  const paths = [...(parts.get('xl/workbook.xml') ?? '').matchAll(/<(?:[\w.-]+:)?sheet\b[^>]*>/g)]
    .map(([sheet]) => targets.get(/\s[\w.-]+:id="([^"]*)"/.exec(sheet)?.[1]));
  const XLSX = require(workerData.xlsxModule);
  const read = (options) => XLSX.read(bytes, { type: 'buffer', cellHTML: false, cellFormula: true, dense: true, ...options });
  const book = read({ sheetRows: ROWS });
  if (!book.Workbook) throw new Error('This file is not an XLSX workbook.');
  const visible = book.SheetNames.map((name, index) => ({ name, index })).filter(({ index }) => !book.Workbook.Sheets?.[index]?.Hidden);
  let characters = 0, hasFormulas = false;
  const sheets = visible.slice(0, 20).map(({ name, index }) => {
    let sheet = book.Sheets[name], limit = ROWS;
    const found = worksheets.get(paths[index]);
    // The extent covers the declared range, the cells the XML lists and the
    // cells parsed, so a wrong <dimension> neither hides nor miscounts data.
    const range = { s: { r: Infinity, c: Infinity }, e: { r: -1, c: -1 } };
    const cover = (s, e) => {
      range.s = { r: Math.min(range.s.r, s.r), c: Math.min(range.s.c, s.c) };
      range.e = { r: Math.max(range.e.r, e.r), c: Math.max(range.e.c, e.c) };
    };
    const declared = sheet?.['!fullref'] ?? sheet?.['!ref'];
    if (declared) { const d = XLSX.utils.decode_range(declared); cover(d.s, d.e); }
    if (found?.cells) cover({ r: found.firstRow, c: found.firstColumn }, { r: found.lastRow, c: found.lastColumn });
    (sheet?.['!data'] ?? []).forEach((cells, r) => cells?.forEach((cell, c) => cell && cover({ r, c }, { r, c })));
    if (range.e.r < 0) return { name, firstRow: 0, firstColumn: 0, rowCount: 0, columnCount: 0, rows: [], formulas: [] };
    // A sheet whose cells start past the rows read is read again from there;
    // no cells precede its first, so the same bound holds.
    if (range.s.r >= limit && found?.cells) {
      if (found.window > CELL_BUDGET) throw tooLarge();
      limit = range.s.r + ROWS;
      sheet = read({ sheets: index, sheetRows: limit }).Sheets[name];
    }
    const rowCount = range.e.r - range.s.r + 1, columnCount = range.e.c - range.s.c + 1;
    const data = sheet?.['!data'] ?? [];
    const rows = [], formulas = [];
    for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + ROWS - 1, limit - 1); r++) {
      const row = [];
      for (let c = range.s.c; c <= Math.min(range.e.c, range.s.c + COLUMNS - 1); c++) {
        const cell = data[r]?.[c];
        if (cell?.f) {
          hasFormulas = true;
          if (formulas.length < 2000) {
            const formula = '=' + String(cell.f).slice(0, 8191);
            characters += formula.length;
            formulas.push({ row: r - range.s.r, column: c - range.s.c, formula });
          }
        }
        const value = !cell ? '' : cell.f && cell.v == null ? '=' + cell.f : XLSX.utils.format_cell(cell);
        characters += value.length;
        if (value.length > 32767 || characters > 1000000)
          throw new Error('This workbook contains too much text to preview. Open it in a spreadsheet app.');
        row.push(value);
      }
      rows.push(row);
    }
    return { name, firstRow: range.s.r, firstColumn: range.s.c, rowCount, columnCount, rows, formulas };
  });
  parentPort.postMessage({ workbook: { sheets, sheetCount: visible.length, hasFormulas } });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
`;

/** Parsing cannot block the host; cancellation terminates its worker. The small
 * content-keyed cache avoids reparsing unchanged files on document refresh. */
async function parseWorkbook(bytes: Buffer, signal?: AbortSignal): Promise<Workbook> {
  signal?.throwIfAborted();
  xlsxModule ??= createRequire(import.meta.url).resolve('xlsx');
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { bytes, xlsxModule },
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
  try {
    return await new Promise<Workbook>((resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new Error('Preview cancelled.'));
      const timer = setTimeout(() => reject(new Error('This workbook took too long to preview.')), 15_000);
      signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      worker.once('message', (message: { workbook?: unknown; error?: string }) => {
        cleanup();
        const parsed = spreadsheetPreviewSchema.safeParse(message.workbook);
        if (parsed.success) resolve(parsed.data);
        else reject(new Error(message.error ?? 'This workbook could not be read.'));
      });
      worker.once('error', (error) => { cleanup(); reject(error); });
      worker.once('exit', () => { cleanup(); reject(new Error('This workbook could not be read.')); });
    });
  } finally {
    await worker.terminate();
  }
}

/** Compound File Binary, the container Excel encrypts a workbook into and
 *  the older .xls format uses; it is not a ZIP, so it cannot be an XLSX. */
const COMPOUND_FILE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export async function spreadsheetFilePreview(bytes: Buffer, name: string, signal?: AbortSignal): Promise<GenericFilePreview> {
  signal?.throwIfAborted();
  if (bytes.subarray(0, COMPOUND_FILE.length).equals(COMPOUND_FILE)) {
    return {
      kind: 'invalid-spreadsheet', name, size: bytes.length,
      message: 'This workbook is password-protected or saved in the older Excel format. Open it in a spreadsheet app.',
    };
  }
  const version = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  try {
    let workbook = cache.get(version);
    if (!workbook) {
      workbook = await parseWorkbook(bytes, signal);
      signal?.throwIfAborted();
      if (cache.size >= 4) cache.delete(cache.keys().next().value!);
      cache.set(version, workbook);
    }
    return { kind: 'spreadsheet', name, size: bytes.length, version, workbook };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      kind: 'invalid-spreadsheet', name, size: bytes.length,
      message: error instanceof Error && /^This (workbook|file) /.test(error.message)
        ? error.message.slice(0, 500) : 'The workbook may be damaged or password-protected. Open it in a spreadsheet app.',
    };
  }
}

/** A1-style column letters for a zero-based column index. */
function spreadsheetColumnLabel(column: number): string {
  let label = '';
  for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  }
  return label;
}

const counted = (count: number, noun: string) => `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;

const tableCell = (value: string) => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');

/**
 * The workbook as an Agent reads it: what the preview shows, from the same
 * parse, as Markdown. Every sheet keeps its name, every column its letter and
 * every row its number, so a reply can point back at a cell. Row 1 usually
 * holds the column names. Anything the preview leaves out is stated, never
 * dropped silently.
 */
export function spreadsheetAgentText(name: string, workbook: Workbook): string {
  const lines = [
    `# ${name}`,
    '',
    `Worksheet values as saved in this XLSX file. ${counted(workbook.sheetCount, 'visible worksheet')}; hidden worksheets are not included.`,
  ];
  if (workbook.hasFormulas) {
    lines.push('Formula cells show the result saved in the file. StashBase did not recalculate them.');
  }
  if (workbook.sheetCount > workbook.sheets.length) {
    lines.push(`Only the first ${workbook.sheets.length} worksheets are included.`);
  }
  workbook.sheets.forEach((sheet, index) => {
    lines.push('', `## Sheet ${index + 1}: ${sheet.name}`, '');
    const columns = sheet.rows[0]?.length ?? 0;
    if (sheet.rows.length === 0 || columns === 0) {
      // Cells the preview could not reach are left out, not called empty.
      lines.push(sheet.rowCount === 0
        ? 'This worksheet is empty.'
        : `Rows ${sheet.firstRow + 1}–${sheet.firstRow + sheet.rowCount} of this sheet are not included.`);
      return;
    }
    const column = (offset: number) => spreadsheetColumnLabel(sheet.firstColumn + offset);
    const lastRow = sheet.firstRow + sheet.rows.length;
    lines.push(
      `Cells ${column(0)}${sheet.firstRow + 1}:${column(columns - 1)}${lastRow} (${counted(sheet.rowCount, 'row')} × ${counted(sheet.columnCount, 'column')} in the sheet).`,
    );
    if (sheet.rows.length < sheet.rowCount || columns < sheet.columnCount) {
      lines.push(
        `Only rows ${sheet.firstRow + 1}–${lastRow} and columns ${column(0)}–${column(columns - 1)} are included; the rest of this sheet is not.`,
      );
    }
    // Rows and columns keep their own numbers and letters, so leaving out the
    // empty ones costs no coordinates and keeps a sparse sheet readable.
    const kept = Array.from({ length: columns }, (_, offset) => offset).filter((offset) =>
      sheet.rows.some((row) => row[offset] !== ''),
    );
    const rows = sheet.rows
      .map((row, offset) => ({ number: sheet.firstRow + offset + 1, row }))
      .filter(({ row }) => kept.some((offset) => row[offset] !== ''));
    if (kept.length < columns || rows.length < sheet.rows.length) {
      lines.push('Empty rows and columns are not shown.');
    }
    if (rows.length === 0) {
      lines.push('', 'These cells hold no values.');
      return;
    }
    lines.push(
      '',
      `| Row | ${kept.map(column).join(' | ')} |`,
      `| --- |${' --- |'.repeat(kept.length)}`,
    );
    for (const { number, row } of rows) {
      lines.push(`| ${number} | ${kept.map((offset) => tableCell(row[offset])).join(' | ')} |`);
    }
    if (sheet.formulas.length > 0) {
      const shown = sheet.formulas.slice(0, 200).map(
        ({ row, column: offset, formula }) => `${column(offset)}${sheet.firstRow + row + 1} \`${formula}\``,
      );
      const more = sheet.formulas.length - shown.length;
      // The worker stops listing formulas at its own bound, so past it the count is a floor.
      const rest = more <= 0 ? '' : sheet.formulas.length >= 2000 ? `; and at least ${more} more` : `; and ${more} more`;
      lines.push('', `Formula cells (saved results, not recalculated): ${shown.join('; ')}${rest}.`);
    }
  });
  return `${lines.join('\n')}\n`;
}
