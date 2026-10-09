# 0018 — The hub under Apache-2.0, with no CLA

- Status: Accepted
- Date: 2026-10-09
- Supersedes: the hub's license and CLA in ADR 0015

## Context

ADR 0015 put the community hub under AGPL-3.0, so that anyone offering a
modified hub as a service must publish their changes, and asked for a CLA, so
that the project could combine contributed code with the closed enterprise
package. The enterprise package is a Composer package that runs in the hub's
own process; under the AGPL, that combination is a derivative work, and only a
copyright holder of every line may ship it closed. Hence the CLA.

That choice has costs that showed up before the first outside contribution:

- The CLA needs a legal party to receive the rights, so every contributor
  signs an agreement with a company, and the text needs a lawyer before the
  hub accepts any pull request.
- Other companies cannot build their own closed enterprise layer on the hub's
  extension points: in the same process, their code would have to be AGPL
  too. The extension points are meant to be a public API (ADR 0015), and the
  AGPL narrows who can use them.
- Moving the enterprise layer out of the process to stay clear of the AGPL
  would turn every extension point (`RunGate`, `IdentityProvider`,
  `PlanLimits`, `BillingGateway`) from a call into a remote API, with latency
  on every run and a separate UI for billing and admin.

The hub has a single author so far, so its license can still change by that
author's decision alone.

## Decision

**The hub is licensed under Apache-2.0, like this repository.** Contributions
are accepted under the same license (inbound = outbound), with no CLA, as ADR
0001 does here. The copyright stays with each contributor.

**Nothing else in ADR 0015 changes.** The four repositories, the open core
through extension points with community defaults, the private
`hub-enterprise` package for the hosted hub at `app.comitiva.dev`, the
contract and the web UI living here, and the tests across repositories all
stand. Anyone, not only the project, may now build an enterprise layer on the
same extension points.

## Consequences

- Anyone may host and sell a modified hub, closed. The project's protection
  is the official hosted hub being the desktop's default, the quality of its
  enterprise features, and the name "Comitiva" (a trademark policy can state
  who may use it).
- No company has to be named in the public repositories: no CLA, no copyright
  assignment. A legal entity is needed only to bill the hosted hub and to hold
  the trademark.
- The hub drops `CLA.md`, and CLA Assistant is not installed. Its open item
  "legal review of AGPL-3.0 and the CLA text" is gone.
- Code may move between the hub and this repository as far as licenses go.
  They remain separate stacks (PHP and TypeScript), so what both need still
  lives in the contract here.
- The hub had no release before this change. Its earlier commits, and the
  images built from them, were published under AGPL-3.0 and stay so; every
  commit from this change on is Apache-2.0.
