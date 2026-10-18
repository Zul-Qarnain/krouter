// 0.5.165 — the key a CLI tool's Apply writes into that tool's config (upstream 06eda8b0).
// The cards send the literal "sk_krouter" (or nothing) when no key is picked, and the
// routes used to write that placeholder through. It is not a dashboard key, so every
// request from the tool got 401 "Invalid API key" whenever requireApiKey is on (every
// Docker install). Order: the key the user picked, else the first active dashboard
// key, else "" (fine when requireApiKey is off). A placeholder is never written.

import { getApiKeys } from "@/lib/localDb";

// "sk_9router" is what upstream's cards send; a kRouter config imported from 9router
// may carry it too.
const PLACEHOLDER_KEYS = new Set(["sk_krouter", "sk_9router"]);

/**
 * @param {string|null|undefined} callerKey  Key the card sent.
 * @returns {Promise<string>}
 */
export async function resolveCliApiKey(callerKey) {
  const picked = typeof callerKey === "string" ? callerKey.trim() : "";
  if (picked && !PLACEHOLDER_KEYS.has(picked)) return picked;
  try {
    const keys = await getApiKeys();
    return keys.find((k) => k.isActive)?.key || "";
  } catch (error) {
    console.log("Error reading API keys for CLI tool config:", error);
    return "";
  }
}
