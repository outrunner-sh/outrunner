package codex

import (
	"strings"

	"runtime-agent/internal/claude"
)

// A Codex session can run another company's model through a gateway, as a
// Claude session can: Outrunner's own models (GLM, Kimi, DeepSeek) through
// OpenRouter, on Outrunner's key. Codex speaks OpenAI's Responses API, not
// Anthropic's, so only a gateway that serves it can be one: OpenRouter does,
// at its /v1 endpoint (claude.OpenRouter's is the Anthropic one). Codex no
// longer takes the Chat Completions API (0.146.0 refuses `wire_api = "chat"`
// at start), so Responses is the only wire.

// gatewayURLs are the Responses endpoints of the gateways Codex runs through.
// Compiled in and never taken from a request, like providers.json: a page
// that could choose the URL could have Codex send the user's code anywhere.
var gatewayURLs = map[claude.Gateway]string{
	claude.OpenRouter: "https://openrouter.ai/api/v1",
}

// gatewayNames are what Codex shows for each ("provider: OpenRouter").
var gatewayNames = map[claude.Gateway]string{
	claude.OpenRouter: "OpenRouter",
}

// RunsThrough reports whether Codex can run a session through g.
func RunsThrough(g claude.Gateway) bool {
	_, ok := gatewayURLs[g]
	return ok
}

// ProviderConfig is the config.toml that puts Codex on g with token: its
// model_provider, then that provider's table. It starts with a top-level key,
// so it goes before any other table in the file.
//
// The key is the provider's bearer token, in the file, rather than named by
// env_key: Codex passes its whole environment to every command it runs (its
// shell_environment_policy excludes are not applied to them as of 0.146.0),
// so a key in its environment would be in the session's. The file is in the
// session's own Codex home, owner-only. "" for a gateway Codex can't run
// through.
func ProviderConfig(g claude.Gateway, token string) string {
	url, ok := gatewayURLs[g]
	if !ok {
		return ""
	}
	id := TOMLString(string(g))
	var b strings.Builder
	b.WriteString("model_provider = " + id + "\n\n")
	b.WriteString("[model_providers." + id + "]\n")
	b.WriteString("name = " + TOMLString(gatewayNames[g]) + "\n")
	b.WriteString("base_url = " + TOMLString(url) + "\n")
	b.WriteString("wire_api = \"responses\"\n")
	b.WriteString("experimental_bearer_token = " + TOMLString(token) + "\n")
	return b.String()
}

// Identity is claude.Identity in Codex's terms: Codex's own instructions say
// it is Codex, made by OpenAI, which GLM or Kimi would otherwise repeat to a
// user who asks who it is.
//
// It names no model, as claude.Identity does. Codex sends its developer
// instructions to the model once, when the conversation starts: a resume
// records new ones but doesn't send them, and a switch sends only Codex's own
// prompt (as checked on a real box with 0.128.0 and 0.146.0). A model named
// would stay the first one after any switch, and the answer would be wrong.
func Identity() string {
	return claude.IdentityOver("Codex or a GPT model", "OpenAI", "") +
		" If the user asks which model you run on, say Outrunner's model menu for this session shows it: the session can switch models, so don't name one, and don't claim to be a GPT model."
}
