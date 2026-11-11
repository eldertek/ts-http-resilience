# Changelog

All notable changes to `ts-http-resilience` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-11

### Added
- `resilientFetch` wrapper with configurable retry counts, status codes, and method safety rules.
- `computeBackoffDelayMs`, `parseRetryAfterMs`, and `resolveRetryDelayMs` supporting `"full"`, `"equal"`, and `"none"` jitter plus RFC 9110 `Retry-After` headers.
- Per-attempt `timeoutMs` abort handling (`RequestTimeoutError`) composed cleanly with caller `AbortSignal`.
- `ensureIdempotencyHeader` and `autoIdempotencyKey` option preserving stable `Idempotency-Key` headers across retried mutating calls.
- `createResilientClient` factory with `baseUrl` resolution, default headers merging, and typed `fetchJson<T>()` helper throwing `HttpStatusError`.
- Vitest unit test suite and GitHub Actions CI matrix across Node.js 22 and 24.
