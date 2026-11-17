//! Voice input's recording on Windows and Linux as Ogg/Opus (RFC 7845): the Opus encoder and the
//! Ogg muxing, kept apart from the device (`recorder_portable.rs`) so every desktop tests them.
//!
//! Why Opus: the shell has no AAC here, and a WAV of a take is too big. The daemon takes at most
//! `SPEECH_AUDIO_BASE64_MAX` characters of base64 per recording (about 750 kB of audio), and
//! speech at 24 kbps is 3 kB a second, so a take can last the full `SPEECH_MAX_SECONDS`, as it does
//! on the Mac and in a browser. Every speech format the daemon speaks takes Ogg
//! (`apps/daemon/src/speech.ts`: OpenAI and ElevenLabs by the `speech.ogg` file name, MiMo and
//! Deepgram as it is, Qwen and DashScope by `format`).

use ogg::writing::{PacketWriteEndInfo, PacketWriter};
use opus::{Application, Bitrate, Channels, Encoder};

/// What the messenger is told the recording is.
pub const MIME: &str = "audio/ogg;codecs=opus";

/// How long a recording may run: the messenger's own limit (`SPEECH_MAX_SECONDS` in
/// `packages/protocol/src/speech.ts`), which is also what the caller is told.
pub const MAX_SECONDS: u32 = 180;

/// The rate Opus is fed at when the device allows: wideband speech, which is also what the
/// transcription services resample to.
pub const TARGET_RATE: u32 = 16_000;

/// The bitrate: plenty for wideband speech in VOIP mode, and 3 kB a second.
const BITRATE: i32 = 24_000;

/// The most an Ogg file may be: the daemon's limit on the base64 of a recording
/// (`SPEECH_AUDIO_BASE64_MAX`, 1,000,000 characters) is 750,000 bytes, and the messenger keeps
/// 16 kB of it for its margin (`SPEECH_RAW_BYTES_MAX`).
pub const MAX_BYTES: usize = 730_000;

/// The most one Opus packet can be (RFC 6716).
const MAX_PACKET: usize = 1275;

/// Ogg ties a file's pages together by this; any value will do for a file of one stream.
const SERIAL: u32 = 0x4465_736b;

/// The rate Opus takes that a device at `in_rate` can be brought down to: `TARGET_RATE` when it
/// has that much, else the nearest rate below that Opus takes; none for a device under 8 kHz.
pub fn opus_rate(in_rate: u32) -> Option<u32> {
    [TARGET_RATE, 12_000, 8_000].into_iter().find(|&rate| in_rate >= rate)
}

/// How many samples a recording keeps at most at `rate`; the rest of a longer one is dropped.
/// A second more than `MAX_SECONDS`, so the caller's own stop lands before the host's cut-off.
pub fn max_samples(rate: u32) -> usize {
    (MAX_SECONDS as usize + 1) * rate as usize
}

/// The `OpusHead` packet: mono, `pre_skip` in 48 kHz samples, the rate the audio was recorded at
/// (informative only: Opus always decodes at 48 kHz), no gain, channel mapping family 0.
pub fn opus_head(pre_skip: u16, input_rate: u32) -> Vec<u8> {
    let mut head = Vec::with_capacity(19);
    head.extend_from_slice(b"OpusHead");
    head.push(1); // version
    head.push(1); // channels
    head.extend_from_slice(&pre_skip.to_le_bytes());
    head.extend_from_slice(&input_rate.to_le_bytes());
    head.extend_from_slice(&0i16.to_le_bytes()); // output gain
    head.push(0); // channel mapping family
    head
}

/// The `OpusTags` packet: the vendor string and no comments.
pub fn opus_tags() -> Vec<u8> {
    let vendor = b"Deskfolk";
    let mut tags = Vec::with_capacity(16 + vendor.len());
    tags.extend_from_slice(b"OpusTags");
    tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    tags.extend_from_slice(vendor);
    tags.extend_from_slice(&0u32.to_le_bytes()); // no comments
    tags
}

