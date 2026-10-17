#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getLogFilePath, type McpToolCallLogRecord } from '../mcp/token-logger.ts';

export interface ToolAggregateStats {
  toolName: string;
  calls: number;
  charCount: number;
  estTokens: number;
  duplicateCalls: number;
  unchangedReReads: number;
  wastedTokens: number;
  prettyPrintOverheadTokens: number;
  totalDurationMs: number;
}

export interface McpLogAnalysis {
  logPath: string;
  totalCalls: number;
  totalCharCount: number;
  totalEstTokens: number;
  totalDuplicateCalls: number;
  totalUnchangedReReads: number;
  totalWastedTokens: number;
  totalPrettyPrintOverheadTokens: number;
  avgDurationMs: number;
  tools: ToolAggregateStats[];
}

/** Parse lines from a JSONL MCP log file and aggregate stats. */
export function analyzeMcpLogLines(lines: string[], logPath = ''): McpLogAnalysis {
  const toolMap = new Map<string, ToolAggregateStats>();

  let totalCalls = 0;
  let totalCharCount = 0;
  let totalEstTokens = 0;
  let totalDuplicateCalls = 0;
  let totalUnchangedReReads = 0;
  let totalWastedTokens = 0;
  let totalPrettyPrintOverheadTokens = 0;
  let totalDurationMs = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let record: McpToolCallLogRecord;
    try {
      record = JSON.parse(line) as McpToolCallLogRecord;
    } catch {
      continue;
    }

    const {
      toolName = 'unknown',
      charCount = 0,
      estTokens = 0,
      isDuplicateCall = false,
      isUnchangedFileReread = false,
      prettyPrintOverheadTokens = 0,
      durationMs = 0,
    } = record;

    totalCalls += 1;
    totalCharCount += charCount;
    totalEstTokens += estTokens;
    totalDurationMs += durationMs;

    if (isDuplicateCall) totalDuplicateCalls += 1;
    if (isUnchangedFileReread) {
      totalUnchangedReReads += 1;
      totalWastedTokens += estTokens;
    }
    totalPrettyPrintOverheadTokens += prettyPrintOverheadTokens;

    const existing = toolMap.get(toolName) ?? {
      toolName,
      calls: 0,
      charCount: 0,
      estTokens: 0,
      duplicateCalls: 0,
      unchangedReReads: 0,
      wastedTokens: 0,
      prettyPrintOverheadTokens: 0,
      totalDurationMs: 0,
    };

    existing.calls += 1;
    existing.charCount += charCount;
    existing.estTokens += estTokens;
    if (isDuplicateCall) existing.duplicateCalls += 1;
    if (isUnchangedFileReread) {
      existing.unchangedReReads += 1;
      existing.wastedTokens += estTokens;
    }
    existing.prettyPrintOverheadTokens += prettyPrintOverheadTokens;
    existing.totalDurationMs += durationMs;

    toolMap.set(toolName, existing);
  }

  // oxlint-disable-next-line unicorn/no-array-sort
  const tools: ToolAggregateStats[] = Array.from(toolMap.values()).sort(
    (a: ToolAggregateStats, b: ToolAggregateStats) => b.estTokens - a.estTokens,
  );
  const avgDurationMs = totalCalls > 0 ? Math.round(totalDurationMs / totalCalls) : 0;

  return {
    logPath,
    totalCalls,
    totalCharCount,
    totalEstTokens,
    totalDuplicateCalls,
    totalUnchangedReReads,
    totalWastedTokens,
    totalPrettyPrintOverheadTokens,
    avgDurationMs,
    tools,
  };
}

function formatNumber(num: number): string {
  return num.toLocaleString('en-US');
}

