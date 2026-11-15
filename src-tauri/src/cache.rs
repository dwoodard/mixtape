//! On-disk library cache: the last scan of each library folder, so the app
//! can show the library at launch without reading any tags.

use crate::library::{CachedTrack, Known, Removed};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Bump when the cached shape changes; older files are then ignored.
const VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCache {
    version: u32,
    pub root: String,
    pub scanned_at_ms: u64,
    pub tracks: Vec<CachedTrack>,
}

impl LibraryCache {
    pub fn new(root: &Path, tracks: Vec<CachedTrack>) -> Self {
        let scanned_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        LibraryCache { version: VERSION, root: root.to_string_lossy().into_owned(), scanned_at_ms, tracks }
    }

    pub fn known(&self) -> Known {
        self.tracks.iter().map(|c| (c.track.path.clone(), c.clone())).collect()
    }
}

/// Stable (across Rust versions) hash of a library root, for file names.
fn root_hash(root: &Path) -> String {
    let mut hash: u64 = 0xcbf29ce484222325; // FNV-1a
    for byte in root.to_string_lossy().bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[derive(Clone)]
pub struct CacheDir(pub PathBuf);

impl CacheDir {
    fn cache_path(&self, root: &Path) -> PathBuf {
        self.0.join(format!("library-{}.json", root_hash(root)))
    }

    fn removed_path(&self, root: &Path) -> PathBuf {
        self.0.join(format!("removed-{}.json", root_hash(root)))
    }

    fn last_root_path(&self) -> PathBuf {
        self.0.join("last-root.txt")
    }

    /// The cache for `root`, or `None` if missing, unreadable, or from another version.
    pub fn load(&self, root: &Path) -> Option<LibraryCache> {
        let text = std::fs::read_to_string(self.cache_path(root)).ok()?;
        let cache: LibraryCache = serde_json::from_str(&text).ok()?;
        (cache.version == VERSION && cache.root == root.to_string_lossy()).then_some(cache)
    }

    /// Writes the cache atomically and remembers `root` as the last scanned folder.
    pub fn save(&self, cache: &LibraryCache) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.0)?;
        let root = Path::new(&cache.root);
        let path = self.cache_path(root);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(cache).map_err(std::io::Error::other)?)?;
        std::fs::rename(&tmp, &path)?;
        std::fs::write(self.last_root_path(), &cache.root)
    }

    /// Replaces cached entries (matched by path) with freshly read ones, for
    /// example after tags were edited, so the saved library shows the change.
    pub fn update_tracks(&self, root: &Path, updated: Vec<CachedTrack>) -> std::io::Result<()> {
        let Some(mut cache) = self.load(root) else { return Ok(()) };
        for new in updated {
            if let Some(slot) = cache.tracks.iter_mut().find(|c| c.track.path == new.track.path) {
                *slot = new;
            }
        }
        self.save(&cache)
    }

    /// Adds (or replaces, by path) tracks in the saved library, keeping scan
    /// order. Does nothing if this library has not been saved yet, so a
    /// partial cache is never created.
    pub fn add_tracks(&self, root: &Path, added: Vec<CachedTrack>) -> std::io::Result<()> {
        let Some(mut cache) = self.load(root) else { return Ok(()) };
        for new in added {
            cache.tracks.retain(|c| c.track.path != new.track.path);
            cache.tracks.push(new);
        }
        crate::library::sort_cached(&mut cache.tracks);
        self.save(&cache)
    }

    /// Drops tracks from the saved library without remembering them as
    /// removed (the files are gone, not hidden).
    pub fn forget_tracks(&self, root: &Path, paths: &[String]) -> std::io::Result<()> {
        let Some(mut cache) = self.load(root) else { return Ok(()) };
        cache.tracks.retain(|c| !paths.contains(&c.track.path));
        self.save(&cache)
    }

    /// Paths the user removed from this library, which scans leave out.
    pub fn removed(&self, root: &Path) -> Removed {
        std::fs::read_to_string(self.removed_path(root))
            .ok()
            .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
            .map(|paths| paths.into_iter().collect())
            .unwrap_or_default()
    }

    fn save_removed(&self, root: &Path, removed: &Removed) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.0)?;
        let mut sorted: Vec<&String> = removed.iter().collect();
        sorted.sort();
        std::fs::write(self.removed_path(root), serde_json::to_vec(&sorted).map_err(std::io::Error::other)?)
    }

    /// Removes tracks from the library: remembers them so later scans skip
    /// them, and drops them from the saved library right away. Files on disk
    /// are not touched.
    pub fn remove_tracks(&self, root: &Path, paths: &[String]) -> std::io::Result<()> {
        let mut removed = self.removed(root);
        removed.extend(paths.iter().cloned());
        self.save_removed(root, &removed)?;
        if let Some(mut cache) = self.load(root) {
            cache.tracks.retain(|c| !removed.contains(&c.track.path));
            self.save(&cache)?;
        }
        Ok(())
    }

    /// Forgets all removals. The next scan brings those files back.
    pub fn clear_removed(&self, root: &Path) -> std::io::Result<()> {
        match std::fs::remove_file(self.removed_path(root)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    pub fn last_root(&self) -> Option<PathBuf> {
        let text = std::fs::read_to_string(self.last_root_path()).ok()?;
        let text = text.trim();
        (!text.is_empty()).then(|| PathBuf::from(text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::test_track;

    fn cached(name: &str) -> CachedTrack {
        CachedTrack { modified_ms: 5, size: 9, track: test_track(name) }
    }

    #[test]
    fn round_trips_and_remembers_last_root() {
        let dir = tempfile::tempdir().unwrap();
        let store = CacheDir(dir.path().join("cache"));
        let root = Path::new("/Volumes/music");
        store.save(&LibraryCache::new(root, vec![cached("a"), cached("b")])).unwrap();

        let loaded = store.load(root).unwrap();

        assert_eq!(loaded.tracks.len(), 2);
        assert_eq!(loaded.known().len(), 2);
        assert_eq!(store.last_root(), Some(root.to_path_buf()));
    }

    #[test]
    fn roots_have_separate_caches() {
        let dir = tempfile::tempdir().unwrap();
        let store = CacheDir(dir.path().to_path_buf());
        store.save(&LibraryCache::new(Path::new("/a"), vec![cached("a")])).unwrap();

        assert!(store.load(Path::new("/b")).is_none());
        assert_eq!(store.load(Path::new("/a")).unwrap().tracks.len(), 1);
    }

    #[test]
    fn corrupt_or_wrong_version_cache_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let store = CacheDir(dir.path().to_path_buf());
        let root = Path::new("/a");
        std::fs::write(store.cache_path(root), "{ broken").unwrap();
        assert!(store.load(root).is_none());

        let mut old = LibraryCache::new(root, vec![]);
        old.version = 0;
        std::fs::write(store.cache_path(root), serde_json::to_vec(&old).unwrap()).unwrap();
        assert!(store.load(root).is_none());
    }

    #[test]
    fn removing_tracks_drops_them_from_the_saved_library_and_remembers_them() {
        let dir = tempfile::tempdir().unwrap();
        let store = CacheDir(dir.path().to_path_buf());
        let root = Path::new("/lib");
        store.save(&LibraryCache::new(root, vec![cached("a"), cached("b"), cached("c")])).unwrap();

        store.remove_tracks(root, &["/music/b.mp3".into()]).unwrap();
        store.remove_tracks(root, &["/music/c.mp3".into()]).unwrap();

        let titles: Vec<_> = store.load(root).unwrap().tracks.into_iter().map(|c| c.track.title).collect();
        assert_eq!(titles, vec!["a"]);
        assert_eq!(store.removed(root).len(), 2);
    }

    #[test]
    fn removals_work_before_any_cache_exists_and_are_per_library() {
        let dir = tempfile::tempdir().unwrap();
        let store = CacheDir(dir.path().to_path_buf());
        store.remove_tracks(Path::new("/a"), &["/music/x.mp3".into()]).unwrap();
        assert!(store.removed(Path::new("/a")).contains("/music/x.mp3"));
        assert!(store.removed(Path::new("/b")).is_empty());
    }

    #[test]
    fn clearing_removals_restores_them_and_is_safe_when_there_are_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = CacheDir(dir.path().to_path_buf());
        let root = Path::new("/a");
        store.clear_removed(root).unwrap();
        store.remove_tracks(root, &["/music/x.mp3".into()]).unwrap();
        store.clear_removed(root).unwrap();
        assert!(store.removed(root).is_empty());
    }

    #[test]
    fn updating_tracks_replaces_matching_entries_only() {
        let dir = tempfile::tempdir().unwrap();
        let store = CacheDir(dir.path().to_path_buf());
        let root = Path::new("/lib");
        store.save(&LibraryCache::new(root, vec![cached("a"), cached("b")])).unwrap();

        let mut edited = cached("a");
        edited.track.title = "Renamed".into();
        edited.size = 99;
        let stranger = cached("zzz");
        store.update_tracks(root, vec![edited, stranger]).unwrap();

        let tracks = store.load(root).unwrap().tracks;
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].track.title, "Renamed");
        assert_eq!(tracks[0].size, 99);
        assert_eq!(tracks[1].track.title, "b");
    }

    #[test]
    fn adding_tracks_keeps_scan_order_replaces_by_path_and_never_creates_a_cache() {
        let dir = tempfile::tempdir().unwrap();
        let store = CacheDir(dir.path().to_path_buf());
        let root = Path::new("/lib");
        store.add_tracks(root, vec![cached("a")]).unwrap();
        assert!(store.load(root).is_none(), "no cache is invented for a library that was never scanned");

        store.save(&LibraryCache::new(root, vec![cached("b"), cached("d")])).unwrap();
        let mut again = cached("d");
        again.size = 7;
        store.add_tracks(root, vec![cached("c"), again]).unwrap();

        let tracks = store.load(root).unwrap().tracks;
        let titles: Vec<_> = tracks.iter().map(|c| c.track.title.as_str()).collect();
        assert_eq!(titles, vec!["b", "c", "d"]);
        assert_eq!(tracks[2].size, 7);
    }

    #[test]
    fn forgetting_tracks_removes_them_without_blocking_a_future_scan() {
        let dir = tempfile::tempdir().unwrap();
        let store = CacheDir(dir.path().to_path_buf());
        let root = Path::new("/lib");
        store.save(&LibraryCache::new(root, vec![cached("a"), cached("b")])).unwrap();

        store.forget_tracks(root, &["/music/a.mp3".to_string()]).unwrap();

        assert_eq!(store.load(root).unwrap().tracks.len(), 1);
        assert!(store.removed(root).is_empty());
    }

    #[test]
    fn no_last_root_before_first_save() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(CacheDir(dir.path().to_path_buf()).last_root(), None);
    }
}
