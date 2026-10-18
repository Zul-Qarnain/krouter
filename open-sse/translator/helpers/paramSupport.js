// Strip request params a given provider/model rejects upstream (e.g. HTTP 400).
//
// Config-driven so a single rule table is the source of truth instead of
// `delete body.x` lines scattered across executors. Add a new entry to
// STRIP_RULES whenever a provider rejects a param for some model.
//
// Ported from upstream commit 7ae9fff (fix #1748). Kept in
// translator/helpers/ to match our existing file layout (upstream places it
// under translator/concerns/ post-refactor — same shape, different path).

// Each rule:
//   provider?  string  — restrict to this provider id; omit to apply globally
//   match?     RegExp | (model) => boolean  — predicate on the model id; omit to
//              match every model (0.5.166 — provider-only rules used to throw)
//   drop?      string[]  — request-body keys to remove when both checks pass
//   dropMessageFields?  string[]  — keys to remove from assistant messages
const REPLAYED_REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_details"];

const STRIP_RULES = [
  // All Claude models: `temperature` is rejected by the upstream Anthropic API
  // on OpenAI-compatible routes (400 "deprecated for this model") — not just the
  // opus-4 series. Hits any path routing to a claude model regardless of provider
  // (direct Anthropic, Copilot, Kiro pass-through, etc.). Broadened from
  // /claude-opus-4/i per upstream 9173c29b (#1748); trades fine temperature
  // control for not hard-400ing the request.
  { match: /claude/i, drop: ["temperature"] },

  // GitHub Copilot's gpt-5.4 family rejects `temperature`.
  { provider: "github", match: /gpt-5\.4/i, drop: ["temperature"] },

  // GitHub Copilot Claude models — Copilot's /chat/completions doesn't
  // understand Claude-style `thinking` payloads, and only Claude opus 4.6 /
  // sonnet 4.6 honour `reasoning_effort` on Copilot; everything else (Claude
  // Haiku 4.5, Claude Opus 4.7, etc.) rejects it. Strip both keys for Claude
  // models that aren't the two opus/sonnet 4.6 exceptions. Ref: upstream #713.
  //
  // Note: kRouter's model registry uses BOTH dot ("claude-opus-4.6") and
  // hyphen ("claude-opus-4-6", "claude-opus-4-6-thinking") forms — upstream's
  // literal-dot regex only matched the first, so on our codebase the 4.6
  // exception failed to fire and stripped thinking from valid 4.6 requests.
  // Allow [.\-] between the version digits to cover both.
  {
    provider: "github",
    match: (m) => /claude/i.test(m) && !/claude.*(opus|sonnet).*4[.\-]6/i.test(m),
    drop: ["thinking", "reasoning_effort"],
  },

  // 0.5.166 (upstream 7c2b1fe3) — strict OpenAI-compatible validators reject
  // unknown assistant-message fields. Clients driving reasoning models (Hermes
  // Agent, the DeepSeek/Kimi convention) echo the prior turn's reasoning on every
  // assistant message: Groq 400, Mistral 422 ("extra_forbidden"), Cerebras 400,
  // which knocks these providers out of every multi-turn combo. Providers that
  // *require* the field (DeepSeek, Kimi) are handled by reasoningContentInjector.
  { provider: "groq", dropMessageFields: REPLAYED_REASONING_FIELDS },
  { provider: "mistral", dropMessageFields: REPLAYED_REASONING_FIELDS },
  { provider: "cerebras", dropMessageFields: REPLAYED_REASONING_FIELDS },
];

function matches(rule, model) {
  if (!rule.match) return true;
  return typeof rule.match === "function" ? rule.match(model) : rule.match.test(model);
}

// 0.5.166 — copy-on-write: the message objects may be the client's own, so build
// new ones rather than deleting in place (upstream 7c2b1fe3 deleted in place).
function dropAssistantFields(messages, fields) {
  let changed = false;
  const next = messages.map((msg) => {
    if (!msg || msg.role !== "assistant" || !fields.some((k) => msg[k] !== undefined)) return msg;
    changed = true;
    return Object.fromEntries(Object.entries(msg).filter(([k]) => !fields.includes(k)));
  });
  return changed ? next : messages;
}

/**
 * Mutate `body` to remove any param a provider/model is known to reject.
 * Returns the same body for chainability.
 *
 * @param {string} provider  provider id (e.g. "claude", "github")
 * @param {string} model     upstream model id (e.g. "claude-opus-4-6")
 * @param {object} body      request body (will be mutated in place)
 * @returns {object} body
 */
export function stripUnsupportedParams(provider, model, body) {
  if (!model || !body || typeof body !== "object") return body;
  for (const rule of STRIP_RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    if (!matches(rule, model)) continue;
    for (const key of rule.drop || []) {
      if (body[key] !== undefined) delete body[key];
    }
    if (Array.isArray(rule.dropMessageFields) && Array.isArray(body.messages)) {
      body.messages = dropAssistantFields(body.messages, rule.dropMessageFields);
    }
  }
  return body;
}

// Test hook so unit tests can exercise rules without spinning up an executor.
export const __test__ = { STRIP_RULES, matches };
