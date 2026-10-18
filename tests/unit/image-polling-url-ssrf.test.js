import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The async image adapters submit a job, then poll a status URL until it is done.
 * Every one of those polls was a bare fetch(url, { headers }) -- and `headers`
 * carries the provider's own credential (fal "Authorization: Key ...", BFL
 * "x-key", runway bearer). So this is not only a blind internal read like the
 * source-image hole: the credential travels with the request.
 *
 * Two different exposures, deliberately tested differently:
 *
 *   - fal-ai and black-forest-labs take the whole absolute URL out of the submit
 *     response (status_url / response_url / polling_url). A hostile or
 *     compromised provider response names any host it likes and the key goes
 *     there. These need the URL itself validated.
 *   - runwayml and nanobanana build the poll URL from a fixed BASE_URL, so the
 *     host cannot be moved by the response. What was still open on those two is
 *     the redirect: fetch defaults to redirect:"follow", so one 30x from the
 *     real provider host walked the credential anywhere with nothing
 *     re-validating the hop. runwayml also interpolated the task id into the
 *     path unescaped.
 *
 * DNS is mocked so loopback / metadata / private-range / rebinding targets are
 * deterministic offline.
 */

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));

const falAi = (await import("../../open-sse/handlers/imageProviders/falAi.js")).default;
const blackForestLabs = (await import("../../open-sse/handlers/imageProviders/blackForestLabs.js")).default;
const runwayml = (await import("../../open-sse/handlers/imageProviders/runwayml.js")).default;
const nanobanana = (await import("../../open-sse/handlers/imageProviders/nanobanana.js")).default;

const INTERNAL = "http://169.254.169.254/latest/meta-data/iam/security-credentials/";
const LOOPBACK = "http://127.0.0.1:9999/admin";
const originalFetch = global.fetch;

const json = (obj, init = {}) =>
  new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

/** Advance past the poll sleep, then settle the assertion the caller attached. */
async function tick(assertion, ms = 2000) {
  await vi.advanceTimersByTimeAsync(ms);
  return assertion;
}

/** Every URL global.fetch was asked for. */
const fetchedUrls = () => global.fetch.mock.calls.map((c) => String(c[0]));

