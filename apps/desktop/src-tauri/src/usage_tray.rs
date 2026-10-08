//! What is left of your Claude plan at the top of the menu bar menu (ADR 0061): the same
//! `GET /v1/claude-usage` the sidebar reads, asked once a minute while the daemon is up. The
//! daemon keeps each answer for five minutes, so this starts at most one `claude` per five
//! minutes, and none at all until a Bot runs on Claude Agent. Each account is a group of its own,
//! set off by separators: its name under Claude's mark, then a line per window with a ring as full
//! as what is left of it. The lines go away when there is nothing to show; a click on one shows
//! the window.

use serde::Deserialize;
use std::f64::consts::TAU;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::image::Image;
use tauri::menu::{IconMenuItem, Menu, PredefinedMenuItem};
use tauri::{AppHandle, Manager, Wry};

use crate::supervisor::Endpoint;

const POLL: Duration = Duration::from_secs(60);
/// Starting `claude` and its answer from claude.ai can take a while; the daemon gives up at 30 s.
const FETCH_TIMEOUT: Duration = Duration::from_secs(40);
pub const ITEM_PREFIX: &str = "usage-";

/// Menu icons are drawn at 18 pt; these are 36 px, for a Retina screen.
const ICON_PX: u32 = 36;
/// Anthropic's Claude Spark in its own colour (as `ClaudeSpark.svelte` draws it), 30 px inside a
/// transparent 36 px square, as raw RGBA: rendered from that SVG path once, since a menu icon
/// takes pixels and this crate has no image decoder.
static CLAUDE_SPARK: &[u8] = include_bytes!("claude-spark-36.rgba");

#[derive(Debug, Deserialize)]
pub struct Usage {
    pub available: bool,
    #[serde(default)]
    pub plan: Option<String>,
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
    pub plan: Option<String>,
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

/// One row of the usage part of the menu.
#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    /// An account's name, under Claude's mark.
    Account(String),
    /// A window and how much of it is left, under a ring as full as that.
    Window {
        text: String,
        left: f64,
        level: Level,
    },
    Separator,
}

/// How full a window is, for its ring's colour: as the sidebar colours it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Level {
    Normal,
    Warn,
    Danger,
}

enum Placed {
    Item(IconMenuItem<Wry>),
    Separator(PredefinedMenuItem<Wry>),
}

#[derive(Default)]
struct Shown {
    menu: Option<Menu<Wry>>,
    /// What is in the menu now, the separator under the last group included.
    placed: Vec<Placed>,
    entries: Vec<Entry>,
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
        let entries = match endpoint(&handle) {
            // A failed ask keeps the lines already shown; the next minute asks again.
            Some(endpoint) => match fetch(&endpoint) {
                Some(usage) => usage_entries(&usage, now_secs()),
                None => current_entries(&handle),
            },
            None => Vec::new(),
        };
        show(&handle, entries);
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

fn current_entries(app: &AppHandle) -> Vec<Entry> {
    let state = app.state::<UsageTray>();
    let entries = state
        .0
        .lock()
        .map(|s| s.entries.clone())
        .unwrap_or_default();
    entries
}

fn icon_of(entry: &Entry) -> Option<Image<'static>> {
    match entry {
        Entry::Account(_) => Some(Image::new(CLAUDE_SPARK, ICON_PX, ICON_PX)),
        Entry::Window { left, level, .. } => {
            Some(Image::new_owned(ring_rgba(*left, *level), ICON_PX, ICON_PX))
        }
        Entry::Separator => None,
    }
}

fn text_of(entry: &Entry) -> &str {
    match entry {
        Entry::Account(text) | Entry::Window { text, .. } => text,
        Entry::Separator => "",
    }
}

