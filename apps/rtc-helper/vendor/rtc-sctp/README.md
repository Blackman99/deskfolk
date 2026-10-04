# rtc-sctp 0.21.0, with a 200 ms retransmission floor

This is [rtc-sctp](https://crates.io/crates/rtc-sctp) 0.21.0 from [webrtc-rs/rtc](https://github.com/webrtc-rs/rtc), MIT / Apache-2.0, as published on crates.io, with one change: `RTO_MIN` in `src/association/timer.rs` is 200 ms instead of 1000 ms. `../../Cargo.toml` puts it in place of the published crate with `[patch.crates-io]`.

**Why.** The remote screen sends the Mac's screen in bursts, one per screen update, several megabytes when a window switches. When the last packets of a burst are lost, nothing follows them to trigger a fast retransmit, so the sender waits out the retransmission timeout, and 0.21.0 never lets that drop below the one second RFC 9260 recommends; the constant is not configurable. Measured on loopback with 7.45 MB screen updates (4112×2658, ZRLE as Screen Sharing sends it), the median update took 1194 ms with the one-second floor and 240–276 ms with 200 ms. 200 ms is Linux TCP's floor; the timeout itself still follows the measured round trip, so a slow path waits longer.

**Updating.** When the webrtc crates move past 0.21.0, check whether the floor became configurable (`TimerConfig`) and drop this copy if so; otherwise copy the new release's sources here and make the same one-line change.
