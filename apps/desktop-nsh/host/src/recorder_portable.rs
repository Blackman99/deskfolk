//! Voice input's recording on Windows and Linux, the counterpart of the Mac's `recorder.rs`: the
//! same four calls under `app/src/platform/media.ts`, made with the system's default input through
//! `cpal` (WASAPI on Windows; ALSA on Linux, whose `default` device PulseAudio and PipeWire answer).
//!
//! - `shell.record.start`: opens the default input and records. Rejects with `NotFoundError` when
//!   there is no input, `NotAllowedError` when the system refuses it (Windows' microphone privacy
//!   switch, Linux's audio group), `NotReadableError` for the rest. Answers `{ mime, maxSeconds }`:
//!   the format the recording will be (Ogg/Opus, see `recorder_ogg.rs` for why) and how long the
//!   caller may let it run: the three minutes a take lasts on the Mac and in a browser.
//! - `shell.record.level`: the input level now, 0 to 1.
//! - `shell.record.stop`: stops, encodes, answers `{ data: base64, mime, seconds }`.
//! - `shell.record.cancel`: stops and drops it.
//!
//! One recording at a time. A `cpal` stream may not leave the thread that made it (WASAPI's does
//! not), so each recording has a thread of its own that opens the stream, keeps it, and drops it
//! when told to stop; the samples wait in memory (three minutes at 16 kHz is under 6 MB) and become Ogg/Opus on stop.
//! A device that fails in the middle ends the stream; the recording so far is still what `stop`
//! answers, and only an empty one answers the failure.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{ErrorKind, FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig};
use serde_json::{Value, json};

use crate::recorder_ogg::{MAX_SECONDS, MIME, encode, max_samples, opus_rate};
use crate::recorder_pcm::{LevelMeter, Resampler, dom_error, to_pcm16};

/// What the input thread and the calls share.
#[derive(Default)]
struct Shared {
    /// The recording so far, mono 16-bit at the recording's rate.
    samples: Mutex<Vec<i16>>,
    /// The first fatal error the stream reported, as the DOM-named message.
    failed: Mutex<Option<String>>,
}

struct Session {
    stop: Sender<()>,
    thread: JoinHandle<()>,
    shared: Arc<Shared>,
    rate: u32,
}

static CURRENT: Mutex<Option<Session>> = Mutex::new(None);
/// The latest level as `f32` bits; the input thread writes it, `level` reads it.
static LEVEL: AtomicU32 = AtomicU32::new(0);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The error `getUserMedia` would throw for what `cpal` reported.
fn failure(error: &cpal::Error) -> String {
    let name = match error.kind() {
        ErrorKind::PermissionDenied => "NotAllowedError",
        ErrorKind::DeviceNotAvailable | ErrorKind::HostUnavailable | ErrorKind::UnsupportedConfig | ErrorKind::UnsupportedOperation | ErrorKind::InvalidInput => {
            "NotFoundError"
        }
        _ => "NotReadableError",
    };
    dom_error(name, &error.to_string())
}

/// What one input callback does with the device's samples: down to mono, to the recording's rate,
/// into the level meter and the recording.
struct Sink {
    shared: Arc<Shared>,
    channels: usize,
    /// Most samples the recording keeps.
    room: usize,
    resampler: Resampler,
    meter: LevelMeter,
    batch: Vec<i16>,
}

impl Sink {
    fn new(shared: Arc<Shared>, channels: usize, in_rate: u32, out_rate: u32) -> Self {
        let resampler = Resampler::new(in_rate, out_rate);
        let meter = LevelMeter::new(resampler.out_rate());
        Self { shared, channels, room: max_samples(resampler.out_rate()), resampler, meter, batch: Vec::new() }
    }

    fn feed<T>(&mut self, data: &[T])
    where
        T: Sample,
        f32: FromSample<T>,
    {
        self.batch.clear();
        for frame in data.chunks(self.channels) {
            let mono = frame.iter().map(|&s| f32::from_sample(s)).sum::<f32>() / frame.len() as f32;
            let Some(out) = self.resampler.push(mono) else { continue };
            if let Some(level) = self.meter.push(out) {
                LEVEL.store(level.to_bits(), Ordering::Relaxed);
            }
            self.batch.push(to_pcm16(out));
        }
        // Past the most a recording lasts the rest is dropped; the caller has been told to stop.
        let mut samples = locked(&self.shared.samples);
        let room = self.room.saturating_sub(samples.len());
        samples.extend(self.batch.iter().take(room));
    }
}

fn build<T>(device: &cpal::Device, config: StreamConfig, mut sink: Sink, shared: Arc<Shared>) -> Result<Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device.build_input_stream(
        config,
        move |data: &[T], _: &_| sink.feed(data),
        move |error: cpal::Error| {
            // A rerouted or glitching stream goes on; anything else has ended it.
            if matches!(error.kind(), ErrorKind::DeviceChanged | ErrorKind::Xrun | ErrorKind::RealtimeDenied) {
                return;
            }
            log::warn!("voice input: the stream failed: {error}");
            locked(&shared.failed).get_or_insert_with(|| failure(&error));
        },
        None,
    )
}

