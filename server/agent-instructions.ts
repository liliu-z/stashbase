import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentInstructionsScope,
  AgentInstructionsState,
} from '../shared/agent-instructions.ts';
import { MAX_AGENT_INSTRUCTIONS_LENGTH } from '../shared/agent-instructions.ts';
import {
  readAppConfig,
  readAppConfigStrict,
  writeAppConfigStrict,
  type AppConfigFile,
} from './app-config.ts';
import { filesystemPath } from './filesystem-path.ts';

interface StoredFolderInstructions {
  path: string;
  text: string;
}

export interface AgentInstructionsStore {
  get(scope: AgentInstructionsScope): AgentInstructionsState;
  set(scope: AgentInstructionsScope, text: string): AgentInstructionsState;
}

const RESOURCES_ROOT = process.env.STASHBASE_RESOURCES_PATH
  ? path.resolve(process.env.STASHBASE_RESOURCES_PATH)
  : process.env.STASHBASE_APP_ROOT
    ? path.resolve(process.env.STASHBASE_APP_ROOT)
    : path.resolve(import.meta.dirname, '..');

/** The prompts are product content, not runtime implementation. Keeping each
 * as one packaged Markdown resource lets product changes edit the one thing
 * the user sees while every Adapter consumes the exact same bytes. There are
 * two: `default.md` for folder Chats, `library.md` for Library-wide Chats —
 * a Chat with no working folder is oriented toward finding and starting
 * work, not maintaining one folder's Wiki. */
export function readDefaultAgentInstructions(
  file = path.join(RESOURCES_ROOT, 'assets', 'agent-instructions', 'default.md'),
): string {
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) throw new Error(`Default Agent Instructions are empty: ${file}`);
  if (text.length > MAX_AGENT_INSTRUCTIONS_LENGTH) {
    throw new Error(`Default Agent Instructions exceed ${MAX_AGENT_INSTRUCTIONS_LENGTH.toLocaleString('en-US')} characters: ${file}`);
  }
  return text;
}

export function readDefaultLibraryAgentInstructions(): string {
  return readDefaultAgentInstructions(
    path.join(RESOURCES_ROOT, 'assets', 'agent-instructions', 'library.md'),
  );
}

function readableText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, MAX_AGENT_INSTRUCTIONS_LENGTH).trim();
}

function normalizedInput(value: unknown): string {
  if (typeof value !== 'string') throw inputError('text must be a string');
  if (value.length > MAX_AGENT_INSTRUCTIONS_LENGTH) {
    throw inputError(`Agent Instructions must be ${MAX_AGENT_INSTRUCTIONS_LENGTH.toLocaleString('en-US')} characters or fewer`);
  }
  return value.trim();
}

function storedFolders(config: AppConfigFile): StoredFolderInstructions[] {
  const value: unknown = config.agentInstructions;
  const folders = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { folders?: unknown }).folders
    : undefined;
  if (!Array.isArray(folders)) return [];
  return folders.filter((entry): entry is StoredFolderInstructions => (
    !!entry
    && typeof entry === 'object'
    && typeof entry.path === 'string'
    && !!entry.path.trim()
    && typeof entry.text === 'string'
  ));
}

function storedLibrary(config: AppConfigFile): string {
  const value: unknown = config.agentInstructions;
  const library = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { library?: unknown }).library
    : undefined;
  return readableText(library);
}

function inputError(message: string): Error {
  const error = new Error(message) as Error & { code: string; status: number };
  error.code = 'INVALID_AGENT_INSTRUCTIONS';
  error.status = 400;
  return error;
}

/** One deep interface owns scope matching, defensive reads, clearing, and
 * config compaction. Callers never manipulate the persisted shape directly. */
export function createAgentInstructionsStore(io: {
  read(): AppConfigFile;
  readStrict(): AppConfigFile;
  write(config: AppConfigFile): void;
  equalPath(left: string, right: string): boolean;
  defaultText: string;
  defaultLibraryText: string;
}): AgentInstructionsStore {
  const pathsEqual = (left: string, right: string): boolean => {
    try { return io.equalPath(left, right); }
    catch { return false; }
  };

  const defaultFor = (scope: AgentInstructionsScope): string => (
    scope.kind === 'library' ? io.defaultLibraryText : io.defaultText
  );

  function get(scope: AgentInstructionsScope): AgentInstructionsState {
    const config = io.read();
    const text = scope.kind === 'library'
      ? storedLibrary(config)
      : readableText(storedFolders(config).find((entry) => pathsEqual(entry.path, scope.path))?.text);
    return text ? { scope, text, customized: true } : { scope, text: defaultFor(scope), customized: false };
  }

  function set(scope: AgentInstructionsScope, rawText: string): AgentInstructionsState {
    const text = normalizedInput(rawText);
    const config = io.readStrict();
    const folders = scope.kind === 'library'
      ? storedFolders(config)
      : storedFolders(config).filter((entry) => !pathsEqual(entry.path, scope.path));
    if (scope.kind === 'folder' && text) folders.push({ path: scope.path, text });
    const library = scope.kind === 'library' ? text : storedLibrary(config);

    if (folders.length || library) {
      config.agentInstructions = {
        ...(folders.length ? { folders } : {}),
        ...(library ? { library } : {}),
      };
    } else {
      delete config.agentInstructions;
    }
    io.write(config);
    return text ? { scope, text, customized: true } : { scope, text: defaultFor(scope), customized: false };
  }

  return { get, set };
}

const defaultAgentInstructions = readDefaultAgentInstructions();
const defaultLibraryInstructions = readDefaultLibraryAgentInstructions();

const store = createAgentInstructionsStore({
  // Reads used while starting an Agent fail soft, matching other optional
  // preferences: a damaged config must not prevent Chat from opening.
  read: readAppConfig,
  // Writes fail closed so Save never replaces malformed config with defaults.
  readStrict: readAppConfigStrict,
  write: writeAppConfigStrict,
  equalPath: filesystemPath.equal,
  defaultText: defaultAgentInstructions,
  defaultLibraryText: defaultLibraryInstructions,
});

export function getAgentInstructions(scope: AgentInstructionsScope): AgentInstructionsState {
  return store.get(scope);
}

export function setAgentInstructions(scope: AgentInstructionsScope, text: string): AgentInstructionsState {
  return store.set(scope, text);
}

/** Runtime-facing read. A Library Chat has no concrete working directory, so
 * it resolves the Library scope — its own packaged default, or the saved
 * Library-wide customization. */
export function resolveAgentInstructions(folderPath: string | null): string {
  return store.get(folderPath ? { kind: 'folder', path: folderPath } : { kind: 'library' }).text;
}
