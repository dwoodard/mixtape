use crate::queue::Queue;
use crate::track::Track;
use serde::Serialize;

/// If playback is past this point, "previous" restarts the track instead of
/// going to the previous one.
const RESTART_THRESHOLD_MS: u64 = 3_000;

/// Audio output. Implemented by the rodio backend and by a fake in tests.
pub trait Backend: Send {
    /// Starts playing `path`. `token` identifies this load in later events.
    fn load(&mut self, path: &str, token: u64) -> Result<(), String>;
    fn play(&mut self);
    fn pause(&mut self);
    fn seek(&mut self, position_ms: u64);
    fn set_volume(&mut self, volume: f32);
    fn stop(&mut self);
}

/// Events the audio backend reports back to the player.
#[derive(Debug, Clone, PartialEq)]
pub enum BackendEvent {
    Position { token: u64, position_ms: u64 },
    Ended { token: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Stopped,
    Playing,
    Paused,
}

/// Everything the UI needs except the queue itself.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub status: Status,
    pub current_index: Option<usize>,
    pub current_track: Option<Track>,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub volume: f32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlayerEvent {
    /// Status, current track, or volume changed.
    State(PlayerState),
    /// The queue contents changed.
    Queue(Vec<Track>),
    /// Playback position tick.
    Position(u64),
}

pub struct Player {
    queue: Queue,
    status: Status,
    position_ms: u64,
    volume: f32,
    token: u64,
    error: Option<String>,
    backend: Box<dyn Backend>,
    emit: Box<dyn Fn(PlayerEvent) + Send>,
}

impl Player {
    pub fn new(backend: Box<dyn Backend>, emit: Box<dyn Fn(PlayerEvent) + Send>) -> Self {
        let mut player = Player {
            queue: Queue::default(),
            status: Status::Stopped,
            position_ms: 0,
            volume: 1.0,
            token: 0,
            error: None,
            backend,
            emit,
        };
        player.backend.set_volume(player.volume);
        player
    }

    pub fn state(&self) -> PlayerState {
        let track = self.queue.current();
        PlayerState {
            status: self.status,
            current_index: self.queue.current_index(),
            current_track: track.cloned(),
            position_ms: self.position_ms,
            duration_ms: track.map_or(0, |t| t.duration_ms),
            volume: self.volume,
            error: self.error.clone(),
        }
    }

    pub fn queue_tracks(&self) -> &[Track] {
        self.queue.tracks()
    }

    // --- commands ---

    /// Replaces the queue and starts playing at `start`.
    pub fn play_tracks(&mut self, tracks: Vec<Track>, start: usize) {
        self.queue.set(tracks, start);
        self.emit_queue();
        self.start_current();
    }

    /// Adds tracks to the end of the queue without changing what is playing.
    pub fn enqueue(&mut self, tracks: Vec<Track>) {
        if tracks.is_empty() {
            return;
        }
        let had_current = self.queue.current_index().is_some();
        self.queue.append(tracks);
        self.emit_queue();
        if !had_current {
            // Nothing selected yet: point at the first track so play has a target.
            self.queue.jump(0);
            self.emit_state();
        }
    }

    pub fn play_index(&mut self, index: usize) {
        if self.queue.jump(index).is_some() {
            self.start_current();
        }
    }

    pub fn toggle(&mut self) {
        match self.status {
            Status::Playing => self.pause(),
            Status::Paused => self.resume(),
            Status::Stopped => {
                if self.queue.current().is_some() {
                    self.start_current();
                }
            }
        }
    }

    pub fn pause(&mut self) {
        if self.status == Status::Playing {
            self.backend.pause();
            self.status = Status::Paused;
            self.emit_state();
        }
    }

    pub fn resume(&mut self) {
        match self.status {
            Status::Paused => {
                self.backend.play();
                self.status = Status::Playing;
                self.emit_state();
            }
            Status::Stopped => {
                if self.queue.current().is_some() {
                    self.start_current();
                }
            }
            Status::Playing => {}
        }
    }

    pub fn stop(&mut self) {
        self.stop_playback();
        self.emit_state();
    }

    pub fn next(&mut self) {
        if self.queue.next().is_some() {
            self.start_current();
        }
    }

    pub fn prev(&mut self) {
        if self.status != Status::Stopped && self.position_ms > RESTART_THRESHOLD_MS {
            self.seek(0);
        } else if self.queue.prev().is_some() {
            self.start_current();
        } else if self.status != Status::Stopped {
            self.seek(0);
        }
    }

