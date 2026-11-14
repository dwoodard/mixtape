pub mod audio;
pub mod cache;
pub mod cleanup;
pub mod config;
pub mod cover;
pub mod fsutil;
pub mod importer;
pub mod imports;
pub mod library;
pub mod media;
pub mod player;
pub mod queue;
pub mod reveal;
pub mod session;
pub mod tags;
pub mod track;
pub mod window;
pub mod window_state;

use audio::RodioBackend;
use cache::{CacheDir, LibraryCache};
use config::Config;
use cover::CoverCache;
use media::{MediaCommand, MediaSession};
use player::{Player, PlayerEvent, PlayerState};
use queue::Repeat;
use session::{SessionStore, SessionWriter};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, WindowEvent};
use track::Track;
use window::WindowStore;
use window_state::Mode;

/// Cover art requests, limited to a few at a time so opening an album grid
/// does not read hundreds of files off a network share at once.
struct CoverService {
    cache: CoverCache,
    pool: rayon::ThreadPool,
}

/// Set while a duplicate clean-up runs, so only one can run at a time.
#[derive(Default)]
struct CleanupBusy(Arc<AtomicBool>);

struct ImportsHandle(imports::Imports);

/// Locates yt-dlp on every call, so installing it while the app is open just works.
struct LazyYtDlp;

impl imports::Runner for LazyYtDlp {
    fn picard(&self) -> Option<String> {
        importer::find_picard().map(|p| p.display().to_string())
    }
    fn open_in_picard(&self, file: &std::path::Path) -> Result<(), String> {
        let app = importer::find_picard()
            .ok_or("MusicBrainz Picard isn't installed. In a terminal: brew install --cask musicbrainz-picard")?;
        importer::open_in_picard(&app, file)
    }
    fn close_in_picard(&self, file: &std::path::Path) {
        if let Some(app) = importer::find_picard() {
            importer::remove_from_picard(&app, file);
        }
    }
    fn probe(&self, url: &str) -> Result<String, String> {
        imports::YtDlp::locate()?.probe(url)
    }
    fn playlist(&self, url: &str) -> Result<String, String> {
        imports::YtDlp::locate()?.playlist(url)
    }
    fn fetch(&self, url: &str, format: &str, dir: &std::path::Path, line: &mut dyn FnMut(&str), kill: &imports::KillSwitch) -> Result<(), String> {
        imports::YtDlp::locate()?.fetch(url, format, dir, line, kill)
    }
}

struct PlayerHandle(Arc<Mutex<Player>>);

/// Lets the exit handler write the session before the process ends.
struct SessionFlush(Arc<SessionWriter>);

