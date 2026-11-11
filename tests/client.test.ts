import { describe, expect, it } from "vitest";
import {
  createResilientClient,
  HttpStatusError,
  RequestTimeoutError,
  resilientFetch,
} from "../src/index.js";

const instantSleep = async (): Promise<void> => {};

describe("resilientFetch", () => {
  it("retries transient 503 responses and returns the eventual 200 response", async () => {
    let calls = 0;
    const notices: number[] = [];

    const response = await resilientFetch("https://api.example.test/items", {
      maxRetries: 3,
      sleep: instantSleep,
      onRetry: (info) => {
        notices.push(info.attempt);
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) {
          return new Response("Service Unavailable", { status: 503 });
        }
        return Response.json({ ok: true });
      },
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    expect(notices).toEqual([1, 2]);
  });

  it("does not retry non-retryable 400 client errors", async () => {
    let calls = 0;

    const response = await resilientFetch("https://api.example.test/items", {
      maxRetries: 3,
      sleep: instantSleep,
      fetchImpl: async () => {
        calls += 1;
        return new Response("Bad Request", { status: 400 });
      },
    });

    expect(response.status).toBe(400);
    expect(calls).toBe(1);
  });

  it("does not retry POST without idempotency protection by default", async () => {
    let calls = 0;

    const response = await resilientFetch("https://api.example.test/orders", {
      method: "POST",
      maxRetries: 2,
      sleep: instantSleep,
      fetchImpl: async () => {
        calls += 1;
        return new Response("Bad Gateway", { status: 502 });
      },
    });

    expect(response.status).toBe(502);
    expect(calls).toBe(1);
  });

  it("injects and preserves the same Idempotency-Key across retried POST attempts", async () => {
    const observedKeys: string[] = [];

    const response = await resilientFetch("https://api.example.test/orders", {
      method: "POST",
      autoIdempotencyKey: true,
      maxRetries: 2,
      sleep: instantSleep,
      fetchImpl: async (_input, init) => {
        const headers = new Headers(init?.headers);
        observedKeys.push(headers.get("Idempotency-Key") ?? "");
        if (observedKeys.length === 1) {
          return new Response("Gateway Timeout", { status: 504 });
        }
        return new Response("Created", { status: 201 });
      },
    });

    expect(response.status).toBe(201);
    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]?.length).toBeGreaterThan(10);
    expect(observedKeys[0]).toBe(observedKeys[1]);
  });

  it("aborts slow attempts via timeoutMs and retries before throwing RequestTimeoutError", async () => {
    let calls = 0;

    await expect(
      resilientFetch("https://api.example.test/slow", {
        timeoutMs: 20,
        maxRetries: 1,
        sleep: instantSleep,
        fetchImpl: async (_input, init) => {
          calls += 1;
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason ?? new Error("Aborted")),
              { once: true },
            );
          });
        },
      }),
    ).rejects.toBeInstanceOf(RequestTimeoutError);

    expect(calls).toBe(2);
  });

  it("stops immediately without retrying when the caller AbortSignal is aborted", async () => {
    const controller = new AbortController();
    let calls = 0;

    await expect(
      resilientFetch("https://api.example.test/cancel", {
        signal: controller.signal,
        maxRetries: 3,
        sleep: instantSleep,
        fetchImpl: async (_input, init) => {
          calls += 1;
          controller.abort(new Error("Caller cancelled"));
          throw init?.signal?.reason ?? new Error("Caller cancelled");
        },
      }),
    ).rejects.toThrow("Caller cancelled");

    expect(calls).toBe(1);
  });
});

describe("createResilientClient", () => {
  it("resolves baseUrl, merges headers, and parses typed JSON payloads", async () => {
    let seenUrl = "";
    let seenAuth = "";

    const client = createResilientClient({
      baseUrl: "https://api.example.test/v1/",
      defaultHeaders: { Authorization: "Bearer test-token" },
      sleep: instantSleep,
      fetchImpl: async (input, init) => {
        seenUrl = String(input);
        seenAuth = new Headers(init?.headers).get("Authorization") ?? "";
        return Response.json({ id: "acct_42", active: true });
      },
    });

    const account = await client.fetchJson<{ id: string; active: boolean }>("/accounts/acct_42");
    expect(account).toEqual({ id: "acct_42", active: true });
    expect(seenUrl).toBe("https://api.example.test/v1/accounts/acct_42");
    expect(seenAuth).toBe("Bearer test-token");
  });

  it("throws HttpStatusError with response body on terminal non-2xx responses", async () => {
    const client = createResilientClient({
      baseUrl: "https://api.example.test",
      maxRetries: 0,
      fetchImpl: async () => new Response('{"error":"quota_exceeded"}', { status: 429 }),
    });

    await expect(client.fetchJson("/usage")).rejects.toMatchObject({
      name: "HttpStatusError",
      status: 429,
      bodyText: '{"error":"quota_exceeded"}',
    });

    await expect(client.fetchJson("/usage")).rejects.toBeInstanceOf(HttpStatusError);
  });
});
