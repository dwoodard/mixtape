//! Moves song files into another folder of the library.

use crate::fsutil::copy_data;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One song to move: its file, and the folder it should end up in.
#[derive(Deserialize)]
pub struct SongMove {
    pub path: String,
    pub folder: String,
}

#[derive(Serialize)]
pub struct Moved {
    pub from: String,
    pub to: String,
}

#[derive(Serialize)]
pub struct MoveFailure {
    pub path: String,
    pub error: String,
}

#[derive(Serialize, Default)]
pub struct MoveReport {
    pub moved: Vec<Moved>,
    pub failed: Vec<MoveFailure>,
}

/// Moves the file into `folder` (created if needed), keeping its name. Never replaces a file already there.
/// A rename is tried first. When the share refuses it, the file is copied, checked by size, and only then removed.
pub fn move_file(path: &Path, folder: &Path, root: &Path) -> Result<PathBuf, String> {
    if !folder.starts_with(root) {
        return Err("the folder is outside the library folder".into());
    }
    if !path.is_file() {
        return Err("the file is gone".into());
    }
    let name = path.file_name().ok_or("the file has no name")?;
    let target = folder.join(name);
    if target == path {
        return Err("it is already in that folder".into());
    }
    if target.exists() {
        return Err("a file with that name is already in that folder".into());
    }
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    if std::fs::rename(path, &target).is_ok() {
        return Ok(target);
    }
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    copy_data(path, &target).map_err(|e| e.to_string())?;
    if std::fs::metadata(&target).map(|m| m.len()).ok() != Some(size) {
        let _ = std::fs::remove_file(&target);
        return Err("the copy did not match the original, so nothing was moved".into());
    }
    std::fs::remove_file(path).map_err(|e| format!("copied, but could not remove the original: {e}"))?;
    Ok(target)
}

pub fn move_songs(moves: &[SongMove], root: &Path) -> MoveReport {
    let mut report = MoveReport::default();
    for m in moves {
        match move_file(Path::new(&m.path), Path::new(&m.folder), root) {
            Ok(to) => report.moved.push(Moved { from: m.path.clone(), to: to.to_string_lossy().into_owned() }),
            Err(error) => report.failed.push(MoveFailure { path: m.path.clone(), error }),
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn moves_a_file_into_a_new_folder_and_keeps_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let from = root.join("Forrest_/slow down/01 slow down.mp3");
        fs::create_dir_all(from.parent().unwrap()).unwrap();
        fs::write(&from, b"song").unwrap();

        let to = move_file(&from, &root.join("Forrest Frank/slow down"), root).unwrap();

        assert_eq!(to, root.join("Forrest Frank/slow down/01 slow down.mp3"));
        assert_eq!(fs::read(&to).unwrap(), b"song");
        assert!(!from.exists());
    }

    #[test]
    fn never_replaces_a_file_that_is_already_there() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("a")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        fs::write(root.join("a/x.mp3"), b"new").unwrap();
        fs::write(root.join("b/x.mp3"), b"old").unwrap();

        assert!(move_file(&root.join("a/x.mp3"), &root.join("b"), root).is_err());

        assert_eq!(fs::read(root.join("b/x.mp3")).unwrap(), b"old");
        assert!(root.join("a/x.mp3").exists());
    }

    #[test]
    fn refuses_a_folder_outside_the_library() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("x.mp3"), b"s").unwrap();
        assert!(move_file(&dir.path().join("x.mp3"), other.path(), dir.path()).is_err());
        assert!(dir.path().join("x.mp3").exists());
    }

    #[test]
    fn reports_each_song_on_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("ok.mp3"), b"s").unwrap();
        let moves = vec![
            SongMove { path: root.join("ok.mp3").to_string_lossy().into(), folder: root.join("A").to_string_lossy().into() },
            SongMove { path: root.join("gone.mp3").to_string_lossy().into(), folder: root.join("A").to_string_lossy().into() },
        ];
        let report = move_songs(&moves, root);
        assert_eq!(report.moved.len(), 1);
        assert_eq!(report.failed.len(), 1);
    }
}
