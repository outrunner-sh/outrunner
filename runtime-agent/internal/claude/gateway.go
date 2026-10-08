package claude

import (
	"fmt"
	"strings"
)

// Gateway is an Anthropic-compatible endpoint a session can run through, on a
// key of its own, instead of the user's Claude login.
type Gateway string

const (
	// NoGateway runs on the user's own Claude credential.
	NoGateway Gateway = ""
	// OpenRouter serves Claude, GLM and other models behind one key.
	OpenRouter Gateway = "openrouter"
)

// gatewayBaseURLs is fixed per gateway, never taken from a request: a page that
// could choose the URL could have Claude send the user's code anywhere.
var gatewayBaseURLs = map[Gateway]string{
	OpenRouter: "https://openrouter.ai/api",
}

// ParseGateway validates a requested gateway; empty is none.
func ParseGateway(raw string) (Gateway, error) {
	g := Gateway(raw)
	if g == NoGateway {
		return g, nil
	}
	if _, ok := gatewayBaseURLs[g]; !ok {
		return "", fmt.Errorf("unknown gateway %q", raw)
	}
	return g, nil
}

// minGatewayTokenLen is shorter than any real key (OpenRouter's are 73
// characters). Every key is masked in every session's output, so a short one
// would mask that text wherever it appears on the machine.
const minGatewayTokenLen = 20

// ValidGatewayToken accepts a key as a gateway issues one: printable ASCII,
// no spaces, bounded. It is written into a shell-sourced file, quoted, but
// nothing that could need escaping is allowed in the first place.
func ValidGatewayToken(token string) bool {
	if len(token) < minGatewayTokenLen || len(token) > 400 {
		return false
	}
	for _, r := range token {
		if r <= ' ' || r > '~' || r == '\'' || r == '\\' {
			return false
		}
	}
	return true
}

// GatewayEnv is the environment that runs Claude through g on token, with model
// for every request (the main loop, background calls and subagents), so
// nothing falls back to a model the gateway's key is not meant to buy.
//
// The model is named through ANTHROPIC_MODEL, not --model: Claude refuses a
// name it does not know on the flag, and ANTHROPIC_CUSTOM_MODEL_OPTION makes
// the gateway's name one it knows. ANTHROPIC_API_KEY is set empty, as
// OpenRouter requires: a key left in the environment would win over the token.
// A Claude login token is unset for the same reason.
func GatewayEnv(g Gateway, token, model string) (set map[string]string, unset []string) {
	return map[string]string{
		"ANTHROPIC_BASE_URL":             gatewayBaseURLs[g],
		"ANTHROPIC_AUTH_TOKEN":           token,
		"ANTHROPIC_API_KEY":              "",
		"ANTHROPIC_MODEL":                model,
		"ANTHROPIC_CUSTOM_MODEL_OPTION":  model,
		"ANTHROPIC_DEFAULT_OPUS_MODEL":   model,
		"ANTHROPIC_DEFAULT_SONNET_MODEL": model,
		"ANTHROPIC_DEFAULT_HAIKU_MODEL":  model,
		"CLAUDE_CODE_SUBAGENT_MODEL":     model,
	}, []string{"CLAUDE_CODE_OAUTH_TOKEN"}
}

// WithEnvFile runs argv after sourcing a shell file of exports, so a gateway
// key reaches Claude's environment without ever being on a command line.
func WithEnvFile(argv []string, path string) []string {
	return append([]string{"sh", "-c", `. "$1" && shift && exec "$@"`, "sh", path}, argv...)
}

// ShellQuote single-quotes a value for a sourced file. Values here never hold a
// quote (ValidGatewayToken, ValidModel), so this is belt and braces.
func ShellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}
