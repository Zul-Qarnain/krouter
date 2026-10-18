// 0.5.165 — Codex 0.155 introduced a second Responses request shape for the
// GPT-6 Sol/Luna family, "Responses Lite" (upstream 95600db1, 7bf93178).
//
// Those models are served behind the x-openai-internal-codex-responses-lite
// header and expect tools and instructions as input prefix items, with the
// top-level `instructions`/`tools` emptied, parallel_tool_calls off and
// reasoning carrying context: "all_turns". kRouter sent them the legacy shape, so
// gpt-6.1-sol / gpt-6-sol / gpt-6-luna were rejected; and a request already in
// the Lite shape (the real Codex CLI's own) got its developer msg_ ids stripped
// and a duplicate prefix stacked on top.
//
// Hosted web_search cannot run from a Lite prefix, so a request that asks for it
// falls back to regular Responses with the prefixed tools hoisted back out.
//
// Only catalog ids flagged responsesLite change: gpt-6-astra and the 5.6 trio
// keep the legacy transport.
import { describe, expect, it, vi, afterEach } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { CODEX_CLI_VERSION } from "../../open-sse/config/providers.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

const credentials = { connectionId: "fixture", accessToken: "fixture-token", providerSpecificData: {} };
const LITE_HEADER = "x-openai-internal-codex-responses-lite";
const liteIds = PROVIDER_MODELS.cx.filter((m) => m.responsesLite === true).map((m) => m.id);
const fn = (name = "run") => ({ type: "function", name, parameters: { type: "object", properties: {} } });

const transform = (model, body) => new CodexExecutor().transformRequest(model, body, true, credentials);
const headersFor = (model, body = null) =>
  new CodexExecutor().buildHeaders(credentials, true, null, model, body);

afterEach(() => vi.restoreAllMocks());

