import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TokenEstimation {
  charCount: number;
  estTokens: number;
}

export interface McpToolCallLogRecord {
  timestamp: string;
  toolName: string;
  args?: Record<string, unknown>;
  durationMs: number;
  charCount: number;
  estTokens: number;
  isDuplicateCall: boolean;
  isUnchangedFileReread: boolean;
  prettyPrintOverheadTokens: number;
  isError?: boolean;
}

export interface LogToolCallParams {
  toolName: string;
  args?: Record<string, unknown>;
  durationMs: number;
  textPayload: string;
  isError?: boolean;
}

/** In-memory state tracking within the running session. */
const seenToolCalls = new Set<string>();
const fileContentHashes = new Map<string, string>();

/** Fast heuristic token estimator: 1 token ≈ 4 characters. */
export function estimateTokens(text: string): TokenEstimation {
  const charCount = typeof text === 'string' ? text.length : 0;
  return {
    charCount,
    estTokens: Math.ceil(charCount / 4),
  };
}

/** Recursively sort object keys for deterministic argument comparison. */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const obj = value as Record<string, unknown>;
  // oxlint-disable-next-line unicorn/no-array-sort
  const keys = Object.keys(obj).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const key of keys) {
    sortedObj[key] = canonicalize(obj[key]);
  }
  return sortedObj;
}

/** Check if exact same toolName + canonicalized args have already been called. */
export function checkAndRecordDuplicateCall(toolName: string, args?: Record<string, unknown>): boolean {
  const normalizedArgs = canonicalize(args ?? {});
  const callKey = `${toolName}:${JSON.stringify(normalizedArgs)}`;
  if (seenToolCalls.has(callKey)) {
    return true;
  }
  seenToolCalls.add(callKey);
  return false;
}

/** For read_file, check if content has been read before with the same sha256 hash. */
export function checkAndRecordFileRead(
  toolName: string,
  args: Record<string, unknown> | undefined,
  textPayload: string,
  isError?: boolean,
): boolean {
  if (toolName !== 'read_file' || isError) {
    return false;
  }

  const rawPath = typeof args?.path === 'string' && args.path.trim()
    ? args.path.trim()
    : typeof args?.file_path === 'string' && args.file_path.trim()
      ? args.file_path.trim()
      : '';

  if (!rawPath) {
    return false;
  }

  const offset = args?.offset ?? 1;
  const limit = args?.limit ?? 'all';
  const normalizedPath = path.normalize(rawPath).replace(/\\/g, '/');
  const fileKey = `${normalizedPath}:${String(offset)}:${String(limit)}`;

  let contentToHash = textPayload;
  try {
    const parsed = JSON.parse(textPayload) as { content?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string') {
      contentToHash = parsed.content;
    }
  } catch {
    // If textPayload is not JSON, hash the raw text payload
  }

  const contentHash = crypto.createHash('sha256').update(contentToHash).digest('hex');
  const previousHash = fileContentHashes.get(fileKey);

  if (previousHash !== undefined && previousHash === contentHash) {
    return true;
  }

  fileContentHashes.set(fileKey, contentHash);
  return false;
}

/** Compute token difference between pretty-printed JSON (null, 2) and compact JSON. */
export function calculatePrettyPrintOverhead(textPayload: string, prettyTokens: number): number {
  if (!textPayload) return 0;
  try {
    const parsed = JSON.parse(textPayload);
    const compactText = JSON.stringify(parsed);
    const compactTokens = estimateTokens(compactText).estTokens;
    return Math.max(0, prettyTokens - compactTokens);
  } catch {
    return 0;
  }
}

/** Reset in-memory session tracking state (useful for tests or new sessions). */
export function resetSessionState(): void {
  seenToolCalls.clear();
  fileContentHashes.clear();
}

/** Find project root by checking STASHBASE_APP_ROOT or traversing up to package.json. */
export function findProjectRoot(startDir?: string): string {
  const envAppRoot = process.env.STASHBASE_APP_ROOT;
  if (envAppRoot && envAppRoot.trim()) {
    return path.resolve(envAppRoot.trim());
  }
  const baseDir = startDir ?? (typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : path.dirname(fileURLToPath(import.meta.url)));
  let dir = path.resolve(baseDir);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(process.cwd());
}

/** Get default or configured log file destination. */
export function getLogFilePath(startDir?: string): string {
  const envPath = process.env.STASHBASE_MCP_LOG_PATH;
  if (envPath && envPath.trim()) {
    return path.resolve(envPath.trim());
  }
  const projectRoot = findProjectRoot(startDir);
  return path.join(projectRoot, 'logs', 'mcp-token-baseline.jsonl');
}

/**
 * Log tool call metrics to the JSONL log file.
 * Guaranteed never to throw or crash the caller.
 */
export function logToolCall(params: LogToolCallParams): McpToolCallLogRecord | null {
  try {
    const { toolName, args, durationMs, textPayload, isError } = params;
    const { charCount, estTokens } = estimateTokens(textPayload);
    const isDuplicateCall = checkAndRecordDuplicateCall(toolName, args);
    const isUnchangedFileReread = checkAndRecordFileRead(toolName, args, textPayload, isError);
    const prettyPrintOverheadTokens = calculatePrettyPrintOverhead(textPayload, estTokens);

    const record: McpToolCallLogRecord = {
      timestamp: new Date().toISOString(),
      toolName,
      ...(args ? { args } : {}),
      durationMs,
      charCount,
      estTokens,
      isDuplicateCall,
      isUnchangedFileReread,
      prettyPrintOverheadTokens,
      ...(isError ? { isError: true } : {}),
    };

    const logFilePath = getLogFilePath();
    const logDir = path.dirname(logFilePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    fs.appendFileSync(logFilePath, JSON.stringify(record) + '\n', 'utf8');
    return record;
  } catch {
    // Logging errors must never crash the MCP tool call
    return null;
  }
}
