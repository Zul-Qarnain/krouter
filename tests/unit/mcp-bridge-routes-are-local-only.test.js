/**
 * The MCP stdio-SSE bridge must stay behind the local-only gate.
 *
 * Why it matters: GET /api/mcp/<plugin>/sse calls registerSession(), which calls
 * getOrSpawn() - the request SPAWNS the plugin - and POST /api/mcp/<plugin>/message
 * writes the caller's JSON straight to that child's stdin. The one preset plugin is
 * browsermcp (`npx -y @browsermcp/mcp@latest`), which drives the operator's own
 * logged-in Chrome. kRouter binds 0.0.0.0, so if these routes ever fell back to the
 * ordinary /api gate (satisfied by a session alone) the blast radius would be every
 * authenticated browser session the operator has.
 *
 * The protection lives in ONE place: LOCAL_ONLY_PATHS in src/dashboardGuard.js, applied
 * by src/proxy.js (this fork is on Next 16, where proxy.js replaces middleware.js - a
 * search for "middleware" finds nothing and can lead a reader to think the routes are
 * unguarded). The route files deliberately carry no second check: canAccessLocalOnlyRoute
 * also accepts a valid CLI token, so an in-route isLocalRequest() would be a REGRESSION,
 * locking out legitimate CLI-token callers.
 *
 * These tests pin that arrangement so it cannot be removed by accident.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p) => readFileSync(join(process.cwd(), p), "utf8");
const guard = read("src/dashboardGuard.js");

describe("the bridge can spawn and be written to, which is why it is gated", () => {
  it("registerSession spawns the child", () => {
    expect(read("src/lib/mcp/stdioSseBridge.js")).toMatch(/function registerSession[\s\S]{0,200}getOrSpawn\(/);
  });

  it("sendToChild writes caller JSON to the child's stdin", () => {
    expect(read("src/lib/mcp/stdioSseBridge.js")).toMatch(/function sendToChild[\s\S]{0,300}stdin\.write/);
  });

  it("the only preset plugin drives the operator's browser", () => {
    const plugins = read("src/shared/constants/coworkPlugins.js");
    expect(plugins).toMatch(/browsermcp/);
    expect(plugins).toMatch(/@browsermcp\/mcp/);
  });
});

describe("/api/mcp/ is local-only at the guard", () => {
  it("is listed in LOCAL_ONLY_PATHS", () => {
    const list = guard.slice(guard.indexOf("const LOCAL_ONLY_PATHS"), guard.indexOf("];", guard.indexOf("const LOCAL_ONLY_PATHS")));
    expect(list).toMatch(/"\/api\/mcp\/"/);
  });

  it("the other spawn-capable routes stay listed beside it", () => {
    const list = guard.slice(guard.indexOf("const LOCAL_ONLY_PATHS"), guard.indexOf("];", guard.indexOf("const LOCAL_ONLY_PATHS")));
    for (const p of ['"/api/mitm/"', '"/api/pxpipe/"', '"/api/headroom/"']) expect(list).toContain(p);
  });

  it("that list is enforced before the ordinary /api gate, with a 403", () => {
    expect(guard).toMatch(/LOCAL_ONLY_PATHS\.some\(\(p\) => pathname\.startsWith\(p\)\)/);
    expect(guard).toMatch(/canAccessLocalOnlyRoute\(request\)/);
    expect(guard).toMatch(/Local only: CLI token required/);
  });

  it("passing it needs a CLI token, or being local AND authenticated", () => {
    const fn = guard.slice(guard.indexOf("async function canAccessLocalOnlyRoute"), guard.indexOf("async function hasValidToken"));
    expect(fn).toMatch(/hasValidCliToken\(request\)/);
    expect(fn).toMatch(/isLocalRequest\(request\) && await isAuthenticated\(request\)/);
    expect(fn).toMatch(/return false;/);
  });
});

describe("the guard is actually wired into the request path", () => {
  it("proxy.js delegates to it and matches every route", () => {
    const proxy = read("src/proxy.js");
    expect(proxy).toMatch(/dashboardProxy\(request\)/);
    expect(proxy).toMatch(/matcher/);
  });

  it("the route files keep no second, stricter check of their own", () => {
    // An in-route isLocalRequest() would reject valid CLI-token callers the guard allows.
    for (const p of ["src/app/api/mcp/[plugin]/sse/route.js", "src/app/api/mcp/[plugin]/message/route.js"]) {
      expect(read(p)).not.toMatch(/isLocalRequest/);
    }
  });
});
