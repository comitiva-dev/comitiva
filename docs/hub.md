# The hub: workspaces for teams

A hub lets a team share agents and conversations and watch replies stream in, live, on
everyone's screen. It is optional: without one, Comitiva works as before on your computer
(**Personal**). The hub is a separate, self-hostable server,
[comitiva-dev/hub](https://github.com/comitiva-dev/hub) (AGPL-3.0). The official hosted hub runs at
`app.comitiva.dev`. Why it works this way: ADR 0015, 0016 and 0017.

## For users

### Connect and sign in

1. **Settings → Hub**: enter the hub's address and choose **Connect**. Comitiva checks that the
   address answers like a hub it supports.
2. **Create account**, or **Sign in**. Comitiva keeps a token for this computer in your system's
   keyring and never shows it to the window. **Sign out** revokes it.

### Workspaces

The menu at the top of the sidebar switches between **Personal** (this computer only) and your
workspaces. **New workspace…** creates one, and you become its owner. **Join with a link…** accepts
an invitation.

On the **Workspace** screen, owners and admins invite people. Enter their email address, choose
**Create link**, and send them the link. It works once and for 7 days, and only for that email
address. Owners change roles (a workspace always keeps an owner). Admins remove members. Anyone can
leave.

| Role | Can |
|---|---|
| Member | use every agent, share agents, create and rename conversations, send |
| Admin | also manage members, invitations, every agent, and workspace tool servers |
| Owner | also change roles and delete the workspace |

### Shared agents run with your connection

An agent in a workspace names a provider and a model, but no connection: your API keys are never
shared. The first time you use a shared agent, **Edit** it and choose one of your connections. You
can also add your own folders and local tools; they stay on your computer. Until you do,
the composer asks you to choose a connection.

To share one of your Personal agents, open it and use **Share** in its panel. It is copied into the
workspace, and you run it with the same connection and folders. Your Personal agent and its
conversations stay where they are.

When you send a message, your computer runs the reply with your connection, and everyone in the
workspace sees it stream in. The chat header says whose computer is running a reply. If the agent
wants to write a file, only the person whose computer runs it can allow it: the file is on their
computer. The others see "Waiting for …'s answer".

**Stop** works for the member running the reply and for admins. If that computer closes or loses
its connection, the reply ends as interrupted after about 30 seconds, and anyone can retry it.

### What stays on your computer

Connections and keys, your Personal agents and conversations, folders, local (stdio) tool servers,
"always allow" decisions, and the secret headers of workspace tool servers. You enter those
secrets in the Tools screen, and each member enters their own.

### Offline

A workspace needs the hub. When it cannot be reached, requests fail with "Could not reach the hub",
and Personal keeps working. There is no offline copy of a workspace to edit and merge later.

## For developers

### Pieces

| Where | What |
|---|---|
| `packages/contract/src/hub/` | Entities, REST payloads and `HubEvent`, published as `schema/*.json` and tagged `contract-v*` for the hub (ADR 0016) |
| `apps/desktop/src/main/hub/` | `HubService` (token, REST, socket), `PusherSocket`, `HubChatStore` and `HubRunService` (workspace turns), `HubAttachments` |
| `apps/desktop/src/main/services/chat/` | `RunEngine` and the `ChatStore` port: one engine for Personal and workspace conversations |
| `apps/desktop/src/renderer/src/backend/RemoteBackend.ts` | `Backend` over the hub, through `HubTransport` and `HubExecutor` (IPC to main) |
| `apps/desktop/src/renderer/src/Root.tsx` | Rebuilds the stores when the window switches scope |

The flow of a workspace turn is in `docs/architecture.md` → Workspace runs.

### Changing the hub's payloads

1. Change the zod schemas in `packages/contract/src/hub/` (or the shared entities), run
   `pnpm contract:schema`, bump `packages/contract/package.json`, commit, and tag
   `contract-vX.Y.Z`. A new optional field is a minor version; anything an existing hub or desktop
   would misread is a major version, together with a new `HUB_API_VERSION`.
2. In the hub, run `php artisan contract:sync contract-vX.Y.Z --from=../comitiva`, adapt the hub,
   and commit. Its CI runs `contract:check`.

### Running a hub locally

```bash
cd ../hub && docker compose up -d && docker compose exec app composer install \
  && docker compose exec app php artisan migrate
# the hub at http://localhost:8810, Reverb at localhost:8811
```

Then point two dev instances of the desktop at it, each with its own data:

```bash
COMITIVA_USER_DATA=/tmp/comitiva-ana pnpm dev
COMITIVA_USER_DATA=/tmp/comitiva-bea pnpm dev
```

### Testing

- Unit and integration tests run against `FakeHub` (`src/main/testing/FakeHub.ts`), an in-process
  stand-in for the hub's REST API and a Pusher-protocol server. `src/main/hub/twoDesktops.test.ts`
  runs two complete desktop stacks in one workspace.
- `pnpm --filter desktop test:e2e:hub` runs two Comitiva apps against the hub's image in Docker
  (`e2e-hub/docker-compose.yml`). The image is `HUB_IMAGE`, by default `comitiva-hub:local`:
  `docker build --target production -t comitiva-hub:local ../../../hub`. `KEEP_HUB=1` keeps the
  hub running afterwards.
