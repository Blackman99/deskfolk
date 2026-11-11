//! Voice input's recording. NSH 0.4 has no microphone for an app (its `Speech` recognises with the
//! system's recogniser, not the speech service the person chose), and the desktop engine has no
//! `MediaRecorder`; the messenger's recorder (`chat/voice-recorder.ts`) runs on the web's. So the
//! shell records — AAC in an `.m4a`, what WebKit's `MediaRecorder` gives Safari as `audio/mp4` — and
//! `app/src/platform/media.ts` puts `getUserMedia` and `MediaRecorder` over these calls:
//!
//! - `shell.record.start`: asks for the microphone the first time, then records. Rejects with
//!   `NotAllowedError` / `NotFoundError` as `getUserMedia` would.
//! - `shell.record.level`: the input level now, 0 to 1, for the button to breathe with.
//! - `shell.record.stop`: stops, answers `{ data: base64, mime: "audio/mp4", seconds }`, and deletes
//!   the file.
//! - `shell.record.cancel`: stops and deletes; nothing is kept.
//!
//! One recording at a time, on the main thread (AVAudioRecorder is not thread-safe here).

use std::cell::RefCell;
use std::path::PathBuf;
use std::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2::{AnyThread, MainThreadMarker};
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
use objc2_avf_audio::{AVAudioRecorder, AVEncoderBitRateKey, AVFormatIDKey, AVNumberOfChannelsKey, AVSampleRateKey};
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};
use serde_json::{Value, json};

/// `kAudioFormatMPEG4AAC`, the four characters `aac `.
const AAC: u32 = u32::from_be_bytes(*b"aac ");
/// What the messenger asks of a browser's recorder (`BITS_PER_SECOND` in voice-recorder.ts).
const BITS_PER_SECOND: i32 = 32_000;
const SAMPLE_RATE: f64 = 16_000.0;

struct Recording {
    recorder: Retained<AVAudioRecorder>,
    path: PathBuf,
    started: Instant,
}

thread_local! {
    static CURRENT: RefCell<Option<Recording>> = const { RefCell::new(None) };
}

/// The error `getUserMedia` would throw, as the messenger's `failureOf` reads it (`name: message`).
fn dom_error(name: &str, message: &str) -> String {
    format!("{name}: {message}")
}

fn temp_path() -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    std::env::temp_dir().join(format!("deskfolk-voice-{}-{nanos}.m4a", std::process::id()))
}

fn begin(_mtm: MainThreadMarker) -> Result<(), String> {
    cancel_current();
    let path = temp_path();
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    // SAFETY: AVFoundation's settings keys are static NSStrings, present on every macOS we run on.
    let keys: [&NSString; 4] = unsafe {
        [
            AVFormatIDKey.ok_or("no AVFormatIDKey")?,
            AVSampleRateKey.ok_or("no AVSampleRateKey")?,
            AVNumberOfChannelsKey.ok_or("no AVNumberOfChannelsKey")?,
            AVEncoderBitRateKey.ok_or("no AVEncoderBitRateKey")?,
        ]
    };
    let number = |n: Retained<NSNumber>| -> Retained<AnyObject> { Retained::into_super(Retained::into_super(n)).into() };
    let values: [Retained<AnyObject>; 4] = [
        number(NSNumber::new_u32(AAC)),
        number(NSNumber::new_f64(SAMPLE_RATE)),
        number(NSNumber::new_i32(1)),
        number(NSNumber::new_i32(BITS_PER_SECOND)),
    ];
    let value_refs: Vec<&AnyObject> = values.iter().map(|v| &**v).collect();
    let settings = NSDictionary::from_slices(&keys, &value_refs);
    // SAFETY: the settings hold the types AVAudioRecorder documents for these keys.
    let recorder = unsafe { AVAudioRecorder::initWithURL_settings_error(AVAudioRecorder::alloc(), &url, &settings) }
        .map_err(|e| dom_error("NotFoundError", &e.localizedDescription().to_string()))?;
    // SAFETY: a recorder made above, used on the main thread only.
    unsafe {
        recorder.setMeteringEnabled(true);
        if !recorder.prepareToRecord() || !recorder.record() {
            return Err(dom_error("NotFoundError", "the microphone could not start recording"));
        }
    }
    CURRENT.with_borrow_mut(|current| *current = Some(Recording { recorder, path, started: Instant::now() }));
    Ok(())
}

