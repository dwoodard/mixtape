//! Live spectrum of what is playing, for the visuals.
//!
//! A [`Tap`] sits between the decoder and the output and copies a mono mix of
//! the samples into a [`Shared`] ring. A separate thread calls
//! [`Shared::frame`] about 30 times a second and sends the result to the window.

use rodio::{ChannelCount, Sample, SampleRate, Source, source::SeekError};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

/// Number of bands sent to the window, low pitch to high.
pub const BANDS: usize = 32;
/// Samples analysed per frame. Must be a power of two.
const WINDOW: usize = 1024;
/// Mono frames the tap collects before handing them to the ring.
const BATCH: usize = 256;
/// Quietest and loudest level (in dB) that maps to 0 and 1.
const FLOOR_DB: f32 = -80.0;
const CEILING_DB: f32 = -20.0;
/// Extra dB at the top band, because music carries less energy up there.
const TILT_DB: f32 = 14.0;
const LOWEST_HZ: f32 = 40.0;
const HIGHEST_HZ: f32 = 16_000.0;

/// One analysed slice of audio. Every value is between 0 and 1.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Frame {
    pub bands: Vec<f32>,
    pub level: f32,
}

struct Ring {
    samples: Vec<f32>,
    write: usize,
    total: u64,
}

/// Latest samples written by the [`Tap`], read by the analysis thread.
pub struct Shared {
    ring: Mutex<Ring>,
    sample_rate: AtomicU32,
}

impl Shared {
    pub fn new() -> Self {
        Shared {
            ring: Mutex::new(Ring { samples: vec![0.0; WINDOW], write: 0, total: 0 }),
            sample_rate: AtomicU32::new(44_100),
        }
    }

    fn push(&self, batch: &[f32]) -> bool {
        // Never block the audio thread: if the reader holds the lock, try again with the next batch.
        let Ok(mut ring) = self.ring.try_lock() else { return false };
        for &s in batch {
            let at = ring.write;
            ring.samples[at] = s;
            ring.write = (at + 1) % WINDOW;
        }
        ring.total += batch.len() as u64;
        true
    }

    /// Analyses the newest samples. `seen` holds the sample count of the previous call:
    /// when nothing new arrived (paused, stopped) this returns `None`.
    pub fn frame(&self, seen: &mut u64) -> Option<Frame> {
        let (mut window, total) = {
            let ring = self.ring.lock().ok()?;
            let mut out = Vec::with_capacity(WINDOW);
            out.extend_from_slice(&ring.samples[ring.write..]);
            out.extend_from_slice(&ring.samples[..ring.write]);
            (out, ring.total)
        };
        if total == *seen {
            return None;
        }
        *seen = total;
        Some(analyse(&mut window, self.sample_rate.load(Ordering::Relaxed)))
    }
}

impl Default for Shared {
    fn default() -> Self {
        Self::new()
    }
}

/// Source wrapper that copies a mono mix of its samples into [`Shared`].
pub struct Tap<S> {
    input: S,
    shared: std::sync::Arc<Shared>,
    channels: usize,
    frame_sum: f32,
    frame_len: usize,
    batch: Vec<f32>,
}

impl<S: Source> Tap<S> {
    pub fn new(input: S, shared: std::sync::Arc<Shared>) -> Self {
        shared.sample_rate.store(input.sample_rate().get(), Ordering::Relaxed);
        let channels = input.channels().get() as usize;
        Tap { input, shared, channels, frame_sum: 0.0, frame_len: 0, batch: Vec::with_capacity(BATCH * 2) }
    }
}

impl<S: Source> Iterator for Tap<S> {
    type Item = Sample;

    #[inline]
    fn next(&mut self) -> Option<Sample> {
        let sample = self.input.next()?;
        self.frame_sum += sample;
        self.frame_len += 1;
        if self.frame_len == self.channels {
            self.batch.push(self.frame_sum / self.channels as f32);
            self.frame_sum = 0.0;
            self.frame_len = 0;
            if self.batch.len() >= BATCH && self.shared.push(&self.batch) {
                self.batch.clear();
            } else if self.batch.len() >= BATCH * 8 {
                self.batch.clear();
            }
        }
        Some(sample)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.input.size_hint()
    }
}

impl<S: Source> Source for Tap<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.input.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.input.channels()
    }
    fn sample_rate(&self) -> SampleRate {
        self.input.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.input.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.input.try_seek(pos)
    }
}

