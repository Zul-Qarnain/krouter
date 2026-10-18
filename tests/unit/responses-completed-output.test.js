// 0.5.166 (upstream 273f0c32) — response.completed carries the finished Response
// object, so response.output has to repeat the items already delivered in
// response.output_item.done. Clients that build their final result from the
// terminal event (GitHub Copilot CLI, the OpenAI SDK "final response" helpers)
// otherwise treat the turn as empty even though the text was streamed.
import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState } from "../../open-sse/translator/index.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";

// targetFormat === OPENAI is the direct openai -> openai-responses route, the only
// one where flush() reaches this translator.
function newState() {
  return { ...initState(FORMATS.OPENAI_RESPONSES), targetFormat: FORMATS.OPENAI };
}

function textChunk(text, index = 0) {
  return { id: "chatcmpl-1", choices: [{ index, delta: { content: text } }] };
}

function reasoningChunk(text, index = 0) {
  return { id: "chatcmpl-1", choices: [{ index, delta: { reasoning_content: text } }] };
}

function toolChunk(id, name, args, index = 0) {
  return { id: "chatcmpl-1", choices: [{ index: 0, delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }] };
}

function finishChunk(usage, reason = "stop") {
  return { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: reason }], usage };
}

function runChunks(chunks) {
  const state = newState();
  const events = [];
  for (const chunk of chunks) {
    for (const event of openaiToOpenAIResponsesResponse(chunk, state)) events.push(event);
  }
  return { state, events };
}

function completedResponse(events) {
  const completed = events.find((event) => event.event === "response.completed");
  expect(completed, "expected a response.completed event").toBeTruthy();
  return completed.data.response;
}

function doneItems(events) {
  return events
    .filter((event) => event.event === "response.output_item.done")
    .map((event) => event.data.item);
}

describe("response.completed output", () => {
  it("repeats the streamed message in response.completed", () => {
    const state = newState();
    openaiToOpenAIResponsesResponse(textChunk("O"), state);
    openaiToOpenAIResponsesResponse(textChunk("K"), state);
    const response = completedResponse(openaiToOpenAIResponsesResponse(null, state));

    expect(response.status).toBe("completed");
    expect(response.output).toHaveLength(1);
    expect(response.output[0]).toMatchObject({ type: "message", role: "assistant" });
    expect(response.output[0].content[0]).toMatchObject({ type: "output_text", text: "OK" });
  });

  it("matches exactly the items already delivered in response.output_item.done", () => {
    const { events } = runChunks([
      textChunk("hello"),
      finishChunk({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }),
    ]);
    const response = completedResponse(events);
    const streamed = doneItems(events);

    expect(streamed).toHaveLength(1);
    expect(response.output).toEqual(streamed);
  });

  it("includes a function_call item", () => {
    const { events } = runChunks([
      toolChunk("call_1", "get_weather", '{"city":"Paris"}'),
      finishChunk({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, "tool_calls"),
    ]);
    const response = completedResponse(events);

    expect(response.output).toHaveLength(1);
    expect(response.output[0]).toMatchObject({
      type: "function_call",
      name: "get_weather",
      arguments: '{"city":"Paris"}',
      call_id: "call_1",
    });
  });

  it("orders output by output_index", () => {
    const { events } = runChunks([
      reasoningChunk("thinking", 0),
      textChunk("answer", 1),
      finishChunk({ prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }),
    ]);
    const response = completedResponse(events);

    expect(response.output.map((item) => item.type)).toEqual(["reasoning", "message"]);
    expect(response.output[1].content[0]).toMatchObject({ type: "output_text", text: "answer" });
  });

  // kRouter adaptation: a real single-choice stream puts reasoning, message and the
  // first tool call all on choice index 0, so they share output_index 0. Keying the
  // record by output_index (as upstream does) kept only the last item closed.
  it("keeps every item when reasoning, text and a tool call share choice index 0", () => {
    const { events } = runChunks([
      reasoningChunk("plan"),
      textChunk("Looking it up."),
      toolChunk("call_9", "lookup", "{}"),
      finishChunk({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, "tool_calls"),
    ]);
    const response = completedResponse(events);

    expect(response.output.map((item) => item.type)).toEqual(["reasoning", "message", "function_call"]);
    expect(response.output).toEqual(doneItems(events));
  });

  it("reports an empty output array when nothing was produced", () => {
    const state = newState();
    const response = completedResponse(openaiToOpenAIResponsesResponse(null, state));
    expect(response.output).toEqual([]);
  });

  it("keeps the usage block alongside output", () => {
    const { events } = runChunks([
      textChunk("OK"),
      finishChunk({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }),
    ]);
    const response = completedResponse(events);

    expect(response.usage).toMatchObject({ input_tokens: 3, output_tokens: 1, total_tokens: 4 });
    expect(response.output).toHaveLength(1);
  });

  it("leaves the in-progress response.created output empty", () => {
    const { events } = runChunks([textChunk("hi")]);
    const created = events.find((event) => event.event === "response.created");
    expect(created.data.response.status).toBe("in_progress");
    expect(created.data.response.output).toEqual([]);
  });

  it("does not duplicate items when flush runs more than once", () => {
    const state = newState();
    openaiToOpenAIResponsesResponse(textChunk("once"), state);
    openaiToOpenAIResponsesResponse(null, state);
    const second = openaiToOpenAIResponsesResponse(null, state);

    expect(second).toEqual([]);
    expect(state.completedOutputItems.size).toBe(1);
  });
});