/** Any header value that looks like the provider credential, per request. */
function credentialSentTo(host) {
  return global.fetch.mock.calls.some(([url, init]) => {
    if (!String(url).includes(host)) return false;
    const h = init?.headers || {};
    return Object.values(h).some((v) => String(v).includes("super-secret-key"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
});
afterEach(() => {
  vi.useRealTimers();
  global.fetch = originalFetch;
});

describe("fal-ai -- status_url and response_url come out of the provider response", () => {
  const headers = { "Content-Type": "application/json", Authorization: "Key super-secret-key" };

  it("refuses a status_url pointing at the metadata endpoint, and never sends the key there", async () => {
    global.fetch = vi.fn();
    const submit = json({ status_url: INTERNAL, response_url: "https://queue.fal.run/r" });

    await tick(expect(falAi.parseResponse(submit, { headers })).rejects.toThrow(/blocked/i));

    expect(fetchedUrls().some((u) => u.includes("169.254.169.254"))).toBe(false);
    expect(credentialSentTo("169.254.169.254")).toBe(false);
  });

  it("refuses a loopback status_url", async () => {
    global.fetch = vi.fn();
    const submit = json({ status_url: LOOPBACK, response_url: "https://queue.fal.run/r" });

    await tick(expect(falAi.parseResponse(submit, { headers })).rejects.toThrow(/blocked/i));
    expect(credentialSentTo("127.0.0.1")).toBe(false);
  });

  it("refuses an internal response_url even when status_url was public", async () => {
    global.fetch = vi.fn(async () => json({ status: "COMPLETED" }));
    const submit = json({ status_url: "https://queue.fal.run/s", response_url: INTERNAL });

    await tick(expect(falAi.parseResponse(submit, { headers })).rejects.toThrow(/blocked/i));

    expect(fetchedUrls()).toEqual(["https://queue.fal.run/s"]);
    expect(credentialSentTo("169.254.169.254")).toBe(false);
  });

  it("refuses a status_url hostname that only resolves to loopback", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    global.fetch = vi.fn();
    const submit = json({ status_url: "https://queue.fal.run.attacker.test/s", response_url: "https://x.test/r" });

    await tick(expect(falAi.parseResponse(submit, { headers })).rejects.toThrow(/blocked/i));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses a redirect from a public status_url into an internal target", async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { Location: INTERNAL } }));
    const submit = json({ status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" });

    await tick(expect(falAi.parseResponse(submit, { headers })).rejects.toThrow(/blocked/i));

    expect(fetchedUrls()).toEqual(["https://queue.fal.run/s"]); // hop inspected, not followed
    expect(credentialSentTo("169.254.169.254")).toBe(false);
  });

  it("still polls a public queue through to the result", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(json({ status: "IN_QUEUE" }))
      .mockResolvedValueOnce(json({ status: "COMPLETED" }))
      .mockResolvedValueOnce(json({ images: [{ url: "https://cdn.fal.test/out.png" }] }));

    const p = falAi.parseResponse(
      json({ status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" }),
      { headers }
    );
    await vi.advanceTimersByTimeAsync(5000);

    expect(await p).toEqual({ images: [{ url: "https://cdn.fal.test/out.png" }] });
    expect(fetchedUrls()).toEqual([
      "https://queue.fal.run/s",
      "https://queue.fal.run/s",
      "https://queue.fal.run/r",
    ]);
  });

  it("still reports a non-OK poll with its own message", async () => {
    global.fetch = vi.fn(async () => json({}, { status: 500 }));
    const submit = json({ status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" });

    await tick(expect(falAi.parseResponse(submit, { headers })).rejects.toThrow(/Fal status 500/));
  });
});

describe("black-forest-labs -- polling_url comes out of the provider response", () => {
  const headers = { "Content-Type": "application/json", "x-key": "super-secret-key" };

  it("refuses an internal polling_url, and never sends x-key there", async () => {
    global.fetch = vi.fn();

    await tick(
      expect(blackForestLabs.parseResponse(json({ polling_url: INTERNAL }), { headers })).rejects.toThrow(/blocked/i)
    );

    expect(fetchedUrls().some((u) => u.includes("169.254.169.254"))).toBe(false);
    expect(credentialSentTo("169.254.169.254")).toBe(false);
  });

  it("refuses a private-range polling_url", async () => {
    global.fetch = vi.fn();
    await tick(
      expect(blackForestLabs.parseResponse(json({ polling_url: "http://10.1.2.3/poll" }), { headers })).rejects.toThrow(
        /blocked/i
      )
    );
    expect(credentialSentTo("10.1.2.3")).toBe(false);
  });

  it("refuses a redirect from a public polling_url into an internal target", async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { Location: LOOPBACK } }));

    await tick(
      expect(
        blackForestLabs.parseResponse(json({ polling_url: "https://api.bfl.ai/v1/get_result?id=1" }), { headers })
      ).rejects.toThrow(/blocked/i)
    );

    expect(fetchedUrls()).toEqual(["https://api.bfl.ai/v1/get_result?id=1"]);
    expect(credentialSentTo("127.0.0.1")).toBe(false);
  });

  it("still polls a public polling_url through to Ready", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(json({ status: "Pending" }))
      .mockResolvedValueOnce(json({ status: "Ready", result: { sample: "https://cdn.bfl.test/o.png" } }));

    const p = blackForestLabs.parseResponse(json({ polling_url: "https://api.bfl.ai/v1/get_result?id=1" }), { headers });
    await vi.advanceTimersByTimeAsync(5000);

    expect((await p).status).toBe("Ready");
    // Credential still reaches the real provider.
    expect(credentialSentTo("api.bfl.ai")).toBe(true);
  });
});

describe("runwayml -- fixed host, but the hop and the task id needed handling", () => {
  const headers = { Authorization: "Bearer super-secret-key", "X-Runway-Version": "2024-11-06" };

  it("refuses a redirect from the task URL into an internal target", async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { Location: INTERNAL } }));

    await tick(expect(runwayml.parseResponse(json({ id: "task-1" }), { headers })).rejects.toThrow(/blocked/i));

    expect(fetchedUrls().some((u) => u.includes("169.254.169.254"))).toBe(false);
    expect(credentialSentTo("169.254.169.254")).toBe(false);
  });

  it("escapes the task id instead of letting it shape the path", async () => {
    global.fetch = vi.fn(async () => json({ status: "SUCCEEDED", output: [] }));

    const p = runwayml.parseResponse(json({ id: "../../evil" }), { headers });
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    const [url] = fetchedUrls();
    // The id stays one path segment under /tasks/ -- no traversal, no host change.
    expect(url).toBe("https://api.dev.runwayml.com/v1/tasks/..%2F..%2Fevil");
    expect(new URL(url).host).toBe("api.dev.runwayml.com");
  });

  it("still polls through to SUCCEEDED", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(json({ status: "RUNNING" }))
      .mockResolvedValueOnce(json({ status: "SUCCEEDED", output: ["https://cdn.runway.test/o.mp4"] }));

    const p = runwayml.parseResponse(json({ id: "task-1" }), { headers });
    await vi.advanceTimersByTimeAsync(5000);

    expect((await p).status).toBe("SUCCEEDED");
    expect(fetchedUrls()).toEqual([
      "https://api.dev.runwayml.com/v1/tasks/task-1",
      "https://api.dev.runwayml.com/v1/tasks/task-1",
    ]);
  });
});

describe("nanobanana -- fixed host, redirect hop closed", () => {
  const headers = { "Content-Type": "application/json", Authorization: "Bearer super-secret-key" };

  it("refuses a redirect from the record-info poll into an internal target", async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { Location: LOOPBACK } }));

    await tick(
      expect(
        nanobanana.parseResponse(json({ code: 200, data: { taskId: "task-123" } }), { headers })
      ).rejects.toThrow(/blocked/i)
    );

    expect(credentialSentTo("127.0.0.1")).toBe(false);
  });

  it("still polls record-info through to success", async () => {
    global.fetch = vi.fn(async () =>
      json({ data: { successFlag: 1, response: { resultImageUrl: "https://cdn.nb.test/o.png" } } })
    );

    const p = nanobanana.parseResponse(json({ code: 200, data: { taskId: "task-123" } }), { headers });
    await vi.advanceTimersByTimeAsync(2000);

    expect((await p).successFlag).toBe(1);
    expect(fetchedUrls()).toEqual([
      "https://api.nanobananaapi.ai/api/v1/nanobanana/record-info?taskId=task-123",
    ]);
  });
});