/// Windowed FFT of `samples` (length [`WINDOW`]), folded into [`BANDS`] log-spaced bands.
fn analyse(samples: &mut [f32], sample_rate: u32) -> Frame {
    let n = samples.len();
    let mut re: Vec<f32> = samples
        .iter()
        .enumerate()
        .map(|(i, s)| s * (0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / n as f32).cos()))
        .collect();
    let mut im = vec![0.0f32; n];
    fft(&mut re, &mut im);

    // Hann window halves the amplitude, and a real signal splits between two mirrored bins.
    let scale = 4.0 / n as f32;
    let magnitude: Vec<f32> = (0..n / 2).map(|k| (re[k] * re[k] + im[k] * im[k]).sqrt() * scale).collect();

    let nyquist = sample_rate as f32 / 2.0;
    let top = HIGHEST_HZ.min(nyquist * 0.95);
    let hz_per_bin = sample_rate as f32 / n as f32;
    let ratio = (top / LOWEST_HZ).powf(1.0 / BANDS as f32);

    let mut bands = Vec::with_capacity(BANDS);
    for b in 0..BANDS {
        let from = LOWEST_HZ * ratio.powi(b as i32);
        let to = from * ratio;
        let first = ((from / hz_per_bin).floor() as usize).min(n / 2 - 1);
        let last = ((to / hz_per_bin).ceil() as usize).clamp(first + 1, n / 2);
        let peak = magnitude[first..last].iter().cloned().fold(0.0f32, f32::max);
        let db = 20.0 * (peak + 1e-9).log10() + TILT_DB * b as f32 / (BANDS - 1) as f32;
        bands.push(((db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)).clamp(0.0, 1.0));
    }

    let rms = (samples.iter().map(|s| s * s).sum::<f32>() / n as f32).sqrt();
    let db = 20.0 * (rms + 1e-9).log10();
    let level = ((db - FLOOR_DB) / (0.0 - FLOOR_DB)).clamp(0.0, 1.0);
    Frame { bands, level }
}

/// In-place radix-2 FFT. `re.len()` must be a power of two.
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let angle = -std::f32::consts::TAU / len as f32;
        let (w_im, w_re) = angle.sin_cos();
        for start in (0..n).step_by(len) {
            let (mut cur_re, mut cur_im) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let t_re = re[b] * cur_re - im[b] * cur_im;
                let t_im = re[b] * cur_im + im[b] * cur_re;
                re[b] = re[a] - t_re;
                im[b] = im[a] - t_im;
                re[a] += t_re;
                im[a] += t_im;
                let next_re = cur_re * w_re - cur_im * w_im;
                cur_im = cur_re * w_im + cur_im * w_re;
                cur_re = next_re;
            }
        }
        len <<= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f32, sample_rate: u32, amplitude: f32) -> Vec<f32> {
        (0..WINDOW)
            .map(|i| amplitude * (std::f32::consts::TAU * hz * i as f32 / sample_rate as f32).sin())
            .collect()
    }

    fn loudest(frame: &Frame) -> usize {
        frame.bands.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0
    }

    #[test]
    fn silence_gives_all_zero() {
        let frame = analyse(&mut vec![0.0; WINDOW], 44_100);
        assert_eq!(frame.bands.len(), BANDS);
        assert!(frame.bands.iter().all(|&b| b == 0.0));
        assert_eq!(frame.level, 0.0);
    }

    #[test]
    fn a_tone_lights_up_its_own_band_and_higher_tones_land_higher() {
        let low = analyse(&mut sine(100.0, 44_100, 0.5), 44_100);
        let mid = analyse(&mut sine(1_000.0, 44_100, 0.5), 44_100);
        let high = analyse(&mut sine(8_000.0, 44_100, 0.5), 44_100);
        assert!(loudest(&low) < loudest(&mid), "{} < {}", loudest(&low), loudest(&mid));
        assert!(loudest(&mid) < loudest(&high), "{} < {}", loudest(&mid), loudest(&high));
        assert!(mid.bands[loudest(&mid)] > 0.8);
        assert!(mid.level > 0.3);
    }

    #[test]
    fn louder_audio_reads_higher() {
        let quiet = analyse(&mut sine(1_000.0, 44_100, 0.01), 44_100);
        let loud = analyse(&mut sine(1_000.0, 44_100, 0.5), 44_100);
        assert!(loud.bands[loudest(&loud)] > quiet.bands[loudest(&quiet)]);
        assert!(loud.level > quiet.level);
    }

    #[test]
    fn frame_is_only_produced_when_new_samples_arrived() {
        let shared = Shared::new();
        let mut seen = 0;
        assert!(shared.frame(&mut seen).is_none());
        assert!(shared.push(&sine(440.0, 44_100, 0.5)[..BATCH]));
        assert!(shared.frame(&mut seen).is_some());
        assert!(shared.frame(&mut seen).is_none());
    }

    #[test]
    fn tap_passes_samples_through_unchanged_and_feeds_the_ring() {
        use rodio::buffer::SamplesBuffer;
        use std::num::NonZero;
        let samples: Vec<f32> = (0..BATCH * 4).map(|i| (i as f32 * 0.01).sin()).collect();
        let source = SamplesBuffer::new(NonZero::new(2).unwrap(), NonZero::new(44_100).unwrap(), samples.clone());
        let shared = std::sync::Arc::new(Shared::new());
        let out: Vec<f32> = Tap::new(source, shared.clone()).collect();
        assert_eq!(out, samples);
        assert!(shared.frame(&mut 0).is_some());
    }
}
