use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::{Accessor, ItemKey};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// File extensions Mixtape scans for and can decode.
pub const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "m4a", "aac", "ogg", "oga", "wav"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub year: Option<u16>,
    pub genre: String,
    pub duration_ms: u64,
}

pub fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Reads tags and duration from an audio file. Returns `None` when the file
/// cannot be parsed as audio. Missing tags fall back to the file name for the
/// title and to empty strings elsewhere.
pub fn read_track(path: &Path) -> Option<Track> {
    let tagged = lofty::read_from_path(path).ok()?;
    let duration_ms = tagged.properties().duration().as_millis() as u64;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());

    let text = |value: Option<std::borrow::Cow<'_, str>>| {
        value.map(|v| v.trim().to_string()).unwrap_or_default()
    };

    let (title, artist, album, genre, album_artist, track_number, disc_number, year) = match tag {
        Some(tag) => (
            text(tag.title()),
            text(tag.artist()),
            text(tag.album()),
            text(tag.genre()),
            tag.get_string(ItemKey::AlbumArtist)
                .map(|v| v.trim().to_string())
                .unwrap_or_default(),
            tag.track(),
            tag.disk(),
            tag.date().map(|d| d.year),
        ),
        None => Default::default(),
    };

    let title = if title.is_empty() {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Unknown")
            .to_string()
    } else {
        title
    };

    Some(Track {
        path: path.to_string_lossy().into_owned(),
        title,
        artist,
        album,
        album_artist,
        track_number,
        disc_number,
        year,
        genre,
        duration_ms,
    })
}

#[cfg(test)]
pub mod test_support {
    use std::path::Path;

    /// Writes a mono 16-bit PCM WAV containing a quiet sine tone.
    pub fn write_wav(path: &Path, seconds: f32) {
        let sample_rate = 8000u32;
        let samples = (sample_rate as f32 * seconds) as u32;
        let data_len = samples * 2;
        let mut bytes = Vec::with_capacity(44 + data_len as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
        bytes.extend_from_slice(&1u16.to_le_bytes()); // mono
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..samples {
            let t = i as f32 / sample_rate as f32;
            let v = (t * 440.0 * std::f32::consts::TAU).sin() * 0.1;
            bytes.extend_from_slice(&((v * i16::MAX as f32) as i16).to_le_bytes());
        }
        std::fs::write(path, bytes).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::write_wav;
    use super::*;
    use lofty::config::WriteOptions;
    use lofty::tag::{Tag, TagExt, TagType};

    #[test]
    fn recognizes_audio_extensions_case_insensitively() {
        assert!(is_audio_file(Path::new("a/b.MP3")));
        assert!(is_audio_file(Path::new("c.flac")));
        assert!(!is_audio_file(Path::new("cover.jpg")));
        assert!(!is_audio_file(Path::new("noextension")));
    }

    #[test]
    fn untagged_file_falls_back_to_file_name_and_has_duration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Some Song.wav");
        write_wav(&path, 2.0);

        let track = read_track(&path).unwrap();

        assert_eq!(track.title, "Some Song");
        assert_eq!(track.artist, "");
        assert_eq!(track.track_number, None);
        assert!((1990..=2010).contains(&track.duration_ms), "{}", track.duration_ms);
    }

    #[test]
    fn reads_tags_from_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tagged.wav");
        write_wav(&path, 1.0);

        let mut tag = Tag::new(TagType::RiffInfo);
        tag.set_title("Tagged Title".into());
        tag.set_artist("The Artist".into());
        tag.set_album("The Album".into());
        tag.set_genre("Rock".into());
        tag.set_track(7);
        tag.save_to_path(&path, WriteOptions::default()).unwrap();

        let track = read_track(&path).unwrap();

        assert_eq!(track.title, "Tagged Title");
        assert_eq!(track.artist, "The Artist");
        assert_eq!(track.album, "The Album");
        assert_eq!(track.genre, "Rock");
        assert_eq!(track.track_number, Some(7));
    }

    #[test]
    fn unreadable_file_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.mp3");
        std::fs::write(&path, b"this is not audio").unwrap();

        assert!(read_track(&path).is_none());
    }
}
