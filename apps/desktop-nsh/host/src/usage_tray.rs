//! What is used of your plans at the top of the menu bar extra's menu (ADR 0061, ADR 0079,
//! ADR 0080), transplanted from the Tauri shell's `usage_tray.rs`: one line per account, read from
//! the one `GET /v1/usage` the usage widget reads, asked once a minute. The daemon keeps each
//! answer for five minutes, so this starts at most one `claude` per five minutes, and none at all
//! until something runs on Claude Agent. An account with plan windows gets its agent's mark inside
//! a ring as full as what is used of its tightest window, and the 5-hour and 7-day numbers beside
//! its name; one signed out, or one that could not be read, says so beside its mark; agents that
//! only report today's records share one line. At most eight lines, then "查看全部用量…", which
//! shows a window and opens the usage tab (the messenger's `pane-command` `view-usage`, as the
//! Tauri tray sent it). The lines go away when the runtime's descriptor is gone.
//!
//! The words, their order and the icons are the Tauri shell's, function for function (the tests
//! came along); only the menu calls differ: AppKit's own, on the main thread. The agents' marks
//! and the menu bar's mark are read from the Tauri tree, where `apps/desktop/scripts/app-icon`
//! makes them, so there is one copy of each.

use std::cell::RefCell;
use std::f64::consts::TAU;
use std::path::PathBuf;
use std::time::Duration;

use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::NSObject;
use objc2::{AllocAnyThread, MainThreadMarker, MainThreadOnly, sel};
use objc2_app_kit::{NSControlStateValueOff, NSControlStateValueOn, NSImage, NSMenu, NSMenuItem};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextCreateImage, CGBitmapContextGetBytesPerRow, CGBitmapContextGetData,
    CGColorSpace, CGImageAlphaInfo,
};
use objc2_foundation::{NSSize, NSString};
use serde::Deserialize;

use crate::endpoint::Endpoint;

const POLL: Duration = Duration::from_secs(60);
/// Starting `claude` and its answer from claude.ai can take a while; the daemon gives up at 30 s.
const FETCH_TIMEOUT: Duration = Duration::from_secs(40);
/// Lines for accounts and today's records, before "查看全部用量…".
const MAX_LINES: usize = 8;

/// Menu icons are drawn at 18 pt; these are 36 px, for a Retina screen.
const ICON_PX: usize = 36;
const ICON_PT: f64 = 18.0;

/// The menu bar's mark in one ink (`apps/desktop/scripts/app-icon/tray.py`), 44 px for 22 pt: a
/// template image, so the menu bar tints it like its own items.
pub const MARK_PX: usize = 44;
pub const MARK_PT: f64 = 22.0;
pub const MARK: &[u8] = include_bytes!("../../../desktop/src-tauri/src/tray-template.rgba");

/// `GET /v1/usage` (ADR 0080): each agent something runs on, with its accounts.
#[derive(Debug, Default, Deserialize)]
pub struct UsageResponse {
    #[serde(default)]
    pub agents: Vec<UsageAgent>,
}

#[derive(Debug, Deserialize)]
pub struct UsageAgent {
    pub runner: String,
    pub label: String,
    #[serde(default)]
    pub today: UsageToday,
    #[serde(default)]
    pub accounts: Vec<UsageAccount>,
}

#[derive(Debug, Default, Deserialize)]
pub struct UsageToday {
    #[serde(default)]
    pub turns: i64,
}

#[derive(Debug, Deserialize)]
pub struct UsageAccount {
    #[serde(default)]
    pub config_dir: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    pub available: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub windows: Vec<UsageWindow>,
}

#[derive(Debug, Deserialize)]
pub struct UsageWindow {
    #[serde(default)]
    pub minutes: Option<f64>,
    #[serde(default)]
    pub model: Option<String>,
    pub percent: f64,
}

