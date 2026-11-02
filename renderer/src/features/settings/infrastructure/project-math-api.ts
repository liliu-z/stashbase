import type { ProjectMathPort } from '@/features/settings/application/ports';
import { settingsRequest } from '@/features/settings/infrastructure/settings-request';
import { request } from '@/platform/http/classify';
import type { HttpClient } from '@/platform/http/client';
import {
  projectMathSettingsRequestSchema,
  projectMathSettingsSchema,
} from '@/protocols/http/project-settings';

const PATH = '/api/project-settings/math';

function options(signal: AbortSignal) {
  return settingsRequest({ path: PATH, signal });
}

export function createProjectMathAdapter(client: HttpClient): ProjectMathPort {
  return {
    load(scope, signal) {
      return request(client, {
        ...options(signal),
        path: `${PATH}?${new URLSearchParams({ scope })}`,
        schema: projectMathSettingsSchema,
      });
    },
    update(scope, mathMode, signal) {
      return request(client, {
        ...options(signal),
        body: projectMathSettingsRequestSchema.parse({ scope, math_mode: mathMode }),
        method: 'PUT',
        schema: projectMathSettingsSchema,
      });
    },
  };
}
