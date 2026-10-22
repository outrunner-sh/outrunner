package claude

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Gateway is an Anthropic-compatible endpoint a session can run through, on a
// key of its own, instead of the user's Claude login.
type Gateway string

const (
	// NoGateway runs on the user's own Claude credential.
	NoGateway Gateway = ""
	// OpenRouter serves Claude, GLM and other models behind one key: the
	// gateway Outrunner's own models run through.
	OpenRouter Gateway = "openrouter"
	// Anthropic is Anthropic's own API, on the user's key: Claude's models.
	Anthropic Gateway = "anthropic"
)

// SpeaksAsOutrunner reports whether a session through g is told it is
// Outrunner's agent (Identity) rather than left calling itself Claude Code:
// any gateway but Anthropic's, as those serve other companies' models (GLM,
// Kimi, DeepSeek), which Claude Code's own prompt would otherwise have claim
// to be Claude. A session on the user's own Claude, or on Anthropic's API, is
// Claude, and says so.
func (g Gateway) SpeaksAsOutrunner() bool {
	return g != NoGateway && g != Anthropic
}

// The variables Claude reads a gateway's key from: a bearer token for most,
// an API key for Anthropic's own API.
const (
	authTokenEnv = "ANTHROPIC_AUTH_TOKEN"
	apiKeyEnv    = "ANTHROPIC_API_KEY"
)

// gateway is one entry of providers.json.
type gateway struct {
	BaseURL string `json:"baseURL"`
	KeyEnv  string `json:"keyEnv"`
}

// providers.json is the one list of gateways, shared with the web app, which
// imports it for the providers a user can bring a key for. Compiled in, and
// never taken from a request: a page that could choose the URL could have
// Claude send the user's code anywhere.
//
//go:embed providers.json
var providersJSON []byte

var gateways = mustParseGateways(providersJSON)

// mustParseGateways reads providers.json, refusing anything but https
// endpoints and the two key variables: a mistake there is a build that
// mustn't ship, so it panics at start (and fails the tests) rather than at a
// session's launch.
func mustParseGateways(data []byte) map[Gateway]gateway {
	var parsed map[Gateway]gateway
	if err := json.Unmarshal(data, &parsed); err != nil {
		panic(fmt.Sprintf("providers.json: %v", err))
	}
	for id, g := range parsed {
		if id == NoGateway || !strings.HasPrefix(g.BaseURL, "https://") || (g.KeyEnv != authTokenEnv && g.KeyEnv != apiKeyEnv) {
			panic(fmt.Sprintf("providers.json: bad gateway %q: %+v", id, g))
		}
	}
	return parsed
}

// Gateways lists the gateways this agent can run a session through, sorted,
// for the web app to offer only what it supports.
func Gateways() []Gateway {
	ids := make([]Gateway, 0, len(gateways))
	for id := range gateways {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// GatewayKeyEnvs are the variables any gateway's key can be in, for finding
// keys to redact.
func GatewayKeyEnvs() []string {
	return []string{authTokenEnv, apiKeyEnv}
}

// ParseGateway validates a requested gateway; empty is none.
func ParseGateway(raw string) (Gateway, error) {
	g := Gateway(raw)
	if g == NoGateway {
		return g, nil
	}
	if _, ok := gateways[g]; !ok {
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
// the gateway's name one it knows. The key goes in the gateway's own variable,
// and the other one can't compete with it: a bearer-token gateway gets
// ANTHROPIC_API_KEY set empty, as OpenRouter requires (a key left in the
// environment would win over the token), and an API-key gateway gets
// ANTHROPIC_AUTH_TOKEN unset. A Claude login token is unset for the same
// reason.
//
// What the key reaches: Claude's environment, and so every command Claude runs
// (a Bash tool call that prints its environment shows it). Terminal output is
// redacted of it (RedactionSecrets), but the conversation stream and the
// archived conversation are not, the same as for a Claude login token.
func GatewayEnv(g Gateway, token, model string) (set map[string]string, unset []string) {
	gw := gateways[g]
	set = map[string]string{
		"ANTHROPIC_BASE_URL":             gw.BaseURL,
		gw.KeyEnv:                        token,
		"ANTHROPIC_MODEL":                model,
		"ANTHROPIC_CUSTOM_MODEL_OPTION":  model,
		"ANTHROPIC_DEFAULT_OPUS_MODEL":   model,
		"ANTHROPIC_DEFAULT_SONNET_MODEL": model,
		"ANTHROPIC_DEFAULT_HAIKU_MODEL":  model,
		"CLAUDE_CODE_SUBAGENT_MODEL":     model,
	}
	unset = []string{"CLAUDE_CODE_OAUTH_TOKEN"}
	if gw.KeyEnv == authTokenEnv {
		set[apiKeyEnv] = ""
	} else {
		unset = append(unset, authTokenEnv)
	}
	return set, unset
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
