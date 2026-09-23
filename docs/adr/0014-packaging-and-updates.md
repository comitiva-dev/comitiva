# 0014 — Packaging, signing later, and updates from GitHub Releases

- Status: Accepted
- Date: 2026-09-23

## Context

v0.1.0 is the first release people install. Three things cross packages:
the runner and the built-in MCP servers are separate Node processes that
must start from the installed app on macOS, Windows and Linux; installers
must reach people on all three; and the app must be able to update itself.
There are no code-signing certificates yet, and the repository goes public
with the release.

## Decision

**electron-builder produces dmg + zip (macOS, arm64 and x64), an NSIS
installer (Windows x64, per user) and AppImage, deb and rpm (Linux x64).** The
runner (`bin.cjs`), the MCP proxy (`mcp-proxy.cjs`), both built-in servers
and the migrations ship as `extraResources`, outside the asar: a child process
running under `ELECTRON_RUN_AS_NODE` cannot read from an asar. A smoke test of
the packaged app (`e2e-packaged/smoke.spec.ts`) starts each of them from the
installed resources, on all three OSes in CI.

**Linux sandbox.** The deb and rpm install electron-builder's AppArmor profile
(Ubuntu 24.04+ restricts unprivileged user namespaces) and make `chrome-sandbox`
setuid only where namespaces are unavailable. The AppImage cannot carry
either: its launcher (electron-builder's `AppRun`) probes `unshare -Ur true`
and adds `--no-sandbox` when user namespaces are unavailable, which is the
case on a default Ubuntu 24.04 (verified). There, the AppImage runs without
Chromium's sandbox; people who want it use the deb or rpm. The unpacked
folder needs `--no-sandbox` too, which only the tests use.

**Signing is a documented TODO.** The configuration and the release workflow
take the certificates from secrets when they exist (`CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`,
`WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`) and build unsigned otherwise. The
hardened runtime and its entitlements are already in place for macOS.

**Updates come from GitHub Releases through electron-updater.** Packaged
builds check 10 s after start and every 6 h (a setting turns this off; "Check
now" always works), download in the background and install on restart
(Windows NSIS, Linux AppImage, deb and rpm). An unsigned macOS build cannot
install an update (Squirrel.Mac checks the signature), so it only says that a
version is available and links to its release; the release workflow records
`comitiva.macSigned` in the packaged `package.json` when it signs. Updates are
off in development builds and with `COMITIVA_DISABLE_UPDATES=1` (tests, CI).
Update errors are logged and shown by code (`update_failed`).

## Consequences

- The repository must be public for the updater to read the releases feed
  without a token. It goes public with v0.1.0.
- First installs warn: Gatekeeper on macOS (right-click → Open), SmartScreen on
  Windows. The README says so until signing lands.
- macOS users of unsigned builds update by downloading; everyone else gets it
  on restart.
- Releases are drafts until the workflow has uploaded every platform's files
  and written the notes, so the feed never points at a half-published release.
