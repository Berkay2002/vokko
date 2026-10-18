import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowUp, Download, Mic, Pause, Play, Trash2 } from 'lucide-react';
import { MessageFlags } from '../api/types';
import type { Attachment, Message, Snowflake, User } from '../api/types';
import { Tooltip, resolveUrl, uploadAttachment } from './shell';
import { saveOnClick } from './mediaActions';
import { messageStore } from './messageStore';
import { chatToast } from './toast';
import { uploadErrorMessage } from './util';
import { MAX_VOICE_SECONDS, decodeWaveform, encodeWaveform, formatVoiceTime, pickVoiceType, resample } from './voiceWaveform';

const TICK_MS = 50;
const LIVE_BARS = 48;
/** Speech RMS rarely passes 0.25, so live bars are scaled up to fill the strip. */
const LIVE_GAIN = 4;
const SPEEDS = [1, 1.5, 2] as const;

export const isVoiceMessage = (message: Pick<Message, 'flags'>): boolean => ((message.flags ?? 0) & MessageFlags.IsVoiceMessage) !== 0;

export const canRecordVoice = (): boolean => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

interface Clip { file: File; duration: number; waveform: string }

interface Active {
  stream: MediaStream;
  recorder: MediaRecorder;
  ctx: AudioContext;
  timer: ReturnType<typeof setInterval>;
  chunks: Blob[];
  levels: number[];
  started: number;
  extension: string;
}

/** Microphone recording with live levels. `onLimit` runs when the 20 minute cap stops it. */
export function useVoiceRecorder(onLimit: (clip: Clip | null) => void) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [live, setLive] = useState<number[]>([]);
  const active = useRef<Active | null>(null);
  const limit = useRef(onLimit);
  useEffect(() => { limit.current = onLimit; });

  const release = useCallback((a: Active) => {
    clearInterval(a.timer);
    a.stream.getTracks().forEach(t => t.stop());
    void a.ctx.close().catch(() => undefined);
    if (active.current === a) active.current = null;
    setRecording(false);
    setElapsed(0);
    setLive([]);
  }, []);

  const stop = useCallback((): Promise<Clip | null> => {
    const a = active.current;
    if (!a) return Promise.resolve(null);
    const duration = Math.min(MAX_VOICE_SECONDS, (performance.now() - a.started) / 1000);
    return new Promise(resolve => {
      a.recorder.onstop = () => {
        release(a);
        const type = a.recorder.mimeType || a.chunks[0]?.type || 'audio/webm';
        const blob = new Blob(a.chunks, { type });
        if (blob.size === 0 || duration < 0.3) { resolve(null); return; }
        resolve({ file: new File([blob], `voice-message.${a.extension}`, { type }), duration: Math.round(duration * 100) / 100, waveform: encodeWaveform(a.levels) });
      };
      if (a.recorder.state === 'inactive') a.recorder.onstop(new Event('stop'));
      else a.recorder.stop();
    });
  }, [release]);

  const cancel = useCallback(() => {
    const a = active.current;
    if (!a) return;
    a.recorder.onstop = null;
    if (a.recorder.state !== 'inactive') a.recorder.stop();
    release(a);
  }, [release]);

  const start = useCallback(async (): Promise<boolean> => {
    if (active.current) return true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      chatToast('Vokko needs microphone access to record a voice message.');
      return false;
    }
    const type = pickVoiceType(t => MediaRecorder.isTypeSupported(t));
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, type ? { mimeType: type.mimeType, audioBitsPerSecond: 64_000 } : undefined);
    } catch {
      stream.getTracks().forEach(t => t.stop());
      chatToast('Voice messages are not supported here.');
      return false;
    }
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const a: Active = { stream, recorder, ctx, timer: 0 as unknown as ReturnType<typeof setInterval>, chunks: [], levels: [], started: performance.now(), extension: type?.extension ?? 'webm' };
    recorder.ondataavailable = e => { if (e.data.size > 0) a.chunks.push(e.data); };
    recorder.start(250);
    a.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      a.levels.push(Math.sqrt(sum / buf.length));
      const seconds = (performance.now() - a.started) / 1000;
      setElapsed(seconds);
      setLive(a.levels.slice(-LIVE_BARS));
      if (seconds >= MAX_VOICE_SECONDS) { clearInterval(a.timer); void stop().then(clip => limit.current(clip)); }
    }, TICK_MS);
    active.current = a;
    setRecording(true);
    return true;
  }, [stop]);

  useEffect(() => () => { if (active.current) { active.current.recorder.onstop = null; if (active.current.recorder.state !== 'inactive') active.current.recorder.stop(); release(active.current); } }, [release]);

  return { recording, elapsed, live, start, stop, cancel };
}

