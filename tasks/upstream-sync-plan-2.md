# kRouter <- decolua/9router upstream-sync plan 2

Assessed: upstream **v0.5.50 -> 87a74e1b (upstream v0.5.104, 2026-10-15)** against kRouter **v0.5.164**.
Date: 2026-10-16. Read-only assessment; nothing was checked out, merged or cherry-picked.

The previous plan (`tasks/upstream-sync-plan.md`) covered upstream v0.5.45 -> v0.5.50. Those ports shipped as
kRouter v0.5.120-0.5.124. kRouter's own triage in v0.5.125-0.5.164 already took a large share of this range.
That is why 58 rows below are already-have.

## Scope and counts

- 7 slices, about 367 upstream commits (2026-08-05 .. 2026-10-15), triaged into **305 rows**. Some commits
  are split into two rows: f4f06f29, e0ffc7e2, 9f41ee75, ab044e6d, c933eefc and 910db749.
- Caveat: the RTK hook rewrites `git log` and caps it at 50 lines. Two slices were silently truncated
  (2026-09-05 lost 13 commits, 2026-10-01 showed 51 of 83). Both were re-read with `/usr/bin/git`. Use
  `rtk proxy git ...` or `/usr/bin/git` for any future range review.

| Status | Rows |
|---|---|
| needed | 176 |
| already-have | 58 |
| not-applicable | 60 |
| fixed-differently | 7 |
| unclear (needs a live probe) | 4 |

| Category | Rows |
|---|---|
| bugfix | 115 |
| provider | 51 |
| feature | 45 |
| ui | 34 |
| catalog | 26 |
| docs | 9 |
| security | 8 |
| perf | 7 |
| other | 4 |
| tests | 4 |
| refactor | 1 |
| ci | 1 |

Many "needed" rows are later steps of the same upstream work. After merging those across slices
(see "Merged chains" below), the port work comes to **about 75 port items in Phases 1-3** plus an optional
Phase 4 feature list.

### Corrections from the lead spot-check

Every high-value needed item and every security item was re-checked against the upstream diff and kRouter
code. The classifications held, with these corrections:

1. **MiMo Free is dead, and upstream said so first.** Upstream `6d96e24b` (2026-07-29) set
   `hidden: true` on `mimo-free` with the comment "Xiaomi ended the free MiMo channel ('MiMo free API service
   has ended')". kRouter skipped that commit in the v0.5.50 sync as "registry-file tuning". The slice notes
   that say "upstream has not declared it dead" are wrong. kRouter still enables the vision pool by
   default (`src/lib/db/repos/settingsRepo.js:24`) with `mmf/mimo-auto` as its implicit model
   (`open-sse/services/capacityAdapter.js:22`). As a result, every image request to a combo with no
   vision-capable member puts a dead model first. This is a Phase 2 fix (batch `p2-mimo`); it cannot wait for
   the OpenCode Free port.
2. **cfd8c618 (Cursor strict-proxy guard) is only partly covered.** kRouter forces fetch instead of
   direct h2 when a proxy resolves (`open-sse/executors/cursor.js:234`). It does not cover upstream 24664f2c's
   case: a strict pool that is inactive or has no URL. There `connectionProxyEnabled` is false, so Cursor opens a
   direct h2 socket. That fix belongs in `p1-proxy-strict`.
3. **New fail-open on the proxy error path.** `src/lib/network/connectionProxy.js:174-185` returns
   `strictProxy: false` whenever the pool lookup throws. Upstream has the same code. The fix here is
   kRouter's own: fail closed when a `proxyPoolId` was set.
4. **The Codex usage_limit_reached / TPM concern.** Upstream has no TPM downgrade at all, so it has no
   fix to port. kRouter's gate (`src/sse/services/auth.js:503`) checks the error text and the quota cache,
   but never checks the `resetsAtMs` that `codex.js:358-379` parses. Codex's standard message ("The usage limit
   has been reached") does not match `looksLikeQuotaError`, so the downgrade probably does not fire today. Any
   429 that says "rate limit" and also carries a precise reset would still be cut to 90 s. A one-line
   `!resetsAtMs` guard closes it (batch `p2-errors`).