/// One row of the usage part of the menu.
#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    /// An account and how much is used of its tightest window: its agent's mark in a ring as full as that.
    Line { text: String, used: f64, level: Level, runner: String },
    /// An account that is signed out or could not be read, beside its agent's mark, with no ring.
    AgentNote { text: String, runner: String },
    /// A line with no icon: the agents' day here.
    Note(String),
    /// "查看全部用量…", last.
    All,
}

/// How full a window is, for its ring's colour: as the sidebar colours it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Level {
    Normal,
    Warn,
    Danger,
}

/// The menu the lines go into, what answers their clicks, and what is in it now.
struct Shown {
    menu: Retained<NSMenu>,
    target: Retained<NSObject>,
    entries: Vec<Entry>,
    /// How many items at the top of the menu are ours, the separator under them included.
    placed: usize,
}

thread_local! {
    // Main thread only: every menu call is made there.
    static SHOWN: RefCell<Option<Shown>> = const { RefCell::new(None) };
}

/// Puts the lines at the top of `menu` from now on; a line's click goes to `target`'s
/// `showWindow:`, "查看全部用量…" to its `showUsage:`. Then asks the runtime whose descriptor is
/// in `data_dir`, now and once a minute. Main thread.
pub fn start(menu: Retained<NSMenu>, target: Retained<NSObject>, data_dir: PathBuf) {
    SHOWN.with_borrow_mut(|shown| *shown = Some(Shown { menu, target, entries: Vec::new(), placed: 0 }));
    std::thread::spawn(move || loop {
        // The descriptor each time: a restarted runtime has a new token. A failed ask keeps the
        // lines already shown; the next minute asks again.
        let entries = match crate::endpoint::read(&data_dir) {
            Ok(endpoint) => fetch(&endpoint).map(|usage| usage_entries(&usage)),
            Err(_) => Some(Vec::new()),
        };
        if let Some(entries) = entries {
            DispatchQueue::main().exec_async(move || {
                if let Some(mtm) = MainThreadMarker::new() {
                    show(mtm, entries);
                }
            });
        }
        std::thread::sleep(POLL);
    });
}

fn fetch(endpoint: &Endpoint) -> Option<UsageResponse> {
    ureq::AgentBuilder::new()
        .timeout(FETCH_TIMEOUT)
        .build()
        .get(&format!("{}/v1/usage", endpoint.origin))
        .set("Authorization", &format!("Bearer {}", endpoint.token))
        .call()
        .ok()?
        .into_json()
        .ok()
}

fn text_of(entry: &Entry) -> &str {
    match entry {
        Entry::Line { text, .. } | Entry::AgentNote { text, .. } | Entry::Note(text) => text,
        Entry::All => "查看全部用量…",
    }
}

/// Puts `entries` at the top of the menu with a separator under them: changed in place when they
/// have the same shape as before (so an open menu does not jump), rebuilt otherwise, nothing at
/// all when there are none.
fn show(mtm: MainThreadMarker, entries: Vec<Entry>) {
    SHOWN.with_borrow_mut(|shown| {
        let Some(shown) = shown else { return };
        if shown.entries == entries {
            return;
        }
        let same_shape = shown.entries.len() == entries.len()
            && shown.entries.iter().zip(&entries).all(|(a, b)| std::mem::discriminant(a) == std::mem::discriminant(b));
        if same_shape && !entries.is_empty() {
            for (index, entry) in entries.iter().enumerate() {
                if let Some(item) = shown.menu.itemAtIndex(index as isize) {
                    item.setTitle(&NSString::from_str(text_of(entry)));
                    mark(&item, entry);
                }
            }
        } else {
            for _ in 0..shown.placed {
                shown.menu.removeItemAtIndex(0);
            }
            let mut at = 0;
            for entry in &entries {
                let action = if *entry == Entry::All { sel!(showUsage:) } else { sel!(showWindow:) };
                let item = unsafe {
                    NSMenuItem::initWithTitle_action_keyEquivalent(
                        NSMenuItem::alloc(mtm),
                        &NSString::from_str(text_of(entry)),
                        Some(action),
                        &NSString::new(),
                    )
                };
                // SAFETY: the target is the app delegate, which lives as long as the app.
                unsafe { item.setTarget(Some(&shown.target)) };
                mark(&item, entry);
                shown.menu.insertItem_atIndex(&item, at);
                at += 1;
            }
            if !entries.is_empty() {
                shown.menu.insertItem_atIndex(&NSMenuItem::separatorItem(mtm), at);
                at += 1;
            }
            shown.placed = at as usize;
        }
        log::info!("usage lines in the menu bar menu: {:?}", entries.iter().map(text_of).collect::<Vec<_>>());
        shown.entries = entries;
    });
}

