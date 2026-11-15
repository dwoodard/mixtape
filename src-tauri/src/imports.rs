//! The import pipeline: links become items that are probed, fetched,
//! converted, and held in a local staging folder until the user adds them to
//! the library. Running yt-dlp sits behind [`Runner`] so the pipeline can be
//! tested without a network.

use crate::importer::{
    clean_file_title, classify_link, destination, extract_link, find_picard, find_tool, open_in_picard, parse_meta, parse_playlist, parse_progress, place, proposal_from_track,
    remove_from_picard, suggest, LinkKind, Progress, Proposal, VideoMeta,
};
use crate::importer::to_edit;
use crate::library::CachedTrack;
use crate::tags::write_tags;
use crate::track::{is_audio_file, read_disc_total, read_track};
use std::time::{Duration, SystemTime};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};

/// Videos fetched at the same time.
const MAX_AT_ONCE: usize = 2;
/// Most videos taken from one playlist.
const PLAYLIST_LIMIT: usize = 50;
pub const FORMATS: [&str; 3] = ["mp3", "m4a", "flac"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    /// Listed from a playlist but not fetched: nothing downloads until the person asks for it.
    Held,
    Queued,
    Probing,
    Fetching,
    Converting,
    Ready,
    Added,
    Failed,
}

/// Whether the song has been handed to MusicBrainz Picard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PicardState {
    /// Not sent to Picard: tags come from YouTube and the user.
    None,
    /// Open in Picard; waiting for it to be saved there.
    Waiting,
    /// Saved in Picard: the tags below are what Picard wrote and are not rewritten.
    Saved,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    pub id: u64,
    pub url: String,
    pub stage: Stage,
    /// 0 to 1 while fetching.
    pub progress: f32,
    pub error: Option<String>,
    pub video_title: String,
    pub channel: String,
    pub duration_secs: Option<u64>,
    pub proposal: Proposal,
    pub sources: BTreeMap<String, String>,
    pub alternatives: BTreeMap<String, Vec<String>>,
    pub notes: Vec<String>,
    pub confidence: f32,
    pub format: String,
    /// Where it will go, relative to the library folder.
    pub destination: Option<String>,
    pub added_path: Option<String>,
    pub picard: PicardState,
    #[serde(skip)]
    staged: Option<PathBuf>,
    #[serde(skip)]
    added_size: u64,
}

/// Whether a song is still being brought in: waiting its turn, being looked up, downloaded or converted.
fn is_loading(stage: Stage) -> bool {
    matches!(stage, Stage::Queued | Stage::Probing | Stage::Fetching | Stage::Converting)
}

/// The songs that can be stopped: those still loading, narrowed to `wanted` when it is given.
fn loading_ids(items: &[ImportItem], wanted: Option<&[u64]>) -> Vec<u64> {
    items.iter().filter(|i| is_loading(i.stage) && wanted.is_none_or(|w| w.contains(&i.id))).map(|i| i.id).collect()
}

/// Where an item's file is: in the library once added, the fetched copy while it is ready, nowhere before or after that.
fn file_of_item(item: &ImportItem) -> Result<PathBuf, String> {
    match (item.stage, &item.added_path, &item.staged) {
        (Stage::Added, Some(path), _) => Ok(PathBuf::from(path)),
        (Stage::Ready, _, Some(staged)) => Ok(staged.clone()),
        (Stage::Failed, ..) => Err("That one failed, so there is no file.".into()),
        _ => Err("The song has no file yet.".into()),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum ImportEvent {
    Item(Box<ImportItem>),
    Removed(u64),
}

/// Tag edits from the user. `None` leaves a field alone.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TagsPatch {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub year: Option<String>,
    pub track: Option<String>,
    pub genre: Option<String>,
}

/// Lets a running download be stopped.
#[derive(Default)]
pub struct KillSwitch {
    child: Mutex<Option<Child>>,
}

impl KillSwitch {
    pub fn kill(&self) {
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.kill();
        }
    }
}

/// Talks to yt-dlp. Faked in tests.
pub trait Runner: Send + Sync {
    /// yt-dlp's JSON for one video.
    fn probe(&self, url: &str) -> Result<String, String>;
    /// yt-dlp's flat JSON listing of a playlist.
    fn playlist(&self, url: &str) -> Result<String, String>;
    /// Where MusicBrainz Picard is installed, if it is.
    fn picard(&self) -> Option<String>;
    /// Opens a file in Picard.
    fn open_in_picard(&self, file: &Path) -> Result<(), String>;
    /// Tells Picard to forget a file (best effort).
    fn close_in_picard(&self, file: &Path);
    /// Converts any audio or video file to an mp3 (needs ffmpeg).
    fn convert(&self, _input: &Path, _output: &Path) -> Result<(), String> {
        Err("Converting this kind of file needs ffmpeg. In a terminal: brew install ffmpeg".into())
    }
    /// Downloads and converts, passing each output line to `line`.
    fn fetch(&self, url: &str, format: &str, dir: &Path, line: &mut dyn FnMut(&str), kill: &KillSwitch) -> Result<(), String>;
}

/// A friendlier sentence for the usual yt-dlp failures.
pub fn friendly_error(stderr: &str) -> String {
    let last = stderr.lines().rev().find(|l| l.contains("ERROR")).unwrap_or(stderr).trim();
    let lower = last.to_lowercase();
    if lower.contains("private video") {
        "This video is private.".into()
    } else if lower.contains("sign in") || lower.contains("age-restricted") || lower.contains("confirm your age") {
        "YouTube wants a sign-in for this video (age or region restricted), so it can't be fetched.".into()
    } else if lower.contains("unavailable") || lower.contains("not available") {
        "This video is unavailable.".into()
    } else if lower.contains("copyright") {
        "This video is blocked on copyright grounds.".into()
    } else if lower.contains("unable to download") || lower.contains("urlopen") || lower.contains("network") {
        "Couldn't reach YouTube. Check the connection and try again.".into()
    } else {
        let cleaned = last.trim_start_matches("ERROR:").trim();
        if cleaned.is_empty() { "Fetching failed.".into() } else { cleaned.chars().take(200).collect() }
    }
}

/// The real thing: runs `yt-dlp` (which uses `ffmpeg` to convert).
pub struct YtDlp {
    yt_dlp: PathBuf,
    ffmpeg_dir: PathBuf,
}

impl YtDlp {
    pub fn locate() -> Result<YtDlp, String> {
        let yt_dlp = find_tool("yt-dlp").ok_or("yt-dlp isn't installed. In a terminal: brew install yt-dlp ffmpeg")?;
        let ffmpeg = find_tool("ffmpeg").ok_or("ffmpeg isn't installed. In a terminal: brew install ffmpeg")?;
        let ffmpeg_dir = ffmpeg.parent().map(Path::to_path_buf).unwrap_or_default();
        Ok(YtDlp { yt_dlp, ffmpeg_dir })
    }

    fn capture(&self, args: &[&str]) -> Result<String, String> {
        let out = Command::new(&self.yt_dlp).args(args).output().map_err(|e| format!("Couldn't run yt-dlp: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(friendly_error(&String::from_utf8_lossy(&out.stderr)))
        }
    }
}

impl Runner for YtDlp {
    fn picard(&self) -> Option<String> {
        find_picard().map(|p| p.display().to_string())
    }

    fn open_in_picard(&self, file: &Path) -> Result<(), String> {
        let app = find_picard().ok_or("MusicBrainz Picard isn't installed. In a terminal: brew install --cask musicbrainz-picard")?;
        open_in_picard(&app, file)
    }

    fn close_in_picard(&self, file: &Path) {
        if let Some(app) = find_picard() {
            remove_from_picard(&app, file);
        }
    }

    fn probe(&self, url: &str) -> Result<String, String> {
        self.capture(&["--skip-download", "--no-warnings", "--no-playlist", "-j", "--", url])
    }

    fn playlist(&self, url: &str) -> Result<String, String> {
        self.capture(&["--flat-playlist", "-J", "--no-warnings", "--", url])
    }

    fn convert(&self, input: &Path, output: &Path) -> Result<(), String> {
        let out = Command::new(self.ffmpeg_dir.join("ffmpeg"))
            .args(["-y", "-nostdin", "-loglevel", "error", "-i"])
            .arg(input)
            .args(["-vn", "-map_metadata", "0", "-codec:a", "libmp3lame", "-q:a", "0"])
            .arg(output)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("Couldn't run ffmpeg: {e}"))?;
        if out.status.success() {
            return Ok(());
        }
        let text = String::from_utf8_lossy(&out.stderr);
        let reason = text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("it gave no reason");
        Err(format!("Couldn't convert this file: {reason}"))
    }

    fn fetch(&self, url: &str, format: &str, dir: &Path, line: &mut dyn FnMut(&str), kill: &KillSwitch) -> Result<(), String> {
        let output = format!("{}/%(id)s.%(ext)s", dir.display());
        let mut cmd = Command::new(&self.yt_dlp);
        cmd.args(["--no-playlist", "--newline", "--no-warnings", "--progress", "-x", "--audio-format", format]);
        match format {
            "mp3" => cmd.args(["--audio-quality", "320K"]),
            "m4a" => cmd.args(["--audio-quality", "0"]),
            _ => &mut cmd,
        };
        cmd.arg("--ffmpeg-location").arg(&self.ffmpeg_dir);
        cmd.args([
            "--progress-template",
            "download:PROG|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s",
            "--progress-template",
            "postprocess:POST|%(progress.postprocessor)s|%(progress.status)s",
            "-o",
            &output,
            "--print",
            "after_move:FILE|%(filepath)s",
            "--",
            url,
        ]);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());

        let mut child = cmd.spawn().map_err(|e| format!("Couldn't run yt-dlp: {e}"))?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        *kill.child.lock().unwrap() = Some(child);

