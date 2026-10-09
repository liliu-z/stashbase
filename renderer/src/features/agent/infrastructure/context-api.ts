import {
  AgentContextError,
  type AgentContextPort,
  type AgentUploadOutcome,
  type ResolvedContextFile,
} from '@/features/agent/application/ports';
import { classifyResponse, request, type TransportFailure } from '@/platform/http/classify';
import type { HttpClient } from '@/platform/http/client';
import {
  agentAttachResponseSchema,
  agentContextFileFailureSchema,
  agentContextFileResponseSchema,
} from '@/protocols/http/agent-context';

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Resolution meets two refusals the shared ladder cannot see: the file left
 *  the folder, and the Agent cannot read that format at all. */
function resolveFailure({ response, serverMessage }: TransportFailure): AgentContextError | null {
  const cause = serverMessage === null ? undefined : { cause: new Error(serverMessage) };
  if (response.status === 404) {
    return new AgentContextError('not-found', 'That file is no longer in this folder.', cause);
  }
  return response.status === 415
    ? new AgentContextError('unsupported', 'This file type cannot be given to the Agent.', cause)
    : null;
}

/** Project source resolution through the JSON client and transient uploads
 *  through the server origin directly, because the JSON client cannot carry
 *  multipart bodies. */
export function createAgentContextAdapter(
  client: HttpClient,
  serverOrigin: string,
  fetchRequest: Fetch = fetch,
): AgentContextPort {
  const attachTarget = new URL('/api/agent/attach', serverOrigin);
  return {
    async resolve(source, signal): Promise<ResolvedContextFile> {
      const query = new URLSearchParams({ path: `${source.folderPath}/${source.path}` });
      return request(client, {
        error: AgentContextError,
        failure: resolveFailure,
        failureSchema: agentContextFileFailureSchema,
        messages: {
          'invalid-response': 'File resolution returned an invalid response.',
          unavailable: 'StashBase could not resolve that file.',
        },
        path: `/api/project/agent-context-file?${query}`,
        schema: agentContextFileResponseSchema,
        signal,
      });
    },
    async upload(files, signal): Promise<AgentUploadOutcome[]> {
      const form = new FormData();
      for (const file of files) form.append('files', file, file.name);
      let response: Response;
      try {
        response = await fetchRequest(attachTarget, { body: form, method: 'POST', signal });
      } catch (error) {
        if (signal.aborted) throw error;
        client.reportError?.(error, 'attachment');
        throw new AgentContextError('unavailable', 'The attachment could not be uploaded.', {
          cause: error,
        });
      }
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (response.status < 200 || response.status >= 300) {
        // Multipart cannot go through the JSON client, so the shared ladder is
        // applied here to the status the attach route answered with.
        const failure = agentContextFileFailureSchema.safeParse(body);
        throw new AgentContextError(
          classifyResponse({ body, status: response.status }),
          failure.success ? failure.data.error : 'The attachment could not be uploaded.',
        );
      }
      const parsed = agentAttachResponseSchema.safeParse(body);
      if (!parsed.success) {
        client.reportError?.(new Error('Invalid attachment upload response'), 'attachment');
        throw new AgentContextError('invalid-response', 'The upload returned an invalid response.');
      }
      return parsed.data.files;
    },
  };
}
