/**
 * 0.5.166 (upstream b3d6e089 + a61fc6a0) — two more Antigravity system-prompt
 * rewrites. Antigravity's backend flags competing-client branding and answers
 * 429 "Quota Exhausted" regardless of real quota.
 *
 *  - b3d6e089: Claude Code prepends an `x-anthropic-billing-header:` line to its
 *    system prompt. The Claude-format translator strips it, but OpenAI-format
 *    clients pass it straight through.
 *  - a61fc6a0: the legacy Hermes rule only matched one exact sentence. Current
 *    Hermes builds say "You are Hermes Agent, built by Nous Research." and
 *    similar, which slipped through. Replace every variant with a neutral
 *    identity.
 */
import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_PROMPT_REWRITES } from "../../open-sse/config/appConstants.js";

// Mirrors the executor's loop over systemInstruction.parts.
const rewrite = (text) => {
  let out = text;
  for (const { from, to } of ANTIGRAVITY_PROMPT_REWRITES) out = out.replaceAll(from, to);
  return out;
};

describe("x-anthropic-billing-header line is stripped", () => {
  it("drops the header line when it opens the prompt", () => {
    const out = rewrite("x-anthropic-billing-header: cc-sub\nYou are a helpful assistant.");
    expect(out).toBe("You are a helpful assistant.");
  });

  it("drops it on a later line too", () => {
    const out = rewrite("Intro.\nx-anthropic-billing-header: cc-sub\nRest.");
    expect(out).not.toContain("billing-header");
    expect(out).toContain("Intro.");
    expect(out).toContain("Rest.");
  });

  it("matches case-insensitively and consumes CRLF", () => {
    const out = rewrite("X-Anthropic-Billing-Header: anything\r\nBody.");
    expect(out).toBe("Body.");
  });

  it("leaves a mid-line mention alone (only a real header line is a flag)", () => {
    const text = "Never echo x-anthropic-billing-header: values back to the user.";
    expect(rewrite(text)).toBe(text);
  });
});

describe("every Hermes identity variant becomes a neutral identity", () => {
  const variants = [
    "You are Hermes Agent, an intelligent AI assistant created by Nous Research.",
    "You are Hermes Agent, built by Nous Research.",
    "You are Hermes Agent, an AI assistant created by Nous Research.",
    "You are Hermes Agent, an AI agent built by Nous Research.",
    "You are Hermes Agent.",
    "You are Hermes, built by Nous Research.",
  ];

  for (const variant of variants) {
    it(`rewrites: ${variant}`, () => {
      const out = rewrite(`Preamble. ${variant} Rules follow.`);
      expect(out).toContain("You are an AI assistant.");
      expect(out).not.toMatch(/Hermes/i);
      expect(out).not.toMatch(/Nous Research/i);
      expect(out).toContain("Preamble.");
      expect(out).toContain("Rules follow.");
    });
  }

  it("rewrites every occurrence, not just the first", () => {
    const out = rewrite("You are Hermes Agent, built by Nous Research. Again: You are Hermes Agent.");
    expect(out).not.toMatch(/Hermes/i);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const once = rewrite("You are Hermes Agent, built by Nous Research.");
    expect(rewrite(once)).toBe(once);
  });
});

describe("the earlier rules still hold", () => {
  it("still strips the Zed Claude Agent SDK line", () => {
    const out = rewrite("Intro. You are a Claude agent, built on Anthropic's Claude Agent SDK. Rest.");
    expect(out).not.toContain("Claude Agent SDK");
  });

  it("still renames OpenCode branding, preserving casing", () => {
    expect(rewrite("You are OpenCode.")).toBe("You are Antigravity.");
    expect(rewrite("OPENCODE MODE")).toBe("ANTIGRAVITY MODE");
  });

  it("leaves an unrelated prompt untouched", () => {
    const text = "You are a helpful assistant working on a Rust codebase.";
    expect(rewrite(text)).toBe(text);
  });
});
