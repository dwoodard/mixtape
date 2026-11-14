//! Cleaning up duplicate files: moving the extra copies to the Trash (or, on
//! drives that have none, to a holding folder), never deleting them outright.

use crate::track::is_audio_file;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// Folder (inside the library folder) that extras are moved into on drives without a Trash.
pub const HOLDING_DIR: &str = ".mixtape-duplicates";

/// An extra copy and the copy that is being kept instead.
#[derive(Debug, Clone, Deserialize)]
pub struct DuplicatePair {
    pub keep: String,
    pub extra: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

/// A file moved to the holding folder, and where it went.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldFile {
    /// Where it was (and where the library knew it).
    pub path: String,
    pub moved_to: String,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    /// Moved to the Trash.
    pub trashed: Vec<String>,
    /// Moved to the holding folder instead, because the drive has no Trash.
    pub held: Vec<HeldFile>,
    /// This run's holding folder, when anything was held.
    pub holding_folder: Option<String>,
    /// Were already gone from disk.
    pub missing: Vec<String>,
    /// Left alone, with why.
    pub skipped: Vec<Skipped>,
}

/// Moves each pair's extra copy to the Trash through `trash`, but only after
/// checking it is safe: both are absolute audio paths, the kept copy exists
/// and is not itself being removed, and both files are the same size.
/// If the Trash can't take a file (a network drive without one), `hold` is
/// tried instead, and once the Trash has failed it is not tried again for the
/// rest of the run. Anything neither can move is left alone.
pub fn trash_duplicates(
    pairs: &[DuplicatePair],
    trash: impl Fn(&Path) -> Result<(), String>,
    hold: impl Fn(&Path) -> Result<PathBuf, String>,
) -> CleanupReport {
    let mut trash_unavailable = false;
    let keeping: HashSet<&str> = pairs.iter().map(|p| p.keep.as_str()).collect();
    let mut report = CleanupReport::default();
    let mut skip = |report: &mut CleanupReport, path: &str, reason: &str| {
        report.skipped.push(Skipped { path: path.to_string(), reason: reason.to_string() });
    };

    for pair in pairs {
        let (keep, extra) = (Path::new(&pair.keep), Path::new(&pair.extra));
        let valid = |p: &Path| p.is_absolute() && is_audio_file(p);
        if !valid(keep) || !valid(extra) || pair.keep == pair.extra {
            skip(&mut report, &pair.extra, "Not a pair of audio file paths.");
            continue;
        }
        if keeping.contains(pair.extra.as_str()) {
            skip(&mut report, &pair.extra, "This file is also the copy being kept for another song.");
            continue;
        }
        let keep_len = match std::fs::metadata(keep) {
            Ok(m) if m.is_file() => m.len(),
            _ => {
                skip(&mut report, &pair.extra, "The copy to keep can't be found, so this one was left alone.");
                continue;
            }
        };
        let extra_len = match std::fs::metadata(extra) {
            Ok(m) if m.is_file() => m.len(),
            Err(e) if e.kind() == ErrorKind::NotFound => {
                report.missing.push(pair.extra.clone());
                continue;
            }
            _ => {
                skip(&mut report, &pair.extra, "Can't read this file.");
                continue;
            }
        };
        if keep_len != extra_len {
            skip(&mut report, &pair.extra, "Different size from the copy being kept.");
            continue;
        }
        let trash_error = if trash_unavailable {
            Some("this drive has no Trash".to_string())
        } else {
            match trash(extra) {
                Ok(()) => {
                    report.trashed.push(pair.extra.clone());
                    continue;
                }
                Err(e) => {
                    trash_unavailable = true;
                    Some(e)
                }
            }
        };
        match hold(extra) {
            Ok(moved_to) => report.held.push(HeldFile {
                path: pair.extra.clone(),
                moved_to: moved_to.to_string_lossy().into_owned(),
            }),
            Err(e) => {
                let why = format!(
                    "Couldn't move to the Trash ({}) or to the holding folder ({e}).",
                    short_reason(&trash_error.unwrap_or_default())
                );
                skip(&mut report, &pair.extra, &why);
            }
        }
    }
    report
}

