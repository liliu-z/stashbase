/**
 * CSV and TSV as a table, read in segments.
 *
 * One record reader owns the quoting rules for both passes over a file: a
 * scan that validates UTF-8 and remembers where every `CHECKPOINT_EVERY`th
 * record starts, and page reads that seek to the nearest checkpoint and decode
 * only the rows asked for. The file is never held whole, so a table far larger
 * than the text-editing ceiling still opens, and nothing here writes bytes.
 *
 * Quoting follows RFC 4180 as spreadsheet apps read it: a field that starts
 * with a quote runs to the matching quote, `""` inside it is one quote, and
 * delimiters and line breaks inside it are content. A quote anywhere else is
 * an ordinary character. Records end at LF, CRLF or a lone CR.
 */
import fs from 'node:fs';
import { MAX_TEXT_READ_BYTES } from './active-file-operations.ts';
import type { DelimitedTable, TableDelimiter, TableEncoding } from '../shared/protocols/http/files.ts';

const MAX_TABLE_BYTES = 512 * 1024 * 1024;
const MAX_TABLE_PAGE_ROWS = 500;
/** Excel's own column ceiling; wider records keep their first columns. */
const MAX_TABLE_COLUMNS = 16_384;
/** Excel's cell ceiling. A longer field is cut, visibly, with an ellipsis. */
const MAX_FIELD_CHARACTERS = 32_767;
const MAX_FIELD_BYTES = MAX_FIELD_CHARACTERS * 4;
const MAX_PAGE_CHARACTERS = 2_000_000;
const CHECKPOINT_EVERY = 256;
const SCAN_CHUNK_BYTES = 1024 * 1024;
const PAGE_CHUNK_BYTES = 256 * 1024;
const SAMPLE_BYTES = 64 * 1024;
const QUOTE = 0x22;
const CR = 0x0d;
const LF = 0x0a;
/** In order of preference when two split the sample equally well: a tab
 *  almost never appears inside a value, a comma often does. */
const DELIMITERS: readonly TableDelimiter[] = ['\t', ',', ';', '|'];

const enum State { FieldStart, Unquoted, Quoted, QuoteSeen, AfterCr }

/** Resumable across chunks: `push` may end anywhere, including inside a
 *  quoted field or between the CR and LF of one line break. With `collect`
 *  off it only counts fields, which is what the full-file scan needs. */
class RecordReader {
  collect = false;
  stopped = false;
  private state = State.FieldStart;
  private recordPending = true;
  private recordStart = 0;
  private fieldCount = 0;
  private fields: string[] = [];
  private pieces: Uint8Array[] = [];
  private fieldBytes = 0;
  private readonly decoder = new TextDecoder('utf-8');

  constructor(
    private readonly delimiter: number,
    private readonly onRecord: (fields: string[] | null, fieldCount: number, start: number) => void,
  ) {}

  push(chunk: Uint8Array, base: number): void {
    let runStart = this.state === State.Unquoted || this.state === State.Quoted ? 0 : -1;
    for (let i = 0; i < chunk.length && !this.stopped; i += 1) {
      const byte = chunk[i];
      if (this.state === State.AfterCr) {
        // CRLF is one line break; after a lone CR this byte starts the next record.
        this.state = State.FieldStart;
        if (byte === LF) continue;
      }
      switch (this.state) {
        case State.FieldStart:
          if (this.recordPending) {
            this.recordPending = false;
            this.recordStart = base + i;
          }
          if (byte === QUOTE) {
            this.state = State.Quoted;
            runStart = i + 1;
          } else if (byte === this.delimiter) {
            this.endField();
          } else if (byte === CR || byte === LF) {
            this.endField();
            this.endRecord(byte === CR);
          } else {
            this.state = State.Unquoted;
            runStart = i;
          }
          break;
        case State.Unquoted:
          if (byte === this.delimiter || byte === CR || byte === LF) {
            this.piece(chunk, runStart, i);
            runStart = -1;
            this.endField();
            if (byte === this.delimiter) this.state = State.FieldStart;
            else this.endRecord(byte === CR);
          }
          break;
        case State.Quoted:
          if (byte === QUOTE) {
            this.piece(chunk, runStart, i);
            runStart = -1;
            this.state = State.QuoteSeen;
          }
          break;
        case State.QuoteSeen:
          if (byte === QUOTE) {
            // `""`: the second quote is content and starts the next run.
            this.state = State.Quoted;
            runStart = i;
          } else if (byte === this.delimiter) {
            this.endField();
            this.state = State.FieldStart;
          } else if (byte === CR || byte === LF) {
            this.endField();
            this.endRecord(byte === CR);
          } else {
            // Text after a closing quote stays in the field, as spreadsheets read it.
            this.state = State.Unquoted;
            runStart = i;
          }
          break;
      }
    }
    if (runStart >= 0 && !this.stopped) this.piece(chunk, runStart, chunk.length);
  }

