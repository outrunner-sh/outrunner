package codex

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"time"
)

// AccountConfig points native Codex at the Outrunner inference broker. The
// credential is an Outrunner grant, never a provider access or refresh token.
// chatgptAuthTokens is the CLI's host-managed mode: Codex must not renew it.
func AccountConfig(encoded string) (string, string, error) {
	var grant struct {
		URL    string `json:"url"`
		Bearer string `json:"bearer"`
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || json.Unmarshal(raw, &grant) != nil {
		return "", "", errors.New("invalid Codex connection")
	}
	u, err := url.Parse(grant.URL)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "/api/runtime/codex" ||
		(u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))) || len(grant.Bearer) < 20 {
		return "", "", errors.New("invalid Codex broker address")
	}
	config := "features.apps = false\nfeatures.plugins = false\nmodel_provider = \"outrunner-account\"\nchatgpt_base_url = " + TOMLString(grant.URL) + "\n\n" +
		"[model_providers.outrunner-account]\nname = \"ChatGPT via Outrunner\"\nbase_url = " + TOMLString(grant.URL) + "\nwire_api = \"responses\"\nrequires_openai_auth = true\nsupports_websockets = false\n"
	// A local identity tells Codex which protocol to use. It isn't a provider
	// identity assertion and is never forwarded upstream. The broker injects
	// the actual account id, with its fresh access token, after authorization.
	identity := "e30." + base64.RawURLEncoding.EncodeToString([]byte(`{"https://api.openai.com/auth":{"chatgpt_account_id":"outrunner"}}`)) + ".outrunner"
	auth, _ := json.Marshal(map[string]any{
		"auth_mode": "chatgptAuthTokens", "last_refresh": time.Now().UTC().Format(time.RFC3339),
		"tokens": map[string]string{"id_token": identity, "access_token": grant.Bearer, "refresh_token": "", "account_id": "outrunner"},
	})
	return config, string(auth), nil
}

// AccountBearer extracts the broker grant for redaction of active and retired
// credentials. API keys and other credential formats simply return empty.
func AccountBearer(encoded string) string {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return ""
	}
	var value struct {
		Bearer string `json:"bearer"`
	}
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return value.Bearer
}