/// Opens the default input in its own format and starts it; answers the rate the recording has.
fn open(shared: &Arc<Shared>) -> Result<(Stream, u32), String> {
    let device = cpal::default_host().default_input_device().ok_or_else(|| dom_error("NotFoundError", "no microphone was found"))?;
    let supported = device.default_input_config().map_err(|e| failure(&e))?;
    let channels = usize::from(supported.channels().max(1));
    // A device under 8 kHz has nothing Opus takes; none is met in practice.
    let out_rate = opus_rate(supported.sample_rate())
        .ok_or_else(|| dom_error("NotReadableError", &format!("the microphone records at {} Hz, too slow for speech", supported.sample_rate())))?;
    let sink = Sink::new(shared.clone(), channels, supported.sample_rate(), out_rate);
    let rate = sink.resampler.out_rate();
    let format = supported.sample_format();
    let config: StreamConfig = supported.into();
    let (device, shared) = (&device, shared.clone());
    let stream = match format {
        SampleFormat::I8 => build::<i8>(device, config, sink, shared),
        SampleFormat::I16 => build::<i16>(device, config, sink, shared),
        SampleFormat::I32 => build::<i32>(device, config, sink, shared),
        SampleFormat::U8 => build::<u8>(device, config, sink, shared),
        SampleFormat::U16 => build::<u16>(device, config, sink, shared),
        SampleFormat::U32 => build::<u32>(device, config, sink, shared),
        SampleFormat::F32 => build::<f32>(device, config, sink, shared),
        SampleFormat::F64 => build::<f64>(device, config, sink, shared),
        other => return Err(dom_error("NotReadableError", &format!("the microphone records in {other}, which is not read here"))),
    }
    .map_err(|e| failure(&e))?;
    stream.play().map_err(|e| failure(&e))?;
    Ok((stream, rate))
}

/// The recording's thread: opens the stream, says how that went, and keeps it until told to stop.
fn capture(shared: Arc<Shared>, ready: Sender<Result<u32, String>>, stop: Receiver<()>) {
    let stream = match open(&shared) {
        Ok((stream, rate)) => {
            let _ = ready.send(Ok(rate));
            stream
        }
        Err(why) => {
            let _ = ready.send(Err(why));
            return;
        }
    };
    // A message, or the sender going away, ends it.
    let _ = stop.recv();
    drop(stream);
}

/// Ends a session's thread and hands back what it recorded.
fn end(session: Session) -> Arc<Shared> {
    let _ = session.stop.send(());
    let _ = session.thread.join();
    LEVEL.store(0, Ordering::Relaxed);
    session.shared
}

/// `shell.record.start`. Waits on the system (a first use can take a moment), so it runs on a
/// thread of its own, not the engine's.
pub fn start() -> Result<Value, String> {
    let mut current = locked(&CURRENT);
    if let Some(old) = current.take() {
        end(old);
    }
    let shared = Arc::new(Shared::default());
    let (ready_tx, ready_rx) = mpsc::channel();
    let (stop_tx, stop_rx) = mpsc::channel();
    let worker = shared.clone();
    let thread = std::thread::Builder::new()
        .name("voice-record".into())
        .spawn(move || capture(worker, ready_tx, stop_rx))
        .map_err(|e| dom_error("NotReadableError", &e.to_string()))?;
    match ready_rx.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(rate)) => {
            *current = Some(Session { stop: stop_tx, thread, shared, rate });
            Ok(json!({ "mime": MIME, "maxSeconds": MAX_SECONDS }))
        }
        Ok(Err(why)) => {
            let _ = thread.join();
            Err(why)
        }
        Err(_) => {
            // Never answered (or the thread died): let it go whenever it comes back.
            let _ = stop_tx.send(());
            Err(dom_error("NotReadableError", "the microphone did not start"))
        }
    }
}

/// `shell.record.level`: the last tenth of a second's level, 0 to 1.
pub fn level() -> f64 {
    f64::from(f32::from_bits(LEVEL.load(Ordering::Relaxed)))
}

/// `shell.record.stop`: the recording as Ogg/Opus, base64. Encoding three minutes takes a fraction
/// of a second.
pub fn stop() -> Result<Value, String> {
    let Some(session) = locked(&CURRENT).take() else {
        return Err(dom_error("InvalidStateError", "not recording"));
    };
    let rate = session.rate;
    let shared = end(session);
    let samples = std::mem::take(&mut *locked(&shared.samples));
    if samples.is_empty() {
        if let Some(why) = locked(&shared.failed).take() {
            return Err(why);
        }
    }
    let seconds = samples.len() as f64 / f64::from(rate);
    let file = encode(&samples, rate).map_err(|why| dom_error("NotReadableError", &why))?;
    Ok(json!({ "data": B64.encode(file), "mime": MIME, "seconds": seconds }))
}

/// `shell.record.cancel`: nothing kept. Quietly nothing when not recording.
pub fn cancel() {
    if let Some(session) = locked(&CURRENT).take() {
        end(session);
    }
}