/// macOS 27 draws no menu item's image, but it still draws the state column's: a line's icon goes
/// there, as the image of an "on" state (the Tauri shell's `mark_lines`).
fn mark(item: &NSMenuItem, entry: &Entry) {
    match icon_rgba(entry).and_then(|rgba| image_of(&rgba, ICON_PX, ICON_PT)) {
        Some(image) => {
            // SAFETY: an image for the item's on state, on the main thread, as AppKit asks.
            unsafe { item.setOnStateImage(Some(&image)) };
            item.setState(NSControlStateValueOn);
        }
        None => {
            // SAFETY: as above, clearing it.
            unsafe { item.setOnStateImage(None) };
            item.setState(NSControlStateValueOff);
        }
    }
}

/// Square straight-alpha RGBA, `px` on a side, as an image `points` on a side.
pub fn image_of(rgba: &[u8], px: usize, points: f64) -> Option<Retained<NSImage>> {
    if rgba.len() != px * px * 4 {
        return None;
    }
    let space = CGColorSpace::new_device_rgb()?;
    // SAFETY: CoreGraphics allocates the pixels itself (null data); the size and format are valid.
    let context = unsafe {
        CGBitmapContextCreate(std::ptr::null_mut(), px, px, 8, 0, Some(&space), CGImageAlphaInfo::PremultipliedLast.0)
    }?;
    let row = CGBitmapContextGetBytesPerRow(Some(&context));
    let data = CGBitmapContextGetData(Some(&context)).cast::<u8>();
    if data.is_null() || row < px * 4 {
        return None;
    }
    // SAFETY: the context's own buffer, `row` bytes for each of its `px` rows, alive with it.
    let pixels = unsafe { std::slice::from_raw_parts_mut(data, row * px) };
    for y in 0..px {
        for x in 0..px {
            let src = &rgba[(y * px + x) * 4..][..4];
            let dst = &mut pixels[y * row + x * 4..][..4];
            let alpha = u32::from(src[3]);
            for c in 0..3 {
                dst[c] = ((u32::from(src[c]) * alpha + 127) / 255) as u8;
            }
            dst[3] = src[3];
        }
    }
    let image = CGBitmapContextCreateImage(Some(&context))?;
    Some(NSImage::initWithCGImage_size(NSImage::alloc(), &image, NSSize::new(points, points)))
}

/// A line's icon as raw RGBA, `ICON_PX` square: its agent's mark in a ring, the mark alone, or none.
fn icon_rgba(entry: &Entry) -> Option<Vec<u8>> {
    match entry {
        Entry::Line { used, level, runner, .. } => Some(match logo_of(runner) {
            Some(logo) => logo_in_ring_rgba(Some((*used, *level)), logo),
            None => ring_rgba(*used, *level),
        }),
        Entry::AgentNote { runner, .. } => logo_of(runner).map(|logo| logo_in_ring_rgba(None, logo)),
        Entry::Note(_) | Entry::All => None,
    }
}