  /** The end of the file closes whatever record is open; a final line break
   *  does not add an empty record after it. */
  finish(): void {
    if (this.stopped) return;
    if (this.state === State.AfterCr) return;
    if (this.state === State.FieldStart && this.recordPending) return;
    this.endField();
    this.endRecord(false);
  }

  private piece(chunk: Uint8Array, start: number, end: number): void {
    if (!this.collect || end <= start || this.fieldBytes >= MAX_FIELD_BYTES) return;
    const slice = chunk.subarray(start, Math.min(end, start + MAX_FIELD_BYTES - this.fieldBytes));
    this.pieces.push(slice);
    this.fieldBytes += slice.length;
  }

  private endField(): void {
    this.fieldCount += 1;
    if (this.collect) {
      if (this.fieldCount <= MAX_TABLE_COLUMNS) this.fields.push(this.decodeField());
      this.pieces = [];
      this.fieldBytes = 0;
    }
  }

  private decodeField(): string {
    if (this.pieces.length === 0) return '';
    const bytes = this.pieces.length === 1 ? this.pieces[0] : Buffer.concat(this.pieces);
    const value = this.decoder.decode(bytes);
    return value.length > MAX_FIELD_CHARACTERS || this.fieldBytes >= MAX_FIELD_BYTES
      ? `${value.slice(0, MAX_FIELD_CHARACTERS)}…`
      : value;
  }

  private endRecord(sawCr: boolean): void {
    const fields = this.collect ? this.fields : null;
    const count = this.fieldCount;
    this.fields = [];
    this.fieldCount = 0;
    this.state = sawCr ? State.AfterCr : State.FieldStart;
    this.recordPending = true;
    this.onRecord(fields, count, this.recordStart);
  }
}

interface TableIndex {
  readonly delimiter: TableDelimiter;
  readonly version: string;
  readonly size: number;
  readonly rowCount: number;
  readonly totalColumns: number;
  /** Byte offset of record `n * CHECKPOINT_EVERY`. */
  readonly checkpoints: readonly number[];
}

type TableProblem =
  | { kind: 'unsupported-encoding'; encoding: TableEncoding | null }
  | { kind: 'too-large'; size: number }
  | { kind: 'binary' };

/** One scan per file version, shared by every read that needs it. It stops
 *  once no read waits for it, so closing a large table ends its scan. */
interface SharedScan {
  readonly controller: AbortController;
  readonly result: Promise<TableIndex | TableProblem>;
  settled: boolean;
  waiting: number;
}

const indexes = new Map<string, SharedScan>();

