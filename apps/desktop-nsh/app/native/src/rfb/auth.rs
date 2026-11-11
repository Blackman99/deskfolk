//! The two password schemes: VNC authentication (DES) and Apple Remote Desktop (Diffie-Hellman,
//! MD5, AES-128-ECB), as noVNC's `genDES` and `_negotiateARDAuth*` do them.

use aes::Aes128;
use aes::cipher::{Array, BlockCipherEncrypt, KeyInit};
use des::Des;
use md5::{Digest, Md5};
use num_bigint::BigUint;

/// VNC authentication: DES-ECB of the 16-byte challenge, the key being the password cut or
/// zero-padded to 8 bytes with every byte's bits reversed.
pub fn vnc_response(password: &str, challenge: &[u8; 16]) -> [u8; 16] {
    let mut key = [0u8; 8];
    for (slot, c) in key.iter_mut().zip(password.chars()) {
        *slot = (u32::from(c) as u8).reverse_bits();
    }
    let cipher = Des::new(&Array::from(key));
    let mut out = *challenge;
    for block in out.chunks_exact_mut(8) {
        let mut b = Array::<u8, _>::try_from(&*block).expect("8 bytes");
        cipher.encrypt_block(&mut b);
        block.copy_from_slice(&b);
    }
    out
}

/// Deterministic byte stream from the caller's entropy: MD5(seed || label || counter) blocks.
pub fn expand(seed: &[u8], label: &[u8], len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len + 16);
    let mut counter = 0u32;
    while out.len() < len {
        let mut h = Md5::new();
        h.update(seed);
        h.update(label);
        h.update(counter.to_be_bytes());
        out.extend_from_slice(&h.finalize());
        counter += 1;
    }
    out.truncate(len);
    out
}

fn to_fixed(n: &BigUint, len: usize) -> Vec<u8> {
    let bytes = n.to_bytes_be();
    let mut out = vec![0u8; len.saturating_sub(bytes.len())];
    out.extend_from_slice(&bytes);
    out
}

/// What ARD wants back: the AES-encrypted 128 credential bytes, then our DH public key.
pub fn ard_response(
    generator: &[u8],
    prime: &[u8],
    server_public: &[u8],
    username: &str,
    password: &str,
    seed: &[u8],
) -> Result<Vec<u8>, String> {
    let key_len = prime.len();
    let g = BigUint::from_bytes_be(generator);
    let p = BigUint::from_bytes_be(prime);
    if p <= BigUint::from(1u8) {
        return Err("the server sent an unusable Diffie-Hellman prime".into());
    }
    let private = BigUint::from_bytes_be(&expand(seed, b"ard-private", key_len));
    let public = to_fixed(&g.modpow(&private, &p), key_len);
    let shared = to_fixed(&BigUint::from_bytes_be(server_public).modpow(&private, &p), key_len);

    // 128 bytes: username (at most 63 bytes) and a zero at 0.., password and a zero at 64.., the
    // rest random fill.
    let mut credentials = expand(seed, b"ard-fill", 128);
    let user = &username.as_bytes()[..username.len().min(63)];
    let pass = &password.as_bytes()[..password.len().min(63)];
    credentials[..user.len()].copy_from_slice(user);
    credentials[user.len()] = 0;
    credentials[64..64 + pass.len()].copy_from_slice(pass);
    credentials[64 + pass.len()] = 0;

    let aes_key: [u8; 16] = Md5::digest(&shared).into();
    let cipher = Aes128::new(&Array::from(aes_key));
    for block in credentials.chunks_exact_mut(16) {
        let mut b = Array::<u8, _>::try_from(&*block).expect("16 bytes");
        cipher.encrypt_block(&mut b);
        block.copy_from_slice(&b);
    }
    credentials.extend_from_slice(&public);
    Ok(credentials)
}
