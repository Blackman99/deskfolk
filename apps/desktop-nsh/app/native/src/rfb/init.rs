//! The handshake (noVNC's `_initMsg`): version, security type, authentication, SecurityResult,
//! ClientInit and ServerInit.

use serde_json::json;

use super::auth;
use super::protocol::*;
use super::session::{Failure, Phase, Session, Step};

/// What we can do, tried in the order the server lists them.
fn supported(scheme: u32) -> bool {
    matches!(scheme, SEC_NONE | SEC_VNC | SEC_ARD)
}

impl Session {
    pub(super) fn init_step(&mut self, data: &[u8]) -> Result<Step, Failure> {
        match self.phase {
            Phase::Version => self.version(data),
            Phase::Security => self.security(data),
            Phase::Auth => self.authenticate(data),
            Phase::SecurityResult => self.security_result(data),
            Phase::SecurityReason { context } => self.security_reason(data, context),
            Phase::ServerInit => self.server_init(data),
            Phase::Normal | Phase::Dead => Ok(Step::Need),
        }
    }

    fn version(&mut self, data: &[u8]) -> Result<Step, Failure> {
        if data.len() < 12 {
            return Ok(Step::Need);
        }
        let text = String::from_utf8_lossy(&data[..12]).into_owned();
        let version = text.get(4..11).filter(|_| text.starts_with("RFB ") && text.ends_with('\n'));
        self.minor = match version {
            Some("003.003" | "003.006") => 3,
            Some("003.007") => 7,
            // 3.889 Apple Remote Desktop, 4.0 Intel AMT, 4.1 RealVNC 4.6, 5.0 RealVNC 5.3
            Some("003.008" | "003.889" | "004.000" | "004.001" | "005.000") => 8,
            other => {
                let shown = other.map(str::to_owned).unwrap_or_else(|| text.trim_end().to_owned());
                return Err(Failure::new(format!("Invalid server version {shown}")));
            }
        };
        self.out.extend(version_message(self.minor));
        self.phase = Phase::Security;
        Ok(Step::Done(12))
    }

    fn security(&mut self, data: &[u8]) -> Result<Step, Failure> {
        if self.minor >= 7 {
            let Some(&count) = data.first() else { return Ok(Step::Need) };
            let count = count as usize;
            if data.len() < 1 + count {
                return Ok(Step::Need);
            }
            if count == 0 {
                self.phase = Phase::SecurityReason { context: "no security types" };
                return Ok(Step::Done(1));
            }
            let types = &data[1..1 + count];
            let Some(&chosen) = types.iter().find(|&&t| supported(u32::from(t))) else {
                return Err(Failure::new(format!("Unsupported security types (types: {})", join(types))));
            };
            self.out.push(chosen);
            self.scheme = u32::from(chosen);
            self.phase = Phase::Auth;
            Ok(Step::Done(1 + count))
        } else {
            if data.len() < 4 {
                return Ok(Step::Need);
            }
            self.scheme = be32(data, 0);
            self.phase = if self.scheme == 0 { Phase::SecurityReason { context: "authentication scheme" } } else { Phase::Auth };
            Ok(Step::Done(4))
        }
    }

    /// Credentials are asked for once; `credentials()` answers and the parser resumes.
    fn ask(&mut self, needs: &[&str]) {
        if !self.asked {
            self.asked = true;
            self.emit(json!({"type": "credentials", "needs": needs}));
        }
    }

    fn authenticate(&mut self, data: &[u8]) -> Result<Step, Failure> {
        match self.scheme {
            SEC_NONE => {
                if self.minor >= 8 {
                    self.phase = Phase::SecurityResult;
                } else {
                    self.client_init();
                }
                Ok(Step::Done(0))
            }
            SEC_VNC => {
                if data.len() < 16 {
                    return Ok(Step::Need);
                }
                let Some((_, password)) = self.credentials.clone() else {
                    self.ask(&["password"]);
                    return Ok(Step::Need);
                };
                let challenge: [u8; 16] = data[..16].try_into().expect("16 bytes");
                self.out.extend(auth::vnc_response(&password, &challenge));
                self.phase = Phase::SecurityResult;
                Ok(Step::Done(16))
            }
            SEC_ARD => {
                let Some((user, password)) = self.credentials.clone() else {
                    self.ask(&["username", "password"]);
                    return Ok(Step::Need);
                };
                if data.len() < 4 {
                    return Ok(Step::Need);
                }
                let key_len = be16(data, 2);
                if key_len == 0 || key_len > 512 {
                    return Err(Failure::new("The server sent an unusable ARD key length"));
                }
                let total = 4 + key_len * 2;
                if data.len() < total {
                    return Ok(Step::Need);
                }
                let seed = match self.seed.clone() {
                    Some(seed) => seed,
                    #[cfg(test)]
                    None => vec![0x5e; 16],
                    #[cfg(not(test))]
                    None => return Err(Failure::new("No random seed was given for the ARD key exchange")),
                };
                let reply = auth::ard_response(
                    &data[..2],
                    &data[4..4 + key_len],
                    &data[4 + key_len..total],
                    &user,
                    &password,
                    &seed,
                )?;
                self.out.extend(reply);
                self.phase = Phase::SecurityResult;
                Ok(Step::Done(total))
            }
            other => Err(Failure::new(format!("Unsupported auth scheme (scheme: {other})"))),
        }
    }

    fn security_result(&mut self, data: &[u8]) -> Result<Step, Failure> {
        if data.len() < 4 {
            return Ok(Step::Need);
        }
        if be32(data, 0) == 0 {
            self.client_init();
        } else if self.minor >= 8 {
            self.phase = Phase::SecurityReason { context: "security result" };
        } else {
            return Err(Failure { reason: "Security handshake failed".into(), security: true });
        }
        Ok(Step::Done(4))
    }

    fn security_reason(&mut self, data: &[u8], context: &str) -> Result<Step, Failure> {
        if data.len() < 4 {
            return Ok(Step::Need);
        }
        let len = be32(data, 0) as usize;
        if len > 1 << 16 {
            return Err(Failure { reason: format!("Security negotiation failed on {context}"), security: true });
        }
        if data.len() < 4 + len {
            return Ok(Step::Need);
        }
        let reason: String = data[4..4 + len].iter().map(|&b| b as char).collect();
        let reason = if reason.is_empty() { format!("Security negotiation failed on {context}") } else { reason };
        Err(Failure { reason, security: true })
    }

    fn client_init(&mut self) {
        self.out.push(1); // shared
        self.phase = Phase::ServerInit;
    }

    fn server_init(&mut self, data: &[u8]) -> Result<Step, Failure> {
        if data.len() < 24 {
            return Ok(Step::Need);
        }
        let name_len = be32(data, 20) as usize;
        if name_len > 1 << 20 {
            return Err(Failure::new("The server's name is absurdly long"));
        }
        if data.len() < 24 + name_len {
            return Ok(Step::Need);
        }
        let name = String::from_utf8_lossy(&data[24..24 + name_len]).into_owned();
        let (w, h) = (be16(data, 0), be16(data, 2));
        self.resize(w, h)?;
        self.out.extend(pixel_format());
        self.out.extend(encodings());
        self.out.extend(update_request(false, w, h));
        self.phase = Phase::Normal;
        self.emit(json!({"type": "connected", "width": w, "height": h, "name": name}));
        Ok(Step::Done(24 + name_len))
    }
}

fn join(types: &[u8]) -> String {
    types.iter().map(u8::to_string).collect::<Vec<_>>().join(",")
}
