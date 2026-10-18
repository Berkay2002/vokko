// Level meter for the "you are muted" hint. LiveKit mutes by disabling the RAW mic track, which is what the published chain
// (gate.ts) reads, so a disabled track means silence on the wire. This listens to a CLONE that stays live, only while muted,
// and feeds an analyser that is connected to nothing: its audio can never reach the output. Not unit tested on a real device.

import { FRAME_MS, rmsDb } from "./vad";

export class MutedTap {
  private readonly clone: MediaStreamTrack;
  private readonly source: MediaStreamAudioSourceNode;
  private poll: ReturnType<typeof setInterval> | null;

  constructor(ctx: AudioContext, track: MediaStreamTrack, onLevel: (db: number) => void) {
    this.clone = track.clone();
    this.clone.enabled = true;
    this.source = ctx.createMediaStreamSource(new MediaStream([this.clone]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    this.source.connect(analyser); // the analyser has no output
    const buffer = new Float32Array(analyser.fftSize);
    this.poll = setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      onLevel(rmsDb(buffer));
    }, FRAME_MS);
  }

  /** Releases the clone, so the capture device is not held open (a switch of device or a restart needs that on iOS Safari). */
  stop(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.source.disconnect();
    this.clone.stop();
  }
}
