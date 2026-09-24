# 0015 — The hub in its own repository: AGPL community edition, private enterprise package

- Status: Accepted
- Date: 2026-09-24

## Context

SPEC §4 placed the Laravel hub in this monorepo as `apps/hub`, and ADR 0001
assumed a hub that teams self-host. After v0.1.0 the plan grew: besides the
self-hostable hub, there will be an **official hosted hub** at
`app.comitiva.dev`, billed by usage, with features that stay closed (billing,
plans, SSO, audit, admin). The questions this raises cross every package and
every future repository:

- Where does the hub live, and under what license, so that a competitor cannot
  resell the community hub as a service while teams can still run it
  themselves?
- Where does the closed code live, and how does it plug into the open hub
  without the open hub knowing about it?
- How do the contract, the web UI and the tests keep working across
  repositories?

## Decision

**Four repositories under `comitiva-dev`.**

| Repository | License | Contents | Runs at |
|---|---|---|---|
| `comitiva` (this one) | Apache-2.0 | desktop, runner, contract, mcp-servers; `RemoteBackend` (Phase 8); `apps/web` (Phase 9) | users' machines |
| `hub` | AGPL-3.0, contributions under a CLA | Laravel hub, **community edition**, self-hostable; public image `ghcr.io/comitiva-dev/hub` | anywhere |
| `hub-enterprise` | proprietary, private | Composer package `comitiva/hub-enterprise` and the CI that builds and deploys the hosted hub | `app.comitiva.dev` only |
| `comitiva.dev` | — | static site; also serves `/schema/*.json`, the `$id`s from ADR 0005 | `comitiva.dev` |

This repository keeps Apache-2.0 and inbound = outbound contributions, with no
CLA (ADR 0001 stands). The hub is AGPL-3.0 so that anyone offering a modified
hub as a service must publish their changes. The CLA (CLA Assistant on the
hub's pull requests) lets the project combine contributed code with the
closed enterprise package. Both the license choice and the CLA text go past a
lawyer before the hub takes its first outside contribution.

**Open core through extension points.** The hub defines interfaces with
community defaults and binds them in its own service provider: a
`BillingGateway` (none), a `UsageMeter`, a `RunGate` for usage policies (allow
all), `PlanLimits` (unlimited), an `IdentityProvider` (email and Sanctum) and
an `AuditSink` (none). It emits domain events such as `RunCompleted` (with its
usage), `WorkspaceCreated` and `MemberAdded`. The enterprise service provider
rebinds those interfaces and adds its own routes, migrations and pages.

- The hub never references enterprise code. The enterprise package uses only
  the documented interfaces and events, which are the hub's semver-public API.
- The enterprise edition runs only at `app.comitiva.dev` for now. Its CI checks
  out `hub` at a tag, requires the package, builds a private image and deploys
  it. A self-hosted enterprise edition (license key, private image) can come
  later on the same extension points.
- The hub reports itself through a metadata endpoint: `apiVersion`, `edition`
  (`community` | `cloud`) and capabilities. The desktop's hub URL defaults to
  `app.comitiva.dev` and can be changed for a self-hosted hub.

**The contract stays here.** `@comitiva/contract` (zod) remains the single
source of truth, including the hub's HTTP and WebSocket payloads. The hub pins
a release tag of this repository, copies `packages/contract/schema/*.json`
from it into its own tree, commits the copy, and fails CI when the copy drifts
from the pinned tag. It validates with a draft 2020-12 validator, as ADR 0005
expects.

**The web UI stays here.** The renderer moves to `packages/ui`, and
`apps/desktop` and `apps/web` become thin shells that plug in `LocalBackend`
and `RemoteBackend`. The web UI does not depend on the edition: desktop-only
features stay behind `capabilities()`. Enterprise pages (billing, plans, SSO,
admin) are not part of it; the enterprise package renders them in the hub, and
the web UI links to them when the hub reports the `cloud` edition. The web UI
is released as a versioned static bundle; the hub pins a version and serves
it, and the hosted hub may deploy it from `main`.

**Tests across repositories.** The hub publishes an image for every commit on
its `main` and every tag. This repository's `RemoteBackend` e2e runs that
image, pinned to a version, as a service, so the whole path is still covered
end to end. Unit and integration tests use a fake hub, as they use fake
providers today.

**Billing by usage covers only what the server runs.** Runs the hub executes
(Phase 9: API connections and `http` MCP servers) are metered on the server
with the runner's pricing table (ADR 0011). Usage a desktop reports (CLI
harnesses, `stdio` MCP servers, a desktop acting as the workspace runner) is
shown but not billed by usage, because a client can alter it; seat or
workspace pricing covers it. Billing lands with Phase 9 at the earliest.

## Consequences

- SPEC's tree loses `apps/hub`; Phase 8 starts by creating `comitiva-dev/hub`
  (AGPL, CLA Assistant, image publishing) before any hub code.
- The web UI and its shared components stay Apache-2.0, so the desktop can keep
  using them. Keeping them in the AGPL hub would have forced the desktop to
  change license or the components to be dual-licensed.
- Contract changes that the hub needs take two steps: a release here, then a
  bump of the pinned tag in the hub. The drift check makes a missed step
  visible.
- The hub's extension interfaces and events become a public API with semver
  obligations; breaking them breaks the hosted hub.
- A single-repository change can no longer cover a feature that spans desktop
  and hub; the pinned image in this repository's e2e is what keeps them
  honest.
- Code must never move from `hub-enterprise` into `hub` or here, nor from the
  AGPL `hub` into this Apache repository.