/// The usage part of the menu: a line per account with plan windows (`Claude Max · a@x.com　5h 62%
/// · 7d 81%`, the ring for the tightest window), a note for one signed out or unreadable, one
/// shared line for agents that only report today's turns; eight lines at most, then
/// "查看全部用量…". Nothing when there is nothing to show.
pub fn usage_entries(usage: &UsageResponse) -> Vec<Entry> {
    let mut lines = Vec::new();
    let mut today = Vec::new();
    for agent in &usage.agents {
        if agent.accounts.is_empty() {
            today.push(format!("{} {} 轮", agent.label, agent.today.turns));
            continue;
        }
        let several = agent.accounts.len() > 1;
        for account in &agent.accounts {
            let name = account_name(agent, account, several);
            let shown: Vec<&UsageWindow> = account.windows.iter().filter(|w| w.model.is_none()).collect();
            if account.available && !account.windows.is_empty() {
                let tightest = account.windows.iter().map(|w| w.percent).fold(f64::MIN, f64::max);
                let mut shown = shown;
                shown.sort_by(|a, b| a.minutes.unwrap_or(f64::MAX).total_cmp(&b.minutes.unwrap_or(f64::MAX)));
                let summary: Vec<String> = if shown.is_empty() {
                    // Only per-model windows (Antigravity's model groups): each group by its tightest.
                    let mut groups: Vec<&str> = Vec::new();
                    for w in &account.windows {
                        if let Some(model) = w.model.as_deref()
                            && !groups.contains(&model)
                        {
                            groups.push(model);
                        }
                    }
                    groups
                        .iter()
                        .map(|model| {
                            let used = account
                                .windows
                                .iter()
                                .filter(|w| w.model.as_deref() == Some(*model))
                                .map(|w| w.percent)
                                .fold(f64::MIN, f64::max);
                            format!("{model} {}", used_text(used))
                        })
                        .collect()
                } else {
                    shown.iter().map(|w| format!("{} {}", window_span(w.minutes), used_text(w.percent))).collect()
                };
                let text = if summary.is_empty() { name } else { format!("{name}　{}", summary.join(" · ")) };
                lines.push(Entry::Line {
                    text,
                    used: tightest.clamp(0.0, 100.0),
                    level: level_of(tightest),
                    runner: agent.runner.clone(),
                });
            } else if !account.available {
                match account.reason.as_deref() {
                    Some("signed_out") => {
                        lines.push(Entry::AgentNote { text: format!("{name}　未登录"), runner: agent.runner.clone() })
                    }
                    Some("failed") => {
                        lines.push(Entry::AgentNote { text: format!("{name}　没查到用量"), runner: agent.runner.clone() })
                    }
                    _ => {}
                }
            }
        }
    }
    let today_line = (!today.is_empty()).then(|| Entry::Note(today.join(" · ")));
    lines.truncate(MAX_LINES - usize::from(today_line.is_some()));
    lines.extend(today_line);
    if !lines.is_empty() {
        lines.push(Entry::All);
    }
    lines
}

/// The last part of a directory path: `/Users/a/.claude-b` is `.claude-b`.
fn dir_name(dir: &str) -> Option<&str> {
    dir.rsplit(['/', '\\']).find(|part| !part.is_empty())
}

/// An account's name: Claude by its plan and who it is (`Claude Max · a@x.com`), the others by
/// their name and plan, with the directory only when the agent has several accounts to tell apart.
fn account_name(agent: &UsageAgent, account: &UsageAccount, several: bool) -> String {
    let plan = account.plan.as_deref().map(plan_name).unwrap_or_default();
    let dir = account.config_dir.as_deref().and_then(dir_name);
    let mut name = if agent.runner == "claude_code" { "Claude".to_string() } else { agent.label.clone() };
    if !plan.is_empty() {
        name = format!("{name} {plan}");
    }
    if agent.runner == "claude_code" {
        if let Some(who) = account.email.as_deref().or(dir) {
            name = format!("{name} · {who}");
        }
    } else if let (true, Some(dir)) = (several, dir) {
        name = format!("{name} · {dir}");
    }
    name
}

