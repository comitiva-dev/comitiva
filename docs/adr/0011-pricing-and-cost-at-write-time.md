# 0011 — Pricing in the runner, cost computed at write time

- Status: Accepted
- Date: 2026-09-22

## Context

Phase 6 has to answer "what did this cost". `usage_records` had a `cost_usd`
column since Phase 0 and it had always been `NULL`. Filling it raises four
questions that each affect more than one package.

**Where the prices live.** They change without our code changing, and the
Laravel hub (Phase 8) will have to reach the same number for the same row, in
PHP. Whatever holds them has to be readable from both.

**When cost is computed.** On read, from today's prices, or on write, from the
prices in force then.

**What a price correction does to history.** The table will be wrong or stale
for somebody — a negotiated rate, a model we do not list, a price that moved.

**What a CLI harness costs.** Claude Code and Codex report full token counts,
but most people run them on a subscription. The marginal cost of a run on a
Max plan is nothing, and the list-price value of its tokens is not a bill.

## Decision

**One versioned table, in `packages/runner/src/usage/pricing.json.`** It carries
`version`, `updatedAt` and the pages each provider's numbers were read from, so
a stale table is visible rather than silent. `aliases` maps a CLI provider onto
the API it bills on, instead of repeating the numbers. Lookup is exact id, then
the longest listed id the model starts with — `claude-sonnet-5` prices
`claude-sonnet-5-20260101` — then the provider's `*` entry. A model nothing
matches has **no** cost, not a guessed one; the UI says so and offers to set a
price. The file is imported with `with { type: 'json' }`, as `version.ts`
already imports `package.json`, so tsup inlines it into both `dist/bin.cjs` and
`dist/index.js`; electron-vite bundles the latter into main. Nothing to ship,
nothing to resolve at runtime, and the hub can read the same file.

**Cost is computed when the row is written**, inside `UsageRepository.insert`,
so replies and title runs both get it without either service knowing about
pricing. The dashboard has to match what was billed at the time, and a cost
computed on read would silently rewrite last month's spend the day a provider
changes a price.

**A correction recosts that model's rows.** `model_prices` in SQLite holds the
user's corrections and wins over the shipped table; saving one recomputes
`cost_usd` for every record of that model. The alternative — going forward only
— leaves one model showing two prices in one window, which is worse than either
price alone. Rows whose `cost_source` is `harness` are never touched: that
number is the harness's own measurement, not our arithmetic to redo.

**CLI cost is an equivalent, and says so.** Harness tokens are priced at the
API's list rates, summed into `costUsdCli` rather than `costUsd`, and shown in
its own tile and column with "your plan may bill differently". Adding the two
would produce a figure matching no invoice. Where the harness computes its own
cost — Claude Code's `total_cost_usd`, at list prices — that wins.

## Consequences

- Updating prices means shipping a build. Acceptable while `model_prices` lets
  any user correct any model immediately, and the file says how old it is.
- `UsageRecord` grew `provider`, `costSource` and `costEstimated`, and
  `run.usage` grew `model` and `reportedCostUsd` (SPEC §3, migration 0006).
- Cost is only as good as the tokens under it. Making that true forced four
  recording fixes in the same phase: usage on failed runs, input normalized net
  of cache for every adapter, the model the provider actually ran, and an
  estimate re-seeded across tool-loop iterations.
- The hub will implement the same lookup in PHP against the same JSON. The
  prefix rule and the alias map are the parts to port carefully.
