# Development

Setting up, running, testing, packaging and releasing Comitiva. What the code
is and why is in [SPEC.md](../SPEC.md), [design.md](design.md) and
[architecture.md](architecture.md).

## Setup

| Tool | Version | Why |
|---|---|---|
| Node.js | 24 (`.nvmrc`); the packages support ≥ 22 | the app runs on Electron 44's Node 24 |
| pnpm | 10, through corepack (`packageManager` pins it) | workspaces with the hoisted linker (ADR 0006) |
| Build tools | Xcode CLT · VS Build Tools · `build-essential` + Python 3 | `better-sqlite3` when no prebuilt binary fits |
| Claude Code, Codex | optional | trying the CLI harnesses by hand |

```bash
corepack enable
pnpm install
pnpm dev                 # Ubuntu 24.04+: pnpm dev -- --noSandbox
```

On Ubuntu 24.04+, AppArmor keeps an unpackaged Electron from using its
sandbox; `--noSandbox`, or the other options in
[CONTRIBUTING.md](../CONTRIBUTING.md#linux-chromium-sandbox-on-ubuntu-2404),
fix that. Installed packages (deb, rpm, AppImage) do not need it.

On Linux, API keys need a running keyring (GNOME Keyring or KWallet).

## Everyday commands

```bash
pnpm dev                            # the desktop app, hot reload in the renderer
pnpm build                          # every package, in dependency order (turbo)
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm --filter desktop test:e2e      # builds the app, runs Playwright against the fake providers
pnpm contract:schema                # regenerate packages/contract/schema/*.json (commit it)
pnpm --filter desktop db:generate   # a Drizzle migration from db/schema.ts (commit it)
pnpm package                        # installers for this platform → apps/desktop/release/
pnpm --filter desktop test:packaged # smoke-test the packaged app (after pnpm package)
pnpm changelog                      # release notes since the last tag
pnpm runner:dev                     # the runner alone: type JSON lines into it
echo '{"id":"1","type":"ping"}' | node packages/runner/dist/bin.cjs
```

## Environment variables

| Variable | Effect |
|---|---|
| `COMITIVA_RUNNER_LOG` | Runner log level (`debug`, `info`…); stderr goes to `<userData>/logs/runner.log` |
| `COMITIVA_USER_DATA` | Use another data folder (the tests do) |
| `COMITIVA_ALLOW_WEAK_SECRET_STORAGE=1` | Tests and CI only: allow Linux's `basic_text` secret storage |
| `COMITIVA_DISABLE_UPDATES=1` | Never check for updates (the packaged smoke test sets it) |
| `COMITIVA_GOOGLE_OAUTH_BASE_URL`, `COMITIVA_GOOGLE_API_BASE_URL` | Tests only: point Google OAuth and the Drive API at the fake server |

`<userData>` is `~/.config/comitiva` (Linux), `~/Library/Application Support/comitiva`
(macOS) or `%APPDATA%\comitiva` (Windows). Its files are listed in
[architecture.md](architecture.md#data-locations).

## Tests

- **Unit and integration** (`pnpm test`): vitest in every package, plus
  `node --test` for `scripts/`. Desktop main runs under plain Node with
  in-memory SQLite; renderer stores run against a fake `Backend`. The runner's
  adapters go through a shared conformance suite over msw, and its integration
  tests spawn the bundled `dist/bin.cjs` against a real fake server for all
  four providers and two fake harnesses.
- **End to end** (`pnpm --filter desktop test:e2e`): Playwright launches the
  built app (not packaged) against the fake providers, the fake harnesses and
  a fake Google. Setup goes through `window.api`; everything under test goes
  through the UI. Native dialogs are stubbed with `electronApp.evaluate`.
  Screenshots land in `apps/desktop/test-results/`. On Linux CI it runs under
  Xvfb.
- **Packaged smoke** (`pnpm --filter desktop test:packaged`, after
  `pnpm package`): launches `release/*-unpacked` (or the `.app`) and checks
  that the runner, the MCP proxy, both built-in servers and the migrations
  work from the packaged resources. CI runs it on macOS, Windows and Linux.

Prompt controls for the fake providers: `[chunks:N]`, `[interval:MS]`,
`[error:NNN]`, `[tool:NAME {json}]`; the fake harnesses take `[mcp:NAME {json}]`
([tools.md](tools.md#testing)).

## Debugging

- The runner: `COMITIVA_RUNNER_LOG=debug pnpm dev`, then read
  `<userData>/logs/runner.log` (rotates at 5 MB). The runner never logs to
  stdout, which is its protocol channel.
- The database: `sqlite3 ~/.config/comitiva/comitiva.db '.tables'` (quit the
  app first, or open it read-only).
- The renderer: View → Toggle Developer Tools (development builds only).

## Database and migrations

The schema is `apps/desktop/src/main/db/schema.ts` (Drizzle, ADR 0003). Change
it, run `pnpm --filter desktop db:generate`, and commit the migration. Seeds,
backfills and things Drizzle cannot model (the FTS5 table in `0007`) go in a
custom migration: `pnpm --filter desktop exec drizzle-kit generate --custom --name <name>`.
Migrations run at startup, from `resources/migrations` in a packaged app.

## Packaging

`pnpm package` builds every package, then runs electron-builder for the
current platform (`apps/desktop/electron-builder.yml`, ADR 0014):

| Platform | Files |
|---|---|
| macOS | `Comitiva-X-mac-arm64.dmg`, `…-x64.dmg`, and zips (the updater's) |
| Windows | `Comitiva-X-win-x64-setup.exe` (NSIS, per user) |
| Linux | `.AppImage`, `.deb`, `.rpm` (the rpm needs `rpmbuild`: `sudo apt install rpm`) |

The runner, the MCP proxy, the built-in servers and the migrations ship
outside the asar (`extraResources`), because a process started with
`ELECTRON_RUN_AS_NODE` cannot read inside one. `pnpm --filter desktop package:dir`
builds only the unpacked folder, which is enough for the smoke test.

The icon is a placeholder: `apps/desktop/build/icon.svg`, rendered to
`build/icon.png` (1024×1024). Replace both; electron-builder derives the macOS
and Windows icons.

### Code signing (to do)

Builds are unsigned today. People see Gatekeeper's warning on macOS (right-click
→ Open, once) and SmartScreen's on Windows (More info → Run anyway). An
unsigned macOS build also cannot install updates itself: it shows that a
version is available and links to it.

To sign, add these repository secrets; the release workflow uses them when
present and builds unsigned otherwise:

| Secret | What |
|---|---|
| `CSC_LINK` | macOS: the Developer ID Application certificate (.p12), base64 or an https URL |
| `CSC_KEY_PASSWORD` | its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization (turns `mac.notarize` on) |
| `WIN_CSC_LINK` | Windows: the code-signing certificate (.pfx) |
| `WIN_CSC_KEY_PASSWORD` | its password |

With `CSC_LINK`, the workflow also records `comitiva.macSigned: true` in the
packaged `package.json`, which lets the macOS build install its own updates.
The hardened runtime and its entitlements (`build/entitlements.mac.plist`) are
already configured. Windows certificates from a cloud HSM (Azure Trusted
Signing, for example) need electron-builder's `win.azureSignOptions` instead of
`WIN_CSC_LINK`.

## Releasing

1. Bump the version in `apps/desktop/package.json` (and the packages, which
   move together) and commit: `chore: release 0.2.0`.
2. Update `CHANGELOG.md`: `pnpm changelog --version 0.2.0 --prepend CHANGELOG.md`,
   review, commit.
3. Tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
4. `.github/workflows/release.yml` runs the checks, verifies the tag matches
   the version, creates a draft release, builds and smoke-tests on the three
   OSes (signing when the secrets exist), uploads the installers and the
   updater's `latest*.yml`, writes the notes from the commits since the
   previous tag, and publishes. A tag with a suffix (`v0.2.0-rc.1`) publishes a
   prerelease, which installed stable builds do not update to.

To try the whole build without publishing, run the workflow by hand (Actions →
Release → Run workflow, "dry run" on): the installers are attached to the run.

Installed apps check `https://github.com/comitiva-dev/comitiva/releases` 10 s
after start and every 6 hours (Settings → Updates). The repository must be
public for that to work without a token.

## Conventions

Commits, the order of work inside a feature, i18n, errors and secrets:
[CLAUDE.md](../CLAUDE.md) and [CONTRIBUTING.md](../CONTRIBUTING.md).
