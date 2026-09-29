//! Check GitHub Releases for a newer Deskfolk build and cache the result.
//!
//! All network access happens here, off the webview (the CSP `connect-src`
//! only allows the loopback local API). `fetch_releases` does the HTTP call;
//! `pick_update` is pure and does the semver comparison so it can be unit
//! tested without a network.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub const GITHUB_RELEASES_URL: &str =
    "https://api.github.com/repos/Blackman99/deskfolk/releases?per_page=10";
pub const RELEASE_URL_PREFIX: &str = "https://github.com/Blackman99/deskfolk/";
pub const FEED_ENV: &str = "REAL_BOT_UPDATE_FEED";
pub const CACHE_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Deserialize)]
pub struct Asset {
    pub name: String,
    pub browser_download_url: String,
}

#[derive(Debug, Deserialize)]
pub struct Release {
    pub tag_name: String,
    pub html_url: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    pub published_at: Option<String>,
    /// The release body, which the workflow fills from this version's CHANGELOG
    /// section. The About card renders it, so it travels with the check.
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub assets: Vec<Asset>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub current: String,
    pub latest: Option<String>,
    pub update_available: bool,
    pub release_url: Option<String>,
    pub download_url: Option<String>,
    pub published_at: Option<String>,
    pub notes: Option<String>,
}

/// The feed URL to poll: `REAL_BOT_UPDATE_FEED` if set and non-empty, else the
/// real GitHub releases endpoint.
pub fn feed_url() -> String {
    match std::env::var(FEED_ENV) {
        Ok(url) if !url.is_empty() => url,
        _ => GITHUB_RELEASES_URL.to_string(),
    }
}

/// Map a Rust `std::env::consts::ARCH` value to the suffix used in release
/// asset names (`Deskfolk_<ver>_<arch>.dmg`).
pub fn arch_tag_for(arch: &str) -> Option<&'static str> {
    match arch {
        "aarch64" => Some("aarch64"),
        "x86_64" => Some("x64"),
        _ => None,
    }
}

pub fn arch_tag() -> Option<&'static str> {
    arch_tag_for(std::env::consts::ARCH)
}

/// Map a Rust `std::env::consts::ARCH` value to the suffix used in the NSIS
/// installer's name (`Deskfolk_<ver>_<arch>-setup.exe`) — aarch64 is spelled
/// `arm64` there, unlike the `.dmg` naming above.
pub fn windows_arch_tag_for(arch: &str) -> Option<&'static str> {
    match arch {
        "aarch64" => Some("arm64"),
        "x86_64" => Some("x64"),
        _ => None,
    }
}

pub fn windows_arch_tag() -> Option<&'static str> {
    windows_arch_tag_for(std::env::consts::ARCH)
}

/// The architecture tag for this platform's own release asset naming.
pub fn platform_arch_tag() -> Option<&'static str> {
    if cfg!(windows) {
        windows_arch_tag()
    } else {
        arch_tag()
    }
}

/// Parse a release tag (`v1.2.3` or `1.2.3`) into a semver version. Strips at
/// most one leading `v`/`V`. Returns `None` on any parse failure.
pub fn parse_tag(tag: &str) -> Option<semver::Version> {
    let trimmed = tag.trim();
    let stripped = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    semver::Version::parse(stripped).ok()
}

/// Pick the `.dmg` asset matching the given architecture tag. Returns `None`
/// when there is no architecture (unknown host arch) or no matching asset.
pub fn pick_dmg(assets: &[Asset], arch: Option<&str>) -> Option<String> {
    let arch = arch?;
    let suffix = format!("_{arch}.dmg");
    assets
        .iter()
        .find(|asset| asset.name.ends_with(&suffix))
        .map(|asset| asset.browser_download_url.clone())
}

/// Pick the NSIS installer asset (`Deskfolk_<ver>_<arch>-setup.exe`) matching
/// the given architecture tag ([`windows_arch_tag`]'s spelling).
pub fn pick_windows_installer(assets: &[Asset], arch: Option<&str>) -> Option<String> {
    let arch = arch?;
    let suffix = format!("_{arch}-setup.exe");
    assets
        .iter()
        .find(|asset| asset.name.ends_with(&suffix))
        .map(|asset| asset.browser_download_url.clone())
}

/// Which installer this platform takes from a release.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallerKind {
    /// `Deskfolk_<ver>_<arch>.dmg` (macOS), matched by [`pick_dmg`].
    Dmg,
    /// `Deskfolk_<ver>_<arch>-setup.exe` (Windows NSIS), matched by [`pick_windows_installer`].
    NsisSetup,
}

impl InstallerKind {
    pub fn for_this_platform() -> Self {
        if cfg!(windows) {
            Self::NsisSetup
        } else {
            Self::Dmg
        }
    }

