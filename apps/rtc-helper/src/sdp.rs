//! What an acceptable offer looks like: one data-channel section and nothing else. The phone
//! never sends audio or video here, so an offer asking for either is refused before it reaches
//! the WebRTC stack.

pub fn check_offer(sdp: &str) -> Result<(), &'static str> {
    let media: Vec<&str> = sdp
        .lines()
        .map(str::trim_end)
        .filter(|line| line.starts_with("m="))
        .collect();
    match media.as_slice() {
        [only] if only.starts_with("m=application ") && only.contains("webrtc-datachannel") => {
            Ok(())
        }
        [] => Err("offer has no data channel"),
        [_] => Err("offer's only section is not a data channel"),
        _ => Err("offer has more than one media section"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DATA: &str = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\n";

    #[test]
    fn accepts_a_lone_data_channel() {
        assert_eq!(check_offer(DATA), Ok(()));
    }

    #[test]
    fn refuses_media_and_extra_sections() {
        let video = DATA.replace(
            "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
            "m=video 9 UDP/TLS/RTP/SAVPF 96",
        );
        assert!(check_offer(&video).is_err());
        let both = format!("{DATA}m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n");
        assert!(check_offer(&both).is_err());
        assert!(check_offer("v=0\r\n").is_err());
    }
}