/// Muxes Opus `packets`, each of `frame_samples` samples at `rate`, into an Ogg file. `real_samples`
/// is how many of them (at `rate`, after the encoder's `pre_skip`) are the recording and not the
/// padding that fills the last frame: the end page's granule position says so, and a decoder drops
/// the rest.
pub fn mux(packets: &[Vec<u8>], frame_samples: usize, rate: u32, pre_skip: u16, real_samples: usize) -> Vec<u8> {
    // Granule positions count 48 kHz samples whatever the encoder's rate.
    let scale = (48_000 / rate.max(1)) as u64;
    let frame_48k = frame_samples as u64 * scale;
    let mut out = Vec::new();
    let mut writer = PacketWriter::new(&mut out);
    // Each header ends its page, as RFC 7845 asks: the head alone on the first.
    let _ = writer.write_packet(opus_head(pre_skip, rate), SERIAL, PacketWriteEndInfo::EndPage, 0);
    let _ = writer.write_packet(opus_tags(), SERIAL, PacketWriteEndInfo::EndPage, 0);
    let end = (u64::from(pre_skip) + real_samples as u64 * scale).min(packets.len() as u64 * frame_48k);
    for (i, packet) in packets.iter().enumerate() {
        let last = i + 1 == packets.len();
        let granule = if last { end } else { (i as u64 + 1) * frame_48k };
        let info = if last { PacketWriteEndInfo::EndStream } else { PacketWriteEndInfo::NormalPacket };
        let _ = writer.write_packet(packet.clone(), SERIAL, info, granule);
    }
    out
}