impl PlayerHandle {
    fn with<R>(&self, f: impl FnOnce(&mut Player) -> R) -> R {
        f(&mut self.0.lock().unwrap())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerSnapshot {
    state: PlayerState,
    queue: Vec<Track>,
}

/// Error returned to the UI when a scan was cancelled (not shown as a failure).
const SCAN_CANCELLED: &str = "cancelled";

/// The flag of the scan currently running, if any. Starting a new scan
/// cancels the previous one.
#[derive(Default)]
struct ScanControl(Mutex<Option<Arc<AtomicBool>>>);

impl ScanControl {
    fn begin(&self) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Some(previous) = self.0.lock().unwrap().replace(flag.clone()) {
            previous.store(true, Ordering::Relaxed);
        }
        flag
    }

    fn cancel(&self) {
        if let Some(flag) = self.0.lock().unwrap().as_ref() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

async fn scan(
    app: AppHandle,
    control: &ScanControl,
    cache: &CacheDir,
    root: PathBuf,
) -> Result<Vec<Track>, String> {
    let cancel = control.begin();
    let cache = cache.clone();
    // Everything that touches the (possibly network) file system runs off the async thread.
    tauri::async_runtime::spawn_blocking(move || {
        if !root.is_dir() {
            return Err(format!("{} is not available. Is the drive mounted?", root.display()));
        }
        let previous = cache.load(&root);
        let known = previous.as_ref().map(|c| c.known()).unwrap_or_default();
        let removed = cache.removed(&root);
        let mut scanned = library::scan_folder_with(&root, &cancel, &known, &removed, |p| {
            let _ = app.emit("scan-progress", p);
        })
        .ok_or_else(|| SCAN_CANCELLED.to_string())?;

        // An unmounted share can leave an empty folder behind. Keep the
        // cache rather than replacing a real library with nothing.
        if scanned.is_empty() && !known.is_empty() {
            return Err(format!(
                "No audio files found in {}. Is the drive mounted? Your saved library was kept.",
                root.display()
            ));
        }

        // Something may have been removed while the scan ran.
        let removed = cache.removed(&root);
        scanned.retain(|c| !removed.contains(&c.track.path));

        let tracks = scanned.iter().map(|c| c.track.clone()).collect();
        if let Err(e) = cache.save(&LibraryCache::new(&root, scanned)) {
            eprintln!("could not save library cache: {e}");
        }
        Ok(tracks)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedLibrary {
    folder: String,
    tracks: Vec<Track>,
    scanned_at_ms: u64,
}

/// The last scanned library, straight from the local cache (no folder access).
#[tauri::command]
async fn cached_library(
    cache: State<'_, CacheDir>,
    config: State<'_, Config>,
) -> Result<Option<CachedLibrary>, String> {
    let cache = cache.inner().clone();
    let fallback = config.music_folder.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = cache.last_root().or(fallback)?;
        let loaded = cache.load(&root)?;
        Some(CachedLibrary {
            folder: loaded.root.clone(),
            scanned_at_ms: loaded.scanned_at_ms,
            tracks: loaded.tracks.into_iter().map(|c| c.track).collect(),
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// Removes tracks from the library (the files stay on disk).
#[tauri::command]
async fn remove_from_library(cache: State<'_, CacheDir>, paths: Vec<String>) -> Result<(), String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = cache.last_root().ok_or("No library is loaded.")?;
        cache.remove_tracks(&root, &paths).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Moves the extra copies of duplicate songs out of the library after safety
/// checks: to the Trash, or, on drives without one, to a dated holding folder
/// inside the library folder. Nothing is deleted outright.
#[tauri::command]
async fn trash_duplicates(
    cache: State<'_, CacheDir>,
    busy: State<'_, CleanupBusy>,
    pairs: Vec<cleanup::DuplicatePair>,
) -> Result<cleanup::CleanupReport, String> {
    // A second click (or window) while one is running would race the first over the same files.
    if busy.0.swap(true, Ordering::SeqCst) {
        return Err("A clean-up is already running.".into());
    }
    let busy_flag = busy.0.clone();
    let root = cache.last_root();
    tauri::async_runtime::spawn_blocking(move || {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let batch = root.as_ref().map(|r| r.join(cleanup::HOLDING_DIR).join(cleanup::utc_stamp(secs)));
        let mut report = cleanup::trash_duplicates(&pairs, cleanup::move_to_trash, |path| match (&root, &batch) {
            (Some(root), Some(batch)) => cleanup::move_to_holding(root, path, batch),
            _ => Err("no library folder is loaded".to_string()),
        });
        if !report.held.is_empty() {
            report.holding_folder = batch.map(|b| b.to_string_lossy().into_owned());
        }
        busy_flag.store(false, Ordering::SeqCst);
        report
    })
    .await
    .map_err(|e| {
        busy.0.store(false, Ordering::SeqCst);
        e.to_string()
    })
}

#[derive(Serialize)]
struct TagWriteResult {
    path: String,
    /// The track as re-read from disk after a successful write.
    track: Option<Track>,
    error: Option<String>,
}

/// Writes the same tag edits to each file. Files are handled one at a time and
/// independently: one failing does not stop or undo the others. Successfully
/// edited files are also updated in the saved library.
#[tauri::command]
async fn write_tags(
    cache: State<'_, CacheDir>,
    paths: Vec<String>,
    edit: tags::TagEdit,
) -> Result<Vec<TagWriteResult>, String> {
    edit.validate()?;
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();
        let mut updated = Vec::new();
        for path in paths {
            match tags::write_tags(std::path::Path::new(&path), &edit) {
                Ok(track) => {
                    if let Ok(meta) = std::fs::metadata(&path) {
                        let modified_ms = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map_or(0, |d| d.as_millis() as u64);
                        updated.push(library::CachedTrack { modified_ms, size: meta.len(), track: track.clone() });
                    }
                    results.push(TagWriteResult { path, track: Some(track), error: None });
                }
                Err(error) => results.push(TagWriteResult { path, track: None, error: Some(error) }),
            }
        }
        if let Some(root) = cache.last_root() {
            if let Err(e) = cache.update_tracks(&root, updated) {
                eprintln!("could not update the library cache after editing tags: {e}");
            }
        }
        results
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolStatus {
    yt_dlp: Option<String>,
    ffmpeg: Option<String>,
    picard: Option<String>,
}

/// Whether the tools the import pipeline needs are installed.
#[tauri::command]
fn import_tools() -> ToolStatus {
    let found = |n: &str| importer::find_tool(n).map(|p| p.display().to_string());
    ToolStatus { yt_dlp: found("yt-dlp"), ffmpeg: found("ffmpeg"), picard: importer::find_picard().map(|p| p.display().to_string()) }
}

#[tauri::command]
fn import_list(imports: State<ImportsHandle>) -> Vec<imports::ImportItem> {
    imports.0.list()
}

#[tauri::command]
fn import_add_link(imports: State<ImportsHandle>, text: String, format: String) -> Result<(), String> {
    imports.0.add_link(&text, &format)
}

#[tauri::command]
fn import_set_tags(
    imports: State<ImportsHandle>,
    id: u64,
    patch: imports::TagsPatch,
) -> Result<imports::ImportItem, String> {
    imports.0.set_tags(id, patch)
}

/// Opens the song in MusicBrainz Picard; its tags are read back once it is saved there.
#[tauri::command]
fn import_open_in_picard(imports: State<ImportsHandle>, id: u64) -> Result<(), String> {
    imports.0.open_in_picard(id)
}

/// Stops waiting for Picard and takes the song out of it.
#[tauri::command]
fn import_cancel_picard(imports: State<ImportsHandle>, id: u64) -> Result<(), String> {
    imports.0.cancel_picard(id)
}

#[tauri::command]
fn import_remove(imports: State<ImportsHandle>, id: u64) {
    imports.0.remove(id);
}

fn library_root(cache: &CacheDir, config: &Config) -> Result<PathBuf, String> {
    cache
        .last_root()
        .or_else(|| config.music_folder.clone())
        .ok_or_else(|| "Open or import a library folder first, so there is somewhere to add songs.".to_string())
}

/// Adds a ready song to the library: tags written, filed as Artist/Album/NN Title.
#[tauri::command]
async fn import_add(
    imports: State<'_, ImportsHandle>,
    cache: State<'_, CacheDir>,
    config: State<'_, Config>,
    id: u64,
) -> Result<Track, String> {
    let root = library_root(&cache, &config)?;
    let (staged, proposal, retag) = imports.0.take_for_add(id)?;
    let cache = cache.inner().clone();
    let manager = imports.0.clone();
    let root_for_job = root.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        // Follow the folders the library already has.
        let library = cache.load(&root_for_job).map(|c| c.tracks).unwrap_or_default();
        let added = importer::add_to_library(&staged, &proposal, &root_for_job, &library, retag)?;
        if let Ok(meta) = std::fs::metadata(&added.path) {
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            let cached = library::CachedTrack { modified_ms, size: meta.len(), track: added.track.clone() };
            if let Err(e) = cache.add_tracks(&root_for_job, vec![cached]) {
                eprintln!("could not update the library cache: {e}");
            }
        }
        Ok::<_, String>(added)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    match outcome {
        Ok(added) => {
            // The working file is no longer needed in Picard.
            manager.release_from_picard(id);
            manager.mark_added(id, &added.path, added.size);
            Ok(added.track)
        }
        Err(e) => {
            manager.abort_add(id);
            Err(e)
        }
    }
}

/// Undoes an add: removes the file we added and forgets it in the library.
#[tauri::command]
async fn import_undo(
    imports: State<'_, ImportsHandle>,
    cache: State<'_, CacheDir>,
    config: State<'_, Config>,
    id: u64,
) -> Result<String, String> {
    let root = library_root(&cache, &config)?;
    let (path, size) = imports.0.take_for_undo(id)?;
    let cache = cache.inner().clone();
    let manager = imports.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        importer::remove_added(&root, &path, size)?;
        let shown = path.to_string_lossy().into_owned();
        if let Err(e) = cache.forget_tracks(&root, std::slice::from_ref(&shown)) {
            eprintln!("could not update the library cache: {e}");
        }
        manager.mark_undone(id);
        Ok(shown)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sends songs to MusicBrainz Picard (starting it if needed).
#[tauri::command]
async fn picard_open_files(paths: Vec<String>) -> Result<(), String> {
    let files = importer::validate_picard_files(&paths)?;
    tauri::async_runtime::spawn_blocking(move || {
        let app = importer::find_picard()
            .ok_or("MusicBrainz Picard isn't installed. In a terminal: brew install --cask musicbrainz-picard")?;
        importer::open_files_in_picard(&app, &files)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct FolderRefresh {
    dir: String,
    tracks: Vec<Track>,
}

/// Re-checks some folders of the library (after Picard changed files in them):
/// only changed files are re-read. Returns each folder's songs as they are now.
#[tauri::command]
async fn refresh_folders(
    cache: State<'_, CacheDir>,
    config: State<'_, Config>,
    dirs: Vec<String>,
) -> Result<Vec<FolderRefresh>, String> {
    let root = library_root(&cache, &config)?;
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut saved = cache.load(&root).ok_or("The library hasn't been saved yet. Use Refresh first.")?;
        let known = saved.known();
        let removed = cache.removed(&root);
        let never = AtomicBool::new(false);
        let mut results = Vec::new();
        for dir in dirs {
            let dir = PathBuf::from(dir);
            // Only folders inside the library, and only ones that exist.
            if !dir.starts_with(&root) || !dir.is_dir() {
                continue;
            }
            let scanned = library::scan_folder_with(&dir, &never, &known, &removed, |_| {}).unwrap_or_default();
            results.push(FolderRefresh {
                dir: dir.to_string_lossy().into_owned(),
                tracks: scanned.iter().map(|c| c.track.clone()).collect(),
            });
            library::merge_folder(&mut saved.tracks, &dir, scanned);
        }
        cache.save(&saved).map_err(|e| e.to_string())?;
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Shows songs in Finder.
#[tauri::command]
async fn reveal_in_finder(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || reveal::reveal(&paths))
        .await
        .map_err(|e| e.to_string())?
}

/// How many tracks are currently removed from the loaded library.
#[tauri::command]
fn removed_count(cache: State<CacheDir>) -> usize {
    cache.last_root().map_or(0, |root| cache.removed(&root).len())
}

/// Forgets removals. The next refresh brings those files back.
#[tauri::command]
fn restore_removed(cache: State<CacheDir>) -> Result<(), String> {
    match cache.last_root() {
        Some(root) => cache.clear_removed(&root).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
fn cancel_scan(control: State<ScanControl>) {
    control.cancel();
}

#[tauri::command]
async fn scan_folder(
    app: AppHandle,
    control: State<'_, ScanControl>,
    cache: State<'_, CacheDir>,
    path: String,
) -> Result<Vec<Track>, String> {
    scan(app, &control, &cache, PathBuf::from(path)).await
}

/// Scans the music folder saved in the config file.
#[tauri::command]
async fn import_library(
    app: AppHandle,
    control: State<'_, ScanControl>,
    cache: State<'_, CacheDir>,
    config: State<'_, Config>,
) -> Result<Vec<Track>, String> {
    let root = config
        .music_folder
        .clone()
        .ok_or("No musicFolder set in config.json")?;
    scan(app, &control, &cache, root).await
}

#[tauri::command]
fn music_folder(config: State<Config>) -> Option<String> {
    config.music_folder.as_ref().map(|p| p.display().to_string())
}

#[tauri::command]
fn player_snapshot(player: State<PlayerHandle>) -> PlayerSnapshot {
    player.with(|p| PlayerSnapshot { state: p.state(), queue: p.queue_tracks().to_vec() })
}

#[tauri::command]
fn play_tracks(player: State<PlayerHandle>, tracks: Vec<Track>, start: usize) {
    player.with(|p| p.play_tracks(tracks, start));
}

#[tauri::command]
fn enqueue(player: State<PlayerHandle>, tracks: Vec<Track>) {
    player.with(|p| p.enqueue(tracks));
}

#[tauri::command]
fn play_index(player: State<PlayerHandle>, index: usize) {
    player.with(|p| p.play_index(index));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueReplacement {
    old_path: String,
    track: Track,
}

/// Updates queue entries whose files were retagged, renamed or re-added.
#[tauri::command]
fn replace_queue_tracks(player: State<PlayerHandle>, replacements: Vec<QueueReplacement>) {
    player.with(|p| p.replace_tracks(replacements.into_iter().map(|r| (r.old_path, r.track)).collect()));
}

/// Moves a queue entry from one position to another.
#[tauri::command]
fn move_queue_track(player: State<PlayerHandle>, from: usize, to: usize) {
    player.with(|p| p.move_track(from, to));
}

#[tauri::command]
fn enqueue_next(player: State<PlayerHandle>, tracks: Vec<Track>) {
    player.with(|p| p.enqueue_next(tracks));
}

#[tauri::command]
fn dismiss_error(player: State<PlayerHandle>) {
    player.with(|p| p.clear_error());
}

#[tauri::command]
fn stop_playback(player: State<PlayerHandle>) {
    player.with(|p| p.stop());
}

#[tauri::command]
fn set_shuffle(player: State<PlayerHandle>, on: bool) {
    player.with(|p| p.set_shuffle(on));
}

#[tauri::command]
fn set_repeat(player: State<PlayerHandle>, repeat: Repeat) {
    player.with(|p| p.set_repeat(repeat));
}

#[tauri::command]
fn toggle_playback(player: State<PlayerHandle>) {
    player.with(|p| p.toggle());
}

#[tauri::command]
fn next_track(player: State<PlayerHandle>) {
    player.with(|p| p.next());
}

#[tauri::command]
fn prev_track(player: State<PlayerHandle>) {
    player.with(|p| p.prev());
}

#[tauri::command]
fn seek(player: State<PlayerHandle>, position_ms: u64) {
    player.with(|p| p.seek(position_ms));
}

#[tauri::command]
fn set_volume(player: State<PlayerHandle>, volume: f32) {
    player.with(|p| p.set_volume(volume));
}

#[tauri::command]
fn remove_from_queue(player: State<PlayerHandle>, index: usize) {
    player.with(|p| p.remove(index));
}

#[tauri::command]
fn remove_from_queue_down(player: State<PlayerHandle>, index: usize) {
    player.with(|p| p.remove_from(index));
}

#[tauri::command]
fn clear_queue(player: State<PlayerHandle>) {
    player.with(|p| p.clear());
}

#[tauri::command]
fn window_mode(store: State<WindowStore>) -> Mode {
    store.mode()
}

#[tauri::command]
fn toggle_window_mode(window: WebviewWindow, store: State<WindowStore>) -> Mode {
    let mode = store.toggle(&window);
    let _ = window.emit("window-mode", mode);
    mode
}

/// Widens or narrows the thin bar. Ignored in the large window.
#[tauri::command]
fn resize_thin(window: WebviewWindow, store: State<WindowStore>, width: f64) {
    if store.mode() == Mode::Thin {
        window::resize_thin(&window, width);
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn apply_media_command(player: &PlayerHandle, command: MediaCommand) {
    player.with(|p| match command {
        MediaCommand::Play => p.resume(),
        MediaCommand::Pause => p.pause(),
        MediaCommand::Toggle => p.toggle(),
        MediaCommand::Next => p.next(),
        MediaCommand::Previous => p.prev(),
        MediaCommand::Stop => p.stop(),
        MediaCommand::SeekTo(ms) => p.seek(ms),
        MediaCommand::SeekBy(delta) => p.seek_relative(delta),
    });
}

fn setup_player(app: &tauri::App) {
    let handle = app.handle().clone();

    let media_handle = handle.clone();
    let media = Arc::new(MediaSession::spawn(move |command| {
        apply_media_command(&media_handle.state::<PlayerHandle>(), command);
    }));

    let data_dir = app.path().app_data_dir().expect("app data dir");
    let session_store = SessionStore::new(data_dir.join("session"));
    let restore = session_store.load();
    let session = Arc::new(SessionWriter::spawn(session_store));
    app.manage(SessionFlush(session.clone()));

    let emit_handle = handle.clone();
    let emit = move |event: PlayerEvent| match event {
        PlayerEvent::State(state) => {
            media.update_state(state.clone());
            session.state_changed(&state);
            let _ = emit_handle.emit("player-state", state);
        }
        PlayerEvent::Queue(queue) => {
            session.queue_changed(queue.clone());
            let _ = emit_handle.emit("player-queue", queue);
        }
        PlayerEvent::Position(ms) => {
            media.update_position(ms);
            session.position_changed(ms);
            let _ = emit_handle.emit("player-position", ms);
        }
    };

    let (backend_tx, backend_rx) = mpsc::channel();
    let backend = RodioBackend::spawn(backend_tx);
    let mut new_player = Player::new(Box::new(backend), Box::new(emit));
    if let Some(saved) = restore {
        new_player.restore(saved);
    }
    let player = Arc::new(Mutex::new(new_player));

    let events_player = player.clone();
    std::thread::Builder::new()
        .name("mixtape-events".into())
        .spawn(move || {
            for event in backend_rx {
                events_player.lock().unwrap().handle_backend_event(event);
            }
        })
        .expect("spawn event thread");

    app.manage(PlayerHandle(player));
}

fn setup_config(app: &tauri::App) -> tauri::Result<()> {
    app.manage(Config::load(&app.path().app_config_dir()?.join("config.json")));
    Ok(())
}

fn setup_window(app: &tauri::App) -> tauri::Result<()> {
    // Managed before restoring so window events fired by the restore can find it.
    app.manage(WindowStore::load(app.path().app_config_dir()?.join("window-state.json")));
    if let Some(window) = app.get_webview_window("main") {
        app.state::<WindowStore>().restore(&window);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("cover", |ctx, request, responder| {
            let service = ctx.app_handle().state::<Arc<CoverService>>().inner().clone();
            let path = request.uri().path().to_string();
            let worker = service.clone();
            service.pool.spawn(move || {
                let response = match worker.cache.serve(&path) {
                    Some(jpeg) => tauri::http::Response::builder()
                        .header("Content-Type", "image/jpeg")
                        .header("Cache-Control", "public, max-age=86400")
                        .body(jpeg),
                    None => tauri::http::Response::builder().status(404).body(Vec::new()),
                };
                responder.respond(response.expect("valid response"));
            });
        })
        .setup(|app| {
            setup_player(app);
            app.manage(ScanControl::default());
            app.manage(CleanupBusy::default());
            {
                let emit_handle = app.handle().clone();
                let library_handle = app.handle().clone();
                app.manage(ImportsHandle(imports::Imports::new(
                    app.path().app_data_dir()?.join("imports"),
                    Box::new(LazyYtDlp),
                    Box::new(move || {
                        // Read when needed, so it always reflects the library as it is now.
                        let cache = library_handle.state::<CacheDir>();
                        let config = library_handle.state::<Config>();
                        let root = cache.last_root().or_else(|| config.music_folder.clone());
                        let tracks = root.as_ref().and_then(|r| cache.load(r)).map(|c| c.tracks).unwrap_or_default();
                        imports::LibraryView { root, tracks }
                    }),
                    Box::new(move |event| {
                        let _ = emit_handle.emit("import-event", event);
                    }),
                )));
            }
            app.manage(Arc::new(CoverService {
                cache: CoverCache::new(app.path().app_cache_dir()?.join("covers")),
                pool: rayon::ThreadPoolBuilder::new()
                    .num_threads(4)
                    .thread_name(|i| format!("mixtape-cover-{i}"))
                    .build()
                    .expect("cover thread pool"),
            }));
            app.manage(CacheDir(app.path().app_cache_dir()?.join("library")));
            setup_config(app)?;
            setup_window(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            let Some(webview) = window.app_handle().get_webview_window(window.label()) else {
                return;
            };
            let store = window.state::<WindowStore>();
            match event {
                WindowEvent::Moved(_) => store.track(&webview),
                // A resize that changed the thin bar's height is undone; the undo's own event is the one saved.
                WindowEvent::Resized(_) => {
                    if !store.keep_thin_height(&webview) {
                        store.track(&webview);
                    }
                }
                WindowEvent::CloseRequested { .. } => {
                    store.track(&webview);
                    store.save();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            import_library,
            cached_library,
            remove_from_library,
            reveal_in_finder,
            import_tools,
            import_list,
            import_add_link,
            import_set_tags,
            import_open_in_picard,
            picard_open_files,
            refresh_folders,
            import_cancel_picard,
            import_add,
            import_undo,
            import_remove,
            write_tags,
            trash_duplicates,
            removed_count,
            restore_removed,
            cancel_scan,
            music_folder,
            player_snapshot,
            play_tracks,
            enqueue,
            enqueue_next,
            replace_queue_tracks,
            move_queue_track,
            stop_playback,
            dismiss_error,
            set_shuffle,
            set_repeat,
            play_index,
            toggle_playback,
            next_track,
            prev_track,
            seek,
            set_volume,
            remove_from_queue,
            remove_from_queue_down,
            clear_queue,
            window_mode,
            toggle_window_mode,
            resize_thin,
            quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<SessionFlush>().0.flush();
                app.state::<WindowStore>().save();
            }
        });
}
