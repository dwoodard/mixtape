//! On-disk library cache: the last scan of each library folder, so the app
//! can show the library at launch without reading any tags.

use crate::library::{CachedTrack, Known};
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

/// Stable (across Rust versions) file name for a library root.
fn file_name(root: &Path) -> String {
    let mut hash: u64 = 0xcbf29ce484222325; // FNV-1a
    for byte in root.to_string_lossy().bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("library-{hash:016x}.json")
}

#[derive(Clone)]
pub struct CacheDir(pub PathBuf);

impl CacheDir {
    fn cache_path(&self, root: &Path) -> PathBuf {
        self.0.join(file_name(root))
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
    fn no_last_root_before_first_save() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(CacheDir(dir.path().to_path_buf()).last_root(), None);
    }
}
