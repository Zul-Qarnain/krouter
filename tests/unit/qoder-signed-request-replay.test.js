/**
 * A Qoder chat POST is COSY-signed and carries a one-shot requestId. When the
 * proxy attempt lost the response, proxyAwareFetch fell back to a direct call
 * with the same signature and Qoder answered 403 code 103 "Duplicate request".
 * The executor now marks its own fetch strict so the transport error reaches
 * the account loop, which retries through execute() with a fresh signature
 * (upstream 782c137b).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: vi.fn() };
});
vi.mock("../../open-sse/services/qoderModels.js", () => ({
  getQoderModelConfig: vi.fn(async (_credentials, key) => ({ key, max_output_tokens: 1024 })),
  resolveQoderModels: vi.fn(),
  invalidateQoderCatalog: vi.fn(),
  clearQoderCatalog: vi.fn(),
}));

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
const { QoderExecutor } = await import("../../open-sse/executors/qoder.js");

const ok = () => new Response('data: {"statusCodeValue":200,"body":"[DONE]"}\n\n', {
  status: 200,
  headers: { "Content-Type": "text/event-stream" },
});

const request = () => ({
  model: "qoder/auto",
  body: { messages: [{ role: "user", content: "hello" }], max_tokens: 32 },
  stream: true,
  credentials: {
    accessToken: "dt-test-token",
    providerSpecificData: { userId: "test-user", machineId: "test-machine" },
  },
});

let executor;
beforeEach(() => {
  executor = new QoderExecutor();
  proxyAwareFetch.mockReset();
  proxyAwareFetch.mockImplementation(async () => ok());
});

describe("Qoder signed inference transport", () => {
  it("marks its fetch strict so a failed proxy is never replayed directly", async () => {
    await executor.execute({ ...request(), proxyOptions: { connectionProxyUrl: "http://127.0.0.1:7890", enabled: true } });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch.mock.calls[0][2]).toMatchObject({
      connectionProxyUrl: "http://127.0.0.1:7890",
      enabled: true,
      strictProxy: true,
    });
  });

  it("marks its fetch strict when the caller passed no proxy options", async () => {
    await executor.execute(request());
    expect(proxyAwareFetch.mock.calls[0][2]).toMatchObject({ strictProxy: true });
  });

  it("does not mutate the caller's proxyOptions", async () => {
    const proxyOptions = { proxyPoolId: "pool-1", strictProxy: false };
    await executor.execute({ ...request(), proxyOptions });
    expect(proxyOptions).toEqual({ proxyPoolId: "pool-1", strictProxy: false });
    expect(proxyAwareFetch.mock.calls[0][2]).not.toBe(proxyOptions);
  });

  it("surfaces a caller abort as the caller's reason, not the strict-proxy error", async () => {
    const controller = new AbortController();
    const reason = new DOMException("client went away", "AbortError");
    proxyAwareFetch.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw new Error("[ProxyFetch] Proxy required but failed (strictProxy=true): socket hang up");
    });
    await expect(executor.execute({ ...request(), signal: controller.signal })).rejects.toBe(reason);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("propagates a transport failure instead of retrying inside execute()", async () => {
    proxyAwareFetch.mockImplementationOnce(async () => { throw new TypeError("response lost after upstream accepted request"); });
    await expect(executor.execute(request())).rejects.toThrow("response lost");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("signs every attempt with a fresh requestId", async () => {
    await executor.execute(request());
    await executor.execute(request());
    const requestIds = proxyAwareFetch.mock.calls.map(([, options]) => JSON.parse(
      Buffer.from(options.headers.Authorization.split(".")[1], "base64").toString(),
    ).requestId);
    expect(requestIds[0]).not.toBe(requestIds[1]);
  });
});
