//! The import pipeline: links become items that are probed, fetched,
//! converted, and held in a local staging folder until the user adds them to
//! the library. Running yt-dlp sits behind [`Runner`] so the pipeline can be
//! tested without a network.

use crate::importer::{
    classify_link, destination, extract_link, find_tool, parse_meta, parse_playlist, parse_progress, suggest, LinkKind, Progress, Proposal,
};
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
    Queued,
    Probing,
    Fetching,
    Converting,
    Ready,
    Added,
    Failed,
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
    #[serde(skip)]
    staged: Option<PathBuf>,
    #[serde(skip)]
    added_size: u64,
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
    fn probe(&self, url: &str) -> Result<String, String> {
        self.capture(&["--skip-download", "--no-warnings", "--no-playlist", "-j", "--", url])
    }

    fn playlist(&self, url: &str) -> Result<String, String> {
        self.capture(&["--flat-playlist", "-J", "--no-warnings", "--", url])
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

struct State {
    items: Vec<ImportItem>,
    switches: HashMap<u64, Arc<KillSwitch>>,
    cancelled: HashSet<u64>,
    /// Items whose add is in progress, so one song is not added twice at once.
    adding: HashSet<u64>,
    next_id: u64,
}

struct Inner {
    state: Mutex<State>,
    staging: PathBuf,
    runner: Box<dyn Runner>,
    emit: Emit,
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
    pub fn new(staging: PathBuf, runner: Box<dyn Runner>, emit: Emit) -> Imports {
        let _ = std::fs::remove_dir_all(&staging);
        let _ = std::fs::create_dir_all(&staging);
        Imports {
            inner: Arc::new(Inner {
                state: Mutex::new(State { items: Vec::new(), switches: HashMap::new(), cancelled: HashSet::new(), adding: HashSet::new(), next_id: 1 }),
                staging,
                runner,
                emit,
                slots: (Mutex::new(0), Condvar::new()),
            }),
        }
    }

    pub fn list(&self) -> Vec<ImportItem> {
        self.inner.state.lock().unwrap().items.clone()
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
                        for (link, title) in entries {
                            if let Ok(id) = this.new_item(&link, &format, &title) {
                                this.spawn_pipeline(id, title);
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
        self.update(id, |i| {
            i.video_title = if hint.is_empty() { meta.title.clone() } else { hint.to_string() };
            i.channel = meta.channel.clone();
            i.duration_secs = meta.duration_secs;
            i.destination = Some(destination(Path::new(""), &suggestion.proposal, &i.format).to_string_lossy().into_owned());
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

    /// Applies the user's tag edits. Edited fields are marked as such.
    pub fn set_tags(&self, id: u64, patch: TagsPatch) -> Result<ImportItem, String> {
        self.update(id, |i| {
            let mut set = |field: &str, slot: &mut String, value: Option<String>| {
                if let Some(v) = value {
                    if *slot != v {
                        *slot = v;
                        i.sources.insert(field.to_string(), "edited by you".to_string());
                    }
                }
            };
            set("title", &mut i.proposal.title, patch.title);
            set("artist", &mut i.proposal.artist, patch.artist);
            set("album", &mut i.proposal.album, patch.album);
            set("albumArtist", &mut i.proposal.album_artist, patch.album_artist);
            set("year", &mut i.proposal.year, patch.year);
            set("track", &mut i.proposal.track, patch.track);
            set("genre", &mut i.proposal.genre, patch.genre);
            i.destination = Some(destination(Path::new(""), &i.proposal, &i.format).to_string_lossy().into_owned());
            i.clone()
        })
        .ok_or_else(|| "That item is gone.".to_string())
    }

    /// What adding needs, once the item is ready.
    pub fn take_for_add(&self, id: u64) -> Result<(PathBuf, Proposal), String> {
        let mut state = self.inner.state.lock().unwrap();
        if state.adding.contains(&id) {
            return Err("This song is already being added.".into());
        }
        let item = state.items.iter().find(|i| i.id == id).ok_or("That item is gone.")?;
        match (item.stage, &item.staged) {
            (Stage::Ready, Some(path)) => {
                let taken = (path.clone(), item.proposal.clone());
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

    /// Stops a running fetch if there is one, deletes the staged file, and
    /// drops the item. A song already added to the library stays there.
    pub fn remove(&self, id: u64) {
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

#[cfg(test)]
mod tests {
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
            }
        }
    }

    impl Runner for Fake {
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
                std::fs::write(&path, b"audio").unwrap();
                line(&format!("FILE|{}", path.display()));
            }
            self.running.fetch_sub(1, Ordering::SeqCst);
            self.fetch_result.clone()
        }
    }

    struct Harness {
        imports: Imports,
        events: Arc<Mutex<Vec<ImportEvent>>>,
        _dir: tempfile::TempDir,
    }

    fn harness(fake: Fake) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let imports = Imports::new(dir.path().join("staging"), Box::new(fake), Box::new(move |e| sink.lock().unwrap().push(e.clone())));
        Harness { imports, events, _dir: dir }
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
    fn a_playlist_becomes_one_item_per_entry() {
        let h = harness(Fake::ok());
        h.imports.add_link("https://www.youtube.com/playlist?list=PLabc", "m4a").unwrap();
        wait_until(&h.imports, "three ready", |i| i.len() == 3 && i.iter().all(|x| x.stage == Stage::Ready));
        assert!(h.imports.list().iter().all(|i| i.format == "m4a"));
    }

    #[test]
    fn at_most_two_fetch_at_once() {
        let mut fake = Fake::ok();
        fake.delay = Duration::from_millis(60);
        let peak = fake.peak.clone();
        let h = harness(fake);
        h.imports.add_link("https://www.youtube.com/playlist?list=PLabc", "mp3").unwrap();
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
        let (staged, _) = h.imports.take_for_add(id).unwrap();
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

        let _ = Imports::new(staging.clone(), Box::new(Fake::ok()), Box::new(|_| {}));

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
        let (staged, proposal) = imports.take_for_add(item.id).unwrap();
        let tagged = Proposal { artist: "jawed".into(), album: "YouTube".into(), ..proposal };
        let added = crate::importer::add_to_library(&staged, &tagged, lib.path()).unwrap();
        assert_eq!(added.path, lib.path().join("jawed/YouTube/Me at the zoo.mp3"));
        assert_eq!((added.track.title.as_str(), added.track.artist.as_str(), added.track.year), ("Me at the zoo", "jawed", Some(2005)));
        assert!((18_000..=21_000).contains(&added.track.duration_ms), "{}", added.track.duration_ms);
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
