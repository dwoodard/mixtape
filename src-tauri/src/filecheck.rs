//! Checks a song's file against what the library says about it, so a wrong length (or an unreadable file) can be found
//! and explained instead of guessed at.

use crate::importer::find_tool;
use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// What ffprobe says about the audio itself, read from its structure and not from the tags.
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub duration_ms: u64,
    pub bitrate_kbps: Option<u32>,
    pub codec: Option<String>,
    pub sample_rate: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    /// The library's length matches the file.
    Ok,
    /// The file plays for a different time than the library says.
    LengthWrong,
    /// No second opinion was available, but the numbers cannot be right for audio.
    LooksWrong,
    /// No second opinion was available, and nothing looks off.
    CannotCheck,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCheck {
    pub path: String,
    pub size_bytes: u64,
    /// The length the library holds.
    pub stored_ms: u64,
    /// The length the file really plays for, when ffprobe is installed.
    pub real_ms: Option<u64>,
    pub codec: Option<String>,
    pub bitrate_kbps: Option<u32>,
    pub sample_rate: Option<u32>,
    /// The bitrate the stored length would mean for this file's size. Absurd values give a wrong length away.
    pub implied_kbps: Option<u32>,
    pub verdict: Verdict,
    pub notes: Vec<String>,
}

/// Reads ffprobe's `-of json` answer (format duration and bit rate, first audio stream).
pub fn parse_probe(json: &str) -> Option<Probe> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    // ffprobe writes numbers as strings.
    let number = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str().map(str::to_owned).or_else(|| v.as_f64().map(|f| f.to_string())));
    let format = value.get("format")?;
    let seconds: f64 = number(format.get("duration"))?.parse().ok()?;
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    let stream = value.get("streams").and_then(|s| s.get(0));
    Some(Probe {
        duration_ms: (seconds * 1000.0).round() as u64,
        bitrate_kbps: number(format.get("bit_rate")).and_then(|b| b.parse::<f64>().ok()).map(|b| (b / 1000.0).round() as u32),
        codec: stream.and_then(|s| s.get("codec_name")).and_then(|c| c.as_str()).map(str::to_owned),
        sample_rate: number(stream.and_then(|s| s.get("sample_rate"))).and_then(|r| r.parse().ok()),
    })
}

fn clock(ms: u64) -> String {
    let s = ms / 1000;
    format!("{}:{:02}", s / 60, s % 60)
}

/// Decides whether the stored length is right, from the file size and what ffprobe found (if it was run).
pub fn judge(size_bytes: u64, stored_ms: u64, probe: Option<&Probe>) -> (Verdict, Option<u32>, Vec<String>) {
    let implied_kbps = (stored_ms > 0).then(|| (size_bytes as f64 * 8.0 / stored_ms as f64).round() as u32);
    let mut notes = Vec::new();

    let Some(probe) = probe else {
        return match implied_kbps {
            Some(k) if !(48..=6000).contains(&k) => {
                notes.push(format!("A {} length would mean {k} kbps for this file, which is not plausible for music. ffprobe (part of ffmpeg) would confirm it.", clock(stored_ms)));
                (Verdict::LooksWrong, implied_kbps, notes)
            }
            _ => {
                notes.push("ffprobe is not installed, so the length could not be compared with the file. In a terminal: brew install ffmpeg".to_string());
                (Verdict::CannotCheck, implied_kbps, notes)
            }
        };
    };

    let tolerance = (probe.duration_ms / 50).max(2_000);
    if stored_ms.abs_diff(probe.duration_ms) > tolerance {
        let ratio = if probe.duration_ms > 0 { stored_ms as f64 / probe.duration_ms as f64 } else { 0.0 };
        notes.push(format!(
            "The library says {} but the file plays for {} ({ratio:.1}× as long).",
            clock(stored_ms),
            clock(probe.duration_ms)
        ));
        (Verdict::LengthWrong, implied_kbps, notes)
    } else {
        notes.push(format!("The library says {} and the file plays for {}.", clock(stored_ms), clock(probe.duration_ms)));
        (Verdict::Ok, implied_kbps, notes)
    }
}

