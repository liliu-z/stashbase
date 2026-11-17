/** The AudioContext requests 16 kHz so Chromium performs device resampling.
 * Nothing is retained beyond one second of PCM and one level interval. */
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class SpeechRecorder extends AudioWorkletProcessor {
  private pcm = new Int16Array(16000);
  private used = 0;
  private energy = 0;
  private count = 0;
  private stopped = false;

  constructor() {
    super();
    this.port.addEventListener('message', () => {
      this.stopped = true;
      this.flush();
      this.port.postMessage({ kind: 'stopped' }, { transfer: [] });
    });
    this.port.start();
  }

  private flush() {
    if (!this.used) return;
    const pcm = this.pcm.slice(0, this.used);
    this.port.postMessage({ kind: 'audio', pcm: pcm.buffer }, [pcm.buffer]);
    this.used = 0;
  }

  process(inputs: Float32Array[][]) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      const bounded = Math.max(-1, Math.min(1, sample));
      this.pcm[this.used++] = Math.round(bounded * (bounded < 0 ? 32768 : 32767));
      this.energy += bounded * bounded;
      this.count++;
      if (this.used === this.pcm.length) this.flush();
      if (this.count === 800) {
        this.port.postMessage(
          { kind: 'level', value: Math.min(1, Math.sqrt(this.energy / this.count) * 8) },
          { transfer: [] },
        );
        this.energy = 0;
        this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor('stashbase-speech', SpeechRecorder);