    pub fn seek(&mut self, position_ms: u64) {
        if self.status == Status::Stopped {
            return;
        }
        let duration = self.queue.current().map_or(0, |t| t.duration_ms);
        let target = if duration > 0 { position_ms.min(duration) } else { position_ms };
        self.backend.seek(target);
        self.position_ms = target;
        (self.emit)(PlayerEvent::Position(target));
    }

    /// Seeks forward or backward from the current position.
    pub fn seek_relative(&mut self, delta_ms: i64) {
        let target = (self.position_ms as i64 + delta_ms).max(0) as u64;
        self.seek(target);
    }

    pub fn set_volume(&mut self, volume: f32) {
        self.volume = volume.clamp(0.0, 1.0);
        self.backend.set_volume(self.volume);
        self.emit_state();
    }

    pub fn remove(&mut self, index: usize) {
        if index >= self.queue.tracks().len() {
            return;
        }
        let removed_current = self.queue.remove(index);
        self.emit_queue();
        if removed_current {
            if self.queue.current().is_some() && self.status != Status::Stopped {
                self.start_current();
            } else {
                self.stop_playback();
                self.emit_state();
            }
        } else {
            self.emit_state();
        }
    }

    pub fn clear(&mut self) {
        self.queue.clear();
        self.stop_playback();
        self.emit_queue();
        self.emit_state();
    }

    pub fn handle_backend_event(&mut self, event: BackendEvent) {
        match event {
            BackendEvent::Position { token, position_ms } => {
                if token == self.token && self.status == Status::Playing {
                    self.position_ms = position_ms;
                    (self.emit)(PlayerEvent::Position(position_ms));
                }
            }
            BackendEvent::Ended { token } => {
                if token != self.token || self.status == Status::Stopped {
                    return;
                }
                if self.queue.next().is_some() {
                    self.start_current();
                } else {
                    self.stop_playback();
                    self.emit_state();
                }
            }
        }
    }

    // --- internals ---

    /// Loads and plays the queue's current track. Tracks that fail to load are
    /// skipped; the last error is reported in the state.
    fn start_current(&mut self) {
        self.error = None;
        loop {
            let Some(path) = self.queue.current().map(|t| t.path.clone()) else {
                self.stop_playback();
                break;
            };
            self.token += 1;
            match self.backend.load(&path, self.token) {
                Ok(()) => {
                    self.status = Status::Playing;
                    self.position_ms = 0;
                    break;
                }
                Err(message) => {
                    self.error = Some(format!("{path}: {message}"));
                    if self.queue.next().is_none() {
                        self.stop_playback();
                        break;
                    }
                }
            }
        }
        self.emit_state();
    }

    fn stop_playback(&mut self) {
        self.token += 1;
        self.backend.stop();
        self.status = Status::Stopped;
        self.position_ms = 0;
    }

    fn emit_state(&self) {
        (self.emit)(PlayerEvent::State(self.state()));
    }

