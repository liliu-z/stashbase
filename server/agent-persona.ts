import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  DEFAULT_AGENT_PERSONA_ICON,
  isAgentPersonaIcon,
  isAgentPersonaId,
  MAX_AGENT_PERSONA_DESCRIPTION_LENGTH,
  MAX_AGENT_PERSONA_LENGTH,
  MAX_AGENT_PERSONA_NAME_LENGTH,
  type AgentPersona,
  type AgentPersonaInput,
} from '../shared/agent-persona.ts';
import { appDataRoot } from './local-data.ts';

/**
 * The reader's persona library and which persona each Chat runs under.
 *
 * Each persona is one Markdown file, `<id>.md`, in an app-owned directory:
 * frontmatter carries the name, description, icon, and Gallery origin, and the
 * body is the exact prompt a session receives. Nothing is written into a
 * project folder. The first read installs the packaged personas, so a reader
 * never starts from an empty list; deleting them later is the reader's choice
 * and they are not reinstalled.
 *
 * A Chat's persona is recorded against its native session id, the identity
 * history restores by. A Chat whose persona was deleted runs none.
 */
export interface AgentPersonaLibrary {
  list(): AgentPersona[];
  create(input: unknown): AgentPersona;
  update(id: string, input: unknown): AgentPersona;
  remove(id: string): void;
  /** The prompt a session starts with; empty for none or an unknown id. */
  prompt(id: string | null | undefined): string;
  recordChat(agent: string, sessionId: string, persona: string | null): void;
  /** The persona a Chat last ran under, when it still exists. */
  chatPersona(agent: string, sessionId: string): string | null;
  forgetChat(agent: string, sessionId: string): void;
}

const RESOURCES_ROOT = process.env.STASHBASE_RESOURCES_PATH
  ? path.resolve(process.env.STASHBASE_RESOURCES_PATH)
  : process.env.STASHBASE_APP_ROOT
    ? path.resolve(process.env.STASHBASE_APP_ROOT)
    : path.resolve(import.meta.dirname, '..');

export const PACKAGED_AGENT_PERSONAS_DIR = path.join(RESOURCES_ROOT, 'assets', 'agent-personas');

/** Bounded so the record cannot grow without limit; the oldest Chats fall
 * back to no persona first. */
const MAX_CHAT_RECORDS = 10_000;

type InputError = Error & { code: string; status: number };

function inputError(message: string, status = 400): InputError {
  const error = new Error(message) as InputError;
  error.code = status === 404 ? 'AGENT_PERSONA_NOT_FOUND' : 'INVALID_AGENT_PERSONA';
  error.status = status;
  return error;
}

function boundedLine(value: unknown, field: string, max: number, required: boolean): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw inputError(`${field} must be text`);
  const text = value.replace(/\s+/gu, ' ').trim();
  if (required && !text) throw inputError(`Give the persona a ${field}`);
  if (text.length > max) throw inputError(`A persona ${field} must be ${max} characters or fewer`);
  return text;
}

/** Validates what a reader wrote. Whitespace inside the prompt is the
 * reader's; only its ends are trimmed. */
export function normalizedPersonaInput(value: unknown): Required<AgentPersonaInput> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw inputError('A persona is required');
  const input = value as Record<string, unknown>;
  const name = boundedLine(input.name, 'name', MAX_AGENT_PERSONA_NAME_LENGTH, true);
  const description = boundedLine(input.description, 'description', MAX_AGENT_PERSONA_DESCRIPTION_LENGTH, false);
  if (input.icon !== undefined && !isAgentPersonaIcon(input.icon)) throw inputError('icon must name a persona icon');
  if (typeof input.prompt !== 'string') throw inputError('prompt must be text');
  if (input.prompt.length > MAX_AGENT_PERSONA_LENGTH) {
    throw inputError(`A persona must be ${MAX_AGENT_PERSONA_LENGTH.toLocaleString('en-US')} characters or fewer`);
  }
  const prompt = input.prompt.trim();
  if (!prompt) throw inputError('Write the persona before saving it');
  const gallery = input.gallery ?? null;
  if (gallery !== null && !isAgentPersonaId(gallery)) throw inputError('gallery must name a Gallery persona');
  return { name, description, icon: (input.icon as AgentPersona['icon'] | undefined) ?? DEFAULT_AGENT_PERSONA_ICON, prompt, gallery };
}

