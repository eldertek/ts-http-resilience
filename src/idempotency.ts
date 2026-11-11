const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

export function defaultGenerateIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 12);
  return `idem_${timestamp}_${randomPart}`;
}

/**
 * Ensures a stable idempotency header is attached to mutating requests when enabled,
 * without overwriting an explicit caller-supplied header.
 */
export function ensureIdempotencyHeader(
  headers: Headers,
  method: string,
  options: {
    enabled?: boolean;
    headerName?: string;
    generateKey?: () => string;
  },
): Headers {
  if (!options.enabled || !isMutatingMethod(method)) {
    return headers;
  }

  const headerName = options.headerName ?? "Idempotency-Key";
  if (!headers.has(headerName)) {
    const generator = options.generateKey ?? defaultGenerateIdempotencyKey;
    headers.set(headerName, generator());
  }

  return headers;
}
