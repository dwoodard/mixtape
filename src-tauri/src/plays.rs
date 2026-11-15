//! How many times each song has been played, and when it was last played. Kept in one small file in the app data folder.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// A song counts as played after this much real listening, or half of it if the song is shorter (but at least ...).
const MIN_LISTEN_MS: u64 = 30_000;
/// ... and never more than this, however long the song is.
const MAX_LISTEN_MS: u64 = 4 * 60_000;

/// How long a song must have really been listened to before it counts as a play: half of it, within 30 seconds
/// and 4 minutes. A song shorter than 30 seconds must be heard in full. Skipping around does not add to it.
pub fn listen_needed_ms(duration_ms: u64) -> u64 {
    if duration_ms == 0 {
        return MIN_LISTEN_MS;
    }
    (duration_ms / 2).clamp(MIN_LISTEN_MS.min(duration_ms), MAX_LISTEN_MS)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlayStat {
    pub count: u32,
    /// When it was last played (ms since the epoch).
    pub last_played_ms: u64,
}

/// Play counts by song path, loaded at start and saved after every play.
pub struct PlayStore {
    path: PathBuf,
    stats: Mutex<HashMap<String, PlayStat>>,
}

impl PlayStore {
    /// Reads the file. A missing or unreadable one starts empty.
    pub fn load(path: PathBuf) -> Self {
        let stats = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        PlayStore { path, stats: Mutex::new(stats) }
    }

    /// Adds one play of `song` at `now_ms`, saves, and returns its new numbers.
    pub fn record(&self, song: &str, now_ms: u64) -> PlayStat {
        let (stat, snapshot) = {
            let mut stats = self.stats.lock().unwrap();
            let stat = stats.entry(song.to_string()).or_default();
            stat.count += 1;
            stat.last_played_ms = now_ms;
            let stat = *stat;
            (stat, stats.clone())
        };
        if let Err(e) = self.save(&snapshot) {
            eprintln!("could not save play counts: {e}");
        }
        stat
    }

    pub fn all(&self) -> HashMap<String, PlayStat> {
        self.stats.lock().unwrap().clone()
    }

    fn save(&self, stats: &HashMap<String, PlayStat>) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(stats).map_err(std::io::Error::other)?)?;
        std::fs::rename(&tmp, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_a_song_within_thirty_seconds_and_four_minutes() {
        assert_eq!(listen_needed_ms(180_000), 90_000, "a normal song: half");
        assert_eq!(listen_needed_ms(50_000), 30_000, "a short song: at least 30 seconds");
        assert_eq!(listen_needed_ms(20_000), 20_000, "under 30 seconds: all of it");
        assert_eq!(listen_needed_ms(900_000), 240_000, "a long one: four minutes");
        assert_eq!(listen_needed_ms(0), 30_000, "unknown length");
    }

    #[test]
    fn counts_each_play_and_remembers_when() {
        let dir = tempfile::tempdir().unwrap();
        let store = PlayStore::load(dir.path().join("plays.json"));

        assert_eq!(store.record("/a.mp3", 1_000), PlayStat { count: 1, last_played_ms: 1_000 });
        assert_eq!(store.record("/a.mp3", 5_000), PlayStat { count: 2, last_played_ms: 5_000 });
        assert_eq!(store.record("/b.mp3", 9_000).count, 1);
        assert_eq!(store.all().len(), 2);
    }

    #[test]
    fn survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/plays.json");
        PlayStore::load(path.clone()).record("/a.mp3", 7);

        let again = PlayStore::load(path);
        assert_eq!(again.all()["/a.mp3"], PlayStat { count: 1, last_played_ms: 7 });
    }

    #[test]
    fn a_missing_or_corrupt_file_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(PlayStore::load(dir.path().join("none.json")).all().is_empty());
        let bad = dir.path().join("bad.json");
        std::fs::write(&bad, "{ nope").unwrap();
        assert!(PlayStore::load(bad).all().is_empty());
    }
}
