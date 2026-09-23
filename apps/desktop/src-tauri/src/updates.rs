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

/// Choose the best release for the current version. Skips drafts and releases
/// with unparsable tags. A stable current version (no prerelease identifiers)
/// only considers non-prerelease releases; a prerelease current version
/// considers all releases. Picks the max semver among the remaining
/// candidates.
pub fn pick_update(
    current: &semver::Version,
    releases: &[Release],
    arch: Option<&str>,
) -> UpdateCheck {
    let stable_only = current.pre.is_empty();
    let best = releases
        .iter()
        .filter(|release| !release.draft)
        .filter(|release| !stable_only || !release.prerelease)
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
            let download_url =
                pick_dmg(&release.assets, arch).or_else(|| Some(release.html_url.clone()));
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

/// The proxy to use for `host`, from the conventional environment variables.
/// `HTTPS_PROXY` wins over `ALL_PROXY`, and `NO_PROXY` takes the host out.
///
/// GitHub is reachable only through a proxy on plenty of machines, and neither
/// the check nor the download can ask the user for one — but the shell that
/// launched the app usually already has these set.
pub fn proxy_from_env(host: &str, read: impl Fn(&str) -> Option<String>) -> Option<String> {
    let value = |name: &str| {
        read(name)
            .or_else(|| read(&name.to_lowercase()))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    if bypasses_proxy(host, value("NO_PROXY").as_deref()) {
        return None;
    }
    value("HTTPS_PROXY").or_else(|| value("ALL_PROXY"))
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

/// Point the agent at the environment's proxy when there is one for this URL.
/// An unusable proxy value (a SOCKS URL, say — this build has no SOCKS) is
/// dropped rather than failing the request before it is tried.
pub fn with_env_proxy(builder: ureq::AgentBuilder, url: &str) -> ureq::AgentBuilder {
    let Some(proxy) = proxy_from_env(url_host(url), |name| std::env::var(name).ok()) else {
        return builder;
    };
    match ureq::Proxy::new(&proxy) {
        Ok(proxy) => builder.proxy(proxy),
        Err(_) => builder,
    }
}

pub fn fetch_releases(url: &str, user_agent: &str) -> Result<Vec<Release>, String> {
    let agent = with_env_proxy(ureq::AgentBuilder::new(), url)
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

    #[test]
    fn prerelease_current_sees_prereleases_and_stable() {
        let current = version("0.1.0-alpha.3");
        let releases = vec![release("v0.1.0-alpha.4", false, true), release("v0.1.0", false, false)];
        let check = pick_update(&current, &releases, None);
        assert_eq!(check.latest.as_deref(), Some("0.1.0"));
        assert!(check.update_available);
    }

    #[test]
    fn stable_current_ignores_prereleases() {
        let current = version("0.1.0");
        let releases = vec![release("v0.2.0-alpha.1", false, true)];
        let check = pick_update(&current, &releases, None);
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
        let check = pick_update(&current, &releases, None);
        assert_eq!(check.latest.as_deref(), Some("0.1.0-alpha.10"));

        let releases2 = vec![
            release("v0.1.0-alpha.10", false, true),
            release("v0.1.0-beta.1", false, true),
        ];
        let check2 = pick_update(&current, &releases2, None);
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
        let check = pick_update(&current, &releases, None);
        assert_eq!(check.latest.as_deref(), Some("0.1.0-alpha.2"));
    }

    #[test]
    fn equal_or_older_latest_is_not_an_update() {
        let current = version("0.1.0");
        let releases = vec![release("v0.1.0", false, false)];
        let check = pick_update(&current, &releases, None);
        assert_eq!(check.latest.as_deref(), Some("0.1.0"));
        assert!(!check.update_available);

        let releases_older = vec![release("v0.0.9", false, false)];
        let check_older = pick_update(&current, &releases_older, None);
        assert_eq!(check_older.latest.as_deref(), Some("0.0.9"));
        assert!(!check_older.update_available);
    }

    #[test]
    fn picks_arch_dmg_and_falls_back_to_release_page() {
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

        let aarch64 = pick_update(&current, &releases, Some("aarch64"));
        assert_eq!(
            aarch64.download_url.as_deref(),
            Some("https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/Deskfolk_0.2.0_aarch64.dmg")
        );

        let x64 = pick_update(&current, &releases, Some("x64"));
        assert_eq!(
            x64.download_url.as_deref(),
            Some("https://github.com/Blackman99/deskfolk/releases/download/v0.2.0/Deskfolk_0.2.0_x64.dmg")
        );

        let none_arch = pick_update(&current, &releases, None);
        assert_eq!(
            none_arch.download_url.as_deref(),
            Some("https://github.com/Blackman99/deskfolk/releases/tag/v0.2.0")
        );

        let mut r2 = release("v0.3.0", false, false);
        r2.assets = vec![];
        let releases_missing = vec![r2];
        let missing_asset = pick_update(&current, &releases_missing, Some("aarch64"));
        assert_eq!(
            missing_asset.download_url.as_deref(),
            Some("https://github.com/Blackman99/deskfolk/releases/tag/v0.3.0")
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
        let check = pick_update(&version("0.1.0"), &[newer], Some("aarch64"));
        assert!(check.update_available);
        assert_eq!(
            check.notes.as_deref(),
            Some("### Messenger\n\n- 一条更新说明。")
        );

        let mut blank = release("v0.2.0", false, false);
        blank.body = Some("   \n".into());
        assert_eq!(
            pick_update(&version("0.1.0"), &[blank], Some("aarch64")).notes,
            None
        );

        assert_eq!(pick_update(&version("0.1.0"), &[], Some("aarch64")).notes, None);
    }

    #[test]
    fn proxy_comes_from_the_environment_unless_no_proxy_covers_the_host() {
        let env = |pairs: Vec<(&'static str, &'static str)>| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| (*value).to_string())
            }
        };
        assert_eq!(
            proxy_from_env("github.com", env(vec![("HTTPS_PROXY", "http://127.0.0.1:12334")])),
            Some("http://127.0.0.1:12334".to_string())
        );
        // Lowercase spellings are just as conventional.
        assert_eq!(
            proxy_from_env("github.com", env(vec![("https_proxy", "http://127.0.0.1:1")])),
            Some("http://127.0.0.1:1".to_string())
        );
        // HTTPS_PROXY wins over ALL_PROXY; an empty value is no value.
        assert_eq!(
            proxy_from_env(
                "github.com",
                env(vec![("HTTPS_PROXY", "http://a:1"), ("ALL_PROXY", "http://b:2")])
            ),
            Some("http://a:1".to_string())
        );
        assert_eq!(
            proxy_from_env("github.com", env(vec![("HTTPS_PROXY", "  "), ("ALL_PROXY", "http://b:2")])),
            Some("http://b:2".to_string())
        );
        assert_eq!(proxy_from_env("github.com", env(vec![])), None);
        assert_eq!(
            proxy_from_env(
                "github.com",
                env(vec![("HTTPS_PROXY", "http://a:1"), ("NO_PROXY", "localhost,github.com")])
            ),
            None
        );
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
