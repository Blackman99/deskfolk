//! Your Claude plan's usage at the top of the menu bar menu (ADR 0061): the same
//! `GET /v1/claude-usage` the sidebar reads, asked once a minute while the daemon is up. The
//! daemon keeps each answer for five minutes, so this starts at most one `claude` per five
//! minutes, and none at all until a Bot runs on Claude Agent. With Bots on more than one Claude
//! account, each account's lines come under its own name. The lines go away when there is
//! nothing to show; a click on one shows the window.

use serde::Deserialize;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Manager, Wry};

use crate::supervisor::Endpoint;

const POLL: Duration = Duration::from_secs(60);
/// Starting `claude` and its answer from claude.ai can take a while; the daemon gives up at 30 s.
const FETCH_TIMEOUT: Duration = Duration::from_secs(40);
pub const ITEM_PREFIX: &str = "usage-";

#[derive(Debug, Deserialize)]
pub struct Usage {
    pub available: bool,
    #[serde(default)]
    pub windows: Vec<UsageWindow>,
    /// Each account some Bot runs on; absent from a daemon older than accounts.
    #[serde(default)]
    pub accounts: Vec<AccountUsage>,
}

#[derive(Debug, Deserialize)]
pub struct AccountUsage {
    pub available: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub windows: Vec<UsageWindow>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub config_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UsageWindow {
    pub kind: String,
    pub model: Option<String>,
    pub percent: f64,
    pub resets_at: Option<String>,
}

#[derive(Default)]
struct Shown {
    menu: Option<Menu<Wry>>,
    items: Vec<MenuItem<Wry>>,
    separator: Option<PredefinedMenuItem<Wry>>,
    lines: Vec<String>,
}

/// The menu the lines go into and what is in it now. Only the worker thread below locks this,
/// so menu calls (which wait on the main thread) never hold a lock the main thread wants.
#[derive(Default)]
pub struct UsageTray(Mutex<Shown>);

/// Remembers the tray's menu and starts asking. `endpoint` reads the connected daemon, if any.
pub fn start(
    app: &AppHandle,
    menu: Menu<Wry>,
    endpoint: impl Fn(&AppHandle) -> Option<Endpoint> + Send + 'static,
) {
    app.manage(UsageTray(Mutex::new(Shown {
        menu: Some(menu),
        ..Shown::default()
    })));
    let handle = app.clone();
    std::thread::spawn(move || loop {
        let lines = match endpoint(&handle) {
            // A failed ask keeps the lines already shown; the next minute asks again.
            Some(endpoint) => match fetch(&endpoint) {
                Some(usage) => usage_lines(&usage, now_secs()),
                None => current_lines(&handle),
            },
            None => Vec::new(),
        };
        show(&handle, lines);
        std::thread::sleep(POLL);
    });
}

fn fetch(endpoint: &Endpoint) -> Option<Usage> {
    let url = format!("{}/v1/claude-usage", endpoint.origin);
    ureq::AgentBuilder::new()
        .timeout(FETCH_TIMEOUT)
        .build()
        .get(&url)
        .set("Authorization", &format!("Bearer {}", endpoint.token))
        .call()
        .ok()?
        .into_json()
        .ok()
}

fn current_lines(app: &AppHandle) -> Vec<String> {
    let state = app.state::<UsageTray>();
    let lines = state.0.lock().map(|s| s.lines.clone()).unwrap_or_default();
    lines
}

/// Puts `lines` at the top of the menu with a separator under them: renamed in place when as many
/// as before, rebuilt otherwise, nothing at all when there are none.
fn show(app: &AppHandle, lines: Vec<String>) {
    let state = app.state::<UsageTray>();
    let Ok(mut shown) = state.0.lock() else {
        return;
    };
    if shown.lines == lines {
        return;
    }
    let Some(menu) = shown.menu.clone() else {
        return;
    };
    if lines.len() == shown.items.len() {
        for (item, line) in shown.items.iter().zip(&lines) {
            let _ = item.set_text(line);
        }
    } else {
        for item in shown.items.drain(..) {
            let _ = menu.remove(&item);
        }
        if let Some(separator) = shown.separator.take() {
            let _ = menu.remove(&separator);
        }
        for (i, line) in lines.iter().enumerate() {
            if let Ok(item) =
                MenuItem::with_id(app, format!("{ITEM_PREFIX}{i}"), line, true, None::<&str>)
            {
                if menu.insert(&item, i).is_ok() {
                    shown.items.push(item);
                }
            }
        }
        if !shown.items.is_empty() {
            if let Ok(separator) = PredefinedMenuItem::separator(app) {
                if menu.insert(&separator, shown.items.len()).is_ok() {
                    shown.separator = Some(separator);
                }
            }
        }
    }
    shown.lines = lines;
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// One line per window, the plan's own first, as the daemon orders them; none when unavailable.
/// With several accounts, each one's windows come under a line naming it (its email, else its
/// config directory, else the default account), and one signed out says so on that line.
pub fn usage_lines(usage: &Usage, now: i64) -> Vec<String> {
    if usage.accounts.len() > 1 {
        if !usage.accounts.iter().any(|account| account.available) {
            return Vec::new();
        }
        let mut lines = Vec::new();
        for account in &usage.accounts {
            let label = account
                .email
                .as_deref()
                .or(account.config_dir.as_deref())
                .unwrap_or("默认账号");
            if account.available {
                lines.push(format!("Claude · {label}"));
                lines.extend(window_lines(&account.windows, now, ""));
            } else if account.reason.as_deref() == Some("signed_out") {
                lines.push(format!("Claude · {label}：未登录"));
            }
        }
        return lines;
    }
    if !usage.available {
        return Vec::new();
    }
    window_lines(&usage.windows, now, "Claude ")
}

/// A line per window; `prefix` goes before the plan's own two (`Claude 5 小时`).
fn window_lines(windows: &[UsageWindow], now: i64, prefix: &str) -> Vec<String> {
    windows
        .iter()
        .map(|window| {
            let name = match window.kind.as_str() {
                "five_hour" => format!("{prefix}5 小时"),
                "seven_day" => format!("{prefix}7 天"),
                _ => format!("{} 7 天", window.model.as_deref().unwrap_or("Claude")),
            };
            let percent = percent_text(window.percent);
            match window.resets_at.as_deref().and_then(parse_rfc3339) {
                Some(at) => format!("{name}：{percent}（{}）", reset_text(at - now)),
                None => format!("{name}：{percent}"),
            }
        })
        .collect()
}

fn percent_text(percent: f64) -> String {
    if percent > 0.0 && percent < 1.0 {
        return "<1%".to_string();
    }
    format!("{}%", percent.clamp(0.0, 100.0).round() as i64)
}

/// How long until a window starts over, in the menu's words.
fn reset_text(left: i64) -> String {
    if left <= 60 {
        return "即将重置".to_string();
    }
    let minutes = (left + 59) / 60;
    if minutes < 24 * 60 {
        let (hours, minutes) = (minutes / 60, minutes % 60);
        return if hours > 0 {
            format!("{hours} 小时 {minutes} 分后重置")
        } else {
            format!("{minutes} 分钟后重置")
        };
    }
    let hours = minutes / 60;
    format!("{} 天 {} 小时后重置", hours / 24, hours % 24)
}

/// `2026-10-08T15:49:59.889937+00:00` or `…Z` to Unix seconds; None for anything else.
fn parse_rfc3339(text: &str) -> Option<i64> {
    let (date, rest) = text.split_once('T')?;
    let mut date = date.splitn(3, '-').map(|part| part.parse::<i64>().ok());
    let (year, month, day) = (date.next()??, date.next()??, date.next()??);
    if rest.len() < 8 {
        return None;
    }
    let (clock, mut zone) = rest.split_at(8);
    let mut clock = clock.splitn(3, ':').map(|part| part.parse::<i64>().ok());
    let (hour, minute, second) = (clock.next()??, clock.next()??, clock.next()??);
    if let Some(fraction) = zone.strip_prefix('.') {
        zone = fraction.trim_start_matches(|c: char| c.is_ascii_digit());
    }
    let offset = match zone {
        "Z" | "z" => 0,
        _ => {
            let sign = match zone.chars().next()? {
                '+' => 1,
                '-' => -1,
                _ => return None,
            };
            let (h, m) = zone[1..].split_once(':')?;
            sign * (h.parse::<i64>().ok()? * 3600 + m.parse::<i64>().ok()? * 60)
        }
    };
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(json: &str) -> Usage {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn reads_claude_codes_timestamps() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339("2026-10-08T15:49:59.889937+00:00"),
            Some(1_791_474_599)
        );
        assert_eq!(
            parse_rfc3339("2026-10-08T23:49:59+08:00"),
            Some(1_791_474_599)
        );
        assert_eq!(parse_rfc3339("2026-10-08"), None);
        assert_eq!(parse_rfc3339("soon"), None);
        assert_eq!(parse_rfc3339("2026-13-08T00:00:00Z"), None);
    }

    #[test]
    fn one_line_per_window_with_when_it_resets() {
        let now = parse_rfc3339("2026-10-08T11:00:00Z").unwrap();
        let answer = usage(
            r#"{"available":true,"reason":null,"plan":"pro","checked_at":"2026-10-08T11:00:00.000Z","error":null,"windows":[
              {"kind":"five_hour","model":null,"percent":2,"resets_at":"2026-10-08T15:50:00.000Z"},
              {"kind":"seven_day","model":null,"percent":91.4,"resets_at":"2026-10-11T02:00:00+00:00"},
              {"kind":"model","model":"Fable","percent":0.4,"resets_at":null},
              {"kind":"model","model":"Opus","percent":40,"resets_at":"2026-10-08T11:20:00Z"}]}"#,
        );
        assert_eq!(
            usage_lines(&answer, now),
            vec![
                "Claude 5 小时：2%（4 小时 50 分后重置）",
                "Claude 7 天：91%（2 天 15 小时后重置）",
                "Fable 7 天：<1%",
                "Opus 7 天：40%（20 分钟后重置）",
            ]
        );
    }

    #[test]
    fn several_accounts_each_under_its_name() {
        let now = parse_rfc3339("2026-10-08T11:00:00Z").unwrap();
        let answer = usage(
            r#"{"available":true,"windows":[{"kind":"five_hour","model":null,"percent":2,"resets_at":null}],"accounts":[
              {"available":true,"reason":null,"config_dir":null,"email":"pro@a.c","windows":[
                {"kind":"five_hour","model":null,"percent":2,"resets_at":null},
                {"kind":"seven_day","model":null,"percent":91,"resets_at":"2026-10-08T11:20:00Z"}]},
              {"available":true,"reason":null,"config_dir":"/Users/a/.claude-b","email":null,"windows":[
                {"kind":"five_hour","model":null,"percent":40,"resets_at":null},
                {"kind":"model","model":"Fable","percent":0.4,"resets_at":null}]},
              {"available":false,"reason":"signed_out","config_dir":"/Users/a/.claude-c","email":null,"windows":[]}]}"#,
        );
        assert_eq!(
            usage_lines(&answer, now),
            vec![
                "Claude · pro@a.c",
                "5 小时：2%",
                "7 天：91%（20 分钟后重置）",
                "Claude · /Users/a/.claude-b",
                "5 小时：40%",
                "Fable 7 天：<1%",
                "Claude · /Users/a/.claude-c：未登录",
            ]
        );
        // One account in the list reads as before.
        let one = usage(
            r#"{"available":true,"windows":[{"kind":"five_hour","model":null,"percent":2,"resets_at":null}],"accounts":[
              {"available":true,"config_dir":null,"email":"pro@a.c","windows":[{"kind":"five_hour","model":null,"percent":2,"resets_at":null}]}]}"#,
        );
        assert_eq!(usage_lines(&one, now), vec!["Claude 5 小时：2%"]);
    }

    #[test]
    fn nothing_to_show_is_no_lines() {
        let none = usage(
            r#"{"available":false,"reason":"unused","plan":null,"windows":[],"checked_at":null,"error":null}"#,
        );
        assert!(usage_lines(&none, 0).is_empty());
        assert_eq!(reset_text(30), "即将重置");
    }
}