/// Runs ffprobe on the file. None when it is not installed or cannot read the file.
fn probe(path: &Path) -> Option<Probe> {
    let tool = find_tool("ffprobe")?;
    let out = Command::new(tool)
        .args(["-v", "error", "-show_entries", "format=duration,bit_rate:stream=codec_name,sample_rate", "-of", "json", "-select_streams", "a:0"])
        .arg(path)
        .output()
        .ok()?;
    out.status.success().then(|| parse_probe(&String::from_utf8_lossy(&out.stdout))).flatten()
}

/// Checks `path` against the length the library holds for it.
pub fn inspect(path: &Path, stored_ms: u64) -> Result<FileCheck, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let found = probe(path);
    let (verdict, implied_kbps, notes) = judge(meta.len(), stored_ms, found.as_ref());
    Ok(FileCheck {
        path: path.to_string_lossy().into_owned(),
        size_bytes: meta.len(),
        stored_ms,
        real_ms: found.as_ref().map(|p| p.duration_ms),
        codec: found.as_ref().and_then(|p| p.codec.clone()),
        bitrate_kbps: found.as_ref().and_then(|p| p.bitrate_kbps),
        sample_rate: found.as_ref().and_then(|p| p.sample_rate),
        implied_kbps,
        verdict,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNY: &str = r#"{"streams":[{"codec_name":"mp3","sample_rate":"44100"}],"format":{"duration":"252.316735","bit_rate":"192000"}}"#;

    #[test]
    fn reads_what_ffprobe_says() {
        assert_eq!(
            parse_probe(KNY),
            Some(Probe { duration_ms: 252_317, bitrate_kbps: Some(192), codec: Some("mp3".into()), sample_rate: Some(44_100) })
        );
    }

    #[test]
    fn no_duration_or_bad_json_is_no_probe() {
        assert_eq!(parse_probe(r#"{"format":{}}"#), None);
        assert_eq!(parse_probe(r#"{"format":{"duration":"0"}}"#), None);
        assert_eq!(parse_probe("not json"), None);
    }

    #[test]
    fn a_length_six_times_too_long_is_found_and_explained() {
        // The real case: a 6 MB, 192 kbps song the library said was 25:13 long.
        let probe = parse_probe(KNY).unwrap();
        let (verdict, implied, notes) = judge(6_094_087, 1_513_926, Some(&probe));
        assert_eq!(verdict, Verdict::LengthWrong);
        assert_eq!(implied, Some(32), "which would be 32 kbps, not a real MP3");
        assert!(notes[0].contains("25:13") && notes[0].contains("4:12") && notes[0].contains("6.0×"), "{notes:?}");
    }

    #[test]
    fn a_matching_length_is_fine_within_a_small_tolerance() {
        let probe = parse_probe(KNY).unwrap();
        assert_eq!(judge(6_094_087, 252_000, Some(&probe)).0, Verdict::Ok);
        assert_eq!(judge(6_094_087, 254_000, Some(&probe)).0, Verdict::Ok, "under two seconds off");
        assert_eq!(judge(6_094_087, 270_000, Some(&probe)).0, Verdict::LengthWrong);
    }

    #[test]
    fn without_ffprobe_an_impossible_bitrate_still_looks_wrong() {
        assert_eq!(judge(6_094_087, 1_513_926, None).0, Verdict::LooksWrong);
        assert_eq!(judge(6_094_087, 252_000, None).0, Verdict::CannotCheck);
        assert_eq!(judge(6_094_087, 0, None).1, None, "no length, no bitrate to work out");
    }

    #[test]
    fn a_missing_file_is_a_readable_error() {
        let err = inspect(Path::new("/no/such/file.mp3"), 1000).unwrap_err();
        assert!(err.starts_with("Cannot read /no/such/file.mp3"), "{err}");
    }
}
