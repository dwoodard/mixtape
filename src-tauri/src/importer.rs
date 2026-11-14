//! Bringing songs in from links: reading what yt-dlp reports about a video,
//! suggesting tags (and where each value came from), choosing where the file
//! belongs in the library, and adding it safely. The pure parts live here so
//! they can be tested without the network or a running yt-dlp.

use crate::tags::{write_tags, TagEdit};
use crate::track::{read_track, Track};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------- links

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkKind {
    YoutubeVideo,
    YoutubePlaylist,
    Unsupported,
}

/// Splits pasted text into the link and whatever came with it (usually the
/// video title copied from the page).
pub fn extract_link(text: &str) -> (String, String) {
    let start = text.find("http://").or_else(|| text.find("https://"));
    let Some(start) = start else { return (text.trim().to_string(), String::new()) };
    let rest = &text[start..];
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let url = rest[..end].to_string();
    let hint = format!("{} {}", &text[..start], &rest[end..]);
    let hint = hint.split_whitespace().collect::<Vec<_>>().join(" ");
    (url, hint)
}

/// What kind of link this is. Only https YouTube links are accepted, so the
/// URL handed to yt-dlp is always one we recognize.
pub fn classify_link(url: &str) -> LinkKind {
    let lower = url.to_ascii_lowercase();
    let host_ok = ["https://www.youtube.com/", "https://youtube.com/", "https://m.youtube.com/", "https://music.youtube.com/", "https://youtu.be/"]
        .iter()
        .any(|h| lower.starts_with(h));
    if !host_ok {
        return LinkKind::Unsupported;
    }
    if lower.contains("/playlist?") && lower.contains("list=") {
        LinkKind::YoutubePlaylist
    } else if lower.contains("watch?") && lower.contains("v=") || lower.starts_with("https://youtu.be/") {
        LinkKind::YoutubeVideo
    } else {
        LinkKind::Unsupported
    }
}

// ------------------------------------------------------------- metadata

/// The parts of yt-dlp's JSON that matter for tagging.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VideoMeta {
    pub id: String,
    pub title: String,
    pub channel: String,
    /// Only on YouTube Music releases and auto-generated "Topic" uploads.
    pub artist: Option<String>,
    pub track: Option<String>,
    pub album: Option<String>,
    /// `YYYYMMDD`. A true release date (YouTube Music).
    pub release_date: Option<String>,
    /// `YYYYMMDD`. When the video went up; can be later than the song's release.
    pub upload_date: Option<String>,
    pub duration_secs: Option<u64>,
}

pub fn parse_meta(json: &str) -> Result<VideoMeta, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("Couldn't read the video's details: {e}"))?;
    let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let title = text("title").ok_or("The video has no title.")?;
    Ok(VideoMeta {
        id: text("id").unwrap_or_default(),
        title,
        channel: text("channel").or_else(|| text("uploader")).unwrap_or_default(),
        artist: text("artist"),
        track: text("track"),
        album: text("album"),
        release_date: text("release_date"),
        upload_date: text("upload_date"),
        duration_secs: v.get("duration").and_then(Value::as_f64).map(|d| d.round() as u64),
    })
}

/// Entries of a playlist from `yt-dlp --flat-playlist -J`: (video link, title).
pub fn parse_playlist(json: &str, limit: usize) -> Result<(String, Vec<(String, String)>), String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("Couldn't read the playlist: {e}"))?;
    let name = v.get("title").and_then(Value::as_str).unwrap_or("Playlist").to_string();
    let entries = v
        .get("entries")
        .and_then(Value::as_array)
        .ok_or("The playlist has no entries.")?
        .iter()
        .filter_map(|e| {
            let id = e.get("id")?.as_str()?;
            let title = e.get("title").and_then(Value::as_str).unwrap_or("").to_string();
            Some((format!("https://www.youtube.com/watch?v={id}"), title))
        })
        .take(limit)
        .collect();
    Ok((name, entries))
}

// ---------------------------------------------------------- suggestions