function statVersion(st: fs.BigIntStats): string {
  return `stat:${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

function delimiterFor(name: string, sample: Uint8Array, complete: boolean): TableDelimiter {
  if (/\.tsv$/iu.test(name)) return '\t';
  // Score each candidate on the complete records in the sample: the one that
  // splits them into the same number of fields most often, then the widest.
  let best: { delimiter: TableDelimiter; consistency: number; width: number } | null = null;
  for (const delimiter of DELIMITERS) {
    const counts: number[] = [];
    const reader = new RecordReader(delimiter.charCodeAt(0), (_fields, count) => {
      counts.push(count);
      if (counts.length > 100) reader.stopped = true;
    });
    reader.push(sample, 0);
    // A sample cut short of the file's end may stop inside its last record.
    if (complete) reader.finish();
    else counts.pop();
    const tally = new Map<number, number>();
    for (const count of counts) if (count > 1) tally.set(count, (tally.get(count) ?? 0) + 1);
    let width = 0;
    let hits = 0;
    for (const [count, seen] of tally) {
      if (seen > hits || (seen === hits && count > width)) {
        width = count;
        hits = seen;
      }
    }
    const consistency = counts.length ? hits / counts.length : 0;
    if (
      width > 1 &&
      (!best || consistency > best.consistency || (consistency === best.consistency && width > best.width))
    ) {
      best = { consistency, delimiter, width };
    }
  }
  return best?.delimiter ?? ',';
}

/** What the bytes most likely are when they are not UTF-8, so the reader can
 *  be told how to re-save the file. A guess is offered only when it is strong. */
export function guessTableEncoding(sample: Uint8Array): TableEncoding | null {
  if (sample[0] === 0xff && sample[1] === 0xfe) return 'utf-16le';
  if (sample[0] === 0xfe && sample[1] === 0xff) return 'utf-16be';
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) {
      if (i % 2) oddZeros += 1;
      else evenZeros += 1;
    }
  }
  const half = sample.length / 2;
  if (half >= 2 && oddZeros / half > 0.3 && evenZeros / half < 0.05) return 'utf-16le';
  if (half >= 2 && evenZeros / half > 0.3 && oddZeros / half < 0.05) return 'utf-16be';
  try {
    // `stream` tolerates a character cut in two at the end of the sample.
    const text = new TextDecoder('gb18030', { fatal: true }).decode(sample, { stream: true });
    const wide = text.match(/[^\u0000-\u007f]/gu)?.length ?? 0;
    const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
    if (wide > 0 && han / wide > 0.6) return 'gb18030';
  } catch {
    // Either not GB18030 or a runtime without that decoder; offer no guess.
  }
  return null;
}

async function scanTable(target: string, name: string, signal: AbortSignal): Promise<TableIndex | TableProblem> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw Object.assign(new Error('path is not a file'), { status: 415 });
      const size = Number(before.size);
      if (size > MAX_TABLE_BYTES) return { kind: 'too-large', size };
      const sample = Buffer.alloc(Math.min(SAMPLE_BYTES, size));
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      const head = sample.subarray(0, bytesRead);
      if (head.includes(0)) {
        const encoding = guessTableEncoding(head);
        return encoding ? { kind: 'unsupported-encoding', encoding } : { kind: 'binary' };
      }
      const bom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
      const delimiter = delimiterFor(name, head.subarray(bom), bytesRead === size);
      const checkpoints: number[] = [];
      let rowCount = 0;
      let totalColumns = 0;
      const reader = new RecordReader(delimiter.charCodeAt(0), (_fields, count, start) => {
        if (rowCount % CHECKPOINT_EVERY === 0) checkpoints.push(start);
        rowCount += 1;
        if (count > totalColumns) totalColumns = count;
      });
      const utf8 = new TextDecoder('utf-8', { fatal: true });
      for (let offset = bom; offset < size; ) {
        signal.throwIfAborted();
        const chunk = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, size - offset));
        const read = (await handle.read(chunk, 0, chunk.length, offset)).bytesRead;
        if (!read) break;
        const bytes = chunk.subarray(0, read);
        try {
          utf8.decode(bytes, { stream: true });
        } catch {
          return { kind: 'unsupported-encoding', encoding: guessTableEncoding(offset === bom ? head : bytes) };
        }
        reader.push(bytes, offset);
        offset += read;
      }
      try {
        utf8.decode();
      } catch {
        return { kind: 'unsupported-encoding', encoding: null };
      }
      reader.finish();
      const after = await fs.promises.stat(target, { bigint: true });
      // A write during the scan leaves offsets that may not be record starts.
      if (statVersion(after) !== statVersion(before)) continue;
      return { checkpoints, delimiter, rowCount, size, totalColumns, version: statVersion(before) };
    } finally {
      await handle.close();
    }
  }
  throw Object.assign(new Error('The file kept changing while it was read. Retry when it is saved.'), {
    code: 'FILE_UNSTABLE',
    status: 409,
  });
}

async function tableIndex(target: string, name: string, signal?: AbortSignal): Promise<TableIndex | TableProblem> {
  const version = statVersion(await fs.promises.stat(target, { bigint: true }));
  const key = `${target}\0${version}`;
  let scan = indexes.get(key);
  if (!scan) {
    const controller = new AbortController();
    const created: SharedScan = { controller, result: scanTable(target, name, controller.signal), settled: false, waiting: 0 };
    created.result.then(
      () => { created.settled = true; },
      () => {
        created.settled = true;
        if (indexes.get(key) === created) indexes.delete(key);
      },
    );
    if (indexes.size >= 8) indexes.delete(indexes.keys().next().value!);
    indexes.set(key, created);
    scan = created;
  }
  const shared = scan;
  shared.waiting += 1;
  try {
    return await new Promise<TableIndex | TableProblem>((resolve, reject) => {
      const abort = () => reject(signal?.reason);
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      shared.result.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
    });
  } finally {
    shared.waiting -= 1;
    if (shared.waiting === 0 && !shared.settled && signal?.aborted) {
      if (indexes.get(key) === shared) indexes.delete(key);
      shared.controller.abort();
    }
  }
}

/** Rows `start`…`start + count` of the delimited file at `target`, with the
 *  table's shape. `name` is the label returned to the caller and the hint
 *  the TSV delimiter is chosen by. Fewer rows come back when the page would
 *  exceed the response budget; the caller asks again from where it ended. */
export async function readDelimitedTable(
  target: string,
  name: string,
  start: number,
  count: number,
  signal?: AbortSignal,
): Promise<DelimitedTable> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal?.throwIfAborted();
    const index = await tableIndex(target, name, signal);
    signal?.throwIfAborted();
    if (!('checkpoints' in index)) return { ...index, name };
    const page = await readPage(target, name, index, start, count, signal);
    if (page) return page;
  }
  throw Object.assign(new Error('The file kept changing while it was read. Retry when it is saved.'), {
    code: 'FILE_UNSTABLE',
    status: 409,
  });
}

/** One page against `index`, or null when the file changed since the scan. */
async function readPage(
  target: string,
  name: string,
  index: TableIndex,
  start: number,
  count: number,
  signal?: AbortSignal,
): Promise<DelimitedTable | null> {
  const first = Math.max(0, Math.min(start, index.rowCount));
  const wanted = Math.max(0, Math.min(count, MAX_TABLE_PAGE_ROWS, index.rowCount - first));
  const rows: string[][] = [];
  if (wanted > 0) {
    const checkpoint = Math.floor(first / CHECKPOINT_EVERY);
    let record = checkpoint * CHECKPOINT_EVERY;
    let characters = 0;
    const reader = new RecordReader(index.delimiter.charCodeAt(0), (fields) => {
      if (fields) {
        rows.push(fields);
        for (const field of fields) characters += field.length;
      }
      record += 1;
      reader.collect = record >= first;
      if (rows.length >= wanted || (rows.length > 0 && characters >= MAX_PAGE_CHARACTERS)) {
        reader.stopped = true;
      }
    });
    reader.collect = record >= first;
    const handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const current = await handle.stat({ bigint: true });
      if (statVersion(current) !== index.version) return null;
      let offset = index.checkpoints[checkpoint];
      while (!reader.stopped && offset < index.size) {
        signal?.throwIfAborted();
        const chunk = Buffer.alloc(Math.min(PAGE_CHUNK_BYTES, index.size - offset));
        const read = (await handle.read(chunk, 0, chunk.length, offset)).bytesRead;
        if (!read) break;
        reader.push(chunk.subarray(0, read), offset);
        offset += read;
      }
      reader.finish();
    } finally {
      await handle.close();
    }
  }
  return {
    columnCount: Math.min(index.totalColumns, MAX_TABLE_COLUMNS),
    delimiter: index.delimiter,
    editable: index.size <= MAX_TEXT_READ_BYTES,
    kind: 'table',
    name,
    rowCount: index.rowCount,
    rows,
    size: index.size,
    start: first,
    totalColumns: index.totalColumns,
    version: index.version,
  };
}
