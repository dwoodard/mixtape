pub mod audio;
pub mod config;
pub mod library;
pub mod media;
pub mod player;
pub mod queue;
pub mod track;
pub mod window;
pub mod window_state;

use audio::RodioBackend;
use config::Config;
use media::{MediaCommand, MediaSession};
use player::{Player, PlayerEvent, PlayerState};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, WindowEvent};
use track::Track;
use window::WindowStore;
use window_state::Mode;

struct PlayerHandle(Arc<Mutex<Player>>);

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

async fn scan(app: AppHandle, control: &ScanControl, root: PathBuf) -> Result<Vec<Track>, String> {
    let cancel = control.begin();
    // Everything that touches the (possibly network) file system runs off the async thread.
    tauri::async_runtime::spawn_blocking(move || {
        if !root.is_dir() {
            return Err(format!("{} is not available. Is the drive mounted?", root.display()));
        }
        library::scan_folder_with(&root, &cancel, |p| {
            let _ = app.emit("scan-progress", p);
        })
        .ok_or_else(|| SCAN_CANCELLED.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_scan(control: State<ScanControl>) {
    control.cancel();
}

#[tauri::command]
async fn scan_folder(
    app: AppHandle,
    control: State<'_, ScanControl>,
    path: String,
) -> Result<Vec<Track>, String> {
    scan(app, &control, PathBuf::from(path)).await
}

/// Scans the music folder saved in the config file.
#[tauri::command]
async fn import_library(
    app: AppHandle,
    control: State<'_, ScanControl>,
    config: State<'_, Config>,
) -> Result<Vec<Track>, String> {
    let root = config
        .music_folder
        .clone()
        .ok_or("No musicFolder set in config.json")?;
    scan(app, &control, root).await
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

    let emit_handle = handle.clone();
    let emit = move |event: PlayerEvent| match event {
        PlayerEvent::State(state) => {
            media.update_state(state.clone());
            let _ = emit_handle.emit("player-state", state);
        }
        PlayerEvent::Queue(queue) => {
            let _ = emit_handle.emit("player-queue", queue);
        }
        PlayerEvent::Position(ms) => {
            media.update_position(ms);
            let _ = emit_handle.emit("player-position", ms);
        }
    };

    let (backend_tx, backend_rx) = mpsc::channel();
    let backend = RodioBackend::spawn(backend_tx);
    let player = Arc::new(Mutex::new(Player::new(Box::new(backend), Box::new(emit))));

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
        .setup(|app| {
            setup_player(app);
            app.manage(ScanControl::default());
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
            cancel_scan,
            music_folder,
            player_snapshot,
            play_tracks,
            enqueue,
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
                app.state::<WindowStore>().save();
            }
        });
}