/// A song's tags as they will be written. Every value is text; numbers are
/// checked when written.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Proposal {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub year: String,
    pub track: String,
    pub genre: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Suggestion {
    pub proposal: Proposal,
    /// Field name -> where its value came from, in plain words.
    pub sources: BTreeMap<String, String>,
    /// Field name -> other values worth offering.
    pub alternatives: BTreeMap<String, Vec<String>>,
    /// Things to know about how far to trust the above.
    pub notes: Vec<String>,
    /// 0 to 1: how sure we are of the artist and title.
    pub confidence: f32,
}

/// Brackets and parentheses that only describe the video, like
/// `[Official Music Video]` or `(Lyrics)`, removed from the title.
fn strip_noise(raw: &str) -> String {
    const WORDS: [&str; 14] = [
        "official", "video", "audio", "lyric", "lyrics", "visualizer", "visualiser", "hd", "4k", "remaster", "remastered", "music", "live", "clip",
    ];
    let mut out = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        let close = match c {
            '[' => ']',
            '(' => ')',
            _ => {
                out.push(c);
                continue;
            }
        };
        let mut inner = String::new();
        let mut closed = false;
        for n in chars.by_ref() {
            if n == close {
                closed = true;
                break;
            }
            inner.push(n);
        }
        let noisy = inner
            .to_lowercase()
            .split(|ch: char| !ch.is_alphanumeric())
            .any(|w| WORDS.contains(&w));
        if !(closed && noisy) {
            out.push(c);
            out.push_str(&inner);
            if closed {
                out.push(close);
            }
        }
    }
    // "Title | Channel" style suffixes.
    let out = out.split(['|', '｜']).next().unwrap_or("").to_string();
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// "The Dead South - People Are Strange [Official Music Video]" -> ("The Dead South", "People Are Strange").
pub fn parse_video_title(raw: &str) -> (String, String) {
    let cleaned = strip_noise(raw);
    for sep in [" - ", " – ", " — "] {
        if let Some((artist, title)) = cleaned.split_once(sep) {
            return (artist.trim().to_string(), title.trim().to_string());
        }
    }
    (String::new(), cleaned)
}

fn simplify_channel(channel: &str) -> String {
    let mut c = channel.trim().to_string();
    for suffix in [" - Topic", "VEVO", " Official", " official"] {
        if let Some(stripped) = c.strip_suffix(suffix) {
            c = stripped.trim().to_string();
        }
    }
    c.to_lowercase()
}

fn pretty_date(d: &str) -> String {
    if d.len() == 8 {
        format!("{}-{}-{}", &d[..4], &d[4..6], &d[6..8])
    } else {
        d.to_string()
    }
}

/// Turns what YouTube reports into suggested tags. `title_hint` is the video
/// title as the user copied it, used when it is more complete than `meta.title`.
pub fn suggest(meta: &VideoMeta, title_hint: Option<&str>) -> Suggestion {
    let mut s = Suggestion::default();
    let mut source = |field: &str, from: &str, sources: &mut BTreeMap<String, String>| {
        sources.insert(field.to_string(), from.to_string());
    };

    let raw_title = title_hint.filter(|h| !h.is_empty()).unwrap_or(&meta.title);

    if let (Some(artist), Some(track)) = (&meta.artist, &meta.track) {
        s.proposal.artist = artist.clone();
        s.proposal.title = track.clone();
        source("artist", "YouTube Music data", &mut s.sources);
        source("title", "YouTube Music data", &mut s.sources);
        s.confidence = 0.9;
        if let Some(album) = &meta.album {
            s.proposal.album = album.clone();
            source("album", "YouTube Music data", &mut s.sources);
        }
    } else {
        let (artist, title) = parse_video_title(raw_title);
        s.proposal.title = title;
        source("title", "video title", &mut s.sources);
        let channel = simplify_channel(&meta.channel);
        if !artist.is_empty() {
            s.proposal.artist = artist.clone();
            if !channel.is_empty() && channel == artist.to_lowercase() {
                s.confidence = 0.7;
                source("artist", "video title + channel", &mut s.sources);
                s.notes.push(format!("Artist matches the channel ({}).", meta.channel));
            } else {
                s.confidence = 0.5;
                source("artist", "video title", &mut s.sources);
            }
        } else {
            s.confidence = 0.3;
            if !meta.channel.is_empty() {
                s.notes.push(format!("The title didn't name an artist; the channel is “{}”.", meta.channel));
            }
        }
        if !meta.channel.is_empty() && s.proposal.artist.to_lowercase() != channel {
            s.alternatives.entry("artist".into()).or_default().push(meta.channel.clone());
        }
        if raw_title != s.proposal.title {
            s.alternatives.entry("title".into()).or_default().push(raw_title.to_string());
        }
    }

    if let Some(date) = meta.release_date.as_deref().or(meta.upload_date.as_deref()) {
        if date.len() >= 4 && date[..4].chars().all(|c| c.is_ascii_digit()) {
            let year = &date[..4];
            s.proposal.year = year.to_string();
            if meta.release_date.is_some() {
                source("year", "YouTube release date", &mut s.sources);
                s.notes.push(format!("Year {year} from YouTube's release date ({}).", pretty_date(date)));
            } else {
                source("year", "YouTube upload date (check)", &mut s.sources);
                s.notes.push(format!(
                    "Year {year} is only the upload date ({}). The song may be older. Please check.",
                    pretty_date(date)
                ));
            }
        }
    }
    if let Some(secs) = meta.duration_secs {
        s.notes.push(format!("Length {}:{:02}.", secs / 60, secs % 60));
    }
    s
}

