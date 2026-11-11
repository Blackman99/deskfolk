//! How long drawing takes: every two seconds with frames in them, one log line (target
//! `deskfolk_native_terminal::perf`) with the count, the mean, the 95th percentile and the worst.

use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Window {
    started: Instant,
    frames: Vec<Duration>,
}

static WINDOW: Mutex<Option<Window>> = Mutex::new(None);

pub fn frame(took: Duration) {
    let mut slot = WINDOW.lock().unwrap_or_else(|p| p.into_inner());
    let window = slot.get_or_insert_with(|| Window { started: Instant::now(), frames: Vec::new() });
    window.frames.push(took);
    if window.started.elapsed() >= Duration::from_secs(2) {
        let mut frames = std::mem::take(&mut window.frames);
        let seconds = window.started.elapsed().as_secs_f64();
        window.started = Instant::now();
        drop(slot);
        log::info!("{}", summary(&mut frames, seconds));
    }
}

pub fn summary(frames: &mut [Duration], seconds: f64) -> String {
    frames.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    let n = frames.len().max(1);
    let mean = frames.iter().map(|d| ms(*d)).sum::<f64>() / n as f64;
    let p95 = frames.get((n * 95 / 100).min(n - 1)).map_or(0.0, |d| ms(*d));
    let worst = frames.last().map_or(0.0, |d| ms(*d));
    format!(
        "terminal draw: {} frames in {seconds:.1}s ({:.0}/s), mean {mean:.2} ms, p95 {p95:.2} ms, max {worst:.2} ms",
        frames.len(),
        frames.len() as f64 / seconds
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn summarises_frame_times() {
        let mut frames: Vec<_> = (1..=20).map(std::time::Duration::from_millis).collect();
        let line = super::summary(&mut frames, 2.0);
        assert!(line.contains("20 frames"), "{line}");
        assert!(line.contains("max 20.00 ms"), "{line}");
    }
}
