//! Soundboard uploads: detects MP3, OGG (Vorbis/Opus) and WAV from the bytes and reads the duration from the headers.
//!
//! The probes are strict: a file that does not parse to its end (apart from tags) is rejected, so nothing that a browser
//! would keep playing past the measured length gets through.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioFormat {
    Mp3,
    Ogg,
    Wav,
}

impl AudioFormat {
    pub fn content_type(self) -> &'static str {
        match self {
            Self::Mp3 => "audio/mpeg",
            Self::Ogg => "audio/ogg",
            Self::Wav => "audio/wav",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Probe {
    pub format: AudioFormat,
    /// Rounded up to the next millisecond.
    pub duration_ms: u64,
}

pub fn probe(bytes: &[u8]) -> Option<Probe> {
    let (format, duration_ms) = if bytes.starts_with(b"RIFF") {
        (AudioFormat::Wav, wav(bytes)?)
    } else if bytes.starts_with(b"OggS") {
        (AudioFormat::Ogg, ogg(bytes)?)
    } else {
        (AudioFormat::Mp3, mp3(bytes)?)
    };
    (duration_ms > 0).then_some(Probe { format, duration_ms })
}

fn u16_le(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_le(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn ceil_ms(units: u64, per_second: u64) -> Option<u64> {
    if per_second == 0 {
        return None;
    }
    Some(units.checked_mul(1000)?.div_ceil(per_second))
}

/// Bytes 2..16 of the KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT GUIDs (bytes 0..2 hold the format tag).
const SUBFORMAT_TAIL: [u8; 14] = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71];

/// RIFF/WAVE: PCM, IEEE float or extensible; duration = data bytes / byte rate.
fn wav(bytes: &[u8]) -> Option<u64> {
    if bytes.get(8..12)? != b"WAVE" {
        return None;
    }
    let (mut byte_rate, mut data) = (None, None);
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32_le(bytes, at + 4)? as usize;
        let body = at + 8;
        match id {
            // Decoders disagree on which of two fmt or data chunks counts (ffmpeg takes the first), so a second one is refused.
            b"fmt " if byte_rate.is_some() => return None,
            b"data" if data.is_some() => return None,
            b"fmt " => {
                let format = u16_le(bytes, body)?;
                let channels = u16_le(bytes, body + 2)?;
                let rate = u32_le(bytes, body + 4)?;
                let rate_bytes = u32_le(bytes, body + 8)?;
                let block_align = u16_le(bytes, body + 12)?;
                let bits = u16_le(bytes, body + 14)?;
                if !matches!(format, 1 | 3 | 0xFFFE) || channels == 0 || rate == 0 || block_align == 0 {
                    return None;
                }
                // Extensible: the real format is the SubFormat GUID, which must be PCM or IEEE float like the plain tags.
                if format == 0xFFFE
                    && (size < 40
                        || u16_le(bytes, body + 16)? < 22
                        || !matches!(u16_le(bytes, body + 24)?, 1 | 3)
                        || bytes.get(body + 26..body + 40)? != SUBFORMAT_TAIL)
                {
                    return None;
                }
                // Decoders play at sample rate x block align and ignore the advisory byte-rate field, so both must agree with the
                // channels and sample size (extensible formats included).
                if bits == 0 || usize::from(block_align) != usize::from(channels) * usize::from(bits).div_ceil(8) {
                    return None;
                }
                let real_rate = u64::from(rate) * u64::from(block_align);
                if u64::from(rate_bytes) != real_rate {
                    return None;
                }
                byte_rate = Some(real_rate);
            }
            // Streaming writers put 0xFFFFFFFF here: the data runs to the end of the file.
            b"data" => data = Some(size.min(bytes.len() - body) as u64),
            _ => {}
        }
        at = body.checked_add(size)?.checked_add(size & 1)?;
    }
    ceil_ms(data.filter(|size| *size > 0)?, byte_rate?)
}

/// One logical Ogg stream (Vorbis or Opus); duration = last granule position (minus Opus pre-skip) / sample rate.
fn ogg(bytes: &[u8]) -> Option<u64> {
    let (mut serial, mut rate, mut pre_skip, mut last) = (None, 0_u64, 0_u64, None);
    let mut first_page_done = false;
    let mut at = 0;
    while at < bytes.len() {
        if bytes.get(at..at + 4)? != b"OggS" {
            return None;
        }
        let granule = i64::from_le_bytes(bytes.get(at + 6..at + 14)?.try_into().ok()?);
        let page_serial = u32_le(bytes, at + 14)?;
        let segments = *bytes.get(at + 26)? as usize;
        let table = bytes.get(at + 27..at + 27 + segments)?;
        let body = at + 27 + segments;
        let length: usize = table.iter().map(|segment| *segment as usize).sum();
        let payload = bytes.get(body..body + length)?;
        match serial {
            None => {
                serial = Some(page_serial);
                if payload.len() >= 16 && payload[0] == 1 && &payload[1..7] == b"vorbis" {
                    rate = u64::from(u32_le(payload, 12)?);
                } else if payload.len() >= 19 && &payload[..8] == b"OpusHead" {
                    rate = 48_000;
                    pre_skip = u64::from(u16_le(payload, 10)?);
                } else {
                    return None;
                }
            }
            Some(first) if first != page_serial => return None,
            Some(_) => {}
        }
        if granule >= 0 {
            // Granule positions never decrease; a decreasing one hides the real length from the probe.
            if last.is_some_and(|previous| (granule as u64) < previous) {
                return None;
            }
            last = Some(granule as u64);
        } else if first_page_done && table.last().is_some_and(|segment| *segment < 255) {
            // A packet ends on this page but it carries no position, so the length cannot be trusted.
            return None;
        }
        first_page_done = true;
        at = body + length;
    }
    ceil_ms(last?.saturating_sub(pre_skip), rate)
}

const MPEG1_RATES: [u32; 3] = [44_100, 48_000, 32_000];
const MPEG1_L1: [u32; 15] = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
const MPEG1_L2: [u32; 15] = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const MPEG1_L3: [u32; 15] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L1: [u32; 15] = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const MPEG2_L23: [u32; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/// (frame length in bytes, samples, sample rate) of the MPEG audio frame header at the start of `bytes`.
fn mpeg_frame(bytes: &[u8]) -> Option<(usize, u64, u32)> {
    let header = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?);
    if header >> 21 != 0x7FF {
        return None;
    }
    let version = (header >> 19) & 3; // 0 = MPEG 2.5, 1 reserved, 2 = MPEG 2, 3 = MPEG 1
    let layer = (header >> 17) & 3; // 1 = III, 2 = II, 3 = I
    let bitrate_index = ((header >> 12) & 0xF) as usize;
    let rate_index = ((header >> 10) & 3) as usize;
    let padding = (header >> 9) & 1;
    if version == 1 || layer == 0 || bitrate_index == 0 || bitrate_index == 15 || rate_index == 3 {
        return None;
    }
    let mpeg1 = version == 3;
    let rate = MPEG1_RATES[rate_index]
        >> if mpeg1 {
            0
        } else if version == 2 {
            1
        } else {
            2
        };
    let kbps = match (mpeg1, layer) {
        (true, 3) => MPEG1_L1[bitrate_index],
        (true, 2) => MPEG1_L2[bitrate_index],
        (true, _) => MPEG1_L3[bitrate_index],
        (false, 3) => MPEG2_L1[bitrate_index],
        (false, _) => MPEG2_L23[bitrate_index],
    };
    let bps = kbps * 1000;
    let (length, samples) = match layer {
        3 => ((12 * bps / rate + padding) * 4, 384),
        2 => (144 * bps / rate + padding, 1152),
        _ if mpeg1 => (144 * bps / rate + padding, 1152),
        _ => (72 * bps / rate + padding, 576),
    };
    (length >= 4).then_some((length as usize, samples, rate))
}

/// MPEG audio after optional ID3v2 tags, up to an optional ID3v1 tag; every byte in between must be frames (a final
/// truncated frame and zero padding are tolerated). Duration = summed samples / sample rate.
fn mp3(bytes: &[u8]) -> Option<u64> {
    let mut at = 0;
    while bytes.get(at..at + 3) == Some(b"ID3") {
        let header = bytes.get(at..at + 10)?;
        let size = header[6..10].iter().fold(0_usize, |acc, byte| (acc << 7) | (*byte as usize & 0x7F));
        let footer = if header[5] & 0x10 != 0 { 10 } else { 0 };
        at += 10 + size + footer;
    }
    let mut end = bytes.len();
    if end >= at + 128 && &bytes[end - 128..end - 125] == b"TAG" {
        end -= 128;
    }
    let (mut samples, mut rate, mut frames) = (0_u64, None, 0_u32);
    while at < end {
        let Some((length, frame_samples, frame_rate)) = mpeg_frame(&bytes[at..end]) else {
            if bytes[at..end].iter().all(|byte| *byte == 0) {
                break;
            }
            return None;
        };
        if *rate.get_or_insert(frame_rate) != frame_rate {
            return None;
        }
        samples += frame_samples;
        frames += 1;
        at += length;
    }
    if frames == 0 {
        return None;
    }
    ceil_ms(samples, u64::from(rate?))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn wav_bytes(rate: u32, channels: u16, frames: u32) -> Vec<u8> {
        let data = frames * u32::from(channels) * 2;
        let mut out = b"RIFF".to_vec();
        out.extend((36 + data).to_le_bytes());
        out.extend(b"WAVEfmt ");
        out.extend(16_u32.to_le_bytes());
        out.extend(1_u16.to_le_bytes());
        out.extend(channels.to_le_bytes());
        out.extend(rate.to_le_bytes());
        out.extend((rate * u32::from(channels) * 2).to_le_bytes());
        out.extend((channels * 2).to_le_bytes());
        out.extend(16_u16.to_le_bytes());
        out.extend(b"LIST");
        out.extend(3_u32.to_le_bytes());
        out.extend([1, 2, 3, 0]); // odd chunk + pad byte
        out.extend(b"data");
        out.extend(data.to_le_bytes());
        out.resize(out.len() + data as usize, 0);
        out
    }

    fn ogg_page(serial: u32, granule: i64, payload: &[u8]) -> Vec<u8> {
        let mut out = b"OggS".to_vec();
        out.extend([0, 0]);
        out.extend(granule.to_le_bytes());
        out.extend(serial.to_le_bytes());
        out.extend([0; 8]); // sequence + crc
        let mut table = vec![255_u8; payload.len() / 255];
        table.push((payload.len() % 255) as u8);
        out.push(table.len() as u8);
        out.extend(table);
        out.extend(payload);
        out
    }

    pub fn ogg_opus(samples_48k: i64) -> Vec<u8> {
        let mut head = b"OpusHead".to_vec();
        head.extend([1, 1]);
        head.extend(312_u16.to_le_bytes());
        head.extend(48_000_u32.to_le_bytes());
        head.extend([0, 0, 0]);
        let mut out = ogg_page(7, 0, &head);
        out.extend(ogg_page(7, 0, b"OpusTags"));
        out.extend(ogg_page(7, samples_48k / 2, &[0; 300]));
        out.extend(ogg_page(7, samples_48k + 312, &[0; 40]));
        out
    }

    /// MPEG-1 layer III, 128 kbps, 44.1 kHz frames (417 bytes, 1152 samples each, no padding).
    pub fn mp3_bytes(frames: usize) -> Vec<u8> {
        let mut out = b"ID3\x04\0\0\0\0\0\x05hello".to_vec();
        for _ in 0..frames {
            let mut frame = vec![0xFF, 0xFB, 0x90, 0x00];
            frame.resize(417, 0x55);
            out.extend(frame);
        }
        out
    }

    #[test]
    fn wav_duration_from_the_data_chunk() {
        assert_eq!(probe(&wav_bytes(22_050, 1, 22_050)), Some(Probe { format: AudioFormat::Wav, duration_ms: 1000 }));
        assert_eq!(probe(&wav_bytes(48_000, 2, 249_600)).map(|p| p.duration_ms), Some(5200));
        assert_eq!(probe(&wav_bytes(48_000, 2, 249_601)).map(|p| p.duration_ms), Some(5201), "rounded up");
        let mut no_data = wav_bytes(8000, 1, 0);
        assert!(probe(&no_data).is_none());
        no_data.truncate(20);
        assert!(probe(&no_data).is_none());
        let mut lying = wav_bytes(8000, 1, 8000 * 30);
        lying[28..32].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(probe(&lying).is_none(), "the declared byte rate must match sample rate x block align");
        let mut bad_align = wav_bytes(8000, 1, 8000);
        bad_align[32..34].copy_from_slice(&1_u16.to_le_bytes());
        assert!(probe(&bad_align).is_none(), "block align must be channels x bytes per sample");
        let one_second = wav_bytes(8000, 1, 8000);
        let mut extensible = one_second.clone();
        extensible[20..22].copy_from_slice(&0xFFFE_u16.to_le_bytes());
        extensible[28..32].copy_from_slice(&(8000_u32 * 65_535).to_le_bytes());
        extensible[32..34].copy_from_slice(&65_535_u16.to_le_bytes());
        assert!(probe(&extensible).is_none(), "block align is checked for extensible WAV too");
        let extended = |cb_size: u16, sub_format: u16, tail: [u8; 14]| {
            let mut out = one_second[..12].to_vec();
            out.extend(b"fmt ");
            out.extend(40_u32.to_le_bytes());
            out.extend(0xFFFE_u16.to_le_bytes());
            out.extend_from_slice(&one_second[22..36]);
            out.extend(cb_size.to_le_bytes());
            out.extend(16_u16.to_le_bytes());
            out.extend(0_u32.to_le_bytes());
            out.extend(sub_format.to_le_bytes());
            out.extend(tail);
            out.extend_from_slice(&one_second[36..]);
            out
        };
        assert_eq!(probe(&extended(22, 1, SUBFORMAT_TAIL)).map(|p| p.duration_ms), Some(1000), "extensible PCM");
        assert_eq!(probe(&extended(22, 3, SUBFORMAT_TAIL)).map(|p| p.duration_ms), Some(1000), "extensible float");
        assert!(probe(&extended(0, 1, SUBFORMAT_TAIL)).is_none(), "cbSize must cover the extension");
        assert!(probe(&extended(22, 2, SUBFORMAT_TAIL)).is_none(), "ADPCM SubFormat is refused");
        let mut other_guid = SUBFORMAT_TAIL;
        other_guid[13] = 0;
        assert!(probe(&extended(22, 1, other_guid)).is_none(), "an unknown SubFormat GUID is refused");
        assert!(probe(&extensible[..]).is_none(), "extensible needs the 40-byte fmt chunk");
        let one = wav_bytes(8000, 1, 8000);
        let mut two_fmt = one[..36].to_vec();
        two_fmt.extend_from_slice(&one[12..36]);
        two_fmt.extend_from_slice(&one[36..]);
        assert!(probe(&two_fmt).is_none(), "a second fmt chunk is refused");
        let mut two_data = one.clone();
        two_data.extend(b"data");
        two_data.extend(16_000_u32.to_le_bytes());
        two_data.resize(two_data.len() + 16_000, 0);
        assert!(probe(&two_data).is_none(), "a second data chunk is refused");
        assert!(probe(&one).is_some());
    }

    #[test]
    fn ogg_with_hidden_or_decreasing_granules_is_rejected() {
        let mut file = ogg_opus(48_000);
        file.extend(ogg_page(7, -1, &[0; 10]));
        assert!(probe(&file).is_none(), "a packet ends on a page without a position");
        let mut file = ogg_opus(48_000);
        file.extend(ogg_page(7, 100, &[0; 10]));
        assert!(probe(&file).is_none(), "granule positions must not decrease");
    }

    #[test]
    fn ogg_duration_from_the_last_granule() {
        assert_eq!(probe(&ogg_opus(48_000 * 3)), Some(Probe { format: AudioFormat::Ogg, duration_ms: 3000 }));
        let mut vorbis = vec![1];
        vorbis.extend(b"vorbis");
        vorbis.extend([0, 0, 0, 0, 2]);
        vorbis.extend(44_100_u32.to_le_bytes());
        vorbis.extend([0; 14]);
        let mut file = ogg_page(1, 0, &vorbis);
        file.extend(ogg_page(1, 44_100 * 6, &[0; 10]));
        assert_eq!(probe(&file).map(|p| p.duration_ms), Some(6000));
        let mut chained = ogg_opus(48_000);
        chained.extend(ogg_page(9, 10, &[0; 4]));
        assert!(probe(&chained).is_none(), "a second stream is rejected");
        let mut trailing = ogg_opus(48_000);
        trailing.extend(b"junk");
        assert!(probe(&trailing).is_none());
    }

    #[test]
    fn mp3_duration_from_the_frames() {
        // 1152 / 44100 s per frame: 100 frames = 2612.2 ms
        assert_eq!(probe(&mp3_bytes(100)), Some(Probe { format: AudioFormat::Mp3, duration_ms: 2613 }));
        let mut tagged = mp3_bytes(10);
        tagged.extend(b"TAG");
        tagged.extend([0; 125]);
        assert_eq!(probe(&tagged).map(|p| p.duration_ms), Some(262));
        let mut hidden = mp3_bytes(10);
        hidden.extend(b"not audio, but maybe more frames after it");
        hidden.extend(mp3_bytes(1000));
        assert!(probe(&hidden).is_none(), "anything that is not a frame is rejected");
        assert!(probe(b"just some text").is_none());
        assert!(probe(b"").is_none());
    }
}
