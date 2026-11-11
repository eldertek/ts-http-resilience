import type { BackoffOptions } from "./types.js";

const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 10_000;
const DEFAULT_FACTOR = 2;

/**
 * Computes the exponential backoff delay in milliseconds for a 1-indexed retry attempt.
 */
export function computeBackoffDelayMs(
  attempt: number,
  options: BackoffOptions = {},
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const factor = Math.max(1, options.factor ?? DEFAULT_FACTOR);
  const jitter = options.jitter ?? "full";
  const rand = options.random ?? Math.random;

  const unclamped = baseDelayMs * Math.pow(factor, safeAttempt - 1);
  const capped = Math.min(maxDelayMs, unclamped);

  if (jitter === "none") {
    return Math.round(capped);
  }

  const sample = clampUnitInterval(rand());

  if (jitter === "equal") {
    const half = capped / 2;
    return Math.round(half + sample * half);
  }

  return Math.round(sample * capped);
}

/**
 * Parses an RFC 9110 Retry-After header value (delta-seconds or HTTP-date)
 * into a non-negative delay in milliseconds, or returns null when invalid.
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!headerValue) {
    return null;
  }

  const trimmed = headerValue.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1_000;
    }
    return null;
  }

  const parsedDateMs = Date.parse(trimmed);
  if (Number.isNaN(parsedDateMs)) {
    return null;
  }

  return Math.max(0, parsedDateMs - nowMs);
}

/**
 * Resolves the wait duration for the next retry, honoring Retry-After bounded by maxDelayMs.
 */
export function resolveRetryDelayMs(
  attempt: number,
  response: Response | undefined,
  options: BackoffOptions & { respectRetryAfter?: boolean; nowMs?: number } = {},
): number {
  const maxDelayMs = Math.max(
    options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
  );

  if (options.respectRetryAfter !== false && response) {
    const retryAfterHeader = response.headers.get("retry-after");
    const parsedMs = parseRetryAfterMs(retryAfterHeader, options.nowMs);
    if (parsedMs !== null) {
      return Math.min(maxDelayMs, parsedMs);
    }
  }

  return computeBackoffDelayMs(attempt, options);
}

function clampUnitInterval(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 0.999999999999;
  }
  return value;
}