        // yt-dlp prints download progress and the final file on stdout but the
        // conversion steps on stderr, so both are read and merged.
        let (tx, rx) = std::sync::mpsc::channel::<(bool, String)>();
        let tx_err = tx.clone();
        let out_reader = std::thread::spawn(move || {
            for l in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = tx.send((false, l));
            }
        });
        let err_reader = std::thread::spawn(move || {
            for l in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = tx_err.send((true, l));
            }
        });
        let mut error_text = String::new();
        for (from_stderr, l) in rx {
            if parse_progress(&l).is_some() {
                line(&l);
            } else if from_stderr {
                error_text.push_str(&l);
                error_text.push('\n');
            }
        }
        let _ = out_reader.join();
        let _ = err_reader.join();
        let status = kill.child.lock().unwrap().take().map(|mut c| c.wait());
        match status {
            Some(Ok(s)) if s.success() => Ok(()),
            _ => Err(friendly_error(&error_text)),
        }
    }
}

type Emit = Box<dyn Fn(&ImportEvent) + Send + Sync>;

/// What the library looks like right now, so songs are placed to match it.
#[derive(Default)]
pub struct LibraryView {
    pub root: Option<PathBuf>,
    pub tracks: Vec<CachedTrack>,
}

type LibraryProvider = Box<dyn Fn() -> LibraryView + Send + Sync>;

struct State {
    items: Vec<ImportItem>,
    switches: HashMap<u64, Arc<KillSwitch>>,
    cancelled: HashSet<u64>,
    /// Items whose add is in progress, so one song is not added twice at once.
    adding: HashSet<u64>,
    /// Which Picard watcher is current for each song; an older one stops itself.
    watch_gen: HashMap<u64, u64>,
    next_id: u64,
}

struct Inner {
    state: Mutex<State>,
    staging: PathBuf,
    runner: Box<dyn Runner>,
    library: LibraryProvider,
    emit: Emit,
    /// How often the staging folder is checked while a song is open in Picard.
    poll: Duration,
    slots: (Mutex<usize>, Condvar),
}

/// Cheap to clone; all clones share the same items.
#[derive(Clone)]
pub struct Imports {
    inner: Arc<Inner>,
}

fn extension_of(format: &str) -> &str {
    if FORMATS.contains(&format) { format } else { "mp3" }
}

impl Imports {
    /// Starts empty. Anything left in `staging` from an earlier run is
    /// cleared, because items live only while the app is open.
    pub fn new(staging: PathBuf, runner: Box<dyn Runner>, library: LibraryProvider, emit: Emit) -> Imports {
        Imports::with_poll(staging, runner, library, emit, Duration::from_secs(1))
    }

    pub fn with_poll(staging: PathBuf, runner: Box<dyn Runner>, library: LibraryProvider, emit: Emit, poll: Duration) -> Imports {
        let _ = std::fs::remove_dir_all(&staging);
        let _ = std::fs::create_dir_all(&staging);
        Imports {
            inner: Arc::new(Inner {
                state: Mutex::new(State { items: Vec::new(), switches: HashMap::new(), cancelled: HashSet::new(), adding: HashSet::new(), watch_gen: HashMap::new(), next_id: 1 }),
                staging,
                runner,
                library,
                emit,
                poll,
                slots: (Mutex::new(0), Condvar::new()),
            }),
        }
    }

    pub fn list(&self) -> Vec<ImportItem> {
        self.inner.state.lock().unwrap().items.clone()
    }

    /// Where this song would go, relative to the library folder, following
    /// the folders the library already has.
    fn preview(&self, proposal: &Proposal, ext: &str) -> String {
        let view = (self.inner.library)();
        match view.root {
            Some(root) => place(&root, proposal, ext, &view.tracks).strip_prefix(&root).map(|p| p.to_path_buf()).unwrap_or_default(),
            None => destination(Path::new(""), proposal, ext),
        }
        .to_string_lossy()
        .into_owned()
    }

    fn emit_item(&self, item: &ImportItem) {
        (self.inner.emit)(&ImportEvent::Item(Box::new(item.clone())));
    }

    /// Changes one item and tells the UI. Returns `None` if it is gone.
    fn update<R>(&self, id: u64, change: impl FnOnce(&mut ImportItem) -> R) -> Option<R> {
        let (result, snapshot) = {
            let mut state = self.inner.state.lock().unwrap();
            let item = state.items.iter_mut().find(|i| i.id == id)?;
            let result = change(item);
            (result, item.clone())
        };
        self.emit_item(&snapshot);
        Some(result)
    }

    fn new_item(&self, url: &str, format: &str, title_hint: &str) -> Result<u64, String> {
        let mut state = self.inner.state.lock().unwrap();
        if state.items.iter().any(|i| i.url == url && i.stage != Stage::Failed) {
            return Err("That link is already in the list.".into());
        }
        let id = state.next_id;
        state.next_id += 1;
        let item = ImportItem {
            id,
            url: url.to_string(),
            stage: Stage::Queued,
            progress: 0.0,
            error: None,
            video_title: title_hint.to_string(),
            channel: String::new(),
            duration_secs: None,
            proposal: Proposal::default(),
            sources: BTreeMap::new(),
            alternatives: BTreeMap::new(),
            notes: Vec::new(),
            confidence: 0.0,
            format: extension_of(format).to_string(),
            destination: None,
            added_path: None,
            picard: PicardState::None,
            staged: None,
            added_size: 0,
        };
        state.items.push(item.clone());
        drop(state);
        self.emit_item(&item);
        Ok(id)
    }

    /// Adds a pasted link (with the video title if it came with it). A video
    /// starts fetching; a playlist is listed and each entry becomes an item.
    pub fn add_link(&self, text: &str, format: &str) -> Result<(), String> {
        let (url, hint) = extract_link(text);
        match classify_link(&url) {
            LinkKind::YoutubeVideo => {
                let id = self.new_item(&url, format, &hint)?;
                self.spawn_pipeline(id, hint);
                Ok(())
            }
            LinkKind::YoutubePlaylist => {
                let this = self.clone();
                let format = format.to_string();
                std::thread::spawn(move || match this.inner.runner.playlist(&url).and_then(|j| parse_playlist(&j, PLAYLIST_LIMIT)) {
                    Ok((_name, entries)) => {
                        // Listed, not fetched: a playlist can be hundreds of songs, and the person picks the ones they want.
                        for (link, title) in entries {
                            if let Ok(id) = this.new_item(&link, &format, &title) {
                                this.update(id, |i| i.stage = Stage::Held);
                            }
                        }
                    }
                    Err(e) => {
                        if let Ok(id) = this.new_item(&url, &format, "Playlist") {
                            this.fail(id, e);
                        }
                    }
                });
                Ok(())
            }
            LinkKind::Unsupported => Err("That isn't a YouTube video or playlist link. (Spotify isn't set up yet.)".into()),
        }
    }

    /// Adds audio files from disk. Files the player can read are copied into
    /// staging as they are; anything else (video containers like .webm and
    /// .mkv, .opus, .wma, .aiff…) is converted to mp3 first. Each becomes an
    /// item to review and add, like a link. Returns how many were new.
    pub fn add_files(&self, paths: &[String]) -> Result<usize, String> {
        let mut started = 0;
        for text in paths {
            let path = PathBuf::from(text);
            if !path.is_file() {
                continue;
            }
            let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            // Already in the list: nothing to do for this one.
            let Ok(id) = self.new_item(text, "mp3", &stem) else { continue };
            started += 1;
            let this = self.clone();
            std::thread::spawn(move || {
                this.acquire_slot();
                this.run_file_pipeline(id, &path);
                this.release_slot();
            });
        }
        if started == 0 {
            return Err("Nothing new to add: those files are missing or already in the list.".into());
        }
        Ok(started)
    }