    fn pick(self, assets: &[Asset], arch: Option<&str>) -> Option<String> {
        match self {
            Self::Dmg => pick_dmg(assets, arch),
            Self::NsisSetup => pick_windows_installer(assets, arch),
        }
    }
}

/// Choose the best release for the current version. Skips drafts and releases
/// with unparsable tags. A stable current version (no prerelease identifiers)
/// only considers non-prerelease releases; a prerelease current version
/// considers all releases. With a known `arch`, a release counts only once it
/// carries `installer` for that arch: a macOS-only release is no update for
/// Windows (and one whose assets are still uploading is none for anyone yet).
/// Picks the max semver among the remaining candidates.
pub fn pick_update(
    current: &semver::Version,
    releases: &[Release],
    installer: InstallerKind,
    arch: Option<&str>,
) -> UpdateCheck {
    let stable_only = current.pre.is_empty();
    let best = releases
        .iter()
        .filter(|release| !release.draft)
        .filter(|release| !stable_only || !release.prerelease)
        .filter(|release| arch.is_none() || installer.pick(&release.assets, arch).is_some())
        .filter_map(|release| parse_tag(&release.tag_name).map(|version| (version, release)))
        .max_by(|(a, _), (b, _)| a.cmp(b));

    match best {
        None => UpdateCheck {
            current: current.to_string(),
            latest: None,
            update_available: false,
            release_url: None,
            download_url: None,
            published_at: None,
            notes: None,
        },
        Some((version, release)) => {
            let update_available = version > *current;
            // Only an unknown arch gets here without an installer; it gets the release page.
            let download_url = installer
                .pick(&release.assets, arch)
                .or_else(|| Some(release.html_url.clone()));
            UpdateCheck {
                current: current.to_string(),
                latest: Some(version.to_string()),
                update_available,
                release_url: Some(release.html_url.clone()),
                download_url,
                published_at: release.published_at.clone(),
                notes: release
                    .body
                    .as_deref()
                    .map(str::trim)
                    .filter(|body| !body.is_empty())
                    .map(str::to_string),
            }
        }
    }
}

/// Only allow opening URLs under the real-bot release URL prefix, with no
/// whitespace or control characters (defends against argument-injection-ish
/// tricks when handed to `open`).
pub fn is_allowed_release_url(url: &str) -> bool {
    url.starts_with(RELEASE_URL_PREFIX) && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The proxy to use for `host`. The conventional environment variables come
/// first: `HTTPS_PROXY` wins over `ALL_PROXY`, and `NO_PROXY` takes the host
/// out. With neither set, `system` answers with the system's own setting for
/// `host` ([`system_proxy_for`]).
///
/// GitHub is reachable only through a proxy on plenty of machines, and neither
/// the check nor the download can ask the user for one. A shell launch carries
/// the variables; a copy opened from Finder, the Start menu or at login carries
/// none, and there the setting the browser follows is the only one there is.
pub fn proxy_for(
    host: &str,
    read: impl Fn(&str) -> Option<String>,
    system: impl FnOnce(&str) -> Option<String>,
) -> Option<String> {
    let value = |name: &str| {
        read(name)
            .or_else(|| read(&name.to_lowercase()))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    if bypasses_proxy(host, value("NO_PROXY").as_deref()) {
        return None;
    }
    value("HTTPS_PROXY")
        .or_else(|| value("ALL_PROXY"))
        .or_else(|| system(host))
}

/// The proxy the system itself would use for `host`: `scutil --proxy` on
/// macOS, Internet Settings in the registry on Windows. `None` elsewhere, or
/// when nothing is set.
fn system_proxy_for(host: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        system_proxy_dump().and_then(|dump| proxy_from_scutil(host, &dump))
    }
    #[cfg(windows)]
    {
        let enabled = internet_settings::dword("ProxyEnable")? != 0;
        let server = internet_settings::string("ProxyServer")?;
        let overrides = internet_settings::string("ProxyOverride").unwrap_or_default();
        proxy_from_windows_settings(host, enabled, &server, &overrides)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = host;
        None
    }
}

/// The proxy Windows would use for `host`, from the current user's Internet
/// Settings: the "Use a proxy server" switch in Settings → Network → Proxy,
/// which browsers follow and proxy apps flip when they turn on "system proxy".
/// `server` is `host:port` for every protocol, or per protocol as
/// `http=host:port;https=host:port;socks=host:port`, where `https` is the one
/// that counts and a lone `http` entry serves it too. `overrides` is the
/// `;`-separated bypass list, `*` wildcards and all, where `<local>` means any
/// name without a dot. A PAC script or a SOCKS-only setup gives `None` — this
/// build evaluates neither.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn proxy_from_windows_settings(
    host: &str,
    enabled: bool,
    server: &str,
    overrides: &str,
) -> Option<String> {
    if !enabled {
        return None;
    }
    let server = server.trim();
    let address = if server.contains('=') {
        let entry = |scheme: &str| {
            server.split(';').find_map(|entry| {
                let (name, address) = entry.split_once('=')?;
                (name.trim().eq_ignore_ascii_case(scheme)).then(|| address.trim())
            })
        };
        entry("https").or_else(|| entry("http"))?
    } else {
        server
    };
    if address.is_empty() || windows_bypasses_proxy(host, overrides) {
        return None;
    }
    let lower = address.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Some(address.to_string())
    } else if lower.contains("://") {
        None
    } else {
        Some(format!("http://{address}"))
    }
}

