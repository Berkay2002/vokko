//! Subtitle cues out of SRT and WebVTT text, shared by the server (files that Stremio addons offer) and the Stremio bot (what ffmpeg
//! writes for an embedded text track). Both feed untrusted text in, and the result is only ever shown as plain text: markup, ASS
//! override blocks, control characters and bidi overrides are stripped, and a cue is capped in length, lines and duration.
use crate::api::StremioCue;

pub const MAX_CUE_CHARS: usize = 300;
pub const MAX_CUE_LINES: usize = 4;
/// A cue that claims to last longer is cut to this.
pub const MAX_CUE_MS: u64 = 30_000;
const MAX_RAW_CHARS: usize = 4096;
const MAX_START_MS: u64 = 48 * 3_600_000;

/// `01:02:03,456`, `01:02:03.456` or the WebVTT short form `02:03.456`, in milliseconds.
fn parse_time(text: &str) -> Option<u64> {
    let (clock, millis) = text.split_once([',', '.'])?;
    if millis.is_empty() || millis.len() > 3 || !millis.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let parts: Vec<&str> = clock.split(':').collect();
    if !(2..=3).contains(&parts.len()) || parts.iter().any(|p| p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    let number = |p: &str| p.parse::<u64>().ok();
    let (hours, minutes, seconds) =
        if parts.len() == 3 { (number(parts[0])?, number(parts[1])?, number(parts[2])?) } else { (0, number(parts[0])?, number(parts[1])?) };
    let ms = format!("{millis:0<3}").parse::<u64>().ok()?;
    Some(((hours * 60 + minutes) * 60 + seconds) * 1000 + ms)
}

/// `00:01:02,345 --> 00:01:04,000 position:10%` gives the two times; the cue settings after them are ignored.
pub fn parse_timing(line: &str) -> Option<(u64, u64)> {
    let (start, rest) = line.split_once("-->")?;
    let (start, end) = (parse_time(start.trim())?, parse_time(rest.split_whitespace().next()?)?);
    (start < end && start <= MAX_START_MS).then_some((start, end.min(start + MAX_CUE_MS)))
}

/// Characters that never reach a viewer: controls, bidi overrides and isolates, zero-width marks, the byte order mark.
fn hidden(c: char) -> bool {
    c.is_control() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
}

/// Removes `<tag>` (a `<` followed by a letter or `/`) and `{override}` blocks. Linear: once a closing character is missing
/// from the rest of the text, no later opener can find one either, so it is not searched for again.
fn strip_markup(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let (mut no_angle, mut no_brace) = (false, false);
    let mut i = 0;
    while i < chars.len() {
        let close = match chars[i] {
            '<' if !no_angle && chars.get(i + 1).is_some_and(|n| n.is_alphabetic() || *n == '/') => Some(('>', &mut no_angle)),
            '{' if !no_brace => Some(('}', &mut no_brace)),
            _ => None,
        };
        let found = close.and_then(|(close, missing)| {
            let found = chars[i..].iter().position(|c| *c == close);
            *missing = found.is_none();
            found
        });
        match found {
            Some(len) => i += len + 1,
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// Plain text of a cue: markup and hidden characters removed, a few entities decoded, at most `MAX_CUE_LINES` lines and
/// `MAX_CUE_CHARS` characters. Empty when nothing visible is left.
pub fn clean_text(raw: &str) -> String {
    // A cue never needs more than this much source (markup included); the rest is not looked at.
    let raw: String = raw.chars().take(MAX_RAW_CHARS).collect();
    let text = strip_markup(&raw.replace("\r\n", "\n").replace('\r', "\n").replace("\\N", "\n").replace("\\n", "\n"));
    let text = text.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&");
    let lines: Vec<String> = text
        .lines()
        .map(|line| line.chars().filter(|c| !hidden(*c)).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .take(MAX_CUE_LINES)
        .collect();
    lines.join("\n").chars().take(MAX_CUE_CHARS).collect()
}

/// One block of lines (as SRT and WebVTT separate cues with a blank line): an optional identifier, the timing line, the text.
/// `None` for anything else (the `WEBVTT` header, a `NOTE`, a cue without visible text).
pub fn parse_block(block: &str) -> Option<StremioCue> {
    let mut lines = block.lines().skip_while(|line| !line.contains("-->"));
    let (start_ms, end_ms) = parse_timing(lines.next()?)?;
    let text = clean_text(&lines.collect::<Vec<_>>().join("\n"));
    (!text.is_empty()).then_some(StremioCue { start_ms, end_ms, text })
}

/// All cues of an SRT or WebVTT file, in start order, at most `max`. Anything else (ASS, garbage) gives none.
pub fn parse(text: &str, max: usize) -> Vec<StremioCue> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut cues: Vec<StremioCue> = text.split("\n\n").filter_map(parse_block).take(max).collect();
    cues.sort_by_key(|cue| cue.start_ms);
    cues
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_parse_in_srt_and_webvtt_forms() {
        assert_eq!(parse_timing("00:01:02,345 --> 00:01:04,000"), Some((62_345, 64_000)));
        assert_eq!(parse_timing("01:02.5 --> 01:04.25 position:10% align:start"), Some((62_500, 64_250)));
        assert_eq!(parse_timing("01:00:00.000 --> 01:00:01.000"), Some((3_600_000, 3_601_000)));
        for bad in [
            "",
            "00:01 --> 00:02",
            "00:01:02,345 -> 00:01:04,000",
            "00:00:05,000 --> 00:00:04,000",
            "00:00:05,000 --> 00:00:05,000",
            "ab:cd:ef,000 --> 00:00:09,000",
            "00:00:01,0000 --> 00:00:09,000",
        ] {
            assert_eq!(parse_timing(bad), None, "{bad}");
        }
        assert_eq!(parse_timing("00:00:01,000 --> 05:00:00,000"), Some((1000, 31_000)), "a cue is cut at the duration cap");
        assert_eq!(parse_timing("99:00:00,000 --> 99:00:01,000"), None, "starts past 48 hours are refused");
    }

    #[test]
    fn markup_and_hidden_characters_are_stripped() {
        assert_eq!(clean_text("<i>Hello</i> <font color=\"#f00\">there</font>"), "Hello there");
        assert_eq!(clean_text("{\\an8}{\\pos(1,2)}Top line\\NSecond"), "Top line\nSecond");
        assert_eq!(clean_text("a &amp; b &lt;3 &quot;x&quot;"), "a & b <3 \"x\"");
        assert_eq!(clean_text("1 < 2 and 3 > 2"), "1 < 2 and 3 > 2", "a bare angle bracket is text");
        assert_eq!(clean_text("<script>alert(1)</script>Hi"), "alert(1)Hi");
        assert_eq!(clean_text("a\u{202e}b\u{200b}c\u{0}d\u{7}"), "abcd");
        assert_eq!(clean_text("<b></b>  \n \n"), "");
        assert_eq!(clean_text("1\n2\n3\n4\n5\n6"), "1\n2\n3\n4");
        assert_eq!(clean_text(&"x".repeat(1000)).chars().count(), MAX_CUE_CHARS);
        // Unclosed openers cost one pass, not one pass each.
        let started = std::time::Instant::now();
        assert_eq!(strip_markup(&"<a".repeat(200_000)).chars().count(), 400_000);
        assert_eq!(clean_text(&"<a{".repeat(1_000_000)).chars().count(), MAX_CUE_CHARS);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn srt_and_webvtt_files_parse_and_other_formats_do_not() {
        let srt = "\u{feff}1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hi</i>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nTwo\r\nlines\r\n\r\n3\r\n00:00:00,500 --> 00:00:00,900\r\nFirst\r\n";
        let cues = parse(srt, 100);
        assert_eq!(
            cues.iter().map(|c| (c.start_ms, c.end_ms, c.text.as_str())).collect::<Vec<_>>(),
            [(500, 900, "First"), (1000, 2500, "Hi"), (3000, 4000, "Two\nlines")]
        );
        let vtt = "WEBVTT\n\nNOTE a comment\n\nintro\n00:01.000 --> 00:02.000 line:90%\n<v Bob>Hello\n\n00:03.000 --> 00:04.000\nBye\n";
        assert_eq!(parse(vtt, 100).iter().map(|c| c.text.as_str()).collect::<Vec<_>>(), ["Hello", "Bye"]);
        assert_eq!(parse(srt, 2).len(), 2, "capped");
        assert!(parse("[Script Info]\nTitle: x\n\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi", 100).is_empty());
        assert!(parse("just some text\n\nmore text", 100).is_empty());
    }

    #[test]
    fn a_block_is_one_cue() {
        let cue = parse_block("7\n00:00:01.000 --> 00:00:02.000\nHi").expect("cue");
        assert_eq!((cue.start_ms, cue.end_ms, cue.text.as_str()), (1000, 2000, "Hi"));
        assert!(parse_block("WEBVTT").is_none() && parse_block("00:00:01.000 --> 00:00:02.000\n<i></i>").is_none());
    }
}
