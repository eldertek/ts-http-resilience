import { describe, expect, it } from "vitest";
import {
  computeBackoffDelayMs,
  parseRetryAfterMs,
  resolveRetryDelayMs,
} from "../src/backoff.js";

describe("computeBackoffDelayMs", () => {
  it("computes deterministic exponential backoff when jitter is none", () => {
    expect(computeBackoffDelayMs(1, { baseDelayMs: 200, jitter: "none" })).toBe(200);
    expect(computeBackoffDelayMs(2, { baseDelayMs: 200, jitter: "none" })).toBe(400);
    expect(computeBackoffDelayMs(3, { baseDelayMs: 200, jitter: "none" })).toBe(800);
  });

  it("caps computed delay at maxDelayMs", () => {
    const delay = computeBackoffDelayMs(6, {
      baseDelayMs: 500,
      maxDelayMs: 2_500,
      jitter: "none",
    });
    expect(delay).toBe(2_500);
  });

  it("applies full jitter using the injected random source", () => {
    expect(
      computeBackoffDelayMs(2, {
        baseDelayMs: 200,
        jitter: "full",
        random: () => 0.5,
      }),
    ).toBe(200);
    expect(
      computeBackoffDelayMs(2, {
        baseDelayMs: 200,
        jitter: "full",
        random: () => 0,
      }),
    ).toBe(0);
  });

  it("applies equal jitter between half and full exponential delay", () => {
    expect(
      computeBackoffDelayMs(2, {
        baseDelayMs: 400,
        jitter: "equal",
        random: () => 0,
      }),
    ).toBe(400);
    expect(
      computeBackoffDelayMs(2, {
        baseDelayMs: 400,
        jitter: "equal",
        random: () => 0.5,
      }),
    ).toBe(600);
  });
});

describe("parseRetryAfterMs and resolveRetryDelayMs", () => {
  it("parses integer delta-seconds into milliseconds", () => {
    expect(parseRetryAfterMs("3")).toBe(3_000);
    expect(parseRetryAfterMs(" 0 ")).toBe(0);
  });

  it("parses RFC 9110 HTTP-date relative to nowMs", () => {
    const now = Date.parse("2026-11-11T14:00:00Z");
    const target = "Wed, 11 Nov 2026 14:00:07 GMT";
    expect(parseRetryAfterMs(target, now)).toBe(7_000);
  });

  it("returns null on malformed Retry-After headers", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("not-a-valid-header")).toBeNull();
  });

  it("bounds Retry-After headers by maxDelayMs", () => {
    const response = new Response(null, {
      status: 429,
      headers: { "Retry-After": "60" },
    });
    const delay = resolveRetryDelayMs(1, response, {
      baseDelayMs: 250,
      maxDelayMs: 5_000,
    });
    expect(delay).toBe(5_000);
  });
});
