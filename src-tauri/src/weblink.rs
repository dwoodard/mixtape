//! Opens a web page in the person's browser, for the few sites the app links to (MusicBrainz, LRCLIB, YouTube).

use std::process::Command;

/// The only places a link may go. Each ends in a slash, so `https://musicbrainz.org.evil.example/` and
/// `https://musicbrainz.org@evil.example/` do not match.
const ALLOWED: &[&str] = &["https://musicbrainz.org/", "https://lrclib.net/", "https://www.youtube.com/", "https://music.youtube.com/", "https://youtu.be/"];

/// The arguments for `open`, when `url` is a plain link to an allowed site. `--` first, so it can never be read as an option.
pub fn open_args(url: &str) -> Result<Vec<String>, String> {
    let plain = !url.is_empty() && url.len() <= 300 && url.chars().all(|c| c.is_ascii() && !c.is_ascii_control() && c != ' ');
    if !plain || !ALLOWED.iter().any(|site| url.starts_with(site)) {
        return Err("The app only opens links to musicbrainz.org, lrclib.net and youtube.com.".into());
    }
    Ok(vec!["--".to_string(), url.to_string()])
}

pub fn open_link(url: &str) -> Result<(), String> {
    let args = open_args(url)?;
    let status = Command::new("open").args(&args).status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("The browser could not open that link.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_links_on_the_two_sites() {
        assert_eq!(
            open_args("https://musicbrainz.org/release/e6389564-0a50-4a19-9219-c22a42aa8de8").unwrap(),
            vec!["--", "https://musicbrainz.org/release/e6389564-0a50-4a19-9219-c22a42aa8de8"]
        );
        assert!(open_args("https://lrclib.net/api/get?track_name=x").is_ok());
        assert!(open_args("https://www.youtube.com/watch?v=abc").is_ok());
        assert!(open_args("https://youtu.be/abc").is_ok());
        assert!(open_args("https://www.youtube.com.evil.example/watch").is_err());
    }

    #[test]
    fn refuses_other_sites_lookalikes_and_other_kinds_of_link() {
        for bad in [
            "https://evil.example/",
            "https://musicbrainz.org.evil.example/",
            "https://musicbrainz.org@evil.example/",
            "http://musicbrainz.org/recording/1",
            "file:///etc/passwd",
            "musicbrainz.org/recording/1",
            "-a Calculator",
            "https://musicbrainz.org/a b",
            "https://musicbrainz.org/\nx",
            "",
        ] {
            assert!(open_args(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(open_args(&format!("https://musicbrainz.org/{}", "a".repeat(400))).is_err());
    }
}