/// A short, readable form of a system error: drops the Debug-style wrapper
/// and keeps the sentence the system gave.
pub fn short_reason(error: &str) -> String {
    // e.g. `... failed: “a.mp3” couldn’t be moved to the trash because the volume “homes” doesn’t have one." }`
    if let Some(at) = error.rfind("failed: ") {
        return error[at + "failed: ".len()..]
            .trim_end_matches(|c: char| c == '}' || c == '"' || c.is_whitespace())
            .to_string();
    }
    error.to_string()
}

/// Seconds since the Unix epoch as `YYYY-MM-DD-HHMMSS` (UTC), for naming a holding folder.
pub fn utc_stamp(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86_400) as i64;
    let rem = epoch_secs % 86_400;
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}-{:02}{:02}{:02}", rem / 3_600, rem % 3_600 / 60, rem % 60)
}

/// Where `path` goes inside `batch_dir` (a holding folder): the same path
/// relative to the library `root`, so the structure can be put back. `None`
/// if the file is not inside `root`.
pub fn holding_destination(root: &Path, path: &Path, batch_dir: &Path) -> Option<PathBuf> {
    path.strip_prefix(root).ok().map(|relative| batch_dir.join(relative))
}

/// Moves `path` into `batch_dir` on the same drive, keeping its place in the
/// folder structure. Never overwrites: a name clash gets a numeric suffix.
pub fn move_to_holding(root: &Path, path: &Path, batch_dir: &Path) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err("the file is gone".into());
    }
    let destination = holding_destination(root, path, batch_dir)
        .ok_or("the file is outside the library folder")?;
    if let Some(dir) = destination.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut target = destination.clone();
    let mut n = 1;
    while target.exists() {
        let stem = destination.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
        let name = match destination.extension().and_then(|e| e.to_str()) {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        target = destination.with_file_name(name);
        n += 1;
    }
    std::fs::rename(path, &target).map_err(|e| e.to_string())?;
    Ok(target)
}

