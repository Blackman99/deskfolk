use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn read() -> Value {
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}
fn emit(value: Value) {
    println!("{}", value);
    io::stdout().flush().unwrap();
}
fn bytes(v: &Value, key: &str) -> Vec<u8> {
    hex::decode(v[key].as_str().unwrap()).unwrap()
}
fn hello(domain: &[u8], prologue: &[u8], ephemeral: &[u8], sid: &[u8], hash: &[u8]) -> Vec<u8> {
    [domain, prologue, ephemeral, sid, hash].concat()
}
fn main() {
    let v = read();
    let initiator = v["initiator"].as_bool().unwrap();
    let local = bytes(&v, "local");
    let remote = bytes(&v, "remote");
    let prologue = bytes(&v, "prologue");
    let signing = SigningKey::from_bytes(&bytes(&v, "signing").try_into().unwrap());
    let peer = VerifyingKey::from_bytes(&bytes(&v, "peer_signing").try_into().unwrap()).unwrap();
    let ephemeral = bytes(&v, "ephemeral");
    let ephemeral_public = bytes(&v, "ephemeral_public");
    let builder = snow::Builder::new("Noise_IK_25519_ChaChaPoly_BLAKE2s".parse().unwrap())
        .local_private_key(&local)
        .unwrap()
        .prologue(&prologue)
        .unwrap()
        .fixed_ephemeral_key_for_testing_only(&ephemeral);
    let mut hs = if initiator {
        builder
            .remote_public_key(&remote)
            .unwrap()
            .build_initiator()
            .unwrap()
    } else {
        builder.build_responder().unwrap()
    };
    let mut out = vec![0u8; 65535];
    let mut payload = vec![0u8; 65535];
    if initiator {
        let sid = [42u8; 16];
        let sig = signing.sign(&hello(
            b"RB-HELLO-I",
            &prologue,
            &ephemeral_public,
            &sid,
            &[],
        ));
        let p = [
            &sid[..],
            &signing.verifying_key().to_bytes(),
            &sig.to_bytes(),
        ]
        .concat();
        let n = hs.write_message(&p, &mut out).unwrap();
        let hash1 = hs.get_handshake_hash().to_vec();
        emit(json!({"message": hex::encode(&out[..n])}));
        let message = bytes(&read(), "message");
        let n = hs.read_message(&message, &mut payload).unwrap();
        assert_eq!(n, 96);
        assert_eq!(&payload[..32], peer.as_bytes());
        peer.verify_strict(
            &hello(b"RB-HELLO-R", &prologue, &message[..32], &sid, &hash1),
            &Signature::from_slice(&payload[32..n]).unwrap(),
        )
        .unwrap();
    } else {
        let message = bytes(&read(), "message");
        let n = hs.read_message(&message, &mut payload).unwrap();
        assert_eq!(n, 112);
        assert_eq!(hs.get_remote_static().unwrap(), remote);
        assert_eq!(&payload[16..48], peer.as_bytes());
        let sid = payload[..16].to_vec();
        peer.verify_strict(
            &hello(b"RB-HELLO-I", &prologue, &message[..32], &sid, &[]),
            &Signature::from_slice(&payload[48..112]).unwrap(),
        )
        .unwrap();
        let sig = signing.sign(&hello(
            b"RB-HELLO-R",
            &prologue,
            &ephemeral_public,
            &sid,
            hs.get_handshake_hash(),
        ));
        let p = [&signing.verifying_key().to_bytes()[..], &sig.to_bytes()].concat();
        let n = hs.write_message(&p, &mut out).unwrap();
        emit(json!({"message": hex::encode(&out[..n])}));
    }
    let hash = hex::encode(hs.get_handshake_hash());
    let mut transport = hs.into_transport_mode().unwrap();
    emit(json!({"ready": true, "hash": hash}));
    loop {
        let command = read();
        if command["quit"] == true {
            break;
        }
        let message = bytes(&command, "message");
        let n = transport.read_message(&message, &mut payload).unwrap();
        let m = transport.write_message(&payload[..n], &mut out).unwrap();
        emit(json!({"message": hex::encode(&out[..m]), "plaintext": hex::encode(&payload[..n])}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn official_cacophony_vector() {
        let vectors: Value =
            serde_json::from_str(include_str!("../../fixtures/cacophony-ik.json")).unwrap();
        let v = &vectors[0];
        let si = bytes(v, "init_static");
        let ei = bytes(v, "init_ephemeral");
        let sr = bytes(v, "resp_static");
        let er = bytes(v, "resp_ephemeral");
        let rs = bytes(v, "init_remote_static");
        let prologue = bytes(v, "init_prologue");
        let mut i = snow::Builder::new(v["protocol_name"].as_str().unwrap().parse().unwrap())
            .local_private_key(&si)
            .unwrap()
            .remote_public_key(&rs)
            .unwrap()
            .prologue(&prologue)
            .unwrap()
            .fixed_ephemeral_key_for_testing_only(&ei)
            .build_initiator()
            .unwrap();
        let mut r = snow::Builder::new(v["protocol_name"].as_str().unwrap().parse().unwrap())
            .local_private_key(&sr)
            .unwrap()
            .prologue(&prologue)
            .unwrap()
            .fixed_ephemeral_key_for_testing_only(&er)
            .build_responder()
            .unwrap();
        let mut out = [0u8; 65535];
        let mut plain = [0u8; 65535];
        for index in 0..2 {
            let m = &v["messages"][index];
            let (sender, receiver) = if index == 0 {
                (&mut i, &mut r)
            } else {
                (&mut r, &mut i)
            };
            let n = sender
                .write_message(&bytes(m, "payload"), &mut out)
                .unwrap();
            assert_eq!(hex::encode(&out[..n]), m["ciphertext"].as_str().unwrap());
            receiver.read_message(&out[..n], &mut plain).unwrap();
        }
        assert_eq!(
            hex::encode(i.get_handshake_hash()),
            v["handshake_hash"].as_str().unwrap()
        );
        assert_eq!(i.get_handshake_hash(), r.get_handshake_hash());
        let mut i = i.into_transport_mode().unwrap();
        let mut r = r.into_transport_mode().unwrap();
        for index in 2..6 {
            let m = &v["messages"][index];
            let (sender, receiver) = if index % 2 == 0 {
                (&mut i, &mut r)
            } else {
                (&mut r, &mut i)
            };
            let n = sender
                .write_message(&bytes(m, "payload"), &mut out)
                .unwrap();
            assert_eq!(hex::encode(&out[..n]), m["ciphertext"].as_str().unwrap());
            receiver.read_message(&out[..n], &mut plain).unwrap();
        }
    }
}
