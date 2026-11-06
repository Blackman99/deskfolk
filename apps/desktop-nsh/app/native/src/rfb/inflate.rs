//! A zlib stream whose state outlives the rects (noVNC's `Inflator`): each rect's compressed bytes
//! continue the same stream.

use miniz_oxide::inflate::stream::{InflateState, inflate};
use miniz_oxide::{DataFormat, MZError, MZFlush, MZStatus};

const CHUNK: usize = 16 * 1024;

#[derive(Default)]
pub struct Inflator {
    state: Option<Box<InflateState>>,
}

impl Inflator {
    pub fn reset(&mut self) {
        self.state = None;
    }

    /// Inflates everything `input` yields, failing past `cap` output bytes.
    pub fn inflate_all(&mut self, input: &[u8], cap: usize) -> Result<Vec<u8>, String> {
        let state = self.state.get_or_insert_with(|| InflateState::new_boxed(DataFormat::Zlib));
        let mut out = Vec::new();
        let mut pos = 0;
        loop {
            let start = out.len();
            out.resize(start + CHUNK, 0);
            let r = inflate(state, &input[pos..], &mut out[start..], MZFlush::Sync);
            out.truncate(start + r.bytes_written);
            pos += r.bytes_consumed;
            match r.status {
                Ok(MZStatus::StreamEnd) | Err(MZError::Buf) => break,
                Ok(_) => {}
                Err(e) => return Err(format!("zlib error: {e:?}")),
            }
            if out.len() > cap {
                return Err("zlib data larger than the rect allows".into());
            }
            if (pos >= input.len() && r.bytes_written < CHUNK) || (r.bytes_consumed == 0 && r.bytes_written == 0) {
                break;
            }
        }
        if out.len() > cap {
            return Err("zlib data larger than the rect allows".into());
        }
        Ok(out)
    }
}
