use crate::queue::{Queue, Repeat};
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
    pub shuffle: bool,
    pub repeat: Repeat,
    /// Why the last track could not be played, and which file it was.
    pub error: Option<String>,
    pub error_path: Option<String>,
}

/// What is needed to bring the player back as it was at the last quit.
#[derive(Debug, Clone, PartialEq)]
pub struct Restore {
    pub tracks: Vec<Track>,
    pub index: Option<usize>,
    pub position_ms: u64,
    pub volume: f32,
    pub shuffle: bool,
    pub repeat: Repeat,
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
    /// A restored position that applies when the track at that index starts.
    pending_seek: Option<(usize, u64)>,
    token: u64,
    error: Option<String>,
    error_path: Option<String>,
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
            pending_seek: None,
            token: 0,
            error: None,
            error_path: None,
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
            shuffle: self.queue.shuffle(),
            repeat: self.queue.repeat(),
            error: self.error.clone(),
            error_path: self.error_path.clone(),
        }
    }

    pub fn queue_tracks(&self) -> &[Track] {
        self.queue.tracks()
    }

    // --- commands ---

    /// Replaces the queue and starts playing at `start`.
    pub fn play_tracks(&mut self, tracks: Vec<Track>, start: usize) {
        self.pending_seek = None;
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

    /// Inserts tracks right after the current one ("play next").
    pub fn enqueue_next(&mut self, tracks: Vec<Track>) {
        if tracks.is_empty() {
            return;
        }
        let had_current = self.queue.current_index().is_some();
        self.queue.insert_next(tracks);
        self.emit_queue();
        if !had_current {
            self.queue.jump(0);
        }
        self.emit_state();
    }

    /// Hides the last playback error.
    pub fn clear_error(&mut self) {
        self.error = None;
        self.error_path = None;
        self.emit_state();
    }

    /// Updates queue entries after their files were retagged, renamed or
    /// re-added: each `(old path, new track)` replaces the entries for that
    /// file in place. What is playing keeps playing (nothing is reloaded).
    pub fn replace_tracks(&mut self, replacements: Vec<(String, Track)>) {
        let mut replaced = 0;
        for (old_path, track) in &replacements {
            replaced += self.queue.replace_track(old_path, track);
        }
        if replaced > 0 {
            self.emit_queue();
            self.emit_state();
        }
    }

    /// Moves a queue entry (by dragging it, or Move up / down). What is
    /// playing keeps playing and keeps its marker; nothing is reloaded.
    pub fn move_track(&mut self, from: usize, to: usize) {
        if self.queue.move_track(from, to) {
            self.emit_queue();
            self.emit_state();
        }
    }

    pub fn set_shuffle(&mut self, on: bool) {
        self.queue.set_shuffle(on);
        self.emit_state();
    }

    pub fn set_repeat(&mut self, repeat: Repeat) {
        self.queue.set_repeat(repeat);
        self.emit_state();
    }

    /// Loads a saved session without starting playback. Pressing play resumes
    /// the track at the saved position.
    pub fn restore(&mut self, saved: Restore) {
        self.queue.set(saved.tracks, saved.index.unwrap_or(0));
        self.queue.set_shuffle(saved.shuffle);
        self.queue.set_repeat(saved.repeat);
        self.volume = saved.volume.clamp(0.0, 1.0);
        self.backend.set_volume(self.volume);
        let index = self.queue.current_index();
        let duration = self.queue.current().map_or(0, |t| t.duration_ms);
        self.position_ms = saved.position_ms.min(duration);
        self.pending_seek = index.filter(|_| self.position_ms > 0).map(|i| (i, self.position_ms));
        self.emit_queue();
        self.emit_state();
    }

    pub fn play_index(&mut self, index: usize) {
        self.pending_seek = None;
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
        self.pending_seek = None;
        if self.queue.next(false).is_some() {
            self.start_current();
        }
    }

    pub fn prev(&mut self) {
        if self.status != Status::Stopped && self.position_ms > RESTART_THRESHOLD_MS {
            self.seek(0);
        } else if self.queue.prev().is_some() {
            self.pending_seek = None;
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
                self.pending_seek = None;
                if self.queue.next(true).is_some() {
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
        self.error_path = None;
        // Bounds skipping so a queue of unplayable files cannot loop forever
        // under repeat-all or shuffle.
        let mut attempts = self.queue.tracks().len().max(1);
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
                    if let Some((index, ms)) = self.pending_seek.take() {
                        if Some(index) == self.queue.current_index() {
                            self.backend.seek(ms);
                            self.position_ms = ms;
                        }
                    }
                    break;
                }
                Err(message) => {
                    self.error = Some(message);
                    self.error_path = Some(path);
                    attempts -= 1;
                    if attempts == 0 || self.queue.next(false).is_none() {
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
    fn replacing_the_playing_track_updates_what_is_shown_without_interrupting_playback() {
        let mut h = Harness::new();
        h.load_abc(1);
        let loads_before = h.loads().len();
        let mut fresh = test_track("b-retagged");
        fresh.path = "/music/PROF/Good Time Boy/06 b.mp3".into();

        h.player.replace_tracks(vec![("/music/b.mp3".into(), fresh)]);

        let state = h.player.state();
        assert_eq!(state.status, Status::Playing);
        assert_eq!(state.current_index, Some(1));
        assert_eq!(state.current_track.unwrap().title, "b-retagged");
        assert_eq!(h.loads().len(), loads_before, "nothing was reloaded");
        let events = h.events.lock().unwrap();
        assert!(events.iter().any(|e| matches!(e, PlayerEvent::Queue(q) if q.iter().any(|t| t.title == "b-retagged"))));
    }

    #[test]
    fn moving_the_playing_track_keeps_it_playing_and_updates_its_position() {
        let mut h = Harness::new();
        h.load_abc(0);
        let loads_before = h.loads().len();

        h.player.move_track(0, 2);

        let titles: Vec<_> = h.player.queue_tracks().iter().map(|t| t.title.clone()).collect();
        assert_eq!(titles, vec!["b", "c", "a"]);
        let state = h.player.state();
        assert_eq!((state.status, state.current_index), (Status::Playing, Some(2)));
        assert_eq!(state.current_track.unwrap().title, "a");
        assert_eq!(h.loads().len(), loads_before, "nothing was reloaded");
        // Next now goes to what follows it in the new order (nothing: it is last).
        h.player.next();
        assert_eq!(h.player.state().current_index, Some(2));
    }

    #[test]
    fn moving_another_track_past_the_playing_one_changes_where_next_goes() {
        let mut h = Harness::new();
        h.load_abc(0); // playing a; queue a b c
        h.player.move_track(2, 1); // a c b

        h.player.next();

        assert_eq!(h.player.state().current_track.unwrap().title, "c");
    }

    #[test]
    fn an_invalid_move_emits_nothing() {
        let mut h = Harness::new();
        h.load_abc(0);
        let before = h.events.lock().unwrap().len();
        h.player.move_track(0, 0);
        h.player.move_track(9, 1);
        assert_eq!(h.events.lock().unwrap().len(), before);
    }

    #[test]
    fn replacing_nothing_known_emits_nothing() {
        let mut h = Harness::new();
        h.load_abc(0);
        let before = h.events.lock().unwrap().len();
        h.player.replace_tracks(vec![("/music/unknown.mp3".into(), test_track("x"))]);
        assert_eq!(h.events.lock().unwrap().len(), before);
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
        assert_eq!(state.error_path.as_deref(), Some("/music/b.mp3"));
        assert_eq!(state.error.as_deref(), Some("cannot decode"));
    }

    #[test]
    fn dismissing_the_error_clears_it_without_touching_playback() {
        let mut h = Harness::new();
        h.fake.fail_paths.lock().unwrap().push("/music/b.mp3".into());
        h.load_abc(1);
        assert!(h.player.state().error.is_some());

        h.player.clear_error();

        let state = h.player.state();
        assert_eq!((state.error, state.error_path), (None, None));
        assert_eq!(state.status, Status::Playing);
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

    #[test]
    fn repeat_one_replays_the_same_track_when_it_ends() {
        let mut h = Harness::new();
        h.load_abc(1);
        h.player.set_repeat(Repeat::One);
        let token = h.token();

        h.player.handle_backend_event(BackendEvent::Ended { token });

        assert_eq!(h.player.state().current_index, Some(1));
        assert_eq!(h.player.state().status, Status::Playing);
        assert_eq!(h.loads().iter().filter(|p| *p == "/music/b.mp3").count(), 2);
    }

    #[test]
    fn repeat_all_wraps_to_the_first_track_when_the_last_ends() {
        let mut h = Harness::new();
        h.load_abc(2);
        h.player.set_repeat(Repeat::All);
        let token = h.token();

        h.player.handle_backend_event(BackendEvent::Ended { token });

        assert_eq!(h.player.state().current_index, Some(0));
        assert_eq!(h.player.state().status, Status::Playing);
    }

    #[test]
    fn shuffle_and_repeat_show_up_in_state() {
        let mut h = Harness::new();
        h.player.set_shuffle(true);
        h.player.set_repeat(Repeat::All);
        let state = h.player.state();
        assert!(state.shuffle);
        assert_eq!(state.repeat, Repeat::All);
    }

    #[test]
    fn repeat_all_with_only_unplayable_tracks_stops_instead_of_looping() {
        let mut h = Harness::new();
        for n in ["a", "b", "c"] {
            h.fake.fail_paths.lock().unwrap().push(format!("/music/{n}.mp3"));
        }
        h.player.set_repeat(Repeat::All);
        h.load_abc(0);
        assert_eq!(h.player.state().status, Status::Stopped);
        assert!(h.player.state().error.is_some());
    }

    #[test]
    fn play_next_inserts_after_the_current_track() {
        let mut h = Harness::new();
        h.load_abc(0);
        h.player.enqueue_next(vec![test_track("x")]);

        let titles: Vec<_> = h.player.queue_tracks().iter().map(|t| t.title.clone()).collect();
        assert_eq!(titles, vec!["a", "x", "b", "c"]);
        assert_eq!(h.player.state().current_index, Some(0));
        h.player.next();
        assert_eq!(h.player.state().current_track.unwrap().title, "x");
    }

    fn saved(index: Option<usize>, position_ms: u64) -> Restore {
        Restore {
            tracks: vec![test_track("a"), test_track("b"), test_track("c")],
            index,
            position_ms,
            volume: 0.4,
            shuffle: true,
            repeat: Repeat::All,
        }
    }

    #[test]
    fn restore_brings_back_queue_settings_without_playing() {
        let mut h = Harness::new();
        h.player.restore(saved(Some(1), 42_000));

        let state = h.player.state();
        assert_eq!(state.status, Status::Stopped);
        assert_eq!(state.current_index, Some(1));
        assert_eq!(state.position_ms, 42_000);
        assert_eq!(state.volume, 0.4);
        assert!(state.shuffle);
        assert_eq!(state.repeat, Repeat::All);
        assert_eq!(h.player.queue_tracks().len(), 3);
        assert!(h.loads().is_empty());
    }

    #[test]
    fn play_after_restore_resumes_at_the_saved_position() {
        let mut h = Harness::new();
        h.player.restore(saved(Some(1), 42_000));

        h.player.toggle();

        assert_eq!(h.loads(), vec!["/music/b.mp3"]);
        assert!(h.calls().contains(&Call::Seek(42_000)));
        assert_eq!(h.player.state().position_ms, 42_000);
        assert_eq!(h.player.state().status, Status::Playing);
    }

    #[test]
    fn choosing_another_track_after_restore_starts_it_from_the_beginning() {
        let mut h = Harness::new();
        h.player.restore(saved(Some(1), 42_000));

        h.player.play_index(2);

        assert_eq!(h.loads(), vec!["/music/c.mp3"]);
        assert!(!h.calls().contains(&Call::Seek(42_000)));
        assert_eq!(h.player.state().position_ms, 0);
    }

    #[test]
    fn restore_clamps_position_and_handles_an_empty_queue() {
        let mut h = Harness::new();
        h.player.restore(saved(Some(0), 9_999_999));
        assert_eq!(h.player.state().position_ms, 180_000);

        let mut empty = saved(None, 5);
        empty.tracks.clear();
        h.player.restore(empty);
        assert_eq!(h.player.state().current_index, None);
        assert_eq!(h.player.state().position_ms, 0);
    }
}
