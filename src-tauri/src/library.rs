use crate::track::{is_audio_file, read_track, Track};
use rayon::prelude::*;
use std::path::Path;
use walkdir::WalkDir;

/// Recursively scans `root` for audio files and reads their tags.
/// Files that cannot be parsed are skipped. The result is ordered by
/// album artist/artist, album, disc, track, then path.
pub fn scan_folder(root: &Path) -> Vec<Track> {
    let paths: Vec<_> = WalkDir::new(root)
        .follow_links(true)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && is_audio_file(e.path()))
        .map(|e| e.into_path())
        .collect();

    let mut tracks: Vec<Track> = paths.par_iter().filter_map(|p| read_track(p)).collect();
    tracks.sort_by(|a, b| sort_key(a).cmp(&sort_key(b)));
    tracks
}

fn sort_key(t: &Track) -> (String, String, u32, u32, String) {
    let artist = if t.album_artist.is_empty() { &t.artist } else { &t.album_artist };
    (
        artist.to_lowercase(),
        t.album.to_lowercase(),
        t.disc_number.unwrap_or(0),
        t.track_number.unwrap_or(0),
        t.path.to_lowercase(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::track::test_support::write_wav;
    use lofty::config::WriteOptions;
    use lofty::tag::{Accessor, Tag, TagExt, TagType};

    fn tagged_wav(path: &Path, artist: &str, album: &str, track: u32) {
        write_wav(path, 0.5);
        let mut tag = Tag::new(TagType::RiffInfo);
        tag.set_artist(artist.into());
        tag.set_album(album.into());
        tag.set_track(track);
        tag.save_to_path(path, WriteOptions::default()).unwrap();
    }

    #[test]
    fn finds_audio_recursively_and_ignores_other_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("Artist/Album")).unwrap();
        write_wav(&dir.path().join("top.wav"), 0.5);
        write_wav(&dir.path().join("Artist/Album/deep.wav"), 0.5);
        std::fs::write(dir.path().join("cover.jpg"), b"jpg").unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"hi").unwrap();
        std::fs::write(dir.path().join("broken.mp3"), b"not audio").unwrap();

        let tracks = scan_folder(dir.path());

        let mut titles: Vec<_> = tracks.iter().map(|t| t.title.as_str()).collect();
        titles.sort();
        assert_eq!(titles, vec!["deep", "top"]);
    }

    #[test]
    fn orders_by_artist_album_then_track_number() {
        let dir = tempfile::tempdir().unwrap();
        tagged_wav(&dir.path().join("a.wav"), "Beta", "Album", 2);
        tagged_wav(&dir.path().join("b.wav"), "Beta", "Album", 1);
        tagged_wav(&dir.path().join("c.wav"), "alpha", "Zed", 9);

        let tracks = scan_folder(dir.path());

        let order: Vec<_> = tracks
            .iter()
            .map(|t| (t.artist.as_str(), t.track_number.unwrap()))
            .collect();
        assert_eq!(order, vec![("alpha", 9), ("Beta", 1), ("Beta", 2)]);
    }

    #[test]
    fn missing_folder_yields_no_tracks() {
        assert!(scan_folder(Path::new("/definitely/not/here")).is_empty());
    }
}