/// Puts `entries` at the top of the menu with a separator under them: changed in place when they
/// have the same shape as before (so an open menu does not jump), rebuilt otherwise, nothing at
/// all when there are none.
fn show(app: &AppHandle, entries: Vec<Entry>) {
    let state = app.state::<UsageTray>();
    let Ok(mut shown) = state.0.lock() else {
        return;
    };
    if shown.entries == entries {
        return;
    }
    let Some(menu) = shown.menu.clone() else {
        return;
    };
    let same_shape = shown.entries.len() == entries.len()
        && shown
            .entries
            .iter()
            .zip(&entries)
            .all(|(a, b)| std::mem::discriminant(a) == std::mem::discriminant(b));
    if same_shape && !entries.is_empty() {
        for (placed, entry) in shown.placed.iter().zip(&entries) {
            if let Placed::Item(item) = placed {
                let _ = item.set_text(text_of(entry));
                let _ = item.set_icon(icon_of(entry));
            }
        }
    } else {
        for placed in shown.placed.drain(..) {
            let _ = match placed {
                Placed::Item(item) => menu.remove(&item),
                Placed::Separator(separator) => menu.remove(&separator),
            };
        }
        let mut position = 0;
        for (i, entry) in entries.iter().enumerate() {
            let placed = match entry {
                Entry::Separator => PredefinedMenuItem::separator(app)
                    .ok()
                    .map(Placed::Separator),
                _ => IconMenuItem::with_id(
                    app,
                    format!("{ITEM_PREFIX}{i}"),
                    text_of(entry),
                    true,
                    icon_of(entry),
                    None::<&str>,
                )
                .ok()
                .map(Placed::Item),
            };
            let Some(placed) = placed else { continue };
            let inserted = match &placed {
                Placed::Item(item) => menu.insert(item, position),
                Placed::Separator(separator) => menu.insert(separator, position),
            };
            if inserted.is_ok() {
                shown.placed.push(placed);
                position += 1;
            }
        }
        if !entries.is_empty() {
            if let Ok(separator) = PredefinedMenuItem::separator(app) {
                if menu.insert(&separator, position).is_ok() {
                    shown.placed.push(Placed::Separator(separator));
                }
            }
        }
    }
    shown.entries = entries;
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The usage part of the menu: a group per account some Bot runs on, set off by separators, each
/// its name under Claude's mark (`Claude Pro · you@example.com`; one signed out says so there and
/// has no windows), then a line per window — the plan's own first, as the daemon orders them —
/// with how much of it is left and when it starts over. Nothing when no account has windows.
pub fn usage_entries(usage: &Usage, now: i64) -> Vec<Entry> {
    // A daemon older than accounts answers for one, with no name to give it.
    let single;
    let accounts: Vec<&AccountUsage> = if usage.accounts.is_empty() {
        single = AccountUsage {
            available: usage.available,
            reason: None,
            windows: Vec::new(),
            plan: usage.plan.clone(),
            email: None,
            config_dir: None,
        };
        vec![&single]
    } else {
        usage.accounts.iter().collect()
    };
    let windows_of = |index: usize| -> &[UsageWindow] {
        if usage.accounts.is_empty() {
            &usage.windows
        } else {
            &usage.accounts[index].windows
        }
    };
    if !accounts.iter().any(|account| account.available) {
        return Vec::new();
    }
    let several = accounts.len() > 1;
    let mut entries = Vec::new();
    for (index, account) in accounts.iter().enumerate() {
        let signed_out = account.reason.as_deref() == Some("signed_out");
        if !account.available && !signed_out {
            continue;
        }
        if !entries.is_empty() {
            entries.push(Entry::Separator);
        }
        let plan = account.plan.as_deref().map(plan_name).unwrap_or_default();
        let who = account
            .email
            .as_deref()
            .or(account.config_dir.as_deref())
            .or(several.then_some("默认账号"));
        let name = match (plan.is_empty(), who) {
            (false, Some(who)) => format!("Claude {plan} · {who}"),
            (false, None) => format!("Claude {plan}"),
            (true, Some(who)) => format!("Claude · {who}"),
            (true, None) => "Claude".to_string(),
        };
        if account.available {
            entries.push(Entry::Account(name));
            entries.extend(window_entries(windows_of(index), now));
        } else {
            entries.push(Entry::Account(format!("{name}：未登录")));
        }
    }
    entries
}

/// A line per window with how much of it is left; a model's own weekly window is named for it.
fn window_entries(windows: &[UsageWindow], now: i64) -> Vec<Entry> {
    windows
        .iter()
        .map(|window| {
            let name = match window.kind.as_str() {
                "five_hour" => "5 小时".to_string(),
                "seven_day" => "7 天".to_string(),
                _ => format!("{} 7 天", window.model.as_deref().unwrap_or("Claude")),
            };
            let left = left_text(window.percent);
            let text = match window.resets_at.as_deref().and_then(parse_rfc3339) {
                Some(at) => format!("{name}：剩 {left}（{}）", reset_text(at - now)),
                None => format!("{name}：剩 {left}"),
            };
            Entry::Window {
                text,
                left: (100.0 - window.percent).clamp(0.0, 100.0),
                level: level_of(window.percent),
            }
        })
        .collect()
}

/// Worth a look from three quarters used, nearly gone from nine tenths, as in the sidebar.
fn level_of(used: f64) -> Level {
    if used >= 90.0 {
        Level::Danger
    } else if used >= 75.0 {
        Level::Warn
    } else {
        Level::Normal
    }
}

/// A ring filled clockwise from twelve o'clock as far as `left` percent, the rest a faint track,
/// as 36 px RGBA. The colours read on a light and a dark menu alike: a menu icon cannot be a
/// template image here, so it does not take the menu's own colour.
fn ring_rgba(left: f64, level: Level) -> Vec<u8> {
    let (r, g, b) = match level {
        Level::Normal => (0x8b, 0x98, 0x9e),
        Level::Warn => (0xf5, 0x9e, 0x0b),
        Level::Danger => (0xef, 0x44, 0x44),
    };
    let size = ICON_PX as usize;
    let center = size as f64 / 2.0;
    let (outer, inner) = (13.0, 9.0);
    let sweep = left.clamp(0.0, 100.0) / 100.0 * TAU;
    let mut rgba = vec![0u8; size * size * 4];
    for y in 0..size {
        for x in 0..size {
            // Sixteen samples a pixel, so the edges are smooth.
            let (mut filled, mut track) = (0u32, 0u32);
            for sy in 0..4 {
                for sx in 0..4 {
                    let dx = x as f64 + (sx as f64 + 0.5) / 4.0 - center;
                    let dy = y as f64 + (sy as f64 + 0.5) / 4.0 - center;
                    let distance = (dx * dx + dy * dy).sqrt();
                    if distance < inner || distance > outer {
                        continue;
                    }
                    let mut angle = dx.atan2(-dy);
                    if angle < 0.0 {
                        angle += TAU;
                    }
                    if angle < sweep {
                        filled += 1;
                    } else {
                        track += 1;
                    }
                }
            }
            let alpha = (filled as f64 + track as f64 * 0.35) / 16.0 * 255.0;
            if alpha > 0.0 {
                let at = (y * size + x) * 4;
                rgba[at..at + 4].copy_from_slice(&[r, g, b, alpha.round() as u8]);
            }
        }
    }
    rgba
}

/// What is left of a window from how much is used: rounded down, so a window in use never reads
/// 100%, and `<1%` for a sliver.
fn left_text(used: f64) -> String {
    let left = (100.0 - used).clamp(0.0, 100.0);
    if left > 0.0 && left < 1.0 {
        return "<1%".to_string();
    }
    format!("{}%", left.floor() as i64)
}

/// `pro` or `claude max` as Claude names the plan: `Pro`, `Max`.
fn plan_name(plan: &str) -> String {
    let plan = plan.trim();
    let plan = plan
        .strip_prefix("claude ")
        .or_else(|| plan.strip_prefix("Claude "))
        .unwrap_or(plan)
        .trim();
    let mut chars = plan.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
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

    fn texts(entries: &[Entry]) -> Vec<String> {
        entries
            .iter()
            .map(|entry| match entry {
                Entry::Account(text) => format!("[Claude] {text}"),
                Entry::Window { text, .. } => format!("[ring] {text}"),
                Entry::Separator => "---".to_string(),
            })
            .collect()
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
    fn one_account_its_name_then_what_is_left_of_each_window() {
        let now = parse_rfc3339("2026-10-08T11:00:00Z").unwrap();
        // As a daemon older than accounts answers: no name beyond the plan.
        let answer = usage(
            r#"{"available":true,"reason":null,"plan":"pro","checked_at":"2026-10-08T11:00:00.000Z","error":null,"windows":[
              {"kind":"five_hour","model":null,"percent":2,"resets_at":"2026-10-08T15:50:00.000Z"},
              {"kind":"seven_day","model":null,"percent":91.4,"resets_at":"2026-10-11T02:00:00+00:00"},
              {"kind":"model","model":"Fable","percent":0.4,"resets_at":null},
              {"kind":"model","model":"Opus","percent":76,"resets_at":"2026-10-08T11:20:00Z"}]}"#,
        );
        let entries = usage_entries(&answer, now);
        assert_eq!(
            texts(&entries),
            vec![
                "[Claude] Claude Pro",
                "[ring] 5 小时：剩 98%（4 小时 50 分后重置）",
                "[ring] 7 天：剩 8%（2 天 15 小时后重置）",
                "[ring] Fable 7 天：剩 99%",
                "[ring] Opus 7 天：剩 24%（20 分钟后重置）",
            ]
        );
        let levels: Vec<Level> = entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::Window { level, .. } => Some(*level),
                _ => None,
            })
            .collect();
        assert_eq!(
            levels,
            vec![Level::Normal, Level::Danger, Level::Normal, Level::Warn]
        );
    }

    #[test]
    fn each_account_a_group_of_its_own() {
        let now = parse_rfc3339("2026-10-08T11:00:00Z").unwrap();
        let answer = usage(
            r#"{"available":true,"windows":[{"kind":"five_hour","model":null,"percent":2,"resets_at":null}],"accounts":[
              {"available":true,"reason":null,"config_dir":null,"plan":"pro","email":"pro@a.c","windows":[
                {"kind":"five_hour","model":null,"percent":2,"resets_at":null},
                {"kind":"seven_day","model":null,"percent":91,"resets_at":"2026-10-08T11:20:00Z"}]},
              {"available":true,"reason":null,"config_dir":"/Users/a/.claude-b","plan":"claude team","email":null,"windows":[
                {"kind":"five_hour","model":null,"percent":40,"resets_at":null},
                {"kind":"model","model":"Fable","percent":99.6,"resets_at":null}]},
              {"available":false,"reason":"signed_out","config_dir":"/Users/a/.claude-c","email":null,"windows":[]},
              {"available":false,"reason":"failed","config_dir":"/Users/a/.claude-d","email":null,"windows":[]}]}"#,
        );
        assert_eq!(
            texts(&usage_entries(&answer, now)),
            vec![
                "[Claude] Claude Pro · pro@a.c",
                "[ring] 5 小时：剩 98%",
                "[ring] 7 天：剩 9%（20 分钟后重置）",
                "---",
                "[Claude] Claude Team · /Users/a/.claude-b",
                "[ring] 5 小时：剩 60%",
                "[ring] Fable 7 天：剩 <1%",
                "---",
                "[Claude] Claude · /Users/a/.claude-c：未登录",
            ]
        );
        // One account in the list reads as before, under its name.
        let one = usage(
            r#"{"available":true,"windows":[],"accounts":[
              {"available":true,"config_dir":null,"plan":"max","email":"me@a.c","windows":[{"kind":"five_hour","model":null,"percent":2,"resets_at":null}]}]}"#,
        );
        assert_eq!(
            texts(&usage_entries(&one, now)),
            vec!["[Claude] Claude Max · me@a.c", "[ring] 5 小时：剩 98%"]
        );
    }

    #[test]
    fn nothing_to_show_is_no_lines() {
        let none = usage(
            r#"{"available":false,"reason":"unused","plan":null,"windows":[],"checked_at":null,"error":null,"accounts":[]}"#,
        );
        assert!(usage_entries(&none, 0).is_empty());
        let out = usage(
            r#"{"available":false,"windows":[],"accounts":[{"available":false,"reason":"signed_out","windows":[]}]}"#,
        );
        assert!(usage_entries(&out, 0).is_empty());
        assert_eq!(reset_text(30), "即将重置");
    }

    #[test]
    fn the_ring_is_as_full_as_what_is_left() {
        let alpha = |rgba: &[u8], x: usize, y: usize| rgba[(y * 36 + x) * 4 + 3];
        // Twelve o'clock, three, six and nine, on the ring's middle.
        let full = ring_rgba(100.0, Level::Normal);
        let quarter = ring_rgba(30.0, Level::Danger);
        let empty = ring_rgba(0.0, Level::Normal);
        assert_eq!(alpha(&full, 18, 6), 255);
        assert_eq!(alpha(&full, 6, 18), 255);
        assert_eq!(alpha(&quarter, 29, 18), 255);
        assert_eq!(
            &quarter[(18 * 36 + 29) * 4..(18 * 36 + 29) * 4 + 3],
            &[0xef, 0x44, 0x44]
        );
        assert!(alpha(&quarter, 18, 29) < 100 && alpha(&quarter, 18, 29) > 0);
        assert!(alpha(&empty, 18, 6) < 100);
        // Nothing drawn outside the ring.
        assert_eq!(alpha(&full, 18, 18), 0);
        assert_eq!(alpha(&full, 0, 0), 0);
    }

    #[test]
    fn claudes_mark_is_a_36_px_square() {
        assert_eq!(CLAUDE_SPARK.len(), 36 * 36 * 4);
        assert_eq!(
            &CLAUDE_SPARK[(18 * 36 + 18) * 4..(18 * 36 + 18) * 4 + 4],
            &[217, 119, 87, 255]
        );
        assert_eq!(CLAUDE_SPARK[3], 0);
    }
}