/** One file's persona, or null when it is not one. A hand-edited file reads
 * as the nearest valid persona; an unreadable one is left alone on disk and
 * simply not listed. */
export function parsePersonaFile(id: string, source: string): AgentPersona | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(source);
  let meta: Record<string, unknown> = {};
  let body = source;
  if (match) {
    try {
      const parsed: unknown = YAML.parse(match[1] ?? '');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    body = match[2] ?? '';
  }
  const prompt = body.trim().slice(0, MAX_AGENT_PERSONA_LENGTH);
  if (!prompt) return null;
  const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '';
  return {
    id,
    name: text(meta.name, MAX_AGENT_PERSONA_NAME_LENGTH) || id,
    description: text(meta.description, MAX_AGENT_PERSONA_DESCRIPTION_LENGTH),
    icon: isAgentPersonaIcon(meta.icon) ? meta.icon : DEFAULT_AGENT_PERSONA_ICON,
    prompt,
    gallery: isAgentPersonaId(meta.gallery) ? meta.gallery : null,
  };
}

export function serializePersona(persona: Omit<AgentPersona, 'id'>): string {
  const meta: Record<string, string> = { name: persona.name };
  if (persona.description) meta.description = persona.description;
  meta.icon = persona.icon;
  if (persona.gallery) meta.gallery = persona.gallery;
  return `---\n${YAML.stringify(meta).trimEnd()}\n---\n\n${persona.prompt}\n`;
}

/** A readable id from the name, made unique with a short suffix. Names in
 * scripts without a Latin slug still get a stable, safe id. */
function newId(name: string, taken: (id: string) => boolean): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60)
    .replace(/-+$/u, '') || 'persona';
  for (;;) {
    const id = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
    if (!taken(id)) return id;
  }
}

function writeAtomic(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, 'utf8');
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function createAgentPersonaLibrary(io: {
  /** The library directory; created and seeded on first read. */
  directory: string;
  /** The JSON file recording each Chat's persona. */
  chatsFile: string;
  /** Packaged personas installed into a new library. */
  packagedDirectory: string;
}): AgentPersonaLibrary {
  const fileOf = (id: string) => path.join(io.directory, `${id}.md`);

  function ensureSeeded(): void {
    if (fs.existsSync(io.directory)) return;
    // Seed into a sibling and rename, so a crash mid-copy never leaves a
    // half-installed library that the next start would treat as the reader's.
    const staging = `${io.directory}.${process.pid}.seed`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    for (const name of fs.readdirSync(io.packagedDirectory)) {
      const id = name.endsWith('.md') ? name.slice(0, -3) : '';
      if (!isAgentPersonaId(id)) continue;
      const persona = parsePersonaFile(id, fs.readFileSync(path.join(io.packagedDirectory, name), 'utf8'));
      if (persona) fs.writeFileSync(path.join(staging, name), serializePersona({ ...persona, gallery: persona.gallery ?? id }), 'utf8');
    }
    try {
      fs.renameSync(staging, io.directory);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      // Another process seeded first; its library wins.
      if (!fs.existsSync(io.directory)) throw error;
    }
  }

  function read(id: string): AgentPersona | null {
    if (!isAgentPersonaId(id)) return null;
    try {
      ensureSeeded();
      return parsePersonaFile(id, fs.readFileSync(fileOf(id), 'utf8'));
    } catch {
      return null;
    }
  }

  function list(): AgentPersona[] {
    ensureSeeded();
    const entries = fs.readdirSync(io.directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => {
        const id = entry.name.slice(0, -3);
        let created = 0;
        try { created = fs.statSync(path.join(io.directory, entry.name)).birthtimeMs; } catch { /* listed last */ }
        return { persona: read(id), created };
      })
      .filter((entry): entry is { persona: AgentPersona; created: number } => entry.persona !== null);
    // Oldest first: the packaged personas lead, and a new one joins the end.
    entries.sort((left, right) => left.created - right.created || left.persona.id.localeCompare(right.persona.id));
    return entries.map((entry) => entry.persona);
  }

  function create(value: unknown): AgentPersona {
    ensureSeeded();
    const input = normalizedPersonaInput(value);
    const id = newId(input.name, (candidate) => fs.existsSync(fileOf(candidate)));
    writeAtomic(fileOf(id), serializePersona(input));
    return { id, ...input };
  }

  function update(id: string, value: unknown): AgentPersona {
    const previous = read(id);
    if (!previous) throw inputError('That persona no longer exists', 404);
    const input = normalizedPersonaInput({ gallery: previous.gallery, ...(value as object) });
    writeAtomic(fileOf(id), serializePersona(input));
    return { id, ...input };
  }

  function remove(id: string): void {
    if (!read(id)) throw inputError('That persona no longer exists', 404);
    fs.rmSync(fileOf(id), { force: true });
  }

  function prompt(id: string | null | undefined): string {
    return id ? read(id)?.prompt ?? '' : '';
  }

  function readChats(): Record<string, string> {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(io.chatsFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => isAgentPersonaId(entry[1])));
    } catch {
      return {};
    }
  }

  const chatKey = (agent: string, sessionId: string) => `${agent}:${sessionId}`;

  function recordChat(agent: string, sessionId: string, persona: string | null): void {
    const chats = readChats();
    const key = chatKey(agent, sessionId);
    if ((chats[key] ?? null) === persona) return;
    delete chats[key];
    if (persona) chats[key] = persona;
    const entries = Object.entries(chats);
    writeAtomic(io.chatsFile, JSON.stringify(Object.fromEntries(entries.slice(-MAX_CHAT_RECORDS))));
  }

  function chatPersona(agent: string, sessionId: string): string | null {
    const id = readChats()[chatKey(agent, sessionId)];
    return id && read(id) ? id : null;
  }

  return {
    list,
    create,
    update,
    remove,
    prompt,
    recordChat,
    chatPersona,
    forgetChat: (agent, sessionId) => recordChat(agent, sessionId, null),
  };
}

