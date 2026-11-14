pub mod audio;
pub mod cache;
pub mod config;
pub mod cover;
pub mod library;
pub mod media;
pub mod player;
pub mod playlists;
pub mod queue;
pub mod reveal;
pub mod session;
pub mod track;
pub mod window;
pub mod window_state;

use audio::RodioBackend;
use cache::{CacheDir, LibraryCache};
use config::Config;
use cover::CoverCache;
use media::{MediaCommand, MediaSession};
use player::{Player, PlayerEvent, PlayerState};
use playlists::{PlaylistStore, PlaylistSummary};
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

#[tauri::command]
fn enqueue_next(player: State<PlayerHandle>, tracks: Vec<Track>) {
    player.with(|p| p.enqueue_next(tracks));
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
fn list_playlists(store: State<PlaylistStore>) -> Vec<PlaylistSummary> {
    store.list()
}

#[tauri::command]
fn load_playlist(store: State<PlaylistStore>, id: String) -> Result<Vec<Track>, String> {
    store
        .get(&id)
        .map(|p| p.tracks)
        .ok_or_else(|| "That playlist no longer exists.".to_string())
}

#[tauri::command]
fn save_playlist(
    store: State<PlaylistStore>,
    name: String,
    tracks: Vec<Track>,
) -> Result<PlaylistSummary, String> {
    store.save(&name, tracks)
}

#[tauri::command]
fn delete_playlist(store: State<PlaylistStore>, id: String) -> Result<(), String> {
    store.delete(&id)
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
            app.manage(Arc::new(CoverService {
                cache: CoverCache::new(app.path().app_cache_dir()?.join("covers")),
                pool: rayon::ThreadPoolBuilder::new()
                    .num_threads(4)
                    .thread_name(|i| format!("mixtape-cover-{i}"))
                    .build()
                    .expect("cover thread pool"),
            }));
            app.manage(PlaylistStore::new(app.path().app_data_dir()?.join("playlists.json")));
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
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => store.track(&webview),
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
            removed_count,
            restore_removed,
            cancel_scan,
            music_folder,
            player_snapshot,
            play_tracks,
            enqueue,
            enqueue_next,
            stop_playback,
            set_shuffle,
            set_repeat,
            list_playlists,
            load_playlist,
            save_playlist,
            delete_playlist,
            play_index,
            toggle_playback,
            next_track,
            prev_track,
            seek,
            set_volume,
            remove_from_queue,
            clear_queue,
            window_mode,
            toggle_window_mode,
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