/// `shell.record.start`: the microphone's permission first (asked once), then recording.
pub fn start(mtm: MainThreadMarker, answer: impl FnOnce(Result<(), String>) + 'static) {
    // SAFETY: a static NSString of AVFoundation.
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
        answer(Err(dom_error("NotFoundError", "no audio media type")));
        return;
    };
    // SAFETY: AVCaptureDevice's class method, on the main thread.
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) };
    match status {
        AVAuthorizationStatus::Authorized => answer(begin(mtm)),
        AVAuthorizationStatus::NotDetermined => {
            let answer = RefCell::new(Some(answer));
            let asked = RcBlock::new(move |granted: Bool| {
                let Some(answer) = answer.borrow_mut().take() else { return };
                let granted = granted.as_bool();
                // The completion runs on an arbitrary queue: back to the main one to record.
                let answer = std::sync::Mutex::new(Some(answer));
                let send = SendBox(answer);
                dispatch2::DispatchQueue::main().exec_async(move || {
                    let send = send;
                    let Some(answer) = send.0.lock().ok().and_then(|mut a| a.take()) else { return };
                    let mtm = MainThreadMarker::new().expect("the main queue");
                    if granted {
                        answer(begin(mtm));
                    } else {
                        answer(Err(dom_error("NotAllowedError", "the microphone was not allowed")));
                    }
                });
            });
            // SAFETY: as above; the block lives as long as AVFoundation needs it.
            unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &asked) };
        }
        _ => answer(Err(dom_error("NotAllowedError", "the microphone is not allowed for Deskfolk Dev"))),
    }
}

/// Carries the main-thread-only answer through `exec_async`, which runs it on the main queue.
struct SendBox<T>(T);
// SAFETY: the contents are only touched on the main queue, inside the closure `exec_async` runs.
unsafe impl<T> Send for SendBox<T> {}

/// `shell.record.level`: the average power now, mapped from decibels to 0..1.
pub fn level() -> f64 {
    CURRENT.with_borrow(|current| {
        current.as_ref().map_or(0.0, |r| {
            // SAFETY: the recorder, on the main thread.
            let db = unsafe {
                r.recorder.updateMeters();
                r.recorder.averagePowerForChannel(0)
            };
            level_of(f64::from(db))
        })
    })
}

/// −50 dB and quieter is silence, 0 dB full.
pub fn level_of(db: f64) -> f64 {
    ((db + 50.0) / 50.0).clamp(0.0, 1.0)
}

/// `shell.record.stop`: the recording's bytes, then the file is gone.
pub fn stop() -> Result<Value, String> {
    let Some(recording) = CURRENT.with_borrow_mut(Option::take) else {
        return Err(dom_error("InvalidStateError", "not recording"));
    };
    // SAFETY: the recorder, on the main thread.
    unsafe { recording.recorder.stop() };
    let seconds = recording.started.elapsed().as_secs_f64();
    let bytes = std::fs::read(&recording.path).map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&recording.path);
    let bytes = bytes?;
    Ok(json!({ "data": B64.encode(&bytes), "mime": "audio/mp4", "seconds": seconds }))
}

fn cancel_current() {
    if let Some(recording) = CURRENT.with_borrow_mut(Option::take) {
        // SAFETY: the recorder, on the main thread.
        unsafe {
            recording.recorder.stop();
            recording.recorder.deleteRecording();
        }
        let _ = std::fs::remove_file(&recording.path);
    }
}

/// `shell.record.cancel`: nothing kept. Quietly nothing when not recording.
pub fn cancel() {
    cancel_current();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_level_maps_decibels_onto_the_buttons_range() {
        assert_eq!(level_of(-160.0), 0.0);
        assert_eq!(level_of(-50.0), 0.0);
        assert!((level_of(-25.0) - 0.5).abs() < 1e-9);
        assert_eq!(level_of(0.0), 1.0);
        assert_eq!(level_of(3.0), 1.0);
    }

    #[test]
    fn errors_read_as_the_dom_names_the_messenger_maps() {
        assert!(dom_error("NotAllowedError", "x").starts_with("NotAllowedError: "));
    }

    #[test]
    fn aac_is_the_four_characters() {
        assert_eq!(AAC, 0x6161_6320);
    }
}
