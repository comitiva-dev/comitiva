# 0019 — Signing: SignPath Foundation for Windows, an individual Developer ID for macOS

- Status: Accepted
- Date: 2026-10-09
- Amends: "Signing is a documented TODO" in ADR 0014

## Context

ADR 0014 left signing as a TODO and wired the release workflow to read
certificates from secrets. Signing as a company would tie the open source
desktop to one company's name and paperwork, while the project wants people to
run it without that, and the hub no longer needs a company either (ADR 0018).

- Windows: certificate authorities no longer issue `.pfx` files, so any
  certificate means a cloud HSM and a yearly fee. The SignPath Foundation
  signs open source projects for free, from a verified build, with its own
  certificate.
- macOS: there is no free path. Unsigned builds need System Settings → Open
  Anyway on macOS 15 and later, cannot install their own updates (ADR 0014),
  and Homebrew's official tap no longer takes casks that fail Gatekeeper.

## Decision

**Windows builds are signed through the SignPath Foundation.** The publisher
Windows shows is "SignPath Foundation". Signing happens after electron-builder,
in the release workflow: the unsigned files are uploaded as a workflow
artifact, submitted to SignPath with the GitHub Actions integration (which
checks that the artifact came from this repository's workflow), approved by a
person, and downloaded signed. Because signing changes the files, the
installer's blockmap and `latest.yml` are produced again from the signed
installer before upload. The app's own executables are signed as well as the
installer, so SmartScreen and electron-updater see the same publisher on both.
`win.publisherName` is set to "SignPath Foundation", which electron-updater
checks before installing an update.

**macOS builds are signed and notarized with a Developer ID of an individual
Apple Developer Program membership.** Gatekeeper shows the member's own name.
The secrets and the workflow from ADR 0014 stay as they are.

**Linux is unchanged**: no signing; checksums and build provenance cover it
like the other platforms.

## Consequences

- The site publishes a code signing policy page, as SignPath requires: who
  commits, reviews and approves, the attribution "Free code signing provided
  by SignPath.io, certificate by SignPath Foundation", and what the app sends
  over the network on its own (the update check against GitHub Releases).
- Every Windows release waits for a manual approval in SignPath.
- The SignPath terms bind the project: an OSI license with no commercial
  dual licensing for what is signed, no proprietary components in it, and the
  Foundation can revoke the certificate for a breach.
- No company appears in the installers. The copyright line moves from a
  company to "The Comitiva contributors".
- Users who installed an unsigned Windows build update to the first signed one
  normally: electron-updater checks the publisher only when the running build
  has `publisherName` set.
