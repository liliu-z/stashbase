export interface SeekableAudio {
  currentTime: number;
}

/** Keeps the user's logical playback position independent from the concrete
 * media URL. Chromium can reject the source after a search seek, at which
 * point AudioPreview swaps in a generated fallback and remounts `<audio>`. */
export class AudioPlaybackPosition {
  private positionMs: number | null = null;
  private sourceIdentity: string | null = null;

  /** Select the logical source file, independently from direct/fallback media
   * URLs. A new file version clears position; a fallback URL for the same
   * version deliberately retains it. */
  setSourceIdentity(identity: string): boolean {
    if (this.sourceIdentity === identity) return false;
    this.sourceIdentity = identity;
    this.reset();
    return true;
  }

  reset(): void {
    this.positionMs = null;
  }

  remember(positionMs: number): void {
    if (Number.isFinite(positionMs) && positionMs >= 0) this.positionMs = positionMs;
  }

  apply(audio: SeekableAudio): boolean {
    if (this.positionMs == null) return false;
    try {
      audio.currentTime = this.positionMs / 1000;
      return true;
    } catch {
      // Media metadata may not exist yet. The retained position is applied by
      // the next loadedmetadata event, including after fallback source swap.
      return false;
    }
  }
}
