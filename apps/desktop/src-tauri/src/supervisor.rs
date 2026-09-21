//! Window-process policy for the daemon: who is alive, when to spawn, when to quit.
//!
//! HTTP and process spawn stay outside this module. Tests lock the process graph
//! from [退出、隐藏与登录启动时谁还活着](../../../../.scratch/v1/issues/05-quit-hide-launchd.md).

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Endpoint {
    pub origin: String,
    pub token: String,
}

impl Endpoint {
    pub fn new(port: u16, token: impl Into<String>) -> Self {
        Self {
            origin: format!("http://127.0.0.1:{port}"),
            token: token.into(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Probe {
    /// `GET /v1/health` is `{ ok: true, name: "real-bot" }`.
    Ours,
    /// Something else is bound on the port.
    OccupiedByOther,
    /// Nothing is listening, or health is unreachable.
    Down,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action {
    Idle,
    Spawn,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum QuitPlan {
    PostThenExit { origin: String, token: String },
    JustExit,
}

pub struct Supervisor {
    supervising: bool,
    endpoint: Option<Endpoint>,
}

impl Supervisor {
    pub fn new() -> Self {
        Self {
            supervising: true,
            endpoint: None,
        }
    }

    pub fn is_supervising(&self) -> bool {
        self.supervising
    }

    pub fn is_connected(&self) -> bool {
        self.endpoint.is_some()
    }

    pub fn endpoint(&self) -> Option<&Endpoint> {
        self.endpoint.as_ref()
    }

    pub fn remember(&mut self, endpoint: Endpoint) {
        self.endpoint = Some(endpoint);
    }

    pub fn set_supervising(&mut self, supervising: bool) {
        self.supervising = supervising;
    }

    #[cfg(test)]
    pub fn forget(&mut self) {
        self.endpoint = None;
    }

    #[cfg(test)]
    pub fn stop_supervising(&mut self) {
        self.set_supervising(false);
    }

    /// Window is alive (including hidden to tray) → spawn a dead daemon.
    /// Occupied by someone else → do not spawn a second listener.
    /// Health down but the descriptor pid is still alive → wait; do not spawn a sibling.
    /// After quit, never spawn.
    pub fn on_probe(&mut self, probe: Probe, holder_alive: bool) -> Action {
        match probe {
            Probe::Ours => Action::Idle,
            Probe::OccupiedByOther => {
                self.endpoint = None;
                Action::Idle
            }
            Probe::Down => {
                self.endpoint = None;
                if self.supervising && !holder_alive {
                    Action::Spawn
                } else {
                    Action::Idle
                }
            }
        }
    }

    /// Stop supervising first so a respawn cannot race the quit POST.
    /// Already-independent windows only close the UI.
    pub fn quit(&mut self) -> QuitPlan {
        let was_supervising = self.supervising;
        self.supervising = false;
        if !was_supervising {
            return QuitPlan::JustExit;
        }
        match self.endpoint.take() {
            Some(Endpoint { origin, token }) => QuitPlan::PostThenExit { origin, token },
            None => QuitPlan::JustExit,
        }
    }
}

pub fn launched_hidden(args: &[impl AsRef<str>]) -> bool {
    args.iter().any(|a| a.as_ref() == "--hidden")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn down_while_supervising_spawns() {
        let mut s = Supervisor::new();
        assert_eq!(s.on_probe(Probe::Down, false), Action::Spawn);
        assert!(!s.is_connected());
    }

    #[test]
    fn down_while_holder_alive_does_not_spawn() {
        let mut s = Supervisor::new();
        s.remember(Endpoint::new(17890, "tok"));
        assert_eq!(s.on_probe(Probe::Down, true), Action::Idle);
        assert!(!s.is_connected());
    }

    #[test]
    fn ours_does_not_spawn() {
        let mut s = Supervisor::new();
        s.remember(Endpoint::new(17890, "tok"));
        assert_eq!(s.on_probe(Probe::Ours, false), Action::Idle);
        assert!(s.is_connected());
    }

    #[test]
    fn occupied_by_other_does_not_spawn() {
        let mut s = Supervisor::new();
        s.remember(Endpoint::new(17890, "tok"));
        assert_eq!(s.on_probe(Probe::OccupiedByOther, false), Action::Idle);
        assert!(!s.is_connected());
    }

    #[test]
    fn down_after_stop_does_not_spawn() {
        let mut s = Supervisor::new();
        s.stop_supervising();
        assert_eq!(s.on_probe(Probe::Down, false), Action::Idle);
        assert_eq!(s.on_probe(Probe::Down, true), Action::Idle);
    }

    #[test]
    fn quit_stops_supervise_then_posts() {
        let mut s = Supervisor::new();
        s.remember(Endpoint::new(17890, "secret-token"));
        let plan = s.quit();
        assert!(!s.is_supervising());
        assert!(!s.is_connected());
        assert_eq!(
            plan,
            QuitPlan::PostThenExit {
                origin: "http://127.0.0.1:17890".into(),
                token: "secret-token".into(),
            }
        );
        assert_eq!(s.on_probe(Probe::Down, false), Action::Idle);
    }

    #[test]
    fn quit_without_endpoint_just_exits() {
        let mut s = Supervisor::new();
        assert_eq!(s.quit(), QuitPlan::JustExit);
        assert!(!s.is_supervising());
    }

    #[test]
    fn quit_while_independent_does_not_post() {
        let mut s = Supervisor::new();
        s.remember(Endpoint::new(17890, "tok"));
        s.set_supervising(false);
        assert_eq!(s.quit(), QuitPlan::JustExit);
    }

    #[test]
    fn login_hidden_flag() {
        assert!(launched_hidden(&["real-bot-desktop", "--hidden"]));
        assert!(!launched_hidden(&["real-bot-desktop"]));
        assert!(!launched_hidden(&["real-bot-desktop", "--from-autostart"]));
    }

    #[test]
    fn stop_available_only_when_connected() {
        let mut s = Supervisor::new();
        assert!(!s.is_connected());
        s.remember(Endpoint::new(17890, "t"));
        assert!(s.is_connected());
        s.forget();
        assert!(!s.is_connected());
    }

    #[test]
    fn independent_mode_stops_spawn_without_adopting_the_old_pid() {
        let mut s = Supervisor::new();
        s.remember(Endpoint::new(17890, "tok"));
        s.set_supervising(false);
        assert!(!s.is_supervising());
        assert!(s.is_connected());
        assert_eq!(s.on_probe(Probe::Down, false), Action::Idle);
        assert_eq!(s.on_probe(Probe::Down, true), Action::Idle);
        assert!(!s.is_connected());
    }

    #[test]
    fn restoring_window_supervision_spawns_after_bootout_down() {
        let mut s = Supervisor::new();
        s.set_supervising(false);
        s.set_supervising(true);
        assert_eq!(s.on_probe(Probe::Ours, true), Action::Idle);
        assert_eq!(s.on_probe(Probe::Down, false), Action::Spawn);
    }
}
