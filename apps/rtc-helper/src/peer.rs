//! Answers the phone's offer and, once its one `rfb` data channel opens, carries bytes between
//! that channel and the local Screen Sharing socket until either side goes away.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use bytes::BytesMut;
use rtc::ice::mdns::MulticastDnsMode;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
    RTCIceGatheringState, RTCIceServer, RTCPeerConnectionState, RTCSessionDescription,
    SettingEngineBuilder,
};

use crate::output::Output;
use crate::protocol::Offer;

/// The only label the phone opens; anything else is closed unanswered.
pub const CHANNEL_LABEL: &str = "rfb";
/// One read from the Screen Sharing socket per channel message. Under the 16 KiB a browser is
/// sure to accept in one message.
const CHUNK: usize = 16 * 1024;
/// Bytes handed to SCTP and not yet acknowledged before `send` waits — which stops the socket
/// reads, which lets TCP push back on screensharingd. The screen never outruns the phone's link.
const SEND_BUFFER_LIMIT: usize = 1024 * 1024;
/// How often the daemon hears how much has gone through.
const STATS_EVERY: Duration = Duration::from_secs(2);

pub struct Options {
    pub udp_addrs: Vec<String>,
    pub include_loopback: bool,
    pub target: SocketAddr,
    pub gather_timeout: Duration,
}

impl Options {
    /// Every interface of both families, so a phone on the same Wi-Fi or with IPv6 can reach the
    /// Mac directly; the server-reflexive candidates come from the Mac's own STUN settings.
    pub fn production(target: SocketAddr) -> Self {
        Self {
            udp_addrs: vec!["0.0.0.0:0".into(), "[::]:0".into()],
            include_loopback: false,
            target,
            gather_timeout: Duration::from_secs(5),
        }
    }
}

pub struct Peer {
    connection: Box<dyn PeerConnection>,
    pub answer: String,
    done: mpsc::Receiver<()>,
}

impl Peer {
    /// Resolves when the connection failed or closed, or the channel or the socket ended.
    pub async fn finished(&mut self) {
        let _ = self.done.recv().await;
    }

    pub async fn close(self) {
        let _ = self.connection.close().await;
    }
}

struct Handler {
    gathered: mpsc::Sender<()>,
    done: mpsc::Sender<()>,
    claimed: AtomicBool,
    target: SocketAddr,
    output: Output,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathered.try_send(());
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        self.output.state(&state.to_string()).await;
        if matches!(
            state,
            RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
        ) {
            let _ = self.done.try_send(());
        }
    }

    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        // Spawned, never awaited here: the driver that called us is what moves the channel along.
        if self.claimed.swap(true, Ordering::SeqCst) {
            tokio::spawn(async move {
                let _ = channel.close().await;
            });
            return;
        }
        tokio::spawn(bridge(
            channel,
            self.target,
            self.done.clone(),
            self.output.clone(),
        ));
    }
}

pub async fn answer(offer: Offer, options: Options, output: Output) -> Result<Peer, String> {
    let (gathered_tx, mut gathered_rx) = mpsc::channel(1);
    let (done_tx, done_rx) = mpsc::channel(4);
    let ice_servers = offer
        .ice_servers
        .into_iter()
        .map(|server| RTCIceServer {
            urls: server.urls,
            username: server.username,
            credential: server.credential,
        })
        .collect();
    // Android Chrome names its LAN candidates `<uuid>.local`; querying those is what makes a
    // same-Wi-Fi connection possible without any STUN at all. Never announce our own that way.
    let settings = SettingEngineBuilder::new()
        .with_multicast_dns_mode(MulticastDnsMode::QueryOnly)
        .with_multicast_dns_timeout(Some(Duration::from_secs(3)))
        .with_include_loopback_candidate(options.include_loopback)
        .build();
    let connection = PeerConnectionBuilder::new()
        .with_configuration(
            RTCConfigurationBuilder::new()
                .with_ice_servers(ice_servers)
                .build(),
        )
        .with_setting_engine(settings)
        .with_handler(Arc::new(Handler {
            gathered: gathered_tx,
            done: done_tx,
            claimed: AtomicBool::new(false),
            target: options.target,
            output,
        }))
        .with_udp_addrs(options.udp_addrs)
        .with_data_channel_send_buffer_limit(SEND_BUFFER_LIMIT)
        .build()
        .await
        .map_err(|error| error.to_string())?;
    let connection: Box<dyn PeerConnection> = Box::new(connection);
    let offer = RTCSessionDescription::offer(offer.sdp).map_err(|error| error.to_string())?;
    connection
        .set_remote_description(offer)
        .await
        .map_err(|error| error.to_string())?;
    let answer = connection
        .create_answer(None)
        .await
        .map_err(|error| error.to_string())?;
    connection
        .set_local_description(answer)
        .await
        .map_err(|error| error.to_string())?;
    // Non-trickle: the answer goes back in one reply, with whatever was gathered by the deadline.
    let _ = tokio::time::timeout(options.gather_timeout, gathered_rx.recv()).await;
    let answer = connection
        .local_description()
        .await
        .ok_or("no local description")?
        .sdp;
    Ok(Peer {
        connection,
        answer,
        done: done_rx,
    })
}

