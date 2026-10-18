import { resolveDns } from "../shared/dnsResolver.js";
import { HEALTH_CHECK } from "./config.js";

export async function probeUrlAlive(url) {
  if (!url) return false;
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return false; }

  if (!await resolveDns(hostname, HEALTH_CHECK.dnsTimeoutMs)) return false;

  try {
    const res = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_CHECK.fetchTimeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// 0.5.165 — callers may pass a shorter timeoutMs; the enable flow does, so the
// toggle stops hanging for the full 180 s while DNS propagates (upstream e7c269b8).
export async function waitForHealth(url, cancelToken = { cancelled: false }, { timeoutMs = HEALTH_CHECK.timeoutMs } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cancelToken.cancelled) throw new Error("cancelled");
    if (await probeUrlAlive(url)) return true;
    await new Promise((r) => setTimeout(r, HEALTH_CHECK.intervalMs));
  }
  throw new Error(`Health check timeout after ${timeoutMs}ms`);
}
