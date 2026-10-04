//! `real-bot-rtc`: one remote-screen connection from a paired phone, per process.
//!
//! The daemon starts it when the phone asks for a direct connection, writes the phone's offer
//! (which came over the end-to-end encrypted remote link, so its DTLS fingerprint is the paired
//! device's) and reads back the answer. When the phone's `rfb` channel opens, the helper connects
//! to the RFB server on 127.0.0.1:5900 — macOS Screen Sharing, or on Windows the VNC server the
//! user installed — and carries bytes both ways. It never connects anywhere else: the port is not
//! a parameter. stdin closing — the daemon stopping the session, or the daemon dying — ends the
//! process.
//!
//! The binary has two other jobs, each its own subcommand: `display-hold`, the Mac's display at a
//! lower resolution while a phone has the remote screen in smooth mode (see display.rs), and
//! `stay-awake`, a Windows PC's display and sleep held off while a phone is connected (awake.rs).

mod awake;
mod display;
mod output;
mod peer;
mod protocol;
mod sdp;

use std::net::{Ipv4Addr, SocketAddr};

use output::Output;
use protocol::Command;

/// macOS Screen Sharing (and Remote Management) listen here, and so does a Windows VNC server.
const SCREEN_SHARING_PORT: u16 = 5900;

fn target() -> SocketAddr {
    // Development builds can be pointed at a fake RFB server for the end-to-end tests; a release
    // build has no way to reach anything but Screen Sharing.
    #[cfg(debug_assertions)]
    if let Some(port) = std::env::var("REAL_BOT_RTC_TARGET_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        return SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    }
    SocketAddr::from((Ipv4Addr::LOCALHOST, SCREEN_SHARING_PORT))
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("display-hold") => std::process::exit(display::hold()),
        Some("stay-awake") => std::process::exit(awake::stay_awake()),
        _ => {}
    }
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(connect());
}

async fn connect() {
    let mut stdin = tokio::io::stdin();
    let output = Output::stdout(tokio::io::stdout());
    let offer = loop {
        match protocol::read_command(&mut stdin).await {
            Command::Offer(offer) => break offer,
            Command::Ignored => continue,
            Command::Close | Command::EndOfStream => return,
        }
    };
    if let Err(reason) = sdp::check_offer(&offer.sdp) {
        output.error("bad_offer", reason.into()).await;
        return;
    }
    let mut peer =
        match peer::answer(offer, peer::Options::production(target()), output.clone()).await {
            Ok(peer) => peer,
            Err(message) => {
                output.error("answer_failed", message).await;
                return;
            }
        };
    output.answer(&peer.answer).await;
    let until_told = async {
        loop {
            match protocol::read_command(&mut stdin).await {
                Command::Close | Command::EndOfStream => break,
                _ => {}
            }
        }
    };
    tokio::select! {
        _ = until_told => {}
        _ = peer.finished() => {}
    }
    peer.close().await;
    output.state("closed").await;
}
