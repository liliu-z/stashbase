import type { AppearancePort } from '@/features/settings/application/ports';
import { settingsRequest } from '@/features/settings/infrastructure/settings-request';
import { request } from '@/platform/http/classify';
import type { HttpClient } from '@/platform/http/client';
import {
  appearanceFailureSchema,
  appearancePreferencesRequestSchema,
  appearancePreferencesSchema,
} from '@/protocols/http/appearance';

function preferences(signal: AbortSignal, unavailable: string) {
  return settingsRequest({
    failureSchema: appearanceFailureSchema,
    invalidResponse: 'Appearance settings returned an invalid response.',
    path: '/api/appearance',
    signal,
    unavailable,
  });
}

export function createAppearanceAdapter(client: HttpClient): AppearancePort {
  return {
    async load(signal) {
      const parsed = await request(client, {
        ...preferences(signal, 'Appearance settings are unavailable.'),
        schema: appearancePreferencesSchema,
      });
      return {
        theme: parsed.theme,
        uiScale: parsed.uiScale,
        readingTextSize: parsed.readingTextSize,
        readingFont: parsed.readingFont,
      };
    },
    async update(change, signal) {
      const parsed = await request(client, {
        ...preferences(signal, 'Appearance settings could not be saved.'),
        body: appearancePreferencesRequestSchema.parse(change),
        method: 'PUT',
        schema: appearancePreferencesSchema,
      });
      return {
        theme: parsed.theme,
        uiScale: parsed.uiScale,
        readingTextSize: parsed.readingTextSize,
        readingFont: parsed.readingFont,
      };
    },
  };
}
