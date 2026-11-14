use crate::player::{PlayerState, Status};
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
use std::sync::mpsc::{self, Sender};
use std::thread;
use std::time::{Duration, Instant};

/// How far a seek step from a media key moves when the OS gives no amount.
const SEEK_STEP_MS: i64 = 10_000;
/// Position drift beyond this is pushed to the OS. Within it, the OS keeps
/// extrapolating from the last position we sent.
const DRIFT_LIMIT_MS: u64 = 1_500;

/// What the OS asked for via media keys or the Now Playing widget.
#[derive(Debug, Clone, PartialEq)]
pub enum MediaCommand {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
    Stop,
    SeekTo(u64),
    SeekBy(i64),
}

pub fn map_event(event: MediaControlEvent) -> Option<MediaCommand> {
    let signed = |dir: SeekDirection, ms: i64| if dir == SeekDirection::Forward { ms } else { -ms };
    Some(match event {
        MediaControlEvent::Play => MediaCommand::Play,
        MediaControlEvent::Pause => MediaCommand::Pause,
        MediaControlEvent::Toggle => MediaCommand::Toggle,
        MediaControlEvent::Next => MediaCommand::Next,
        MediaControlEvent::Previous => MediaCommand::Previous,
        MediaControlEvent::Stop => MediaCommand::Stop,
        MediaControlEvent::Seek(dir) => MediaCommand::SeekBy(signed(dir, SEEK_STEP_MS)),
        MediaControlEvent::SeekBy(dir, by) => {
            MediaCommand::SeekBy(signed(dir, by.as_millis() as i64))
        }
        MediaControlEvent::SetPosition(MediaPosition(at)) => {
            MediaCommand::SeekTo(at.as_millis() as u64)
        }
        _ => return None,
    })
}

enum Update {
    State(PlayerState),
    Position(u64),
}

/// macOS media keys and the Now Playing widget. Owns the OS handle on its own
/// thread; callers push player updates and receive commands via a callback.
pub struct MediaSession {
    tx: Sender<Update>,
}

impl MediaSession {
    /// Registers with the OS. If registration fails the session is inert and
    /// the error is logged, so the player still works without media keys.
    pub fn spawn(on_command: impl Fn(MediaCommand) + Send + 'static) -> Self {
        let (tx, rx) = mpsc::channel::<Update>();
        thread::Builder::new()
            .name("mixtape-media".into())
            .spawn(move || {
                let config = PlatformConfig {
                    dbus_name: "mixtape",
                    display_name: "Mixtape",
                    hwnd: None,
                };
                let mut controls = match MediaControls::new(config) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("media controls unavailable: {e:?}");
                        return;
                    }
                };
                if let Err(e) = controls.attach(move |event| {
                    if let Some(command) = map_event(event) {
                        on_command(command);
                    }
                }) {
                    eprintln!("media controls attach failed: {e:?}");
                    return;
                }
                let mut sync = Sync::default();
                for update in rx {
                    sync.apply(&mut controls, update);
                }
            })
            .expect("spawn media thread");
        MediaSession { tx }
    }

    pub fn update_state(&self, state: PlayerState) {
        let _ = self.tx.send(Update::State(state));
    }

    pub fn update_position(&self, position_ms: u64) {
        let _ = self.tx.send(Update::Position(position_ms));
    }
}

#[derive(Default)]
struct Sync {
    state: Option<PlayerState>,
    last_path: Option<String>,
    /// Position we last told the OS, and when.
    sent: Option<(u64, Instant)>,
}

impl Sync {
    fn apply(&mut self, controls: &mut MediaControls, update: Update) {
        match update {
            Update::State(state) => {
                let path = state.current_track.as_ref().map(|t| t.path.clone());
                if path != self.last_path {
                    if let Some(track) = &state.current_track {
                        let _ = controls.set_metadata(MediaMetadata {
                            title: Some(&track.title),
                            artist: Some(&track.artist),
                            album: Some(&track.album),
                            cover_url: None,
                            duration: Some(Duration::from_millis(track.duration_ms)),
                        });
                    } else {
                        let _ = controls.set_metadata(MediaMetadata::default());
                    }
                    self.last_path = path;
                }
                self.state = Some(state);
                self.push(controls);
            }
            Update::Position(position_ms) => {
                let Some(state) = &mut self.state else { return };
                state.position_ms = position_ms;
                let expected = self.sent.map_or(0, |(pos, at)| {
                    if state.status == Status::Playing {
                        pos + at.elapsed().as_millis() as u64
                    } else {
                        pos
                    }
                });
                if self.sent.is_none() || position_ms.abs_diff(expected) > DRIFT_LIMIT_MS {
                    self.push(controls);
                }
            }
        }
    }

    fn push(&mut self, controls: &mut MediaControls) {
        let Some(state) = &self.state else { return };
        let progress = Some(MediaPosition(Duration::from_millis(state.position_ms)));
        let playback = match state.status {
            Status::Playing => MediaPlayback::Playing { progress },
            Status::Paused => MediaPlayback::Paused { progress },
            Status::Stopped => MediaPlayback::Stopped,
        };
        let _ = controls.set_playback(playback);
        self.sent = Some((state.position_ms, Instant::now()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_transport_events() {
        assert_eq!(map_event(MediaControlEvent::Toggle), Some(MediaCommand::Toggle));
        assert_eq!(map_event(MediaControlEvent::Next), Some(MediaCommand::Next));
        assert_eq!(map_event(MediaControlEvent::Previous), Some(MediaCommand::Previous));
        assert_eq!(map_event(MediaControlEvent::Play), Some(MediaCommand::Play));
        assert_eq!(map_event(MediaControlEvent::Pause), Some(MediaCommand::Pause));
    }

    #[test]
    fn maps_seeks() {
        assert_eq!(
            map_event(MediaControlEvent::SetPosition(MediaPosition(Duration::from_secs(42)))),
            Some(MediaCommand::SeekTo(42_000))
        );
        assert_eq!(
            map_event(MediaControlEvent::SeekBy(SeekDirection::Backward, Duration::from_secs(5))),
            Some(MediaCommand::SeekBy(-5_000))
        );
        assert_eq!(
            map_event(MediaControlEvent::Seek(SeekDirection::Forward)),
            Some(MediaCommand::SeekBy(10_000))
        );
    }

    #[test]
    fn ignores_events_it_does_not_support() {
        assert_eq!(map_event(MediaControlEvent::Raise), None);
        assert_eq!(map_event(MediaControlEvent::SetVolume(0.5)), None);
    }
}