async fn bridge(
    channel: Arc<dyn DataChannel>,
    target: SocketAddr,
    done: mpsc::Sender<()>,
    output: Output,
) {
    let finish = |done: &mpsc::Sender<()>| {
        let _ = done.try_send(());
    };
    if channel.label().await.ok().as_deref() != Some(CHANNEL_LABEL) {
        let _ = channel.close().await;
        return;
    }
    loop {
        match channel.poll().await {
            Some(DataChannelEvent::OnOpen) => break,
            Some(DataChannelEvent::OnClose) | None => return finish(&done),
            _ => {}
        }
    }
    let stream = match TcpStream::connect(target).await {
        Ok(stream) => stream,
        Err(error) => {
            output
                .error("screen_sharing_unreachable", error.to_string())
                .await;
            let _ = channel.close().await;
            return finish(&done);
        }
    };
    let _ = stream.set_nodelay(true);
    output.state("open").await;
    let (mut socket_in, mut socket_out) = stream.into_split();
    let sender = channel.clone();
    let channel_for_mac = channel.clone();
    let sent = Arc::new(AtomicU64::new(0));
    let received = Arc::new(AtomicU64::new(0));
    let sent_count = sent.clone();
    let to_phone = async move {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match socket_in.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if sender.send(BytesMut::from(&buf[..n])).await.is_err() {
                        break;
                    }
                    sent_count.fetch_add(n as u64, Ordering::Relaxed);
                }
            }
        }
    };
    let received_count = received.clone();
    let to_mac = async move {
        while let Some(event) = channel_for_mac.poll().await {
            match event {
                DataChannelEvent::OnMessage(message) => {
                    if socket_out.write_all(&message.data).await.is_err() {
                        break;
                    }
                    received_count.fetch_add(message.data.len() as u64, Ordering::Relaxed);
                }
                DataChannelEvent::OnClose => break,
                _ => {}
            }
        }
    };
    // What has gone through, for the window's settings card while the session lasts.
    let report = async {
        let mut tick = tokio::time::interval(STATS_EVERY);
        loop {
            tick.tick().await;
            output
                .stats(
                    sent.load(Ordering::Relaxed),
                    received.load(Ordering::Relaxed),
                )
                .await;
        }
    };
    tokio::select! {
        _ = to_phone => {}
        _ = to_mac => {}
        _ = report => {}
    }
    let _ = channel.close().await;
    finish(&done);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use webrtc::data_channel::DataChannelEvent;

    struct Gathered(mpsc::Sender<()>);

    #[async_trait::async_trait]
    impl PeerConnectionEventHandler for Gathered {
        async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
            if state == RTCIceGatheringState::Complete {
                let _ = self.0.try_send(());
            }
        }
    }

    /// A phone's side in process: offers one `rfb` channel, and the helper's answer carries it to
    /// a local socket that greets like Screen Sharing and echoes what it is sent.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bridges_the_rfb_channel_to_the_local_socket_both_ways() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket.write_all(b"RFB 003.889\n").await.unwrap();
            let mut buf = [0u8; 64];
            let n = socket.read(&mut buf).await.unwrap();
            socket.write_all(&buf[..n]).await.unwrap();
            tokio::time::sleep(Duration::from_secs(10)).await;
        });

        let (gathered_tx, mut gathered_rx) = mpsc::channel(1);
        let settings = SettingEngineBuilder::new()
            .with_include_loopback_candidate(true)
            .build();
        let phone = PeerConnectionBuilder::new()
            .with_configuration(RTCConfigurationBuilder::new().build())
            .with_setting_engine(settings)
            .with_handler(Arc::new(Gathered(gathered_tx)))
            .with_udp_addrs(vec!["127.0.0.1:0".to_string()])
            .build()
            .await
            .unwrap();
        let channel = phone
            .create_data_channel(CHANNEL_LABEL, None)
            .await
            .unwrap();
        let offer = phone.create_offer(None).await.unwrap();
        phone.set_local_description(offer).await.unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(5), gathered_rx.recv()).await;
        let sdp = phone.local_description().await.unwrap().sdp;
        assert_eq!(crate::sdp::check_offer(&sdp), Ok(()));

        let options = Options {
            udp_addrs: vec!["127.0.0.1:0".into()],
            include_loopback: true,
            target,
            gather_timeout: Duration::from_secs(5),
        };
        let peer = answer(
            Offer {
                sdp,
                ice_servers: vec![],
            },
            options,
            Output::new(tokio::io::sink()),
        )
        .await
        .unwrap();
        phone
            .set_remote_description(RTCSessionDescription::answer(peer.answer.clone()).unwrap())
            .await
            .unwrap();

        let mut received = Vec::new();
        let outcome = tokio::time::timeout(Duration::from_secs(15), async {
            while let Some(event) = channel.poll().await {
                match event {
                    DataChannelEvent::OnOpen => {}
                    DataChannelEvent::OnMessage(message) => {
                        received.extend_from_slice(&message.data);
                        if received == b"RFB 003.889\n" {
                            channel
                                .send(BytesMut::from(&b"RFB 003.008\n"[..]))
                                .await
                                .unwrap();
                        }
                        if received.len() >= 24 {
                            break;
                        }
                    }
                    DataChannelEvent::OnClose => break,
                    _ => {}
                }
            }
        })
        .await;
        assert!(
            outcome.is_ok(),
            "the channel never carried the greeting and the echo"
        );
        assert_eq!(received, b"RFB 003.889\nRFB 003.008\n");
        peer.close().await;
        let _ = phone.close().await;
    }
}
