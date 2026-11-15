//! File helpers that work on network shares.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

/// Copies the bytes of `src` to `dst`, replacing `dst` if it exists, and
/// nothing else.
///
/// `std::fs::copy` also copies permissions and extended attributes (such as
/// the quarantine mark on downloaded files), and SMB shares such as a NAS
/// often refuse that with "Permission denied" even though writing the file is
/// allowed. The data is flushed to the drive before this returns.
pub fn copy_data(src: &Path, dst: &Path) -> io::Result<u64> {
    let mut from = File::open(src)?;
    match fs::remove_file(dst) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut to = OpenOptions::new().write(true).create_new(true).open(dst)?;
    let copied = io::copy(&mut from, &mut to)?;
    to.flush()?;
    to.sync_all()?;
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_the_bytes_and_reports_how_many() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a.bin"), dir.path().join("b.bin"));
        fs::write(&a, b"hello world").unwrap();

        assert_eq!(copy_data(&a, &b).unwrap(), 11);

        assert_eq!(fs::read(&b).unwrap(), b"hello world");
        assert_eq!(fs::read(&a).unwrap(), b"hello world", "the source is untouched");
    }

    #[test]
    fn replaces_an_existing_destination_including_a_longer_one() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        fs::write(&a, b"new").unwrap();
        fs::write(&b, b"a much longer old file").unwrap();

        copy_data(&a, &b).unwrap();

        assert_eq!(fs::read(&b).unwrap(), b"new");
    }

    #[test]
    fn a_missing_source_is_an_error_and_leaves_the_destination_alone() {
        let dir = tempfile::tempdir().unwrap();
        let b = dir.path().join("b");
        fs::write(&b, b"keep").unwrap();

        assert!(copy_data(&dir.path().join("nope"), &b).is_err());

        assert_eq!(fs::read(&b).unwrap(), b"keep");
    }

    #[test]
    fn copies_an_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        fs::write(&a, b"").unwrap();
        assert_eq!(copy_data(&a, &b).unwrap(), 0);
        assert!(b.exists());
    }
}
