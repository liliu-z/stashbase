import type {
  WindowAppearance,
  WindowContextReleaseReason,
} from '@/protocols/electron/window-lifecycle';

export interface WindowLifecycleBridge {
  onPrepareContextRelease(
    handler: (reason: WindowContextReleaseReason) => boolean | Promise<boolean>,
  ): () => void;
  setAppearance(appearance: WindowAppearance): Promise<void>;
}
