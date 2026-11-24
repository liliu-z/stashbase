import { AgentRuntimeError } from '@/features/settings/application/ports';
import type { ReferralPort } from '@/features/settings/application/referral-port';
import { ReferralRequestError } from '@/features/settings/domain/referrals';
import { request, send } from '@/platform/http/classify';
import type { HttpClient } from '@/platform/http/client';
import {
  referralAcceptInputSchema,
  referralAccountSchema,
  referralFailureSchema,
  referralGrantsSchema,
  referralHistorySchema,
  referralPreviewInputSchema,
  referralPreviewSchema,
  referralScopeSchema,
} from '@/protocols/http/referrals';

export function referralRequest(path: string, signal: AbortSignal) {
  return {
    path,
    signal,
    error: AgentRuntimeError,
    failure: ({ response }: { response: { body: unknown; status: number } }) => {
      const parsed = referralFailureSchema.safeParse(response.body);
      return parsed.success
        ? new ReferralRequestError(parsed.data.code, response.status, parsed.data.retryAfterSeconds)
        : null;
    },
  };
}

export function createReferralAdapter(client: HttpClient): ReferralPort {
  const base = '/api/account/referrals';
  function read(path: string, generation: string, signal: AbortSignal, cursor?: string | null) {
    const query = new URLSearchParams(referralScopeSchema.parse({ generation }));
    if (cursor) query.set('cursor', cursor);
    return referralRequest(`${base}/${path}?${query}`, signal);
  }
  return {
    load(generation, signal) {
      return request(client, { ...read('me', generation, signal), schema: referralAccountSchema });
    },
    preview(generation, code, signal) {
      return request(client, {
        ...referralRequest(`${base}/preview`, signal),
        method: 'POST',
        body: referralPreviewInputSchema.parse({ generation, code }),
        schema: referralPreviewSchema,
      });
    },
    async accept(input, signal) {
      await send(client, {
        ...referralRequest(`${base}/claim`, signal),
        method: 'POST',
        body: referralAcceptInputSchema.parse(input),
      });
    },
    async skip(generation, signal) {
      await send(client, {
        ...referralRequest(`${base}/skip`, signal),
        method: 'POST',
        body: referralScopeSchema.parse({ generation }),
      });
    },
    history(generation, cursor, signal) {
      return request(client, {
        ...read('history', generation, signal, cursor),
        schema: referralHistorySchema,
      });
    },
    grants(generation, cursor, signal) {
      return request(client, {
        ...read('grants', generation, signal, cursor),
        schema: referralGrantsSchema,
      });
    },
  };
}
