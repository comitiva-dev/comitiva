# 0010 — Our own Google Drive server; OAuth and refresh in the desktop, the token handed over per launch

- Status: Accepted
- Date: 2026-09-22

## Context

Phase 5b adds the second built-in MCP server, Google Drive. It must search and read (with Google Docs and Sheets exported to text), and create, update and move, with writes behind the same approvals as the filesystem server. SPEC §2.4 keeps secrets out of plain text, and CLAUDE.md requires the server to get its token via env and never read it from disk. SPEC §7 left open whether to adopt a community server or write our own.

We checked the maintained community servers (September 2026):

- The official `@modelcontextprotocol/server-gdrive` was archived in May 2025, and its forks stay close to it.
- `piotr-agier/google-drive-mcp` has 129 tools across Drive, Docs, Sheets, Slides and Calendar.
- `a-bonus/google-docs-mcp` has 100+ tools, including Gmail and Calendar.

Each of them runs its own OAuth flow and keeps credentials and tokens in files under `~/.config`. They pull in `googleapis`, and they do not declare the MCP annotations the permission gate relies on.

## Decision

1. **Write our own server** in `packages/mcp-servers/src/google-drive`, bundled as `dist/google-drive.cjs`:
   - It has five tools: `search`, `read`, `create`, `update` and `move`.
   - It calls Drive REST v3 with `fetch`. It has no `googleapis` dependency.
   - Its tools carry `readOnlyHint`, `destructiveHint` and `openWorldHint`.
   - Like the filesystem server, it registers write tools only with `--gated-by-client`.
   - It reads the access token from `GDRIVE_ACCESS_TOKEN` and removes it from its own environment. It never touches the disk.
2. **OAuth lives in the desktop's main process** (`main/oauth/GoogleOAuth.ts`):
   - It is the installed-app flow with a loopback redirect on `127.0.0.1` (random port), PKCE S256 and a random `state`. The listener takes one request and closes.
   - The scope is the full `drive` scope.
   - The user brings their own OAuth client (type "Desktop app"). Comitiva ships no credentials.
   - The client and the tokens live in the SecretStore (`google:oauthClient`, `google:tokens`). They never reach SQLite, IPC or logs.
3. **The token is refreshed before each launch and handed over as env:**
   - `ToolServerService` resolves the Drive launch per run or test, with `GDRIVE_ACCESS_TOKEN` from `GoogleDriveService.accessToken()`.
   - That call refreshes the token if fewer than 15 minutes are left. The refresh is single-flight.
   - The runner keys instances by a hash of the launch, so a new token starts a new instance, and the old one closes once idle. The runner protocol does not change.
   - Refresh tokens never leave main.
4. **One Google account per app**, on the fixed built-in id `google-drive` (seeded by migration `0005`).
5. **A refused refresh (`invalid_grant`) marks the account `reconnect_required`.** This covers a revoked grant, or the 7-day expiry for apps in Testing status. Sends from agents with Drive are then refused up front with `google_reconnect_required`.

## Consequences

- There is little to audit, and no token files. The fake Google server (`@comitiva/mcp-servers/testing`) covers OAuth and the Drive API in unit tests, runner tests and the e2e.
- A single run that lasts longer than about 15 minutes can see its token expire. The server then answers `auth_failed`, and the next run gets a fresh token. The alternative was handing the refresh token and client secret to the server, which we rejected.
- Users must create a Google Cloud OAuth client once (`docs/tools.md`). With an External app in Testing status, Google asks them to sign in again every 7 days.
- Sheets are read through Drive's CSV export, which only covers the first sheet. Other sheets would need the Sheets API.
- Docs are exported and imported as Markdown (`text/markdown`). This is covered against the fake; it needs a check against the real API.
