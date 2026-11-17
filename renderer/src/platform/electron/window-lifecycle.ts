import type {
  WindowAppearance,
  WindowContextReleaseReason,
  WindowInputActivity,
} from '@/protocols/electron/window-lifecycle';

export interface WindowLifecycleBridge {
  onInputActivity?(handler: (kind: WindowInputActivity) => void): () => void;
  onPrepareContextRelease(
    handler: (reason: WindowContextReleaseReason) => boolean | Promise<boolean>,
    options?: { interactive: boolean },
  ): () => void;
  setAppearance(appearance: WindowAppearance): Promise<void>;
}
