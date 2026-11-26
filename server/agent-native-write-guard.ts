/** Claude keeps its native write tools for requested files outside the
 * project. Inside it, text changes go through StashBase's versioned file
 * tools. A PreToolUse hook enforces that split: hooks run before Claude's
 * permission modes, so Edit and Auto cannot approve an in-project native
 * write first, and they also cover subagent tool calls. */
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { filesystemPath } from './filesystem-path.ts';

const NATIVE_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;
/** Bounds a chain of dangling links, like the OS's own symlink limit. */
const MAX_LINK_HOPS = 40;
// The native form also resolves Windows 8.3 names and on-disk letter case.
const realpathNative = promisify(fs.realpath.native);

const PROJECT_NATIVE_WRITE_REASON =
  'This path is inside the StashBase project. Use the StashBase MCP `edit_file` tool to change an existing project file or `write_file` to create one. Native write tools are only for requested files outside the project.';

/** Whether a native write tool's target resolves inside the bound project.
 * A relative target resolves against the tool's working directory. Links and
 * directory aliases are followed, so a path that only reaches the project
 * through them still counts, and one that leaves it does not. */
export async function nativeWriteTargetsProject(
  toolName: string,
  toolInput: unknown,
  project: string,
  cwd: string = project,
): Promise<boolean> {
  if (!(NATIVE_WRITE_TOOLS as readonly string[]).includes(toolName)) return false;
  const input = toolInput && typeof toolInput === 'object' ? toolInput as Record<string, unknown> : {};
  const raw = [input.file_path, input.notebook_path, input.path]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (!raw) return false;
  let target: string;
  try {
    target = filesystemPath.absolute(raw.trim(), cwd);
  } catch {
    return false;
  }
  const projectReal = await resolvedPath(project) ?? project;
  const targetReal = await resolvedPath(target) ?? target;
  return filesystemPath.containsAsync(projectReal, targetReal);
}

/** The realpath of the nearest existing ancestor plus the missing tail.
 * A dangling link is followed to where a write through it would land. */
async function resolvedPath(candidate: string, hops = 0): Promise<string | null> {
  let existing = candidate;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await realpathNative(existing), ...tail);
    } catch {
      try {
        if ((await fs.promises.lstat(existing)).isSymbolicLink()) {
          if (hops >= MAX_LINK_HOPS) return null;
          const link = path.resolve(path.dirname(existing), await fs.promises.readlink(existing));
          return resolvedPath(path.join(link, ...tail), hops + 1);
        }
      } catch { /* Missing: resolve its parent. */ }
      const parent = path.dirname(existing);
      if (parent === existing) return null;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** Deny in-project native writes; anything else continues through the
 * session's permission mode and approval callback unchanged. */
export function projectNativeWriteGuard(project: string): HookCallbackMatcher {
  return {
    matcher: NATIVE_WRITE_TOOLS.join('|'),
    hooks: [async (input): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : project;
      if (!await nativeWriteTargetsProject(input.tool_name, input.tool_input, project, cwd)) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: PROJECT_NATIVE_WRITE_REASON,
        },
      };
    }],
  };
}
