export type JitterStrategy = "full" | "equal" | "none";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RetryDecisionContext {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly method: string;
  readonly response?: Response;
  readonly error?: unknown;
}

export interface RetryAttemptNotice {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly delayMs: number;
  readonly method: string;
  readonly status?: number;
  readonly error?: unknown;
}

export interface BackoffOptions {
  /** Base delay in milliseconds before exponential growth. Defaults to 250. */
  baseDelayMs?: number;
  /** Upper bound in milliseconds for any single wait interval. Defaults to 10_000. */
  maxDelayMs?: number;
  /** Exponential growth factor per retry attempt. Defaults to 2. */
  factor?: number;
  /** Randomization mode applied to exponential backoff. Defaults to "full". */
  jitter?: JitterStrategy;
  /** Optional deterministic random source returning a float in [0, 1). */
  random?: () => number;
}

export interface ResiliencePolicy extends BackoffOptions {
  /** Maximum number of retry attempts after the initial call. Defaults to 3. */
  maxRetries?: number;
  /** HTTP status codes treated as transient failures. Defaults to [408, 425, 429, 500, 502, 503, 504]. */
  retryStatusCodes?: readonly number[];
  /** HTTP methods eligible for automatic retries when no custom shouldRetry is provided. */
  retryMethods?: readonly string[];
  /** Per-attempt timeout in milliseconds. Aborts slow attempts before evaluating retry eligibility. */
  timeoutMs?: number;
  /** Respect RFC 9110 Retry-After response headers when present. Defaults to true. */
  respectRetryAfter?: boolean;
  /** Inject and preserve an Idempotency-Key header on mutating methods (POST, PUT, PATCH, DELETE). */
  autoIdempotencyKey?: boolean;
  /** Header name used when autoIdempotencyKey is enabled. Defaults to "Idempotency-Key". */
  idempotencyHeaderName?: string;
  /** Custom key generator for idempotency headers. Defaults to crypto.randomUUID(). */
  generateIdempotencyKey?: () => string;
  /** Custom predicate overriding default status/method retry evaluation. */
  shouldRetry?: (context: RetryDecisionContext) => boolean | Promise<boolean>;
  /** Hook invoked immediately before waiting for the next retry attempt. */
  onRetry?: (notice: RetryAttemptNotice) => void | Promise<void>;
  /** Custom sleep implementation, primarily useful for deterministic testing. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetchImpl?: FetchLike;
}

export interface ResilientRequestInit extends RequestInit, ResiliencePolicy {}

export interface ResilientClientOptions extends ResiliencePolicy {
  /** Optional base URL prepended to relative request paths. */
  baseUrl?: string | URL;
  /** Default headers merged into every outgoing request. */
  defaultHeaders?: HeadersInit;
}

export class HttpStatusError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly url: string;
  public readonly bodyText: string;

  public constructor(response: Response, bodyText: string) {
    super(`HTTP ${response.status} ${response.statusText} (${response.url || "unknown-url"})`);
    this.name = "HttpStatusError";
    this.status = response.status;
    this.statusText = response.statusText;
    this.url = response.url;
    this.bodyText = bodyText;
  }
}

export class RequestTimeoutError extends Error {
  public readonly timeoutMs: number;

  public constructor(timeoutMs: number) {
    super(`Request attempt timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
