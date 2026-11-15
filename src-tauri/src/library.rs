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

/// How many songs are delivered together while a scan streams its results.
const BATCH: usize = 25;

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
    scan_folder_streaming(root, cancel, known, removed, on_progress, |_| {})
}

/// Like [`scan_folder_with`], and also hands over the songs in batches (in no
/// particular order) as their tags are read, so a list can fill in while the
/// scan is still running. Every song of the result is delivered exactly once.
pub fn scan_folder_streaming(
    root: &Path,
    cancel: &AtomicBool,
    known: &Known,
    removed: &Removed,
    on_progress: impl Fn(ScanProgress) + Sync,
    on_tracks: impl Fn(Vec<Track>) + Sync,
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
            // A working copy left behind by an interrupted tag edit.
            && !entry.file_name().to_string_lossy().contains(".mixtape-tmp.")
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
    let pending = std::sync::Mutex::new(Vec::<Track>::new());
    let read: Vec<Option<CachedTrack>> = files
        .par_iter()
        .map(|(path, modified_ms, size)| {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let key = path.to_string_lossy();
            let previous = known.get(key.as_ref());
            let reused = previous.filter(|c| c.modified_ms == *modified_ms && c.size == *size).cloned();
            let cached = reused.or_else(|| {
                read_track(path).map(|mut track| {
                    // A retagged file keeps the date it was first added.
                    if let Some(p) = previous.filter(|p| p.track.added_ms > 0) {
                        track.added_ms = p.track.added_ms;
                    }
                    CachedTrack { modified_ms: *modified_ms, size: *size, track }
                })
            });
            // Libraries cached before dates existed get theirs from the file.
            let cached = cached.map(|mut c| {
                if c.track.added_ms == 0 {
                    c.track.added_ms = crate::track::added_ms(path);
                }
                c
            });
            if let Some(c) = &cached {
                let mut waiting = pending.lock().unwrap();
                waiting.push(c.track.clone());
                if waiting.len() >= BATCH {
                    let batch = std::mem::take(&mut *waiting);
                    drop(waiting);
                    on_tracks(batch);
                }
            }
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
    let rest = std::mem::take(&mut *pending.lock().unwrap());
    if !rest.is_empty() {
        on_tracks(rest);
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

/// Re-checks some folders of the library and brings `cached` up to date with them, without scanning anything else.
/// Returns each folder with the songs found in it now.
///
/// - A folder that is no longer there (renamed or moved, for example by Picard) has its songs dropped from `cached`: they
///   are not where they were. Where they went is found by refreshing a folder above it.
/// - A folder outside `root`, or `root` itself, is ignored: this is for small, targeted checks, never a full rescan.
/// - When `root` itself is missing nothing is touched, so an unmounted drive cannot wipe the library.
pub fn refresh_dirs(
    root: &Path,
    cached: &mut Vec<CachedTrack>,
    dirs: &[std::path::PathBuf],
    known: &Known,
    removed: &Removed,
) -> Result<Vec<(std::path::PathBuf, Vec<CachedTrack>)>, String> {
    if !root.is_dir() {
        return Err(format!("{} is not available. Is the drive mounted?", root.display()));
    }
    let never = AtomicBool::new(false);
    let mut out = Vec::new();
    for dir in dirs {
        if !dir.starts_with(root) || dir == root {
            continue;
        }
        let scanned = if dir.is_dir() { scan_folder_with(dir, &never, known, removed, |_| {}).unwrap_or_default() } else { Vec::new() };
        merge_folder(cached, dir, scanned.clone());
        out.push((dir.clone(), scanned));
    }
    Ok(out)
}

/// Replaces everything in `cache` under `dir` with `scanned` (a fresh scan of
/// that folder): songs that were renamed, retagged or deleted there are
/// updated or dropped, new ones are added, and the rest of the library is untouched.
pub fn merge_folder(cache: &mut Vec<CachedTrack>, dir: &Path, scanned: Vec<CachedTrack>) {
    cache.retain(|c| !Path::new(&c.track.path).starts_with(dir));
    cache.extend(scanned);
    sort_cached(cache);
}

/// Puts cached tracks in the order a scan produces: artist, album, disc, track, path.
pub fn sort_cached(tracks: &mut [CachedTrack]) {
    tracks.sort_by(|a, b| sort_key(&a.track).cmp(&sort_key(&b.track)));
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
    fn streams_every_song_exactly_once_in_batches() {
        use std::sync::Mutex;
        let dir = tempfile::tempdir().unwrap();
        for i in 0..60 {
            write_wav(&dir.path().join(format!("{i:02}.wav")), 0.1);
        }
        let batches = Mutex::new(Vec::<Vec<Track>>::new());

        let result = scan_folder_streaming(
            dir.path(),
            &AtomicBool::new(false),
            &Known::new(),
            &Removed::new(),
            |_| {},
            |batch| batches.lock().unwrap().push(batch),
        )
        .unwrap();

        let batches = batches.into_inner().unwrap();
        assert!(batches.len() >= 2, "arrives in more than one piece");
        assert!(batches.iter().all(|b| b.len() <= BATCH));
        let mut streamed: Vec<String> = batches.into_iter().flatten().map(|t| t.path).collect();
        let mut expected: Vec<String> = result.into_iter().map(|c| c.track.path).collect();
        streamed.sort();
        expected.sort();
        assert_eq!(streamed, expected);
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
        tagged_wav(&dir.path().join("edit.wav"), "Newer", "A", 2); // longer, so the size changes even if the clock does not
        std::fs::write(dir.path().join("added.wav"), b"").unwrap();
        write_wav(&dir.path().join("added.wav"), 0.5);

        let second = scan_folder_with(dir.path(), &AtomicBool::new(false), &known, &Removed::new(), |_| {}).unwrap();

        let by_name = |n: &str| second.iter().find(|c| c.track.path.ends_with(n)).unwrap();
        assert_eq!(by_name("keep.wav").track.title, "FROM CACHE");
        assert_eq!(by_name("edit.wav").track.artist, "Newer");
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
    fn merging_a_rescanned_folder_updates_renames_and_deletions_only_there() {
        let entry = |path: &str, title: &str| CachedTrack {
            modified_ms: 1,
            size: 1,
            track: Track { path: path.into(), title: title.into(), artist: "A".into(), album: "B".into(), album_artist: String::new(), track_number: None, disc_number: None, year: None, genre: String::new(), duration_ms: 1, added_ms: 0, has_cover: false, has_lyrics: false },
        };
        let mut cache = vec![
            entry("/lib/A/B/old name.mp3", "Old"),
            entry("/lib/A/B/stays.mp3", "Stays"),
            entry("/lib/A/B/gone.mp3", "Gone"),
            entry("/lib/Other/C/x.mp3", "Elsewhere"),
            entry("/lib/A/Bonus/y.mp3", "Prefix lookalike"),
        ];

        // After Picard: "old name" was renamed and retagged, "gone" is gone, "stays" unchanged, one new.
        merge_folder(&mut cache, Path::new("/lib/A/B"), vec![entry("/lib/A/B/1-01 New Name.mp3", "New"), entry("/lib/A/B/stays.mp3", "Stays")]);

        let mut paths: Vec<_> = cache.iter().map(|c| c.track.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["/lib/A/B/1-01 New Name.mp3", "/lib/A/B/stays.mp3", "/lib/A/Bonus/y.mp3", "/lib/Other/C/x.mp3"]);
    }

    #[test]
    fn missing_folder_yields_no_tracks() {
        assert!(scan_folder(Path::new("/definitely/not/here")).is_empty());
    }

    fn song(path: &Path) -> CachedTrack {
        crate::track::test_support::write_wav(path, 0.2);
        CachedTrack { modified_ms: 0, size: 0, track: read_track(path).unwrap() }
    }

    /// root/Primus/Old Album/a.wav, root/Primus/Other/b.wav, root/Zed/z.wav, all in the saved list.
    fn library_on_disk() -> (tempfile::TempDir, Vec<CachedTrack>) {
        let dir = tempfile::tempdir().unwrap();
        let mut cached = Vec::new();
        for rel in ["Primus/Old Album/a.wav", "Primus/Other/b.wav", "Zed/z.wav"] {
            let path = dir.path().join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            cached.push(song(&path));
        }
        (dir, cached)
    }

    #[test]
    fn a_folder_that_is_gone_loses_its_songs_and_the_artist_folder_finds_where_they_went() {
        let (dir, mut cached) = library_on_disk();
        let root = dir.path();
        // Picard renames the album folder.
        std::fs::rename(root.join("Primus/Old Album"), root.join("Primus/New Album")).unwrap();

        // The old folder alone: its songs are dropped (they are not there), nothing new is found.
        let old = [root.join("Primus/Old Album")];
        let found = refresh_dirs(root, &mut cached, &old, &Known::new(), &Removed::new()).unwrap();
        assert!(found[0].1.is_empty());
        assert!(!cached.iter().any(|c| c.track.path.contains("Old Album")));

        // The artist folder: finds the renamed folder and its song, and leaves the other artist alone.
        let artist = [root.join("Primus")];
        let found = refresh_dirs(root, &mut cached, &artist, &Known::new(), &Removed::new()).unwrap();
        assert_eq!(found[0].1.len(), 2);
        let paths: Vec<&str> = cached.iter().map(|c| c.track.path.as_str()).collect();
        assert!(paths.iter().any(|p| p.ends_with("Primus/New Album/a.wav")));
        assert!(paths.iter().any(|p| p.ends_with("Zed/z.wav")));
        assert_eq!(cached.len(), 3);
    }

    #[test]
    fn a_song_added_next_to_the_saved_ones_is_found_by_refreshing_only_its_folder() {
        let (dir, mut cached) = library_on_disk();
        let root = dir.path();
        crate::track::test_support::write_wav(&root.join("Primus/Other/new.wav"), 0.2);
        // And something unsaved elsewhere, which this refresh must not look at.
        crate::track::test_support::write_wav(&root.join("Zed/unsaved.wav"), 0.2);

        refresh_dirs(root, &mut cached, &[root.join("Primus/Other")], &Known::new(), &Removed::new()).unwrap();

        assert!(cached.iter().any(|c| c.track.path.ends_with("Primus/Other/new.wav")));
        assert!(!cached.iter().any(|c| c.track.path.ends_with("unsaved.wav")), "only the asked-for folder was scanned");
        assert_eq!(cached.len(), 4);
    }

    #[test]
    fn the_library_root_and_outside_folders_are_ignored_so_this_is_never_a_full_rescan() {
        let (dir, mut cached) = library_on_disk();
        let outside = tempfile::tempdir().unwrap();
        let found = refresh_dirs(dir.path(), &mut cached, &[dir.path().to_path_buf(), outside.path().to_path_buf()], &Known::new(), &Removed::new()).unwrap();
        assert!(found.is_empty());
        assert_eq!(cached.len(), 3);
    }

    #[test]
    fn an_unavailable_library_is_an_error_and_nothing_is_dropped() {
        let (_dir, mut cached) = library_on_disk();
        let missing = Path::new("/Volumes/not-mounted/Music");
        let err = refresh_dirs(missing, &mut cached, &[missing.join("Primus")], &Known::new(), &Removed::new()).unwrap_err();
        assert!(err.contains("Is the drive mounted?"));
        assert_eq!(cached.len(), 3);
    }
}
