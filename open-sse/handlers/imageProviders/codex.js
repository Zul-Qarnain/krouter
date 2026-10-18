// Codex (ChatGPT Plus/Pro) image generation via Responses API + SSE
import { randomUUID } from "node:crypto";
import { nowSec } from "./_base.js";
import { CODEX_CLI_VERSION } from "../../config/providers.js";
import { getProviderModels } from "../../config/providerModels.js";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
// 0.5.165 — these two were pinned at 0.136.0 of their own accord while the chat
// transport moved on; one constant now feeds every Codex identity header
// (upstream a7047a07, ca6e8407).
const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_CLI_VERSION}`;
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_MODEL_SUFFIX = "-image";
const CODEX_REF_DETAIL = "high";
// 0.5.165 — the chat model every standalone gpt-image-* request runs on. gpt-5.5,
// upstream's original choice, was retired from ChatGPT sign-in on 2026-10-14 and
// now answers 400 (upstream 832a3465, eb712ca8, 7878f53b).
// tests/unit/codex-image-models-run-on-a-chat-model.test.js fails if the cx
// catalog ever stops serving it.
const CODEX_IMAGES_MAIN_MODEL = "gpt-5.6-sol";
// How a standalone image model is told apart from a "<chat model>-image" id,
// which keeps running on its own chat model. Membership is read from the catalog
// (see resolveCodexImageModels) so a new gpt-image release is a one-line change
// there and nothing to maintain here.
const CODEX_TOOL_IMAGE_PREFIX = "gpt-image-";

function decodeAccountId(idToken) {
  try {
    const parts = String(idToken || "").split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (b64.length % 4)) % 4;
    const payload = JSON.parse(Buffer.from(b64 + "=".repeat(pad), "base64").toString("utf8"));
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id || null;
  } catch {
    return null;
  }
}

function stripImageSuffix(model) {
  return model.endsWith(CODEX_MODEL_SUFFIX) ? model.slice(0, -CODEX_MODEL_SUFFIX.length) : model;
}

// Which model carries the conversation and which one draws. A standalone
// gpt-image-* id cannot carry the conversation, so it rides in
// image_generation.model and a chat model takes its place.
function resolveCodexImageModels(model) {
  const isToolImageModel = typeof model === "string"
    && model.startsWith(CODEX_TOOL_IMAGE_PREFIX)
    && getProviderModels("cx").some((entry) => entry.id === model && entry.type === "image");
  if (isToolImageModel) {
    return { responsesModel: CODEX_IMAGES_MAIN_MODEL, toolModel: model };
  }
  return { responsesModel: stripImageSuffix(model), toolModel: null };
}

function toDataUrl(input) {
  if (!input || typeof input !== "string") return null;
  if (/^data:image\//i.test(input) || /^https?:\/\//i.test(input)) return input;
  return `data:image/png;base64,${input}`;
}

function buildContent(prompt, refs, detail = CODEX_REF_DETAIL) {
  const content = [];
  refs.forEach((url, index) => {
    content.push({ type: "input_text", text: `<image name=image${index + 1}>` });
    content.push({ type: "input_image", image_url: url, detail });
    content.push({ type: "input_text", text: "</image>" });
  });
  content.push({ type: "input_text", text: prompt });
  return content;
}

// 0.5.165 — the exact usage Codex reports on response.completed, in the shape
// saveRequestUsage already understands (upstream e10da160). Anything that is not
// a whole, non-negative token count is dropped rather than recorded as a guess.
function normalizeResponsesUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw.input_tokens ?? raw.prompt_tokens;
  const output = raw.output_tokens ?? raw.completion_tokens;
  if (!Number.isSafeInteger(input) || input < 0) return null;
  if (!Number.isSafeInteger(output) || output < 0) return null;

  const usage = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: Number.isSafeInteger(raw.total_tokens) ? raw.total_tokens : input + output,
  };
  const cached = raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens;
  const reasoning = raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens;
  if (Number.isSafeInteger(cached) && cached >= 0) usage.cached_tokens = cached;
  if (Number.isSafeInteger(reasoning) && reasoning >= 0) usage.reasoning_tokens = reasoning;
  return usage;
}

// Parse Codex SSE stream → final base64 image + reported usage.
// Optional callbacks for client streaming.
async function parseStream(response, log, callbacks = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let imageB64 = null;
  let lastEvent = null;
  let bytesReceived = 0;
  let lastProgressLogMs = 0;
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesReceived += value?.byteLength || 0;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);

      const lines = block.split("\n");
      let eventName = null;
      let dataStr = "";
      for (const line of lines) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (!eventName) continue;
      if (eventName !== lastEvent) {
        log?.info?.("IMAGE", `codex progress: ${eventName}`);
        lastEvent = eventName;
      }

      const now = Date.now();
      if (callbacks.onProgress && now - lastProgressLogMs > 200) {
        lastProgressLogMs = now;
        callbacks.onProgress({ stage: eventName, bytesReceived });
      }

      if (eventName === "response.image_generation_call.partial_image" && dataStr) {
        try {
          const data = JSON.parse(dataStr);
          if (callbacks.onPartialImage && data?.partial_image_b64) {
            callbacks.onPartialImage({ b64_json: data.partial_image_b64, index: data.partial_image_index });
          }
        } catch {}
      }

      if (eventName === "response.output_item.done" && dataStr) {
        try {
          const data = JSON.parse(dataStr);
          const item = data?.item;
          if (item?.type === "image_generation_call" && item.result) {
            imageB64 = item.result;
          }
        } catch {}
      }

      if ((eventName === "response.completed" || eventName === "response.done") && dataStr) {
        try {
          const data = JSON.parse(dataStr);
          usage = normalizeResponsesUsage(data?.response?.usage ?? data?.usage) || usage;
        } catch {}
      }
    }
  }
  return { imageB64, usage };
}

// SSE Response that pipes codex progress + partial + done events to client
function buildSseResponse(providerResponse, log, onSuccess, onUsage) {
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event, data) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const { imageB64: b64, usage } = await parseStream(providerResponse, log, {
          onProgress: (info) => send("progress", info),
          onPartialImage: (info) => send("partial_image", info),
        });
        if (!b64) {
          send("error", { message: "Codex did not return an image. Account may not be entitled (Plus/Pro required)." });
        } else {
          if (usage && onUsage) await onUsage(usage);
          if (onSuccess) await onSuccess();
          send("done", { created: nowSec(), data: [{ b64_json: b64 }] });
        }
      } catch (err) {
        send("error", { message: err?.message || "Stream failed" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export default {
  stream: true,
  buildUrl: () => CODEX_RESPONSES_URL,
  buildHeaders: (creds) => {
    const accountId = creds?.providerSpecificData?.chatgptAccountId || decodeAccountId(creds?.idToken);
    return {
      "accept": "text/event-stream, application/json",
      "authorization": `Bearer ${creds?.accessToken || ""}`,
      "chatgpt-account-id": accountId || "",
      "content-type": "application/json",
      "originator": CODEX_ORIGINATOR,
      "session_id": randomUUID(),
      "user-agent": CODEX_USER_AGENT,
      "version": CODEX_CLI_VERSION,
      "x-client-request-id": randomUUID(),
    };
  },
  buildBody: (model, body) => {
    const refs = [];
    if (Array.isArray(body.images)) body.images.forEach((i) => { const u = toDataUrl(i); if (u) refs.push(u); });
    const single = toDataUrl(body.image);
    if (single) refs.push(single);
    const detail = body.image_detail || CODEX_REF_DETAIL;
    const { responsesModel, toolModel } = resolveCodexImageModels(model);
    const imgTool = { type: "image_generation", output_format: (body.output_format || "png").toLowerCase() };
    if (toolModel) {
      imgTool.action = refs.length > 0 ? "edit" : "generate";
      imgTool.model = toolModel;
    }
    if (body.size && body.size !== "") imgTool.size = body.size;
    if (body.quality && body.quality !== "") imgTool.quality = body.quality;
    if (body.background && body.background !== "") imgTool.background = body.background;
    return {
      model: responsesModel,
      instructions: "",
      input: [{ type: "message", role: "user", content: buildContent(body.prompt, refs, detail) }],
      tools: [imgTool],
      // A standalone image model must be forced; letting the chat model decide
      // means it sometimes answers in prose and never calls the tool.
      tool_choice: toolModel ? { type: "image_generation" } : "auto",
      parallel_tool_calls: false,
      prompt_cache_key: randomUUID(),
      stream: true,
      store: false,
      reasoning: toolModel ? { effort: "medium", summary: "auto" } : null,
    };
  },
  // Custom: codex parses SSE → either pipe to client or collect b64
  async parseResponse(response, { log, streamToClient, onRequestSuccess, onUsage }) {
    if (streamToClient) {
      return { sseResponse: buildSseResponse(response, log, onRequestSuccess, onUsage) };
    }
    const { imageB64: b64, usage } = await parseStream(response, log);
    if (!b64) {
      throw new Error("Codex did not return an image. Account may not be entitled (Plus/Pro required).");
    }
    if (usage && onUsage) await onUsage(usage);
    return { created: nowSec(), data: [{ b64_json: b64 }] };
  },
  normalize: (responseBody) => responseBody,
};
