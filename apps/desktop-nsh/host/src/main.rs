//! Deskfolk's native shell (NSH dev build). See `apps/desktop-nsh/README.md`.

#[cfg(target_os = "macos")]
mod app;
mod config;
mod endpoint;
#[cfg(target_os = "linux")]
mod gtk;
mod launch;
#[cfg(target_os = "macos")]
mod host_calls;
#[cfg(target_os = "macos")]
mod notify;
mod runtime;
#[cfg(target_os = "macos")]
mod snapshot;
#[cfg(target_os = "macos")]
mod system;
#[cfg(windows)]
mod win;
#[cfg(target_os = "macos")]
mod window;

struct Logger;

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        let target = metadata.target();
        metadata.level() <= log::Level::Warn
            || target == "js"
            || target.starts_with("deskfolk")
            || (target.starts_with("nsh") && metadata.level() <= log::Level::Info)
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("{:>5} {} {}", record.level(), record.target(), record.args());
        }
    }

    fn flush(&self) {}
}

static LOGGER: Logger = Logger;

fn main() -> std::process::ExitCode {
    let _ = log::set_logger(&LOGGER).map(|()| log::set_max_level(log::LevelFilter::Info));
    let config = match config::from_args(std::env::args()) {
        Ok(config) => config,
        Err(why) => {
            eprintln!("deskfolk-nsh: {why}");
            return std::process::ExitCode::FAILURE;
        }
    };
    #[cfg(target_os = "macos")]
    return app::run(config);
    #[cfg(windows)]
    return win::run(config);
    #[cfg(target_os = "linux")]
    return gtk::run(config);
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        let _ = config;
        eprintln!("deskfolk-nsh runs on macOS, Windows and Linux");
        std::process::ExitCode::FAILURE
    }
}
