/**
 * Helpers for the OpenCode free-tier client fingerprint.
 *
 * 0.5.165 (upstream 5bdcd5e7, e964e482) — OpenCode Free gates /inference/v1 on the
 * v2 CLI's fingerprint. Live probes on 2026-10-18 (no account needed, the tier is
 * `Bearer public`):
 *   - a request with no tools at all             -> 403 FreeTierError
 *   - tools renamed (read_file instead of read)  -> 403 FreeTierError
 *   - tools named `read` + `shell` present       -> 200
 * The descriptions were not compared on that date, but upstream probed a 403 on
 * stubbed ones days earlier and the gate has moved three times in three days, so
 * the definitions below stay byte-exact. Caller tools are sent untouched, except
 * one that already uses an exact fingerprint name with a different definition: it
 * travels under an alias and the response side restores the caller's own name.
 */

/** Names required by the upstream free-tier gate. */
export const OPENCODE_FINGERPRINT_TOOLS = ["read", "shell"];

/**
 * Tool shapes a request body can carry. Upstream passes a `flat` boolean because its
 * only two cases are Responses and OpenAI chat; kRouter adds "claude" so a
 * Claude-shaped body (`/inference/v1/messages`) gets `input_schema`, not `parameters`.
 */
export const FINGERPRINT_SHAPES = Object.freeze(["responses", "chat", "claude"]);

// Verbatim from the OpenCode v2.0.26 CLI. Upstream may compare description and
// parameters, so do not reword or reformat these.
const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  shell: {
    description: "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
        timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
        background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

// Request body -> names renamed for that request. The executor records the map on the
// exact body object it returns as transformedBody, so a WeakMap keeps the mapping
// request-local without putting transport metadata on the wire.
const renamedToolNames = new WeakMap();

/** The fingerprint name when `name` is exactly one; "" otherwise. */
export function fingerprintToolKey(name) {
  const trimmed = String(name ?? "").trim();
  return OPENCODE_FINGERPRINT_TOOLS.includes(trimmed) ? trimmed : "";
}

/** Read a tool name from flat/claude ({name}) or chat ({function:{name}}) shape. */
function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    return fn.name.trim();
  }
  return "";
}

function chatFunctionOf(tool) {
  const fn = tool?.function;
  return fn && typeof fn === "object" && !Array.isArray(fn) ? fn : null;
}

/** True when `tool` already carries OpenCode's exact definition for `key`. */
function isFingerprintDefinition(tool, key, shape) {
  const def = tool && (chatFunctionOf(tool) || tool);
  const want = FINGERPRINT_TOOL_DEFINITIONS[key];
  const schema = shape === "claude" ? def?.input_schema : def?.parameters;
  return !!def && def.description === want.description
    && JSON.stringify(schema) === JSON.stringify(want.parameters);
}

function withToolName(tool, name) {
  const fn = chatFunctionOf(tool);
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
}

/**
 * Move caller tools off the fingerprint names when their definition differs
 * from OpenCode's, so the exact definitions can be appended without a
 * duplicate name. Everything else, including case variants such as `Read`, is
 * preserved verbatim; upstream accepts them alongside `read` (probed 200).
 *
 * @param {Array} tools
 * @param {"responses"|"chat"|"claude"} shape
 * @returns {{ tools: Array, map: Map<string,string> }} map: sent name -> original name
 */
