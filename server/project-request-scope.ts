import { AsyncLocalStorage } from 'node:async_hooks';
import { attributedAgentSession, type AttributedAgentId } from './agent-session-registry.ts';
import { filesystemPath } from './filesystem-path.ts';
import { ProjectOperationError } from './project-operations/errors.ts';
import { writeDiagnosticEvidence, writeDiagnosticStep } from './write-diagnostic-context.ts';

// Absence is an external caller; null is an attributed Chat with no project.
const requestScope = new AsyncLocalStorage<{ folder: string | null; runtime: AttributedAgentId; turn_id?: string; runtime_version?: string }>();
const requestOrigin = new AsyncLocalStorage<'mcp' | 'http'>();

export function withAgentProjectScope<T>(sessionId: string | undefined, work: () => T, origin: 'mcp' | 'http' = 'http'): T {
  if (sessionId == null) return requestOrigin.run(origin, work);
  const session = attributedAgentSession(sessionId);
  if (!session) throw new ProjectOperationError('The Chat session is no longer available.', 409, 'SESSION_UNAVAILABLE');
  return requestScope.run({ folder: session.boundFolder(), runtime: session.agentId, ...session.diagnosticContext?.() }, work);
}

/** Transport hints never establish agent identity or change access. Only the
 * live session already accepted for project scope supplies a runtime. */
export function projectFileOperationOrigin(): { origin: 'agent' | 'mcp' | 'http'; runtime?: AttributedAgentId } {
  const session = requestScope.getStore();
  return session ? { origin: 'agent', runtime: session.runtime } : { origin: requestOrigin.getStore() ?? 'http' };
}

/** Snapshot only: never resolve a session again after an operation has failed. */
export function currentProjectDiagnosticScope(): { folder: string | null | undefined; runtime?: AttributedAgentId; turn_id?: string; runtime_version?: string } {
  const scope = requestScope.getStore();
  return scope ? { ...scope } : { folder: undefined };
}

/** Search and index operations must select the conversation's exact namespace. */
export function assertProjectScope(folder: string): void {
  assertScopeAllows(folder, filesystemPath.equal);
}

/** A file remains inside its parent project even when a child folder is also
 * registered. Registration chooses its owner; it does not change containment. */
export function assertProjectPath(sourcePath: string): void {
  assertScopeAllows(sourcePath, filesystemPath.contains);
}

function assertScopeAllows(target: string, allows: (root: string, target: string) => boolean): void {
  writeDiagnosticStep('session_scope', 'session_scope.check', () => {
    const scope = requestScope.getStore();
    writeDiagnosticEvidence('session_scope.bound_project', {
      target, session_folder: scope?.folder ?? null,
      attribution: scope ? 'live_session' : 'external_caller',
      runtime: scope?.runtime ?? null,
      rule: allows === filesystemPath.equal ? 'exact_project' : 'project_containment',
    });
    if (!scope) {
      writeDiagnosticEvidence('session_scope.result', { allowed: true, reason: 'external_caller' });
      return;
    }
    if (!scope.folder) {
      writeDiagnosticEvidence('session_scope.result', { allowed: false, reason: 'project_required' });
      throw new ProjectOperationError('Open a project before accessing its files.', 400, 'FOLDER_REQUIRED');
    }
    const allowed = allows(scope.folder, target);
    writeDiagnosticEvidence('session_scope.result', { allowed });
    if (!allowed) {
      throw new ProjectOperationError('Files must stay in the conversation project.', 403, 'PROJECT_SCOPE_MISMATCH');
    }
  });
}
