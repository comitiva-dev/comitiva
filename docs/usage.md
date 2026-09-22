# Usage and cost

How Comitiva accounts for every call, what it costs, and where those numbers
come from. The decision behind it is ADR 0011; the entity is `UsageRecord`
(SPEC §3).

## One record per run

A record is written when a run ends — successfully, with an error, or
cancelled — inside the same transaction as the final message. Title runs write
one too, with `messageId: null` and their own cheap model, so the cost of
naming a conversation is not invisible.

`ConversationService.finish` and `TitleService.recordUsage` are the two
writers. Neither knows about pricing: cost is computed inside
`UsageRepository.insert`.

## What the providers report

Every adapter ends a turn with exactly one `run.usage`. Two things had to be
made true across all six before any of it could be costed:

**`inputTokens` is net of `cacheReadTokens`.** Providers disagree. OpenAI's
`prompt_tokens` and Gemini's `promptTokenCount` include the cached tokens;
Anthropic's `input_tokens`, Claude Code's and Codex's do not. Each adapter
subtracts before reporting, so the contract holds one meaning and cost can
charge cached tokens at the cache rate exactly once.

**A failed run still reports.** `streamTurn` yields the usage known so far
before rethrowing. Tokens spent by a run that died mid-stream are billed by the
provider, and a dashboard that forgets them is wrong by exactly that much.

| Provider | Cache read | Cache write | Model reported | Notes |
|---|---|---|---|---|
| `anthropic` | yes | yes | yes | `input_tokens` is already net |
| `openai-compatible` | yes | n/a | yes | needs `stream_options.include_usage`; many compatible servers never send it, and then the count is estimated |
| `google` | yes | n/a | yes | thinking tokens are billed as output and folded in |
| `ollama` | n/a | n/a | no | local, priced at zero |
| `claude-code` | yes | yes (5m and 1h buckets summed) | yes, from `modelUsage` | also reports `total_cost_usd` at list prices |
| `codex` | yes | yes | no | `reasoning_output_tokens` is already inside `output_tokens` |

## When nothing is reported

`packages/runner/src/usage/Tokenizer.ts` estimates, and the record is flagged
`estimated`. It is word-, punctuation- and CJK-aware, counts the JSON of tool
calls and their results, and charges images and documents a flat rate. It is
not a BPE tokenizer: every model uses a different vocabulary, and shipping rank
tables would add megabytes to a binary that has to stay self-contained. The
tool loop re-seeds the prompt estimate before each model call, because the
history grows with every tool result.

The UI never presents an estimate as a measurement — the totals card and the
right panel both say when part of a window was counted locally.

## Prices

`packages/runner/src/usage/pricing.json` ships with the runner. It carries its
`version`, the `updatedAt` date and the pages each provider's numbers came
from. **Read prices off those pages when updating; never from memory.**

- `aliases` sends a CLI provider to the API it bills on, so `claude-code` uses
  the `anthropic` table.
- Lookup is exact id, then the longest listed id the model starts with (so
  `claude-sonnet-5` prices `claude-sonnet-5-20260101`), then the provider's
  `*` entry (`ollama` is zero).
- A model nothing matches has **no** cost rather than a wrong one. The window
  says "some models have no price" and the Prices section offers to set one.
- An unknown cache rate falls back to the input price, which is what the
  provider charges in that case.

### Correcting a price

The Prices section of the Usage screen lists every model that appears in the
records. Saving a correction writes `model_prices` in SQLite, which wins over
the shipped table, and **recosts every record of that model**, so one model
never shows two prices in one window. "Use default" drops the correction and
recosts back.

Records whose `costSource` is `harness` are never recosted: that number is the
harness's own measurement.

## CLI harnesses cost an *equivalent*

Claude Code and Codex report real token counts, but most people run them on a
subscription where the marginal cost of a run is nothing. Their tokens are
priced at the API's list rates and summed into `costUsdCli`, separate from
`costUsd`, with the label "your plan may bill differently" wherever they show.
The two are never added: the sum would match no invoice.

Where the harness computes its own cost — Claude Code's `total_cost_usd` — that
wins, and the row is marked `harness`.

## The reports

`UsageRepository` does the aggregation in SQL, over the indexes migration 0006
adds. Two details worth knowing:

- **No foreign keys.** Usage outlives the agent or connection it belonged to,
  so the groupings LEFT JOIN and the service labels what is gone as deleted.
- **A day is the viewer's.** `created_at` is ISO 8601 UTC text; the daily
  bucket shifts it by the viewer's offset before taking the date, while the
  range predicate still compares raw UTC text so the index still covers it.

IPC: `usage.summary | timeseries | conversation | export | prices | setPrice |
clearPrice`.

## Export

Two shapes, both written by main through a native save dialog (the renderer
never touches the filesystem), RFC 4180 with a BOM so a spreadsheet reads UTF-8:

- **runs** — one row per record: date, provider, model, the ids, every token
  counter, whether the tokens were estimated, the cost and where it came from,
  whether it is billed or equivalent, and latency. Title runs are marked
  `(title)` in the message column.
- **summary** — what the screen shows: the total, then a row per connection,
  agent, model and day.

## Open

- A range straddling a daylight-saving change is bucketed with one fixed
  offset, so one boundary can be an hour off.
- Prices update with a release. A user can correct any model immediately, and
  `pricing.json` says how old it is.
- If the runner never answers a cancel and main finalizes locally, no tokens
  are known and no record is written.