/// Does a Windows `ProxyOverride` list cover this host? Entries are
/// case-insensitive globs over the whole host (`*.corp.example`, `10.*`);
/// `<local>` covers any name without a dot.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_bypasses_proxy(host: &str, overrides: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    overrides.split(';').any(|entry| {
        let entry = entry.trim().to_ascii_lowercase();
        if entry == "<local>" {
            return !host.contains('.');
        }
        !entry.is_empty() && glob_matches(&entry, &host)
    })
}

/// `*` matches any run of characters, everything else only itself.
#[cfg_attr(not(windows), allow(dead_code))]
fn glob_matches(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if !text.starts_with(first) || text.len() < first.len() + last.len() || !text.ends_with(last) {
        return false;
    }
    let mut rest = &text[first.len()..text.len() - last.len()];
    for middle in &parts[1..parts.len() - 1] {
        match rest.find(middle) {
            Some(at) => rest = &rest[at + middle.len()..],
            None => return false,
        }
    }
    true
}

/// `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, read
/// value by value.
#[cfg(windows)]
mod internet_settings {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };

    const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn dword(name: &str) -> Option<u32> {
        let (key, value) = (wide(KEY), wide(name));
        let mut data = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: NUL-terminated UTF-16 key and value names, and a u32 buffer
        // whose size is passed alongside it.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut data as *mut u32).cast(),
                &mut size,
            )
        };
        (status == 0).then_some(data)
    }

    pub fn string(name: &str) -> Option<String> {
        let (key, value) = (wide(KEY), wide(name));
        let mut size = 0u32;
        // SAFETY: as above; a null buffer asks only for the size in bytes.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if status != 0 || size == 0 {
            return None;
        }
        let mut buf = vec![0u16; (size as usize).div_ceil(2)];
        // SAFETY: `buf` holds `size` bytes; RRF_RT_REG_SZ NUL-terminates it.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != 0 {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }
}

/// The proxy macOS would use for `host`, read from `scutil --proxy`: the
/// secure web proxy (HTTPS) in System Settings → Network → Proxies, which is
/// what browsers follow and what proxy apps switch on. `ExceptionsList` takes
/// the host out the way `NO_PROXY` does. Only the top-level dictionary counts;
/// `__SCOPED__` holds per-interface copies. A PAC file or a SOCKS-only setup
/// gives `None` — this build evaluates neither.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn proxy_from_scutil(host: &str, dump: &str) -> Option<String> {
    let mut depth = 0usize;
    let mut in_exceptions = false;
    let mut fields = Vec::new();
    let mut exceptions = Vec::new();
    for line in dump.lines() {
        let line = line.trim();
        if line == "}" {
            depth = depth.saturating_sub(1);
            in_exceptions = in_exceptions && depth > 1;
            continue;
        }
        let opens = line.ends_with('{');
        if let Some((name, value)) = line.split_once(" : ") {
            if depth == 1 && opens {
                in_exceptions = name == "ExceptionsList";
            } else if depth == 1 {
                fields.push((name, value));
            } else if depth == 2 && in_exceptions {
                exceptions.push(value);
            }
        }
        if opens {
            depth += 1;
        }
    }
    let field = |key: &str| {
        fields
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| value.trim())
    };
    if field("HTTPSEnable") != Some("1") {
        return None;
    }
    let server = field("HTTPSProxy").filter(|server| !server.is_empty())?;
    let port = field("HTTPSPort")?.parse::<u16>().ok()?;
    if bypasses_proxy(host, Some(&exceptions.join(","))) {
        return None;
    }
    Some(format!("http://{server}:{port}"))
}