    /// Stage one picked file (copy or convert), read its tags, and make it ready to review.
    pub fn run_file_pipeline(&self, id: u64, path: &Path) {
        if self.is_cancelled(id) {
            return;
        }
        let dir = self.inner.staging.join(id.to_string());
        if let Err(e) = std::fs::create_dir_all(&dir) {
            return self.fail(id, format!("Couldn't create the staging folder: {e}"));
        }
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let staged = if is_audio_file(path) {
            self.update(id, |i| i.stage = Stage::Probing);
            let target = dir.join(path.file_name().unwrap_or_default());
            std::fs::copy(path, &target).map(|_| target).map_err(|e| format!("Couldn't copy the file: {e}"))
        } else {
            self.update(id, |i| i.stage = Stage::Converting);
            let target = dir.join(format!("{stem}.mp3"));
            self.inner.runner.convert(path, &target).map(|_| target)
        };
        if self.is_cancelled(id) {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let staged = match staged {
            Ok(s) => s,
            Err(e) => return self.fail(id, e),
        };
        let Some(track) = read_track(&staged) else {
            return self.fail(id, "That file has no audio this app can read.".into());
        };

        let mut proposal = proposal_from_track(&track);
        proposal.disc_total = read_disc_total(&staged).map(|n| n.to_string()).unwrap_or_default();
        let mut sources: BTreeMap<String, String> = BTreeMap::new();
        let mut notes = Vec::new();
        let mut confidence = 0.9;
        if proposal.artist.trim().is_empty() {
            // Untagged (the title is just the file name): read artist and title out of the name.
            let meta = VideoMeta { title: clean_file_title(&track.title), ..Default::default() };
            let guess = suggest(&meta, None);
            if !guess.proposal.artist.is_empty() {
                proposal.artist = guess.proposal.artist;
            }
            if !guess.proposal.title.is_empty() {
                proposal.title = guess.proposal.title;
            }
            for (field, value) in [("title", &proposal.title), ("artist", &proposal.artist)] {
                if !value.trim().is_empty() {
                    sources.insert(field.to_string(), "File name".to_string());
                }
            }
            notes.push("This file had no tags. Check the artist and title.".to_string());
            confidence = 0.4;
        } else {
            for (field, value) in [("title", &proposal.title), ("artist", &proposal.artist), ("album", &proposal.album), ("albumArtist", &proposal.album_artist), ("year", &proposal.year), ("track", &proposal.track), ("genre", &proposal.genre)] {
                if !value.trim().is_empty() {
                    sources.insert(field.to_string(), "File tags".to_string());
                }
            }
        }
        let ext = staged.extension().and_then(|e| e.to_str()).unwrap_or("mp3").to_string();
        let preview = self.preview(&proposal, &ext);
        self.update(id, |i| {
            i.video_title = stem.clone();
            i.duration_secs = Some(track.duration_ms / 1000);
            i.destination = Some(preview);
            i.proposal = proposal;
            i.sources = sources;
            i.notes = notes;
            i.confidence = confidence;
            i.format = ext;
            i.stage = Stage::Ready;
            i.progress = 1.0;
            i.staged = Some(staged);
        });
    }

    fn fail(&self, id: u64, message: String) {
        self.update(id, |i| {
            i.stage = Stage::Failed;
            i.error = Some(message);
        });
    }

    fn spawn_pipeline(&self, id: u64, hint: String) {
        let this = self.clone();
        std::thread::spawn(move || {
            this.acquire_slot();
            this.run_pipeline(id, &hint);
            this.release_slot();
        });
    }

    fn acquire_slot(&self) {
        let (lock, cv) = &self.inner.slots;
        let mut n = lock.lock().unwrap();
        while *n >= MAX_AT_ONCE {
            n = cv.wait(n).unwrap();
        }
        *n += 1;
    }

    fn release_slot(&self) {
        let (lock, cv) = &self.inner.slots;
        *lock.lock().unwrap() -= 1;
        cv.notify_one();
    }

    fn is_cancelled(&self, id: u64) -> bool {
        self.inner.state.lock().unwrap().cancelled.contains(&id)
    }

    /// Probe, fetch, convert. Runs on its own thread.
    pub fn run_pipeline(&self, id: u64, hint: &str) {
        if self.is_cancelled(id) {
            return;
        }
        let Some((url, format)) = self.update(id, |i| {
            i.stage = Stage::Probing;
            (i.url.clone(), i.format.clone())
        }) else {
            return;
        };

        // 1. What does YouTube say about it?
        let meta = match self.inner.runner.probe(&url).and_then(|j| parse_meta(&j)) {
            Ok(m) => m,
            Err(e) => return self.fail(id, e),
        };
        let suggestion = suggest(&meta, Some(hint));
        let preview = self.preview(&suggestion.proposal, &format);
        self.update(id, |i| {
            i.video_title = if hint.is_empty() { meta.title.clone() } else { hint.to_string() };
            i.channel = meta.channel.clone();
            i.duration_secs = meta.duration_secs;
            i.destination = Some(preview);
            i.proposal = suggestion.proposal.clone();
            i.sources = suggestion.sources.clone();
            i.alternatives = suggestion.alternatives.clone();
            i.notes = suggestion.notes.clone();
            i.confidence = suggestion.confidence;
            i.stage = Stage::Fetching;
        });

        // 2. Fetch and convert into this item's own staging folder.
        let dir = self.inner.staging.join(id.to_string());
        if let Err(e) = std::fs::create_dir_all(&dir) {
            return self.fail(id, format!("Couldn't create the staging folder: {e}"));
        }
        let switch = Arc::new(KillSwitch::default());
        self.inner.state.lock().unwrap().switches.insert(id, switch.clone());
        let mut file: Option<String> = None;
        let result = self.inner.runner.fetch(
            &url,
            &format,
            &dir,
            &mut |line| match parse_progress(line) {
                Some(Progress::Download { done, total }) if total > 0 => {
                    self.update(id, |i| i.progress = (done as f32 / total as f32).clamp(0.0, 1.0));
                }
                Some(Progress::Post { name, finished: false }) if name == "ExtractAudio" => {
                    self.update(id, |i| {
                        i.stage = Stage::Converting;
                        i.progress = 1.0;
                    });
                }
                Some(Progress::File(path)) => file = Some(path),
                _ => {}
            },
            &switch,
        );
        self.inner.state.lock().unwrap().switches.remove(&id);

        if self.is_cancelled(id) {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        match (result, file) {
            (Ok(()), Some(path)) if Path::new(&path).is_file() => {
                self.update(id, |i| {
                    i.stage = Stage::Ready;
                    i.progress = 1.0;
                    i.staged = Some(PathBuf::from(path));
                });
            }
            (Ok(()), _) => self.fail(id, "Fetching finished but no audio file was produced.".into()),
            (Err(e), _) => self.fail(id, e),
        }
    }

    /// Applies the user's tag edits. Edited fields are marked as such. Once
    /// Picard has saved the song its tags are Picard's and cannot be edited here.
    pub fn set_tags(&self, id: u64, patch: TagsPatch) -> Result<ImportItem, String> {
        let (mut proposal, ext, picard) = {
            let state = self.inner.state.lock().unwrap();
            let item = state.items.iter().find(|i| i.id == id).ok_or("That item is gone.")?;
            (item.proposal.clone(), item.format.clone(), item.picard)
        };
        if picard == PicardState::Saved {
            return Err("These tags come from Picard. To change them, edit and save in Picard.".into());
        }
        let mut changed: Vec<&str> = Vec::new();
        let mut set = |field: &'static str, slot: &mut String, value: Option<String>| {
            if let Some(v) = value {
                if *slot != v {
                    *slot = v;
                    changed.push(field);
                }
            }
        };
        set("title", &mut proposal.title, patch.title);
        set("artist", &mut proposal.artist, patch.artist);
        set("album", &mut proposal.album, patch.album);
        set("albumArtist", &mut proposal.album_artist, patch.album_artist);
        set("year", &mut proposal.year, patch.year);
        set("track", &mut proposal.track, patch.track);
        set("genre", &mut proposal.genre, patch.genre);
        let preview = self.preview(&proposal, &ext);
        self.update(id, |i| {
            i.proposal = proposal;
            for field in changed {
                i.sources.insert(field.to_string(), "edited by you".to_string());
            }
            i.destination = Some(preview);
            i.clone()
        })
        .ok_or_else(|| "That item is gone.".to_string())
    }

    /// Starts fetching songs that were held back from a playlist: the ones in `wanted`, or all of them when it is None.
    /// Returns how many were started.
    pub fn fetch_held(&self, wanted: Option<&[u64]>) -> usize {
        let hints: Vec<(u64, String)> = {
            let state = self.inner.state.lock().unwrap();
            state.items.iter().filter(|i| i.stage == Stage::Held && wanted.is_none_or(|w| w.contains(&i.id))).map(|i| (i.id, i.video_title.clone())).collect()
        };
        for (id, hint) in &hints {
            self.update(*id, |i| i.stage = Stage::Queued);
            self.spawn_pipeline(*id, hint.clone());
        }
        hints.len()
    }

    /// Stops songs that are still loading and takes them out of the list: the ones in `wanted`, or all of them when it is
    /// None. Downloads in progress are killed and songs still waiting for their turn never start. Songs that are ready,
    /// added or failed are left alone. Returns how many were stopped.
    pub fn stop_loading(&self, wanted: Option<&[u64]>) -> usize {
        let ids = loading_ids(&self.inner.state.lock().unwrap().items, wanted);
        for id in &ids {
            self.remove(*id);
        }
        ids.len()
    }

    /// The song's file on disk, for showing it in Finder: the one in the library once it is added, or the fetched
    /// copy while it waits for review.
    pub fn file_of(&self, id: u64) -> Result<PathBuf, String> {
        let state = self.inner.state.lock().unwrap();
        let item = state.items.iter().find(|i| i.id == id).ok_or("That item is gone.")?;
        file_of_item(item)
    }

    /// Hands the staged song to MusicBrainz Picard and starts watching for it
    /// to be saved there. Picard may rename the file when it saves, so the
    /// song's whole staging folder is watched, not one file name.
    pub fn open_in_picard(&self, id: u64) -> Result<(), String> {
        let (dir, staged, saved, proposal) = {
            let state = self.inner.state.lock().unwrap();
            let item = state.items.iter().find(|i| i.id == id).ok_or("That item is gone.")?;
            if item.stage != Stage::Ready {
                return Err("The song isn't ready yet.".into());
            }
            (
                self.inner.staging.join(id.to_string()),
                item.staged.clone().ok_or("The song has no file yet.")?,
                item.picard == PicardState::Saved,
                item.proposal.clone(),
            )
        };
        // The fetched file has no tags of its own. Write what we know (title,
        // artist, year...) into it first, so Picard shows and can look up the
        // song instead of an untitled file named after the video id. Not when
        // the song was already tagged by Picard: those tags must be left alone.
        if !saved {
            write_tags(&staged, &to_edit(&proposal)).map_err(|e| format!("Couldn't prepare the file for Picard: {e}"))?;
        }
        // Measured after the tags above, so that change isn't mistaken for Picard saving.
        let baseline = newest_audio(&dir).ok_or("The fetched file is missing.")?;
        self.inner.runner.open_in_picard(&staged)?;
        self.update(id, |i| i.picard = PicardState::Waiting);

        // A new watcher with a fresh baseline replaces any earlier one (sending again).
        let generation = {
            let mut state = self.inner.state.lock().unwrap();
            let g = state.watch_gen.entry(id).or_insert(0);
            *g += 1;
            *g
        };
        let this = self.clone();
        std::thread::spawn(move || this.watch_picard(id, dir, baseline, generation));
        Ok(())
    }

    /// Stops waiting for Picard and takes the song's working file out of
    /// Picard. The song goes back to being a normal ready song. Does nothing
    /// if it isn't waiting (so a late click is harmless).
    pub fn cancel_picard(&self, id: u64) -> Result<(), String> {
        let file = {
            let mut state = self.inner.state.lock().unwrap();
            let item = state.items.iter_mut().find(|i| i.id == id).ok_or("That item is gone.")?;
            if item.picard != PicardState::Waiting {
                return Ok(());
            }
            item.picard = PicardState::None;
            item.staged.clone()
        };
        // The watcher notices the state change on its next check and stops.
        self.update(id, |_| ());
        if let Some(file) = file {
            let this = self.clone();
            std::thread::spawn(move || this.inner.runner.close_in_picard(&file));
        }
        Ok(())
    }

    /// Polls the song's staging folder until Picard has saved (changed or
    /// renamed the file) or taken it away, the song is removed, or half an
    /// hour passes.
    fn watch_picard(&self, id: u64, dir: PathBuf, baseline: Fingerprint, generation: u64) {
        let polls = (Duration::from_secs(30 * 60).as_millis() / self.inner.poll.as_millis().max(1)) as u64;
        let mut missing = 0;
        // A changed file is only accepted once it has stayed the same for two
        // checks in a row: Picard writes the tags and *then* renames the file,
        // and catching it in between would leave us pointing at a name that is
        // about to disappear.
        let mut pending: Option<Fingerprint> = None;
        for _ in 0..polls {
            std::thread::sleep(self.inner.poll);
            let (waiting, current) = {
                let state = self.inner.state.lock().unwrap();
                (state.items.iter().find(|i| i.id == id).map(|i| i.picard), state.watch_gen.get(&id) == Some(&generation))
            };
            if waiting != Some(PicardState::Waiting) || !current {
                return;
            }
            match newest_audio(&dir) {
                None => {
                    // Allow a moment for a rename to finish before deciding it was moved away.
                    missing += 1;
                    if missing >= 3 {
                        self.fail(
                            id,
                            "Picard moved the song out of its working folder. If it moved it into your library, use Refresh library. \
                             Otherwise, in Picard's Options → File Naming turn off “Move files”, then bring the link in again."
                                .into(),
                        );
                        return;
                    }
                }
                Some(now) if now != baseline => {
                    missing = 0;
                    if pending.as_ref() == Some(&now) {
                        self.picard_saved(id, now.path);
                        return;
                    }
                    pending = Some(now);
                }
                Some(_) => {
                    missing = 0;
                    pending = None;
                }
            }
        }
        self.update(id, |i| {
            if i.picard == PicardState::Waiting {
                i.picard = PicardState::None;
            }
        });
    }

    /// Picard saved the song: take its tags as they are now on the file.
    fn picard_saved(&self, id: u64, path: PathBuf) {
        let Some(track) = read_track(&path) else {
            return self.fail(id, "Picard saved the song but its tags couldn't be read.".into());
        };
        let mut proposal = proposal_from_track(&track);
        proposal.disc_total = read_disc_total(&path).map(|n| n.to_string()).unwrap_or_default();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("mp3").to_string();
        let preview = self.preview(&proposal, &ext);
        self.update(id, |i| {
            i.sources = [("title", &proposal.title), ("artist", &proposal.artist), ("album", &proposal.album), ("albumArtist", &proposal.album_artist), ("year", &proposal.year), ("track", &proposal.track), ("genre", &proposal.genre)]
                .into_iter()
                .filter(|(_, v)| !v.trim().is_empty())
                .map(|(k, _)| (k.to_string(), "MusicBrainz Picard".to_string()))
                .collect();
            i.alternatives.clear();
            i.notes = vec!["Tags written by MusicBrainz Picard.".to_string()];
            i.confidence = 1.0;
            i.proposal = proposal;
            i.destination = Some(preview);
            i.format = ext;
            i.staged = Some(path);
            i.picard = PicardState::Saved;
        });
    }

    /// What adding needs, once the item is ready.
    pub fn take_for_add(&self, id: u64) -> Result<(PathBuf, Proposal, bool), String> {
        let mut state = self.inner.state.lock().unwrap();
        if state.adding.contains(&id) {
            return Err("This song is already being added.".into());
        }
        let item = state.items.iter().find(|i| i.id == id).ok_or("That item is gone.")?;
        match (item.stage, &item.staged) {
            (Stage::Ready, Some(path)) => {
                // Tags Picard wrote are left exactly as they are.
                let taken = (path.clone(), item.proposal.clone(), item.picard != PicardState::Saved);
                state.adding.insert(id);
                Ok(taken)
            }
            (Stage::Added, _) => Err("Already added.".into()),
            _ => Err("This song isn't ready yet.".into()),
        }
    }

    /// An add that failed: lets the item be added again.
    pub fn abort_add(&self, id: u64) {
        self.inner.state.lock().unwrap().adding.remove(&id);
    }

    pub fn mark_added(&self, id: u64, path: &Path, size: u64) {
        self.inner.state.lock().unwrap().adding.remove(&id);
        self.update(id, |i| {
            i.stage = Stage::Added;
            i.added_path = Some(path.to_string_lossy().into_owned());
            i.added_size = size;
        });
    }

    /// What undoing an add needs: the file added and its size.
    pub fn take_for_undo(&self, id: u64) -> Result<(PathBuf, u64), String> {
        let state = self.inner.state.lock().unwrap();
        let item = state.items.iter().find(|i| i.id == id).ok_or("That item is gone.")?;
        match (item.stage, &item.added_path) {
            (Stage::Added, Some(path)) => Ok((PathBuf::from(path), item.added_size)),
            _ => Err("This song hasn't been added.".into()),
        }
    }

    pub fn mark_undone(&self, id: u64) {
        self.update(id, |i| {
            i.stage = Stage::Ready;
            i.added_path = None;
            i.added_size = 0;
        });
    }

    /// Takes a song's working file out of Picard once we are done with it, so
    /// Picard isn't left holding a file that is about to be deleted.
    pub fn release_from_picard(&self, id: u64) {
        let file = {
            let state = self.inner.state.lock().unwrap();
            state.items.iter().find(|i| i.id == id).filter(|i| i.picard != PicardState::None).and_then(|i| i.staged.clone())
        };
        if let Some(file) = file {
            let this = self.clone();
            std::thread::spawn(move || this.inner.runner.close_in_picard(&file));
        }
    }

    /// Stops a running fetch if there is one, deletes the staged file, and
    /// drops the item. A song already added to the library stays there.
    pub fn remove(&self, id: u64) {
        self.release_from_picard(id);
        let (switch, staged_dir) = {
            let mut state = self.inner.state.lock().unwrap();
            state.cancelled.insert(id);
            state.items.retain(|i| i.id != id);
            (state.switches.get(&id).cloned(), self.inner.staging.join(id.to_string()))
        };
        if let Some(s) = switch {
            s.kill();
        }
        let _ = std::fs::remove_dir_all(staged_dir);
        (self.inner.emit)(&ImportEvent::Removed(id));
    }
}

/// What a staged file looked like when last checked.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fingerprint {
    path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
}