// ---------------------------------------------------------- destination

/// A single path component made safe: no separators or characters Windows and
/// network shares reject, no leading or trailing dots and spaces, bounded length.
pub fn sanitize_component(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '-' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let limited: String = trimmed.chars().take(120).collect();
    limited.trim().to_string()
}

/// Where a song belongs: `Artist/Album/NN Title.ext` under the library folder.
pub fn destination(root: &Path, p: &Proposal, ext: &str) -> PathBuf {
    let artist = [&p.album_artist, &p.artist]
        .into_iter()
        .map(|a| sanitize_component(a))
        .find(|a| !a.is_empty())
        .unwrap_or_else(|| "Unknown Artist".into());
    let album = Some(sanitize_component(&p.album)).filter(|a| !a.is_empty()).unwrap_or_else(|| "Unknown Album".into());
    let title = Some(sanitize_component(&p.title)).filter(|t| !t.is_empty()).unwrap_or_else(|| "Untitled".into());
    let number = p.track.trim().parse::<u32>().ok().map(|n| format!("{n:02} ")).unwrap_or_default();
    root.join(artist).join(album).join(format!("{number}{title}.{ext}"))
}

/// The tag edit that writes every field of a proposal (empty fields clear).
pub fn to_edit(p: &Proposal) -> TagEdit {
    TagEdit {
        title: Some(p.title.clone()),
        artist: Some(p.artist.clone()),
        album: Some(p.album.clone()),
        album_artist: Some(p.album_artist.clone()),
        track_number: Some(p.track.clone()),
        disc_number: None,
        year: Some(p.year.clone()),
        genre: Some(p.genre.clone()),
    }
}

// ------------------------------------------------------------ adding

#[derive(Debug)]
pub struct Added {
    pub path: PathBuf,
    pub track: Track,
    pub size: u64,
}

fn free_name(target: PathBuf) -> PathBuf {
    if !target.exists() {
        return target;
    }
    let stem = target.file_stem().and_then(|s| s.to_str()).unwrap_or("song").to_string();
    let ext = target.extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
    (2..)
        .map(|n| target.with_file_name(format!("{stem} ({n}).{ext}")))
        .find(|p| !p.exists())
        .expect("an unused name exists")
}