/// The system's proxy settings as `scutil --proxy` prints them; `None` when
/// it can't run.
#[cfg(target_os = "macos")]
fn system_proxy_dump() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Does `NO_PROXY` cover this host? `*` covers everything, and an entry
/// matches a host that is it or ends in `.` plus it.
pub fn bypasses_proxy(host: &str, no_proxy: Option<&str>) -> bool {
    let Some(no_proxy) = no_proxy else {
        return false;
    };
    let host = host.trim().trim_end_matches('.').to_lowercase();
    no_proxy.split(',').any(|entry| {
        let raw = entry.trim();
        if raw == "*" {
            return true;
        }
        let entry = raw.trim_start_matches('*').trim_start_matches('.').to_lowercase();
        !entry.is_empty() && (host == entry || host.ends_with(&format!(".{entry}")))
    })
}

/// The host part of an `https://host/…` URL, for the `NO_PROXY` check.
pub fn url_host(url: &str) -> &str {
    let rest = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let host = authority.rsplit('@').next().unwrap_or(authority);
    host.split(':').next().unwrap_or(host)
}

/// Point the agent at the proxy for this URL, when there is one (see
/// [`proxy_for`]). An unusable proxy value (a SOCKS URL, say — this build has
/// no SOCKS) is dropped rather than failing the request before it is tried.
pub fn with_proxy(builder: ureq::AgentBuilder, url: &str) -> ureq::AgentBuilder {
    let Some(proxy) = proxy_for(
        url_host(url),
        |name| std::env::var(name).ok(),
        system_proxy_for,
    ) else {
        return builder;
    };
    match ureq::Proxy::new(&proxy) {
        Ok(proxy) => builder.proxy(proxy),
        Err(_) => builder,
    }
}

pub fn fetch_releases(url: &str, user_agent: &str) -> Result<Vec<Release>, String> {
    let agent = with_proxy(ureq::AgentBuilder::new(), url)
        .timeout(Duration::from_secs(10))
        .user_agent(user_agent)
        .build();
    match agent
        .get(url)
        .set("Accept", "application/vnd.github+json")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .call()
    {
        Ok(resp) => resp.into_json::<Vec<Release>>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(403, _)) | Err(ureq::Error::Status(429, _)) => {
            Err("rate limited".into())
        }
        Err(ureq::Error::Status(code, _)) => Err(format!("HTTP {code}")),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Default)]
pub struct UpdateCache {
    checked_at: Option<Instant>,
    result: Option<UpdateCheck>,
}

impl UpdateCache {
    /// A clone of the cached result if it was stored within `ttl` of `now`.
    pub fn fresh(&self, now: Instant, ttl: Duration) -> Option<UpdateCheck> {
        let checked_at = self.checked_at?;
        let result = self.result.as_ref()?;
        if now.checked_duration_since(checked_at).unwrap_or_default() < ttl {
            Some(result.clone())
        } else {
            None
        }
    }

