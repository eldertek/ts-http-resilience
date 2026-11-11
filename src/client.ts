import { resolveRetryDelayMs } from "./backoff.js";
import { ensureIdempotencyHeader } from "./idempotency.js";
import {
  HttpStatusError,
  RequestTimeoutError,
  type ResilientClientOptions,
  type ResilientRequestInit,
  type RetryDecisionContext,
} from "./types.js";

export const DEFAULT_RETRY_STATUS_CODES: readonly number[] = [
  408, 425, 429, 500, 502, 503, 504,
];

export const DEFAULT_SAFE_RETRY_METHODS: readonly string[] = [
  "GET",
  "HEAD",
  "OPTIONS",
  "PUT",
  "DELETE",
];

/**
 * Executes an HTTP request with configurable retries, exponential backoff, jitter,
 * Retry-After parsing, per-attempt timeouts, and stable Idempotency-Key headers.
 */
export async function resilientFetch(
  input: string | URL | Request,
  init: ResilientRequestInit = {},
): Promise<Response> {
  const fetchFn = init.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new TypeError("No fetch implementation available in globalThis or fetchImpl");
  }

  const maxRetries = Math.max(0, Math.floor(init.maxRetries ?? 3));
  const retryStatusCodes = new Set(init.retryStatusCodes ?? DEFAULT_RETRY_STATUS_CODES);
  const method = resolveMethod(input, init);
  const headers = mergeRequestHeaders(input, init.headers);

  ensureIdempotencyHeader(headers, method, {
    enabled: init.autoIdempotencyKey,
    headerName: init.idempotencyHeaderName,
    generateKey: init.generateIdempotencyKey,
  });

  const allowedMethods = buildAllowedMethodsSet(
    init.retryMethods,
    Boolean(init.autoIdempotencyKey) || headers.has(init.idempotencyHeaderName ?? "Idempotency-Key"),
  );

  const sleepFn = init.sleep ?? abortableSleep;
  const callerSignal = init.signal ?? (input instanceof Request ? input.signal : undefined);

  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(callerSignal);

    const attemptScope = createAttemptSignal(callerSignal, init.timeoutMs);

    try {
      const requestInit = stripPolicyFields(init, headers, attemptScope.signal);
      const target = input instanceof Request ? input.clone() : input;
      const response = await fetchFn(target, requestInit);
      attemptScope.cleanup();

      if (attempt >= maxRetries) {
        return response;
      }

      const canRetryResponse = await evaluateShouldRetry(
        {
          attempt: attempt + 1,
          maxRetries,
          method,
          response,
        },
        init.shouldRetry,
        allowedMethods,
        retryStatusCodes,
      );

      if (!canRetryResponse) {
        return response;
      }

      await cancelUnreadBody(response);

      const delayMs = resolveRetryDelayMs(attempt + 1, response, {
        baseDelayMs: init.baseDelayMs,
        maxDelayMs: init.maxDelayMs,
        factor: init.factor,
        jitter: init.jitter,
        random: init.random,
        respectRetryAfter: init.respectRetryAfter,
      });

      if (init.onRetry) {
        await init.onRetry({
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          method,
          status: response.status,
        });
      }

      await sleepFn(delayMs, callerSignal ?? undefined);
    } catch (rawError) {
      const timedOut = attemptScope.didTimeout();
      attemptScope.cleanup();

      if (callerSignal?.aborted) {
        throw callerSignal.reason ?? rawError;
      }

      const normalizedError =
        timedOut && init.timeoutMs !== undefined
          ? new RequestTimeoutError(init.timeoutMs)
          : rawError;

      if (attempt >= maxRetries) {
        throw normalizedError;
      }

      const canRetryError = await evaluateShouldRetry(
        {
          attempt: attempt + 1,
          maxRetries,
          method,
          error: normalizedError,
        },
        init.shouldRetry,
        allowedMethods,
        retryStatusCodes,
      );

      if (!canRetryError) {
        throw normalizedError;
      }

      const delayMs = resolveRetryDelayMs(attempt + 1, undefined, {
        baseDelayMs: init.baseDelayMs,
        maxDelayMs: init.maxDelayMs,
        factor: init.factor,
        jitter: init.jitter,
        random: init.random,
        respectRetryAfter: false,
      });

      if (init.onRetry) {
        await init.onRetry({
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          method,
          error: normalizedError,
        });
      }

      await sleepFn(delayMs, callerSignal ?? undefined);
    }
  }
}

export interface ResilientClient {
  fetch: (input: string | URL | Request, init?: ResilientRequestInit) => Promise<Response>;
  fetchJson: <T>(input: string | URL | Request, init?: ResilientRequestInit) => Promise<T>;
}

/**
 * Creates a reusable resilient HTTP client with shared base URL, default headers, and retry policy.
 */
