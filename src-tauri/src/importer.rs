//! Bringing songs in from links: reading what yt-dlp reports about a video,
//! suggesting tags (and where each value came from), choosing where the file
//! belongs in the library, and adding it safely. The pure parts live here so
//! they can be tested without the network or a running yt-dlp.

use crate::library::CachedTrack;
use crate::tags::{write_tags, TagEdit};
use crate::track::{read_track, Track};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

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
    /// Which disc of a multi-disc release this is, and how many discs there are.
    /// Not edited by hand: they come from Picard's tags and only shape the file name.
    pub disc: String,
    pub disc_total: String,
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
    let source = |field: &str, from: &str, sources: &mut BTreeMap<String, String>| {
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

/// The number in front of a file name: `03 ` for a one-disc release, `2-07 `
/// for a song on a later (or any, if there are several) disc of a multi-disc
/// release, which is how the library already names such songs.
fn track_prefix(p: &Proposal) -> String {
    let Some(track) = p.track.trim().parse::<u32>().ok() else { return String::new() };
    let disc = p.disc.trim().parse::<u32>().ok();
    let total = p.disc_total.trim().parse::<u32>().unwrap_or(0);
    match disc {
        Some(d) if total > 1 || d >= 2 => format!("{d}-{track:02} "),
        _ => format!("{track:02} "),
    }
}

/// Where a song belongs: `Artist/Album/NN Title.ext` (`D-NN Title.ext` on a
/// multi-disc release) under the library folder.
pub fn destination(root: &Path, p: &Proposal, ext: &str) -> PathBuf {
    let artist = [&p.album_artist, &p.artist]
        .into_iter()
        .map(|a| sanitize_component(a))
        .find(|a| !a.is_empty())
        .unwrap_or_else(|| "Unknown Artist".into());
    let album = Some(sanitize_component(&p.album)).filter(|a| !a.is_empty()).unwrap_or_else(|| "Unknown Album".into());
    let title = Some(sanitize_component(&p.title)).filter(|t| !t.is_empty()).unwrap_or_else(|| "Untitled".into());
    root.join(artist).join(album).join(format!("{}{title}.{ext}", track_prefix(p)))
}

/// A name reduced to its letters and digits, so `AC/DC`, `AC_DC` and `ac dc`
/// all compare equal. Used to recognize folders that already exist.
fn fold(name: &str) -> String {
    name.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn artist_key(album_artist: &str, artist: &str) -> String {
    fold(if album_artist.trim().is_empty() { artist } else { album_artist })
}

/// The most common value in `items` (first seen wins a tie).
fn most_common<T: PartialEq + Clone>(items: Vec<T>) -> Option<T> {
    let mut counted: Vec<(T, usize)> = Vec::new();
    for item in items {
        match counted.iter_mut().find(|(v, _)| *v == item) {
            Some((_, n)) => *n += 1,
            None => counted.push((item, 1)),
        }
    }
    counted.into_iter().fold(None, |best: Option<(T, usize)>, c| match best {
        Some(b) if b.1 >= c.1 => Some(b),
        _ => Some(c),
    }).map(|(v, _)| v)
}

/// Where a song belongs in the library. Follows what is already there: if the
/// library has songs by this artist, the new one goes in the same artist
/// folder (however it is spelled on disk, `AC_DC` for `AC/DC`), and if it has
/// this album, in the same album folder. Only an artist or album the library
/// has never seen gets a new folder, named from the tags.
pub fn place(root: &Path, p: &Proposal, ext: &str, library: &[CachedTrack]) -> PathBuf {
    let default = destination(root, p, ext);
    let file_name = default.file_name().map(PathBuf::from).unwrap_or_default();
    let key = artist_key(&p.album_artist, &p.artist);
    if key.is_empty() {
        return default;
    }

    // Songs of this artist in the library, as path pieces under the root.
    let theirs: Vec<Vec<String>> = library
        .iter()
        .filter(|c| artist_key(&c.track.album_artist, &c.track.artist) == key)
        .filter_map(|c| Path::new(&c.track.path).strip_prefix(root).ok().map(|r| r.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>()))
        // Skip hidden folders such as the duplicates holding folder.
        .filter(|parts| parts.len() >= 2 && !parts[0].starts_with('.'))
        .collect();
    let Some(artist_folder) = most_common(theirs.iter().map(|parts| parts[0].clone()).collect()) else {
        return default;
    };
    let artist_dir = root.join(&artist_folder);

    // An album folder the artist already has: second path piece when the song sits one level deeper.
    let album_key = fold(&p.album);
    let album_folder = if album_key.is_empty() {
        None
    } else {
        most_common(
            theirs
                .iter()
                .filter(|parts| parts.len() >= 3 && parts[0] == artist_folder && fold(&parts[1]) == album_key)
                .map(|parts| parts[1].clone())
                .collect(),
        )
    };
    let album_dir = album_folder.unwrap_or_else(|| {
        Some(sanitize_component(&p.album)).filter(|a| !a.is_empty()).unwrap_or_else(|| "Unknown Album".into())
    });
    artist_dir.join(album_dir).join(file_name)
}

/// A proposal read back from a tagged file (what Picard wrote).
/// A file name made readable for guessing artist and title: the leftovers of a
/// download (a trailing ".webm" and a "[videoId]") are dropped.
pub fn clean_file_title(stem: &str) -> String {
    let mut s = stem.trim().to_string();
    for ext in [".webm", ".mkv", ".mp4", ".m4a", ".opus", ".ogg", ".flac", ".wav", ".mp3"] {
        if s.to_ascii_lowercase().ends_with(ext) {
            s.truncate(s.len() - ext.len());
        }
    }
    let s = s.trim_end();
    if let Some(open) = s.rfind(" [") {
        let id = &s[open + 2..];
        if let Some(id) = id.strip_suffix(']') {
            if id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
                return s[..open].trim_end().to_string();
            }
        }
    }
    s.to_string()
}

pub fn proposal_from_track(t: &Track) -> Proposal {
    Proposal {
        title: t.title.clone(),
        artist: t.artist.clone(),
        album: t.album.clone(),
        album_artist: t.album_artist.clone(),
        year: t.year.map(|y| y.to_string()).unwrap_or_default(),
        track: t.track_number.map(|n| n.to_string()).unwrap_or_default(),
        genre: t.genre.clone(),
        disc: t.disc_number.map(|n| n.to_string()).unwrap_or_default(),
        disc_total: String::new(),
    }
}

/// The tag edit that writes every field of a proposal (empty fields clear).
pub fn to_edit(p: &Proposal) -> TagEdit {
    TagEdit {
        title: Some(p.title.clone()),
        artist: Some(p.artist.clone()),
        album: Some(p.album.clone()),
        album_artist: Some(p.album_artist.clone()),
        track_number: Some(p.track.clone()),
        disc_number: Some(p.disc.clone()),
        year: Some(p.year.clone()),
        genre: Some(p.genre.clone()),
        // A proposal has no lyrics: whatever the file already has stays.
        lyrics: None,
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

/// Whether the file at `existing` is the song being added: the same title and, to within two seconds, the same length.
/// (The folder already says it is the same artist and album.)
fn is_same_song(existing: &Path, staged: &Path, proposal: &Proposal) -> bool {
    let (Some(have), Some(new)) = (read_track(existing), read_track(staged)) else { return false };
    let fold = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>();
    !fold(&proposal.title).is_empty() && fold(&have.title) == fold(&proposal.title) && have.duration_ms.abs_diff(new.duration_ms) <= 2_000
}

/// Puts a staged file into the library at the place [`place`] chooses. Tags
/// are written to a working copy (the staged file stays as it was, so the add
/// can be undone), unless `retag` is false because another program such as
/// Picard already wrote them. The copy is transferred to the library under a
/// temporary name and checked, then moved into place. Never overwrites an
/// existing file.
pub fn add_to_library(staged: &Path, proposal: &Proposal, root: &Path, library: &[CachedTrack], retag: bool, allow_copy: bool) -> Result<Added, String> {
    if !root.is_dir() {
        return Err(format!("{} is not available. Is the drive mounted?", root.display()));
    }
    let ext = staged.extension().and_then(|e| e.to_str()).ok_or("The fetched file has no extension.")?;
    let wanted = place(root, proposal, ext, library);
    // The saved library can be out of date (files renamed or added behind the app's back), so what is really in the
    // folder decides: the same song already at that place is not added a second time as "Song (2)", unless asked for.
    if wanted.exists() && !allow_copy && is_same_song(&wanted, staged, proposal) {
        let shown = wanted.strip_prefix(root).unwrap_or(&wanted).display();
        return Err(format!("Already in the library: {shown}. It was not added again. To keep a second copy on purpose, choose “Add anyway”."));
    }
    let dest = free_name(wanted);
    let dir = dest.parent().ok_or("No destination folder.")?.to_path_buf();

    // 1. Tag a local working copy next to the staged file.
    let work = staged.with_file_name(format!(".{}.tagging.{ext}", staged.file_stem().and_then(|s| s.to_str()).unwrap_or("song")));
    crate::fsutil::copy_data(staged, &work).map_err(|e| format!("Couldn't copy the fetched file: {e}"))?;
    let cleanup = |p: &Path| {
        let _ = std::fs::remove_file(p);
    };
    if retag {
        if let Err(e) = write_tags(&work, &to_edit(proposal)) {
            cleanup(&work);
            return Err(e);
        }
    }

    // 2. Transfer to the library under a temporary name, verify, then rename.
    let result = (|| -> Result<(), String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
        let temp = dir.join(format!(".{}.mixtape-tmp.{ext}", dest.file_stem().and_then(|s| s.to_str()).unwrap_or("song")));
        crate::fsutil::copy_data(&work, &temp).map_err(|e| format!("Couldn't copy into the library: {e}"))?;
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

/// MusicBrainz Picard's bundle id, used to find the app wherever it is installed.
const PICARD_BUNDLE_ID: &str = "org.musicbrainz.Picard";

/// Where MusicBrainz Picard is installed, if it is.
pub fn find_picard() -> Option<PathBuf> {
    let found = Command::new("mdfind")
        .arg(format!("kMDItemCFBundleIdentifier == '{PICARD_BUNDLE_ID}'"))
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|text| text.lines().next().map(PathBuf::from));
    found
        .or_else(|| Some(PathBuf::from("/Applications/MusicBrainz Picard.app")))
        .filter(|p| p.exists())
}

/// Picard's command-line program inside the app bundle.
fn picard_run(app: &Path) -> PathBuf {
    app.join("Contents/MacOS/picard-run")
}

/// Is Picard running right now?
pub fn picard_running() -> bool {
    Command::new("pgrep")
        .args(["-f", "MusicBrainz Picard.app/Contents/MacOS/picard-run"])
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

/// Arguments that tell a running Picard to load `files` and come to the front.
pub fn picard_load_args(files: &[PathBuf]) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec!["-e".into(), "LOAD".into()];
    args.extend(files.iter().map(|f| f.as_os_str().to_owned()));
    args.extend(["-e".into(), "SHOW".into()]);
    args
}

/// Arguments that tell a running Picard to drop `file` from its lists.
pub fn picard_remove_args(file: &Path) -> Vec<std::ffi::OsString> {
    vec!["-e".into(), "REMOVE".into(), file.as_os_str().to_owned()]
}

/// Most files sent to Picard at once.
pub const PICARD_MAX_FILES: usize = 200;

/// Checks a list of files before handing it to Picard: audio files with
/// absolute paths only, and not too many.
pub fn validate_picard_files(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() {
        return Err("Nothing to send to Picard.".into());
    }
    if paths.len() > PICARD_MAX_FILES {
        return Err(format!("That's a lot of songs. Send up to {PICARD_MAX_FILES} to Picard at a time."));
    }
    paths
        .iter()
        .map(|p| {
            let path = PathBuf::from(p);
            if path.is_absolute() && crate::track::is_audio_file(&path) { Ok(path) } else { Err(format!("Can't send {p} to Picard.")) }
        })
        .collect()
}

/// Loads `files` in Picard. A running Picard is sent them with its own
/// command-line (`-e LOAD`), which is more reliable than asking macOS to open
/// documents; if Picard isn't running it is started with the files.
pub fn open_files_in_picard(app: &Path, files: &[PathBuf]) -> Result<(), String> {
    let run = picard_run(app);
    if run.exists() && picard_running() {
        let sent = Command::new(&run).args(picard_load_args(files)).output();
        if sent.is_ok_and(|o| o.status.success()) {
            return Ok(());
        }
    }
    let status = Command::new("open")
        .arg("-a")
        .arg(app)
        .arg("--args")
        .args(files)
        .status()
        .map_err(|e| format!("Couldn't start Picard: {e}"))?;
    if status.success() { Ok(()) } else { Err("Picard didn't open the files.".into()) }
}

/// Loads one file in Picard.
pub fn open_in_picard(app: &Path, file: &Path) -> Result<(), String> {
    open_files_in_picard(app, &[file.to_path_buf()])
}

/// Tells a running Picard to forget `file` (best effort: nothing to do if Picard isn't running).
pub fn remove_from_picard(app: &Path, file: &Path) {
    let run = picard_run(app);
    if run.exists() && picard_running() {
        let _ = Command::new(run).args(picard_remove_args(file)).output();
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

    // ---- files

    #[test]
    fn file_names_lose_download_leftovers() {
        assert_eq!(clean_file_title("@kongos - Come with Me Now (Lyrics) [hVN-GVdH3qY].webm"), "@kongos - Come with Me Now (Lyrics)");
        assert_eq!(clean_file_title("Plain Song"), "Plain Song");
        assert_eq!(clean_file_title("Song [not an id]"), "Song [not an id]");
    }

    // ---- links

    #[test]
    fn picard_commands_load_the_file_and_show_the_window_or_remove_it() {
        let f = Path::new("/Users/me/Library/Application Support/com.dustin.mixtape/imports/2/a b.mp3");
        let load: Vec<_> = picard_load_args(&[f.to_path_buf()]).iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(load, vec!["-e", "LOAD", "/Users/me/Library/Application Support/com.dustin.mixtape/imports/2/a b.mp3", "-e", "SHOW"]);
        let several: Vec<_> = picard_load_args(&[PathBuf::from("/a/1.mp3"), PathBuf::from("/a/2.flac")]).iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(several, vec!["-e", "LOAD", "/a/1.mp3", "/a/2.flac", "-e", "SHOW"]);
        let remove: Vec<_> = picard_remove_args(f).iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(remove[..2], ["-e", "REMOVE"]);
        assert_eq!(remove.len(), 3, "the path stays one argument even with spaces");
    }

    #[test]
    fn only_a_sensible_list_of_audio_files_is_sent_to_picard() {
        assert_eq!(validate_picard_files(&["/a/b.mp3".into(), "/c/d.FLAC".into()]).unwrap().len(), 2);
        assert!(validate_picard_files(&[]).is_err());
        assert!(validate_picard_files(&["relative/a.mp3".into()]).is_err());
        assert!(validate_picard_files(&["/etc/passwd".into()]).is_err());
        assert!(validate_picard_files(&["-e QUIT".into()]).is_err());
        assert!(validate_picard_files(&["/a/b.mp3".into(), "/a/notes.txt".into()]).is_err());
        let many: Vec<String> = (0..=PICARD_MAX_FILES).map(|i| format!("/m/{i}.mp3")).collect();
        assert!(validate_picard_files(&many).unwrap_err().contains("up to"));
    }

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
    fn multi_disc_releases_get_a_disc_prefix_like_the_rest_of_the_library() {
        let p = |disc: &str, total: &str, track: &str| Proposal { title: "Kashmir".into(), artist: "Led Zeppelin".into(), album: "Mothership".into(), track: track.into(), disc: disc.into(), disc_total: total.into(), ..Default::default() };
        let name = |p: &Proposal| destination(Path::new("/M"), p, "mp3").file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name(&p("2", "2", "7")), "2-07 Kashmir.mp3");
        assert_eq!(name(&p("1", "2", "3")), "1-03 Kashmir.mp3", "disc 1 of several is prefixed too, so the discs sort together");
        assert_eq!(name(&p("2", "", "7")), "2-07 Kashmir.mp3", "a later disc is enough even without a total");
        assert_eq!(name(&p("1", "1", "3")), "03 Kashmir.mp3", "a one-disc release is not prefixed");
        assert_eq!(name(&p("1", "", "3")), "03 Kashmir.mp3");
        assert_eq!(name(&p("", "2", "3")), "03 Kashmir.mp3", "no disc number, nothing to prefix");
        assert_eq!(name(&p("2", "2", "")), "Kashmir.mp3", "no track number, no prefix");
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

        let added = add_to_library(&staged, &proposal(), lib.path(), &[], true, false).unwrap();

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

    /// Adds and undoes a song in a real folder given by `MIXTAPE_TEST_LIBRARY`
    /// (for example a scratch folder on a network share) to prove copying
    /// there works. Run with
    /// `MIXTAPE_TEST_LIBRARY=/Volumes/x/scratch cargo test -- --ignored real_folder`.
    #[test]
    #[ignore]
    fn real_folder_accepts_an_add_and_an_undo() {
        let Some(root) = std::env::var_os("MIXTAPE_TEST_LIBRARY").map(PathBuf::from) else {
            panic!("set MIXTAPE_TEST_LIBRARY to a scratch folder");
        };
        std::fs::create_dir_all(&root).unwrap();
        let work = tempfile::tempdir().unwrap();
        // A downloaded file carries a quarantine mark; the copy must cope with it.
        let staged = staged(work.path());
        let _ = std::process::Command::new("xattr").args(["-w", "com.apple.quarantine", "0081;00000000;Test;"]).arg(&staged).status();

        let added = add_to_library(&staged, &proposal(), &root, &[], true, false).expect("add into the real folder");
        assert!(added.path.exists());
        assert_eq!(read_track(&added.path).unwrap().title, "People Are Strange");

        remove_added(&root, &added.path, added.size).expect("undo");
        assert!(!added.path.exists());
        assert!(!root.join("The Dead South").exists(), "emptied folders are removed");
        let _ = std::fs::remove_dir(&root);
    }

    // ---- placement follows the library

    fn lib_track(path: &str, artist: &str, album: &str, album_artist: &str) -> CachedTrack {
        CachedTrack {
            modified_ms: 1,
            size: 1,
            track: Track {
                path: path.into(),
                title: "t".into(),
                artist: artist.into(),
                album: album.into(),
                album_artist: album_artist.into(),
                track_number: None,
                disc_number: None,
                year: None,
                genre: String::new(),
                duration_ms: 1000,
                added_ms: 0,
            },
        }
    }

    fn song(artist: &str, album: &str) -> Proposal {
        Proposal { title: "New Song".into(), artist: artist.into(), album: album.into(), track: "3".into(), ..Default::default() }
    }

    const ROOT: &str = "/Volumes/homes/dwoodard/music/Music";

    fn at(rel: &str) -> String {
        format!("{ROOT}/{rel}")
    }

    #[test]
    fn an_artist_the_library_spells_differently_keeps_its_existing_folder() {
        let library = [lib_track(&at("AC_DC/Back in Black/01 Hells Bells.mp3"), "AC/DC", "Back in Black", "")];
        let placed = place(Path::new(ROOT), &song("AC/DC", "Highway to Hell"), "mp3", &library);
        assert_eq!(placed, PathBuf::from(at("AC_DC/Highway to Hell/03 New Song.mp3")));
    }

    #[test]
    fn an_album_the_library_already_has_keeps_its_existing_folder_and_spelling() {
        let library = [lib_track(&at("No Doubt/Tragic Kingdom/01 Spiderwebs.mp3"), "No Doubt", "Tragic Kingdom", "")];
        let placed = place(Path::new(ROOT), &song("no doubt", "TRAGIC KINGDOM"), "mp3", &library);
        assert_eq!(placed, PathBuf::from(at("No Doubt/Tragic Kingdom/03 New Song.mp3")));
        // A punctuation-only difference is still the same album.
        let placed = place(Path::new(ROOT), &song("No Doubt", "Tragic  Kingdom!"), "mp3", &library);
        assert_eq!(placed, PathBuf::from(at("No Doubt/Tragic Kingdom/03 New Song.mp3")));
    }

    #[test]
    fn a_new_artist_or_album_gets_folders_named_from_the_tags() {
        let library = [lib_track(&at("AJR/Neotheater/01 x.mp3"), "AJR", "Neotheater", "")];
        assert_eq!(place(Path::new(ROOT), &song("Eminem", "The Eminem Show"), "mp3", &library), PathBuf::from(at("Eminem/The Eminem Show/03 New Song.mp3")));
        // Known artist, album never seen: under the artist's folder.
        assert_eq!(place(Path::new(ROOT), &song("AJR", "Living Room"), "mp3", &library), PathBuf::from(at("AJR/Living Room/03 New Song.mp3")));
        // No album at all.
        assert_eq!(place(Path::new(ROOT), &song("AJR", ""), "mp3", &library), PathBuf::from(at("AJR/Unknown Album/03 New Song.mp3")));
    }

    #[test]
    fn no_artist_means_the_default_unknown_folders_even_if_the_library_has_unknown_songs() {
        let library = [lib_track(&at("Unknown Artist/Unknown Album/a.wav"), "", "", "")];
        assert_eq!(place(Path::new(ROOT), &song("", ""), "mp3", &library), PathBuf::from(at("Unknown Artist/Unknown Album/03 New Song.mp3")));
    }

    #[test]
    fn when_an_artist_is_split_across_folders_the_most_used_one_wins() {
        let library = [
            lib_track(&at("Eminem/Show/1.mp3"), "Eminem", "Show", ""),
            lib_track(&at("Eminem/Show/2.mp3"), "Eminem", "Show", ""),
            lib_track(&at("Slim Shady/Other/3.mp3"), "Eminem", "Other", ""),
        ];
        assert_eq!(place(Path::new(ROOT), &song("Eminem", "New"), "mp3", &library), PathBuf::from(at("Eminem/New/03 New Song.mp3")));
    }

    #[test]
    fn songs_outside_the_library_folder_and_in_hidden_folders_are_ignored() {
        let library = [
            lib_track("/somewhere/else/Eminem/Show/1.mp3", "Eminem", "Show", ""),
            lib_track(&at(".mixtape-duplicates/2026/Eminem/Show/2.mp3"), "Eminem", "Show", ""),
        ];
        assert_eq!(place(Path::new(ROOT), &song("Eminem", "Show"), "mp3", &library), PathBuf::from(at("Eminem/Show/03 New Song.mp3")));
    }

    #[test]
    fn the_album_artist_decides_the_artist_folder() {
        let library = [lib_track(&at("Various Artists/Hits/1.mp3"), "Guest One", "Hits", "Various Artists")];
        let p = Proposal { album_artist: "Various Artists".into(), ..song("Guest Two", "Hits") };
        assert_eq!(place(Path::new(ROOT), &p, "mp3", &library), PathBuf::from(at("Various Artists/Hits/03 New Song.mp3")));
    }

    #[test]
    fn a_stray_song_directly_in_an_artist_folder_marks_the_artist_but_not_an_album() {
        let library = [lib_track(&at("No Doubt/10 Don't Speak.mp3"), "No Doubt", "Tragic Kingdom", "")];
        // The stray file is not an album folder, so the album gets its own folder inside the artist's.
        assert_eq!(place(Path::new(ROOT), &song("No Doubt", "Tragic Kingdom"), "mp3", &library), PathBuf::from(at("No Doubt/Tragic Kingdom/03 New Song.mp3")));
    }

    #[test]
    fn folding_ignores_case_punctuation_and_spacing() {
        assert_eq!(fold("AC/DC"), fold("AC_DC"));
        assert_eq!(fold("Guns N' Roses"), fold("guns n roses"));
        assert_eq!(fold("Björk"), fold("björk"));
        assert_ne!(fold("AC/DC"), fold("ABBA"));
        assert_eq!(fold("!!!"), "");
    }

    #[test]
    fn adding_uses_the_library_s_existing_folders() {
        let work = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let existing = lib.path().join("The_Dead_South/Served Live/01 Old.mp3");
        let library = [lib_track(existing.to_str().unwrap(), "The Dead South", "Served Live", "")];

        let added = add_to_library(&staged(work.path()), &proposal(), lib.path(), &library, true, false).unwrap();

        assert_eq!(added.path, lib.path().join("The_Dead_South/Served Live/04 People Are Strange.mp3"));
        assert!(!lib.path().join("The Dead South").exists(), "no look-alike folder is created");
    }

    #[test]
    fn without_retagging_the_file_goes_in_byte_for_byte_and_keeps_its_own_tags() {
        let work = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let staged = staged(work.path());
        // Tags another program (Picard) wrote: different from what the proposal says.
        let by_picard = Proposal { title: "People Are Strange".into(), artist: "The Dead South".into(), album: "From Picard".into(), year: "2019".into(), track: "2".into(), genre: "Bluegrass".into(), ..Default::default() };
        write_tags(&staged, &to_edit(&by_picard)).unwrap();
        let before = std::fs::read(&staged).unwrap();
        let stale = Proposal { album: "Stale Guess".into(), ..by_picard.clone() };

        let added = add_to_library(&staged, &stale, lib.path(), &[], false, false).unwrap();

        assert_eq!(std::fs::read(&added.path).unwrap(), before, "not rewritten");
        assert_eq!(added.track.album, "From Picard");
    }

    #[test]
    fn a_proposal_can_be_read_back_from_a_tagged_track() {
        let t = Track { path: "/x.mp3".into(), title: "T".into(), artist: "A".into(), album: "B".into(), album_artist: "AA".into(), track_number: Some(3), disc_number: None, year: Some(1999), genre: "G".into(), duration_ms: 1, added_ms: 0 };
        let p = proposal_from_track(&t);
        assert_eq!((p.title.as_str(), p.artist.as_str(), p.album.as_str(), p.album_artist.as_str(), p.year.as_str(), p.track.as_str(), p.genre.as_str()), ("T", "A", "B", "AA", "1999", "3", "G"));
        let none = proposal_from_track(&Track { year: None, track_number: None, ..t });
        assert_eq!((none.year.as_str(), none.track.as_str()), ("", ""));
    }

    #[test]
    fn the_same_song_already_in_the_folder_is_not_added_again_even_when_the_saved_library_does_not_know_it() {
        let work = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let staged = staged(work.path());

        let first = add_to_library(&staged, &proposal(), lib.path(), &[], true, false).unwrap();
        // An empty library list: the file is on the disk but the app has not been told.
        let err = add_to_library(&staged, &proposal(), lib.path(), &[], true, false).unwrap_err();

        assert!(err.starts_with("Already in the library:"), "{err}");
        assert!(err.contains("04 People Are Strange.mp3") && err.contains("Add anyway"), "{err}");
        assert_eq!(std::fs::read_dir(first.path.parent().unwrap()).unwrap().count(), 1, "no second file, no leftovers");
    }

    #[test]
    fn a_different_song_with_the_same_file_name_is_still_added_under_a_free_name() {
        let work = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let staged = staged(work.path());
        let first = add_to_library(&staged, &proposal(), lib.path(), &[], true, false).unwrap();
        // Something else already sits at the place this one would go: same name, a different title inside.
        let mut other = proposal();
        other.title = "Something Else".into();
        other.track = "4".into();
        std::fs::rename(&first.path, first.path.with_file_name("04 Something Else.mp3")).unwrap();
        let again = add_to_library(&staged, &other, lib.path(), &[], true, false).unwrap();
        assert!(again.path.to_string_lossy().ends_with("04 Something Else (2).mp3"), "{:?}", again.path);
    }

    #[test]
    fn never_overwrites_an_existing_file() {
        let work = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let staged = staged(work.path());

        let first = add_to_library(&staged, &proposal(), lib.path(), &[], true, false).unwrap();
        // Asked for on purpose: a second copy of the same song.
        let second = add_to_library(&staged, &proposal(), lib.path(), &[], true, true).unwrap();

        assert_ne!(first.path, second.path);
        assert!(second.path.to_string_lossy().ends_with("04 People Are Strange (2).mp3"));
        assert!(first.path.exists() && second.path.exists());
    }

    #[test]
    fn an_unavailable_library_folder_is_reported_and_nothing_is_created() {
        let work = tempfile::tempdir().unwrap();
        let staged = staged(work.path());
        let err = add_to_library(&staged, &proposal(), Path::new("/Volumes/not-mounted/Music"), &[], true, false).unwrap_err();
        assert!(err.contains("not available"));
    }

    #[test]
    fn a_bad_tag_value_stops_the_add_before_anything_reaches_the_library() {
        let work = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let staged = staged(work.path());
        let bad = Proposal { year: "nineteen".into(), ..proposal() };

        assert!(add_to_library(&staged, &bad, lib.path(), &[], true, false).is_err());

        assert!(walk(lib.path()).iter().all(|p| p.is_dir() && p == lib.path() || p.extension().is_none()));
        assert!(!lib.path().join("The Dead South/Served Live").join("04 People Are Strange.mp3").exists());
        assert!(!walk(work.path()).iter().any(|p| p.to_string_lossy().contains(".tagging.")));
    }

    #[test]
    fn undo_removes_the_added_file_and_the_folders_it_emptied_but_not_the_library() {
        let work = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let added = add_to_library(&staged(work.path()), &proposal(), lib.path(), &[], true, false).unwrap();

        remove_added(lib.path(), &added.path, added.size).unwrap();

        assert!(!added.path.exists());
        assert!(!lib.path().join("The Dead South").exists(), "emptied folders are removed");
        assert!(lib.path().exists());
    }

    #[test]
    fn undo_keeps_folders_that_still_have_other_songs() {
        let work = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let a = add_to_library(&staged(work.path()), &proposal(), lib.path(), &[], true, false).unwrap();
        let other = Proposal { title: "Another".into(), track: "5".into(), ..proposal() };
        let b = add_to_library(&staged(work.path()), &other, lib.path(), &[], true, false).unwrap();

        remove_added(lib.path(), &a.path, a.size).unwrap();

        assert!(!a.path.exists() && b.path.exists());
    }

    #[test]
    fn undo_leaves_a_file_that_changed_and_refuses_paths_outside_the_library() {
        let work = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let added = add_to_library(&staged(work.path()), &proposal(), lib.path(), &[], true, false).unwrap();

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
