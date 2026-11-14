//! "Reveal in Finder" for songs.

use crate::track::is_audio_file;
use std::path::Path;
use std::process::Command;

/// The arguments for `open -R`, which selects the files in Finder. Only
/// absolute paths to audio files are accepted, and none may start with `-`
/// (so a path can never be read as an option).
pub fn reveal_args(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("Nothing to reveal.".into());
    }
    for p in paths {
        let path = Path::new(p);
        if !path.is_absolute() || !is_audio_file(path) {
            return Err(format!("Cannot reveal {p}."));
        }
    }
    let mut args = vec!["-R".to_string(), "--".to_string()];
    args.extend(paths.iter().cloned());
    Ok(args)
}

pub fn reveal(paths: &[String]) -> Result<(), String> {
    let args = reveal_args(paths)?;
    let status = Command::new("open").args(&args).status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Finder could not find that file. Is the drive mounted?".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_open_arguments_for_audio_files() {
        let args = reveal_args(&["/Music/a.mp3".into(), "/Music/b.flac".into()]).unwrap();
        assert_eq!(args, vec!["-R", "--", "/Music/a.mp3", "/Music/b.flac"]);
    }

    #[test]
    fn rejects_empty_relative_non_audio_and_option_like_paths() {
        assert!(reveal_args(&[]).is_err());
        assert!(reveal_args(&["relative/a.mp3".into()]).is_err());
        assert!(reveal_args(&["/etc/passwd".into()]).is_err());
        assert!(reveal_args(&["-a Calculator.mp3".into()]).is_err());
        // One bad path rejects the whole request.
        assert!(reveal_args(&["/Music/a.mp3".into(), "/etc/hosts".into()]).is_err());
    }
}
