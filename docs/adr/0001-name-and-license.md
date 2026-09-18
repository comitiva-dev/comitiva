# 0001 — Name "Comitiva" and license Apache-2.0

- Status: Accepted
- Date: 2026-09-18

## Context

SPEC §7 left open the product name and the license (Apache-2.0 vs MIT). The project is open source, may be backed by a company, and will ship a desktop app plus a hub that teams self-host.

## Decision

- The product is called **Comitiva** ("agentic chat for your whole team"). Package scope `@comitiva/*`.
- The code is licensed under **Apache-2.0**.

## Consequences

- Apache-2.0 gives an explicit patent grant and patent-retaliation clause, which matters for contributors and adopters in companies. MIT has neither.
- Contributions are accepted under the same license (inbound = outbound, stated in CONTRIBUTING.md). No CLA for now.
- Redistributors must keep the LICENSE and any NOTICE file. We add a NOTICE file if we ever vendor third-party code that requires one.