/// Moves a file to the Trash using the system file manager. If the volume
/// has no Trash this fails; the file is never deleted outright.
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    let mut context = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context.delete(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::path::PathBuf;

    fn file(dir: &Path, name: &str, bytes: usize) -> String {
        let path: PathBuf = dir.join(name);
        std::fs::write(&path, vec![0u8; bytes]).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn pair(keep: &str, extra: &str) -> DuplicatePair {
        DuplicatePair { keep: keep.into(), extra: extra.into() }
    }

    /// A fake Trash that records what it was asked to move.
    struct FakeTrash(RefCell<Vec<String>>);
    impl FakeTrash {
        fn new() -> Self {
            FakeTrash(RefCell::new(Vec::new()))
        }
        fn run(&self, pairs: &[DuplicatePair]) -> CleanupReport {
            trash_duplicates(
                pairs,
                |p| {
                    self.0.borrow_mut().push(p.to_string_lossy().into_owned());
                    Ok(())
                },
                |_| Err("no holding folder".into()),
            )
        }
    }

    /// Uses the real Trash (a throwaway file in the system temp dir ends up
    /// there), so it is skipped by default. Run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn the_real_trash_takes_a_local_file_and_removes_it_from_disk() {
        let path = std::env::temp_dir().join(format!("mixtape-trash-test-{}.mp3", std::process::id()));
        std::fs::write(&path, b"throwaway").unwrap();

        move_to_trash(&path).expect("move to Trash");

        assert!(!path.exists());
    }

    #[test]
    fn falls_back_to_the_holding_folder_and_stops_trying_the_trash_after_it_fails() {
        let dir = tempfile::tempdir().unwrap();
        let keep = file(dir.path(), "a.mp3", 100);
        let one = file(dir.path(), "a 1.mp3", 100);
        let two = file(dir.path(), "a 2.mp3", 100);
        let trash_calls = RefCell::new(0);
        let held = RefCell::new(Vec::new());

        let report = trash_duplicates(
            &[pair(&keep, &one), pair(&keep, &two)],
            |_| {
                *trash_calls.borrow_mut() += 1;
                Err("the volume doesn't have one".into())
            },
            |p| {
                held.borrow_mut().push(p.to_string_lossy().into_owned());
                Ok(PathBuf::from("/held").join(p.file_name().unwrap()))
            },
        );

        assert_eq!(*trash_calls.borrow(), 1, "the Trash is tried once, then skipped");
        assert_eq!(report.held.iter().map(|h| h.path.clone()).collect::<Vec<_>>(), vec![one.clone(), two.clone()]);
        assert_eq!(report.held[0].moved_to, "/held/a 1.mp3");
        assert_eq!(*held.borrow(), vec![one, two]);
        assert!(report.trashed.is_empty() && report.skipped.is_empty());
    }

    #[test]
    fn shortens_the_system_error_to_its_sentence() {
        let raw = "Error during a `trash` operation: Unknown { description: \"While deleting x\", `trashItemAtURL` failed: “a.mp3” couldn’t be moved to the trash because the volume “homes” doesn’t have one.\" }";
        assert_eq!(short_reason(raw), "“a.mp3” couldn’t be moved to the trash because the volume “homes” doesn’t have one.");
        assert_eq!(short_reason("locked"), "locked");
    }

    #[test]
    fn formats_a_utc_stamp() {
        assert_eq!(utc_stamp(0), "1970-01-01-000000");
        assert_eq!(utc_stamp(1_700_000_000), "2023-11-14-221320");
        assert_eq!(utc_stamp(951_782_400), "2000-02-29-000000"); // a leap day
    }

    #[test]
    fn holding_destination_keeps_the_folder_structure_and_rejects_outside_files() {
        let root = Path::new("/Volumes/m/Music");
        let batch = Path::new("/Volumes/m/Music/.mixtape-duplicates/2026-01-01-000000");
        assert_eq!(
            holding_destination(root, Path::new("/Volumes/m/Music/No Doubt/TK/a 1.mp3"), batch),
            Some(batch.join("No Doubt/TK/a 1.mp3"))
        );
        assert_eq!(holding_destination(root, Path::new("/elsewhere/a.mp3"), batch), None);
    }

    #[test]
    fn moves_a_file_into_the_holding_folder_without_overwriting_anything() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("Artist/Album")).unwrap();
        let extra = root.join("Artist/Album/a 1.mp3");
        std::fs::write(&extra, b"extra").unwrap();
        let batch = root.join(HOLDING_DIR).join("2026-01-01-000000");

        let moved = move_to_holding(root, &extra, &batch).unwrap();

        assert_eq!(moved, batch.join("Artist/Album/a 1.mp3"));
        assert!(!extra.exists());
        assert_eq!(std::fs::read(batch.join("Artist/Album/a 1.mp3")).unwrap(), b"extra");

        // A second file with the same name lands next to it instead of replacing it.
        std::fs::write(&extra, b"second").unwrap();
        move_to_holding(root, &extra, &batch).unwrap();
        assert_eq!(std::fs::read(batch.join("Artist/Album/a 1.mp3")).unwrap(), b"extra");
        assert_eq!(std::fs::read(batch.join("Artist/Album/a 1 (1).mp3")).unwrap(), b"second");
    }

    #[test]
    fn a_missing_file_is_refused_without_leaving_empty_folders() {
        let dir = tempfile::tempdir().unwrap();
        let batch = dir.path().join(HOLDING_DIR).join("b");
        assert!(move_to_holding(dir.path(), &dir.path().join("Artist/gone.mp3"), &batch).is_err());
        assert!(!dir.path().join(HOLDING_DIR).exists());
    }

    #[test]
    fn refuses_to_hold_a_file_outside_the_library_folder() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = outside.path().join("a.mp3");
        std::fs::write(&path, b"x").unwrap();
        assert!(move_to_holding(root.path(), &path, &root.path().join(HOLDING_DIR).join("b")).is_err());
        assert!(path.exists());
    }

    #[test]
    fn trashes_extras_that_match_the_kept_copy() {
        let dir = tempfile::tempdir().unwrap();
        let keep = file(dir.path(), "01 A.mp3", 100);
        let one = file(dir.path(), "01 A 1.mp3", 100);
        let two = file(dir.path(), "01 A 2.mp3", 100);
        let fake = FakeTrash::new();

        let report = fake.run(&[pair(&keep, &one), pair(&keep, &two)]);

        assert_eq!(report.trashed, vec![one.clone(), two.clone()]);
        assert_eq!(*fake.0.borrow(), vec![one, two]);
        assert!(report.skipped.is_empty() && report.missing.is_empty());
    }

    #[test]
    fn never_touches_the_kept_copy_or_a_file_of_a_different_size() {
        let dir = tempfile::tempdir().unwrap();
        let keep = file(dir.path(), "a.mp3", 100);
        let bigger = file(dir.path(), "a 1.mp3", 250);
        let fake = FakeTrash::new();

        let report = fake.run(&[pair(&keep, &bigger)]);

        assert!(fake.0.borrow().is_empty());
        assert_eq!(report.skipped.len(), 1);
        assert!(report.skipped[0].reason.contains("Different size"));
    }

    #[test]
    fn leaves_the_extra_alone_when_the_kept_copy_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let extra = file(dir.path(), "a 1.mp3", 100);
        let keep = dir.path().join("a.mp3").to_string_lossy().into_owned();
        let fake = FakeTrash::new();

        let report = fake.run(&[pair(&keep, &extra)]);

        assert!(fake.0.borrow().is_empty());
        assert!(report.skipped[0].reason.contains("can't be found"));
    }

    #[test]
    fn a_file_that_is_the_kept_copy_of_another_pair_is_not_trashed() {
        let dir = tempfile::tempdir().unwrap();
        let a = file(dir.path(), "a.mp3", 100);
        let b = file(dir.path(), "b.mp3", 100);
        let fake = FakeTrash::new();

        // b is kept for one pair and listed as an extra in another.
        let report = fake.run(&[pair(&a, &b), pair(&b, &a)]);

        assert!(fake.0.borrow().is_empty());
        assert_eq!(report.skipped.len(), 2);
    }

    #[test]
    fn reports_extras_that_are_already_gone() {
        let dir = tempfile::tempdir().unwrap();
        let keep = file(dir.path(), "a.mp3", 100);
        let gone = dir.path().join("a 1.mp3").to_string_lossy().into_owned();
        let report = FakeTrash::new().run(&[pair(&keep, &gone)]);
        assert_eq!(report.missing, vec![gone]);
        assert!(report.trashed.is_empty());
    }

    #[test]
    fn rejects_relative_paths_non_audio_files_and_a_file_paired_with_itself() {
        let dir = tempfile::tempdir().unwrap();
        let keep = file(dir.path(), "a.mp3", 10);
        let notes = file(dir.path(), "notes.txt", 10);
        let fake = FakeTrash::new();

        let report = fake.run(&[
            pair("a.mp3", "b.mp3"),
            pair(&keep, &notes),
            pair(&keep, &keep),
        ]);

        assert!(fake.0.borrow().is_empty());
        assert_eq!(report.skipped.len(), 3);
    }

    #[test]
    fn a_failing_trash_leaves_the_file_and_reports_why() {
        let dir = tempfile::tempdir().unwrap();
        let keep = file(dir.path(), "a.mp3", 100);
        let extra = file(dir.path(), "a 1.mp3", 100);

        let report = trash_duplicates(
            &[pair(&keep, &extra)],
            |_| Err("volume has no Trash".into()),
            |_| Err("read-only".into()),
        );

        assert!(report.trashed.is_empty() && report.held.is_empty());
        assert!(report.skipped[0].reason.contains("volume has no Trash"));
        assert!(report.skipped[0].reason.contains("read-only"));
        assert!(Path::new(&extra).exists(), "the file must still be there");
    }

    #[test]
    fn one_failure_does_not_stop_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let keep = file(dir.path(), "a.mp3", 100);
        let bad = file(dir.path(), "a 1.mp3", 100);
        let good = file(dir.path(), "a 2.mp3", 100);

        let report = trash_duplicates(
            &[pair(&keep, &bad), pair(&keep, &good)],
            |p| if p.ends_with("a 1.mp3") { Err("locked".into()) } else { Ok(()) },
            |p| if p.ends_with("a 1.mp3") { Err("also locked".into()) } else { Ok(p.to_path_buf()) },
        );

        // The first failure means the Trash is not tried again, so the second goes to hold.
        assert_eq!(report.held.iter().map(|h| h.path.clone()).collect::<Vec<_>>(), vec![good]);
        assert_eq!(report.skipped.len(), 1);
    }
}
