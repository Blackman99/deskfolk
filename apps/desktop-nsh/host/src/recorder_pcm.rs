//! The parts of voice input's recording on Windows and Linux (`recorder_portable.rs`) that are
//! plain arithmetic, so they are tested on every desktop: the WAV the recording is answered as, the
//! resampling that keeps it small, the level the button breathes with and the error names.
//!
//! Why WAV, and why resampled: the shell has no AAC or Opus encoder here, and every speech format
//! the daemon speaks takes `audio/wav` (`apps/daemon/src/speech.ts`: OpenAI and ElevenLabs by the
//! `speech.wav` file name, MiMo and Deepgram as they are, Qwen and DashScope by `format`). But the
//! daemon takes at most `SPEECH_AUDIO_BASE64_MAX` characters of base64 per recording (about
//! 730 kB of audio), and 16-bit PCM is 22 kB a second at 11.025 kHz: a recording is about 30
//! seconds. The caller (`media.ts`, then the messenger's recorder) is told that length and stops
//! there, so the limit is a stop and not a failed transcription.

/// What the messenger is told the recording is.
pub const MIME: &str = "audio/wav";

/// The rate a recording is made at: speech to 5.5 kHz, half of what a microphone's rate gives, so
/// that a recording of half a minute fits the transcription limit. A device that records slower
/// than this keeps its own rate.
pub const TARGET_RATE: u32 = 11_025;

/// The most audio one recording may carry, header included: the daemon's limit on the base64 of a
/// recording (`SPEECH_AUDIO_BASE64_MAX`, 1,000,000 characters) is 750,000 bytes, and the messenger
/// keeps 16 kB of it for its margin (`SPEECH_RAW_BYTES_MAX`).
pub const MAX_WAV_BYTES: usize = 730_000;

const HEADER_BYTES: usize = 44;

/// The error `getUserMedia` would throw, as the messenger's `failureOf` reads it (`name: message`).
pub fn dom_error(name: &str, message: &str) -> String {
    format!("{name}: {message}")
}

/// How many samples a recording keeps at most; the rest of a longer one is dropped.
pub fn max_samples() -> usize {
    (MAX_WAV_BYTES - HEADER_BYTES) / 2
}

/// How long the caller should let a recording at `rate` run: a second short of what fits, so that
/// its own stop lands before the host's cut-off.
pub fn max_seconds(rate: u32) -> u32 {
    (max_samples() as u32 / rate.max(1)).saturating_sub(1).max(1)
}

/// A mono 16-bit PCM WAV: the 44-byte RIFF header, then the samples little-endian.
pub fn wav_bytes(samples: &[i16], rate: u32) -> Vec<u8> {
    let data = samples.len() * 2;
    let mut out = Vec::with_capacity(HEADER_BYTES + data);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // the fmt chunk's size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // bytes a second
    out.extend_from_slice(&2u16.to_le_bytes()); // bytes a frame
    out.extend_from_slice(&16u16.to_le_bytes()); // bits a sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data as u32).to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

/// A float sample in -1..1 as 16-bit PCM, clipped rather than wrapped.
pub fn to_pcm16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16
}

/// Brings a stream of mono samples from the device's rate down to `out_rate` by averaging the input
/// that falls in each output sample: crude, but it is also the low-pass that keeps the dropped
/// band from folding back into speech. Never up: an output rate above the input's is the input's.
pub struct Resampler {
    /// Output samples per input sample, at most 1.
    step: f64,
    /// How much of the output sample in progress is already filled, 0 to 1.
    phase: f64,
    sum: f64,
    out_rate: u32,
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let in_rate = in_rate.max(1);
        let out_rate = out_rate.clamp(1, in_rate);
        Self { step: f64::from(out_rate) / f64::from(in_rate), phase: 0.0, sum: 0.0, out_rate }
    }

    /// The rate the samples come out at.
    pub fn out_rate(&self) -> u32 {
        self.out_rate
    }

    /// One input sample in; an output sample when it completes one.
    pub fn push(&mut self, x: f32) -> Option<f32> {
        let x = f64::from(x);
        let room = 1.0 - self.phase;
        if self.step < room - 1e-12 {
            self.sum += x * self.step;
            self.phase += self.step;
            return None;
        }
        let out = self.sum + x * room;
        let rest = self.step - room;
        self.sum = x * rest;
        self.phase = rest;
        Some(out as f32)
    }
}

/// The level of the last ~100 ms: the RMS of each window of samples, published when the window is
/// full, so a button polling a few times a second sees a steady figure.
pub struct LevelMeter {
    window: usize,
    count: usize,
    sum_squares: f64,
    last: f32,
}

impl LevelMeter {
    /// A meter for samples at `rate`.
    pub fn new(rate: u32) -> Self {
        Self { window: (rate as usize / 10).max(1), count: 0, sum_squares: 0.0, last: 0.0 }
    }

    /// One sample in; the new 0..1 level when it completed a window.
    pub fn push(&mut self, x: f32) -> Option<f32> {
        self.sum_squares += f64::from(x) * f64::from(x);
        self.count += 1;
        if self.count < self.window {
            return None;
        }
        let rms = (self.sum_squares / self.count as f64).sqrt();
        self.count = 0;
        self.sum_squares = 0.0;
        self.last = level_of(db_of(rms)) as f32;
        Some(self.last)
    }
}