export function concealFingerprintToolNames(tools, shape) {
  const map = new Map();
  if (!Array.isArray(tools) || tools.length === 0) return { tools, map };

  const taken = new Set(tools.map(toolNameOf));
  const seen = new Set();
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool);
      continue;
    }

    const key = fingerprintToolKey(toolNameOf(tool));
    if (!key) {
      out.push(tool);
      continue;
    }

    // Duplicate declarations of one name are rejected upstream; keep the first.
    if (seen.has(key)) continue;
    seen.add(key);

    if (isFingerprintDefinition(tool, key, shape)) {
      out.push(tool);
      continue;
    }

    let alias = `${key}_client`;
    for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`;
    taken.add(alias);
    map.set(alias, key);
    out.push(withToolName(tool, alias));
  }
  return { tools: out, map };
}

/**
 * Append OpenCode's definition for each fingerprint tool not already declared.
 *
 * @param {Array} tools
 * @param {"responses"|"chat"|"claude"} shape
 * @returns {string[]} names that were appended
 */
export function appendMissingFingerprintTools(tools, shape) {
  const appended = [];
  if (!Array.isArray(tools)) return appended;
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (tools.some((tool) => fingerprintToolKey(toolNameOf(tool)) === name)) continue;
    const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
    if (shape === "responses") tools.push({ type: "function", name, description, parameters, strict: false });
    else if (shape === "claude") tools.push({ name, description, input_schema: parameters });
    else tools.push({ type: "function", function: { name, description, parameters } });
    appended.push(name);
  }
  return appended;
}

/** Invert a sent -> original rename map. */
function aliasesByOriginal(map) {
  return new Map([...map].map(([alias, original]) => [original, alias]));
}

/** Point an explicit tool_choice at the alias of a concealed caller tool. */
export function retargetToolChoice(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
  const aliases = aliasesByOriginal(map);

  if (typeof choice.name === "string") {
    const alias = aliases.get(choice.name.trim());
    if (alias) body.tool_choice = { ...choice, name: alias };
    return;
  }

  const fn = choice.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    const alias = aliases.get(fn.name.trim());
    if (alias) body.tool_choice = { ...choice, function: { ...fn, name: alias } };
  }
}

/**
 * Rename prior-turn calls to concealed caller tools as well; otherwise the model
 * reads its own earlier calls as calls to OpenCode's tool of the same name.
 */
export function aliasHistoryToolCalls(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const aliases = aliasesByOriginal(map);

  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) =>
      item?.type === "function_call" && aliases.has(item.name)
        ? { ...item, name: aliases.get(item.name) }
        : item);
  }

  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((msg) => {
      // Claude history carries the call as a tool_use content block.
      if (Array.isArray(msg?.content)) {
        const content = msg.content.map((block) =>
          block?.type === "tool_use" && aliases.has(block.name)
            ? { ...block, name: aliases.get(block.name) }
            : block);
        msg = { ...msg, content };
      }
      if (!Array.isArray(msg?.tool_calls)) return msg;
      return {
        ...msg,
        tool_calls: msg.tool_calls.map((call) =>
          aliases.has(call?.function?.name)
            ? { ...call, function: { ...call.function, name: aliases.get(call.function.name) } }
            : call),
      };
    });
  }
}

// Without the old "must not be used" descriptions the model does call the
// appended tools (live probe: `read` on "what files are in /etc?"), so tell it
// in the system prompt instead. Upstream does not gate on the prompt text.
// Wording matters: "not available" made the model also refuse the caller's own
// Read/Bash; "placeholders ... use the other tools" kept those working.
function noteUnavailableTools(body, shape, names) {
  const list = names.map((name) => `\`${name}\``).join(" or ");
  const note = names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
  if (shape === "responses") {
    body.instructions = typeof body.instructions === "string" && body.instructions.trim()
      ? `${body.instructions}\n\n${note}`
      : note;
    return;
  }
  // A Claude-shaped body carries `system`, not a system message.
  if (shape === "claude" || body.system !== undefined) {
    if (Array.isArray(body.system)) body.system = [...body.system, { type: "text", text: note }];
    else if (typeof body.system === "string" && body.system.trim()) body.system = `${body.system}\n\n${note}`;
    else body.system = note;
    return;
  }
  if (!Array.isArray(body.messages)) return;
  const first = body.messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...body.messages.slice(1)];
  } else {
    body.messages = [{ role: "system", content: note }, ...body.messages];
  }
}

/**
 * Full request-side pass: alias conflicting caller tools, append OpenCode's
 * fingerprint definitions, and tell the model the appended ones are off-limits.
 *
 * Writes into `body` in place, like every other kRouter executor transform: the
 * object is chatCore's already-translated request, never the caller's own body, and
 * the pass is idempotent so base.js may re-run it on a strip retry.
 *
 * @param {object} body
 * @param {"responses"|"chat"|"claude"} shape - tool shape this endpoint accepts
 * @returns {Map<string,string>} map: sent name -> original name
 */
export function applyFingerprintTools(body, shape = "chat") {
  if (!body || typeof body !== "object") return new Map();

  const { tools, map } = concealFingerprintToolNames(body.tools, shape);
  body.tools = Array.isArray(tools) ? tools : [];
  const appended = appendMissingFingerprintTools(body.tools, shape);
  retargetToolChoice(body, map);
  aliasHistoryToolCalls(body, map);
  if (appended.length) noteUnavailableTools(body, shape, appended);

  // Responses keeps its explicit auto default. Never default to "none": upstream
  // answered tool_choice "none" with 403 FreeTierError while this gate was new.
  if (!body.tool_choice && shape === "responses") body.tool_choice = "auto";

  recordRenamedToolNames(body, map);
  return map;
}

