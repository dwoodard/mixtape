use crate::track::{is_audio_file, read_track, Track};
use rayon::prelude::*;
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use walkdir::WalkDir;

/// How far a scan has got. While `Discovering`, `total` is unknown (0) and
/// `done` counts audio files found so far. While `Reading`, `done` of `total`
/// files have had their tags read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub phase: ScanPhase,
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanPhase {
    Discovering,
    Reading,
}

/// Report progress at most this often (in files) so slow network shares and
/// huge libraries do not flood the UI.
const PROGRESS_EVERY: usize = 25;

/// Recursively scans `root` for audio files and reads their tags.
/// Files that cannot be parsed are skipped. The result is ordered by
/// album artist/artist, album, disc, track, then path.
pub fn scan_folder(root: &Path) -> Vec<Track> {
    scan_folder_with(root, &AtomicBool::new(false), |_| {}).unwrap_or_default()
}

/// Like [`scan_folder`], but reports progress and stops early when `cancel`
/// is set, returning `None`. Unreadable directories are skipped.
pub fn scan_folder_with(
    root: &Path,
    cancel: &AtomicBool,
    on_progress: impl Fn(ScanProgress) + Sync,
) -> Option<Vec<Track>> {
    let mut paths = Vec::new();
    for entry in WalkDir::new(root).follow_links(true).into_iter().filter_map(Result::ok) {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        if entry.file_type().is_file() && is_audio_file(entry.path()) {
            paths.push(entry.into_path());
            if paths.len() % PROGRESS_EVERY == 0 {
                on_progress(ScanProgress { phase: ScanPhase::Discovering, done: paths.len(), total: 0 });
            }
        }
    }

    let total = paths.len();
    on_progress(ScanProgress { phase: ScanPhase::Reading, done: 0, total });
    let done = AtomicUsize::new(0);
    let read: Vec<Option<Track>> = paths
        .par_iter()
        .map(|p| {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let track = read_track(p);
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            if n % PROGRESS_EVERY == 0 || n == total {
                on_progress(ScanProgress { phase: ScanPhase::Reading, done: n, total });
            }
            track
        })
        .collect();
    if cancel.load(Ordering::Relaxed) {
        return None;
    }

    let mut tracks: Vec<Track> = read.into_iter().flatten().collect();
    tracks.sort_by(|a, b| sort_key(a).cmp(&sort_key(b)));
    Some(tracks)
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
    fn reports_discovery_then_reading_progress_ending_at_total() {
        use std::sync::Mutex;
        let dir = tempfile::tempdir().unwrap();
        for i in 0..30 {
            write_wav(&dir.path().join(format!("{i:02}.wav")), 0.1);
        }
        let seen = Mutex::new(Vec::new());

        let tracks = scan_folder_with(dir.path(), &AtomicBool::new(false), |p| {
            seen.lock().unwrap().push(p)
        })
        .unwrap();

        assert_eq!(tracks.len(), 30);
        let seen = seen.into_inner().unwrap();
        assert!(seen.iter().any(|p| p.phase == ScanPhase::Discovering && p.done == 25));
        assert_eq!(
            seen.last().copied(),
            Some(ScanProgress { phase: ScanPhase::Reading, done: 30, total: 30 })
        );
    }

    #[test]
    fn cancelled_scan_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        write_wav(&dir.path().join("a.wav"), 0.1);
        assert!(scan_folder_with(dir.path(), &AtomicBool::new(true), |_| {}).is_none());
    }

    #[test]
    fn cancelling_from_the_progress_callback_stops_reading() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..60 {
            write_wav(&dir.path().join(format!("{i:02}.wav")), 0.1);
        }
        let cancel = AtomicBool::new(false);

        let result = scan_folder_with(dir.path(), &cancel, |p| {
            if p.phase == ScanPhase::Reading && p.done >= 25 {
                cancel.store(true, Ordering::Relaxed);
            }
        });

        assert!(result.is_none());
    }

    #[test]
    fn missing_folder_yields_no_tracks() {
        assert!(scan_folder(Path::new("/definitely/not/here")).is_empty());
    }
}
