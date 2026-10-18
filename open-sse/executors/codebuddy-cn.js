// 0.5.109 (upstream efd20be8) — CodeBuddy CN (Tencent) executor.
import { DefaultExecutor } from "./default.js";

// The gateway has no "none" tier — asking for it is an error, so we omit the
// param entirely and let CodeBuddy fall back to its own default.
const REASONING_OFF_VALUES = new Set(["none", "off"]);

// 0.5.165 — the effort ladder, cheapest first. Used only to step a requested
// level onto the nearest one a model actually publishes.
const EFFORT_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

// 0.5.165 (upstream e014cb53 + the upstream/master end state) — the per-model
// effort sets CodeBuddy's own product-config payload publishes as
// `reasoning.supportedEfforts`, snapshot 2026-09-30. The chat endpoint answers
// 200 for any level and then silently clamps whatever is outside the set, so the
// published set is the only description of what the model will really do. Models
// that publish no set (glm-5.1, kimi-k3-1, minimax-m3) are absent here and keep
// the client's level untouched. Keyed by exact id on purpose: a prefix rule for
// "deepseek-v4" would swallow deepseek-v4.1-flash, which has a different set.
const MODEL_EFFORTS = new Map([
  ["glm-5.3", ["low", "high", "max"]],
  ["glm-5.3-flash", ["low", "high", "max"]],
  ["glm-5.2", ["high", "xhigh"]],
  ["kimi-k2.8-preview", ["low", "medium", "high"]],
  ["hy3", ["low", "high"]],
  ["hy4-preview", ["high"]],
  ["deepseek-v4-pro", ["low", "high", "xhigh"]],
  ["deepseek-v4.1-flash", ["low", "high", "max"]],
]);

/**
 * Step an effort onto the nearest level the model publishes.
 *
 * Down, not up: never spend more thinking than the client asked for. A level
 * below the model's floor is the one exception — there is nothing cheaper to
 * pick, so it rises to that floor. An effort the ladder does not know (or a
 * model with no published set) is returned untouched.
 */
export function clampCodeBuddyEffort(model, effort) {
  const supported = MODEL_EFFORTS.get(model);
  if (!supported || supported.includes(effort)) return effort;
  const wanted = EFFORT_LADDER.indexOf(effort);
  if (wanted === -1) return effort;
  const ranked = supported
    .map((level) => ({ level, rank: EFFORT_LADDER.indexOf(level) }))
    .filter((entry) => entry.rank !== -1)
    .sort((a, b) => a.rank - b.rank);
  if (!ranked.length) return effort;
  const atOrBelow = ranked.filter((entry) => entry.rank <= wanted);
  return (atOrBelow.length ? atOrBelow[atOrBelow.length - 1] : ranked[0]).level;
}

// 0.5.165 (upstream e706e4f2) — the rate-limit envelope. CodeBuddy reports a
// per-model frequency limit as its own code 6004 with the retry time in the
// message, on whatever HTTP status it feels like (seen on 200 and 400), so the
// text is the only reliable marker. Chinese first because that is what the CN
// gateway sends.
const FREQUENCY_LIMIT_CODE = 6004;
const FREQUENCY_LIMIT_TEXT = /超出频率限制|频率限制|限额|frequency limit/i;
const RESET_TIME = /(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2}:\d{2})(?:\s*UTC\s*([+-]?[0-9:]+))?/i;
// No offset in the text means Beijing time: the CN gateway publishes nothing else.
const DEFAULT_RESET_OFFSET = "+08:00";

function normalizeOffset(raw) {
  if (!raw) return DEFAULT_RESET_OFFSET;
  const sign = raw.startsWith("-") ? "-" : "+";
  const digits = raw.replace(/^[+-]/, "");
  const [hours, minutes = "00"] = digits.split(":");
  return `${sign}${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
}

// Returns the epoch ms the limit lifts, or null when the message carries no time.
export function parseCodeBuddyResetTime(message) {
  const match = RESET_TIME.exec(String(message || ""));
  if (!match) return null;
  const parsed = new Date(`${match[1]}T${match[2]}${normalizeOffset(match[3])}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

/**
 * CodeBuddyExecutor — https://copilot.tencent.com/v2/chat/completions
 *
 * Three gateway quirks this exists to absorb:
 *
 * 1. Non-stream requests are rejected outright (HTTP 400, code 11101
 *    "Non-stream chat request is currently not supported"). The same-format
 *    openai->openai translator path passes body.stream through untouched, so a
 *    non-streaming client would fail. We force stream:true; kRouter still
 *    re-aggregates the SSE back into a single JSON response for those clients.
 *
 * 2. Reasoning only surfaces when the request carries the CLI's OpenAI-style
 *    params (reasoning_effort + reasoning_summary:"auto"). We mirror the pair,
 *    but only when the client actually asked for reasoning: forcing
 *    reasoning_effort:"medium" on a plain request trips CodeBuddy's content
 *    filter and the answer comes back as an error (upstream d1e98d9a, #2071).
 *    "medium" is also outside most of the per-model sets above.
 *
 * 3. A per-model frequency limit arrives as envelope code 6004 rather than an
 *    HTTP 429, so parseError has to re-label it for cross-account fallback.
 */
export class CodeBuddyExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-cn");
  }

  transformRequest(model, body, stream, credentials) {
    const base = super.transformRequest(model, body, stream, credentials);
    // Copy-on-write: `base` can still be the caller's own body object.
    const transformed = { ...base, stream: true };

    const effort = transformed.reasoning_effort;
    if (!effort || REASONING_OFF_VALUES.has(effort)) {
      delete transformed.reasoning_effort;
      delete transformed.reasoning_summary;
      return transformed;
    }

    transformed.reasoning_effort = clampCodeBuddyEffort(model, effort);
    transformed.reasoning_summary = "auto";
    return transformed;
  }

  parseError(response, bodyText) {
    let parsed = null;
    try {
      parsed = JSON.parse(bodyText || "");
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object") {
      const message = parsed.msg || parsed.message || parsed.error?.message || "";
      if (parsed.code === FREQUENCY_LIMIT_CODE || FREQUENCY_LIMIT_TEXT.test(message)) {
        return {
          status: 429,
          message: message || `CodeBuddy frequency limit (${FREQUENCY_LIMIT_CODE})`,
          resetsAtMs: parseCodeBuddyResetTime(message),
        };
      }
    }
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyExecutor;
