//! Named playlists saved on disk. Each keeps a snapshot of its tracks' tags,
//! so a playlist still reads correctly while the library folder is offline.

use crate::track::Track;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    /// The lowercased name. Saving under an existing name replaces that playlist.
    pub id: String,
    pub name: String,
    pub tracks: Vec<Track>,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSummary {
    pub id: String,
    pub name: String,
    pub track_count: usize,
    pub duration_ms: u64,
    pub updated_at_ms: u64,
}

impl From<&Playlist> for PlaylistSummary {
    fn from(p: &Playlist) -> Self {
        PlaylistSummary {
            id: p.id.clone(),
            name: p.name.clone(),
            track_count: p.tracks.len(),
            duration_ms: p.tracks.iter().map(|t| t.duration_ms).sum(),
            updated_at_ms: p.updated_at_ms,
        }
    }
}

pub struct PlaylistStore {
    path: PathBuf,
}

impl PlaylistStore {
    pub fn new(path: PathBuf) -> Self {
        PlaylistStore { path }
    }

    fn read(&self) -> Vec<Playlist> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn write(&self, playlists: &[Playlist]) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let json = serde_json::to_vec(playlists).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }

    /// Playlists ordered by name.
    pub fn list(&self) -> Vec<PlaylistSummary> {
        let mut all = self.read();
        all.sort_by_key(|p| p.name.to_lowercase());
        all.iter().map(PlaylistSummary::from).collect()
    }

    pub fn get(&self, id: &str) -> Option<Playlist> {
        self.read().into_iter().find(|p| p.id == id)
    }

    /// Creates a playlist, or replaces the one with the same name.
    pub fn save(&self, name: &str, tracks: Vec<Track>) -> Result<PlaylistSummary, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Give the playlist a name.".into());
        }
        if tracks.is_empty() {
            return Err("There are no tracks to save.".into());
        }
        let id = name.to_lowercase();
        let updated_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        let playlist = Playlist { id: id.clone(), name: name.to_string(), tracks, updated_at_ms };
        let summary = PlaylistSummary::from(&playlist);

        let mut all = self.read();
        all.retain(|p| p.id != id);
        all.push(playlist);
        self.write(&all)?;
        Ok(summary)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut all = self.read();
        let before = all.len();
        all.retain(|p| p.id != id);
        if all.len() == before {
            return Ok(());
        }
        self.write(&all)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::test_track;

    fn store() -> (tempfile::TempDir, PlaylistStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = PlaylistStore::new(dir.path().join("data/playlists.json"));
        (dir, store)
    }

    #[test]
    fn saves_lists_and_loads_a_playlist() {
        let (_dir, store) = store();
        let summary = store.save("Road Trip", vec![test_track("a"), test_track("b")]).unwrap();

        assert_eq!(summary.track_count, 2);
        assert_eq!(summary.duration_ms, 360_000);
        assert_eq!(store.list(), vec![summary.clone()]);
        let loaded = store.get(&summary.id).unwrap();
        assert_eq!(loaded.name, "Road Trip");
        assert_eq!(loaded.tracks.len(), 2);
    }

    #[test]
    fn saving_under_the_same_name_replaces_it_ignoring_case_and_padding() {
        let (_dir, store) = store();
        store.save("Mix", vec![test_track("a")]).unwrap();
        store.save("  mix ", vec![test_track("b"), test_track("c")]).unwrap();

        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].track_count, 2);
        assert_eq!(store.get("mix").unwrap().tracks[0].title, "b");
    }

    #[test]
    fn rejects_blank_names_and_empty_playlists() {
        let (_dir, store) = store();
        assert!(store.save("   ", vec![test_track("a")]).is_err());
        assert!(store.save("Empty", vec![]).is_err());
        assert!(store.list().is_empty());
    }

    #[test]
    fn lists_by_name_and_deletes() {
        let (_dir, store) = store();
        store.save("beta", vec![test_track("a")]).unwrap();
        store.save("Alpha", vec![test_track("a")]).unwrap();

        let names: Vec<_> = store.list().into_iter().map(|p| p.name).collect();
        assert_eq!(names, vec!["Alpha", "beta"]);

        store.delete("alpha").unwrap();
        assert_eq!(store.list().len(), 1);
        store.delete("does not exist").unwrap();
        assert!(store.get("alpha").is_none());
    }

    #[test]
    fn a_corrupt_file_reads_as_no_playlists() {
        let (_dir, store) = store();
        std::fs::create_dir_all(store.path.parent().unwrap()).unwrap();
        std::fs::write(&store.path, "{ nope").unwrap();
        assert!(store.list().is_empty());
    }
}
