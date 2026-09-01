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

/** The prompt is product content, not runtime implementation. Keeping it as
 * one packaged Markdown resource lets product changes edit the one thing the
 * user sees while every Adapter consumes the exact same bytes. */
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
}): AgentInstructionsStore {
  const pathsEqual = (left: string, right: string): boolean => {
    try { return io.equalPath(left, right); }
    catch { return false; }
  };

  function get(scope: AgentInstructionsScope): AgentInstructionsState {
    const config = io.read();
    const stored = storedFolders(config).find((entry) => pathsEqual(entry.path, scope.path))?.text;
    const text = readableText(stored);
    return text ? { scope, text, customized: true } : { scope, text: io.defaultText, customized: false };
  }

  function set(scope: AgentInstructionsScope, rawText: string): AgentInstructionsState {
    const text = normalizedInput(rawText);
    const config = io.readStrict();
    const retained = storedFolders(config).filter((entry) => !pathsEqual(entry.path, scope.path));
    if (text) retained.push({ path: scope.path, text });

    if (retained.length) config.agentInstructions = { folders: retained };
    else delete config.agentInstructions;
    io.write(config);
    return text ? { scope, text, customized: true } : { scope, text: io.defaultText, customized: false };
  }

  return { get, set };
}

const defaultAgentInstructions = readDefaultAgentInstructions();

const store = createAgentInstructionsStore({
  // Reads used while starting an Agent fail soft, matching other optional
  // preferences: a damaged config must not prevent Chat from opening.
  read: readAppConfig,
  // Writes fail closed so Save never replaces malformed config with defaults.
  readStrict: readAppConfigStrict,
  write: writeAppConfigStrict,
  equalPath: filesystemPath.equal,
  defaultText: defaultAgentInstructions,
});

export function getAgentInstructions(scope: AgentInstructionsScope): AgentInstructionsState {
  return store.get(scope);
}

export function setAgentInstructions(scope: AgentInstructionsScope, text: string): AgentInstructionsState {
  return store.set(scope, text);
}

/** Runtime-facing read. A Library Chat has no concrete working directory, so
 * it receives the same packaged default without inventing a Library-wide
 * customization scope. */
export function resolveAgentInstructions(folderPath: string | null): string {
  return folderPath
    ? store.get({ kind: 'folder', path: folderPath }).text
    : defaultAgentInstructions;
}