/// A window's length in the menu's words: `5h`, `7d`, `30m`.
fn window_span(minutes: Option<f64>) -> String {
    match minutes {
        Some(m) if m == 300.0 => "5h".to_string(),
        Some(m) if m == 10080.0 => "7d".to_string(),
        Some(m) if m >= 1440.0 => format!("{}d", (m / 1440.0).round() as i64),
        Some(m) if m >= 60.0 => format!("{}h", (m / 60.0).round() as i64),
        Some(m) => format!("{}m", m.round() as i64),
        None => "窗口".to_string(),
    }
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

/// Each agent's mark, cut round, as raw RGBA at `LOGO_PX`: rendered once from the messenger's
/// `AgentLogo.svelte` at twice its 13 px.
const LOGO_PX: usize = 26;

fn logo_of(runner: &str) -> Option<&'static [u8]> {
    Some(match runner {
        "claude_code" => include_bytes!("../../../desktop/src-tauri/src/agent-logos/claude_code.rgba"),
        "codex" => include_bytes!("../../../desktop/src-tauri/src/agent-logos/codex.rgba"),
        "grok" => include_bytes!("../../../desktop/src-tauri/src/agent-logos/grok.rgba"),
        "opencode" => include_bytes!("../../../desktop/src-tauri/src/agent-logos/opencode.rgba"),
        "antigravity" => include_bytes!("../../../desktop/src-tauri/src/agent-logos/antigravity.rgba"),
        "zcode" => include_bytes!("../../../desktop/src-tauri/src/agent-logos/zcode.rgba"),
        "custom" => include_bytes!("../../../desktop/src-tauri/src/agent-logos/custom.rgba"),
        _ => return None,
    })
}

/// An agent's mark in the middle of the icon, inside a thin ring as full as what is used (`ring`),
/// or alone when there is no window to show.
fn logo_in_ring_rgba(ring: Option<(f64, Level)>, logo: &[u8]) -> Vec<u8> {
    let size = ICON_PX;
    let mut rgba = match ring {
        Some((used, level)) => ring_pixels(used, level, 17.5, 15.0),
        None => vec![0u8; size * size * 4],
    };
    let offset = (size - LOGO_PX) / 2;
    for y in 0..LOGO_PX {
        for x in 0..LOGO_PX {
            let from = (y * LOGO_PX + x) * 4;
            let Some(src) = logo.get(from..from + 4) else { continue };
            let a = src[3] as f64 / 255.0;
            if a == 0.0 {
                continue;
            }
            let at = ((y + offset) * size + x + offset) * 4;
            let dst = &mut rgba[at..at + 4];
            let da = dst[3] as f64 / 255.0;
            let out = a + da * (1.0 - a);
            for c in 0..3 {
                dst[c] = ((src[c] as f64 * a + dst[c] as f64 * da * (1.0 - a)) / out).round() as u8;
            }
            dst[3] = (out * 255.0).round() as u8;
        }
    }
    rgba
}

fn ring_rgba(used: f64, level: Level) -> Vec<u8> {
    ring_pixels(used, level, 13.0, 9.0)
}

