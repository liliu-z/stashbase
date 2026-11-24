import { useEffect } from 'react';

type Changed = 'identity' | 'referrals';
let channel: BroadcastChannel | undefined;

function accountChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined;
  channel ??= new BroadcastChannel('stashbase-account');
  return channel;
}

/** A peer only learns it should read the Node owner again. */
export function broadcastAccountChange(change: Changed): void {
  accountChannel()?.postMessage(change);
}

export function useAccountSignals(onChange: (change: Changed) => void) {
  useEffect(() => {
    const peer = accountChannel();
    if (!peer) return;
    const received = ({ data }: MessageEvent) => {
      if (data === 'identity' || data === 'referrals') onChange(data);
    };
    peer.addEventListener('message', received);
    return () => peer.removeEventListener('message', received);
  }, [onChange]);
}