/** Uploads the clip and posts it as a voice message (flags IS_VOICE_MESSAGE, one attachment with duration + waveform). */
export async function sendVoiceMessage(channelId: Snowflake, me: User, clip: Clip, reply: Message | null, mention: boolean): Promise<void> {
  let uploaded: Attachment;
  try {
    uploaded = await uploadAttachment(channelId, clip.file);
  } catch (e) {
    chatToast(uploadErrorMessage(e, clip.file.size));
    return;
  }
  const voice = { duration_secs: clip.duration, waveform: clip.waveform };
  messageStore.send(channelId, me, {
    content: '',
    attachments: [{ ...uploaded, ...voice }],
    meta: [{ id: uploaded.id, ...voice }],
    flags: MessageFlags.IsVoiceMessage,
    reply,
    mention,
  });
}

function LiveBars({ levels }: { levels: number[] }) {
  const padded = [...Array<number>(Math.max(0, LIVE_BARS - levels.length)).fill(0), ...levels];
  return <div className="voice-live" aria-hidden="true">
    {padded.map((v, i) => <span key={i} style={{ height: `${Math.max(8, Math.min(100, v * LIVE_GAIN * 100))}%` }} />)}
  </div>;
}

/** Desktop: the bar that replaces the message box while recording (cancel, red dot + timer, live waveform, send). */
export function VoiceRecorderBar({ elapsed, live, onCancel, onSend }: { elapsed: number; live: number[]; onCancel(): void; onSend(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    else if (e.key === 'Enter') { e.preventDefault(); onSend(); }
  };
  return <div ref={ref} className="voice-recorder" role="group" aria-label="Recording voice message" tabIndex={-1} onKeyDown={onKeyDown}>
    <Tooltip content="Cancel" side="top"><button type="button" className="voice-recorder-cancel" aria-label="Cancel voice message" onClick={onCancel}><Trash2 size={20} /></button></Tooltip>
    <span className="voice-recorder-dot" aria-hidden="true" />
    <span className="voice-recorder-time" role="timer" aria-label={`Recording, ${formatVoiceTime(elapsed)}`}>{formatVoiceTime(elapsed)}</span>
    <LiveBars levels={live} />
    <Tooltip content="Send" side="top"><button type="button" className="voice-recorder-send" aria-label="Send voice message" onClick={onSend}><ArrowUp size={20} /></button></Tooltip>
  </div>;
}

/** Phone: hold the mic to record, release to send, slide left to cancel. Shown in place of the message box while held. */
export function VoiceHoldOverlay({ elapsed, live, cancelling }: { elapsed: number; live: number[]; cancelling: boolean }) {
  return <div className={`voice-recorder hold${cancelling ? ' cancelling' : ''}`} role="group" aria-label="Recording voice message">
    <span className="voice-recorder-dot" aria-hidden="true" />
    <span className="voice-recorder-time" role="timer">{formatVoiceTime(elapsed)}</span>
    <LiveBars levels={live} />
    <span className="voice-recorder-hint">{cancelling ? 'Release to cancel' : '‹ Slide to cancel'}</span>
  </div>;
}

/** Pointer handlers for the phone mic button: press starts, release sends, a slide of 100px to the left cancels. */
export function useHoldToRecord(rec: ReturnType<typeof useVoiceRecorder>, send: (clip: Clip) => void) {
  const [cancelling, setCancelling] = useState(false);
  const origin = useRef<{ x: number; at: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    origin.current = { x: e.clientX, at: Date.now() };
    setCancelling(false);
    // released while the microphone was still opening: drop what just started
    void rec.start().then(() => { if (!origin.current) rec.cancel(); });
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (origin.current) setCancelling(e.clientX - origin.current.x < -100);
  };
  const finish = (cancel: boolean) => {
    const o = origin.current;
    origin.current = null;
    setCancelling(false);
    if (!o) return;
    if (cancel || Date.now() - o.at < 300) {
      rec.cancel();
      if (!cancel) chatToast('Hold to record, release to send.');
      return;
    }
    void rec.stop().then(clip => { if (clip) send(clip); });
  };
  return {
    cancelling,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: () => finish(cancelling),
      onPointerCancel: () => finish(true),
      onContextMenu: (e: { preventDefault(): void }) => e.preventDefault(),
    },
  };
}

