/** Correlation is an observation, never a window capability or a replay key. */
export const HTTP_REQUEST_ID_HEADER = 'x-stashbase-request-id';

export function validHttpRequestId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

const FEATURES = new Set(['account', 'agents', 'agent', 'project', 'upload', 'appearance', 'attach',
  'embedder', 'files', 'folders', 'gallery', 'index-status', 'mcp', 'projects', 'search', 'sync',
  'terminal', 'keyword-search', 'local-components', 'turn-changes', 'updates', 'workspace-preferences',
  'scheduled-tasks', 'telemetry', 'log', 'health']);

/** A client has no matched route template. Retain only known service names;
 * arbitrary path components, project names and queries never become metadata. */
export function httpDiagnosticRoute(path: string): string {
  const pathname = path.split(/[?#]/)[0] ?? '';
  const parts = pathname.split('/');
  const feature = parts[1] === 'api' && FEATURES.has(parts[2] ?? '') ? parts[2] : undefined;
  if (!feature) return '/other';
  if (feature === 'scheduled-tasks' && ['projects', 'runs'].includes(parts[3] ?? '') && parts.length === 4)
    return `/api/scheduled-tasks/${parts[3]}`;
  return `/api/${feature}${parts.length > 3 ? '/*' : ''}`;
}