/** Render a clean Markdown summary table from analysis results. */
export function formatSummaryMarkdown(analysis: McpLogAnalysis): string {
  const {
    logPath,
    totalCalls,
    totalCharCount,
    totalEstTokens,
    totalDuplicateCalls,
    totalUnchangedReReads,
    totalWastedTokens,
    totalPrettyPrintOverheadTokens,
    avgDurationMs,
    tools,
  } = analysis;

  if (totalCalls === 0) {
    return [
      '# MCP Token & Workflow Baseline Summary',
      '',
      `**Log File:** \`${logPath}\``,
      '',
      'No MCP tool calls recorded yet in this log file.',
    ].join('\n');
  }

  const prettyOverheadPct = totalEstTokens > 0
    ? ((totalPrettyPrintOverheadTokens / totalEstTokens) * 100).toFixed(1)
    : '0.0';

  const wastedPct = totalEstTokens > 0
    ? ((totalWastedTokens / totalEstTokens) * 100).toFixed(1)
    : '0.0';

  const rows: string[] = [
    '# MCP Token & Workflow Baseline Summary',
    '',
    `**Log File:** \`${logPath}\``,
    `**Total Calls Recorded:** ${formatNumber(totalCalls)}`,
    '',
    '## Tool Breakdown',
    '',
    '| Tool Name | Calls | Characters | Est. Tokens | Duplicates | Unchanged Re-reads | Pretty-Print Overhead | Avg Duration |',
    '| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const t of tools) {
    const avgDur = t.calls > 0 ? `${Math.round(t.totalDurationMs / t.calls)} ms` : '-';
    rows.push(
      `| \`${t.toolName}\` | ${formatNumber(t.calls)} | ${formatNumber(t.charCount)} | ${formatNumber(t.estTokens)} | ${formatNumber(t.duplicateCalls)} | ${formatNumber(t.unchangedReReads)} | ${formatNumber(t.prettyPrintOverheadTokens)} | ${avgDur} |`,
    );
  }

  rows.push(
    `| **Total** | **${formatNumber(totalCalls)}** | **${formatNumber(totalCharCount)}** | **${formatNumber(totalEstTokens)}** | **${formatNumber(totalDuplicateCalls)}** | **${formatNumber(totalUnchangedReReads)}** | **${formatNumber(totalPrettyPrintOverheadTokens)}** | **${avgDurationMs} ms** |`,
  );

  rows.push('');
  rows.push('## Key Efficiency & Waste Metrics');
  rows.push('');
  rows.push(`* **Duplicate Tool Calls:** ${formatNumber(totalDuplicateCalls)} call(s) with identical arguments`);
  rows.push(`* **Unchanged File Re-reads:** ${formatNumber(totalUnchangedReReads)} call(s)`);
  rows.push(`* **Wasted Tokens (Unchanged Re-reads):** ${formatNumber(totalWastedTokens)} tokens (${wastedPct}% of total response tokens)`);
  rows.push(`* **Pretty-Print JSON Overhead:** ${formatNumber(totalPrettyPrintOverheadTokens)} tokens (${prettyOverheadPct}% of total response tokens)`);

  return rows.join('\n');
}

/** Resolve target log file path from arguments, env, or defaults. */
export function resolveLogPath(): string {
  const customArgIndex = process.argv.indexOf('--file');
  if (customArgIndex !== -1 && process.argv[customArgIndex + 1]) {
    return path.resolve(process.argv[customArgIndex + 1]);
  }
  const positionalArg = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
  if (positionalArg) {
    return path.resolve(positionalArg);
  }
  return getLogFilePath();
}

function runCli(): void {
  const logPath = resolveLogPath();
  if (!fs.existsSync(logPath)) {
    console.log([
      '# MCP Token & Workflow Baseline Summary',
      '',
      `**Log File:** \`${logPath}\``,
      '',
      'Log file does not exist yet. Run some MCP tool calls or set `STASHBASE_MCP_LOG_PATH` to an existing log file.',
    ].join('\n'));
    return;
  }

  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  const analysis = analyzeMcpLogLines(lines, logPath);
  console.log(formatSummaryMarkdown(analysis));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli();
}