let library: AgentPersonaLibrary | null = null;

/** The app's library, resolved lazily so tests and launches that set the
 * local data root before first use get their own. */
export function agentPersonaLibrary(): AgentPersonaLibrary {
  library ??= createAgentPersonaLibrary({
    directory: path.join(appDataRoot(), 'personas'),
    chatsFile: path.join(appDataRoot(), 'persona-chats.json'),
    packagedDirectory: PACKAGED_AGENT_PERSONAS_DIR,
  });
  return library;
}

/** Runtime-facing read: the prompt a session with this persona starts with. */
export function resolveAgentPersona(id: string | null | undefined): string {
  return agentPersonaLibrary().prompt(id);
}

/** Records which persona a Chat runs under, against the native session id
 * its runtime announces. Every runtime sends `{ t: 'session-id' }` once it
 * knows its id, so watching the socket is the one seam all of them share;
 * a resumed Chat is recorded up front because its id is already known.
 * A failed write leaves that Chat restoring with no persona, never a broken
 * session. */
export function trackChatPersona(
  ws: { send: (...args: never[]) => void },
  agent: string,
  options: { resume?: string; persona?: string },
  library: () => AgentPersonaLibrary = agentPersonaLibrary,
): void {
  const persona = options.persona ?? null;
  const record = (sessionId: string) => {
    try {
      library().recordChat(agent, sessionId, persona);
    } catch {
      // Best effort: the session itself runs whatever was recorded.
    }
  };
  if (options.resume) record(options.resume);
  let recorded = options.resume ?? null;
  const send = ws.send.bind(ws) as (...args: unknown[]) => void;
  ws.send = ((data: unknown, ...rest: unknown[]) => {
    send(data, ...rest);
    if (typeof data !== 'string' || !data.includes('"session-id"')) return;
    try {
      const message = JSON.parse(data) as { t?: unknown; id?: unknown };
      if (message.t === 'session-id' && typeof message.id === 'string' && message.id && message.id !== recorded) {
        recorded = message.id;
        record(message.id);
      }
    } catch {
      // Not a JSON frame; nothing to record.
    }
  }) as typeof ws.send;
}
