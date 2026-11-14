//! Saves what is playing so the app can reopen where it left off: the queue,
//! which track, how far in, volume, shuffle and repeat.

use crate::player::{PlayerState, Restore};
use crate::queue::Repeat;
use crate::track::Track;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

/// The small, frequently changing part of the session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionState {
    pub index: Option<usize>,
    pub position_ms: u64,
    pub volume: f32,
    pub shuffle: bool,
    pub repeat: Repeat,
}

impl Default for SessionState {
    fn default() -> Self {
        SessionState { index: None, position_ms: 0, volume: 1.0, shuffle: false, repeat: Repeat::Off }
    }
}

impl From<&PlayerState> for SessionState {
    fn from(s: &PlayerState) -> Self {
        SessionState {
            index: s.current_index,
            position_ms: s.position_ms,
            volume: s.volume,
            shuffle: s.shuffle,
            repeat: s.repeat,
        }
    }
}

/// Files in the app data directory. The queue (potentially thousands of
/// tracks) is kept apart from the small state so position updates stay cheap.
#[derive(Clone)]
pub struct SessionStore {
    dir: PathBuf,
}

impl SessionStore {
    pub fn new(dir: PathBuf) -> Self {
        SessionStore { dir }
    }

    fn queue_path(&self) -> PathBuf {
        self.dir.join("session-queue.json")
    }

    fn state_path(&self) -> PathBuf {
        self.dir.join("session-state.json")
    }

    pub fn save_queue(&self, tracks: &[Track]) -> std::io::Result<()> {
        write_json(&self.queue_path(), &tracks)
    }

    pub fn save_state(&self, state: &SessionState) -> std::io::Result<()> {
        write_json(&self.state_path(), state)
    }

    /// The saved session, or `None` when there is no (readable) saved queue.
    pub fn load(&self) -> Option<Restore> {
        let tracks: Vec<Track> =
            serde_json::from_str(&std::fs::read_to_string(self.queue_path()).ok()?).ok()?;
        if tracks.is_empty() {
            return None;
        }
        let state: SessionState = std::fs::read_to_string(self.state_path())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Some(Restore {
            tracks,
            index: state.index,
            position_ms: state.position_ms,
            volume: state.volume,
            shuffle: state.shuffle,
            repeat: state.repeat,
        })
    }
}

fn write_json(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(value).map_err(std::io::Error::other)?)?;
    std::fs::rename(&tmp, path)
}

enum Msg {
    Queue(Vec<Track>),
    State(SessionState),
    Position(u64),
    /// Write everything now and signal when done.
    Flush(Sender<()>),
}

/// How often changes are written at most.
const WRITE_EVERY: Duration = Duration::from_secs(2);

/// Writes session changes on a background thread, batching them so a stream
/// of position ticks does not hit the disk each time.
pub struct SessionWriter {
    tx: Sender<Msg>,
}

impl SessionWriter {
    pub fn spawn(store: SessionStore) -> Self {
        let (tx, rx) = mpsc::channel::<Msg>();
        thread::Builder::new()
            .name("mixtape-session".into())
            .spawn(move || {
                let mut queue: Option<Vec<Track>> = None;
                let mut state: Option<SessionState> = None;
                let mut last_write = Instant::now() - WRITE_EVERY;
                let write = |queue: &mut Option<Vec<Track>>, state: &mut Option<SessionState>| {
                    if let Some(q) = queue.take() {
                        if let Err(e) = store.save_queue(&q) {
                            eprintln!("could not save queue: {e}");
                        }
                    }
                    if let Some(s) = state.take() {
                        if let Err(e) = store.save_state(&s) {
                            eprintln!("could not save session state: {e}");
                        }
                    }
                };
                loop {
                    match rx.recv_timeout(WRITE_EVERY) {
                        Ok(Msg::Queue(q)) => queue = Some(q),
                        Ok(Msg::State(s)) => state = Some(s),
                        Ok(Msg::Position(ms)) => {
                            if let Some(s) = &mut state {
                                s.position_ms = ms;
                            }
                        }
                        Ok(Msg::Flush(done)) => {
                            write(&mut queue, &mut state);
                            let _ = done.send(());
                            continue;
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => {
                            write(&mut queue, &mut state);
                            return;
                        }
                    }
                    if last_write.elapsed() >= WRITE_EVERY {
                        write(&mut queue, &mut state);
                        last_write = Instant::now();
                    }
                }
            })
            .expect("spawn session thread");
        SessionWriter { tx }
    }

    pub fn queue_changed(&self, tracks: Vec<Track>) {
        let _ = self.tx.send(Msg::Queue(tracks));
    }

    pub fn state_changed(&self, state: &PlayerState) {
        let _ = self.tx.send(Msg::State(state.into()));
    }

    pub fn position_changed(&self, position_ms: u64) {
        let _ = self.tx.send(Msg::Position(position_ms));
    }

    /// Writes any pending changes immediately (used on quit).
    pub fn flush(&self) {
        let (done, wait) = mpsc::channel();
        if self.tx.send(Msg::Flush(done)).is_ok() {
            let _ = wait.recv_timeout(Duration::from_secs(3));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::test_track;

    fn player_state(index: usize, position_ms: u64) -> PlayerState {
        PlayerState {
            status: crate::player::Status::Playing,
            current_index: Some(index),
            current_track: None,
            position_ms,
            duration_ms: 0,
            volume: 0.5,
            shuffle: true,
            repeat: Repeat::One,
            error: None,
            error_path: None,
        }
    }

    #[test]
    fn nothing_saved_means_nothing_to_restore() {
        let dir = tempfile::tempdir().unwrap();
        assert!(SessionStore::new(dir.path().to_path_buf()).load().is_none());
    }

    #[test]
    fn round_trips_queue_and_state() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().join("data"));
        store.save_queue(&[test_track("a"), test_track("b")]).unwrap();
        store.save_state(&SessionState::from(&player_state(1, 9_000))).unwrap();

        let restored = store.load().unwrap();

        assert_eq!(restored.tracks.len(), 2);
        assert_eq!(restored.index, Some(1));
        assert_eq!(restored.position_ms, 9_000);
        assert_eq!(restored.volume, 0.5);
        assert!(restored.shuffle);
        assert_eq!(restored.repeat, Repeat::One);
    }

    #[test]
    fn missing_state_falls_back_to_defaults_and_corrupt_queue_restores_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().to_path_buf());
        store.save_queue(&[test_track("a")]).unwrap();
        let restored = store.load().unwrap();
        assert_eq!(restored.index, None);
        assert_eq!(restored.volume, 1.0);

        std::fs::write(dir.path().join("session-queue.json"), "{ nope").unwrap();
        assert!(store.load().is_none());
    }

    #[test]
    fn an_empty_saved_queue_restores_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().to_path_buf());
        store.save_queue(&[]).unwrap();
        assert!(store.load().is_none());
    }

    #[test]
    fn writer_flush_persists_the_latest_changes_including_position() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().to_path_buf());
        let writer = SessionWriter::spawn(store.clone());

        writer.queue_changed(vec![test_track("a"), test_track("b")]);
        writer.state_changed(&player_state(0, 1_000));
        writer.position_changed(55_000);
        writer.flush();

        let restored = store.load().unwrap();
        assert_eq!(restored.tracks.len(), 2);
        assert_eq!(restored.position_ms, 55_000);
    }
}
