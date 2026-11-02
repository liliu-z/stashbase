export { errorDiagnostic } from '../shared/protocols/diagnostics.ts';

// A lifecycle owner can report the original Error with richer typed evidence.
// Catching that same Error at outer log/shutdown boundaries must not count it again.
const reported = new WeakSet<object>();
export function markDiagnosticReported(error: object): void { reported.add(error); }
export function diagnosticAlreadyReported(error: unknown): boolean {
  return typeof error === 'object' && error !== null && reported.has(error);
}

const OPERATIONS = new Set(`render uncaught unhandled-rejection http-transport http-response startup native agent-connection folder-picker app-update upload attachment docx-preview pdf-preview resource workspace-session project-lifecycle mcp-connection install sync connection runtime skills steer tool model-request`.split(' '));
const HTTP_FEATURES = new Set(`account agents agent asset asset-derived appearance attach embedder files folders gallery index-status mcp projects project project-settings search sync terminal keyword-search local-components turn-changes updates workspace-preferences upload other unhandled`.split(' '));
const LOG_SCOPES = new Set(`agent-model-catalog agent-process agent-projects agent-rules agent app-config codex-app-server codex-agent conversion derived-store docx file-save folder github-import hosted-agent-broker http renderer server index links mcp-http-service mfs opencode-agent opencode-runtime pdf project-file-mutations extractor-runtime rename routes/account routes/attach routes/embedder routes/folders routes/indexing mcp-http routes/project-files routes/folder routes/upload stale-lock state sync turn-changes`.split(' '));
export function diagnosticOperation(value: string): string {
  if (OPERATIONS.has(value)) return value;
  if (value.startsWith('http.') && HTTP_FEATURES.has(value.slice(5))) return value;
  if (value.startsWith('background.') && LOG_SCOPES.has(value.slice(11))) return value.replaceAll('/', '.');
  return 'other';
}