/// A ring between `outer` and `inner` radii filled clockwise from twelve o'clock as far as `used`
/// percent, the rest a faint track, as `ICON_PX` RGBA. The colours read on a light and a dark menu
/// alike: the icon is not a template image, so it does not take the menu's own colour.
fn ring_pixels(used: f64, level: Level, outer: f64, inner: f64) -> Vec<u8> {
    let (r, g, b) = match level {
        Level::Normal => (0x8b, 0x98, 0x9e),
        Level::Warn => (0xf5, 0x9e, 0x0b),
        Level::Danger => (0xef, 0x44, 0x44),
    };
    let size = ICON_PX;
    let center = size as f64 / 2.0;
    let sweep = used.clamp(0.0, 100.0) / 100.0 * TAU;
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

/// What is used of a window: rounded down, so a window not yet spent never reads 100%, and `<1%`
/// for a sliver, so one in use never reads 0%.
fn used_text(used: f64) -> String {
    let used = used.clamp(0.0, 100.0);
    if used > 0.0 && used < 1.0 {
        return "<1%".to_string();
    }
    format!("{}%", used.floor() as i64)
}

/// `pro` or `claude max` as Claude names the plan: `Pro`, `Max`.
fn plan_name(plan: &str) -> String {
    let plan = plan.trim();
    let plan = plan.strip_prefix("claude ").or_else(|| plan.strip_prefix("Claude ")).unwrap_or(plan).trim();
    let mut chars = plan.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(json: &str) -> UsageResponse {
        serde_json::from_str(json).unwrap()
    }

    fn texts(entries: &[Entry]) -> Vec<String> {
        entries
            .iter()
            .map(|entry| match entry {
                Entry::Line { text, .. } => format!("[ring] {text}"),
                Entry::AgentNote { text, .. } | Entry::Note(text) => format!("[note] {text}"),
                Entry::All => "[all]".to_string(),
            })
            .collect()
    }

    const CLAUDE: &str = r#"{"runner":"claude_code","custom_id":null,"label":"Claude Agent","today":{"turns":5,"tokens":9,"estimated_usd":0},"accounts":[
      {"config_dir":"/Users/a/.claude","email":"a@x.com","available":true,"reason":null,"plan":"claude max","credits":null,
       "windows":[{"minutes":10080,"model":null,"percent":19,"resets_at":null},
                  {"minutes":300,"model":null,"percent":38,"resets_at":null},
                  {"minutes":10080,"model":"Opus","percent":96,"resets_at":null}]}]}"#;

    #[test]
    fn claude_one_line_with_email_and_the_tightest_ring() {
        let entries = usage_entries(&usage(&format!(r#"{{"agents":[{CLAUDE}]}}"#)));
        // Shortest window first; Opus's own window is not in the text, but it is the tightest ring.
        assert_eq!(texts(&entries), vec!["[ring] Claude Max · a@x.com　5h 38% · 7d 19%", "[all]"]);
        match &entries[0] {
            Entry::Line { used, level, .. } => {
                assert_eq!(*used, 96.0);
                assert_eq!(*level, Level::Danger);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn claude_without_email_names_its_directory() {
        let answer = usage(
            r#"{"agents":[{"runner":"claude_code","label":"Claude Agent","today":{"turns":0,"tokens":0,"estimated_usd":0},"accounts":[
              {"config_dir":"/Users/a/.claude-b","email":null,"available":true,"plan":null,"windows":[{"minutes":300,"model":null,"percent":0.4}]}]}]}"#,
        );
        assert_eq!(texts(&usage_entries(&answer)), vec!["[ring] Claude · .claude-b　5h <1%", "[all]"]);
    }

    #[test]
    fn codex_its_plan_and_its_directory_only_among_several() {
        let one = usage(
            r#"{"agents":[{"runner":"codex","label":"Codex","today":{"turns":2},"accounts":[
              {"config_dir":"/Users/a/.codex","available":true,"plan":"plus","windows":[{"minutes":300,"model":null,"percent":12.4},{"minutes":43200,"model":null,"percent":80}]}]}]}"#,
        );
        assert_eq!(texts(&usage_entries(&one)), vec!["[ring] Codex Plus　5h 12% · 30d 80%", "[all]"]);
        let two = usage(
            r#"{"agents":[{"runner":"codex","label":"Codex","accounts":[
              {"config_dir":"/Users/a/.codex","available":true,"plan":"plus","windows":[{"minutes":300,"model":null,"percent":10}]},
              {"config_dir":"/Users/a/.codex-work","available":true,"plan":"pro","windows":[{"minutes":300,"model":null,"percent":50}]}]}]}"#,
        );
        assert_eq!(
            texts(&usage_entries(&two)),
            vec!["[ring] Codex Plus · .codex　5h 10%", "[ring] Codex Pro · .codex-work　5h 50%", "[all]"]
        );
    }

    #[test]
    fn signed_out_and_unreadable_accounts_say_so_the_rest_say_nothing() {
        let answer = usage(
            r#"{"agents":[{"runner":"claude_code","label":"Claude Agent","accounts":[
              {"config_dir":"/Users/a/.claude-c","email":null,"available":false,"reason":"signed_out","plan":null,"windows":[]},
              {"config_dir":"/Users/a/.claude-d","email":"d@x.com","available":false,"reason":"failed","plan":null,"windows":[]},
              {"config_dir":"/Users/a/.claude-e","email":null,"available":false,"reason":"no_plan","plan":null,"windows":[]},
              {"config_dir":null,"email":null,"available":false,"reason":null,"plan":null,"windows":[]}]}]}"#,
        );
        assert_eq!(
            texts(&usage_entries(&answer)),
            vec!["[note] Claude · .claude-c　未登录", "[note] Claude · d@x.com　没查到用量", "[all]"]
        );
    }

    #[test]
    fn agents_with_only_a_day_share_one_line() {
        let answer = usage(
            r#"{"agents":[
              {"runner":"grok","label":"Grok","today":{"turns":12,"tokens":1},"accounts":[]},
              {"runner":"antigravity","label":"Antigravity","today":{"turns":0,"tokens":0},"accounts":[]},
              {"runner":"opencode","label":"OpenCode","today":{"turns":3,"tokens":1},"accounts":[]}]}"#,
        );
        assert_eq!(texts(&usage_entries(&answer)), vec!["[note] Grok 12 轮 · Antigravity 0 轮 · OpenCode 3 轮", "[all]"]);
    }

    #[test]
    fn eight_lines_at_most_the_day_line_kept() {
        let account = r#"{"config_dir":null,"email":"e@x.com","available":true,"plan":"pro","windows":[{"minutes":300,"model":null,"percent":10}]}"#;
        let accounts = vec![account; 9].join(",");
        let answer = usage(&format!(
            r#"{{"agents":[{{"runner":"claude_code","label":"Claude Agent","accounts":[{accounts}]}},
              {{"runner":"grok","label":"Grok","today":{{"turns":1}},"accounts":[]}}]}}"#
        ));
        let lines = texts(&usage_entries(&answer));
        assert_eq!(lines.len(), 9);
        assert_eq!(lines[7], "[note] Grok 1 轮");
        assert_eq!(lines[8], "[all]");
        assert_eq!(lines.iter().filter(|l| l.starts_with("[ring]")).count(), 7);
        // Without a day line, eight accounts.
        let only =
            usage(&format!(r#"{{"agents":[{{"runner":"claude_code","label":"Claude Agent","accounts":[{accounts}]}}]}}"#));
        assert_eq!(usage_entries(&only).len(), 9);
    }

    #[test]
    fn model_groups_only_each_group_by_its_tightest() {
        let answer = usage(
            r#"{"agents":[{"runner":"antigravity","label":"Antigravity","accounts":[{"config_dir":null,"available":true,"windows":[
              {"minutes":10080,"model":"Gemini Models","percent":2},{"minutes":300,"model":"Gemini Models","percent":3},
              {"minutes":10080,"model":"Claude and GPT models","percent":13},{"minutes":300,"model":"Claude and GPT models","percent":0}]}]}]}"#,
        );
        assert_eq!(
            texts(&usage_entries(&answer)),
            vec!["[ring] Antigravity　Gemini Models 3% · Claude and GPT models 13%", "[all]"]
        );
    }

    #[test]
    fn every_agent_has_its_mark_and_a_line_wears_it_inside_its_ring() {
        for runner in ["claude_code", "codex", "grok", "opencode", "antigravity", "zcode", "custom"] {
            assert_eq!(logo_of(runner).map(<[u8]>::len), Some(LOGO_PX * LOGO_PX * 4), "{runner}");
        }
        assert!(logo_of("someone_else").is_none());
        let logo = logo_of("grok").unwrap();
        let icon = logo_in_ring_rgba(Some((50.0, Level::Normal)), logo);
        let px = |x: usize, y: usize| &icon[(y * ICON_PX + x) * 4..][..4];
        // Grok's mark is black in the middle; the ring is drawn outside it; the corners are clear.
        assert_eq!(&px(18, 18)[3], &255);
        assert!(px(18, 18)[0] < 40);
        assert!(px(18, 1)[3] > 0);
        assert_eq!(px(0, 0)[3], 0);
        let entries = usage_entries(&usage(&format!(r#"{{"agents":[{CLAUDE}]}}"#)));
        assert!(matches!(&entries[0], Entry::Line { runner, .. } if runner == "claude_code"));
    }

    #[test]
    fn nothing_to_show_is_no_lines() {
        assert!(usage_entries(&UsageResponse::default()).is_empty());
        let none = usage(
            r#"{"agents":[{"runner":"codex","label":"Codex","accounts":[{"available":false,"reason":"no_plan","windows":[]}]}]}"#,
        );
        assert!(usage_entries(&none).is_empty());
        // A connected agent with no turns today is still listed.
        let idle = usage(r#"{"agents":[{"runner":"grok","label":"Grok","today":{"turns":0},"accounts":[]}]}"#);
        assert_eq!(texts(&usage_entries(&idle)), vec!["[note] Grok 0 轮", "[all]"]);
    }

    #[test]
    fn windows_are_named_by_their_length() {
        assert_eq!(window_span(Some(300.0)), "5h");
        assert_eq!(window_span(Some(10080.0)), "7d");
        assert_eq!(window_span(Some(120.0)), "2h");
        assert_eq!(window_span(Some(30.0)), "30m");
        assert_eq!(window_span(None), "窗口");
    }

    #[test]
    fn the_ring_is_as_full_as_what_is_used() {
        let alpha = |rgba: &[u8], x: usize, y: usize| rgba[(y * 36 + x) * 4 + 3];
        // Twelve o'clock, three, six and nine, on the ring's middle.
        let full = ring_rgba(100.0, Level::Normal);
        let quarter = ring_rgba(30.0, Level::Danger);
        let empty = ring_rgba(0.0, Level::Normal);
        assert_eq!(alpha(&full, 18, 6), 255);
        assert_eq!(alpha(&full, 6, 18), 255);
        assert_eq!(alpha(&quarter, 29, 18), 255);
        assert_eq!(&quarter[(18 * 36 + 29) * 4..(18 * 36 + 29) * 4 + 3], &[0xef, 0x44, 0x44]);
        assert!(alpha(&quarter, 18, 29) < 100 && alpha(&quarter, 18, 29) > 0);
        assert!(alpha(&empty, 18, 6) < 100);
        // Nothing drawn outside the ring.
        assert_eq!(alpha(&full, 18, 18), 0);
        assert_eq!(alpha(&full, 0, 0), 0);
    }

    #[test]
    fn icons_and_the_menu_bar_mark_become_images_of_their_size() {
        let ring = icon_rgba(&Entry::Line { text: String::new(), used: 40.0, level: Level::Warn, runner: "codex".into() })
            .unwrap();
        let image = image_of(&ring, ICON_PX, ICON_PT).expect("a line's icon");
        assert_eq!((image.size().width, image.size().height), (ICON_PT, ICON_PT));
        assert_eq!(MARK.len(), MARK_PX * MARK_PX * 4);
        let mark = image_of(MARK, MARK_PX, MARK_PT).expect("the menu bar's mark");
        assert_eq!(mark.size().width, MARK_PT);
        // The wrong number of bytes is no image, not a read past the end.
        assert!(image_of(&ring[..ring.len() - 4], ICON_PX, ICON_PT).is_none());
        assert!(icon_rgba(&Entry::All).is_none());
    }
}
