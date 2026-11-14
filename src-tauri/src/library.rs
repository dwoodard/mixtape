use crate::track::{is_audio_file, read_track, Track};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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

/// A track plus the file facts that tell us whether its tags can be reused.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CachedTrack {
    pub modified_ms: u64,
    pub size: u64,
    pub track: Track,
}

/// Previously read tracks by path.
pub type Known = HashMap<String, CachedTrack>;

/// Paths the user removed from the library. Scans leave them out.
pub type Removed = HashSet<String>;

/// Recursively scans `root` for audio files and reads their tags.
/// Files that cannot be parsed are skipped. The result is ordered by
/// album artist/artist, album, disc, track, then path.
pub fn scan_folder(root: &Path) -> Vec<Track> {
    scan_folder_with(root, &AtomicBool::new(false), &Known::new(), &Removed::new(), |_| {})
        .map(|cached| cached.into_iter().map(|c| c.track).collect())
        .unwrap_or_default()
}

/// Like [`scan_folder`], but reports progress, stops early when `cancel` is
/// set (returning `None`), and skips reading tags for files whose path,
/// modified time and size match an entry in `known`. Paths in `removed` are
/// left out. Unreadable directories are skipped.
pub fn scan_folder_with(
    root: &Path,
    cancel: &AtomicBool,
    known: &Known,
    removed: &Removed,
    on_progress: impl Fn(ScanProgress) + Sync,
) -> Option<Vec<CachedTrack>> {
    let mut files = Vec::new();
    let walker = WalkDir::new(root)
        .follow_links(true)
        .into_iter()
        // Duplicates moved aside by the clean-up are not part of the library.
        .filter_entry(|e| !(e.file_type().is_dir() && e.file_name() == crate::cleanup::HOLDING_DIR));
    for entry in walker.filter_map(Result::ok) {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        if entry.file_type().is_file()
            && is_audio_file(entry.path())
            && !removed.contains(entry.path().to_string_lossy().as_ref())
        {
            let (modified_ms, size) = entry
                .metadata()
                .map(|m| (modified_ms(&m), m.len()))
                .unwrap_or((0, 0));
            files.push((entry.into_path(), modified_ms, size));
            if files.len() % PROGRESS_EVERY == 0 {
                on_progress(ScanProgress { phase: ScanPhase::Discovering, done: files.len(), total: 0 });
            }
        }
    }

    let total = files.len();
    on_progress(ScanProgress { phase: ScanPhase::Reading, done: 0, total });
    let done = AtomicUsize::new(0);
    let read: Vec<Option<CachedTrack>> = files
        .par_iter()
        .map(|(path, modified_ms, size)| {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let key = path.to_string_lossy();
            let reused = known
                .get(key.as_ref())
                .filter(|c| c.modified_ms == *modified_ms && c.size == *size)
                .cloned();
            let cached = reused.or_else(|| {
                read_track(path).map(|track| CachedTrack { modified_ms: *modified_ms, size: *size, track })
            });
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            if n % PROGRESS_EVERY == 0 || n == total {
                on_progress(ScanProgress { phase: ScanPhase::Reading, done: n, total });
            }
            cached
        })
        .collect();
    if cancel.load(Ordering::Relaxed) {
        return None;
    }

    let mut tracks: Vec<CachedTrack> = read.into_iter().flatten().collect();
    tracks.sort_by(|a, b| sort_key(&a.track).cmp(&sort_key(&b.track)));
    Some(tracks)
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
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

        let tracks = scan_folder_with(dir.path(), &AtomicBool::new(false), &Known::new(), &Removed::new(), |p| {
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
        assert!(scan_folder_with(dir.path(), &AtomicBool::new(true), &Known::new(), &Removed::new(), |_| {}).is_none());
    }

    #[test]
    fn cancelling_from_the_progress_callback_stops_reading() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..60 {
            write_wav(&dir.path().join(format!("{i:02}.wav")), 0.1);
        }
        let cancel = AtomicBool::new(false);

        let result = scan_folder_with(dir.path(), &cancel, &Known::new(), &Removed::new(), |p| {
            if p.phase == ScanPhase::Reading && p.done >= 25 {
                cancel.store(true, Ordering::Relaxed);
            }
        });

        assert!(result.is_none());
    }

    #[test]
    fn unchanged_files_reuse_known_tags_and_changed_files_are_reread() {
        let dir = tempfile::tempdir().unwrap();
        tagged_wav(&dir.path().join("keep.wav"), "Keep", "A", 1);
        tagged_wav(&dir.path().join("edit.wav"), "Old", "A", 2);
        let first = scan_folder_with(dir.path(), &AtomicBool::new(false), &Known::new(), &Removed::new(), |_| {}).unwrap();
        let mut known: Known = first.into_iter().map(|c| (c.track.path.clone(), c)).collect();

        // Poison the cached copy of the unchanged file: if it is reused, the
        // poisoned title survives. Then change the other file on disk.
        known.get_mut(dir.path().join("keep.wav").to_str().unwrap()).unwrap().track.title =
            "FROM CACHE".into();
        tagged_wav(&dir.path().join("edit.wav"), "New", "A", 2);
        std::fs::write(dir.path().join("added.wav"), b"").unwrap();
        write_wav(&dir.path().join("added.wav"), 0.5);

        let second = scan_folder_with(dir.path(), &AtomicBool::new(false), &known, &Removed::new(), |_| {}).unwrap();

        let by_name = |n: &str| second.iter().find(|c| c.track.path.ends_with(n)).unwrap();
        assert_eq!(by_name("keep.wav").track.title, "FROM CACHE");
        assert_eq!(by_name("edit.wav").track.artist, "New");
        assert_eq!(second.len(), 3);
    }

    #[test]
    fn removed_paths_are_left_out_without_being_read() {
        let dir = tempfile::tempdir().unwrap();
        write_wav(&dir.path().join("keep.wav"), 0.2);
        write_wav(&dir.path().join("drop.wav"), 0.2);
        let removed: Removed =
            [dir.path().join("drop.wav").to_string_lossy().into_owned()].into_iter().collect();

        let tracks = scan_folder_with(dir.path(), &AtomicBool::new(false), &Known::new(), &removed, |_| {})
            .unwrap();

        assert_eq!(tracks.len(), 1);
        assert!(tracks[0].track.path.ends_with("keep.wav"));
    }

    #[test]
    fn the_duplicates_holding_folder_is_not_scanned() {
        let dir = tempfile::tempdir().unwrap();
        write_wav(&dir.path().join("keep.wav"), 0.2);
        let held = dir.path().join(crate::cleanup::HOLDING_DIR).join("2026-01-01-000000/Artist");
        std::fs::create_dir_all(&held).unwrap();
        write_wav(&held.join("old copy.wav"), 0.2);

        let tracks = scan_folder(dir.path());

        assert_eq!(tracks.len(), 1);
        assert!(tracks[0].path.ends_with("keep.wav"));
    }

    #[test]
    fn deleted_files_drop_out_of_the_result() {
        let dir = tempfile::tempdir().unwrap();
        write_wav(&dir.path().join("a.wav"), 0.2);
        write_wav(&dir.path().join("b.wav"), 0.2);
        let first = scan_folder_with(dir.path(), &AtomicBool::new(false), &Known::new(), &Removed::new(), |_| {}).unwrap();
        let known: Known = first.into_iter().map(|c| (c.track.path.clone(), c)).collect();
        std::fs::remove_file(dir.path().join("b.wav")).unwrap();

        let second = scan_folder_with(dir.path(), &AtomicBool::new(false), &known, &Removed::new(), |_| {}).unwrap();

        assert_eq!(second.len(), 1);
        assert!(second[0].track.path.ends_with("a.wav"));
    }

    #[test]
    fn missing_folder_yields_no_tracks() {
        assert!(scan_folder(Path::new("/definitely/not/here")).is_empty());
    }
}
