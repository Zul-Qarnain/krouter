// 0.5.110 (upstream a11937cd + 59b78282) — Grok CLI / Grok Build constants.
//
// Distinct from our other two Grok-family providers:
//   xai      -> api.x.ai            (API key / OAuth PKCE, API credits)
//   grok-web -> grok.com            (web SSO cookie)
//   grok-cli -> cli-chat-proxy.grok.com (Grok Build subscription, this file)
//
// The gateway fingerprints the official CLI, so these values must track the
// real client. Verified live against cli-chat-proxy.grok.com: /v1/models and
// /v1/billing both answer 200 with these headers on a valid xAI token.
// 0.5.165 — cli-chat-proxy answers HTTP 426 to identities below 1.0.13, so keep
// this on a current @xai-official/grok release (1.0.44 as of 2026-10-01) (upstream 6b9dc54d).
export const GROK_CLI_VERSION = "1.0.44";
export const GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const GROK_CLI_CLIENT_IDENTIFIER = "grok-shell";
export const GROK_CLI_USER_AGENT = `grok-shell/${GROK_CLI_VERSION} (linux; x86_64)`;

/**
 * Only grok-4.5 accepts reasoning.effort. Sending it to anything else is a
 * hard error, so unknown models omit it until live metadata says otherwise.
 * Confirmed against the live catalog: grok-4.5 advertises low/medium/high.
 */
export function supportsGrokCliReasoningEffort(model) {
  return /^grok-4\.5(?:$|-)/.test(String(model || ""));
}
