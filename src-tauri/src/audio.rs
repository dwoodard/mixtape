use crate::player::{Backend, BackendEvent};
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player as RodioPlayer};
use std::fs::File;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::Duration;

/// How often the audio thread reports position and checks for track end.
const TICK: Duration = Duration::from_millis(250);

enum Command {
    Load { path: String, token: u64, reply: Sender<Result<(), String>> },
    Play,
    Pause,
    Seek(u64),
    Volume(f32),
    Stop,
}

/// Audio output on the default device using rodio (symphonia decoders).
///
/// The output stream is not `Send` on macOS, so it lives on a dedicated
/// thread and this handle talks to it over a channel.
pub struct RodioBackend {
    tx: Sender<Command>,
}

impl RodioBackend {
    pub fn spawn(events: Sender<BackendEvent>) -> Self {
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("mixtape-audio".into())
            .spawn(move || AudioThread::new(events).run(rx))
            .expect("spawn audio thread");
        RodioBackend { tx }
    }
}

impl Backend for RodioBackend {
    fn load(&mut self, path: &str, token: u64) -> Result<(), String> {
        let (reply, result) = mpsc::channel();
        self.tx
            .send(Command::Load { path: path.to_string(), token, reply })
            .map_err(|_| "audio thread stopped".to_string())?;
        result.recv().map_err(|_| "audio thread stopped".to_string())?
    }

    fn play(&mut self) {
        let _ = self.tx.send(Command::Play);
    }

    fn pause(&mut self) {
        let _ = self.tx.send(Command::Pause);
    }

    fn seek(&mut self, position_ms: u64) {
        let _ = self.tx.send(Command::Seek(position_ms));
    }

    fn set_volume(&mut self, volume: f32) {
        let _ = self.tx.send(Command::Volume(volume));
    }

    fn stop(&mut self) {
        let _ = self.tx.send(Command::Stop);
    }
}

struct Active {
    player: RodioPlayer,
    token: u64,
}

struct AudioThread {
    events: Sender<BackendEvent>,
    device: Option<MixerDeviceSink>,
    active: Option<Active>,
    volume: f32,
}

impl AudioThread {
    fn new(events: Sender<BackendEvent>) -> Self {
        AudioThread { events, device: None, active: None, volume: 1.0 }
    }

    fn run(mut self, rx: Receiver<Command>) {
        loop {
            match rx.recv_timeout(TICK) {
                Ok(command) => self.handle(command),
                Err(RecvTimeoutError::Timeout) => self.tick(),
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    fn handle(&mut self, command: Command) {
        match command {
            Command::Load { path, token, reply } => {
                let _ = reply.send(self.load(&path, token));
            }
            Command::Play => {
                if let Some(a) = &self.active {
                    a.player.play();
                }
            }
            Command::Pause => {
                if let Some(a) = &self.active {
                    a.player.pause();
                }
            }
            Command::Seek(ms) => {
                if let Some(a) = &self.active {
                    if let Err(e) = a.player.try_seek(Duration::from_millis(ms)) {
                        eprintln!("seek failed: {e}");
                    }
                }
            }
            Command::Volume(v) => {
                self.volume = v;
                if let Some(a) = &self.active {
                    a.player.set_volume(v);
                }
            }
            Command::Stop => self.active = None,
        }
    }

    fn load(&mut self, path: &str, token: u64) -> Result<(), String> {
        // Drop the previous track first so its end is never reported.
        self.active = None;
        let file = File::open(path).map_err(|e| e.to_string())?;
        let source = Decoder::try_from(file).map_err(|e| e.to_string())?;
        if self.device.is_none() {
            let mut device = DeviceSinkBuilder::open_default_sink()
                .map_err(|e| format!("no audio output: {e}"))?;
            device.log_on_drop(false);
            self.device = Some(device);
        }
        let device = self.device.as_ref().expect("device opened above");
        let player = RodioPlayer::connect_new(device.mixer());
        player.set_volume(self.volume);
        player.append(source);
        self.active = Some(Active { player, token });
        Ok(())
    }

    fn tick(&mut self) {
        let Some(active) = &self.active else { return };
        if active.player.empty() {
            let token = active.token;
            self.active = None;
            let _ = self.events.send(BackendEvent::Ended { token });
        } else if !active.player.is_paused() {
            let position_ms = active.player.get_pos().as_millis() as u64;
            let _ = self.events.send(BackendEvent::Position { token: active.token, position_ms });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::track::test_support::write_wav;

    /// Needs a real audio output device, so it is skipped by default.
    /// Run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn plays_a_file_reports_position_and_ends() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tone.wav");
        write_wav(&path, 1.0);

        let (tx, rx) = mpsc::channel();
        let mut backend = RodioBackend::spawn(tx);
        backend.set_volume(0.0);
        backend.load(path.to_str().unwrap(), 7).unwrap();

        let mut saw_position = false;
        loop {
            match rx.recv_timeout(Duration::from_secs(5)).expect("event before timeout") {
                BackendEvent::Position { token: 7, .. } => saw_position = true,
                BackendEvent::Ended { token: 7 } => break,
                other => panic!("unexpected event {other:?}"),
            }
        }
        assert!(saw_position);
    }

    #[test]
    fn decoder_accepts_every_supported_format_and_can_seek() {
        use rodio::Source;
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        for ext in ["mp3", "flac", "m4a", "ogg"] {
            let file = File::open(dir.join(format!("tone.{ext}"))).unwrap();
            let mut decoder = Decoder::try_from(file)
                .unwrap_or_else(|e| panic!("{ext} should decode: {e}"));
            assert!(decoder.next().is_some(), "{ext} yields samples");
            decoder
                .try_seek(Duration::from_millis(500))
                .unwrap_or_else(|e| panic!("{ext} should seek: {e}"));
        }
    }

    #[test]
    fn load_reports_missing_and_undecodable_files() {
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("bad.mp3");
        std::fs::write(&bad, b"not audio").unwrap();

        let (tx, _rx) = mpsc::channel();
        let mut backend = RodioBackend::spawn(tx);

        assert!(backend.load("/no/such/file.mp3", 1).is_err());
        assert!(backend.load(bad.to_str().unwrap(), 2).is_err());
    }
}