/// The newest audio file in a song's staging folder.
fn newest_audio(dir: &Path) -> Option<Fingerprint> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_audio_file(p) && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')))
        .filter_map(|path| {
            let meta = std::fs::metadata(&path).ok()?;
            Some(Fingerprint { size: meta.len(), modified: meta.modified().ok(), path })
        })
        .max_by_key(|f| f.modified)
}

#[cfg(test)]
mod tests {

    fn blank_item(id: u64, stage: Stage) -> ImportItem {
        ImportItem {
            id,
            url: String::new(),
            stage,
            progress: 0.0,
            error: None,
            video_title: String::new(),
            channel: String::new(),
            duration_secs: None,
            proposal: Proposal::default(),
            sources: BTreeMap::new(),
            alternatives: BTreeMap::new(),
            notes: Vec::new(),
            confidence: 0.0,
            format: "mp3".into(),
            destination: None,
            added_path: None,
            picard: PicardState::None,
            staged: None,
            added_size: 0,
        }
    }

    #[test]
    fn only_songs_still_loading_can_be_stopped() {
        let items = vec![
            blank_item(1, Stage::Queued),
            blank_item(2, Stage::Probing),
            blank_item(3, Stage::Fetching),
            blank_item(4, Stage::Converting),
            blank_item(5, Stage::Ready),
            blank_item(6, Stage::Added),
            blank_item(7, Stage::Failed),
        ];
        assert_eq!(loading_ids(&items, None), vec![1, 2, 3, 4]);
        // Asking for songs that are not loading changes nothing for them.
        assert_eq!(loading_ids(&items, Some(&[2, 5, 6, 99])), vec![2]);
        assert!(loading_ids(&items, Some(&[])).is_empty());
    }

