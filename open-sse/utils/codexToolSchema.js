// 0.5.165 (upstream 781c18d8) — Codex-specific tool JSON Schema compatibility.
//
// `https://chatgpt.com/backend-api/codex/responses` validates every function
// tool's `parameters` with a regex engine that has no Unicode property escapes.
// A `pattern` such as
//
//   "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./\\[\\]]{1,200}$"
//
// is a valid ECMAScript u-mode regex, but Codex answers
//
//   400 Invalid schema for function 'Artifact': '^\p{Cc}...' is not a 'regex'
//
// The request is malformed for this provider alone, so every account fails the
// same way and a combo pays a full failover before landing somewhere that
// accepts it.
//
// Scope: this is NOT a global schema sanitizer. It runs only on the Codex
// dispatch path and only drops `pattern` strings that contain a property escape.
// Everything else (valid patterns included) passes through byte-identical, and
// providers that support `\p{...}` never see this code.

// `\p{` / `\P{` preceded by an odd number of backslashes. An even count means
// the backslash itself is escaped, so `\\p{Cc}` is a literal "p".
const UNICODE_PROPERTY_ESCAPE = /(^|[^\\])(\\\\)*\\[pP]\{/;

export function hasUnicodePropertyEscape(pattern) {
  return typeof pattern === "string" && UNICODE_PROPERTY_ESCAPE.test(pattern);
}

// Copy-on-write walk: returns the original reference when nothing changed, so an
// untouched schema keeps its identity and the caller's schema stays intact for a
// retry against another provider. `properties` is special-cased because its keys
// are arbitrary property *names* (which may be "pattern" or "properties") and must
// never be read as schema keywords.
function stripNode(node, stats) {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const cleaned = stripNode(item, stats);
      if (cleaned !== item) changed = true;
      return cleaned;
    });
    return changed ? next : node;
  }
  if (!node || typeof node !== "object") return node;

  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "pattern" && hasUnicodePropertyEscape(value)) {
      stats.removed += 1;
      changed = true;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      let propsChanged = false;
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        const cleaned = stripNode(propSchema, stats);
        if (cleaned !== propSchema) propsChanged = true;
        props[propName] = cleaned;
      }
      if (propsChanged) changed = true;
      next[key] = propsChanged ? props : value;
      continue;
    }
    const cleaned = stripNode(value, stats);
    if (cleaned !== value) changed = true;
    next[key] = cleaned;
  }
  return changed ? next : node;
}

// Remove only the `pattern` constraints Codex's validator rejects.
// Returns the same reference when the schema is already compatible.
export function stripCodexUnsupportedPatterns(schema, stats = { removed: 0 }) {
  return stripNode(schema, stats);
}