/// An RMS (0..1 of full scale) in decibels; silence is far below the floor of `level_of`.
pub fn db_of(rms: f64) -> f64 {
    if rms <= 1e-9 { -180.0 } else { 20.0 * rms.log10() }
}

/// −50 dB and quieter is silence, 0 dB full; the mapping the Mac's recorder uses.
pub fn level_of(db: f64) -> f64 {
    ((db + 50.0) / 50.0).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u32_at(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    #[test]
    fn the_wav_is_a_mono_16_bit_riff_with_the_samples_after_the_header() {
        assert_eq!(MIME, "audio/wav");
        let wav = wav_bytes(&[0, 1, -1, i16::MAX, i16::MIN], 11_025);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32_at(&wav, 4) as usize, wav.len() - 8);
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u32_at(&wav, 16), 16);
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1, "PCM");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1, "mono");
        assert_eq!(u32_at(&wav, 24), 11_025);
        assert_eq!(u32_at(&wav, 28), 22_050, "bytes a second");
        assert_eq!(u16::from_le_bytes([wav[32], wav[33]]), 2, "bytes a frame");
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16, "bits a sample");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32_at(&wav, 40), 10);
        assert_eq!(wav.len(), 44 + 10);
        assert_eq!(i16::from_le_bytes([wav[44 + 6], wav[44 + 7]]), i16::MAX);
        assert_eq!(i16::from_le_bytes([wav[44 + 8], wav[44 + 9]]), i16::MIN);
    }

    #[test]
    fn an_empty_recording_is_still_a_valid_header() {
        let wav = wav_bytes(&[], 16_000);
        assert_eq!(wav.len(), 44);
        assert_eq!(u32_at(&wav, 40), 0);
    }

    #[test]
    fn the_longest_recording_fits_what_the_daemon_takes() {
        let full = wav_bytes(&vec![0; max_samples()], TARGET_RATE);
        assert!(full.len() <= MAX_WAV_BYTES);
        // Base64 grows by a third, rounded up to four characters.
        assert!(full.len().div_ceil(3) * 4 < 1_000_000);
        // The length the caller is told is inside it, with a second to spare.
        let told = max_seconds(TARGET_RATE) as usize;
        assert!(told * TARGET_RATE as usize + TARGET_RATE as usize <= max_samples());
        assert!(told >= 30);
    }

    #[test]
    fn pcm_clips_instead_of_wrapping() {
        assert_eq!(to_pcm16(0.0), 0);
        assert_eq!(to_pcm16(1.0), i16::MAX);
        assert_eq!(to_pcm16(-1.0), -i16::MAX);
        assert_eq!(to_pcm16(3.0), i16::MAX);
        assert_eq!(to_pcm16(-3.0), -i16::MAX);
    }

    #[test]
    fn a_resampler_gives_the_rate_ratio_and_the_average() {
        let mut down = Resampler::new(44_100, 11_025);
        let out: Vec<f32> = (0..4410).filter_map(|_| down.push(0.5)).collect();
        assert_eq!(out.len(), 1102, "a tenth of a second at 11.025 kHz");
        assert!(out.iter().all(|v| (v - 0.5).abs() < 1e-5));

        // A ratio that is not whole still comes out at the ratio over a long run.
        let mut down = Resampler::new(48_000, 11_025);
        let count = (0..48_000).filter_map(|_| down.push(0.25)).count();
        assert!((count as i64 - 11_025).abs() <= 1, "{count}");

        // The average is the low-pass: a Nyquist-rate wiggle averages out.
        let mut down = Resampler::new(22_050, 11_025);
        let out: Vec<f32> = (0..200).filter_map(|i| down.push(if i % 2 == 0 { 1.0 } else { -1.0 })).collect();
        assert!(out.iter().all(|v| v.abs() < 1e-5));
    }

    #[test]
    fn a_slower_device_keeps_its_own_rate() {
        let mut same = Resampler::new(8_000, 11_025);
        assert_eq!(same.out_rate(), 8_000);
        let out: Vec<f32> = (0..100).filter_map(|i| same.push(i as f32)).collect();
        assert_eq!(out.len(), 100);
        assert_eq!(out[7], 7.0);
    }

    #[test]
    fn the_level_maps_decibels_onto_the_buttons_range() {
        assert_eq!(level_of(-160.0), 0.0);
        assert_eq!(level_of(-50.0), 0.0);
        assert!((level_of(-25.0) - 0.5).abs() < 1e-9);
        assert_eq!(level_of(0.0), 1.0);
        assert_eq!(level_of(3.0), 1.0);
        assert_eq!(db_of(0.0), -180.0);
        assert!((db_of(1.0)).abs() < 1e-9);
        assert!((db_of(0.1) + 20.0).abs() < 1e-9);
    }

    #[test]
    fn the_meter_publishes_the_rms_of_each_tenth_of_a_second() {
        let mut meter = LevelMeter::new(10_000);
        let mut levels = Vec::new();
        for _ in 0..3000 {
            levels.extend(meter.push(0.1)); // 0.1 RMS is -20 dB: 0.6
        }
        assert_eq!(levels.len(), 3);
        assert!(levels.iter().all(|l| (l - 0.6).abs() < 1e-4));
        let silent: Vec<f32> = (0..1000).filter_map(|_| meter.push(0.0)).collect();
        assert_eq!(silent, vec![0.0]);
    }

    #[test]
    fn errors_read_as_the_dom_names_the_messenger_maps() {
        assert_eq!(dom_error("NotAllowedError", "x"), "NotAllowedError: x");
    }
}
