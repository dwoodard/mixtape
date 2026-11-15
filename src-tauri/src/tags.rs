//! Editing the tags of audio files. Writes go to a temporary copy that is
//! read back and checked before it replaces the original, so a failed write
//! can never leave a damaged file behind.

use crate::track::{is_audio_file, read_track, Track};
use lofty::config::WriteOptions;
use lofty::file::{FileType, TaggedFileExt};
use lofty::tag::items::Timestamp;
use lofty::tag::{Accessor, ItemKey, Tag, TagExt};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Which fields to change. `None` leaves a field as it is, `Some("")` clears
/// it, and anything else sets it. Numbers are given as text so the UI can
/// pass what was typed.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TagEdit {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_number: Option<String>,
    pub disc_number: Option<String>,
    pub year: Option<String>,
    pub genre: Option<String>,
}

impl TagEdit {
    pub fn is_empty(&self) -> bool {
        *self == TagEdit::default()
    }

    /// Checks the numeric fields so a bad value is rejected before any file is touched.
    pub fn validate(&self) -> Result<(), String> {
        number(self.track_number.as_deref(), "Track", u32::MAX)?;
        number(self.disc_number.as_deref(), "Disc", u32::MAX)?;
        number(self.year.as_deref(), "Year", 9999)?;
        Ok(())
    }
}

/// `None`: leave as is. `Some(None)`: clear. `Some(Some(n))`: set.
fn number(text: Option<&str>, label: &str, max: u32) -> Result<Option<Option<u32>>, String> {
    let Some(text) = text else { return Ok(None) };
    let text = text.trim();
    if text.is_empty() {
        return Ok(Some(None));
    }
    match text.parse::<u32>() {
        Ok(n) if n <= max => Ok(Some(Some(n))),
        _ => Err(format!("{label} must be a whole number{}.", if max == 9999 { " between 0 and 9999" } else { "" })),
    }
}

fn apply(tag: &mut Tag, edit: &TagEdit) -> Result<(), String> {
    fn text(value: &Option<String>) -> Option<Option<String>> {
        value.as_ref().map(|v| Some(v.trim().to_string()).filter(|v| !v.is_empty()))
    }
    if let Some(v) = text(&edit.title) {
        match v { Some(v) => tag.set_title(v), None => tag.remove_title() }
    }
    if let Some(v) = text(&edit.artist) {
        match v { Some(v) => tag.set_artist(v), None => tag.remove_artist() }
    }
    if let Some(v) = text(&edit.album) {
        match v { Some(v) => tag.set_album(v), None => tag.remove_album() }
    }
    if let Some(v) = text(&edit.genre) {
        match v { Some(v) => tag.set_genre(v), None => tag.remove_genre() }
    }
    if let Some(v) = text(&edit.album_artist) {
        match v {
            Some(v) => {
                tag.insert_text(ItemKey::AlbumArtist, v);
            }
            None => tag.remove_key(ItemKey::AlbumArtist),
        }
    }
    if let Some(v) = number(edit.track_number.as_deref(), "Track", u32::MAX)? {
        match v { Some(n) => tag.set_track(n), None => tag.remove_track() }
    }
    if let Some(v) = number(edit.disc_number.as_deref(), "Disc", u32::MAX)? {
        match v { Some(n) => tag.set_disk(n), None => tag.remove_disk() }
    }
    if let Some(v) = number(edit.year.as_deref(), "Year", 9999)? {
        match v {
            Some(n) => tag.set_date(Timestamp { year: n as u16, ..Default::default() }),
            None => tag.remove_date(),
        }
    }
    Ok(())
}

/// Whether the track read back from the written copy has what was asked for.
fn matches(track: &Track, edit: &TagEdit) -> bool {
    let same = |want: &Option<String>, got: &str| want.as_ref().is_none_or(|w| w.trim().is_empty() || w.trim() == got);
    let num = |want: &Option<String>, got: Option<u32>| {
        number(want.as_deref(), "", u32::MAX).ok().flatten().is_none_or(|w| w == got)
    };
    // A cleared title falls back to the file name, so it is not compared.
    same(&edit.title, &track.title)
        && same(&edit.artist, &track.artist)
        && same(&edit.album, &track.album)
        && same(&edit.album_artist, &track.album_artist)
        && same(&edit.genre, &track.genre)
        && num(&edit.track_number, track.track_number)
        && num(&edit.disc_number, track.disc_number)
        && num(&edit.year, track.year.map(u32::from))
}

