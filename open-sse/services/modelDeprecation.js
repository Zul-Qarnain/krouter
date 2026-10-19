// modelDeprecation (0.5.31) — port of O‍mniRoute's modelDeprecation.
//
// Maps deprecated model IDs to their active replacements. When a provider
// (like Google or Anthropic) retires a model, users with that model hardcoded
// in their combos or IDEs would normally get 404s. This automatically remaps
// the request to the official successor model.

const BUILT_IN_ALIASES = {
  // Gemini legacy → current
  // 0.5.166 — was gemini-2.5-pro / -flash, which entered their retirement window on the
  // partner platforms (Vertex retires them before the Gemini API does). Point at the
  // current GA pro and the self-following flash alias instead.
  "gemini-pro": "gemini-4-argon",
  "gemini-pro-vision": "gemini-4-argon",
  "gemini-1.5-pro": "gemini-4-argon",
  "gemini-1.5-flash": "gemini-flash-latest",
  "gemini-1.0-pro": "gemini-4-argon",
  "gemini-2.0-flash": "gemini-flash-latest",
  "gemini-3-pro-high": "gemini-3.1-pro-high",
  "gemini-3-pro-low": "gemini-3.1-pro-low",

  // Claude legacy → current. 0.5.166 — these pointed at claude-opus-4-20250514 and
  // claude-sonnet-4-20250514 (both retired 2026-06-15) and claude-3-5-sonnet-20241022
  // (retired 2025-10-28), so the "fix" returned a second 404. Re-pointed tier for tier.
  "claude-3-opus-20240229": "claude-opus-5-5",
  "claude-3-sonnet-20240229": "claude-sonnet-5-5",
  "claude-3-haiku-20240307": "claude-haiku-4-5-20251001",
  "claude-3-5-sonnet-latest": "claude-sonnet-5-5",
  "claude-3-5-haiku-latest": "claude-haiku-4-5-20251001",

  // OpenAI legacy → current. 0.5.166 — these pointed at gpt-4-turbo and gpt-3.5-turbo,
  // which OpenAI shuts down on 2026-10-23, so the alias was about to start 404ing too.
  "gpt-4-turbo-preview": "gpt-5.4",
  "gpt-4-0125-preview": "gpt-5.4",
  "gpt-4-1106-preview": "gpt-5.4",
  "gpt-3.5-turbo-0125": "gpt-5.4-mini",

  // Kimi / Fireworks
  "kimi-k2p5": "moonshotai/Kimi-K2.5",
  // 0.5.166 — was moonshotai/Kimi-K2: no such provider here. kimi-k2.5 is served.
  "kimi-k2": "kimi-k2.5",

  // Mistral / Codestral
  "mistral-large": "mistral-large-latest",
  // 0.5.166 — mistral-small-latest is not served; medium is the nearest tier we route.
  "mistral-small": "mistral-medium-latest",
  "codestral": "codestral-latest",
  "codestral-2405": "codestral-latest", // 0.5.166 — codestral-2508 is not served

  // Llama
  "llama-3.3": "llama-3.3-70b-versatile",
  "llama-3-70b": "llama-3.3-70b-versatile",
  // 0.5.166 — llama-3-8b is deliberately NOT aliased. The only Llama we serve on Groq is
  // the 70B, and quietly turning an 8B request into a 70B one changes what it costs; a
  // clear "unknown model" beats a surprise bill.
};

// Check if a model is deprecated and return its successor.
// Also handles "provider/model" prefixes by extracting the bare model,
// remapping it, and re-attaching the prefix.
export function resolveDeprecatedModel(modelStr) {
  if (!modelStr || typeof modelStr !== "string") return modelStr;

  let prefix = "";
  let bareModel = modelStr;

  const slashIdx = modelStr.indexOf("/");
  if (slashIdx !== -1) {
    prefix = modelStr.slice(0, slashIdx + 1);
    bareModel = modelStr.slice(slashIdx + 1);
  }

  const replacement = BUILT_IN_ALIASES[bareModel];
  if (replacement) {
    // If the replacement string already has a provider slash (e.g. moonshotai/Kimi-K2.5),
    // use it as-is. Otherwise, re-attach the original provider prefix.
    if (replacement.includes("/")) return replacement;
    return `${prefix}${replacement}`;
  }

  return modelStr;
}

// 0.5.166 — exposed so tests can assert every target is still a served model
// (an alias that lands on a retired id turns one 404 into another).
export const __test__ = { BUILT_IN_ALIASES };