    fn emit_queue(&self) {
        (self.emit)(PlayerEvent::Queue(self.queue.tracks().to_vec()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::test_track;
    use std::sync::{Arc, Mutex};

    #[derive(Debug, Clone, PartialEq)]
    enum Call {
        Load(String),
        Play,
        Pause,
        Seek(u64),
        Volume(f32),
        Stop,
    }

    #[derive(Clone, Default)]
    struct Fake {
        calls: Arc<Mutex<Vec<Call>>>,
        fail_paths: Arc<Mutex<Vec<String>>>,
        last_token: Arc<Mutex<u64>>,
    }

    impl Backend for Fake {
        fn load(&mut self, path: &str, token: u64) -> Result<(), String> {
            if self.fail_paths.lock().unwrap().iter().any(|p| p == path) {
                return Err("cannot decode".into());
            }
            *self.last_token.lock().unwrap() = token;
            self.calls.lock().unwrap().push(Call::Load(path.into()));
            Ok(())
        }
        fn play(&mut self) {
            self.calls.lock().unwrap().push(Call::Play);
        }
        fn pause(&mut self) {
            self.calls.lock().unwrap().push(Call::Pause);
        }
        fn seek(&mut self, ms: u64) {
            self.calls.lock().unwrap().push(Call::Seek(ms));
        }
        fn set_volume(&mut self, v: f32) {
            self.calls.lock().unwrap().push(Call::Volume(v));
        }
        fn stop(&mut self) {
            self.calls.lock().unwrap().push(Call::Stop);
        }
    }

    struct Harness {
        player: Player,
        fake: Fake,
        events: Arc<Mutex<Vec<PlayerEvent>>>,
    }

    impl Harness {
        fn new() -> Self {
            let fake = Fake::default();
            let events = Arc::new(Mutex::new(Vec::new()));
            let sink = events.clone();
            let player = Player::new(
                Box::new(fake.clone()),
                Box::new(move |e| sink.lock().unwrap().push(e)),
            );
            Harness { player, fake, events }
        }

        fn calls(&self) -> Vec<Call> {
            self.fake.calls.lock().unwrap().clone()
        }

        fn loads(&self) -> Vec<String> {
            self.calls()
                .into_iter()
                .filter_map(|c| if let Call::Load(p) = c { Some(p) } else { None })
                .collect()
        }

        fn token(&self) -> u64 {
            *self.fake.last_token.lock().unwrap()
        }

        fn load_abc(&mut self, start: usize) {
            self.player
                .play_tracks(vec![test_track("a"), test_track("b"), test_track("c")], start);
        }
    }

    #[test]
    fn play_tracks_loads_the_start_track_and_reports_playing() {
        let mut h = Harness::new();
        h.load_abc(1);

        assert_eq!(h.loads(), vec!["/music/b.mp3"]);
        let state = h.player.state();
        assert_eq!(state.status, Status::Playing);
        assert_eq!(state.current_index, Some(1));
        assert_eq!(state.duration_ms, 180_000);
    }

    #[test]
    fn toggle_pauses_then_resumes() {
        let mut h = Harness::new();
        h.load_abc(0);

        h.player.toggle();
        assert_eq!(h.player.state().status, Status::Paused);
        h.player.toggle();
        assert_eq!(h.player.state().status, Status::Playing);
        let calls = h.calls();
        assert!(calls.contains(&Call::Pause) && calls.contains(&Call::Play));
    }

    #[test]
    fn toggle_when_stopped_starts_current_track() {
        let mut h = Harness::new();
        h.player.enqueue(vec![test_track("a")]);
        assert_eq!(h.player.state().status, Status::Stopped);

        h.player.toggle();

        assert_eq!(h.loads(), vec!["/music/a.mp3"]);
        assert_eq!(h.player.state().status, Status::Playing);
    }

    #[test]
    fn toggle_with_empty_queue_does_nothing() {
        let mut h = Harness::new();
        h.player.toggle();
        assert_eq!(h.player.state().status, Status::Stopped);
        assert!(h.loads().is_empty());
    }

    #[test]
    fn next_and_prev_move_through_the_queue() {
        let mut h = Harness::new();
        h.load_abc(0);

        h.player.next();
        h.player.next();
        assert_eq!(h.player.state().current_index, Some(2));
        h.player.prev();
        assert_eq!(h.player.state().current_index, Some(1));
        assert_eq!(h.loads(), vec!["/music/a.mp3", "/music/b.mp3", "/music/c.mp3", "/music/b.mp3"]);
    }

    #[test]
    fn next_at_end_is_a_no_op() {
        let mut h = Harness::new();
        h.load_abc(2);
        h.player.next();
        assert_eq!(h.player.state().current_index, Some(2));
        assert_eq!(h.player.state().status, Status::Playing);
    }

    #[test]
    fn prev_after_threshold_restarts_the_track() {
        let mut h = Harness::new();
        h.load_abc(1);
        let token = h.token();
        h.player.handle_backend_event(BackendEvent::Position { token, position_ms: 10_000 });

        h.player.prev();

        assert_eq!(h.player.state().current_index, Some(1));
        assert!(h.calls().contains(&Call::Seek(0)));
    }

    #[test]
    fn prev_near_start_goes_to_previous_track() {
        let mut h = Harness::new();
        h.load_abc(1);
        let token = h.token();
        h.player.handle_backend_event(BackendEvent::Position { token, position_ms: 1_000 });

        h.player.prev();

        assert_eq!(h.player.state().current_index, Some(0));
    }

    #[test]
    fn prev_on_first_track_restarts_it() {
        let mut h = Harness::new();
        h.load_abc(0);
        h.player.prev();
        assert_eq!(h.player.state().current_index, Some(0));
        assert!(h.calls().contains(&Call::Seek(0)));
    }

    #[test]
    fn seek_is_clamped_to_duration_and_ignored_when_stopped() {
        let mut h = Harness::new();
        h.player.seek(5_000);
        assert!(h.calls().iter().all(|c| !matches!(c, Call::Seek(_))));

        h.load_abc(0);
        h.player.seek(999_999);
        assert!(h.calls().contains(&Call::Seek(180_000)));
        assert_eq!(h.player.state().position_ms, 180_000);
    }

    #[test]
    fn relative_seek_moves_from_current_position_and_floors_at_zero() {
        let mut h = Harness::new();
        h.load_abc(0);
        let token = h.token();
        h.player.handle_backend_event(BackendEvent::Position { token, position_ms: 20_000 });

        h.player.seek_relative(10_000);
        assert_eq!(h.player.state().position_ms, 30_000);
        h.player.seek_relative(-100_000);
        assert_eq!(h.player.state().position_ms, 0);
    }

    #[test]
    fn volume_is_clamped() {
        let mut h = Harness::new();
        h.player.set_volume(3.0);
        assert_eq!(h.player.state().volume, 1.0);
        h.player.set_volume(-1.0);
        assert_eq!(h.player.state().volume, 0.0);
        assert_eq!(h.calls().last(), Some(&Call::Volume(0.0)));
    }

    #[test]
    fn track_end_advances_to_next_track() {
        let mut h = Harness::new();
        h.load_abc(0);
        let token = h.token();

        h.player.handle_backend_event(BackendEvent::Ended { token });

        assert_eq!(h.player.state().current_index, Some(1));
        assert_eq!(h.player.state().status, Status::Playing);
    }

    #[test]
    fn track_end_on_last_track_stops_and_keeps_current() {
        let mut h = Harness::new();
        h.load_abc(2);
        let token = h.token();

        h.player.handle_backend_event(BackendEvent::Ended { token });

        let state = h.player.state();
        assert_eq!(state.status, Status::Stopped);
        assert_eq!(state.current_index, Some(2));
        assert_eq!(state.position_ms, 0);
    }

    #[test]
    fn stale_backend_events_are_ignored() {
        let mut h = Harness::new();
        h.load_abc(0);
        let old = h.token();
        h.player.next();

        h.player.handle_backend_event(BackendEvent::Ended { token: old });
        h.player.handle_backend_event(BackendEvent::Position { token: old, position_ms: 9_000 });

        assert_eq!(h.player.state().current_index, Some(1));
        assert_eq!(h.player.state().position_ms, 0);
    }

    #[test]
    fn unplayable_track_is_skipped_and_error_reported() {
        let mut h = Harness::new();
        h.fake.fail_paths.lock().unwrap().push("/music/b.mp3".into());
        h.load_abc(1);

        let state = h.player.state();
        assert_eq!(state.current_index, Some(2));
        assert_eq!(state.status, Status::Playing);
        assert!(state.error.unwrap().contains("b.mp3"));
    }

    #[test]
    fn all_tracks_failing_ends_stopped() {
        let mut h = Harness::new();
        for n in ["a", "b", "c"] {
            h.fake.fail_paths.lock().unwrap().push(format!("/music/{n}.mp3"));
        }
        h.load_abc(0);
        assert_eq!(h.player.state().status, Status::Stopped);
        assert!(h.player.state().error.is_some());
    }

    #[test]
    fn enqueue_appends_without_interrupting_playback() {
        let mut h = Harness::new();
        h.load_abc(0);
        h.player.enqueue(vec![test_track("d")]);

        assert_eq!(h.player.queue_tracks().len(), 4);
        assert_eq!(h.player.state().current_index, Some(0));
        assert_eq!(h.loads().len(), 1);
    }

    #[test]
    fn removing_the_playing_track_plays_its_replacement() {
        let mut h = Harness::new();
        h.load_abc(1);

        h.player.remove(1);

        assert_eq!(h.player.state().current_index, Some(1));
        assert_eq!(h.loads().last().unwrap(), "/music/c.mp3");
    }

    #[test]
    fn removing_the_last_playing_track_stops() {
        let mut h = Harness::new();
        h.load_abc(2);
        h.player.remove(2);
        assert_eq!(h.player.state().status, Status::Stopped);
        assert_eq!(h.player.state().current_index, None);
    }

    #[test]
    fn clear_stops_and_empties_queue() {
        let mut h = Harness::new();
        h.load_abc(0);
        h.player.clear();
        assert_eq!(h.player.state().status, Status::Stopped);
        assert!(h.player.queue_tracks().is_empty());
    }

    #[test]
    fn emits_queue_and_state_events_on_play_tracks() {
        let mut h = Harness::new();
        h.load_abc(0);
        let events = h.events.lock().unwrap();
        assert!(events.iter().any(|e| matches!(e, PlayerEvent::Queue(q) if q.len() == 3)));
        assert!(events
            .iter()
            .any(|e| matches!(e, PlayerEvent::State(s) if s.status == Status::Playing)));
    }
}