/// Puts a staged file into the library: tags are written to a working copy
/// (the staged file stays as it was, so the add can be undone), the copy is
/// transferred to the library under a temporary name and checked, then moved
/// into place. Never overwrites an existing file.
pub fn add_to_library(staged: &Path, proposal: &Proposal, root: &Path) -> Result<Added, String> {
    if !root.is_dir() {
        return Err(format!("{} is not available. Is the drive mounted?", root.display()));
    }
    let ext = staged.extension().and_then(|e| e.to_str()).ok_or("The fetched file has no extension.")?;
    let dest = free_name(destination(root, proposal, ext));
    let dir = dest.parent().ok_or("No destination folder.")?.to_path_buf();

    // 1. Tag a local working copy next to the staged file.
    let work = staged.with_file_name(format!(".{}.tagging.{ext}", staged.file_stem().and_then(|s| s.to_str()).unwrap_or("song")));
    std::fs::copy(staged, &work).map_err(|e| format!("Couldn't copy the fetched file: {e}"))?;
    let cleanup = |p: &Path| {
        let _ = std::fs::remove_file(p);
    };
    if let Err(e) = write_tags(&work, &to_edit(proposal)) {
        cleanup(&work);
        return Err(e);
    }

    // 2. Transfer to the library under a temporary name, verify, then rename.
    let result = (|| -> Result<(), String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
        let temp = dir.join(format!(".{}.mixtape-tmp.{ext}", dest.file_stem().and_then(|s| s.to_str()).unwrap_or("song")));
        std::fs::copy(&work, &temp).map_err(|e| format!("Couldn't copy into the library: {e}"))?;
        let ok = std::fs::metadata(&temp).and_then(|a| std::fs::metadata(&work).map(|b| a.len() == b.len())).unwrap_or(false);
        if !ok {
            let _ = std::fs::remove_file(&temp);
            return Err("The copy in the library had the wrong size, so it was removed.".into());
        }
        std::fs::rename(&temp, &dest).map_err(|e| {
            let _ = std::fs::remove_file(&temp);
            format!("Couldn't move it into place: {e}")
        })
    })();
    cleanup(&work);
    result?;

    let track = read_track(&dest).ok_or("Added, but the new file could not be read back.")?;
    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    Ok(Added { path: dest, track, size })
}

