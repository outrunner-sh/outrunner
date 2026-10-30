# Composer harness and model selection

The new-session form and every `WorkspaceSession` composer (ordinary chats,
Runners and Ships) use the same Harness / Model / Effort menu. Review's request
composer starts its existing metered review workflow; it does not expose an
arbitrary coding-runtime selection. No extra runtime is implied by a model
provider: the implemented harness IDs are `claude` and `codex`.

`lib/runtime/selection.ts` is shared by the form and cloud creation. An explicit
session choice wins. Otherwise the personal model loadout wins, then the
organization default where the person has no default, then an eligible runtime
catalog default or the first eligible model. Missing credentials can make a
saved default temporarily unavailable. The fallback does not rewrite settings;
an explicit unavailable request fails. Shared Outrunner models can store an
`agent` in the existing preference JSON; personal and Organization → Defaults
controls keep their existing authorization and storage scopes. Change defaults
opens `/settings/models`.

Own-account eligibility and billing ownership remain in `agentAuthStore` and
`resolveAgentAuth`: personal selections/credentials take precedence over shared
organization credentials, including the existing personal OpenAI-key precedence.
New-session menus use the selected repository’s organization.
Existing chats request a workspace-scoped model menu, independent of the
organization currently selected in the sidebar. Organization default
configuration discovers only shared Codex credentials,
never the viewing admin's personal account. Mac menus omit organization keys.

Codex ChatGPT-account suggestions and capabilities come from the selected
credential's native model catalog through the existing inference broker. Only
picker-visible IDs and reasoning levels the pinned Outrunner agent can express
are offered. For an API key, the current runtime registry's suggestions are
intersected with the key's accessible IDs. The API ID listing does not establish
reasoning or image capabilities, so those remain unknown and effort uses the
runtime default. Failed discovery offers no guessed account models. A Mac's own
CLI login currently has no model-discovery bridge; its account model choices are
therefore unavailable until discovery is supported. Existing recorded labels
and explicit effort remain intact. Generic gateway models use their provider's
existing registry and custom-ID support; Outrunner's paid list stays restricted.

The current direct Claude aliases support effort per the pinned CLI's model
configuration contract. See [Claude Code model configuration](https://code.claude.com/docs/en/model-config).
OpenAI likewise says model and reasoning choices are account/client-dependent;
see [Codex model discovery](https://learn.chatgpt.com/docs/app-server#models).

Creation sends provider, model, compatible effort and harness together. Its
optimistic workspace contains that exact selection before navigation, and the
server records the intended selection before setup and the applied selection
before starting the runtime. Old browser model/effort hints cannot override a
recorded session. During startup, queued input belongs to that recorded
harness/model/effort; prompts keep their own mode and attachment IDs. The picker
stays inspectable, with selection changes held until the initial send and startup
queue settle, so a retry cannot silently run under another selection. Start over
carries the explicit harness as well as provider/model/effort, and transfers the
waiting queue, initial prompt and unsent draft/attachments to the replacement.
Resume preserves explicit recorded effort. Runner overrides
and cross-harness forks resolve compatible choices instead of inheriting an
unrelated model or effort.

A running chat's harness cannot be changed in place. The menu's **Fork with …**
action uses the existing chat API and runtime transcript handoff in the same
worktree. The original conversation and files remain. A successful fork moves
its unsent draft and uploaded attachments to the new chat; failed forks keep
them in place. Uploads, active prompt edits, working turns and disconnected
sessions prevent this operation. Missions and local sessions explain that
harness forking is unavailable. Capability checks and authentication occur
before runtime start; failure removes only the newly created chat.

A fresh chat starts with the harness, model and effort saved for the chat the
user is currently viewing. The server rereads that selection when the chat is
created, so a model change or harness handoff made after the header loaded is
not lost. When the user explicitly chooses another harness, its newest saved
setup in the session is reused; a harness not used there yet starts from its
configured eligible default.

The isolated browser fixtures in `test/browser` exercise real new-session and
WorkspaceStudio composers at desktop and mobile sizes. Their APIs and runtime
responses are synthetic; they do not validate provider inference or create
cloud computers. `.context/selection/routing-*.json` records the actual client
payloads, the model requests built by production routing helpers, and simulated
stored results. Production Codex startup/crash verification is separate work.
