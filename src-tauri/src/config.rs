//! User settings stored as JSON in the app config directory.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// Folder the library is imported from (for example a mounted NAS share).
    pub music_folder: Option<PathBuf>,
}

impl Config {
    /// Reads the config. A missing or corrupt file yields the defaults.
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let json = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(path, json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_yields_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Config::load(&dir.path().join("config.json")), Config::default());
    }

    #[test]
    fn corrupt_file_yields_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, "{ nope").unwrap();
        assert_eq!(Config::load(&path), Config::default());
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/config.json");
        let config = Config { music_folder: Some(PathBuf::from("/Volumes/homes/music")) };

        config.save(&path).unwrap();

        assert_eq!(Config::load(&path), config);
    }

    #[test]
    fn reads_camel_case_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"musicFolder": "/music"}"#).unwrap();
        assert_eq!(Config::load(&path).music_folder, Some(PathBuf::from("/music")));
    }
}
