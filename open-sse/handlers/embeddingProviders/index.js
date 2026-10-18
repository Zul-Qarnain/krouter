// Embeddings provider adapter registry
import createOpenAIEmbeddingAdapter from "./openai.js";
import gemini from "./gemini.js";
// 0.5.165 — Copilot embeddings need the editor headers a bare bearer adapter
// does not send, so github gets its own adapter. (upstream 51a1827e)
import github from "./github.js";
import openaiCompatNode from "./openaiCompatNode.js";

const OPENAI_COMPAT_PROVIDERS = [
  "openai", "openrouter", "mistral", "voyage-ai", "fireworks",
  "together", "nebius", "nvidia", "jina-ai",
  "vercel-ai-gateway",
];

const ADAPTERS = {
  ...Object.fromEntries(OPENAI_COMPAT_PROVIDERS.map((id) => [id, createOpenAIEmbeddingAdapter(id)])),
  gemini,
  google_ai_studio: gemini,
  github,
};

export function getEmbeddingAdapter(provider) {
  if (ADAPTERS[provider]) return ADAPTERS[provider];
  if (provider?.startsWith?.("openai-compatible-") || provider?.startsWith?.("custom-embedding-")) {
    return openaiCompatNode;
  }
  return null;
}