export function MicButton(props: { onClick?(): void; recording?: boolean } & Partial<ReturnType<typeof useHoldToRecord>['handlers']>) {
  const { recording, ...handlers } = props;
  return <Tooltip content="Record Voice Message" side="top">
    <button type="button" className={`chat-composer-btn voice-mic${recording ? ' recording' : ''}`} aria-label="Record voice message" aria-pressed={recording ?? false} {...handlers}><Mic size={24} /></button>
  </Tooltip>;
}

/** Discord's voice message pill: play/pause, waveform with progress (click or arrow keys to seek), time, speed 1x / 1.5x / 2x, download. */
export function VoicePlayer({ attachment }: { attachment: Attachment }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  // MediaRecorder webm files often report Infinity until played through, so the sent duration wins.
  const duration = attachment.duration_secs ?? (mediaDuration && Number.isFinite(mediaDuration) ? mediaDuration : 0);
  const bars = useMemo(() => {
    const samples = decodeWaveform(attachment.waveform);
    // Discord sizes the strip by length: short clips get fewer bars.
    const count = Math.max(24, Math.min(64, Math.round(duration * 4) || 40));
    return samples.length ? resample(samples, count) : Array<number>(count).fill(0.15);
  }, [attachment.waveform, duration]);
  const progress = duration > 0 ? Math.min(1, time / duration) : 0;
  const url = resolveUrl(attachment.url);

  useEffect(() => { if (audio.current) audio.current.playbackRate = speed; }, [speed]);

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) { el.playbackRate = speed; void el.play().catch(() => setPlaying(false)); } else el.pause();
  };
  const seek = (fraction: number) => {
    const el = audio.current;
    if (!el || duration <= 0) return;
    el.currentTime = Math.max(0, Math.min(duration, fraction * duration));
    setTime(el.currentTime);
  };
  const onWaveKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); seek((time + 5) / duration); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek((time - 5) / duration); }
  };

  return <div className={`voice-player${playing ? ' playing' : ''}`} role="group" aria-label="Voice message">
    <audio ref={audio} src={url} preload="metadata"
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
      onEnded={() => { setPlaying(false); setTime(0); }}
      onTimeUpdate={e => setTime(e.currentTarget.currentTime)}
      onLoadedMetadata={e => setMediaDuration(e.currentTarget.duration)} />
    <button type="button" className="voice-player-play" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>
      {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
    </button>
    <div className="voice-player-wave" role="slider" tabIndex={0} aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)}
      aria-valuetext={`${formatVoiceTime(time)} of ${formatVoiceTime(duration)}`} onKeyDown={onWaveKey}
      onClick={e => { const r = e.currentTarget.getBoundingClientRect(); seek((e.clientX - r.left) / r.width); }}>
      {bars.map((v, i) => <span key={i} className={(i + 0.5) / bars.length <= progress ? 'played' : undefined} style={{ height: `${Math.max(12, v * 100)}%` }} />)}
    </div>
    <span className="voice-player-time">{formatVoiceTime(playing || time > 0 ? time : duration)}</span>
    <Tooltip content="Playback speed" side="top">
      <button type="button" className="voice-player-speed" aria-label={`Playback speed ${speed}x`} onClick={() => setSpeed(s => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]!)}>{speed}x</button>
    </Tooltip>
    <Tooltip content="Download" side="top">
      <a className="voice-player-download" href={url} download={attachment.filename} onClick={saveOnClick(url, attachment.filename)} aria-label="Download voice message"><Download size={18} /></a>
    </Tooltip>
  </div>;
}
