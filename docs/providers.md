# Adding a provider adapter

How to teach the runner a new LLM API. The four API adapters (`anthropic`, `openai-compatible`, `google`, `ollama`) follow this recipe; use them as working examples. CLI harnesses (Phase 2) follow a different base class, `CliHarnessAdapter`.

Order, as everywhere in the repo: **contract → runner → (main and renderer need nothing) → tests**.

## 1. Contract: config and descriptor

In `packages/contract/src/provider-config.ts`:

- Add the id to `ProviderId`.
- Add a `XxxConfig` zod schema with the provider's settings (`baseUrl`, `defaultModel`, …). Secrets never go here.

In `packages/contract/src/entities/connection.ts`, add a variant to the `Connection` union (`kind: 'api'`, `provider: z.literal('xxx')`, `config: XxxConfig`).

In `packages/contract/src/ipc.ts`, add the variant to `apiProviderVariants`, so the IPC draft and probe schemas accept it.

In `packages/contract/src/providers.ts`, add a `providerDescriptors` entry. This is what the UI builds the form from, and the adapter's `capabilities` come from here:

```ts
xxx: {
  id: 'xxx',
  kind: 'api',
  label: 'Xxx',
  capabilities: textOnly,             // be honest: only what the adapter does today
  secret: 'required',                 // 'required' | 'optional' | 'none'
  baseUrl: { mode: 'advanced', default: 'https://api.xxx.com' },  // or mode 'required'
},
```

Then run `pnpm contract:schema` and commit the regenerated JSON.

The Connections form picks the provider up by itself: the provider list, the key field (required, optional or hidden), the base URL (always shown, or behind "Advanced"), fetch models and test. Only `ProviderIcon.tsx` needs a monogram for it.

## 2. Runner: the adapter

Create `packages/runner/src/providers/api/XxxAdapter.ts` implementing `ProviderAdapter` (`providers/ProviderAdapter.ts`):

```ts
export class XxxAdapter implements ProviderAdapter {
  readonly id = 'xxx' as const;
  readonly kind = 'api' as const;
  readonly capabilities = providerDescriptors.xxx.capabilities;

  testConnection(connection, secret) {
    return probe((signal) => /* cheapest authenticated call */, toAppError);
  }
  listModels(connection, secret) {
    return withDeadline(async (signal) => /* → ModelInfo[] */, toAppError);
  }
  run(input, ctx, signal) {
    const usage = UsageTracker.for(input);
    return streamTurn({
      signal, usage, toAppError,
      body: async function* (): AsyncGenerator<AdapterEvent, StopReason> {
        // call the API with `signal`, yield { type: 'run.text_delta', text },
        // usage.report({ input, output, cacheRead, final: true }) when the provider says so,
        // return the mapped stop reason
      },
    });
  }
}
```

Register it in `createDefaultRegistry()` (`providers/ProviderRegistry.ts`).

The helpers in `providers/api/shared.ts` enforce the rules every adapter must follow:

| Rule | Helper |
|---|---|
| Every turn ends with exactly one `run.usage`, then `run.done`. Failures are thrown as `AppError`, and `Run` turns them into `run.error`. | `streamTurn` |
| Cancel is not an error. It yields the usage known so far (`estimated: true`) and `done { stopReason: 'cancelled' }` right away, even if the SDK keeps its stream open. | `streamTurn` (races every read against the signal) |
| Usage the provider does not report is estimated: about 4 chars per token for output, and the prompt for input. | `UsageTracker` |
| HTTP errors map to stable codes: 401/403 → `auth_failed`; 429 → `rate_limited` (retryable); 5xx → `provider_unavailable` (retryable); other 4xx → `provider_error`. | `httpError` |
| No response (refused, DNS, reset) → `provider_unavailable` (retryable). A timeout → `timeout` (retryable). | `networkError`, `isFetchFailure` |
| Test and list models give up after 15 s with `timeout`. `testConnection` never throws; it returns `{ ok: false, error }`. | `withDeadline`, `probe` |
| Messages the provider cannot take yet (images, tool results) fail with `unsupported_content`. | `plainText` |

Your own `toAppError(err)` should check the SDK's error classes first (timeout before connection error), then fall back to `httpError(status, …)`, `networkError`, and finally `AppError.from`.

### Non-negotiables

- **Explicit credentials and endpoint.** Pass the key and the base URL explicitly, and null out any other credential option the SDK has. Most SDKs silently read `XXX_API_KEY` / `XXX_BASE_URL` from the environment; the runner must never do that. The conformance suite checks it.
- **No Electron, no persistence.** The adapter gets the key per call and must not store it or log it.
- **Retries.** Probes use `maxRetries: 0` (fast feedback in the form). Runs may keep the SDK default.
- **Stop reasons.** Map them onto `StopReason` (`end_turn`, `max_tokens`, `refusal`, `tool_use`, …), with `other` as the fallback.

## 3. Tests

**Conformance (msw).** Add `packages/runner/test/adapters/xxx.test.ts`. It describes the provider's wire format as a `Wire` and calls `describeAdapterConformance(wire)` from `conformance.ts`. The suite covers:

- deltas in order
- exact usage, and estimated usage when none is reported
- the max-tokens stop
- cancel mid-stream (the request is closed)
- 401/403/429/500/503/404 on run, test and listModels
- a real refused connection
- model parsing
- test latency
- ambient env credentials ignored

Add provider-specific tests next to it: the request body mapping, and any odd error shapes (Gemini answers a bad key with 400 `API_KEY_INVALID`, for example).

**Fake server.** Add routes under a new prefix in `src/testing/fakeProviders.ts`, honoring the same prompt controls (`[error:N]`, `[chunks:N]`, `[interval:MS]`) and `bad-key`. Add a fixture in `src/testing/fixtures.ts` and include it in `fakeConnections`. The `bin.cjs` integration tests (`test/client.test.ts`) and the desktop e2e (`apps/desktop/e2e/connections.spec.ts`) then run through it. msw cannot reach a spawned process, which is why this real server exists.

**Real provider.** Before calling it done, run it by hand once against the real API: test, list models, and a short streamed run. Record the result in `docs/STATUS.md`.
