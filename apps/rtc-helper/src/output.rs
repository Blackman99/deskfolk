//! stdout, shared by the main loop and the connection's event handler. Each frame goes out whole.

use std::sync::Arc;

use tokio::io::{AsyncWrite, Stdout};
use tokio::sync::Mutex;

use crate::protocol::{self, Answer, Failure, State, Stats};

#[derive(Clone)]
pub struct Output(Arc<Mutex<Box<dyn AsyncWrite + Send + Unpin>>>);

impl Output {
    pub fn stdout(stdout: Stdout) -> Self {
        Self::new(stdout)
    }

    pub fn new<W: AsyncWrite + Send + Unpin + 'static>(writer: W) -> Self {
        Self(Arc::new(Mutex::new(Box::new(writer))))
    }

    pub async fn answer(&self, sdp: &str) {
        self.write(protocol::TYPE_ANSWER, &Answer { sdp }).await;
    }

    pub async fn state(&self, state: &str) {
        self.write(protocol::TYPE_STATE, &State { state }).await;
    }

    pub async fn stats(&self, to_phone: u64, from_phone: u64) {
        self.write(
            protocol::TYPE_STATS,
            &Stats {
                to_phone,
                from_phone,
            },
        )
        .await;
    }

    pub async fn error(&self, code: &str, message: String) {
        self.write(protocol::TYPE_ERROR, &Failure { code, message })
            .await;
    }

    async fn write<T: serde::Serialize>(&self, frame_type: u8, value: &T) {
        // A daemon that stopped reading is a daemon that is gone; stdin's EOF ends us shortly.
        let _ = protocol::write_frame(&mut *self.0.lock().await, frame_type, value).await;
    }
}
