/**
 * Tool normalization before dispatch:
 * - Strip built-in tools when equivalent MCP tools are present (Claude clients
 *   only; reduces tool-definition token bloat).
 * - 0.5.166 — drop later same-name tools for DeepSeek models. DeepSeek answers 400
 *   "Tool names must be unique" on every endpoint that serves it; first definition
 *   wins, and tool_choice / history refer by name or id, so nothing else changes
 *   (upstream 7f5bd155).
 */

const DEDUP_RULES = [
  {
    // Exa MCP present → drop built-in web tools (Exa is preferred).
    triggers: ["mcp__exa__web_search_exa", "mcp__exa__web_fetch_exa"],
    strip: ["WebSearch", "WebFetch", "mcp__workspace__web_fetch"],
  },
  {
    // Tavily MCP present → drop built-in web tools.
    triggers: ["mcp__tavily__tavily_search", "mcp__tavily__tavily_extract"],
    strip: ["WebSearch", "WebFetch", "mcp__workspace__web_fetch"],
  },
  {
    // Browser MCP present → drop Cowork's duplicate Claude_in_Chrome connector.
    triggers: [/^mcp__browsermcp__/],
    strip: [/^mcp__Claude_in_Chrome__/],
  },
];

function getToolName(t) {
  return t?.name || t?.function?.name || "";
}

function matches(name, pattern) {
  if (typeof pattern === "string") return name === pattern;
  return pattern instanceof RegExp ? pattern.test(name) : false;
}

// "deepseek-v4-pro", "deepseek/deepseek-v4-pro", "cline-pass/deepseek-v4-pro":
// kRouter catalog ids carry a vendor prefix, so match the last path segment.
// A trailing "(level)" thinking override is stripped first.
function isDeepSeekModel(model) {
  if (typeof model !== "string") return false;
  const id = model.replace(/\([^()]+\)\s*$/, "").trim().split("/").pop() || "";
  return /^deepseek-/i.test(id);
}

function mcpEquivalentNames(names) {
  const toStrip = new Set();
  for (const rule of DEDUP_RULES) {
    const hasTrigger = names.some((n) => rule.triggers.some((p) => matches(n, p)));
    if (!hasTrigger) continue;
    for (const n of names) {
      if (rule.strip.some((p) => matches(n, p))) toStrip.add(n);
    }
  }
  return toStrip;
}

function laterDuplicateIndexes(names) {
  const seen = new Set();
  const toDrop = new Set();
  names.forEach((n, i) => {
    if (!n) return;
    if (seen.has(n)) toDrop.add(i);
    else seen.add(n);
  });
  return toDrop;
}

/**
 * @param {Array} tools - translated tools array (never mutated)
 * @param {object} [opts]
 * @param {string|null} [opts.clientTool] - detected client; the MCP rules run for "claude" only
 * @param {string|null} [opts.model] - model id; same-name dedup runs for deepseek-* models
 * @returns {{ tools: Array, stripped: Array<string> }}
 */
function dedupeTools(tools, opts = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, stripped: [] };
  const names = tools.map(getToolName);
  const toStrip = opts.clientTool === "claude" ? mcpEquivalentNames(names) : new Set();
  const toDrop = isDeepSeekModel(opts.model) ? laterDuplicateIndexes(names) : new Set();
  if (toStrip.size === 0 && toDrop.size === 0) return { tools, stripped: [] };
  const out = tools.filter((t, i) => !toDrop.has(i) && !toStrip.has(names[i]));
  const stripped = [...toDrop].map((i) => names[i]).concat([...toStrip]);
  return { tools: out, stripped };
}

export { dedupeTools };