/// Undoes an add: removes the file we added (only if it is still the size we
/// wrote, so a file changed since is left alone) and any folders that became
/// empty, stopping at the library root.
pub fn remove_added(root: &Path, path: &Path, expected_size: u64) -> Result<(), String> {
    if !path.starts_with(root) {
        return Err("That file is not inside the library folder.".into());
    }
    match std::fs::metadata(path) {
        Ok(m) if m.len() == expected_size => {}
        Ok(_) => return Err("The file has changed since it was added, so it was left alone.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())?;
    let mut dir = path.parent();
    while let Some(d) = dir {
        if d == root || !d.starts_with(root) || std::fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
    Ok(())
}

// ------------------------------------------------------------- yt-dlp

/// What yt-dlp prints while it works (using our `--progress-template`s).
#[derive(Debug, PartialEq)]
pub enum Progress {
    Download { done: u64, total: u64 },
    /// A post-processing step started or finished (e.g. `ExtractAudio`, the ffmpeg conversion).
    Post { name: String, finished: bool },
    File(String),
}

pub fn parse_progress(line: &str) -> Option<Progress> {
    let mut parts = line.trim().split('|');
    match parts.next()? {
        "PROG" => {
            let _status = parts.next()?;
            let done: u64 = parts.next()?.parse().ok()?;
            let total = parts.next()?.parse::<u64>().ok().or_else(|| parts.next()?.parse::<f64>().ok().map(|t| t as u64))?;
            Some(Progress::Download { done, total })
        }
        "POST" => {
            let name = parts.next()?.to_string();
            let finished = parts.next()? == "finished";
            Some(Progress::Post { name, finished })
        }
        "FILE" => Some(Progress::File(line.trim().strip_prefix("FILE|")?.to_string())),
        _ => None,
    }
}

/// Finds a command-line tool even when the app was started from Finder and
/// so has a short PATH (Homebrew lives outside it).
pub fn find_tool(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- links

    #[test]
    fn splits_a_pasted_title_and_link() {
        let (url, hint) = extract_link(
            "The Dead South - People Are Strange [Official Music Video]\nhttps://www.youtube.com/watch?v=v4YQJ6KuWvQ",
        );
        assert_eq!(url, "https://www.youtube.com/watch?v=v4YQJ6KuWvQ");
        assert_eq!(hint, "The Dead South - People Are Strange [Official Music Video]");
        assert_eq!(extract_link("  https://youtu.be/abc123 ").1, "");
        assert_eq!(extract_link("no link here"), ("no link here".into(), String::new()));
    }

    #[test]
    fn a_link_can_come_before_or_around_its_title() {
        let (url, hint) = extract_link("Song Name https://youtu.be/abc123 by Someone");
        assert_eq!(url, "https://youtu.be/abc123");
        assert_eq!(hint, "Song Name by Someone");
    }

    #[test]
    fn classifies_only_https_youtube_links() {
        assert_eq!(classify_link("https://www.youtube.com/watch?v=v4YQJ6KuWvQ"), LinkKind::YoutubeVideo);
        assert_eq!(classify_link("https://www.youtube.com/watch?feature=share&v=abc"), LinkKind::YoutubeVideo);
        assert_eq!(classify_link("https://youtu.be/v4YQJ6KuWvQ?t=5"), LinkKind::YoutubeVideo);
        assert_eq!(classify_link("https://music.youtube.com/watch?v=abc"), LinkKind::YoutubeVideo);
        assert_eq!(classify_link("https://www.youtube.com/playlist?list=PLabc"), LinkKind::YoutubePlaylist);
        assert_eq!(classify_link("http://www.youtube.com/watch?v=abc"), LinkKind::Unsupported);
        assert_eq!(classify_link("https://evil.example/https://www.youtube.com/watch?v=abc"), LinkKind::Unsupported);
        assert_eq!(classify_link("https://open.spotify.com/track/abc"), LinkKind::Unsupported);
        assert_eq!(classify_link("--exec rm -rf"), LinkKind::Unsupported);
        assert_eq!(classify_link("https://www.youtube.com/@channel"), LinkKind::Unsupported);
    }

    // ---- metadata

    #[test]
    fn reads_yt_dlp_metadata() {
        let json = r#"{"id":"v4YQJ6KuWvQ","title":"The Dead South - People Are Strange [Official Music Video]",
            "uploader":"The Dead South","channel":"The Dead South","release_date":"20211111","upload_date":"20211111",
            "duration":193,"categories":["Music"],"artist":null}"#;
        let meta = parse_meta(json).unwrap();
        assert_eq!(meta.id, "v4YQJ6KuWvQ");
        assert_eq!(meta.channel, "The Dead South");
        assert_eq!(meta.release_date.as_deref(), Some("20211111"));
        assert_eq!(meta.duration_secs, Some(193));
        assert_eq!(meta.artist, None);
    }

    #[test]
    fn metadata_errors_are_readable() {
        assert!(parse_meta("not json").is_err());
        assert!(parse_meta(r#"{"id":"x"}"#).unwrap_err().contains("no title"));
    }

    #[test]
    fn reads_a_playlist_listing_and_caps_it() {
        let json = r#"{"title":"Road trip","entries":[{"id":"a1","title":"One"},{"id":"b2","title":"Two"},{"id":"c3"},{"title":"no id"}]}"#;
        let (name, entries) = parse_playlist(json, 2).unwrap();
        assert_eq!(name, "Road trip");
        assert_eq!(entries, vec![("https://www.youtube.com/watch?v=a1".to_string(), "One".to_string()), ("https://www.youtube.com/watch?v=b2".to_string(), "Two".to_string())]);
        assert_eq!(parse_playlist(json, 10).unwrap().1.len(), 3);
        assert!(parse_playlist(r#"{"title":"x"}"#, 5).is_err());
    }

    // ---- title parsing

    #[test]
    fn splits_artist_and_title_and_strips_video_noise() {
        assert_eq!(parse_video_title("The Dead South - People Are Strange [Official Music Video]"), ("The Dead South".into(), "People Are Strange".into()));
        assert_eq!(parse_video_title("AJR - My Calling (Official Video) | AJR Official"), ("AJR".into(), "My Calling".into()));
        assert_eq!(parse_video_title("Eminem - Without Me (Official Music Video)"), ("Eminem".into(), "Without Me".into()));
        assert_eq!(parse_video_title("Some Song (Lyrics)"), (String::new(), "Some Song".into()));
        assert_eq!(parse_video_title("Me at the zoo"), (String::new(), "Me at the zoo".into()));
    }

    #[test]
    fn keeps_brackets_that_are_part_of_the_title() {
        assert_eq!(parse_video_title("Band - Song (feat. Someone)"), ("Band".into(), "Song (feat. Someone)".into()));
        assert_eq!(parse_video_title("Band - Song (Acoustic) [Official Video]"), ("Band".into(), "Song (Acoustic)".into()));
        assert_eq!(parse_video_title("Band - Un-closed (bracket"), ("Band".into(), "Un-closed (bracket".into()));
    }

    #[test]
    fn only_the_first_dash_separates_artist_from_title() {
        assert_eq!(parse_video_title("Artist - Title - Remix"), ("Artist".into(), "Title - Remix".into()));
    }

    // ---- suggestions

    fn dead_south() -> VideoMeta {
        VideoMeta {
            id: "v4YQJ6KuWvQ".into(),
            title: "The Dead South - People Are Strange [Official Music Video]".into(),
            channel: "The Dead South".into(),
            release_date: Some("20211111".into()),
            upload_date: Some("20211111".into()),
            duration_secs: Some(193),
            ..Default::default()
        }
    }

    #[test]
    fn suggests_tags_for_a_normal_music_video_and_says_where_each_came_from() {
        let s = suggest(&dead_south(), None);
        assert_eq!(s.proposal.artist, "The Dead South");
        assert_eq!(s.proposal.title, "People Are Strange");
        assert_eq!(s.proposal.year, "2021");
        assert_eq!(s.proposal.album, "");
        assert_eq!(s.sources["artist"], "video title + channel");
        assert_eq!(s.sources["year"], "YouTube release date");
        assert!(!s.sources.contains_key("album"));
        assert_eq!(s.confidence, 0.7);
        assert!(s.notes.iter().any(|n| n.contains("2021-11-11")));
        assert!(s.notes.iter().any(|n| n.contains("3:13")));
    }

    #[test]
    fn an_upload_date_alone_is_used_but_flagged() {
        let meta = VideoMeta { release_date: None, upload_date: Some("20050424".into()), ..dead_south() };
        let s = suggest(&meta, None);
        assert_eq!(s.proposal.year, "2005");
        assert_eq!(s.sources["year"], "YouTube upload date (check)");
        assert!(s.notes.iter().any(|n| n.contains("only the upload date")));
    }

    #[test]
    fn no_date_means_no_year() {
        let meta = VideoMeta { release_date: None, upload_date: None, ..dead_south() };
        assert_eq!(suggest(&meta, None).proposal.year, "");
    }

    #[test]
    fn youtube_music_data_is_trusted_over_the_title() {
        let meta = VideoMeta {
            title: "Song (Audio)".into(),
            channel: "Artist - Topic".into(),
            artist: Some("Artist".into()),
            track: Some("Song".into()),
            album: Some("The Album".into()),
            release_date: Some("20180302".into()),
            ..Default::default()
        };
        let s = suggest(&meta, None);
        assert_eq!((s.proposal.artist.as_str(), s.proposal.title.as_str(), s.proposal.album.as_str()), ("Artist", "Song", "The Album"));
        assert_eq!(s.sources["album"], "YouTube Music data");
        assert_eq!(s.confidence, 0.9);
    }

    #[test]
    fn a_title_without_an_artist_leaves_it_blank_and_offers_the_channel() {
        let meta = VideoMeta { title: "Me at the zoo".into(), channel: "jawed".into(), upload_date: Some("20050424".into()), duration_secs: Some(19), ..Default::default() };
        let s = suggest(&meta, None);
        assert_eq!(s.proposal.artist, "");
        assert_eq!(s.proposal.title, "Me at the zoo");
        assert_eq!(s.alternatives["artist"], vec!["jawed".to_string()]);
        assert_eq!(s.confidence, 0.3);
    }

    #[test]
    fn a_channel_that_is_not_the_artist_gets_offered_as_an_alternative() {
        let meta = VideoMeta { channel: "SomeLabelVEVO".into(), ..dead_south() };
        let s = suggest(&meta, None);
        assert_eq!(s.confidence, 0.5);
        assert_eq!(s.alternatives["artist"], vec!["SomeLabelVEVO".to_string()]);
    }

    #[test]
    fn vevo_and_topic_channels_still_match_the_artist_when_the_name_is_the_same() {
        let meta = VideoMeta { channel: "TheDeadSouthVEVO".into(), ..dead_south() };
        // "thedeadsouth" != "the dead south": a different spelling is not guessed at.
        assert_eq!(suggest(&meta, None).confidence, 0.5);
        let meta = VideoMeta { channel: "The Dead South VEVO".into(), ..dead_south() };
        assert_eq!(suggest(&meta, None).confidence, 0.7);
        let meta = VideoMeta { channel: "The Dead South - Topic".into(), ..dead_south() };
        assert_eq!(suggest(&meta, None).confidence, 0.7);
    }

    #[test]
    fn the_title_the_user_pasted_is_preferred() {
        let meta = VideoMeta { title: "People Are Strange".into(), ..dead_south() };
        let s = suggest(&meta, Some("The Dead South - People Are Strange [Official Music Video]"));
        assert_eq!(s.proposal.artist, "The Dead South");
        assert_eq!(s.proposal.title, "People Are Strange");
    }

    // ---- destination

    #[test]
    fn destination_is_artist_album_number_title() {
        let p = Proposal { title: "People Are Strange".into(), artist: "The Dead South".into(), album: "Served Live".into(), track: "4".into(), ..Default::default() };
        assert_eq!(destination(Path::new("/Music"), &p, "mp3"), PathBuf::from("/Music/The Dead South/Served Live/04 People Are Strange.mp3"));
    }

    #[test]
    fn missing_parts_get_the_library_placeholders_and_album_artist_wins() {
        let p = Proposal { title: "Me at the zoo".into(), ..Default::default() };
        assert_eq!(destination(Path::new("/M"), &p, "mp3"), PathBuf::from("/M/Unknown Artist/Unknown Album/Me at the zoo.mp3"));
        let p = Proposal { title: "T".into(), artist: "Guest".into(), album_artist: "Host".into(), album: "A".into(), ..Default::default() };
        assert_eq!(destination(Path::new("/M"), &p, "m4a"), PathBuf::from("/M/Host/A/T.m4a"));
        assert_eq!(destination(Path::new("/M"), &Proposal::default(), "flac"), PathBuf::from("/M/Unknown Artist/Unknown Album/Untitled.flac"));
    }

    #[test]
    fn path_characters_cannot_escape_the_library_folder() {
        let p = Proposal { title: "../../etc/passwd".into(), artist: "AC/DC".into(), album: "..".into(), ..Default::default() };
        let d = destination(Path::new("/Music"), &p, "mp3");
        assert!(d.starts_with("/Music"));
        assert!(!d.components().any(|c| c.as_os_str() == ".."));
        // Leading dots are trimmed too, so the result is odd-looking but cannot point anywhere else.
        assert_eq!(d, PathBuf::from("/Music/AC-DC/Unknown Album/-..-etc-passwd.mp3"));
    }

    #[test]
    fn sanitizing_trims_and_bounds_names() {
        assert_eq!(sanitize_component("  What? Why: Not*  "), "What- Why- Not-");
        assert_eq!(sanitize_component("...hidden..."), "hidden");
        assert_eq!(sanitize_component(&"x".repeat(300)).chars().count(), 120);
        assert_eq!(sanitize_component("Björk – Jóga"), "Björk – Jóga");
    }

    // ---- progress

    #[test]
    fn parses_progress_lines() {
        assert_eq!(parse_progress("PROG|downloading|1024|252182|NA"), Some(Progress::Download { done: 1024, total: 252182 }));
        assert_eq!(parse_progress("PROG|downloading|1024|NA|500000"), Some(Progress::Download { done: 1024, total: 500000 }));
        assert_eq!(parse_progress("POST|ExtractAudio|started"), Some(Progress::Post { name: "ExtractAudio".into(), finished: false }));
        assert_eq!(parse_progress("POST|MoveFiles|finished"), Some(Progress::Post { name: "MoveFiles".into(), finished: true }));
        assert_eq!(parse_progress("FILE|/tmp/a b/x.mp3"), Some(Progress::File("/tmp/a b/x.mp3".into())));
        assert_eq!(parse_progress("[info] something else"), None);
        assert_eq!(parse_progress("PROG|downloading|NA|NA|NA"), None);
    }

    // ---- adding to the library (real files, no network)

    fn staged(dir: &Path) -> PathBuf {
        let path = dir.join("abc123.mp3");
        std::fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tone.mp3"), &path).unwrap();
        path
    }

    fn proposal() -> Proposal {
        Proposal {
            title: "People Are Strange".into(),
            artist: "The Dead South".into(),
            album: "Served Live".into(),
            year: "2021".into(),
            track: "4".into(),
            genre: "Folk".into(),
            ..Default::default()
        }
    }

    #[test]
    fn adds_a_song_with_its_tags_in_the_right_place_and_leaves_the_staged_file_alone() {
        let work = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let staged = staged(work.path());
        let original = std::fs::read(&staged).unwrap();

        let added = add_to_library(&staged, &proposal(), lib.path()).unwrap();

        assert_eq!(added.path, lib.path().join("The Dead South/Served Live/04 People Are Strange.mp3"));
        assert_eq!((added.track.title.as_str(), added.track.artist.as_str(), added.track.album.as_str()), ("People Are Strange", "The Dead South", "Served Live"));
        assert_eq!((added.track.year, added.track.track_number, added.track.genre.as_str()), (Some(2021), Some(4), "Folk"));
        assert_eq!(std::fs::read(&staged).unwrap(), original, "staged file must stay pristine so the add can be undone");
        // No working or temporary files left behind anywhere.
        let leftovers: Vec<_> = walk(work.path()).into_iter().chain(walk(lib.path())).filter(|p| p.to_string_lossy().contains(".tagging.") || p.to_string_lossy().contains("mixtape-tmp")).collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        walkdir::WalkDir::new(dir).into_iter().filter_map(Result::ok).map(|e| e.into_path()).collect()
    }

    #[test]
    fn never_overwrites_an_existing_file() {
        let work = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let staged = staged(work.path());

        let first = add_to_library(&staged, &proposal(), lib.path()).unwrap();
        let second = add_to_library(&staged, &proposal(), lib.path()).unwrap();

        assert_ne!(first.path, second.path);
        assert!(second.path.to_string_lossy().ends_with("04 People Are Strange (2).mp3"));
        assert!(first.path.exists() && second.path.exists());
    }

    #[test]
    fn an_unavailable_library_folder_is_reported_and_nothing_is_created() {
        let work = tempfile::tempdir().unwrap();
        let staged = staged(work.path());
        let err = add_to_library(&staged, &proposal(), Path::new("/Volumes/not-mounted/Music")).unwrap_err();
        assert!(err.contains("not available"));
    }

    #[test]
    fn a_bad_tag_value_stops_the_add_before_anything_reaches_the_library() {
        let work = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let staged = staged(work.path());
        let bad = Proposal { year: "nineteen".into(), ..proposal() };

        assert!(add_to_library(&staged, &bad, lib.path()).is_err());

        assert!(walk(lib.path()).iter().all(|p| p.is_dir() && p == lib.path() || p.extension().is_none()));
        assert!(!lib.path().join("The Dead South/Served Live").join("04 People Are Strange.mp3").exists());
        assert!(!walk(work.path()).iter().any(|p| p.to_string_lossy().contains(".tagging.")));
    }

    #[test]
    fn undo_removes_the_added_file_and_the_folders_it_emptied_but_not_the_library() {
        let work = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let added = add_to_library(&staged(work.path()), &proposal(), lib.path()).unwrap();

        remove_added(lib.path(), &added.path, added.size).unwrap();

        assert!(!added.path.exists());
        assert!(!lib.path().join("The Dead South").exists(), "emptied folders are removed");
        assert!(lib.path().exists());
    }

    #[test]
    fn undo_keeps_folders_that_still_have_other_songs() {
        let work = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let a = add_to_library(&staged(work.path()), &proposal(), lib.path()).unwrap();
        let other = Proposal { title: "Another".into(), track: "5".into(), ..proposal() };
        let b = add_to_library(&staged(work.path()), &other, lib.path()).unwrap();

        remove_added(lib.path(), &a.path, a.size).unwrap();

        assert!(!a.path.exists() && b.path.exists());
    }

    #[test]
    fn undo_leaves_a_file_that_changed_and_refuses_paths_outside_the_library() {
        let work = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let added = add_to_library(&staged(work.path()), &proposal(), lib.path()).unwrap();

        assert!(remove_added(lib.path(), &added.path, added.size + 1).unwrap_err().contains("changed"));
        assert!(added.path.exists());

        let outside = work.path().join("keep.mp3");
        std::fs::write(&outside, b"x").unwrap();
        assert!(remove_added(lib.path(), &outside, 1).is_err());
        assert!(outside.exists());

        // Already gone is fine.
        std::fs::remove_file(&added.path).unwrap();
        remove_added(lib.path(), &added.path, added.size).unwrap();
    }
}
