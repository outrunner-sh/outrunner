package workspace

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestCodexAccountRestartAndAPIKeyReplacement(t *testing.T) {
	t.Parallel()
	s, fake, id := codexSession(t, CreateInput{WorkspaceID: "ws-account", Branch: "b"})
	raw, _ := json.Marshal(map[string]string{"url": "https://app.example/api/runtime/codex", "bearer": "synthetic-outrunner-grant"})
	grant := base64.RawURLEncoding.EncodeToString(raw)
	ctx := context.Background()
	if err := s.SetAuth(ctx, id, AuthCodexAccount, grant); err != nil {
		t.Fatal(err)
	}
	restarted := NewService(s.Root)
	restarted.env, restarted.tmux, restarted.lookPath = s.env, fake, s.lookPath
	restarted.runCommand = func(context.Context, []string, string, ...string) ([]byte, error) {
		t.Fatal("account mode must not run a provider login/refresh on the computer")
		return nil, nil
	}
	if _, err := restarted.Start(ctx, id, ""); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { restarted.stopRecorder(ctx, id); restarted.stopCodexTail(id) })
	authPath := filepath.Join(s.codexHome(id), "auth.json")
	raw, err := os.ReadFile(authPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"auth_mode":"chatgptAuthTokens"`) || !strings.Contains(string(raw), `"refresh_token":""`) {
		t.Fatal("computer has wrong account mode")
	}
	argv := strings.Join(fake.lastLaunch(), " ")
	if strings.Contains(argv, grant) || strings.Contains(argv, "synthetic-outrunner-grant") || !strings.Contains(argv, "-u OUTRUNNER_CODEX_GRANT") {
		t.Fatal("grant exposed in launch/environment")
	}
	if !slices.Contains(restarted.RedactionSecrets(), grant) || !slices.Contains(restarted.RedactionSecrets(), "synthetic-outrunner-grant") {
		t.Fatal("grant not redacted")
	}
	if err := restarted.SetAuth(ctx, id, AuthOpenAIAPIKey, testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(authPath); !os.IsNotExist(err) {
		t.Fatal("old account cache kept after API-key selection")
	}
	if restarted.authFiles().value(id, "OUTRUNNER_CODEX_GRANT") != "" {
		t.Fatal("old grant remains active")
	}
}