export function createResilientClient(defaults: ResilientClientOptions = {}): ResilientClient {
  const clientFetch = async (
    input: string | URL | Request,
    init: ResilientRequestInit = {},
  ): Promise<Response> => {
    const resolvedInput = resolveInputUrl(input, defaults.baseUrl);
    const mergedHeaders = new Headers(defaults.defaultHeaders);

    if (resolvedInput instanceof Request) {
      resolvedInput.headers.forEach((value, key) => {
        mergedHeaders.set(key, value);
      });
    }
    if (init.headers) {
      new Headers(init.headers).forEach((value, key) => {
        mergedHeaders.set(key, value);
      });
    }

    return resilientFetch(resolvedInput, {
      ...defaults,
      ...init,
      headers: mergedHeaders,
    });
  };

  const fetchJson = async <T>(
    input: string | URL | Request,
    init: ResilientRequestInit = {},
  ): Promise<T> => {
    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }

    const response = await clientFetch(input, { ...init, headers });
    if (!response.ok) {
      const bodyText = await safeReadText(response);
      throw new HttpStatusError(response, bodyText);
    }

    return (await response.json()) as T;
  };

  return {
    fetch: clientFetch,
    fetchJson,
  };
}

function resolveMethod(input: string | URL | Request, init: RequestInit): string {
  if (init.method) {
    return init.method.toUpperCase();
  }
  if (input instanceof Request && input.method) {
    return input.method.toUpperCase();
  }
  return "GET";
}

function mergeRequestHeaders(
  input: string | URL | Request,
  overrideHeaders?: HeadersInit,
): Headers {
  const merged = new Headers(input instanceof Request ? input.headers : undefined);
  if (overrideHeaders) {
    new Headers(overrideHeaders).forEach((value, key) => {
      merged.set(key, value);
    });
  }
  return merged;
}

function buildAllowedMethodsSet(
  explicitMethods: readonly string[] | undefined,
  hasIdempotencyProtection: boolean,
): Set<string> {
  if (explicitMethods) {
    return new Set(explicitMethods.map((m) => m.toUpperCase()));
  }
  const set = new Set(DEFAULT_SAFE_RETRY_METHODS);
  if (hasIdempotencyProtection) {
    set.add("POST");
    set.add("PATCH");
  }
  return set;
}

async function evaluateShouldRetry(
  context: RetryDecisionContext,
  customPredicate: ResilientRequestInit["shouldRetry"],
  allowedMethods: Set<string>,
  retryStatusCodes: Set<number>,
): Promise<boolean> {
  if (customPredicate) {
    return customPredicate(context);
  }
  if (!allowedMethods.has(context.method)) {
    return false;
  }
  if (context.response) {
    return retryStatusCodes.has(context.response.status);
  }
  return isRetryableError(context.error);
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof RequestTimeoutError) {
    return true;
  }
  if (error instanceof TypeError) {
    return true;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return false;
  }
  return false;
}

function createAttemptSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number | undefined,
): {
  signal: AbortSignal | undefined;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  if (!callerSignal && (timeoutMs === undefined || timeoutMs <= 0)) {
    return {
      signal: undefined,
      didTimeout: () => false,
      cleanup: () => {},
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onCallerAbort = (): void => {
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  if (timeoutMs !== undefined && timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new RequestTimeoutError(timeoutMs));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (callerSignal) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}

function stripPolicyFields(
  init: ResilientRequestInit,
  headers: Headers,
  signal: AbortSignal | undefined,
): RequestInit {
  const {
    maxRetries: _maxRetries,
    retryStatusCodes: _retryStatusCodes,
    retryMethods: _retryMethods,
    timeoutMs: _timeoutMs,
    respectRetryAfter: _respectRetryAfter,
    autoIdempotencyKey: _autoIdempotencyKey,
    idempotencyHeaderName: _idempotencyHeaderName,
    generateIdempotencyKey: _generateIdempotencyKey,
    shouldRetry: _shouldRetry,
    onRetry: _onRetry,
    sleep: _sleep,
    fetchImpl: _fetchImpl,
    baseDelayMs: _baseDelayMs,
    maxDelayMs: _maxDelayMs,
    factor: _factor,
    jitter: _jitter,
    random: _random,
    ...standardInit
  } = init;

  return {
    ...standardInit,
    headers,
    signal,
  };
}

function resolveInputUrl(
  input: string | URL | Request,
  baseUrl?: string | URL,
): string | URL | Request {
  if (!baseUrl || input instanceof Request || input instanceof URL) {
    return input;
  }
  if (/^https?:\/\//i.test(input)) {
    return input;
  }
  const normalizedBase = String(baseUrl).replace(/\/+$/, "") + "/";
  const normalizedPath = input.replace(/^\/+/, "");
  return new URL(normalizedPath, normalizedBase);
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    throwIfAborted(signal);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };

    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }
}

async function cancelUnreadBody(response: Response): Promise<void> {
  try {
    if (response.body && !response.bodyUsed) {
      await response.body.cancel();
    }
  } catch {
    // Ignore stream cancellation errors when cleaning up discarded retry responses.
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