/** Store the rename map for `body`. */
export function recordRenamedToolNames(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  renamedToolNames.set(body, map);
}

/** Retrieve the rename map for `body`. */
export function takeRenamedToolNames(body) {
  if (!body || typeof body !== "object") return null;
  return renamedToolNames.get(body) || null;
}

// Response side -------------------------------------------------------------

/** Restore caller tool spellings in supported response/event shapes. */
export function restoreToolNames(payload, map) {
  if (!map?.size || !payload) return payload;
  if (Array.isArray(payload)) return payload.map((item) => restoreToolNames(item, map));
  if (typeof payload !== "object") return payload;

  let out = payload;
  const put = (key, value) => {
    if (out === payload) out = { ...payload };
    out[key] = value;
  };

  // Claude streaming content_block_start event.
  if (payload.type === "content_block_start") {
    const block = payload.content_block;
    if (block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)) {
      put("content_block", { ...block, name: map.get(block.name) });
    }
  }

  // Claude non-streaming message body.
  if (Array.isArray(payload.content)) {
    put("content", payload.content.map((block) =>
      block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)
        ? { ...block, name: map.get(block.name) }
        : block));
  }

  // OpenAI Chat Completions, both streaming delta and JSON message shapes.
  if (Array.isArray(payload.choices)) {
    put("choices", payload.choices.map((choice) => {
      let changed = false;
      const next = { ...choice };
      for (const holder of ["delta", "message"]) {
        const value = choice?.[holder];
        if (!value || !Array.isArray(value.tool_calls) || value.tool_calls.length === 0) continue;
        const calls = value.tool_calls.map((call) => {
          const name = call?.function?.name;
          if (typeof name === "string" && map.has(name)) {
            changed = true;
            return { ...call, function: { ...call.function, name: map.get(name) } };
          }
          return call;
        });
        next[holder] = { ...value, tool_calls: calls };
      }
      return changed ? next : choice;
    }));
  }

  // OpenAI Responses final JSON body.
  if (Array.isArray(payload.output)) {
    put("output", payload.output.map((item) =>
      item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)
        ? { ...item, name: map.get(item.name) }
        : item));
  }

  // OpenAI Responses SSE events such as response.output_item.added/done.
  const item = payload.item;
  if (item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)) {
    put("item", { ...item, name: map.get(item.name) });
  }

  return out;
}

/** Rewrite one SSE line's JSON payload; anything else is returned unchanged. */
function restoreToolNamesInSSELine(line, map) {
  if (!line.startsWith("data:")) return line;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return line;
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return line;
  }
  const restored = restoreToolNames(parsed, map);
  return restored === parsed ? line : `data: ${JSON.stringify(restored)}`;
}

/**
 * Put the caller's own tool names back into an upstream SSE response.
 *
 * Upstream restores late, in translateResponse() and the JSON handlers. kRouter
 * cannot: when the client and the upstream share a format — an OpenAI client on
 * OpenCode Free, which is the common case — streamingHandler picks
 * createPassthroughStreamWithLogger and no translator ever sees the chunk. Restoring
 * here, before anything downstream reads the stream, covers every client format and
 * both the streaming and the re-aggregated JSON paths with one pass. The cost is that
 * the provider-response log shows the restored name rather than the alias; the
 * request log still shows exactly what was sent.
 *
 * A response with nothing to rename is returned untouched, so a request that did not
 * collide with the fingerprint pays nothing.
 */
export function restoreToolNamesInResponse(response, map) {
  if (!map?.size || !response?.body) return response;

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const encoder = new TextEncoder();
  let buffer = "";

  const rewrite = (text) => text.split("\n").map((line) => restoreToolNamesInSSELine(line, map)).join("\n");

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      // Only hand on whole lines: a tool name can straddle two network chunks.
      const cut = buffer.lastIndexOf("\n");
      if (cut === -1) return;
      const ready = buffer.slice(0, cut + 1);
      buffer = buffer.slice(cut + 1);
      controller.enqueue(encoder.encode(rewrite(ready)));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
    },
  });

  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
