import type { MathModePort } from '@/features/settings/application/math-mode-port';
import { settingsRequest } from '@/features/settings/infrastructure/settings-request';
import { request } from '@/platform/http/classify';
import type { HttpClient } from '@/platform/http/client';
import {
  projectMathModeFailureSchema,
  projectMathModeSchema,
} from '@/protocols/http/project-math-mode';

const PATH = '/api/project-math-mode';

/** One project's switch, named by its folder root in the query for a read and
 *  in the body for a write. */
function preferences(scope: string, signal: AbortSignal) {
  return settingsRequest({
    failureSchema: projectMathModeFailureSchema,
    path: `${PATH}?scope=${encodeURIComponent(scope)}`,
    signal,
  });
}

export function createMathModeAdapter(client: HttpClient): MathModePort {
  return {
    async load(scope, signal) {
      const record = await request(client, {
        ...preferences(scope, signal),
        schema: projectMathModeSchema,
      });
      return record.enabled;
    },
    async save(scope, enabled, signal) {
      const record = await request(client, {
        ...preferences(scope, signal),
        body: { scope, enabled },
        method: 'PUT',
        schema: projectMathModeSchema,
      });
      return record.enabled;
    },
  };
}