    pub fn store(&mut self, now: Instant, result: UpdateCheck) {
        self.checked_at = Some(now);
        self.result = Some(result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(s: &str) -> semver::Version {
        semver::Version::parse(s).unwrap()
    }

    fn release(tag: &str, draft: bool, prerelease: bool) -> Release {
        Release {
            tag_name: tag.to_string(),
            html_url: format!("https://github.com/Blackman99/deskfolk/releases/tag/{tag}"),
            draft,
            prerelease,
            published_at: Some("2026-01-01T00:00:00Z".into()),
            body: None,
            assets: vec![],
        }
    }

    #[test]
    fn parse_tag_strips_v_and_rejects_garbage() {
        assert_eq!(parse_tag("v1.2.3"), Some(version("1.2.3")));
        assert_eq!(parse_tag("V1.2.3"), Some(version("1.2.3")));
        assert_eq!(parse_tag("1.2.3"), Some(version("1.2.3")));
        assert_eq!(parse_tag("  v1.2.3  "), Some(version("1.2.3")));
        assert_eq!(parse_tag("not-a-version"), None);
        assert_eq!(parse_tag("vv1.2.3"), None);
        assert_eq!(parse_tag(""), None);
    }

    #[test]
    fn arch_tag_maps_x86_64_to_x64_and_unknown_to_none() {
        assert_eq!(arch_tag_for("aarch64"), Some("aarch64"));
        assert_eq!(arch_tag_for("x86_64"), Some("x64"));
        assert_eq!(arch_tag_for("arm"), None);
        assert_eq!(arch_tag_for(""), None);
    }

    /// Windows spells the aarch64 tag `arm64`, not `aarch64` — the `.dmg` and
    /// the NSIS installer disagree here, so this has its own mapping.
    #[test]
    fn windows_arch_tag_spells_aarch64_as_arm64() {
        assert_eq!(windows_arch_tag_for("aarch64"), Some("arm64"));
        assert_eq!(windows_arch_tag_for("x86_64"), Some("x64"));
        assert_eq!(windows_arch_tag_for("arm"), None);
        assert_eq!(windows_arch_tag_for(""), None);
    }

    #[test]
    fn picks_windows_installer_by_arch_suffix() {
        let assets = vec![
            Asset {
                name: "Deskfolk_0.2.0_x64-setup.exe".into(),
                browser_download_url: "https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/Deskfolk_0.2.0_x64-setup.exe".into(),
            },
            Asset {
                name: "Deskfolk_0.2.0_arm64-setup.exe".into(),
                browser_download_url: "https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/Deskfolk_0.2.0_arm64-setup.exe".into(),
            },
        ];
        assert_eq!(
            pick_windows_installer(&assets, Some("x64")).as_deref(),
            Some("https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/Deskfolk_0.2.0_x64-setup.exe")
        );
        assert_eq!(
            pick_windows_installer(&assets, Some("arm64")).as_deref(),
            Some("https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/Deskfolk_0.2.0_arm64-setup.exe")
        );
        assert_eq!(pick_windows_installer(&assets, None), None);
        assert_eq!(pick_windows_installer(&assets, Some("unknown")), None);
        // A `.dmg` of the same architecture tag is not an NSIS installer.
        let dmg_only = vec![Asset {
            name: "Deskfolk_0.2.0_x64.dmg".into(),
            browser_download_url: "https://example.invalid/Deskfolk_0.2.0_x64.dmg".into(),
        }];
        assert_eq!(pick_windows_installer(&dmg_only, Some("x64")), None);
    }

    #[test]
    fn prerelease_current_sees_prereleases_and_stable() {
        let current = version("0.1.0-alpha.3");
        let releases = vec![release("v0.1.0-alpha.4", false, true), release("v0.1.0", false, false)];
        let check = pick_update(&current, &releases, InstallerKind::Dmg, None);
        assert_eq!(check.latest.as_deref(), Some("0.1.0"));
        assert!(check.update_available);
    }

    #[test]
    fn stable_current_ignores_prereleases() {
        let current = version("0.1.0");
        let releases = vec![release("v0.2.0-alpha.1", false, true)];
        let check = pick_update(&current, &releases, InstallerKind::Dmg, None);
        assert_eq!(check.latest, None);
        assert!(!check.update_available);
    }

    #[test]
    fn numeric_prerelease_identifiers_compare_numerically() {
        let current = version("0.1.0-alpha.1");
        let releases = vec![
            release("v0.1.0-alpha.3", false, true),
            release("v0.1.0-alpha.10", false, true),
        ];
        let check = pick_update(&current, &releases, InstallerKind::Dmg, None);
        assert_eq!(check.latest.as_deref(), Some("0.1.0-alpha.10"));

        let releases2 = vec![
            release("v0.1.0-alpha.10", false, true),
            release("v0.1.0-beta.1", false, true),
        ];
        let check2 = pick_update(&current, &releases2, InstallerKind::Dmg, None);
        assert_eq!(check2.latest.as_deref(), Some("0.1.0-beta.1"));
    }

    #[test]
    fn drafts_and_unparsable_tags_are_skipped() {
        let current = version("0.1.0-alpha.1");
        let releases = vec![
            release("v9.9.9", true, false),
            release("garbage", false, false),
            release("v0.1.0-alpha.2", false, true),
        ];
        let check = pick_update(&current, &releases, InstallerKind::Dmg, None);
        assert_eq!(check.latest.as_deref(), Some("0.1.0-alpha.2"));
    }

    #[test]
    fn equal_or_older_latest_is_not_an_update() {
        let current = version("0.1.0");
        let releases = vec![release("v0.1.0", false, false)];
        let check = pick_update(&current, &releases, InstallerKind::Dmg, None);
        assert_eq!(check.latest.as_deref(), Some("0.1.0"));
        assert!(!check.update_available);

        let releases_older = vec![release("v0.0.9", false, false)];
        let check_older = pick_update(&current, &releases_older, InstallerKind::Dmg, None);
        assert_eq!(check_older.latest.as_deref(), Some("0.0.9"));
        assert!(!check_older.update_available);
    }

    // The installer kind is passed in, so this runs the same on every host; the Windows side is
    // each_platform_takes_the_newest_release_that_carries_its_installer below.
    #[test]
    fn picks_arch_dmg_and_skips_a_release_without_one() {
        let current = version("0.1.0");
        let mut r = release("v0.2.0", false, false);
        r.assets = vec![
            Asset {
                name: "Deskfolk_0.2.0_aarch64.dmg".into(),
                browser_download_url: "https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/Deskfolk_0.2.0_aarch64.dmg".into(),
            },
            Asset {
                name: "Deskfolk_0.2.0_x64.dmg".into(),
                browser_download_url: "https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/Deskfolk_0.2.0_x64.dmg".into(),
            },
        ];
        let releases = vec![r];

        let aarch64 = pick_update(&current, &releases, InstallerKind::Dmg, Some("aarch64"));
        assert_eq!(
            aarch64.download_url.as_deref(),
            Some("https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/Deskfolk_0.2.0_aarch64.dmg")
        );

        let x64 = pick_update(&current, &releases, InstallerKind::Dmg, Some("x64"));
        assert_eq!(
            x64.download_url.as_deref(),
            Some("https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/Deskfolk_0.2.0_x64.dmg")
        );

        let none_arch = pick_update(&current, &releases, InstallerKind::Dmg, None);
        assert_eq!(
            none_arch.download_url.as_deref(),
            Some("https://github.com/Blackman99/deskfolk/releases/tag/v0.2.0")
        );

        // No `.dmg` for this arch (yet): not an update at all, rather than a release page
        // with nothing on it to install.
        let mut r2 = release("v0.3.0", false, false);
        r2.assets = vec![];
        let releases_missing = vec![r2];
        let missing_asset = pick_update(&current, &releases_missing, InstallerKind::Dmg, Some("aarch64"));
        assert_eq!(missing_asset.latest, None);
        assert!(!missing_asset.update_available);
    }

    #[test]
    fn each_platform_takes_the_newest_release_that_carries_its_installer() {
        let asset = |name: &str| Asset {
            name: name.into(),
            browser_download_url: format!("https://github.com/Blackman99/deskfolk/releases/download/{name}"),
        };
        let mut both = release("v0.2.0", false, false);
        both.assets = vec![asset("Deskfolk_0.2.0_x64.dmg"), asset("Deskfolk_0.2.0_x64-setup.exe")];
        let mut mac_only = release("v0.3.0", false, false);
        mac_only.assets = vec![asset("Deskfolk_0.3.0_x64.dmg")];
        let mut windows_only = release("v0.2.5", false, false);
        windows_only.assets = vec![asset("Deskfolk_0.2.5_x64-setup.exe")];
        let releases = vec![both, mac_only, windows_only];
        let current = version("0.1.0");

        let windows = pick_update(&current, &releases, InstallerKind::NsisSetup, Some("x64"));
        assert_eq!(windows.latest.as_deref(), Some("0.2.5"));
        assert_eq!(
            windows.download_url.as_deref(),
            Some("https://github.com/Blackman99/deskfolk/releases/download/Deskfolk_0.2.5_x64-setup.exe")
        );

        let mac = pick_update(&current, &releases, InstallerKind::Dmg, Some("x64"));
        assert_eq!(mac.latest.as_deref(), Some("0.3.0"));
        assert_eq!(
            mac.download_url.as_deref(),
            Some("https://github.com/Blackman99/deskfolk/releases/download/Deskfolk_0.3.0_x64.dmg")
        );
    }

    #[test]
    fn parses_github_release_json() {
        let json = r#"[
            {
                "tag_name": "v0.1.0-alpha.4",
                "html_url": "https://github.com/Blackman99/deskfolk/releases/tag/v0.1.0-alpha.4",
                "draft": false,
                "prerelease": true,
                "published_at": "2026-09-10T00:00:00Z",
                "name": "Deskfolk 0.1.0-alpha.4",
                "body": "- 群聊输入框上方改成草稿建议。",
                "assets": [
                    {
                        "name": "Deskfolk_0.1.0-alpha.4_aarch64.dmg",
                        "browser_download_url": "https://github.com/Blackman99/deskfolk/releases/download/v0.1.0-alpha.4/Deskfolk_0.1.0-alpha.4_aarch64.dmg",
                        "content_type": "application/x-apple-diskimage",
                        "size": 12345678
                    }
                ]
            }
        ]"#;
        let releases: Vec<Release> = serde_json::from_str(json).unwrap();
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].tag_name, "v0.1.0-alpha.4");
        assert!(releases[0].prerelease);
        assert!(!releases[0].draft);
        assert_eq!(releases[0].assets.len(), 1);
        assert_eq!(releases[0].assets[0].name, "Deskfolk_0.1.0-alpha.4_aarch64.dmg");
        assert!(releases[0].body.as_deref().unwrap().contains("草稿建议"));
    }

    #[test]
    fn the_release_body_travels_with_the_check_and_blank_bodies_do_not() {
        let mut newer = release("v0.2.0", false, false);
        newer.body = Some("### Messenger\n\n- 一条更新说明。\n".into());
        let check = pick_update(&version("0.1.0"), &[newer], InstallerKind::Dmg, None);
        assert!(check.update_available);
        assert_eq!(
            check.notes.as_deref(),
            Some("### Messenger\n\n- 一条更新说明。")
        );

        let mut blank = release("v0.2.0", false, false);
        blank.body = Some("   \n".into());
        assert_eq!(
            pick_update(&version("0.1.0"), &[blank], InstallerKind::Dmg, None).notes,
            None
        );

        assert_eq!(pick_update(&version("0.1.0"), &[], InstallerKind::Dmg, None).notes, None);
    }

    fn env(pairs: Vec<(&'static str, &'static str)>) -> impl Fn(&str) -> Option<String> {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_string())
        }
    }

    /// What `scutil --proxy` prints with a proxy app's "system proxy" on.
    const SCUTIL_PROXY_ON: &str = "<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : localhost
    3 : *.local
    4 : <local>
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 12334
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 12334
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 12334
  SOCKSProxy : 127.0.0.1
}
";

    #[test]
    fn proxy_comes_from_the_environment_unless_no_proxy_covers_the_host() {
        let from_env = |host: &str, read| proxy_for(host, read, |_| None);
        assert_eq!(
            from_env("github.com", env(vec![("HTTPS_PROXY", "http://127.0.0.1:12334")])),
            Some("http://127.0.0.1:12334".to_string())
        );
        // Lowercase spellings are just as conventional.
        assert_eq!(
            from_env("github.com", env(vec![("https_proxy", "http://127.0.0.1:1")])),
            Some("http://127.0.0.1:1".to_string())
        );
        // HTTPS_PROXY wins over ALL_PROXY; an empty value is no value.
        assert_eq!(
            from_env(
                "github.com",
                env(vec![("HTTPS_PROXY", "http://a:1"), ("ALL_PROXY", "http://b:2")])
            ),
            Some("http://a:1".to_string())
        );
        assert_eq!(
            from_env("github.com", env(vec![("HTTPS_PROXY", "  "), ("ALL_PROXY", "http://b:2")])),
            Some("http://b:2".to_string())
        );
        assert_eq!(from_env("github.com", env(vec![])), None);
        assert_eq!(
            from_env(
                "github.com",
                env(vec![("HTTPS_PROXY", "http://a:1"), ("NO_PROXY", "localhost,github.com")])
            ),
            None
        );
    }

    /// A copy opened from Finder has no proxy variables; github.com downloads
    /// then go through the system proxy the browser uses, or not at all on
    /// networks where github.com only answers through one.
    #[test]
    fn without_variables_the_system_proxy_is_used() {
        let system = |host: &str| proxy_from_scutil(host, SCUTIL_PROXY_ON);
        assert_eq!(
            proxy_for("github.com", env(vec![]), system),
            Some("http://127.0.0.1:12334".to_string())
        );
        // The shell's variables still win, and NO_PROXY still means direct.
        assert_eq!(
            proxy_for(
                "github.com",
                env(vec![("HTTPS_PROXY", "http://a:1")]),
                system
            ),
            Some("http://a:1".to_string())
        );
        assert_eq!(
            proxy_for("github.com", env(vec![("NO_PROXY", "github.com")]), system),
            None
        );
        // The system dump is only read when the variables leave it open.
        assert_eq!(
            proxy_for(
                "github.com",
                env(vec![("HTTPS_PROXY", "http://a:1")]),
                |_: &str| -> Option<String> { panic!("read the system proxy although HTTPS_PROXY is set") }
            ),
            Some("http://a:1".to_string())
        );
    }

    #[test]
    fn scutil_proxy_is_the_https_proxy_unless_excepted() {
        assert_eq!(
            proxy_from_scutil("github.com", SCUTIL_PROXY_ON),
            Some("http://127.0.0.1:12334".to_string())
        );
        assert_eq!(proxy_from_scutil("printer.local", SCUTIL_PROXY_ON), None);
        assert_eq!(proxy_from_scutil("localhost", SCUTIL_PROXY_ON), None);
        let off = SCUTIL_PROXY_ON.replace("HTTPSEnable : 1", "HTTPSEnable : 0");
        assert_eq!(proxy_from_scutil("github.com", &off), None);
        let no_port = SCUTIL_PROXY_ON.replace("  HTTPSPort : 12334\n", "");
        assert_eq!(proxy_from_scutil("github.com", &no_port), None);
        // Nothing configured at all.
        let empty = "<dictionary> {\n  FTPPassive : 1\n  HTTPEnable : 0\n  HTTPSEnable : 0\n}\n";
        assert_eq!(proxy_from_scutil("github.com", empty), None);
        // A per-interface copy under __SCOPED__ is not the system setting.
        let scoped = "<dictionary> {
  HTTPSEnable : 0
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPSEnable : 1
      HTTPSPort : 8080
      HTTPSProxy : 10.0.0.1
    }
  }
}
";
        assert_eq!(proxy_from_scutil("github.com", scoped), None);
        assert_eq!(proxy_from_scutil("github.com", ""), None);
    }

    /// What Clash for Windows / v2rayN write when their "system proxy" is on,
    /// and the bypass list Windows ships with.
    #[test]
    fn windows_internet_settings_proxy_is_the_https_one_unless_bypassed() {
        let overrides = "localhost;127.*;10.*;172.16.*;192.168.*;*.corp.example;<local>";
        let win = |host: &str, enabled: bool, server: &str| {
            proxy_from_windows_settings(host, enabled, server, overrides)
        };
        let proxy = Some("http://127.0.0.1:7890".to_string());
        assert_eq!(win("github.com", true, "127.0.0.1:7890"), proxy);
        assert_eq!(win("github.com", false, "127.0.0.1:7890"), None);
        assert_eq!(win("github.com", true, ""), None);
        // Per protocol: https wins, http serves when it is the only one, socks alone is none.
        assert_eq!(
            win("github.com", true, "http=127.0.0.1:1;https=127.0.0.1:7890;socks=127.0.0.1:7891"),
            proxy
        );
        assert_eq!(win("github.com", true, "http=127.0.0.1:7890"), proxy);
        assert_eq!(win("github.com", true, "socks=127.0.0.1:7891"), None);
        // A scheme already on the address is kept; a non-HTTP one is not a proxy ureq can use.
        assert_eq!(win("github.com", true, "http://127.0.0.1:7890"), proxy);
        assert_eq!(win("github.com", true, "socks5://127.0.0.1:7891"), None);
        // The bypass list: exact names, wildcards on either side, and <local> for dotless names.
        assert_eq!(win("localhost", true, "127.0.0.1:7890"), None);
        assert_eq!(win("192.168.1.20", true, "127.0.0.1:7890"), None);
        assert_eq!(win("build.corp.example", true, "127.0.0.1:7890"), None);
        assert_eq!(win("printer", true, "127.0.0.1:7890"), None);
        assert_eq!(win("GitHub.com.", true, "127.0.0.1:7890"), proxy);
        assert_eq!(win("corp.example.github.com", true, "127.0.0.1:7890"), proxy);
    }

    #[test]
    fn no_proxy_matches_a_host_or_its_domain() {
        assert!(bypasses_proxy("github.com", Some("localhost,github.com")));
        assert!(bypasses_proxy("api.github.com", Some("*.github.com")));
        assert!(bypasses_proxy("api.github.com", Some(".github.com")));
        assert!(bypasses_proxy("anything", Some("*")));
        assert!(!bypasses_proxy("github.com", Some("localhost,127.0.0.1")));
        assert!(!bypasses_proxy("notgithub.com", Some("github.com")));
        assert!(!bypasses_proxy("github.com", Some("")));
        assert!(!bypasses_proxy("github.com", None));
    }

    #[test]
    fn url_host_is_what_no_proxy_is_matched_against() {
        assert_eq!(url_host("https://api.github.com/repos/x/y/releases?per_page=10"), "api.github.com");
        assert_eq!(url_host("https://github.com:443/x"), "github.com");
        assert_eq!(url_host("http://user:pass@127.0.0.1:8080/feed.json"), "127.0.0.1");
        assert_eq!(url_host("https://github.com"), "github.com");
    }

    #[test]
    fn allowed_release_url_prefix_only() {
        assert!(is_allowed_release_url(
            "https://github.com/Blackman99/deskfolk/releases/tag/v0.1.0"
        ));
        assert!(is_allowed_release_url(
            "https://github.com/Blackman99/deskfolk/releases/download/v0.1.0/Deskfolk_0.1.0_aarch64.dmg"
        ));
        assert!(!is_allowed_release_url("https://github.com/other/x"));
        assert!(!is_allowed_release_url("http://github.com/Blackman99/deskfolk/"));
        assert!(!is_allowed_release_url(
            "https://github.com/Blackman99/deskfolk/releases/tag/v0.1.0 evil"
        ));
        assert!(!is_allowed_release_url(
            "https://github.com/Blackman99/deskfolk/releases/tag/v0.1.0\nevil"
        ));
    }

    #[test]
    fn cache_is_fresh_within_ttl_and_stale_after() {
        let cache_result = UpdateCheck {
            current: "0.1.0".into(),
            latest: Some("0.1.0".into()),
            update_available: false,
            release_url: None,
            download_url: None,
            published_at: None,
            notes: None,
        };
        let mut cache = UpdateCache::default();
        assert!(cache.fresh(Instant::now(), CACHE_TTL).is_none());

        let checked_at = Instant::now();
        cache.store(checked_at, cache_result.clone());

        let ttl = Duration::from_secs(60);
        assert_eq!(
            cache.fresh(checked_at + Duration::from_secs(30), ttl),
            Some(cache_result.clone())
        );
        assert_eq!(cache.fresh(checked_at + Duration::from_secs(61), ttl), None);
    }
}
