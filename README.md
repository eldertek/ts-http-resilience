# ts-http-resilience

Zero-dependency TypeScript `fetch` wrapper providing exponential backoff, configurable jitter, RFC 9110 `Retry-After` parsing, per-attempt `AbortSignal` timeouts, and automatic `Idempotency-Key` headers for safe mutating retries.

## Features

- **Zero runtime dependencies:** Built strictly on standard Web Platform primitives (`fetch`, `Headers`, `AbortController`, `crypto.randomUUID`).
- **Configurable backoff & jitter:** Supports `"full"`, `"equal"`, and `"none"` jitter modes with upper delay caps.
- **RFC 9110 `Retry-After` support:** Parses both integer delta-seconds and HTTP-date headers while bounding wait durations by `maxDelayMs`.
- **Safe mutating retries:** Avoids retrying `POST` or `PATCH` requests unless `autoIdempotencyKey: true` (or an explicit `Idempotency-Key` header) is present, preserving the exact key across retry attempts.
- **Per-attempt timeouts + caller cancellation:** Combines per-attempt `timeoutMs` deadlines with caller `AbortSignal` cancellation without leaking timers or unread response streams.

## Installation

```bash
npm install ts-http-resilience
```

Requires Node.js 22.12+ or any modern JavaScript runtime supporting global `fetch`.

## Quick Start

### Standalone `resilientFetch`

```ts
import { resilientFetch } from "ts-http-resilience";

const response = await resilientFetch("https://api.example.com/v1/charges", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ amountCents: 4900, currency: "EUR" }),
  autoIdempotencyKey: true,
  timeoutMs: 5_000,
  maxRetries: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  jitter: "full",
});
```

### Reusable `createResilientClient`

```ts
import { createResilientClient } from "ts-http-resilience";

interface InvoiceSummary {
  id: string;
  status: "draft" | "paid";
}

const api = createResilientClient({
  baseUrl: "https://api.example.com/v1",
  defaultHeaders: {
    Authorization: `Bearer ${process.env.API_TOKEN}`,
  },
  timeoutMs: 4_000,
  maxRetries: 3,
  onRetry: ({ attempt, delayMs, status }) => {
    console.warn(`Retry #${attempt} in ${delayMs}ms (status=${status ?? "network-error"})`);
  },
});

const invoice = await api.fetchJson<InvoiceSummary>("/invoices/inv_1042");
```

## Policy Options

| Option | Default | Description |
| :--- | :--- | :--- |
| `maxRetries` | `3` | Maximum retry attempts after the initial request. |
| `baseDelayMs` | `250` | Initial backoff delay in milliseconds before exponential growth. |
| `maxDelayMs` | `10000` | Maximum delay cap in milliseconds for any single retry wait. |
| `factor` | `2` | Exponential multiplier per retry attempt. |
| `jitter` | `"full"` | Randomization strategy (`"full"`, `"equal"`, or `"none"`). |
| `timeoutMs` | `undefined` | Optional per-attempt timeout in milliseconds (`RequestTimeoutError`). |
| `respectRetryAfter` | `true` | Honors `Retry-After` response headers (bounded by `maxDelayMs`). |
| `autoIdempotencyKey` | `false` | Generates and preserves an `Idempotency-Key` header on mutating methods (`POST`, `PUT`, `PATCH`, `DELETE`). |

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

Released under the [MIT License](./LICENSE) by [Eclipse Technology](https://eclipse-technology.eu).
