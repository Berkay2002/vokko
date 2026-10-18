import { describe, expect, it } from 'vitest';
import { decodeWaveform, encodeWaveform, formatVoiceTime, pickVoiceType, resample } from './voiceWaveform';

const bytesOf = (waveform: string) => [...atob(waveform)].map(ch => ch.charCodeAt(0));

describe('voice waveform', () => {
  it('keeps short recordings sample for sample, scaled to the loudest', () => {
    expect(bytesOf(encodeWaveform([0, 0.25, 0.5]))).toEqual([0, 128, 255]);
  });

  it('averages long recordings down to 256 samples', () => {
    const levels = Array.from({ length: 1000 }, (_, i) => (i < 500 ? 0.1 : 0.4));
    const bytes = bytesOf(encodeWaveform(levels));
    expect(bytes).toHaveLength(256);
    expect(bytes[0]).toBe(64);
    expect(bytes[255]).toBe(255);
  });

  it('silence and empty input stay valid (one zero sample at least)', () => {
    expect(bytesOf(encodeWaveform([]))).toEqual([0]);
    expect(bytesOf(encodeWaveform([0, 0]))).toEqual([0, 0]);
  });

  it('round-trips through decode and survives garbage', () => {
    expect(decodeWaveform(encodeWaveform([0, 1]))).toEqual([0, 1]);
    expect(decodeWaveform('not base64!')).toEqual([]);
    expect(decodeWaveform(undefined)).toEqual([]);
  });

  it('resample buckets evenly', () => {
    expect(resample([1, 3, 5, 7], 2)).toEqual([2, 6]);
    expect(resample([1, 2], 5)).toEqual([1, 2]);
  });

  it('prefers opus and falls back to mp4 (Safari)', () => {
    expect(pickVoiceType(t => t.startsWith('audio/webm'))?.extension).toBe('webm');
    expect(pickVoiceType(t => t === 'audio/mp4')).toEqual({ mimeType: 'audio/mp4', extension: 'm4a' });
    expect(pickVoiceType(() => false)).toBeNull();
  });

  it('formats times', () => {
    expect(formatVoiceTime(7.9)).toBe('0:07');
    expect(formatVoiceTime(1200)).toBe('20:00');
  });
});