5. **Codex catalog is fully stale.** Upstream's live Codex list (`upstream/master
   open-sse/providers/registry/codex.js:55-86`) shares no chat id with kRouter's `cx` list
   (`open-sse/config/providerModels.js:57-71`). gpt-5.5, the cx default, was retired for ChatGPT sign-in
   on 2026-10-14 (7878f53b). This is the most urgent Phase 3 item; run a live probe first.

### Merged chains (port the end state, never the intermediate commit)

| Chain | Commits | Port as |
|---|---|---|
| OpenCode Free revival | 67271d85, 6091ff59, 0c6ab4f9, 2b65c49f, aa14ef72, eafac37d, 93837af0, 058ceace, 822aa958, ef4679df (superseded), 5bdcd5e7, e964e482, ab044e6d (executor half), acb5c34c | upstream/master `opencode.js` + `opencodeFingerprint.js`, adapted (`p3-opencode-free`) |
| Capacity-adapter default | 6886915f, 1a027131, 41a1b800, 3e4323e2 | interim fix in `p2-mimo`, final switch in `p3-opencode-free` |
| Responses `response.completed` | da004655, 273f0c32, 7111db35, fbcaa282 | one change (`p2-stream-out`) |
| Responses request translator | ab044e6d (translator half), e74db4d0, 11222eff (hardening) | `p2-openai-wire` |
| Codex catalog + transport | ed963931, 832a3465, eb712ca8, a7047a07, 95600db1, 7bf93178, 92c7bdd5, 9f41ee75 (catalog half), 8f9ff44f, efc80ba2, ca6e8407, dec820b9, 7878f53b | `p3-catalog` + `p3-codex-wire` |
| Antigravity catalog | 783e271c (pre-range, never ported), 86694ed8, d91e8b85, 70f15aa5, 24034f69, a07ed95b, cff2b1d9, 29fc880e/eb373017/9c141910 (Argon) | `p3-catalog` + `p3-ag-wire` |
| Antigravity prompt rewrites | f6422953 (superseded), b3d6e089, a61fc6a0 | final regex from a61fc6a0 (`p2-gemini-ag`) |
| Gemini contents normalizer | 8d1db46b (pre-range base, never ported), e7b5f09d, 30464bc2 | one normalizer (`p2-gemini-ag`) |
| CodeBuddy-CN catalog | e014cb53, cec672d9, 807553e2, 63de82b8, e706e4f2 | net 2026-09-30 server state (`p3-catalog`, `p3-execs`) |
| Claude CLI version | 009cac63 (have, 2.1.258), 84035760, cbffeb97 (2.1.280) | `p2-claude-wire` |
| Qoder | 80afb599, 2daf25ff, 782c137b, 2ab6a4c9, 1f10f9e5 (Qoder-local half only) | `p3-qoder` |
| Net no-ops upstream | 2aa9307f + 6ed88685 (per-key quotas reverted), 40dffbce + accf2c52 (qwen add/remove), e214fb1c fallback row (reverted by 4ad1e7a4), 1f10f9e5 shared plumbing (reverted by 248d7da0), 2ab6a4c9 Dockerfile mirror hunk (reverted by c7df895b/f67d5a0c) | never port the reverted parts |

## How to run this plan

- Batches **within a phase touch disjoint files** and can run in parallel, one agent or worktree each.
- **Phases run in order.** A later phase may touch a file an earlier phase changed. Rebase onto the merged earlier
  phase.
- Phase 3 has one data owner, `p3-catalog`. It is the only batch that edits the catalog files
  (`providerModels.js`, both `providers.js`, `capabilities.js`, `pricing.js`, `cliTools.js`, `config.js`,
  `src/mitm/config.js`, `src/lib/qoder/constants.js`). Land it first. The other Phase 3 batches list the
  catalog lines they need as `p3-catalog` items.
- Every batch: tests first (adapt upstream's test file when one exists), then the full suite, then the live
  before/after curl named in the item. The user requires terminal proof, not only unit tests.
- Keep kRouter rules: copy-on-write (never mutate a client body or a shared credentials object), keep the
  two alias maps in agreement, keep both token-refresh paths, never `npm publish` from the Mac (one tag
  ships everything from CI).

---

## Phase 1 - Security and credential / data-loss fixes

Three batches with disjoint files. Ship Phase 1 as its own tagged release.

### Batch `p1-proxy-strict` - strict proxy must never leave over the real IP

Files: `open-sse/utils/proxyFetch.js`, `src/lib/network/connectionProxy.js`, `open-sse/executors/cursor.js`,
`src/app/api/proxy-pools/vercel-deploy/route.js`, `tests/unit/strict-proxy-enforcement.test.js` (new).

- **24664f2c - hold strictProxy when no proxy resolves** (risk low)
  - Fixes: an inactive or empty strict pool makes `resolveConnectionProxyConfig` fall through to legacy/none
    (`connectionProxy.js:91-153`) with no `strictProxy`. `proxyAwareFetch` then goes direct
    (`proxyFetch.js:415-420`). Result: the user's real IP reaches the provider while strict mode is on.
  - Change: carry the pool's `strictProxy` and `proxyPoolId` through the non-pool returns. In
    `proxyAwareFetch`, throw when `strictProxy && proxyIntended` and nothing resolved. `proxyIntended` is
    `proxyPoolId || enabled || connectionProxyEnabled || url`.
  - Adapt: keep the "proxy intended" gate exactly. Qoder uses `strictProxy` to mean "never replay directly",
    and with no proxy configured it must keep working.
  - Test: port upstream `tests/unit/strict-proxy-enforcement.test.js`. Add a case for an inactive pool,
    a pool with no URL, and a strict Qoder call with no proxy, which must not throw.
- **kRouter-own - Cursor h2 path under a strict pool** (risk low)
  - Fixes: `cursor.js:234` only forces fetch when a proxy is enabled. An unresolved strict pool opens a direct h2
    socket and leaks the IP, the exact case cfd8c618 guards upstream.
  - Change: force the fetch path, or refuse, when `proxyOptions.strictProxy && proxyIntended`.
- **kRouter-own - fail closed when the pool lookup throws** (risk low)
  - Change: `connectionProxy.js` catch block. When `connection.proxyPoolId` was set, return
    `strictProxy: true, proxyPoolId` so the request fails instead of going direct.
- **6af26a9e - relay pools keep Headers-instance headers** (risk low; correctness, same file)
  - Fixes: `{ ...options.headers }` on a `Headers` instance produces `{}`, so Vercel/CF/Deno relays drop
    Authorization and Content-Type (`proxyFetch.js:323-324`, `:364-369`). The deployed Vercel relay uses
    `new Headers(req.headers)` (`vercel-deploy/route.js:23`).
  - Change: add one `toPlainHeaders()` helper (the pattern already exists at `proxyFetch.js:85-88`) and use it at
    both spread sites. The relay template copies `req.headers.entries()` into a plain object.
  - Note: users must redeploy the relay for the template half to take effect. Say so in the CHANGELOG.
- Live proof: set a strict pool inactive. Before the fix, a request leaves directly (check the provider-side IP or
  connection logs). After it, the request fails with "Proxy required but none resolved".

### Batch `p1-connections` - stop silent credential overwrite, clear stale locks on re-login

Files: `src/lib/db/repos/connectionsRepo.js`, `src/app/api/providers/route.js`, plus caller audit in
`src/app/api/import/route.js`, `src/app/api/oauth/kiro/api-key/route.js`, `src/app/api/oauth/gitlab/pat/route.js`,
tests.

- **239bcfc5 + 57c04f00 - refuse API-key overwrite on name collision** (risk medium)
  - Fixes: `connectionsRepo.js:109-118` finds an apikey row by `name` and upserts `{ ...existing, ...data }`.
    Adding a second key with the same display name silently replaces the stored key (credential loss). Every
    insert also loads the whole pool and renumbers it (`:97`, `:149` `reorderInTx`), which is O(pool) per key
    on bulk import.
  - Change: throw `PROVIDER_NAME_CONFLICT`, mapped to 409 in `providers/route.js:210`, unless `allowOverwrite`
    or an explicit `id` is passed. Insert at `MAX(priority)+1` without renumbering. Dedup apikey rows by name
    with a targeted query.
  - Adapt: audit every `createProviderConnection` caller. There are 16; the apikey ones are
    `providers/route.js:210`, `import/route.js:73`, `oauth/kiro/api-key/route.js:35` and
    `oauth/gitlab/pat/route.js:39`. Pass `allowOverwrite` only where replacing is intended (backup import).
    The dashboard must show the 409 as "a key with this name exists".
  - Test: rewrite upstream's tests with a temp `DATA_DIR`. 57c04f00 deleted them upstream because they wrote
    to the real user DB.
- **7fee56ba - clear stale health state when a connection is re-activated** (risk low)
  - Fixes: OAuth re-login and imports pass `testStatus: "active"` but merge through `{ ...existing, ...data }`
    (`connectionsRepo.js:115`, `:164`). The connection keeps `modelLock_*`, `backoffLevel`, `rateLimitedUntil`
    and `errorCode`, so a freshly re-logged account stays skipped. Only Test Connection clears locks today
    (`testUtils.js:725-739`).
  - Change: in create/update, when the incoming `testStatus` is `active`, drop every `modelLock_*` and reset
    `backoffLevel`, `rateLimitedUntil` and `errorCode`.
  - Adapt: keep `isPermanentlyBanned`/`bannedAt` handling and the v0.5.164 spend-cap lock semantics.
  - Test: create a connection with locks, re-login it, and assert the locks are gone and the spend-cap lock is kept.

### Batch `p1-oauth-refresh` - Codex refresh-token reuse logs accounts out

Files: `open-sse/config/appConstants.js` (`REFRESH_LEAD_MS` only), `src/app/api/usage/[connectionId]/route.js`,
`src/sse/services/tokenRefresh.js`, `src/shared/services/quotaAutoPing.js`, `src/shared/services/tokenWarmer.js`,
tests.

- **0bc7f86e - stop refresh-token reuse** (risk medium)
  - Fixes: OpenAI rotates the Codex refresh token on every refresh and revokes the whole session when an old one
    is reused. kRouter's lead is 5 days (`appConstants.js:176`). Three writers each refresh from a stale
    snapshot: the usage poll (`usage/[connectionId]/route.js:158/175/219`), auto-ping
    (`quotaAutoPing.js:165`) and the warmer (`tokenWarmer.js:105`). `checkAndRefreshToken` only adopts a
    newer DB token if it outlives the lead (`tokenRefresh.js:245`), which never happens with a 5-day lead.
    `refreshAndUpdateCredentials` keeps going with a dead token on failure (`route.js:52-56`).
  - Change: set the lead to about 10 min. `refreshAndUpdateCredentials` re-reads the row from the DB just before
    refreshing and throws on an unrecoverable refresh. `checkAndRefreshToken` adopts any newer, unexpired DB token.
  - Adapt: first decode `exp` from a live Codex access token. If it is still about 10 days (kRouter chose 5 days
    for a reason), pick a lead well below the real lifetime instead of copying 10 min. Make the two callers
    handle the new throw. Copy credentials; never mutate them.
  - Test: simulate two concurrent refreshers with one stale snapshot and assert one network refresh and no
    reuse. Live: enable Codex auto-ping on a test account and confirm it is still logged in after a reset window.
- **1442cc73 - lazy Antigravity / Gemini-CLI projectId re-onboarding** (risk low; same file)
  - Fixes: `_refreshProjectId` calls `onboardUser` after every token refresh (`tokenRefresh.js:129-151`,
    called at `:307`). Several accounts refreshing together trip Google's anti-abuse limiter.
  - Change: resolve the projectId lazily, only when it is missing; keep an opt-in env flag for the eager path.
    Confirm first that the chat path resolves a missing projectId on demand.

### Phase 1 - do not port

- **b58bd804 - auto-retry with TLS verification disabled on certificate errors.** It is on by default and only
  logs a `console.warn`. A network attacker presenting a bad certificate would receive provider Bearer
  tokens, OAuth refresh tokens and prompts. Acceptable only as explicit opt-in (for example
  `ALLOW_INSECURE_TLS=1`); do not take upstream's default.

### Phase 1 - security items verified already-have

8a527fec (SSRF on /v1/search, default-password remote login, request-details redaction; v0.5.136), 92259214
(peer-token real-IP, GHSA-pjm4-8fpg-f9p6; v0.5.135), b870b5d4 (SSRF guard bypasses; v0.5.149), 97f3ab97
(cowork probe SSRF; v0.5.149), 98579f98 (root rewrite guard; fixed differently via `/codex`, v0.5.149, invariant
test). cfd8c618 is covered only partly; see `p1-proxy-strict`.

---

## Phase 2 - Correctness bug fixes users hit

13 batches with disjoint files.

### Batch `p2-claude-wire` - Claude requests that Anthropic rejects

Files: `open-sse/config/providers.js` (Claude spoof-header block only), `open-sse/utils/claudeCloaking.js`,
`open-sse/translator/helpers/claudeHelper.js`, `open-sse/translator/request/openai-to-claude.js`,
`open-sse/executors/default.js`, tests.

- **84035760 + cbffeb97 - claude-cli 2.1.258 -> 2.1.280** (risk low, value high)
  - Fixes: Anthropic answers Opus 5.5 requests from claude-cli below 2.1.280 with 400 `claude_code_version_too_old`.
    kRouter added Opus 5.5 in v0.5.164 but still sends 2.1.258 (`providers.js:55`, `claudeCloaking.js:7`).
    The default executor does not forward the client UA, so real Claude Code clients look like 2.1.258 too.
  - Change: put the version in one exported constant used by both places.
  - Test: live curl to `cc/claude-opus-5-5`, expect 400 before and 200 after. Run the cloaking and header tests.
- **49ba54b2 + a07ed95b - Opus/Sonnet 5.5 thinking and tool_choice restrictions** (risk low, value high)
  - Fixes: Sonnet 5.5 rejects `thinking: {type:"disabled"}` and needs `between_tools` with effort at most high.
    Sonnet 5.5 and Opus 5.5 reject forced `tool_choice` any/tool. kRouter maps OpenAI `required` to `any`
    (`openai-to-claude.js:305`). The provider-level "off" injects `disabled` (`chatCore.js:87-88`). OpenAI clients
    on these models 400 today; LangChain structured output is the common trigger.
  - Change: add the rewrite in `prepareClaudeRequest` (claudeHelper) so native, translated and "off" bodies are all
    covered. `disabled` becomes `between_tools` on Sonnet 5.5 and is dropped on Opus 5.5 and Fable. Forced
    `tool_choice` becomes `auto`, keeping `disable_parallel_tool_use`. Key the rule on the existing
    `thinkingCanDisable:false` caps flag.
  - Test: unit tests for each model id; live curl with `tool_choice:"required"` to `cc/claude-sonnet-5-5`.
- **8a81085a, 4f274c7f, 75834e96 + 5e9bd464, c8644368 - message-shape cleanups** (risk low)
  - 8a81085a: a turn whose `content` is a single block object is dropped (`claudeHelper.js:8-22`, filtered at
    `:251`); wrap it as a one-block array. Also cap `cache_control` at 4 markers: `:314-327` re-anchors the
    tool marker even in `preserveCacheControl` mode, so a client already at 4 reaches 5 and gets a
    non-retryable 400.
  - 4f274c7f: `hasValidContent` drops a `container_upload`-only user turn and forwards `messages: []`.
  - 75834e96 + 5e9bd464: when cleanup empties the final user turn, append `Continue.`, but only if the client
    itself did not end on assistant, so real prefill is kept.
  - c8644368: strip `context_management` unless the provider is `claude` or `anthropic-compatible-*`. Drop
    thinking blocks with no visible text in both passthrough (`:174-185`) and prepare (`:286-300`).
  - Test: port upstream unit cases. Add a golden test for each shape.
- **b65d2d0a + b54a3f9b - decloak `_ide` tool names without a toolNameMap** (risk low)
  - Fixes: `claudeCloaking.js:87` and `:149` return early when the map is empty. A retried or reconnected
    stream then hands the client `<tool>_ide` names it cannot resolve.
  - Change: fall back to stripping `CLAUDE_TOOL_SUFFIX`, never for the CC decoy names.
- **6aea3875 - x-claude-code-session-id matching metadata.user_id** (risk low)
  - Change: in the claude branch of `default.js:99-112`, derive the header per request from `body.metadata.user_id`
    (JSON or legacy string, with the `claude:` prefix stripped) when it is missing.
  - Adapt: it is derived per request from the body, so it does not bring back the v0.5.123 cross-account leak.
- **90b06934 - ask for summarized thinking for OpenAI-format clients** (risk low)
  - Change: in `openai-to-claude.js:185-197`, set `thinking.display = "summarized"` when the client asked for
    reasoning.
  - Adapt: verify live first that current Claude models omit thinking text without it.
- **ac9120fd - Fable / Opus 5.5 effort shape (unclear, probe first)** (risk medium)
  - Probe: does `{type:"enabled", budget_tokens}` (`openai-to-claude.js:185-198`) 400 or get ignored on
    `claude-fable-5-1` and `claude-opus-5-5`? If it does, models with `thinkingCanDisable===false` get
    `output_config.effort`, no `thinking`, and never `disabled`.
- **Optional, perf, measure before and after:**
  - 49c761cd: put the 4th breakpoint on a tool loop's final `tool_result` turn.
  - 7e5f5a88: fold mid-conversation system messages in place for API-key `anthropic` and
    `anthropic-compatible-*` passthrough (`claudeHelper.js:103-133`). Respect the 4-marker budget and
    v0.5.150 `defer_loading`. Report `cache_read` before and after against a real node.

### Batch `p2-core` - request plumbing in chatCore and the SSE handlers

Files: `open-sse/handlers/chatCore.js`, `src/sse/handlers/chat.js`, `src/sse/handlers/embeddings.js`,
`src/sse/handlers/fetch.js`, `open-sse/utils/toolDeduper.js`, `open-sse/translator/helpers/toolCallHelper.js`, tests.

- **aba4c45d (pre-range) - credentials.rawHeaders** (risk medium)
  - Fixes: three readers that exist but never receive data, because kRouter never assigns `rawHeaders`:
    - the OpenCode Go native-session pass-through (`opencode-go.js:201`, the known dead-code issue);
    - the Cursor UA check (`cursor.js:149`);
    - the Kiro `anthropic-beta interleaved-thinking` budget (`openai-to-kiro.js:544` -> `kiroConstants.js:152`).
    Upstream sets it at `chatCore.js:179`.
  - Change: attach a **whitelisted** header subset to a per-request **copy** of credentials before the executor
    call. The subset is `user-agent`, `anthropic-beta`, `x-opencode-*` and `x-claude-code-session-id`.
  - Adapt: never copy `authorization`, `x-api-key` or `cookie`, which hold the kRouter key. Never mutate the
    shared credentials object (the v0.5.123 cross-account header-leak fix).
  - Test: an opencode-go request with `x-opencode-session` keeps that session upstream. A Kiro request with the
    beta header gets the thinking budget. Assert that no Authorization header reaches `credentials.rawHeaders`.
- **998bb3d9 - scope the `tools[].type = "custom"` default** (risk low)
  - Fixes: kRouter's v0.5.153 port of e08ac6da sets the type on every Claude-format request
    (`chatCore.js:214-217`). DeepSeek `/anthropic`, and other strict gateways behind `anthropic-compatible-*`, then
    answer 400 `unknown variant custom`.
  - Change: apply it only for a `CLAUDE_TOOL_TYPE_REQUIRED` set (`minimax`, `minimax-cn`), passing the provider into
    `defaultClaudeToolType` (`toolCallHelper.js:175-182`). Keep the MiniMax 2013 case working.
- **7f5bd155 - dedupe same-name tools for DeepSeek models** (risk low)
  - Change: `dedupeTools({ clientTool, model })`. Claude clients keep the MCP rule. Any provider serving
    `deepseek-*` drops later duplicates by exact name (first wins). Call it at `chatCore.js:180` for those models too.
  - Test: port `tool-deduper.test.js`. Skip upstream's `*.real.test.js`, which hit the live network.
- **c933eefc (RTK half) - compress tool results before translation for Cursor** (risk low)
  - Change: for `provider === "cursor"`, run `compressMessages` on the source body before translation and skip the
    post-translate pass (`chatCore.js:235`). Respect the token-saver bypass (`:225-230`).
- **15687d19 - 503 when every credential is rate-limited** (risk low)
  - Fixes: `chat.js:346` returns the last upstream status, which can be a stale 401/400. Claude Code then treats a
    cooldown as an auth failure.
  - Change: always 503 with retry-after. Fix the same pattern in `embeddings.js:104-106` and `fetch.js:169`. Note
    that `combo.js:403` waits up to 5 s on a 503.
  - Docker half (node-machine-id COPY): only after a `docker build` shows it missing. Today it degrades to a
    salt-only fallback (`src/mitm/manager.js:160`).
- **e0ffc7e2 (lock half) - scope web-fetch failure locks to `webfetch:<provider>`** (risk low)
  - Fixes: `fetch.js:165/203/213` lock the whole account. tavily and exa share one connection for search and fetch,
    so one failed fetch blocks `/v1/search`.
  - Change: mirror the v0.5.153 search change (`search.js:159`). Test that a failed tavily fetch leaves search usable.

**kRouter-own addition (found 2026-10-16 by the blog fact-checkers; prove before fixing):**
- `open-sse/utils/clientDetector.js` (extra file for this batch): `NATIVE_PAIRS.codex` includes `"openai"`, so a Codex CLI request
  (a Responses API body) routed to the `openai` provider is passed through untranslated and may be posted to OpenAI's Chat Completions
  URL. Check what URL the openai executor uses for a passthrough Responses body; if it would fail, either drop "openai" from the codex
  pair or send the passthrough to /v1/responses. Test with a mocked fetch that records the URL and body.

### Batch `p2-stream-out` - what clients receive (Responses and Claude-to-OpenAI)

Files: `open-sse/translator/response/claude-to-openai.js`, `open-sse/translator/response/openai-responses.js`,
`open-sse/translator/response/openai-to-claude.js`, `open-sse/transformer/responsesTransformer.js`,
`open-sse/utils/stream.js`, `open-sse/handlers/chatCore/nonStreamingHandler.js`,
`open-sse/handlers/chatCore/sseToJsonHandler.js`, golden snapshots.

- **5d2cfbf3 - no literal `<think></think>` in OpenAI content** (risk medium, value high)
  - Fixes: `claude-to-openai.js:47` and `:98` push `<think>` / `</think>` into `delta.content` on every Claude
    thinking block. Thinking cannot be turned off on Opus/Sonnet 5.5, so OpenAI clients see the markers on
    every turn.
  - Change: thinking travels only in `reasoning_content`. Both Responses translators
    (`openai-responses.js:66-84`, `responsesTransformer.js:308-321`) must close the reasoning item when text or
    tool_calls start, because they rely on `</think>` today. **Ship both halves in one commit.**
- **da004655 + 273f0c32 + 7111db35 + fbcaa282 - a real `response.completed`** (risk medium, value high)
  - Fixes: `sendCompleted` (`openai-responses.js:324-339`, and the same at `responsesTransformer.js:225-237`)
    emits no `output` and no `usage`. The early return at `:17` drops the usage-only trailer chunk. Codex CLI
    never sees token usage and cannot auto-compact. GitHub Copilot CLI and the OpenAI SDK final-response
    helpers treat the turn as empty.
  - Change:
    - capture usage before the empty-choices guard into `state.responsesUsage`, leaving `state.usage` for
      billing (`stream.js finalizeStream` depends on it);
    - repeat every `output_item.done` item, ordered by `output_index`, in `response.completed.response.output`;
    - on the direct openai -> openai-responses route, defer `response.completed` until the usage trailer
      arrives, ignore zeroed placeholder usage, and flush at `[DONE]` or after a 3 s watchdog;
    - thread `targetFormat` into the `createSSEStream` state so a pivoted route (claude -> openai -> responses)
      does not wait forever.
  - Test: port upstream's responses-completed tests. Live: Codex CLI against a chat provider shows a non-zero
    context gauge.
- **0f488c70 - Claude `refusal` becomes `content_filter`** (risk low)
  - Fixes: `claude-to-openai.js:194-201` maps `refusal` to `stop`, so clients get an empty "success".
    `openai-to-claude.js:259-266` has no `content_filter` case. The non-streaming path
    (`nonStreamingHandler.js:156-158`) maps only `end_turn` and `tool_use`, so `refusal` and `max_tokens` leak out
    as raw, non-OpenAI values.
  - Change: map `refusal` to `content_filter` in both directions and surface `stop_details.explanation`. In
    `nonStreamingHandler.js`, map `max_tokens` to `length` and `refusal` to `content_filter`. Streaming and
    non-streaming must agree (memory: krouter-claude-nonstreaming-gap).
- **1d4335d4 - forced SSE-to-JSON returns a Claude message to Claude clients** (risk low)
  - Fixes: `sseToJsonHandler.js:214-236`, the Responses-provider branch, still builds `chat.completion` (`:230`) for a
    `CLAUDE` source. The chat branch was fixed in v0.5.163.
- **782c137b (generic half) - keep the upstream 4xx/5xx in forced SSE-to-JSON** (risk low)
  - Change: `sseToJsonHandler.js:252-253` returns 502 for everything. Return `parsed.error.status` when it is 400-599.
- **122f23ee (envelope half) - unwrap Cline `{success, data}`** (risk low)
  - Change: for `cline` and `clinepass` only, unwrap before usage extraction and translation in
    `nonStreamingHandler.js`. This fixes the dashboard "no completion choices" model test.

### Batch `p2-stream-abort` - report aborts after HTTP 200 in-band

Files: `open-sse/handlers/chatCore/streamingHandler.js`, `open-sse/utils/streamHandler.js`,
`open-sse/utils/streamHelpers.js`, `open-sse/utils/responsesStreamHelpers.js`, tests.

- **93001213** (risk medium, value high)
  - Fixes: only Responses passthrough gets a terminal frame (`streamingHandler.js:52-53`). A stall or a lost
    upstream on any other format closes silently, so a truncated reply looks finished.
  - Change: pass the abort reason into a `buildStreamErrorBytes`. OpenAI clients get `data:{error}` then
    `[DONE]`; Claude clients get `event: error`. Never send a fake `finish_reason`.
  - Adapt: with a non-null `onAbortTerminal`, `streamHandler.js:156` turns non-network errors into a graceful
    close plus an error frame. Check the Claude Code and openai-python behaviour live.
  - Unblocks: the Command Code mid-stream throw in `p3-execs` (092c84ea).

### Batch `p2-gemini-ag` - Gemini / Antigravity request shape

Files: `open-sse/executors/antigravity.js`, `open-sse/translator/request/openai-to-gemini.js`,
`open-sse/translator/helpers/geminiHelper.js`, `open-sse/config/appConstants.js` (`ANTIGRAVITY_PROMPT_REWRITES` only),
tests.

- **5798b308 - stop sending `requestType: "agent"`** (risk medium, value high)
  - Fixes: Google buckets `agent` requests and answers 429 RESOURCE_EXHAUSTED with no detail, even with quota
    left. kRouter sets it at `antigravity.js:285`, `openai-to-gemini.js:289` and `:327`. Upstream head deletes it
    (`upstream/master antigravity.js:331-337`).
  - Adapt: keep `requestType: "image_gen"` (`:142`). Leave the requestId seed input untouched. Check how this
    interacts with `antigravity429Engine` and the MITM path.
  - Live: an AG account that gets spurious 429s today.
- **b3d6e089 + a61fc6a0 - two more Antigravity prompt rewrites** (risk low)
  - Change: add the final a61fc6a0 rules to `appConstants.js:167-170`. One strips the `x-anthropic-billing-header:`
    line; the other replaces every "You are Hermes (Agent) ... Nous Research." variant. These supersede f6422953.
- **8d1db46b + e7b5f09d + 30464bc2 - one `normalizeGeminiContents`** (risk medium, value high)
  - Fixes three things:
    - an intermediate tool call whose result is `""` gets no `functionResponse`, because
      `openai-to-gemini.js:146` and `:151` treat `""` as missing;
    - Antigravity thought-stripping can leave `parts: []` and adjacent same-role turns (`antigravity.js:159-175`);
    - a body that ends on a model turn or an unanswered call gets a 400.
  - Change: emit a response for every intermediate call (empty allowed). Merge adjacent same-role turns, drop
    empty parts and empty contents, force a leading user turn, and append `Continue.` (as a `functionResponse`
    for unanswered calls) after a trailing model turn. Apply the normalizer in both the gemini and the AG
    envelope paths, after AG thought stripping.
  - Test: live Claude Code -> Antigravity multi-tool turn before and after. Check the image-gen text-only path
    (`antigravity.js:115-145`) is unaffected.
- **6e4f82db - unique functionCall ids across history** (risk low)
  - Change: rewrite repeated ids per occurrence and queue results per id (`openai-to-gemini.js:76-80`, `:138`,
    `:146-151`).
- **625df74d - rename `$ref` inside `functionResponse.response`** (risk low)
  - Change: recursively rename `$ref` to `_ref` at `openai-to-gemini.js:164-174` and `:382`.
- **09f6d395 + aafe3002 - Gemini schema sanitizer** (risk low)
  - Change: in `ensureObjectType` (`geminiHelper.js:296-300`), recurse into a `properties` map's values, not into
    the map itself. Add `errorMessage(s)`, `x-errorMessage(s)`, `markdownDescription`,
    `x-intellij-html-description`, `x-taplo(-info)`, `doNotSuggest`, `suggestSortText`, `minProperties`,
    `maxProperties` and `deprecated` to `UNSUPPORTED_SCHEMA_CONSTRAINTS` (`:4-27`).
  - Test: port `gemini-unknown-schema-fields.test.js`.

### Batch `p2-kiro` - Kiro executor integrity and translator fixes

Files: `open-sse/executors/kiro.js`, `open-sse/translator/request/claude-to-kiro.js`,
`open-sse/translator/request/openai-to-kiro.js`, tests.

- **b44bb09f (executor hunks) - tool-only turns, one bad tool, truncated output** (risk medium, value high)
  - Fixes three bugs:
    - tool-call bytes never add to `totalContentLength` (`kiro.js:693-722`), so tool-only turns bill OUT 0/1;
    - one invalid fragment clears every tool and the text (`:890-894`);
    - a `max_tokens` or context-window stop after streamed content fails as `terminal_incomplete`
      (`:144-153`, `:916-951`).
  - Change: count argument bytes, including in the completion estimate (`:998`). Validate tools one at a time and
    drop only the invalid ones. When `chunkIndex > 0`, close with `finish_reason: "length"` and
    `stop_disposition: "length"` so the integrity gate keeps the bytes. Tool-only frames with no text still fail
    closed.
  - Adapt: this relaxes the v0.5.133 fail-closed gate; v0.5.142 deferred it for exactly that reason. Every case in
    `tests/unit/kiro-terminal-integrity.test.js` must still pass. Adapt upstream's
    `kiro-usage-and-tool-integrity.test.js` (369 lines).
- **1892ed77 - the repair retry writes a top-level systemPrompt** (risk low, value high)
  - Fixes: kiro.dev answers any top-level `systemPrompt` with a terminal 400 `REQUEST_BODY_INVALID`. Every
    repair retry (`kiro.js:127-134`, called at `:412`) is therefore a hard failure.
  - Change: append the instruction to `conversationState.currentMessage.userInputMessage.content`. Test that the
    repaired body has no `systemPrompt` key.
- **82b1bca4 - neutral placeholder for tool-result-only user turns** (risk low)
  - Change: use `Tool results provided.` when the turn has tool results, else keep `continue`
    (`claude-to-kiro.js:144`, `openai-to-kiro.js:207`). Golden snapshots change.
- **f4f06f29 (Kiro half) - keep tool_result images** (risk medium)
  - Change: image-only `tool_result` blocks are JSON-stringified today (`claude-to-kiro.js:195-203`), which
    floods the context with base64. Move them into `userInputMessage.images`.
- **35b950be (unclear) - Amazon q/codewhisperer surfaces first, plus new headers.** Probe first: send a live
  social-auth Kiro chat curl. Port only if kiro.dev returns 400 `REQUEST_BODY_INVALID`. The v0.5.154 live E2E
  suite passed on 2026-09-08.

### Batch `p2-openai-wire` - OpenAI-shape request translators and executors

Files: `open-sse/translator/request/openai-responses.js`, `open-sse/translator/request/claude-to-openai.js`,
`open-sse/translator/helpers/paramSupport.js`, `open-sse/executors/codex.js`, `open-sse/utils/codexToolSchema.js` (new),
`open-sse/executors/grok-cli.js`, tests.

- **ab044e6d (translator half) - Responses wants `max_output_tokens`** (risk low)
  - Fixes:
    - `openai-responses.js:327` copies `max_tokens` and drops `max_completion_tokens`;
    - the `input[]` early return at `:216` passes `max_tokens` through;
    - `openai-compatible-*responses*` nodes go through DefaultExecutor and never strip it, so real OpenAI
      `/v1/responses` answers 400;
    - the translator never maps `reasoning_effort`.
  - Change: map both to `max_output_tokens` on both paths, and map `reasoning_effort` to
    `reasoning: {effort, summary}`. In `grok-cli.js:538`, map the cap instead of deleting it (it is on the
    allowlist at `:35-52`).
  - Live: one Responses node, before and after.
- **e74db4d0 + 11222eff (hardening) - strict Responses input validation** (risk low)
  - Change: skip nameless calls and tools (`:282-287`, `:311-322`), coerce arguments to one JSON string, and
    always send a string output (`:293-297` sends `"null"` today). Generate unique fallback call_ids
    (`clampCallId(undefined)` returns undefined at `:13`) and clamp names to 128 characters.
  - Adapt: keep kRouter's instruction merging (`:225-243`), which is better than upstream's.
- **f4f06f29 (OpenAI half) - keep tool_result images** (risk medium, value high)
  - Change: `claude-to-openai.js:160-170` JSON-stringifies image blocks into the tool text. Move them into a
    following user message as `image_url` (MCP screenshot tools).
- **7c2b1fe3 - strip replayed reasoning for Groq / Mistral / Cerebras** (risk low, value high)
  - Fixes: from turn 2 on, every request with an echoed `reasoning_content`/`reasoning`/`reasoning_details` fails
    with 400 or 422, and combos silently skip these providers.
  - Change: add a `dropMessageFields` rule type and make `match` optional; `paramSupport.js:58-69` throws today
    on a provider-only rule. Build new message objects rather than deleting in place.
  - Live: a two-turn request with `reasoning_content` to groq.
- **781c18d8 - strip `\p{...}` tool-schema patterns for Codex** (risk low, value high)
  - Fixes: Codex's regex validator returns 400 "is not a regex" on every account, costing a full combo failover
    each turn.
  - Change: new copy-on-write `codexToolSchema.js` that drops only the offending `pattern` keys (treating
    `properties` keys as names), applied to function and namespace sub-tools in `normalizeCodexTools`
    (`codex.js:68-104`). Port upstream's 3 tests.
- **0dd4d6be - keep an explicit tool `strict` flag** (risk low)
  - Change: `codex.js:100-104` rebuilds each tool and drops `strict`. Preserve a boolean.

### Batch `p2-errors` - fallback and lock decisions

Files: `open-sse/services/accountFallback.js`, `open-sse/config/errorConfig.js`, `src/sse/services/auth.js`,
`open-sse/services/combo.js`, tests.

- **20a43f5a - no account cooldown for request-scoped 4xx** (risk medium)
  - Fixes: an unmatched 400 falls through to a 30 s transient cooldown (`accountFallback.js:57-58`). With one
    connection, every request in that window fails with a copy of the error.
  - Change: `{shouldFallback:false, cooldownMs:0}` for any 4xx other than 401/402/403/429; text rules still win;
    404 stays account-scoped (`errorConfig.js:144`).
  - Adapt: check combos first. A 400 that one model rejects may succeed on the next combo member, so combo
    fall-through must still happen.
- **9f41ee75 (fallback half) - "model is not supported when using Codex with a ChatGPT account"** (risk low)
  - Change: add a codex-scoped text rule that locks that model on that account and falls back. Pass the provider
    into `checkFallbackError` (`accountFallback.js:23`). Account selection skips Codex connections whose
    `enabledModels` exclude the model. The dead gpt-5.4 and Spark ids answer with exactly this 400.
- **8f4e3800 - combos fall back on HTTP 200 with zero usable content** (risk medium)
  - Change: on a non-final seat, a 2xx JSON response with no content, tool calls or reasoning, and a
    missing/in_progress/incomplete finish, falls through instead of returning (`combo.js:344-347`). Reuse
    `detectEmptyCompletion`, and keep finish `length` as a success.
- **kRouter-own - never downgrade a precise reset to the 90 s TPM lock** (risk low)
  - Change: add `!(resetsAtMs && resetsAtMs > Date.now())` to the TPM gate at `auth.js:503`. Closes the known
    Codex `usage_limit_reached` concern.
  - Test: feed a 429 that says "rate limit" and carries a `resetsAtMs` 3 h out; assert the cooldown follows
    resetsAtMs and is capped by `MAX_QUOTA_RESET_COOLDOWN_MS`.

**kRouter-own additions (found 2026-10-16 by the blog fact-checkers; prove each before fixing):**
- `open-sse/services/combo.js`: `reorderByQuota` re-sorts the whole list AFTER `reorderByCapabilities`, so a text-only entry with
  quota data can jump ahead of the entry that can read the request's image/PDF/audio, although the comment says the capability sort
  wins. Make capability a hard partition: quota may only reorder within the capable group and within the rest. Test with an image request.
- A provider 503 meaning "busy, try another account" matches no rule and gets the default 30 s per-model cooldown written to the DB.
  Check errorConfig.js / checkFallbackError: a transient busy/overloaded 503 should get the short overloaded backoff (2 s doubling), not
  30 s. Keep 500/502/504 behaviour unless the evidence says otherwise.

- Retry-After never reaches a combo: `combo.js` (around line 355) reads `retryAfter` from the response BODY, but the "all accounts
  are parked" response sends it only as a header. Read the header too. Test it.
- `open-sse/executors/gemini-cli.js` (extra file, ~lines 38-52) turns Gemini CLI's `retryDelay` into `retryAfter` only, never
  `resetsAtMs`, so the lock ignores it. Feed it into the same reset-time path other providers use (still capped at 6 h). Test it.
- Dashboard `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js` (extra file, ~line 82): the cooldown timer can pick a lock
  that has already expired (so a month-long account-wide hold shows no countdown). Use the latest unexpired lock. Test the helper.
### Batch `p2-usage-stats` - usage attribution and cost

Files: `src/lib/db/repos/usageRepo.js`, `open-sse/utils/usageTracking.js`, `src/shared/components/UsageStats.js`, tests.

- **a406381f + 4a57df8b - key live byApiKey stats by the full key** (risk low)
  - Fixes: `usageRepo.js:597` buckets by `maskApiKey`, which keeps 8 characters (`:6-10`). Every kRouter key
    shares the `sk-{machineId}` prefix, so one holder's usage is attributed to another.
  - Change: key by the full key and mask as `first8***last4`.
  - Follow-up to consider: `/api/usage/stats` sends full keys in `byApiKey` and `meta.apiKey`. It is behind auth,
    but the dashboard only needs masked keys.
- **d1de3245 - bound the lastUsed overlay to 2 days** (risk low)
  - Fixes: `usageRepo.js:512-516` scans the whole `usageHistory` table on `period=all`, for every SSE listener on
    every update.
- **813a0121 - token fallback for `input_tokens` rows** (risk low)
  - Fixes: embeddings and Gemini rows count as 0 in the 24h/today view (`:555`).
- **46627249 - Ollama `prompt_eval_cached_count` becomes `cached_tokens`** (`usageTracking.js:224-231`, risk low).
- **dcc6a205 - hide `hidden` providers in the usage filter** (`UsageStats.js:229`, `:238`, risk low).

### Batch `p2-cli-tools` - CLI tool config writers

Files: `src/app/api/cli-tools/{opencode,copilot,deepseek-tui,codex,claude}-settings/route.js`,
`src/app/(dashboard)/dashboard/cli-tools/components/{CodexToolCard,ClaudeToolCard}.js`, a new shared key resolver,
tests.

- **06eda8b0 - write a real dashboard key, not the `sk_krouter` placeholder** (risk low)
  - Fixes: `opencode-settings/route.js:116`, `copilot-settings/route.js:84` and `deepseek-tui-settings/route.js:135`
    write a key that 401s whenever `requireApiKey` is on. That covers every Docker install, per the v0.5.164 docs.
  - Change: use the first active `apiKeys` row, else an empty string. Treat `sk_krouter` and `sk_9router` as no key.
- **8f20daac - the Codex card reads the active `model_providers` table** (risk low)
  - Change: `CodexToolCard.js:69` and `:282` take the first `base_url` in the file. Parse
    `[model_providers.<active>]` instead, and make `codex-settings/route.js` force-dynamic.
- **17c4cc76 - Claude Code context controls that actually work** (risk low)
  - Fixes: `claude-settings/route.js:158-163` writes `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, which Claude Code ignores for
    known models.
  - Change: write `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and add a `[1m]` toggle on `ANTHROPIC_DEFAULT_*_MODEL`. Reset
    removes only values kRouter wrote (v0.5.164 rule) and also cleans up the old key.
- Optional **c4690307** (keep an existing `ANTHROPIC_AUTH_TOKEN`). Only port with a UI note: picking another key
  in ApiKeySelect would silently do nothing until Reset.

### Batch `p2-caps` - capability rows that misroute requests today

Files: `open-sse/providers/capabilities.js`, tests.

- Verified live with `getCapabilitiesForModel` on 2026-10-16:
  - `opencode-go/glm-5.3-flash`: vision=false, ctx=200000.
  - `deepseek-v4-flash-vision-exp`: vision=false.
  - `deepseek-v4.1-flash` and `deepseek-flash`: vision=false.
  - `glm/glm-5.3`: ctx=200000.
  - `kiro/claude-opus-5.5` (dot form): ctx=200000.
  - `codex/gpt-6-sol`: vision=false, ctx=200000.
  - Image requests to the two "(Vision)" ocg models are judged unsatisfiable, so the vision pool, the dead
    mmf, goes in front of them. `/v1/models` also publishes these wrong limits.
- Items:
  - 9c650e1d (caps half): add exact rows for glm-5.3-flash (1M, vision), deepseek-v4-flash-vision-exp (vision),
    grok-4.5/4.6 (500k; verify), and glm-4.6v/4.5v video and output limits.
  - 912ed295 + 367fc546 + 8a4f4d9d: deepseek-v4.1-flash, deepseek-v4-1-flash and deepseek-flash get vision; add a
    `*deepseek-v4.*` dotted pattern. Do not re-add vision to deepseek-v4-pro (v0.5.164 removed it per DeepSeek
    docs).
  - 0f7f6e72: `*glm-5.2*` and `*glm-5.3*` get 1M.
  - f5f88039 + ccd0677d: `pdf:true` for Claude 4.x/5.x/Fable/Mythos, and a `*claude*sonnet-5*` pattern
    (adaptive, 1M/128k). Today the opt-in pdf pool treats Claude as unable to read PDFs.
  - e78b766a: Kiro dot-form `claude-opus-5.5` ids at 1M.
  - 89ffac5a (caps half): `*gpt-6*` and gpt-5.4/5.5/5.6 at 1.05M, with mini/nano staying at 400k.
- Test: table-driven `getCapabilitiesForModel` assertions for every id above. Assert that `reorderByCapabilities`
  stops rerouting a vision request to ocg/glm-5.3-flash.

### Batch `p2-mimo` - stop defaulting the vision pool to the dead MiMo Free channel

Files: `open-sse/services/capacityAdapter.js`, `src/lib/db/repos/settingsRepo.js`,
`src/app/(dashboard)/dashboard/combos/page.js`, `src/shared/constants/providers.js` (the `mimo-free` entry only), tests.

- **6d96e24b (pre-range, skipped in v0.5.50) + kRouter-own interim** (risk low, value high)
  - Fixes: Xiaomi ended the free MiMo API. kRouter's vision pool is on by default with `mmf/mimo-auto` as its
    implicit model (`capacityAdapter.js:22`, `settingsRepo.js:24`, `combos/page.js:24`). Every adapted image
    request spends a failed call on a dead channel first.
  - Change: set `hidden: true` on `mimo-free` (`providers.js:18`). Remove the implicit default, so an enabled
    pool with no models is a no-op, and show a dashboard note asking the user to pick a vision model. Migrate
    stored `mmf/mimo-auto` pool entries out.
  - Adapt: the final default `oc/mimo-v2.6-flash-free` (upstream 6886915f) waits for `p3-opencode-free` live proof.
  - Live: curl `mmf/mimo-auto` to capture the current "service has ended" response as before-evidence.

### Batch `p2-misc` - small independent fixes

Files: `open-sse/config/grokCli.js`, `package.json`, `package-lock.json`, `src/lib/tunnel/tailscale/healthCheck.js`,
`src/lib/tunnel/tailscale/manager.js`, `cli/src/cli/menus/combos.js`, `open-sse/services/imageCapability.js`,
`src/shared/utils/clineAuth.js`, tests.

- **6b9dc54d - Grok CLI 0.2.99 -> 1.0.44** (risk low, value high)
  - Fixes: `cli-chat-proxy.grok.com` answers 426 to clients below 1.0.13. kRouter already single-sources the
    version (`grokCli.js:11`).
  - Live: one grok-cli request, 426 before and 200 after.
- **f6e7cabe - add the `workos:` prefix only to WorkOS JWTs** (risk low, value high)
  - Fixes: `clineAuth.js:9` prefixes every token, so every ClinePass API-key request (`clp_...`) gets 401.
  - Change: prefix only `eyJ...` tokens, never twice. Test both token shapes. (The authModes order is a
    `p3-catalog` item.)
- **8a527fec (deps half) - declare `chalk` and `prop-types`** (risk low)
  - Fixes: both are imported (`src/lib/oauth/utils/ui.js:1` and three dashboard files) but resolve only as
    transitive dependencies. A dependency bump or a production install without eslint breaks the build.
- **e7c269b8 - Tailscale enable flow waits 20 s, not 180 s** (`healthCheck.js:21`, `manager.js:91`).
- **b677bfce - CLI TUI combos store `provider/model` strings** (`combos.js:298-306`).
- **345cdcf6 (strip half) - also drop `msg.images` and image attachments for text-only models**
  (`imageCapability.js:118-140`). Return new objects.

---

## Phase 3 - Provider and catalog updates

Land `p3-catalog` first. The rest run in parallel afterwards.

### Batch `p3-catalog` - the data owner (all catalog and constant edits)

Files: `open-sse/config/providerModels.js`, `open-sse/config/providers.js`, `open-sse/providers/capabilities.js`,
`src/shared/constants/pricing.js`, `src/shared/constants/providers.js`, `src/shared/constants/cliTools.js`,
`src/shared/constants/config.js`, `src/mitm/config.js`, `src/lib/qoder/constants.js`, tests.

Land one commit per provider. Probe the live `/models` endpoint before deleting any id.

- **Codex (cx)** (risk medium, value high)
  - Upstream: ca6e8407, dec820b9, 7878f53b, ed963931, 832a3465, eb712ca8, 92c7bdd5, 9f41ee75 (catalog half),
    8f9ff44f, efc80ba2.
  - Retire gpt-5.5 (the current default), gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark and their `-image`
    variants, after the probe.
  - Add:
    - gpt-6.1-sol, gpt-6-sol and gpt-6-luna, with a `responsesLite: true` flag;
    - gpt-6-astra;
    - gpt-5.6-sol/terra/luna, with `-review` and `-image`;
    - gpt-daybreak-blue-latest and gpt-reserve;
    - `codex-auto-review`, with `upstreamModelId: "codex-auto-review"` outside `withCodexReviewModels`. Today
      `getModelUpstreamId` strips `-review` (`providerModels.js:1054`).
  - Add the capability and pricing rows; GPT-6 Astra is $10/$50.
  - Skip the `[1m]` variants for now: `chat.js:79-84` strips the marker. Revisit with `p4-models-api`.
  - Constants:
    - one `CODEX_CLI_VERSION = "0.159.0"`, used for the UA at `providers.js:97`;
    - auto-ping model `gpt-5-mini` (`config.js:64`) moves to a Codex model, gpt-5.6-terra;
    - the CLI preset at `cliTools.js:378` moves to `cx/gpt-6.1-sol`.
  - Probe: `backend-api/codex/models` on a Plus and a Free account. That decides which ids each plan really
    serves and whether gpt-5.3-codex survives. Do not trust v0.5.155's Spark quota window.
- **Antigravity (ag)** (risk medium, value high)
  - Upstream: 783e271c, 86694ed8, d91e8b85, 70f15aa5, 24034f69, a07ed95b, 29fc880e.
  - Add Gemini 3.6/3.7/3.8 Flash high/medium/low tiers, gemini-3.1-pro-high, Claude Sonnet/Opus 5.5 tiers and
    gemini-4-argon-high. Drop gemini-3.5-flash-*, gemini-3-flash-agent and gemini-3-flash after a live probe.
  - MITM: point `gemini-default` and the 3.5 synonyms/patterns (`src/mitm/config.js:63-80`) and
    `MITM_TOOLS.antigravity` defaults (`cliTools.js:11-18`) at the 3.8 tiers.
  - Also add the Kiro `claude-sonnet-5` MITM slot that kRouter lacks.
- **Gemini API / Vertex:** gemini-3.7-flash, gemini-3.8-flash and gemini-4-argon (1M/64K, thinking cannot be
  disabled).
- **GLM / glm-cn:** glm-5.3-flash, and backfill glm-cn glm-5.2 and glm-4.6v (9c650e1d catalog half).
- **DeepSeek direct:** deepseek-v4.1-flash with pricing (8e15f0bd; check against the August repricing).
  **xai:** grok-4.5 and grok-4.6.
- **CodeBuddy-CN (cbcn)** (risk low)
  - Upstream: e014cb53, cec672d9, 807553e2, 63de82b8. Port the net 2026-09-30 server state.
  - Drop glm-5.0, glm-5.0-turbo, glm-4.7, glm-5v-turbo, minimax-m2.7, kimi-k2.5/2.6/2.7, hy3-preview,
    deepseek-v4-flash and deepseek-v3-2-volc.
  - Add hy3, hy4-preview (the promos ended; verify they still answer), glm-5.3, glm-5.3-flash, kimi-k3-1,
    kimi-k2.8-preview and deepseek-v4.1-flash.
  - Capability fixes: `thinkingCanDisable` true for glm-5.2/5.3/deepseek-v4 (`capabilities.js:118-136`), plus the
    corrected maxOutput values. v0.5.155 called this registry-only, but it maps directly onto these two files.
- **Qoder** (2ab6a4c9 catalog half): drop qmodel_preview and gm51model; add lite, qmodel_38max, qfmodel,
  gmodel and gfmodel in `providerModels.js:180-195` and `src/lib/qoder/constants.js:40-55`. **Never** take that
  commit's Dockerfile mirror hunk.
- **Ollama:** deepseek-v4.1-flash:cloud (5c399b64). **Xiaomi MiMo cloud:** mimo-v2.6-pro/flash/pro-ultraspeed
  (910db749). Check live whether the `xiaomi/` prefix is required. **OpenCode Go:** claude-haiku-5-5 with
  `targetFormat: "claude"` (c8644368 haiku half).
- **Provider constants (`src/shared/constants/providers.js`):**
  - ClinePass `authModes: ["apikey","oauth"]` (f6e7cabe UI half).
  - GitHub `embeddingConfig` moves to api.githubcopilot.com with text-embedding-ada-002 (51a1827e).
  - HuggingFace `sttConfig` moves to router.huggingface.co with whisper-large-v3-turbo, and the `language` param
    is removed (cf663f53).
  - kRouter-own bug: add `opencode-go` to `USAGE_SUPPORTED_PROVIDERS` and `USAGE_APIKEY_PROVIDERS` (`:299`, `:317`).
    The v0.5.155 quota handler is filtered out by `isUsageEligible`.
- **kRouter-own cleanup:** `open-sse/config/providers.js` defines `opencode` twice (`:290` localhost:4096 is dead;
  `:504` wins). Delete the dead one.
- Test: the existing catalog invariant tests (the two alias maps must agree, targetFormat matches
  CLAUDE_FORMAT_MODELS) plus a capabilities table test.

### Batch `p3-codex-wire` - Codex transport for the new catalog

Files: `open-sse/executors/codex.js`, `open-sse/handlers/imageProviders/codex.js`, `open-sse/services/model.js`,
`src/app/api/providers/[id]/test/testUtils.js`, `src/app/api/providers/[id]/models/route.js`,
`src/sse/handlers/imageGeneration.js`, `open-sse/handlers/imageGenerationCore.js`, tests. Depends on `p3-catalog`.

- **95600db1 + 7bf93178 - GPT-6 Sol/Luna "Responses Lite"** (risk medium, value high)
  - Change, gated on the per-model `responsesLite` flag so existing models are untouched:
    - send the `x-openai-internal-codex-responses-lite` header;
    - move tools and instructions into input prefix items (`additional_tools` plus a developer message);
    - set `instructions: ""`, `tools: null`, `parallel_tool_calls: false`;
    - send `reasoning: {effort, context: "all_turns"}` without a summary, default effort medium, with none and
      minimal mapped to low;
    - keep developer `msg_` ids.
  - With hosted `web_search`, fall back to regular Responses and hoist the tools back out (7bf93178).
  - Live: needs a Codex subscription with GPT-6 access.
- **a7047a07 + ca6e8407 - one CLI version everywhere** (risk low)
  - Use the `p3-catalog` constant at `imageProviders/codex.js:6-7`, `testUtils.js:32` (also change its test body
    from gpt-5.3-codex) and `models/route.js:213` (`client_version=0.144.6` today). A stale version filters
    new models out.
- **7878f53b + eb712ca8 + 832a3465 - Codex image models** (risk low)
  - The image main model becomes gpt-5.6-sol. Add the gpt-image-1.5/2/2.5/2.5-flare/2.5-sunburst models, which
    run the Responses request on a chat model, pass the image model as `image_generation.model` and pin
    `tool_choice`. Choose generate or edit by refs. Today `buildBody` sends `stripImageSuffix(model)` as the chat
    model (`imageProviders/codex.js:163-183`).
- **8f9ff44f + efc80ba2 - bare-slug inference** (risk medium)
  - Change: in `model.js:279-290`, route bare `gpt-5.x`, `gpt-6.x`, `gpt-daybreak-*`, `gpt-reserve*` and
    `codex-auto-review` to codex **only when a codex connection exists**, so OpenAI API-key users keep working.
- **e10da160 - record Codex image usage from `response.completed`** (risk low).

### Batch `p3-ag-wire` - Antigravity / Gemini transport for the new catalog

Files: `open-sse/executors/antigravity.js`, `open-sse/translator/request/openai-to-gemini.js`,
`open-sse/executors/vertex.js`, `src/mitm/antigravityIdeVersion.js`, `open-sse/config/appConstants.js`,
`open-sse/services/antigravityClientProfile.js`, tests. Depends on `p3-catalog`.

- **Tier wire ids** (risk medium)
  - Upstream declares `upstreamModelId: "<id>(level)"` and its registry splits off the level. kRouter has no
    such parser; it maps thinking through `extractedThinkingConfig` (`antigravity.js:202-216`).
  - Change: map each tier to the wire model plus `thinkingLevel` via `getModelUpstreamId`
    (`providerModels.js:1050`).
  - Probe: on a live AG account, check which wire ids answer, for example `gemini-3.7-flash-tiered` with
    thinkingLevel high.
- **29fc880e + eb373017 + 9c141910 - Gemini 4 Argon restrictions** (risk low)
  - Argon rejects `thinkingLevel: "minimal"` and `thinkingBudget`. Clamp `none`/`off` to low; today it maps to
    minimal (`openai-to-gemini.js:239`, `antigravity.js:212-216`).
  - Drop temperature, top_p and top_k for Argon, and order `functionResponse` parts last.
  - Vertex: default Argon to the `global` location; today it is us-central1 (`vertex.js:94`). API-key connections
    with a project use the project URL (`:102`).
- **70f15aa5 + cff2b1d9 - IDE fingerprint** (risk medium)
  - The MITM override moves from 1.23.2 (`antigravityIdeVersion.js:7`) to a current real IDE build (upstream
    uses 2.22.0), on chat endpoints only; `server.js:175` explains why auth endpoints are gated.
  - The executor profile (`appConstants.js:129`, antigravity/1.107.0) is kRouter's own OmniRoute-style profile.
    Bump it only to a real build, then verify loadCodeAssist and chat live.
- **24034f69 (429 half) - parse `quotaResetTimeStamp` into `resetsAtMs`** next to the existing retryDelay parse
  (`antigravity.js:392-402`).

### Batch `p3-opencode-free` - revive OpenCode Free (oc), then the final vision default

Files: `open-sse/executors/opencode.js`, `open-sse/utils/opencodeFingerprint.js` (new),
`open-sse/utils/reasoningContentInjector.js`, `open-sse/handlers/chatCore.js`,
`open-sse/handlers/chatCore/nonStreamingHandler.js`, `open-sse/handlers/chatCore/sseToJsonHandler.js`,
`open-sse/translator/index.js`, `open-sse/services/capacityAdapter.js`, `src/lib/db/repos/settingsRepo.js`,
`src/app/(dashboard)/dashboard/combos/page.js`, `src/app/api/v1/models/route.js`, `src/lib/db/repos/nodesRepo.js`, tests.
Depends on `p2-core` (rawHeaders).

- **The upstream/master end state of the OpenCode Free chain** (risk high, value high, effort L)
  - kRouter's `opencode.js` is the 30-line initial version. It posts to `/zen/v1/chat/completions` with only
    `Bearer public` and `x-opencode-client: desktop`.
  - Since 2026-10-14, `/zen/v1` and every v1 UA get 403 FreeTierError. Upstream (416 lines, 5bdcd5e7 + e964e482)
    does the following:
    - posts to `/inference/v1/{chat/completions,messages,responses}`;
    - sends UA `opencode/latest/2.0.26/cli` and client `cli`;
    - sends `x-opencode-session` plus `x-opencode-session-id`, `x-session-affinity` and `x-session-id`, with no
      `x-opencode-request`;
    - mints deterministic digest-time `ses_` ids;
    - appends the byte-exact OpenCode v2.0.26 read/shell tool definitions plus a system note, and never sends
      `tool_choice: "none"`;
    - always streams upstream and aggregates for non-stream clients;
    - restores tool names through a request-local map merged into `toolNameMap`;
    - adds a `reasoning_content` placeholder for Zen multi-turn chats;
    - routes Muse Spark to `/responses` and union-alpha to `/messages`.
  - Adapt:
    - no instance fields (`this._currentSessionId` is shared across concurrent requests; the executor is a
      singleton);
    - kRouter has no `resolveSessionId`, so reuse `opencode-go.js` seed helpers (`:121-205`) and `deriveSessionId`;
    - add `opencode` to `providerRequiresStreaming` (`chatCore.js:101-105`);
    - reuse `toOpenCodeGoResponsesBody` for Muse Spark;
    - read downstream opencode headers from the whitelisted `rawHeaders` from `p2-core`;
    - the oc catalog stays live-fetched (`providerModels.js:283-289` is commented out), so key the model routing
      on live ids.
  - Risk: upstream changed this gate three times in three days. Expect it to move again; keep the fingerprint in
    one module.
  - Live: streaming and non-streaming, with and without tools, on a mimo and a Muse Spark free id.
- **6886915f + 1a027131 + 41a1b800 + 3e4323e2 - final vision default** (risk medium)
  - Only after the oc live proof: `DEFAULT_FALLBACK_MODEL = "oc/mimo-v2.6-flash-free"`, migrate any stored
    legacy value, and use the ordered table UI where deselect restores the default.
- **a8f63f4d - `/v1/models` lists no-auth free providers; deleting a compatible node prunes its custom models**
  - `/v1/models` lists free providers only from DB connections (`route.js:240-245`), so they never appear;
    `nodesRepo.js:85-95` leaves the deleted node's `customModels` kv rows behind.

### Batch `p3-media` - dead media hosts

Files: `open-sse/handlers/imageProviders/huggingface.js`, `open-sse/handlers/sttCore.js`,
`open-sse/handlers/embeddingProviders/openai.js`, `open-sse/handlers/embeddingProviders/index.js`,
`open-sse/handlers/embeddingProviders/github.js` (new), tests. The config lines come from `p3-catalog`.

- **cf663f53 - HuggingFace moves to router.huggingface.co** (risk low)
  - `api-inference.huggingface.co` no longer resolves (ENOTFOUND). HF image (`huggingface.js:4`) and STT
    (`sttCore.js:126-138`) are dead.
  - Change: use `<base>/<provider>/<providerModelId>` with a Hub-id -> provider-id map in the handler (kRouter has
    no `PROVIDER_MEDIA`). Add image-to-image and the hf-inference ASR route, and guard custom-endpoint model ids.
  - Live: one text-to-image and one STT call.
- **51a1827e - GitHub Copilot embeddings** (risk low)
  - `models.github.ai` was retired on 2026-07-30 (`embeddingProviders/openai.js:12`). Add a github adapter that
    calls `api.githubcopilot.com/embeddings` with the short-lived Copilot token and editor headers.

### Batch `p3-quota` - quota tracker data

Files: `open-sse/services/usage.js`, `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js`, tests.

- **e214fb1c + 4ad1e7a4 - Claude model-scoped weekly limits** (risk low)
  - Parse `limits[]` `kind: "weekly_scoped"` (Fable) into `weekly <model> (7d)` rows; `usage.js:625-635` reads only
    `seven_day*`. Use the order session, weekly, fable, opus, sonnet. Port only the 4ad1e7a4 shape: the
    e214fb1c fabricated row was reverted upstream.
- **Antigravity quota model list** for the new tiers (`usage.js:411-421`).

### Batch `p3-execs` - provider-specific executor fixes

Files: `open-sse/executors/codebuddy-cn.js`, `open-sse/executors/opencode-go.js`, `open-sse/executors/commandcode.js`,
`open-sse/translator/request/openai-to-commandcode.js`, `open-sse/translator/response/commandcode-to-openai.js`,
`open-sse/executors/base.js` (only if the 6004 gate needs it), tests.

- **CodeBuddy-CN** (risk low)
  - kRouter-own bug: `codebuddy-cn.js:36-37` forces `reasoning_effort: "medium"` plus `reasoning_summary: "auto"`
    when the client sent none. Upstream removed that in d1e98d9a (#2071) because it trips CodeBuddy's content
    filter, and medium is outside every per-model set.
  - Add a per-model effort clamp (e014cb53: glm-5.3 low/high/max, deepseek-v4 low/high/xhigh, hy3 low/high,
    hy4 high).
  - e706e4f2: code 6004 or the frequency-limit text becomes 429 with `resetsAtMs` (UTC+8). Check which HTTP status
    6004 arrives with, because `base.js:159` consults `parseError` only on 429.
- **OpenCode Go** (468aa7d9): drop `response_format` for `deepseek*` on the chat transport (risk low).
- **Command Code** (risk medium)
  - 13b468b8: map `image_url` and Claude image blocks to the native `{type:"image"}` block instead of
    `[image omitted]` (`openai-to-commandcode.js:41-42`), and put `reasoning_effort` in `params`.
  - 092c84ea: retry 502/503/504 up to 2 times, and send a `{type:"reasoning"}` block on tool-call history turns.
    Throw on mid-stream `type:error` only now that `p2-stream-abort` provides in-band error frames
    (`commandcode-to-openai.js:181-186`).

### Batch `p3-qoder` - Qoder failover and images

Files: `open-sse/executors/qoder.js`, `tests/unit/qoder.test.js`. Qoder carries a RISK_NOTICE deprecation in the UI,
so do this last in Phase 3.

- **80afb599 + 2daf25ff + 782c137b (Qoder half)** (risk medium)
  - Make `wrapQoderSSE` async and peek at the first envelope (`qoder.js:225`, call site `:433`). Billing codes
    110/112/10605 or `pricingUrl` return 403; other non-200 envelopes return the real status. Today every one
    becomes assistant text with finish `stop`, so failover never happens (`:251-265`). Replay the peeked bytes.
  - Mid-stream billing becomes a structured error. Pass `strictProxy` to `proxyAwareFetch` (`:418-422`) so a
    failed proxy attempt never replays the signed request directly (403 code 103).
  - Await `wrapQoderSSE` in the existing tests.
- **2ab6a4c9 (executor half) - keep images** (risk medium)
  - `normalizeMessages` flattens content to text and drops every image (`qoder.js:42-60`). Keep `image_url`,
    convert Claude image blocks, and hash images into `chat_record_id`. Port upstream's image test cases.

---

## Phase 4 - Features worth porting (product-driven, optional)

Value and effort refer to kRouter users. Run each as its own batch when chosen; the files listed are the
primary ones.

| Key | Upstream | What | Value | Effort | Notes |
|---|---|---|---|---|---|
| `p4-search-fetch` | 2f17352c, 5a86f6a8 + 9dbdca0e, e0ffc7e2 (Ollama fetch), 60e890d7, f0a6d358 | Antigravity Google-grounded search, Ollama Cloud and Z.ai (glm) search reusing the chat key (credentialFallback), Ollama web fetch, TinyFish, Xquik | medium | M | Apply the AG anti-abuse layer to search. Fold zai into glm. Ollama fetch needs the `p2-core` lock scoping first |
| `p4-quota-ui` | cd4003bc + 456f2a26, b9c92cb8, e3bf94ee + f615a83c, b2aaf83b, 3ef4d8e3, e571a8b6, be51142b + 28d40159, 65826d95 | Claude 5-min good-read cache with force=1; Groq quota; AG weekly + free-tier handling and grouped rows; Qoder add-on quota; Cursor quota; Claude free reset grants (irreversible, needs confirmation, grantId validation); fixed-time auto-ping schedule; `?provider=` deep link | medium | M-L | Keep kRouter's Claude cooldown and last-good cache |
| `p4-models-api` | 5c217d34, 89ffac5a (combo half), 38f031f4 | Capabilities object on `/v1/models`, combo capability and window aggregation, capability toggles for custom models, fed into `getCapabilitiesForModel` so routing honours them | medium | M | Also decides the `[1m]` Codex variants |
| `p4-claude-extras` | dc198dff, 2fd99eae | Merge the client `anthropic-beta` into the computed set; forward retry-after / anthropic-ratelimit-* headers; `x-claude-code-session-id` as the codex/grok-cli/opencode-go cache seed | medium | M | Rate-limit headers leak one shared account's limits to every user; gate them to single-user setups |
| `p4-headroom` | 993c6eb4 | `headroomTimeoutMs` setting | medium | S | Both handleChatCore call sites in `chat.js` (`:390`, `:486`) |
| `p4-ag-quota-routing` | 1a3db1ef, ac98dd9d | Live quota refresh on 409/429 with exact resetAt; strike-breaker | low | M | Must not widen the TPM downgrade |
| `p4-thought-sig` | c08efdbe + bc3be0cb | Persist and replay real Gemini thoughtSignatures, scoped to the model family | medium | L | High risk on the hot path. Session namespace is per account in kRouter |
| `p4-catalog-sync` | 0532f00d + d0172455 + e6f5724b | Daily models.dev capability sync | medium | L | All three together. Honour `DATA_DIR`. Additive below the hand-written tables |
| `p4-new-providers` | 165f9b90 + 90f89471, a9d0ad26, 28809807 + b00ba1aa, 85bc33ce, 49185137, 06112c13 + 2310ad4b, 737b1f4d, e02bde4a, 73cb8914, 068ce87d | Nous OAuth + attribution tags, AWS Bedrock, Meta Muse, MiniMax Code, OpenCode Zen PAYG, Dahl/Atria/Agnes/B.AI, Token Harbor, Kimchi API key, MiMo Desktop session, GLM OAuth | low-medium | S-L each | Wire all 4 catalog/routing points; both alias maps must agree. Do not take Bedrock's kiro.js refactor |
| `p4-media-extras` | 3288bbc4 + da6aa901, 2f827bcf, fe347e4e | OpenRouter and Vertex Veo video (with the job-id SSRF guard), ElevenLabs Scribe STT, Gemini Live STT | low | M-L | da6aa901 is mandatory with Vertex video |
| `p4-access` | d8c585fb, b3cf3fde, 65197ad1, 4fa46034 | Per-key combo/model allow-lists; per-provider custom headers (block Host/Authorization/Cookie); SAML 2.0 SSO; Netlify relay | medium | L | SAML needs a security review (new XML-signature dependency) |
| `p4-cli-tools` | 69cc1aa9 + 001b2928, a9c9f683 + d6431f8b, 6c9fe6f7, 0249464d, 4a390685, 31704db7 + 8a90d3c9, abb20d9f, 249f6c2f | Hermes roles and profiles, Pi/OMP/Crush/Forge/Smelt/CodeWhale cards, Codex profiles, grouped CLI model selector, `connect`/`show`, Grok bulk import, tray arm64 | low | M-L | Codex profiles: verify the CLI reads `<name>.config.toml`. Tray arm64: pin or self-host the binary, keep it out of the npm tarball |
| `p4-dashboard-ui` | d1d4e0f0, 831001c3, ddfdb0df, da1756a8, 6a1573eb, d95bb8ea, eea08215, 0d50fe36 + b53260ca, 253199f1 (bulk only), a68ada1c, 6efb9790 (two icons), e79ae6e7, a58902e4, 628ff1ea | Status filter, scroll caps, lazy charts, regex model picker, custom models in the picker, portal tooltips, mobile layout, request charts, bulk combo actions, shared endpoint presets, alitp-intl/fish-audio icons, pt-BR/id literals, 24 h cookie | low | S-M each | i18n: import only keys whose English source exists here, and rebrand |
| `p4-misc` | 1f10f9e5 (Qoder-local), 08b21fea, 199173fe, 122f23ee (live catalog), 4a371d1d hardening, 49c761cd/7e5f5a88 if not done in Phase 2, f67d5a0c (smoke test) | Qoder usage/upload/context tiers; ocg DeepSeek /messages thinking; Cline free tier at $0; live Cline catalog; nested cached_tokens fallback in calculateCost; container smoke test before tagging latest | low | S-L | |

---

## Skip list (one-line reasons)

### Already-have (58 rows)

| upstream | where in kRouter |
|---|---|
| cd4003bc (in-flight dedup) | v0.5.143, `usage.js:541-555` |
| 8a527fec (security) | v0.5.136 |
| 345cdcf6 (detection) | v0.5.142, `combo.js:231-252` |
| 5b417f9b | v0.5.137 Kiro MITM x-amz-target |
| 10a923da, 70ba0024, 30fec431, 8ed9da71 | v0.5.138 |
| 6d30ce6d, b566b20a, 71dcdc10, 27f3710c | v0.5.139 |
| e2a4fe04, 59d858b6 | v0.5.140 |
| 8af5e752, b04c03c6 | v0.5.141 |
| b57c0413 | v0.5.146 |
| 92259214 | v0.5.135 |
| 9c45b27c, d7f7d70d, f9d82c65, eb312bd4, 67d9182e, 88676b30, 6ab9ca9e, 009cac63, ee7a9616 | v0.5.150 |
| 548e32aa, 90a00058, e08ac6da, 14401c43, ec669280, bb3cb43e, dff64849, df85e16d, 44e4b80b, 925cb4aa, f6c59d30, e7dd72a8, 28cfd9fa, fb9fab02 | v0.5.153 (several stricter than upstream) |
| 40eed186, c4af43fa, cadef6c4, fcfcced4, 2a9213c5, ed1bd0c5, 5caa72f5, 0da803ee | v0.5.155 |
| b870b5d4, 97f3ab97 | v0.5.149 |
| 81f4f930 | v0.5.151 (native pass-through revived by `p2-core`) |
| e74db4d0 / 11222eff / 702b57c3 / eee3515e / c7126411 (OpenCode Go models) | v0.5.150-0.5.164 |
| dd293d3c | v0.5.163/0.5.164; do not port `space-bunny-free` (renamed) |
| f68d2f5e | initial release, `src/mitm/server.js:169-178` |
| 1f190bd0 | v0.5.61 |
| c2148179 | v0.5.150 byte replay |
| cfd8c618 | covered only when a proxy resolves; the rest goes to `p1-proxy-strict` |

### Fixed differently (7)

| upstream | why |
|---|---|
| 1a3db1ef | kRouter quota preflight plus per-model reset parking. Remainder in `p4-ag-quota-routing` |
| e1115e28 + 540ebbe6 | kRouter's own per-model transport table and dashboard override (v0.5.163) |
| 4a371d1d | kRouter extractors lift nested cached_tokens. Optional hardening in `p4-misc` |
| 98579f98 | kRouter has no root `/responses` rewrite. The same class of bug was fixed via `/codex` with an invariant test |
| 2aa99d9f | kRouter already carries all 43 Go ids plus protocol overrides |
| c7df895b + f67d5a0c | kRouter never used the mirror and already publishes multi-arch. Smoke test optional |
| f4628375 | `/v1/models` already drops inactive connections server-side |

### Not applicable (60)

- **No registry / no `translator/concerns` / no thinkingUnified / no thinkingLevels:**
  - 1fe996db, 77e6a227, 477b2aed + 1b72f02e, 4c58e7f3, c61ee37d, 7894f3d3 (capability thinking flags have no
    consumer here);
  - 28d00577 (no transports);
  - 2203cd8f, 37a6b7e0, fdcba3e1 (no catalog source).
- **Feature absent here:**
  - Zed: e5a13c3a, ef181752, 4641c2b7, 975f28a5, 7a436d20, fb30246c;
  - System One: b7446f8d chain, 0a879c5c, d2f90177;
  - 9Remote sidebar: 52917a6d, d99bc820 chain, 2afa8daf, 2d94d3ab;
  - Cursor AgentService: c933eefc (AgentService half), cbd594ac chain;
  - codebuddy-intl: 1fd208e2, 45d42b80;
  - selfhosted-tts: ee323400;
  - DeepSeek usage fetcher: 3ac100d5;
  - Codex reset-credits: 1a3d4468;
  - background token refresh: f388b5e5;
  - antigravityQuota: ac98dd9d;
  - thought-signature cache: bc3be0cb;
  - AG weekly tracker: be3bc764;
  - Ollama quota: 73e021b8;
  - Qoder CN: 402745dc;
  - MiMo Desktop login: 910db749 (login half);
  - OpenCode Zen: 59e9b526;
  - Kimi Code transports: 3125ac2b;
  - kiroConversation canonicalizer: b44bb09f (translator half);
  - DeepSeek `/anthropic` provider: 45ec1d30;
  - Copilot MITM kept: b84681d5;
  - cliEndpointPresets keys in localStorage: c24a8542 (would store raw keys; do not).
- **Already correct here:** 1fc2a81d (Kiro never emits systemPrompt), c49efdf5 (Kiro tool names sent verbatim),
  9d3f7646 (the label does not exist).
- **Docs, release and branding churn:** 01858fec, 8b2b2fef, 699edac3, 90b52e06, 4eda76e2, eb712ca8/83af3f18
  release halves, c73bb2cd chain, 23ae82d8 chain, f01fb909, a99cf572 chain, 725e2c11 (no fa.json here).
- **Net no-op upstream:** 40dffbce + accf2c52, 2aa9307f + 6ed88685.
- **Unsafe:** b58bd804 (see Phase 1).

### Unclear - live probe decides (4)

- 56a40765: GLM-5.3 effort on glm-cn/ocg returns 400 for medium/xhigh?
- ab044e6d executor half: Muse Spark on oc; folded into `p3-opencode-free`.
- ac9120fd: Fable / Opus 5.5 effort shape; in `p2-claude-wire`.
- 35b950be: kiro.dev path for social auth; in `p2-kiro`.

---

## Known open kRouter issues versus upstream

| Issue | Upstream status | Plan |
|---|---|---|
| MiMo Free (`mmf/mimo-auto`) dead, yet the default vision fallback | **Upstream declared it dead on 2026-07-29** (6d96e24b sets `hidden: true`: "MiMo free API service has ended"); kRouter skipped that commit. Upstream moved the capacity-adapter default to `oc/mimo-v2.6-flash-free` (6886915f, v0.5.85) | Interim now (`p2-mimo`): hide mmf, drop the implicit default, migrate stored entries. Final default after the oc revival (`p3-opencode-free`). `p2-caps` also stops misrouting real vision models into the pool |
| OpenCode Free (oc) returns FreeTierError | **Fixed upstream.** Free tier moved to `/inference/v1` with the v2 client fingerprint: UA `opencode/latest/2.0.26/cli`, session headers, deterministic `ses_` ids, fingerprint tools, forced stream (5bdcd5e7 + e964e482, on top of the 93837af0 and 6091ff59 chains) | `p3-opencode-free`: port the end state with per-request state (no instance fields) |
| OpenCode Go `x-opencode-session` pass-through is dead code | Not touched upstream in this range. Upstream never had the bug, because `chatCore.js:179` sets `credentials.rawHeaders` (aba4c45d, June 2026) | `p2-core`: a whitelisted rawHeaders copy. This also revives the Cursor UA check and the Kiro beta thinking budget |
| Codex `usage_limit_reached` may be cut to a 90 s TPM lock | No fix upstream, and no need: upstream has no TPM downgrade. Both trees parse `resetsAtMs` identically (`codex.js:358-379`) | `p2-errors`: add a `!resetsAtMs` guard to the TPM gate (`auth.js:503`). It probably does not fire for the standard message today, but the guard makes it impossible |

## Recommended order

1. Phase 1, three batches in parallel, then a tagged release. Live proof: the strict-pool leak (before and after),
   the 409 on a duplicate key name, and a Codex account that survives an auto-ping cycle.
2. Phase 2, 13 batches in parallel. Ship the cheap high-value fixes first if splitting releases: Claude 2.1.280,
   Grok 1.0.44, AG requestType, the ClinePass prefix, the Kiro repair, the Codex `\p{}` strip, the
   Groq/Mistral/Cerebras reasoning strip, `p2-caps` and `p2-mimo`.
3. Phase 3: `p3-catalog` first (Codex probe first; gpt-5.5 has been dead since 2026-10-14), then the wire
   batches in parallel. `p3-opencode-free` is the largest and most fragile.
4. Phase 4: pick per product priority.

Every batch: unit tests first, then the full suite and the live curl named in the item, then
`graphify update .` after code changes.