/// Encodes mono 16-bit `samples` at `rate` (one of the rates `opus_rate` gives) as an Ogg/Opus
/// file of at most `MAX_BYTES`: a longer one loses its tail.
pub fn encode(samples: &[i16], rate: u32) -> Result<Vec<u8>, String> {
    let fail = |e: opus::Error| format!("the recording could not be encoded: {e}");
    let mut encoder = Encoder::new(rate, Channels::Mono, Application::Voip).map_err(fail)?;
    encoder.set_bitrate(Bitrate::Bits(BITRATE)).map_err(fail)?;
    let lookahead = encoder.get_lookahead().map_err(fail)?.max(0) as usize;
    let scale = (48_000 / rate) as usize;
    let pre_skip = (lookahead * scale).min(usize::from(u16::MAX)) as u16;

    // 20 ms frames. The decoder drops `lookahead` samples at the start, so as many more than the
    // recording are encoded, and the last frame is filled out with silence.
    let frame = (rate / 50) as usize;
    let frames = (samples.len() + lookahead).div_ceil(frame).max(1);
    let mut packets = Vec::with_capacity(frames);
    let mut buffer = vec![0i16; frame];
    let mut packet = [0u8; MAX_PACKET];
    for i in 0..frames {
        let from = (i * frame).min(samples.len());
        let to = ((i + 1) * frame).min(samples.len());
        buffer[..to - from].copy_from_slice(&samples[from..to]);
        buffer[to - from..].fill(0);
        let len = encoder.encode(&buffer, &mut packet).map_err(fail)?;
        packets.push(packet[..len].to_vec());
    }

    // Past the limit (a loud, busy take at the top of the length) the tail is let go, a twentieth
    // at a time; the file would otherwise be refused by the daemon.
    let mut file = mux(&packets, frame, rate, pre_skip, samples.len());
    while file.len() > MAX_BYTES && packets.len() > 1 {
        packets.truncate(packets.len() - packets.len().div_ceil(20));
        file = mux(&packets, frame, rate, pre_skip, samples.len());
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ogg::reading::PacketReader;
    use std::io::Cursor;

    fn sine(rate: u32, seconds: f64, hz: f64) -> Vec<i16> {
        (0..(f64::from(rate) * seconds) as usize)
            .map(|i| ((i as f64 / f64::from(rate) * hz * std::f64::consts::TAU).sin() * 8000.0) as i16)
            .collect()
    }

    /// Every Ogg page of `file`: (header type flags, granule position, serial, packet count).
    fn pages(file: &[u8]) -> Vec<(u8, u64, u32, usize)> {
        let mut out = Vec::new();
        let mut at = 0;
        while at < file.len() {
            assert_eq!(&file[at..at + 4], b"OggS", "capture pattern at {at}");
            assert_eq!(file[at + 4], 0, "stream structure version");
            let segments = file[at + 26] as usize;
            let table = &file[at + 27..at + 27 + segments];
            let body: usize = table.iter().map(|&s| s as usize).sum();
            // A packet ends at each lacing value under 255.
            let packets = table.iter().filter(|&&s| s < 255).count();
            let granule = u64::from_le_bytes(file[at + 6..at + 14].try_into().unwrap());
            let serial = u32::from_le_bytes(file[at + 14..at + 18].try_into().unwrap());
            out.push((file[at + 5], granule, serial, packets));
            at += 27 + segments + body;
        }
        assert_eq!(at, file.len(), "pages end exactly at the end of the file");
        out
    }

    #[test]
    fn the_head_says_mono_the_pre_skip_and_the_original_rate() {
        let head = opus_head(312, 16_000);
        assert_eq!(&head[0..8], b"OpusHead");
        assert_eq!(head[8], 1, "version");
        assert_eq!(head[9], 1, "mono");
        assert_eq!(u16::from_le_bytes([head[10], head[11]]), 312);
        assert_eq!(u32::from_le_bytes(head[12..16].try_into().unwrap()), 16_000);
        assert_eq!(i16::from_le_bytes([head[16], head[17]]), 0, "no gain");
        assert_eq!(head[18], 0, "mapping family 0");
        assert_eq!(head.len(), 19);
        let tags = opus_tags();
        assert_eq!(&tags[0..8], b"OpusTags");
        assert_eq!(u32::from_le_bytes(tags[8..12].try_into().unwrap()) as usize, tags.len() - 16);
        assert_eq!(u32::from_le_bytes(tags[tags.len() - 4..].try_into().unwrap()), 0, "no comments");
    }

    #[test]
    fn packets_are_muxed_with_granules_in_48_khz_and_an_end_page() {
        // 50 fake packets of 20 ms at 16 kHz: 960 samples at 48 kHz each.
        let packets: Vec<Vec<u8>> = (0..50).map(|i| vec![i as u8; 60]).collect();
        let file = mux(&packets, 320, 16_000, 312, 320 * 49 + 100);
        let pages = pages(&file);
        assert_eq!(pages[0].0, 0x02, "the head alone, beginning of stream");
        assert_eq!((pages[0].1, pages[0].3), (0, 1));
        assert_eq!((pages[1].1, pages[1].3), (0, 1), "the tags alone");
        assert!(pages.iter().all(|p| p.2 == SERIAL));
        let granules: Vec<u64> = pages[2..].iter().map(|p| p.1).collect();
        assert!(granules.windows(2).all(|w| w[0] < w[1]), "granules only grow: {granules:?}");
        assert_eq!(pages.iter().filter(|p| p.0 & 0x04 != 0).count(), 1, "one end of stream");
        let last = pages.last().unwrap();
        assert_eq!(last.0 & 0x04, 0x04, "the last page ends the stream");
        // The pre-skip, then 49 whole frames and 100 samples of the last, each 3 times longer at 48 kHz.
        assert_eq!(last.1, 312 + (320 * 49 + 100) * 3);
        assert_eq!(pages.iter().map(|p| p.3).sum::<usize>(), 52, "head, tags and every packet");

        // An ogg reader gets the packets back, in order.
        let mut reader = PacketReader::new(Cursor::new(&file));
        let mut read = Vec::new();
        while let Some(p) = reader.read_packet().unwrap() {
            read.push(p.data);
        }
        assert_eq!(read[0], opus_head(312, 16_000));
        assert_eq!(read[1], opus_tags());
        assert_eq!(&read[2..], &packets[..]);
    }

    #[test]
    fn the_end_granule_never_passes_what_the_packets_hold() {
        let packets = vec![vec![1u8; 10]; 3];
        let file = mux(&packets, 320, 16_000, 312, 1_000_000);
        assert_eq!(pages(&file).last().unwrap().1, 3 * 960);
    }

    #[test]
    fn only_the_rates_opus_takes_are_chosen() {
        assert_eq!(opus_rate(48_000), Some(16_000));
        assert_eq!(opus_rate(16_000), Some(16_000));
        assert_eq!(opus_rate(14_000), Some(12_000));
        assert_eq!(opus_rate(11_025), Some(8_000));
        assert_eq!(opus_rate(8_000), Some(8_000));
        assert_eq!(opus_rate(7_000), None);
    }

    #[test]
    fn a_sine_through_the_real_encoder_is_a_well_formed_ogg_opus_file() {
        assert_eq!(MIME, "audio/ogg;codecs=opus");
        let samples = sine(16_000, 2.0, 440.0);
        let file = encode(&samples, 16_000).unwrap();
        let pages = pages(&file);

        // Headers first, then audio; one stream; granules grow; the last page ends it.
        assert_eq!(pages[0].0, 0x02);
        assert!(pages.iter().all(|p| p.2 == pages[0].2));
        let granules: Vec<u64> = pages[2..].iter().map(|p| p.1).collect();
        assert!(granules.windows(2).all(|w| w[0] < w[1]), "{granules:?}");
        assert_eq!(pages.iter().filter(|p| p.0 & 0x04 != 0).count(), 1);
        assert_eq!(pages.last().unwrap().0 & 0x04, 0x04);

        let mut reader = PacketReader::new(Cursor::new(&file));
        let head = reader.read_packet().unwrap().unwrap().data;
        assert_eq!(&head[0..8], b"OpusHead");
        let pre_skip = u16::from_le_bytes([head[10], head[11]]);
        assert!(pre_skip > 0 && pre_skip < 1000, "the encoder's lookahead: {pre_skip}");
        assert_eq!(u32::from_le_bytes(head[12..16].try_into().unwrap()), 16_000);
        let tags = reader.read_packet().unwrap().unwrap().data;
        assert_eq!(&tags[0..8], b"OpusTags");

        // What the end granule says is the recording: the pre-skip and two seconds at 48 kHz.
        assert_eq!(pages.last().unwrap().1, u64::from(pre_skip) + 2 * 48_000);

        // Decoding it back gives the same length and a tone, not silence.
        let mut decoder = opus::Decoder::new(16_000, Channels::Mono).unwrap();
        let mut decoded = Vec::new();
        let mut out = vec![0i16; 320];
        while let Some(p) = reader.read_packet().unwrap() {
            let n = decoder.decode(&p.data, &mut out, false).unwrap();
            decoded.extend_from_slice(&out[..n]);
        }
        let skip = usize::from(pre_skip) / 3;
        let kept = &decoded[skip..skip + samples.len()];
        let rms = (kept.iter().map(|&s| f64::from(s).powi(2)).sum::<f64>() / kept.len() as f64).sqrt();
        assert!(rms > 3000.0 && rms < 8000.0, "a 8000-peak sine has an RMS near 5657: {rms}");
    }

    #[test]
    fn a_take_of_the_full_length_fits_what_the_daemon_takes() {
        // Speech-like and busy at once: a few tones swept, plus noise from a fixed generator.
        let rate = 16_000;
        let mut seed = 12345u32;
        let samples: Vec<i16> = (0..max_samples(rate))
            .map(|i| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let noise = f64::from((seed >> 16) as i16) / 32768.0;
                let t = i as f64 / f64::from(rate);
                ((t * 300.0 * (1.0 + 0.5 * (t * 3.0).sin()) * std::f64::consts::TAU).sin() * 6000.0 + noise * 3000.0) as i16
            })
            .collect();
        let file = encode(&samples, rate).unwrap();
        assert!(file.len() <= MAX_BYTES, "{} bytes", file.len());
        // Base64 grows by a third, rounded up to four characters.
        assert!(file.len().div_ceil(3) * 4 < 1_000_000);
    }

    #[test]
    fn an_empty_recording_is_still_a_valid_file() {
        let file = encode(&[], 16_000).unwrap();
        let pages = pages(&file);
        assert_eq!(pages.last().unwrap().0 & 0x04, 0x04);
    }
}
