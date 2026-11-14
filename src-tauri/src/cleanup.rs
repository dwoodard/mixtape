//! Cleaning up duplicate files: moving the extra copies to the Trash, never
//! deleting them outright.

use crate::track::is_audio_file;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::Path;

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

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct CleanupReport {
    /// Moved to the Trash.
    pub trashed: Vec<String>,
    /// Were already gone from disk.
    pub missing: Vec<String>,
    /// Left alone, with why.
    pub skipped: Vec<Skipped>,
}

/// Moves each pair's extra copy to the Trash through `trash`, but only after
/// checking it is safe: both are absolute audio paths, the kept copy exists
/// and is not itself being removed, and both files are the same size.
/// Anything that fails a check, or that `trash` cannot move, is left alone.
pub fn trash_duplicates(
    pairs: &[DuplicatePair],
    trash: impl Fn(&Path) -> Result<(), String>,
) -> CleanupReport {
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
        match trash(extra) {
            Ok(()) => report.trashed.push(pair.extra.clone()),
            Err(e) => skip(&mut report, &pair.extra, &format!("Couldn't move to the Trash: {e}")),
        }
    }
    report
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
            trash_duplicates(pairs, |p| {
                self.0.borrow_mut().push(p.to_string_lossy().into_owned());
                Ok(())
            })
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

        let report = trash_duplicates(&[pair(&keep, &extra)], |_| Err("volume has no Trash".into()));

        assert!(report.trashed.is_empty());
        assert!(report.skipped[0].reason.contains("volume has no Trash"));
        assert!(Path::new(&extra).exists(), "the file must still be there");
    }

    #[test]
    fn one_failure_does_not_stop_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let keep = file(dir.path(), "a.mp3", 100);
        let bad = file(dir.path(), "a 1.mp3", 100);
        let good = file(dir.path(), "a 2.mp3", 100);

        let report = trash_duplicates(&[pair(&keep, &bad), pair(&keep, &good)], |p| {
            if p.ends_with("a 1.mp3") { Err("locked".into()) } else { Ok(()) }
        });

        assert_eq!(report.trashed, vec![good]);
        assert_eq!(report.skipped.len(), 1);
    }
}
