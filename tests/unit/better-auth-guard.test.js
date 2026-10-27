import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  getBetterAuthSession: vi.fn(),
  isBetterAuthConfigured: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url: String(url) })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
  getDb: vi.fn(),
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

vi.mock("@/auth", () => ({
  auth: {
    api: {
      getSession: mocks.getBetterAuthSession,
    },
  },
  getBetterAuth: () => ({
    api: {
      getSession: mocks.getBetterAuthSession,
    },
  }),
  isBetterAuthConfigured: mocks.isBetterAuthConfigured,
}));

const { proxy } = await import("../../src/dashboardGuard.js");

function createRequest(pathname, options = {}) {
  const headers = new Headers(options.headers || { host: "router.example.com" });
  return {
    nextUrl: { pathname },
    headers,
    cookies: {
      get: vi.fn((name) => {
        if (options.cookies && options.cookies[name]) {
          return { value: options.cookies[name] };
        }
        return undefined;
      }),
    },
    url: `http://localhost${pathname}`,
  };
}

describe("Better Auth Guard Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.isBetterAuthConfigured.mockReturnValue(true);
    mocks.getBetterAuthSession.mockResolvedValue(null);
  });

  it("allows admin user to access /dashboard", async () => {
    mocks.getBetterAuthSession.mockResolvedValue({
      user: { id: "u-admin", role: "admin", banned: false },
      session: { id: "s-1" },
    });

    const res = await proxy(createRequest("/dashboard"));
    expect(res).toBe(mocks.nextResponse);
  });

  it("redirects ordinary user away from /dashboard with admin_required error", async () => {
    mocks.getBetterAuthSession.mockResolvedValue({
      user: { id: "u-user", role: "user", banned: false },
      session: { id: "s-2" },
    });

    const res = await proxy(createRequest("/dashboard"));
    expect(res.status).toBe(307);
    expect(res.url).toContain("error=admin_required");
  });

  it("redirects banned user away from /dashboard with banned error", async () => {
    mocks.getBetterAuthSession.mockResolvedValue({
      user: { id: "u-banned", role: "admin", banned: true },
      session: { id: "s-3" },
    });

    const res = await proxy(createRequest("/dashboard"));
    expect(res.status).toBe(307);
    expect(res.url).toContain("error=banned");
  });

  it("allows admin user to access protected admin APIs (/api/keys)", async () => {
    mocks.getBetterAuthSession.mockResolvedValue({
      user: { id: "u-admin", role: "admin", banned: false },
      session: { id: "s-1" },
    });

    const res = await proxy(createRequest("/api/keys"));
    expect(res).toBe(mocks.nextResponse);
  });

  it("blocks ordinary user from protected admin APIs with 403 Forbidden", async () => {
    mocks.getBetterAuthSession.mockResolvedValue({
      user: { id: "u-user", role: "user", banned: false },
      session: { id: "s-2" },
    });

    const res = await proxy(createRequest("/api/keys"));
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("admin access required");
  });

  it("blocks banned user from protected admin APIs with 403 Forbidden", async () => {
    mocks.getBetterAuthSession.mockResolvedValue({
      user: { id: "u-banned", role: "admin", banned: true },
      session: { id: "s-3" },
    });

    const res = await proxy(createRequest("/api/keys"));
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Account is suspended");
  });

  it("allows legacy auth_token as rollback path even when Better Auth is configured", async () => {
    mocks.getBetterAuthSession.mockResolvedValue(null);
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const res = await proxy(createRequest("/dashboard", { cookies: { auth_token: "legacy-jwt" } }));
    expect(res).toBe(mocks.nextResponse);
  });

  it("prevents requireLogin=false from bypassing Better Auth when Better Auth is configured", async () => {
    mocks.isBetterAuthConfigured.mockReturnValue(true);
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.getBetterAuthSession.mockResolvedValue(null);
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);

    const res = await proxy(createRequest("/dashboard"));
    expect(res.status).toBe(307);
    expect(res.url).toContain("/login");
  });

  it("allows requireLogin=false when Better Auth is NOT configured (rollback state)", async () => {
    mocks.isBetterAuthConfigured.mockReturnValue(false);
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.getBetterAuthSession.mockResolvedValue(null);
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);

    const res = await proxy(createRequest("/dashboard"));
    expect(res).toBe(mocks.nextResponse);
  });

  it("keeps public LLM endpoints (/v1/chat/completions) requiring API key for remote callers", async () => {
    mocks.getBetterAuthSession.mockResolvedValue({
      user: { id: "u-user", role: "user", banned: false },
    });
    mocks.validateApiKey.mockResolvedValue(false);

    const res = await proxy(createRequest("/v1/chat/completions", { headers: { host: "router.example.com" } }));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("API key required for remote API access");
  });
});
