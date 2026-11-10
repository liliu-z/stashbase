/**
 * Whether the agent that refused this chat's credentials is signed in again.
 *
 * A turn refused for sign-in stays in the transcript, asking the reader to
 * sign in. That sign-in happens in Settings or Send's access prompt, so the
 * chat learns of it only from the readiness catalog. The host withdraws
 * readiness before it reports the refusal and restores it only after an
 * explicit sign-in, but a catalog read before the refusal still says ready.
 * So the catalog must first be seen reporting the refusal; a ready reading
 * after that is the sign-in.
 */
import { useState } from 'react';

import type { AgentTranscriptBlock } from '@/features/agent/domain/session';

/** `ready` is the chat's agent in the latest catalog reading, or undefined
 *  while the catalog has not described it. */
export function useAgentSignInRecovered(
  transcript: readonly AgentTranscriptBlock[],
  ready: boolean | undefined,
): boolean {
  const refusal =
    transcript.findLast((block) => block.kind === 'error' && block.failure === 'auth-expired')
      ?.id ?? null;
  const [reported, setReported] = useState<string | null>(null);
  if (refusal !== null && ready === false && reported !== refusal) setReported(refusal);
  return refusal !== null && reported === refusal && ready === true;
}