/// A hidden sibling of `path` for the working copy. It keeps the real
/// extension, because the tag library decides the file type from it.
fn temp_path(path: &Path) -> PathBuf {
    let stem = path.file_stem().and_then(|n| n.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    path.with_file_name(format!(".{stem}.mixtape-tmp.{ext}"))
}

/// Applies `edit` to the file at `path` and returns the track as re-read from
/// disk. The original is only replaced after the edited copy has been read
/// back and confirmed to have the new tags and the same audio length.
pub fn write_tags(path: &Path, edit: &TagEdit) -> Result<Track, String> {
    if !path.is_absolute() || !is_audio_file(path) {
        return Err("Not an audio file path.".into());
    }
    edit.validate()?;
    if edit.is_empty() {
        return Err("Nothing to change.".into());
    }
    let before = read_track(path).ok_or("Can't read this file.")?;

    let temp = temp_path(path);
    let result = (|| -> Result<(), String> {
        crate::fsutil::copy_data(path, &temp).map_err(|e| format!("Couldn't make a working copy: {e}"))?;
        let tagged = lofty::read_from_path(&temp).map_err(|e| e.to_string())?;
        let file_type: FileType = tagged.file_type();
        let mut tag = tagged
            .primary_tag()
            .cloned()
            .unwrap_or_else(|| Tag::new(file_type.primary_tag_type()));
        apply(&mut tag, edit)?;
        tag.save_to_path(&temp, WriteOptions::default()).map_err(|e| e.to_string())?;

        let after = read_track(&temp).ok_or("The edited copy could not be read back.")?;
        if !matches(&after, edit) {
            return Err("The edited copy did not contain the new tags, so nothing was changed.".into());
        }
        if after.duration_ms.abs_diff(before.duration_ms) > 100 {
            return Err("The audio length changed, so nothing was changed.".into());
        }
        std::fs::rename(&temp, path).map_err(|e| format!("Couldn't replace the original: {e}"))
    })();

    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }
    let mut track = read_track(path).ok_or_else(|| "Saved, but the file could not be read back.".to_string())?;
    // The swap gave the file a new creation time; it was added when the original was.
    track.added_ms = before.added_ms;
    Ok(track)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(dir: &Path, ext: &str) -> PathBuf {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/tone.{ext}"));
        let path = dir.join(format!("song.{ext}"));
        std::fs::copy(source, &path).unwrap();
        path
    }

    fn edit() -> TagEdit {
        TagEdit {
            title: Some("New Title".into()),
            artist: Some("New Artist".into()),
            album: Some("New Album".into()),
            album_artist: Some("Album Artist".into()),
            track_number: Some("7".into()),
            disc_number: Some("2".into()),
            year: Some("1995".into()),
            genre: Some("Ska".into()),
        }
    }

    #[test]
    fn writes_every_field_in_every_supported_format() {
        for ext in ["mp3", "flac", "m4a", "ogg"] {
            let dir = tempfile::tempdir().unwrap();
            let path = fixture(dir.path(), ext);

            let track = write_tags(&path, &edit()).unwrap_or_else(|e| panic!("{ext}: {e}"));

            assert_eq!(track.title, "New Title", "{ext}");
            assert_eq!(track.artist, "New Artist", "{ext}");
            assert_eq!(track.album, "New Album", "{ext}");
            assert_eq!(track.album_artist, "Album Artist", "{ext}");
            assert_eq!(track.track_number, Some(7), "{ext}");
            assert_eq!(track.disc_number, Some(2), "{ext}");
            assert_eq!(track.year, Some(1995), "{ext}");
            assert_eq!(track.genre, "Ska", "{ext}");
            // The file on disk really has them, not just the returned value.
            assert_eq!(read_track(&path).unwrap().artist, "New Artist", "{ext}");
        }
    }

    /// Edits tags in place in a real folder given by `MIXTAPE_TEST_LIBRARY`
    /// (for example a scratch folder on a network share), to prove the working
    /// copy and swap work there. Run with
    /// `MIXTAPE_TEST_LIBRARY=/Volumes/x/scratch cargo test -- --ignored real_folder`.
    #[test]
    #[ignore]
    fn real_folder_accepts_an_in_place_tag_edit() {
        let root = PathBuf::from(std::env::var_os("MIXTAPE_TEST_LIBRARY").expect("set MIXTAPE_TEST_LIBRARY"));
        std::fs::create_dir_all(&root).unwrap();
        let path = fixture(&root, "mp3");

        let result = write_tags(&path, &edit());
        let leftovers: Vec<_> = std::fs::read_dir(&root).unwrap().filter_map(Result::ok).map(|e| e.file_name()).collect();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&root);

        let track = result.expect("edit on the real folder");
        assert_eq!(track.artist, "New Artist");
        assert_eq!(leftovers, vec![std::ffi::OsString::from("song.mp3")], "no working copy left behind");
    }

    #[test]
    fn only_the_fields_given_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture(dir.path(), "mp3");

        let track = write_tags(&path, &TagEdit { album: Some("Only This".into()), ..Default::default() }).unwrap();

        assert_eq!(track.album, "Only This");
        assert_eq!(track.title, "Fixture");
        assert_eq!(track.artist, "FixtureArtist");
        assert_eq!(track.track_number, Some(3));
    }

    #[test]
    fn an_empty_string_clears_a_field() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture(dir.path(), "flac");

        let track = write_tags(
            &path,
            &TagEdit { artist: Some("".into()), track_number: Some("  ".into()), ..Default::default() },
        )
        .unwrap();

        assert_eq!(track.artist, "");
        assert_eq!(track.track_number, None);
        assert_eq!(track.album, "FixtureAlbum");
    }

    #[test]
    fn the_audio_length_is_unchanged_and_no_temp_file_is_left() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture(dir.path(), "mp3");
        let before = read_track(&path).unwrap().duration_ms;

        let after = write_tags(&path, &edit()).unwrap().duration_ms;

        assert!(after.abs_diff(before) <= 100);
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["song.mp3"]);
    }

    #[test]
    fn bad_numbers_are_rejected_before_the_file_is_touched() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture(dir.path(), "mp3");
        let original = std::fs::read(&path).unwrap();

        for bad in [
            TagEdit { track_number: Some("seven".into()), ..Default::default() },
            TagEdit { year: Some("10000".into()), ..Default::default() },
            TagEdit { disc_number: Some("-1".into()), ..Default::default() },
        ] {
            assert!(write_tags(&path, &bad).is_err());
        }
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[test]
    fn rejects_empty_edits_relative_paths_non_audio_and_unreadable_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture(dir.path(), "mp3");
        assert!(write_tags(&path, &TagEdit::default()).is_err());
        assert!(write_tags(Path::new("song.mp3"), &edit()).is_err());

        let notes = dir.path().join("notes.txt");
        std::fs::write(&notes, "x").unwrap();
        assert!(write_tags(&notes, &edit()).is_err());

        let junk = dir.path().join("junk.mp3");
        std::fs::write(&junk, b"not audio").unwrap();
        assert!(write_tags(&junk, &edit()).is_err());
        assert_eq!(std::fs::read(&junk).unwrap(), b"not audio");
    }

    #[test]
    fn a_failed_write_leaves_the_original_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture(dir.path(), "mp3");
        let original = std::fs::read(&path).unwrap();
        // Make the temp location unusable so the working copy cannot be created.
        std::fs::create_dir(temp_path(&path)).unwrap();

        assert!(write_tags(&path, &edit()).is_err());

        assert_eq!(std::fs::read(&path).unwrap(), original);
    }
}