    #[test]
    fn an_items_file_is_the_library_copy_once_added_and_the_fetched_copy_while_ready() {
        let item = |stage, added: Option<&str>, staged: Option<&str>| ImportItem {
            id: 1,
            url: String::new(),
            stage,
            progress: 0.0,
            error: None,
            video_title: String::new(),
            channel: String::new(),
            duration_secs: None,
            proposal: Proposal::default(),
            sources: BTreeMap::new(),
            alternatives: BTreeMap::new(),
            notes: Vec::new(),
            confidence: 0.0,
            format: "mp3".into(),
            destination: None,
            added_path: added.map(str::to_owned),
            picard: PicardState::None,
            staged: staged.map(PathBuf::from),
            added_size: 0,
        };
        assert_eq!(file_of_item(&item(Stage::Ready, None, Some("/app/imports/1/a.mp3"))), Ok(PathBuf::from("/app/imports/1/a.mp3")));
        // Once added, the file that matters is the one in the library, not the fetched copy.
        assert_eq!(
            file_of_item(&item(Stage::Added, Some("/music/Primus/Frizzle Fry.mp3"), Some("/app/imports/1/a.mp3"))),
            Ok(PathBuf::from("/music/Primus/Frizzle Fry.mp3"))
        );
        assert!(file_of_item(&item(Stage::Queued, None, None)).is_err());
        assert!(file_of_item(&item(Stage::Fetching, None, None)).is_err());
        assert!(file_of_item(&item(Stage::Failed, None, None)).unwrap_err().contains("failed"));
        assert!(file_of_item(&item(Stage::Ready, None, None)).is_err(), "ready but no file recorded");
    }
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    const DEAD_SOUTH: &str = r#"{"id":"v4YQJ6KuWvQ","title":"The Dead South - People Are Strange [Official Music Video]",
        "channel":"The Dead South","release_date":"20211111","upload_date":"20211111","duration":193}"#;

    /// A pretend yt-dlp: answers with canned JSON and prints scripted lines.
    struct Fake {
        probe: Result<String, String>,
        fetch_lines: Vec<String>,
        fetch_result: Result<(), String>,
        make_file: bool,
        running: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
        delay: Duration,
        picard: Option<String>,
        opened: Arc<Mutex<Vec<PathBuf>>>,
        open_result: Result<(), String>,
        closed: Arc<Mutex<Vec<PathBuf>>>,
        /// Write a real, readable mp3 instead of placeholder bytes.
        real_audio: bool,
    }

    impl Fake {
        fn ok() -> Fake {
            Fake {
                probe: Ok(DEAD_SOUTH.to_string()),
                fetch_lines: vec![
                    "PROG|downloading|1024|2048|NA".into(),
                    "PROG|downloading|2048|2048|NA".into(),
                    "POST|ExtractAudio|started".into(),
                    "POST|ExtractAudio|finished".into(),
                ],
                fetch_result: Ok(()),
                make_file: true,
                running: Arc::new(AtomicUsize::new(0)),
                peak: Arc::new(AtomicUsize::new(0)),
                delay: Duration::ZERO,
                picard: Some("/Applications/MusicBrainz Picard.app".into()),
                opened: Arc::new(Mutex::new(Vec::new())),
                open_result: Ok(()),
                closed: Arc::new(Mutex::new(Vec::new())),
                real_audio: false,
            }
        }
    }

    impl Runner for Fake {
        fn picard(&self) -> Option<String> {
            self.picard.clone()
        }
        fn open_in_picard(&self, file: &Path) -> Result<(), String> {
            self.opened.lock().unwrap().push(file.to_path_buf());
            self.open_result.clone()
        }
        fn close_in_picard(&self, file: &Path) {
            self.closed.lock().unwrap().push(file.to_path_buf());
        }
        fn probe(&self, _url: &str) -> Result<String, String> {
            self.probe.clone()
        }
        fn playlist(&self, _url: &str) -> Result<String, String> {
            Ok(r#"{"title":"Mix","entries":[{"id":"aaa","title":"One"},{"id":"bbb","title":"Two"},{"id":"ccc","title":"Three"}]}"#.into())
        }
        fn fetch(&self, _url: &str, format: &str, dir: &Path, line: &mut dyn FnMut(&str), _kill: &KillSwitch) -> Result<(), String> {
            let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(self.delay);
            for l in &self.fetch_lines {
                line(l);
            }
            if self.make_file {
                let path = dir.join(format!("x.{format}"));
                if self.real_audio {
                    std::fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tone.mp3"), &path).unwrap();
                } else {
                    std::fs::write(&path, b"audio").unwrap();
                }
                line(&format!("FILE|{}", path.display()));
            }
            self.running.fetch_sub(1, Ordering::SeqCst);
            self.fetch_result.clone()
        }
    }

    struct Harness {
        imports: Imports,
        events: Arc<Mutex<Vec<ImportEvent>>>,
        dir: tempfile::TempDir,
    }

    impl Harness {
        /// The song's own staging folder.
        fn staging(&self, id: u64) -> PathBuf {
            self.dir.path().join("staging").join(id.to_string())
        }
    }

    fn harness(fake: Fake) -> Harness {
        harness_with_library(fake, || LibraryView::default())
    }

    fn harness_with_library(fake: Fake, library: impl Fn() -> LibraryView + Send + Sync + 'static) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let imports = Imports::with_poll(
            dir.path().join("staging"),
            Box::new(fake),
            Box::new(library),
            Box::new(move |e| sink.lock().unwrap().push(e.clone())),
            Duration::from_millis(15),
        );
        Harness { imports, events, dir }
    }

    fn wait_until(imports: &Imports, what: &str, ok: impl Fn(&[ImportItem]) -> bool) {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if ok(&imports.list()) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("timed out waiting for {what}: {:?}", imports.list().iter().map(|i| (i.stage, i.error.clone())).collect::<Vec<_>>());
    }

    #[test]
    fn a_video_goes_from_link_to_ready_with_suggested_tags() {
        let h = harness(Fake::ok());
        h.imports
            .add_link("The Dead South - People Are Strange [Official Music Video]\nhttps://www.youtube.com/watch?v=v4YQJ6KuWvQ", "mp3")
            .unwrap();
        wait_until(&h.imports, "ready", |i| i.len() == 1 && i[0].stage == Stage::Ready);

        let item = &h.imports.list()[0];
        assert_eq!((item.proposal.artist.as_str(), item.proposal.title.as_str(), item.proposal.year.as_str()), ("The Dead South", "People Are Strange", "2021"));
        assert_eq!(item.sources["year"], "YouTube release date");
        assert_eq!(item.destination.as_deref(), Some("The Dead South/Unknown Album/People Are Strange.mp3"));
        assert_eq!(item.progress, 1.0);
        assert!(item.video_title.starts_with("The Dead South - People Are Strange"));
        assert!(h.imports.take_for_add(item.id).is_ok());
    }

    #[test]
    fn it_reports_each_stage_on_the_way() {
        let h = harness(Fake::ok());
        h.imports.add_link("https://youtu.be/abcdefghijk", "mp3").unwrap();
        wait_until(&h.imports, "ready", |i| i.first().is_some_and(|x| x.stage == Stage::Ready));
        let stages: Vec<Stage> = h.events.lock().unwrap().iter().filter_map(|e| if let ImportEvent::Item(i) = e { Some(i.stage) } else { None }).collect();
        for wanted in [Stage::Queued, Stage::Probing, Stage::Fetching, Stage::Converting, Stage::Ready] {
            assert!(stages.contains(&wanted), "missing {wanted:?} in {stages:?}");
        }
        assert!(stages.iter().position(|s| *s == Stage::Fetching) < stages.iter().position(|s| *s == Stage::Converting));
    }

    #[test]
    fn unsupported_links_and_repeats_are_refused() {
        let h = harness(Fake::ok());
        assert!(h.imports.add_link("https://open.spotify.com/track/abc", "mp3").unwrap_err().contains("Spotify"));
        assert!(h.imports.add_link("hello", "mp3").is_err());
        h.imports.add_link("https://youtu.be/abcdefghijk", "mp3").unwrap();
        assert!(h.imports.add_link("https://youtu.be/abcdefghijk", "mp3").unwrap_err().contains("already"));
        assert!(h.imports.list().len() == 1);
    }

    #[test]
    fn a_failed_probe_or_fetch_is_shown_on_the_item_and_can_be_retried() {
        let mut fake = Fake::ok();
        fake.probe = Err("This video is unavailable.".into());
        let h = harness(fake);
        h.imports.add_link("https://youtu.be/abcdefghijk", "mp3").unwrap();
        wait_until(&h.imports, "failure", |i| i.first().is_some_and(|x| x.stage == Stage::Failed));
        assert_eq!(h.imports.list()[0].error.as_deref(), Some("This video is unavailable."));
        assert!(h.imports.take_for_add(h.imports.list()[0].id).is_err());
        // A failed link can be pasted again.
        h.imports.add_link("https://youtu.be/abcdefghijk", "mp3").unwrap();

        let mut fake = Fake::ok();
        fake.fetch_result = Err("Couldn't reach YouTube.".into());
        let h = harness(fake);
        h.imports.add_link("https://youtu.be/abcdefghijk", "mp3").unwrap();
        wait_until(&h.imports, "fetch failure", |i| i.first().is_some_and(|x| x.stage == Stage::Failed));
    }

    #[test]
    fn finishing_without_a_file_is_a_failure_not_a_ready_song() {
        let mut fake = Fake::ok();
        fake.make_file = false;
        let h = harness(fake);
        h.imports.add_link("https://youtu.be/abcdefghijk", "mp3").unwrap();
        wait_until(&h.imports, "failure", |i| i.first().is_some_and(|x| x.stage == Stage::Failed));
        assert!(h.imports.list()[0].error.as_ref().unwrap().contains("no audio file"));
    }

    #[test]
    fn a_playlist_becomes_one_held_item_per_entry_and_nothing_is_fetched() {
        let fake = Fake::ok();
        let peak = fake.peak.clone();
        let h = harness(fake);
        h.imports.add_link("https://www.youtube.com/playlist?list=PLabc", "m4a").unwrap();
        wait_until(&h.imports, "three held", |i| i.len() == 3 && i.iter().all(|x| x.stage == Stage::Held));
        std::thread::sleep(Duration::from_millis(150));
        // Still held, and nothing was ever fetched.
        assert!(h.imports.list().iter().all(|i| i.stage == Stage::Held && i.format == "m4a"));
        assert_eq!(peak.load(Ordering::SeqCst), 0);
        assert_eq!(h.imports.list().iter().map(|i| i.video_title.as_str()).collect::<Vec<_>>(), ["One", "Two", "Three"]);
    }

    #[test]
    fn fetching_held_songs_starts_only_the_ones_asked_for() {
        let h = harness(Fake::ok());
        h.imports.add_link("https://www.youtube.com/playlist?list=PLabc", "mp3").unwrap();
        wait_until(&h.imports, "three held", |i| i.len() == 3 && i.iter().all(|x| x.stage == Stage::Held));
        let ids: Vec<u64> = h.imports.list().iter().map(|i| i.id).collect();

        assert_eq!(h.imports.fetch_held(Some(&[ids[1], 999])), 1, "an id that is not there is ignored");
        wait_until(&h.imports, "the second ready", |i| i.iter().any(|x| x.id == ids[1] && x.stage == Stage::Ready));
        let stages: Vec<Stage> = h.imports.list().iter().map(|i| i.stage).collect();
        assert_eq!(stages, [Stage::Held, Stage::Ready, Stage::Held]);

        // Songs that already started are not held, so fetching again does nothing for them.
        assert_eq!(h.imports.fetch_held(Some(&[ids[1]])), 0);
        assert_eq!(h.imports.fetch_held(None), 2);
        wait_until(&h.imports, "all ready", |i| i.iter().all(|x| x.stage == Stage::Ready));
    }

    #[test]
    fn a_held_song_can_be_removed_without_ever_fetching() {
        let fake = Fake::ok();
        let peak = fake.peak.clone();
        let h = harness(fake);
        h.imports.add_link("https://www.youtube.com/playlist?list=PLabc", "mp3").unwrap();
        wait_until(&h.imports, "three held", |i| i.len() == 3 && i.iter().all(|x| x.stage == Stage::Held));
        let first = h.imports.list()[0].id;
        h.imports.remove(first);
        assert_eq!(h.imports.list().len(), 2);
        assert_eq!(h.imports.fetch_held(None), 2);
        wait_until(&h.imports, "two ready", |i| i.len() == 2 && i.iter().all(|x| x.stage == Stage::Ready));
        assert!(peak.load(Ordering::SeqCst) >= 1);
    }

    #[test]
    fn a_held_song_is_not_loading_and_has_no_file() {
        let items = vec![blank_item(1, Stage::Held), blank_item(2, Stage::Queued)];
        assert_eq!(loading_ids(&items, None), vec![2], "stopping leaves held songs alone");
        assert!(file_of_item(&items[0]).is_err());
    }

    #[test]
    fn at_most_two_fetch_at_once() {
        let mut fake = Fake::ok();
        fake.delay = Duration::from_millis(60);
        let peak = fake.peak.clone();
        let h = harness(fake);
        h.imports.add_link("https://www.youtube.com/playlist?list=PLabc", "mp3").unwrap();
        wait_until(&h.imports, "three held", |i| i.len() == 3 && i.iter().all(|x| x.stage == Stage::Held));
        assert_eq!(h.imports.fetch_held(None), 3);
        wait_until(&h.imports, "all ready", |i| i.len() == 3 && i.iter().all(|x| x.stage == Stage::Ready));
        assert!(peak.load(Ordering::SeqCst) <= MAX_AT_ONCE, "peak was {}", peak.load(Ordering::SeqCst));
    }

    #[test]
    fn editing_tags_updates_the_destination_and_marks_the_field_as_edited() {
        let h = harness(Fake::ok());
        h.imports.add_link("https://youtu.be/abcdefghijk", "mp3").unwrap();
        wait_until(&h.imports, "ready", |i| i.first().is_some_and(|x| x.stage == Stage::Ready));
        let id = h.imports.list()[0].id;

        let item = h.imports.set_tags(id, TagsPatch { album: Some("Served Live".into()), track: Some("4".into()), ..Default::default() }).unwrap();

        assert_eq!(item.proposal.album, "Served Live");
        assert_eq!(item.sources["album"], "edited by you");
        assert_eq!(item.sources["year"], "YouTube release date", "untouched fields keep their source");
        assert!(item.destination.unwrap().ends_with("Served Live/04 People Are Strange.mp3"));
        // Setting the same value again is not an edit.
        let again = h.imports.set_tags(id, TagsPatch { year: Some("2021".into()), ..Default::default() }).unwrap();
        assert_eq!(again.sources["year"], "YouTube release date");
        assert!(h.imports.set_tags(999, TagsPatch::default()).is_err());
    }

    #[test]
    fn add_and_undo_move_an_item_between_ready_and_added() {
        let h = harness(Fake::ok());
        h.imports.add_link("https://youtu.be/abcdefghijk", "mp3").unwrap();
        wait_until(&h.imports, "ready", |i| i.first().is_some_and(|x| x.stage == Stage::Ready));
        let id = h.imports.list()[0].id;

        h.imports.mark_added(id, Path::new("/Music/A/B/c.mp3"), 123);
        assert_eq!(h.imports.list()[0].stage, Stage::Added);
        assert!(h.imports.take_for_add(id).unwrap_err().contains("Already"));
        assert_eq!(h.imports.take_for_undo(id).unwrap(), (PathBuf::from("/Music/A/B/c.mp3"), 123));

        h.imports.mark_undone(id);
        assert_eq!(h.imports.list()[0].stage, Stage::Ready);
        assert!(h.imports.take_for_undo(id).is_err());
        assert!(h.imports.take_for_add(id).is_ok(), "can be added again after an undo");
    }

    // ---- Picard

    fn add_one_file(h: &Harness, name: &str, contents: &[u8]) -> PathBuf {
        let file = h.dir.path().join(name);
        std::fs::write(&file, contents).unwrap();
        h.imports.add_files(&[file.to_string_lossy().into_owned()]).unwrap();
        file
    }

    #[test]
    fn a_picked_tagged_file_keeps_its_tags_and_the_original_stays() {
        let h = harness(Fake::ok());
        let tone = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tone.mp3")).unwrap();
        let file = add_one_file(&h, "whatever.mp3", &tone);
        wait_until(&h.imports, "ready", |i| i.first().is_some_and(|x| x.stage == Stage::Ready));
        let item = &h.imports.list()[0];
        assert!(item.staged.as_ref().unwrap().is_file());
        assert!(file.is_file(), "the original is left alone");
        assert_eq!(item.proposal.artist, "FixtureArtist");
        assert_eq!(item.sources.get("artist").map(String::as_str), Some("File tags"));
    }

    #[test]
    fn an_untagged_file_gets_its_artist_and_title_from_the_file_name() {
        let h = harness(Fake::ok());
        let tone = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tone.mp3")).unwrap();
        let file = h.dir.path().join("The Dead South - Gunslingers [dQw4w9WgXcQ].webm.mp3");
        std::fs::write(&file, tone).unwrap();
        let clear = crate::tags::TagEdit { title: Some(String::new()), artist: Some(String::new()), album: Some(String::new()), ..Default::default() };
        write_tags(&file, &clear).unwrap();
        h.imports.add_files(&[file.to_string_lossy().into_owned()]).unwrap();
        wait_until(&h.imports, "ready", |i| i.first().is_some_and(|x| x.stage == Stage::Ready));
        let item = &h.imports.list()[0];
        assert_eq!(item.proposal.artist, "The Dead South");
        assert_eq!(item.proposal.title, "Gunslingers");
        assert_eq!(item.sources.get("artist").map(String::as_str), Some("File name"));
    }

    #[test]
    fn a_file_the_player_cannot_read_is_converted_or_fails_with_a_reason() {
        // The fake has no ffmpeg, so the default convert says so.
        let h = harness(Fake::ok());
        add_one_file(&h, "clip.webm", b"not really video");
        wait_until(&h.imports, "failed", |i| i.first().is_some_and(|x| x.stage == Stage::Failed));
        assert!(h.imports.list()[0].error.as_deref().unwrap().contains("ffmpeg"));
    }

    #[test]
    fn the_same_file_is_not_added_twice_and_missing_files_are_skipped() {
        let h = harness(Fake::ok());
        let file = add_one_file(&h, "a.webm", b"x");
        assert!(h.imports.add_files(&[file.to_string_lossy().into_owned()]).is_err());
        assert!(h.imports.add_files(&["/no/such/file.mp3".into()]).is_err());
    }

    fn ready_song(fake: Fake) -> (Harness, u64) {
        let h = harness(fake);
        h.imports.add_link("The Dead South - People Are Strange [Official Music Video]\nhttps://youtu.be/abcdefghijk", "mp3").unwrap();
        wait_until(&h.imports, "ready", |i| i.first().is_some_and(|x| x.stage == Stage::Ready));
        let id = h.imports.list()[0].id;
        (h, id)
    }

    /// What Picard does on Save with the user's settings: write tags into the file and rename it in place.
    fn picard_saves(dir: &Path, new_name: &str, tags: &Proposal) -> PathBuf {
        let old = newest_audio(dir).unwrap().path;
        crate::tags::write_tags(&old, &crate::importer::to_edit(tags)).unwrap();
        let new = dir.join(new_name);
        std::fs::rename(&old, &new).unwrap();
        new
    }

    fn picard_tags() -> Proposal {
        Proposal { title: "People Are Strange".into(), artist: "The Dead South".into(), album: "Served Live".into(), year: "2018".into(), track: "4".into(), genre: "Bluegrass".into(), album_artist: "The Dead South".into(), ..Default::default() }
    }

    #[test]
    fn opening_in_picard_launches_it_with_the_staged_file_and_waits() {
        let mut fake = Fake::ok();
        fake.real_audio = true;
        let opened = fake.opened.clone();
        let (h, id) = ready_song(fake);

        h.imports.open_in_picard(id).unwrap();

        assert_eq!(h.imports.list()[0].picard, PicardState::Waiting);
        let opened = opened.lock().unwrap();
        assert_eq!(opened.len(), 1);
        assert!(opened[0].starts_with(h.staging(id)));
        // Nothing changed yet, so it keeps waiting and the tags are still the YouTube guess.
        std::thread::sleep(Duration::from_millis(80));
        assert_eq!(h.imports.list()[0].picard, PicardState::Waiting);
        assert_eq!(h.imports.list()[0].proposal.album, "");
    }

    #[test]
    fn the_file_is_tagged_with_what_we_know_before_picard_sees_it() {
        let mut fake = Fake::ok();
        fake.real_audio = true;
        let opened = fake.opened.clone();
        let (h, id) = ready_song(fake);
        // Before: the fetched file carries only the fixture's own tags, not the YouTube guess.
        let staged = newest_audio(&h.staging(id)).unwrap().path;
        assert_ne!(read_track(&staged).unwrap().artist, "The Dead South");

        h.imports.open_in_picard(id).unwrap();

        let seen = read_track(&opened.lock().unwrap()[0]).unwrap();
        assert_eq!((seen.title.as_str(), seen.artist.as_str(), seen.year), ("People Are Strange", "The Dead South", Some(2021)));
        // That preparation is not mistaken for Picard saving.
        std::thread::sleep(Duration::from_millis(120));
        assert_eq!(h.imports.list()[0].picard, PicardState::Waiting);
    }

    #[test]
    fn sending_again_while_waiting_prepares_the_file_too_without_being_taken_for_a_save() {
        let mut fake = Fake::ok();
        fake.real_audio = true;
        let (h, id) = ready_song(fake);
        h.imports.open_in_picard(id).unwrap();
        let file = newest_audio(&h.staging(id)).unwrap().path;
        // Something replaced the file with an untagged one (as if tags were lost).
        std::fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tone.flac"), h.staging(id).join("other.flac")).ok();
        std::fs::remove_file(h.staging(id).join("other.flac")).ok();
        crate::tags::write_tags(&file, &crate::tags::TagEdit { artist: Some("".into()), title: Some("".into()), ..Default::default() }).unwrap();
        assert_eq!(read_track(&file).unwrap().artist, "");

        h.imports.open_in_picard(id).unwrap();

        assert_eq!(read_track(&file).unwrap().artist, "The Dead South", "tagged again on resend");
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(h.imports.list()[0].picard, PicardState::Waiting, "the preparation is not a Picard save");
    }

    #[test]
    fn a_failure_to_prepare_the_file_is_reported_and_nothing_waits() {
        let (h, id) = ready_song(Fake::ok()); // placeholder bytes: not a readable audio file
        let err = h.imports.open_in_picard(id).unwrap_err();
        assert!(err.contains("prepare the file"), "{err}");
        assert_eq!(h.imports.list()[0].picard, PicardState::None);
    }

    #[test]
    fn reopening_after_picard_saved_does_not_overwrite_picards_tags() {
        let mut fake = Fake::ok();
        fake.real_audio = true;
        let (h, id) = ready_song(fake);
        h.imports.open_in_picard(id).unwrap();
        picard_saves(&h.staging(id), "04 People Are Strange.mp3", &picard_tags());
        wait_until(&h.imports, "picard saved", |i| i[0].picard == PicardState::Saved);

        h.imports.open_in_picard(id).unwrap();

        let file = newest_audio(&h.staging(id)).unwrap().path;
        assert_eq!(read_track(&file).unwrap().album, "Served Live", "Picard's album survived");
    }

    #[test]
    fn when_picard_saves_and_renames_the_file_its_tags_are_read_back_and_locked() {
        let mut fake = Fake::ok();
        fake.real_audio = true;
        let (h, id) = ready_song(fake);
        h.imports.open_in_picard(id).unwrap();

        let renamed = picard_saves(&h.staging(id), "04 People Are Strange.mp3", &picard_tags());

        wait_until(&h.imports, "picard saved", |i| i[0].picard == PicardState::Saved);
        let item = &h.imports.list()[0];
        assert_eq!((item.proposal.album.as_str(), item.proposal.year.as_str(), item.proposal.track.as_str(), item.proposal.genre.as_str()), ("Served Live", "2018", "4", "Bluegrass"));
        assert_eq!(item.sources["album"], "MusicBrainz Picard");
        assert_eq!(item.sources["year"], "MusicBrainz Picard");
        assert_eq!(item.confidence, 1.0);
        assert!(item.notes.iter().any(|n| n.contains("Picard")));
        assert!(item.alternatives.is_empty());
        assert_eq!(item.destination.as_deref(), Some("The Dead South/Served Live/04 People Are Strange.mp3"));
        // The renamed file is the one that will be added, and Picard's tags are not rewritten.
        let (staged, _, retag) = h.imports.take_for_add(id).unwrap();
        assert_eq!(staged, renamed);
        assert!(!retag);
        // The tags are Picard's now.
        assert!(h.imports.set_tags(id, TagsPatch { album: Some("Mine".into()), ..Default::default() }).unwrap_err().contains("Picard"));
    }

    #[test]
    fn a_save_caught_between_writing_the_tags_and_renaming_never_leaves_a_stale_file_name() {
        // Picard writes the tags, then renames. Run it several times so a check
        // is likely to land in between at least once.
        for _ in 0..8 {
            let mut fake = Fake::ok();
            fake.real_audio = true;
            let (h, id) = ready_song(fake);
            h.imports.open_in_picard(id).unwrap();

            let old = newest_audio(&h.staging(id)).unwrap().path;
            std::thread::sleep(Duration::from_millis(20));
            crate::tags::write_tags(&old, &crate::importer::to_edit(&picard_tags())).unwrap();
            // Picard renames right after writing: much shorter than a check interval.
            std::thread::sleep(Duration::from_millis(3));
            let renamed = h.staging(id).join("04 People Are Strange.mp3");
            std::fs::rename(&old, &renamed).unwrap();

            wait_until(&h.imports, "picard saved", |i| i[0].picard == PicardState::Saved);
            let (staged, _, _) = h.imports.take_for_add(id).unwrap();
            assert_eq!(staged, renamed, "the song must point at the file that still exists");
            assert!(staged.exists());
        }
    }

    #[test]
    fn a_multi_disc_release_saved_in_picard_is_filed_with_its_disc_number() {
        let mut fake = Fake::ok();
        fake.real_audio = true;
        let (h, id) = ready_song(fake);
        h.imports.open_in_picard(id).unwrap();
        let old = newest_audio(&h.staging(id)).unwrap().path;

        // Picard: disc 1 of 2, track 3. Build the finished file next to the watched
        // folder, then move it in in one step, so the watcher never sees a half-done save.
        let building = h.staging(id).parent().unwrap().join("building.mp3");
        std::fs::copy(&old, &building).unwrap();
        crate::tags::write_tags(&building, &crate::importer::to_edit(&Proposal { disc: "1".into(), track: "3".into(), ..picard_tags() })).unwrap();
        {
            use lofty::file::TaggedFileExt;
            use lofty::tag::{Accessor, TagExt};
            let mut tag = lofty::read_from_path(&building).unwrap().primary_tag().cloned().unwrap();
            tag.set_disk_total(2);
            tag.save_to_path(&building, lofty::config::WriteOptions::default()).unwrap();
        }
        std::fs::rename(&building, h.staging(id).join("1-03 People Are Strange.mp3")).unwrap();
        std::fs::remove_file(&old).unwrap();

        wait_until(&h.imports, "picard saved", |i| i[0].picard == PicardState::Saved);

        let item = &h.imports.list()[0];
        assert_eq!((item.proposal.disc.as_str(), item.proposal.disc_total.as_str()), ("1", "2"));
        assert_eq!(item.destination.as_deref(), Some("The Dead South/Served Live/1-03 People Are Strange.mp3"));
    }

    #[test]
    fn a_save_that_only_changes_the_tags_is_noticed_too() {
        let mut fake = Fake::ok();
        fake.real_audio = true;
        let (h, id) = ready_song(fake);
        h.imports.open_in_picard(id).unwrap();
        // Picard with renaming turned off: same file name, new content.
        let file = newest_audio(&h.staging(id)).unwrap().path;
        std::thread::sleep(Duration::from_millis(30));
        crate::tags::write_tags(&file, &crate::importer::to_edit(&picard_tags())).unwrap();

        wait_until(&h.imports, "picard saved", |i| i[0].picard == PicardState::Saved);
        assert_eq!(h.imports.list()[0].proposal.album, "Served Live");
    }

    #[test]
    fn the_destination_follows_the_library_s_existing_folders() {
        let mut fake = Fake::ok();
        fake.real_audio = true;
        let root = PathBuf::from("/Volumes/music/Music");
        let existing = crate::library::CachedTrack {
            modified_ms: 1,
            size: 1,
            track: crate::track::Track {
                path: "/Volumes/music/Music/The_Dead_South/Served Live/01 Old.mp3".into(),
                title: "Old".into(),
                artist: "The Dead South".into(),
                album: "Served Live".into(),
                album_artist: String::new(),
                track_number: Some(1),
                disc_number: None,
                year: None,
                genre: String::new(),
                duration_ms: 1,
                added_ms: 0,
                has_cover: false,
                has_lyrics: false,
            },
        };
        let (r2, e2) = (root.clone(), existing.clone());
        let h = harness_with_library(fake, move || LibraryView { root: Some(r2.clone()), tracks: vec![e2.clone()] });
        h.imports.add_link("The Dead South - People Are Strange\nhttps://youtu.be/abcdefghijk", "mp3").unwrap();
        wait_until(&h.imports, "ready", |i| i.first().is_some_and(|x| x.stage == Stage::Ready));
        let id = h.imports.list()[0].id;

        // Album unknown yet: the artist's existing folder is used.
        assert_eq!(h.imports.list()[0].destination.as_deref(), Some("The_Dead_South/Unknown Album/People Are Strange.mp3"));

        // After Picard names the album, it lands in the album folder the library already has.
        h.imports.open_in_picard(id).unwrap();
        picard_saves(&h.staging(id), "04 People Are Strange.mp3", &picard_tags());
        wait_until(&h.imports, "picard saved", |i| i[0].picard == PicardState::Saved);
        assert_eq!(h.imports.list()[0].destination.as_deref(), Some("The_Dead_South/Served Live/04 People Are Strange.mp3"));
    }

    #[test]
    fn opening_is_refused_when_the_song_is_not_ready_or_picard_fails_to_open() {
        let (h, id) = ready_song(Fake::ok());
        h.imports.remove(id);
        assert!(h.imports.open_in_picard(id).is_err());

        let mut fake = Fake::ok();
        fake.real_audio = true;
        fake.open_result = Err("Picard didn't open the file.".into());
        let (h, id) = ready_song(fake);
        assert!(h.imports.open_in_picard(id).unwrap_err().contains("didn't open"));
        assert_eq!(h.imports.list()[0].picard, PicardState::None, "no waiting for a launch that failed");

        let h = harness(Fake::ok());
        h.imports.add_link("https://youtu.be/abcdefghijk", "mp3").unwrap();
        // Still fetching or just finished: either way a missing item id is an error.
        assert!(h.imports.open_in_picard(999).is_err());
    }

    #[test]
    fn if_picard_moves_the_file_away_the_song_fails_with_advice() {
        let mut fake = Fake::ok();
        fake.real_audio = true;
        let (h, id) = ready_song(fake);
        h.imports.open_in_picard(id).unwrap();

        std::fs::remove_file(newest_audio(&h.staging(id)).unwrap().path).unwrap();

        wait_until(&h.imports, "moved", |i| i[0].stage == Stage::Failed);
        let error = h.imports.list()[0].error.clone().unwrap();
        assert!(error.contains("moved") && error.contains("Move files") && error.contains("Refresh library"), "{error}");
    }

    #[test]
    fn removing_or_finishing_a_song_that_was_in_picard_takes_it_out_of_picard() {
        let mut fake = Fake::ok();
        fake.real_audio = true;
        let closed = fake.closed.clone();
        let (h, id) = ready_song(fake);
        h.imports.open_in_picard(id).unwrap();
        let renamed = picard_saves(&h.staging(id), "04 People Are Strange.mp3", &picard_tags());
        wait_until(&h.imports, "picard saved", |i| i[0].picard == PicardState::Saved);

        h.imports.release_from_picard(id);
        h.imports.remove(id);

        let start = Instant::now();
        while closed.lock().unwrap().is_empty() && start.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(10));
        }
        let closed = closed.lock().unwrap();
        assert!(!closed.is_empty());
        assert!(closed.iter().all(|p| *p == renamed), "the renamed file is the one Picard has: {closed:?}");
    }

    #[test]
    fn songs_never_sent_to_picard_are_not_reported_to_it() {
        let fake = Fake::ok();
        let closed = fake.closed.clone();
        let (h, id) = ready_song(fake);
        h.imports.release_from_picard(id);
        h.imports.remove(id);
        std::thread::sleep(Duration::from_millis(80));
        assert!(closed.lock().unwrap().is_empty());
    }

    #[test]
    fn cancelling_stops_waiting_takes_the_file_out_of_picard_and_ignores_a_later_save() {
        let mut fake = Fake::ok();
        fake.real_audio = true;
        let closed = fake.closed.clone();
        let (h, id) = ready_song(fake);
        h.imports.open_in_picard(id).unwrap();
        assert_eq!(h.imports.list()[0].picard, PicardState::Waiting);

        h.imports.cancel_picard(id).unwrap();

        assert_eq!(h.imports.list()[0].picard, PicardState::None);
        assert_eq!(h.imports.list()[0].stage, Stage::Ready, "the song itself is untouched");
        let start = Instant::now();
        while closed.lock().unwrap().is_empty() && start.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(closed.lock().unwrap().len(), 1);
        // A save in Picard after cancelling is not picked up.
        picard_saves(&h.staging(id), "04 People Are Strange.mp3", &picard_tags());
        std::thread::sleep(Duration::from_millis(120));
        assert_eq!(h.imports.list()[0].picard, PicardState::None);
        assert_eq!(h.imports.list()[0].proposal.album, "", "tags stay the YouTube guess");
    }

    #[test]
    fn after_cancelling_the_song_can_be_sent_to_picard_again() {
        let mut fake = Fake::ok();
        fake.real_audio = true;
        let (h, id) = ready_song(fake);
        h.imports.open_in_picard(id).unwrap();
        h.imports.cancel_picard(id).unwrap();

        h.imports.open_in_picard(id).unwrap();
        picard_saves(&h.staging(id), "04 People Are Strange.mp3", &picard_tags());

        wait_until(&h.imports, "picard saved", |i| i[0].picard == PicardState::Saved);
    }

    #[test]
    fn cancelling_when_not_waiting_is_harmless_and_a_missing_song_is_an_error() {
        let (h, id) = ready_song(Fake::ok());
        h.imports.cancel_picard(id).unwrap();
        assert_eq!(h.imports.list()[0].picard, PicardState::None);
        assert!(h.imports.cancel_picard(999).is_err());
    }

    #[test]
    fn sending_again_while_waiting_reloads_in_picard_without_a_second_watcher() {
        let mut fake = Fake::ok();
        fake.real_audio = true;
        let opened = fake.opened.clone();
        let (h, id) = ready_song(fake);

        h.imports.open_in_picard(id).unwrap();
        h.imports.open_in_picard(id).unwrap();

        assert_eq!(opened.lock().unwrap().len(), 2, "Picard is told again");
        picard_saves(&h.staging(id), "04 People Are Strange.mp3", &picard_tags());
        wait_until(&h.imports, "picard saved", |i| i[0].picard == PicardState::Saved);
        // Exactly one transition to Saved was reported.
        let saved_events = h.events.lock().unwrap().iter().filter(|e| matches!(e, ImportEvent::Item(i) if i.picard == PicardState::Saved)).count();
        assert_eq!(saved_events, 1);
    }

    #[test]
    fn removing_a_song_stops_its_watcher_quietly() {
        let mut fake = Fake::ok();
        fake.real_audio = true;
        let (h, id) = ready_song(fake);
        h.imports.open_in_picard(id).unwrap();
        h.imports.remove(id);
        std::thread::sleep(Duration::from_millis(100));
        assert!(h.imports.list().is_empty());
    }

    #[test]
    fn songs_not_sent_to_picard_are_retagged_when_added() {
        let (h, id) = ready_song(Fake::ok());
        assert!(h.imports.take_for_add(id).unwrap().2);
    }

    #[test]
    fn a_song_cannot_be_added_twice_at_once_and_can_be_retried_after_a_failure() {
        let h = harness(Fake::ok());
        h.imports.add_link("https://youtu.be/abcdefghijk", "mp3").unwrap();
        wait_until(&h.imports, "ready", |i| i.first().is_some_and(|x| x.stage == Stage::Ready));
        let id = h.imports.list()[0].id;

        assert!(h.imports.take_for_add(id).is_ok());
        assert!(h.imports.take_for_add(id).unwrap_err().contains("already being added"));

        h.imports.abort_add(id);
        assert!(h.imports.take_for_add(id).is_ok(), "a failed add can be retried");
        h.imports.mark_added(id, Path::new("/M/a.mp3"), 1);
        assert!(h.imports.take_for_add(id).unwrap_err().contains("Already added"));
    }

    #[test]
    fn removing_an_item_deletes_its_staged_file_and_tells_the_ui() {
        let h = harness(Fake::ok());
        h.imports.add_link("https://youtu.be/abcdefghijk", "mp3").unwrap();
        wait_until(&h.imports, "ready", |i| i.first().is_some_and(|x| x.stage == Stage::Ready));
        let id = h.imports.list()[0].id;
        let (staged, _, _) = h.imports.take_for_add(id).unwrap();
        assert!(staged.exists());

        h.imports.remove(id);

        assert!(h.imports.list().is_empty());
        assert!(!staged.exists());
        assert!(h.events.lock().unwrap().iter().any(|e| matches!(e, ImportEvent::Removed(r) if *r == id)));
    }

    #[test]
    fn leftovers_from_an_earlier_run_are_cleared_at_startup() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("staging");
        std::fs::create_dir_all(staging.join("7")).unwrap();
        std::fs::write(staging.join("7/old.mp3"), b"x").unwrap();

        let _ = Imports::new(staging.clone(), Box::new(Fake::ok()), Box::new(LibraryView::default), Box::new(|_| {}));

        assert!(!staging.join("7/old.mp3").exists());
        assert!(staging.is_dir());
    }

    /// Uses the real yt-dlp, ffmpeg and the network: fetches a 19-second public
    /// clip ("Me at the zoo", the first video on YouTube). Run with
    /// `cargo test -- --ignored real_yt_dlp`.
    #[test]
    #[ignore]
    fn real_yt_dlp_fetches_converts_and_adds_a_short_public_video() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let dir = tempfile::tempdir().unwrap();
        let imports = Imports::new(
            dir.path().join("staging"),
            Box::new(YtDlp::locate().expect("yt-dlp and ffmpeg installed")),
            Box::new(LibraryView::default),
            Box::new(move |e| sink.lock().unwrap().push(e.clone())),
        );

        imports.add_link("Me at the zoo\nhttps://www.youtube.com/watch?v=jNQXAC9IVRw", "mp3").unwrap();
        let start = Instant::now();
        while imports.list().first().is_none_or(|i| !matches!(i.stage, Stage::Ready | Stage::Failed)) {
            assert!(start.elapsed() < Duration::from_secs(120), "timed out: {:?}", imports.list().first().map(|i| i.stage));
            std::thread::sleep(Duration::from_millis(200));
        }

        let item = imports.list().remove(0);
        assert_eq!(item.stage, Stage::Ready, "{:?}", item.error);
        assert_eq!(item.proposal.title, "Me at the zoo");
        assert_eq!(item.proposal.year, "2005");
        assert_eq!(item.sources["year"], "YouTube upload date (check)");
        assert_eq!(item.channel, "jawed");
        assert_eq!(item.duration_secs, Some(19));
        // Progress moved through the stages.
        let stages: Vec<Stage> = events.lock().unwrap().iter().filter_map(|e| if let ImportEvent::Item(i) = e { Some(i.stage) } else { None }).collect();
        assert!(stages.contains(&Stage::Fetching) && stages.contains(&Stage::Converting), "{stages:?}");

        // Add it to a library.
        let lib = tempfile::tempdir().unwrap();
        let (staged, proposal, _) = imports.take_for_add(item.id).unwrap();
        let tagged = Proposal { artist: "jawed".into(), album: "YouTube".into(), ..proposal };
        let added = crate::importer::add_to_library(&staged, &tagged, lib.path(), &[], true, false).unwrap();
        assert_eq!(added.path, lib.path().join("jawed/YouTube/Me at the zoo.mp3"));
        assert_eq!((added.track.title.as_str(), added.track.artist.as_str(), added.track.year), ("Me at the zoo", "jawed", Some(2005)));
        assert!((18_000..=21_000).contains(&added.track.duration_ms), "{}", added.track.duration_ms);
    }

    /// Checks the installed Picard is found (does not launch it).
    /// Run with `cargo test -- --ignored real_picard`.
    #[test]
    #[ignore]
    fn real_picard_is_found_where_it_is_installed() {
        let app = find_picard().expect("MusicBrainz Picard installed");
        assert!(app.to_string_lossy().ends_with("Picard.app"), "{app:?}");
        assert!(app.join("Contents/Info.plist").exists());
    }

    #[test]
    fn yt_dlp_errors_become_plain_sentences() {
        assert!(friendly_error("ERROR: [youtube] x: Sign in to confirm your age").contains("sign-in"));
        assert_eq!(friendly_error("ERROR: [youtube] x: Private video. Sign in if you've been granted access"), "This video is private.");
        assert_eq!(friendly_error("ERROR: [youtube] x: Video unavailable"), "This video is unavailable.");
        assert!(friendly_error("ERROR: unable to download webpage: <urlopen error>").contains("reach YouTube"));
        assert_eq!(friendly_error("ERROR: something odd happened"), "something odd happened");
        assert_eq!(friendly_error(""), "Fetching failed.");
    }
}
