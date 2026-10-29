package codex

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestAccountConfigOwnsNoProviderRefresh(t *testing.T) {
	raw, _ := json.Marshal(map[string]string{"url": "https://app.example/api/runtime/codex", "bearer": "synthetic-outrunner-grant"})
	config, auth, err := AccountConfig(base64.RawURLEncoding.EncodeToString(raw))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(config, "supports_websockets = false") || !strings.Contains(config, "requires_openai_auth = true") {
		t.Fatal(config)
	}
	var login struct {
		Mode   string            `json:"auth_mode"`
		Tokens map[string]string `json:"tokens"`
	}
	if json.Unmarshal([]byte(auth), &login) != nil || login.Mode != "chatgptAuthTokens" || login.Tokens["refresh_token"] != "" || login.Tokens["access_token"] != "synthetic-outrunner-grant" {
		t.Fatal("wrong host-managed login")
	}
	for _, url := range []string{"https://app.example/other", "http://evil.example/api/runtime/codex", "https://user@app.example/api/runtime/codex", "https://app.example/api/runtime/codex?q=x"} {
		raw, _ := json.Marshal(map[string]string{"url": url, "bearer": "synthetic-outrunner-grant"})
		if _, _, err := AccountConfig(base64.RawURLEncoding.EncodeToString(raw)); err == nil {
			t.Fatal("accepted invalid broker", url)
		}
	}
}
