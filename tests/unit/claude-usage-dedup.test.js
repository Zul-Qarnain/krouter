import { describe, it, expect, vi, beforeEach } from "vitest";

// proxyAwareFetch is mocked because this file is about promise identity, not about
// what Anthropic answers. Unmocked, getClaudeUsage reaches the real API: that
// resolves quickly on a developer machine and hung past the 5s test timeout on CI,
// which is a property of the runner's network rather than of the dedup contract.
vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  proxyAwareFetch: vi.fn(),
}));

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
const { getClaudeUsage } = await import("../../open-sse/services/usage.js");

beforeEach(() => {
  proxyAwareFetch.mockReset();
  proxyAwareFetch.mockResolvedValue(
    new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
  );
});

// upstream cd4003bc — several dashboard widgets ask for Claude quota at once;
// without dedup each fired its own upstream request and tripped Anthropic's 429.
// Promise identity is the observable contract: concurrent callers must receive the
// SAME promise, which is only true if the shared one is returned directly (an
// `async` wrapper would hand each caller a distinct wrapper and silently un-dedup).
describe("0.5.143 Claude quota in-flight dedup", () => {
  it("concurrent callers for the same token share one promise", async () => {
    const a = getClaudeUsage("tok-same");
    const b = getClaudeUsage("tok-same");
    const c = getClaudeUsage("tok-same");
    expect(a).toBe(b);
    expect(b).toBe(c);
    await Promise.allSettled([a, b, c]);
  });

  it("different tokens are not shared", async () => {
    const a = getClaudeUsage("tok-A");
    const b = getClaudeUsage("tok-B");
    expect(a).not.toBe(b);
    await Promise.allSettled([a, b]);
  });

  it("the entry is released after settle, so a later call refetches", async () => {
    const first = getClaudeUsage("tok-seq");
    await Promise.allSettled([first]);
    const second = getClaudeUsage("tok-seq");
    expect(second).not.toBe(first);
    await Promise.allSettled([second]);
  });

  it("always returns a promise (callers still await normally)", async () => {
    const p = getClaudeUsage("tok-shape");
    expect(typeof p.then).toBe("function");
    await Promise.allSettled([p]);
  });
});
