// GitHub Copilot embeddings — api.githubcopilot.com/embeddings with the
// short-lived Copilot token and the editor headers Copilot requires.
//
// 0.5.165 — the GitHub Models inference API (models.github.ai) was retired on
// 2026-07-30. It still resolves, which is what made the old endpoint so quietly
// broken: every POST answers `200 text/plain "OK"`, so embeddingsCore turned a
// working connection into "Invalid JSON response from github" rather than an
// auth error. (upstream 51a1827e)
import createOpenAIEmbeddingAdapter from "./openai.js";
import { GITHUB_COPILOT } from "../../config/appConstants.js";

const baseAdapter = createOpenAIEmbeddingAdapter("github");

export default {
  ...baseAdapter,
  buildHeaders: (creds) => ({
    "Content-Type": "application/json",
    // Same precedence as the chat executor (executors/github.js): the Copilot
    // token when one has been minted, else the GitHub OAuth token.
    "Authorization": `Bearer ${creds?.copilotToken || creds?.providerSpecificData?.copilotToken || creds?.accessToken}`,
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${GITHUB_COPILOT.VSCODE_VERSION}`,
    "editor-plugin-version": `copilot-chat/${GITHUB_COPILOT.COPILOT_CHAT_VERSION}`,
    "user-agent": GITHUB_COPILOT.USER_AGENT,
    "x-github-api-version": GITHUB_COPILOT.API_VERSION,
  }),
};
