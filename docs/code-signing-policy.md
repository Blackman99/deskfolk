# Code Signing Policy

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## Purpose and Scope

This policy governs how official Deskfolk release binaries are built and code-signed for distribution on [GitHub Releases](https://github.com/Blackman99/deskfolk/releases).

### Windows (SignPath Foundation)

Once SignPath Foundation onboarding is completed and the repository secrets below are configured, official release builds triggered by `v*` tags on `Blackman99/deskfolk` sign:

- `Deskfolk.exe` (native desktop shell)
- `native/real-bot-daemon.exe` (local daemon)
- `native/real-bot-pty.exe` (ConPTY terminal helper)
- `native/real-bot-rtc.exe` (WebRTC remote screen helper)
- `Deskfolk_<version>_x64-setup.exe` (NSIS installer)

Signing runs exclusively inside `.github/workflows/release.yml` on GitHub-hosted `windows-latest` runners, and every signed binary is verified with Authenticode (`Get-AuthenticodeSignature`) and smoke-tested before publication.

Until SignPath Foundation secrets are configured in this repository, Windows installers remain unsigned and release notes explicitly disclose that SmartScreen will warn about an unknown publisher. Release notes advertise SignPath signing only when signing secrets are configured and the signing steps succeed.

### macOS (Apple Developer ID)

macOS `.dmg` releases are signed with an Apple Developer ID Application certificate and notarized by Apple Notary Service; see [`docs/notarization.md`](notarization.md).

## Team Roles and Governance

SignPath Foundation defines three roles for signing governance:

| Role | Members | Responsibility |
| --- | --- | --- |
| **Committers** | `@Blackman99` (project maintainer) | Author and merge source changes to `main` and create signed release tags (`v*`). |
| **Reviewers** | `@Blackman99` | Review pull requests, release diffs, and workflow changes before tagging a release. |
| **Approvers** | `@Blackman99` | Approve SignPath signing requests (when manual approval is enabled) and manage SignPath project settings and secrets. |

External pull requests are reviewed by a maintainer before merging and never have access to signing credentials or release workflows. Signing is restricted to release tags (`refs/tags/v*`) built from this repository on GitHub-hosted runners.

## Privacy Policy

Deskfolk is a local-first desktop application.

- Deskfolk does **not** collect telemetry, analytics, usage metrics, or crash reports.
- Deskfolk operates **no** first-party cloud service that receives user conversations, files, or credentials.
- Conversations, application state, and credentials are stored locally on the user's machine (macOS Keychain, Windows Credential Manager, or Linux Secret Service; see [`SECURITY.md`](../SECURITY.md)).
- Outbound network requests occur only to endpoints explicitly configured or triggered by the user: AI model providers, local/remote MCP servers, local CLI agents, optional GitHub Releases update checks, or a user-configured remote relay.

## Maintainer Setup (SignPath Foundation)

This section records the exact SignPath configuration matching `.github/workflows/release.yml`.

### 1. Apply and install the GitHub App

1. Apply for the [SignPath Foundation Open Source Program](https://signpath.org/open-source) with:
   - Repository: `https://github.com/Blackman99/deskfolk`
   - Code Signing Policy URL: `https://github.com/Blackman99/deskfolk/blob/main/docs/code-signing-policy.md`
   - License: MIT
2. After approval, install the **SignPath GitHub App** on `Blackman99/deskfolk` so SignPath can verify GitHub Actions build provenance and fetch unsigned artifacts directly from GitHub.

### 2. Create the SignPath project and artifact configurations

In the SignPath dashboard:

- **Project slug**: `deskfolk` (overrideable via repository variable `SIGNPATH_PROJECT_SLUG`).
- **Signing policy slug**: `release-signing` (overrideable via repository variable `SIGNPATH_POLICY_SLUG`), bound to the SignPath Foundation certificate and a GitHub Actions build policy requiring GitHub-hosted runners on `Blackman99/deskfolk` running `.github/workflows/release.yml` for `refs/tags/v*`.
- **Artifact configuration 1 — slug `windows-binaries`**:

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="Deskfolk.exe">
      <authenticode-sign/>
    </pe-file>
    <pe-file path="native/real-bot-daemon.exe">
      <authenticode-sign/>
    </pe-file>
    <pe-file path="native/real-bot-pty.exe">
      <authenticode-sign/>
    </pe-file>
    <pe-file path="native/real-bot-rtc.exe">
      <authenticode-sign/>
    </pe-file>
  </zip-file>
</artifact-configuration>
```

- **Artifact configuration 2 — slug `windows-installer`**:

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="Deskfolk_*_x64-setup.exe">
      <authenticode-sign/>
    </pe-file>
  </zip-file>
</artifact-configuration>
```

> Note: `actions/upload-artifact@v4` packages uploaded files as a ZIP archive on GitHub, so both configurations wrap their `<pe-file>` entries in `<zip-file>`.

### 3. Configure GitHub repository secrets

Set both secrets on `Blackman99/deskfolk`:

```sh
gh secret set SIGNPATH_ORGANIZATION_ID -R Blackman99/deskfolk
gh secret set SIGNPATH_API_TOKEN -R Blackman99/deskfolk
```

| Secret / Variable | Type | Value |
| --- | --- | --- |
| `SIGNPATH_ORGANIZATION_ID` | Secret | Organization ID from the SignPath dashboard |
| `SIGNPATH_API_TOKEN` | Secret | CI user API token with submit permission on `deskfolk` / `release-signing` |
| `SIGNPATH_PROJECT_SLUG` | Variable (optional) | Defaults to `deskfolk` |
| `SIGNPATH_POLICY_SLUG` | Variable (optional) | Defaults to `release-signing` |

Once both secrets are set, the next `v*` tag release automatically stages the Windows binaries, signs them via SignPath, builds the NSIS installer from the signed stage, signs the installer via SignPath, verifies every Authenticode signature, runs the upgrade and fresh install smoke tests on the signed installer, and publishes the signed installer with SignPath attribution in the release notes.