describe("Codex Responses Lite request shape", () => {
  it("has catalog ids to act on", () => {
    expect(liteIds).toEqual(expect.arrayContaining(["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]));
  });

  it("converts an ordinary Responses request to the Lite shape", () => {
    const tool = fn();
    const body = transform("gpt-6-sol", {
      model: "gpt-6-sol", input: "hello", instructions: "Do the task", tools: [tool],
    });

    expect(body.instructions).toBe("");
    expect(body.tools).toBeNull();
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.reasoning).toEqual({ effort: "medium", context: "all_turns" });
    expect(body.input[0]).toEqual({ type: "additional_tools", role: "developer", tools: [tool] });
    expect(body.input[1]).toEqual({
      type: "message", role: "developer", content: [{ type: "input_text", text: "Do the task" }],
    });
    expect(headersFor("gpt-6-sol", body)[LITE_HEADER]).toBe("true");
  });

  it("applies to every responsesLite id in the catalog, review twins included", () => {
    for (const id of liteIds) {
      const body = transform(id, { model: id, input: "hello" });
      expect(body.input[0].type, `${id} needs a Lite prefix`).toBe("additional_tools");
      expect(headersFor(id, body)[LITE_HEADER], `${id} needs the Lite header`).toBe("true");

      const review = transform(`${id}-review`, { model: `${id}-review`, input: "hello" });
      expect(review.model, `${id}-review maps to its base model`).toBe(id);
      expect(review.input[0].type).toBe("additional_tools");
    }
  });

  it("keeps a request that already arrived in the Lite shape intact", () => {
    const input = [
      { type: "additional_tools", role: "developer", tools: [fn()] },
      { type: "message", id: "msg_native", role: "developer", content: [{ type: "input_text", text: "Native" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ];
    const body = transform("gpt-6-luna", {
      model: "gpt-6-luna", input: structuredClone(input), instructions: "", tools: null,
      parallel_tool_calls: false, reasoning: { effort: "high", context: "all_turns" },
    });

    expect(body.input).toEqual(input);
    expect(body.instructions).toBe("");
    expect(body.tools).toBeNull();
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.reasoning).toEqual({ effort: "high", context: "all_turns" });
  });

  it("clamps the efforts Lite does not accept to low", () => {
    for (const effort of ["none", "minimal"]) {
      const body = transform("gpt-6-luna", { model: "gpt-6-luna", input: "hello", reasoning: { effort } });
      expect(body.reasoning.effort, `${effort} is not a Lite level`).toBe("low");
      expect(body.reasoning.context).toBe("all_turns");
    }
    const explicit = transform("gpt-6-luna", { model: "gpt-6-luna", input: "hello", reasoning_effort: "none" });
    expect(explicit.reasoning.effort).toBe("low");
  });

  it("keeps a supported effort and adds no summary", () => {
    const body = transform("gpt-6.1-sol", { model: "gpt-6.1-sol", input: "hello", reasoning_effort: "high" });
    expect(body.reasoning).toEqual({ effort: "high", context: "all_turns" });
  });

  it("leaves the legacy transport alone for non-Lite Codex models", () => {
    for (const id of ["gpt-6-astra", "gpt-5.6-terra", "gpt-5.3-codex"]) {
      const body = transform(id, { model: id, input: "hello" });
      expect(body.instructions, `${id} keeps the default instructions`).toBeTruthy();
      expect(body.input[0].type).not.toBe("additional_tools");
      expect(body.reasoning.summary).toBe("auto");
      expect(body.reasoning.context).toBeUndefined();
      expect(body).not.toHaveProperty("parallel_tool_calls");
      expect(headersFor(id, body)[LITE_HEADER]).toBeUndefined();
    }
  });

  describe("hosted web search falls back to regular Responses", () => {
    it("keeps a client-sent web_search tool at the top level", () => {
      const tool = fn();
      const body = transform("gpt-6-sol", {
        model: "gpt-6-sol", input: "search the web",
        tools: [tool, { type: "web_search" }], tool_choice: "none",
      });

      expect(body.tools).toEqual([tool, { type: "web_search" }]);
      expect(body.input.some((item) => item?.type === "additional_tools")).toBe(false);
      expect(body.tool_choice).toBe("none");
      expect(body.reasoning.context).toBeUndefined();
      expect(headersFor("gpt-6-sol", body)[LITE_HEADER]).toBeUndefined();
    });

    it("hoists web_search out of a Lite prefix without losing the other tools", () => {
      const tool = fn();
      const body = transform("gpt-6-sol", {
        model: "gpt-6-sol",
        input: [
          { type: "additional_tools", role: "developer", tools: [tool, { type: "web_search" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "search" }] },
        ],
        tools: null, tool_choice: "none",
      });

      expect(body.tools).toEqual([tool, { type: "web_search" }]);
      expect(body.input.some((item) => item?.type === "additional_tools")).toBe(false);
      expect(headersFor("gpt-6-sol", body)[LITE_HEADER]).toBeUndefined();
    });

    it("does not duplicate a tool that sits in both places", () => {
      const tool = fn();
      const body = transform("gpt-6-sol", {
        model: "gpt-6-sol",
        input: [
          { type: "additional_tools", role: "developer", tools: [tool, { type: "web_search" }] },
          { type: "additional_tools", role: "developer", tools: [tool] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "search" }] },
        ],
        tools: [tool, { type: "web_search" }],
      });

      expect(body.tools).toEqual([tool, { type: "web_search" }]);
      expect(body.input.some((item) => item?.type === "additional_tools")).toBe(false);
    });

    it("keeps native Lite developer instructions when it switches", () => {
      const instruction = {
        type: "message", role: "developer", content: [{ type: "input_text", text: "Only answer in French" }],
      };
      const body = transform("gpt-6-sol", {
        model: "gpt-6-sol",
        input: [
          { type: "additional_tools", role: "developer", tools: [{ type: "web_search" }] },
          structuredClone(instruction),
          { type: "message", role: "user", content: [{ type: "input_text", text: "search" }] },
        ],
        instructions: "", tools: null,
      });

      expect(body.input).toContainEqual(instruction);
      expect(body.instructions).toBe("");
      expect(body.tools).toEqual([{ type: "web_search" }]);
    });
  });

  describe("the outbound request", () => {
    it("carries the Lite body and header on the wire", async () => {
      const fetchMock = vi.spyOn(proxyFetchModule, "proxyAwareFetch")
        .mockResolvedValue({ ok: true, status: 200, headers: new Map() });

      await new CodexExecutor().execute({
        model: "gpt-6-luna",
        body: { model: "gpt-6-luna", input: "hello", instructions: "Do the task" },
        stream: true,
        credentials,
      });

      const [url, options] = fetchMock.mock.calls[0];
      const sent = JSON.parse(options.body);
      expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(options.headers[LITE_HEADER]).toBe("true");
      expect(options.headers["version"]).toBe(CODEX_CLI_VERSION);
      expect(options.headers["User-Agent"]).toBe(`codex_cli_rs/${CODEX_CLI_VERSION}`);
      expect(sent.model).toBe("gpt-6-luna");
      expect(sent.instructions).toBe("");
      expect(sent.tools).toBeNull();
      expect(sent.parallel_tool_calls).toBe(false);
      expect(sent.input[0].type).toBe("additional_tools");
      expect(sent.reasoning.context).toBe("all_turns");
    });
  });
});
