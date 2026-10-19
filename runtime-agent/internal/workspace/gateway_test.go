package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"runtime-agent/internal/claude"
)

// Every gateway in providers.json, so one added there is covered here too.
func TestEveryGatewaysKeyIsMaskedFromItsOwnVariable(t *testing.T) {
	t.Parallel()
	for _, g := range claude.Gateways() {
		t.Run(string(g), func(t *testing.T) {
			t.Parallel()
			s, _, id := runningSession(t, "sonnet")
			key := "sk-" + string(g) + "-key-0123456789abcdef"
			if err := s.SetModel(context.Background(), id, ModelChoice{Model: "some/model", Gateway: g, Token: key}, ""); err != nil {
				t.Fatalf("SetModel: %v", err)
			}
			set, _ := claude.GatewayEnv(g, key, "some/model")
			for name, value := range set {
				if value == key && !strings.Contains(s.readGatewayEnv(id), "export "+name+"='"+key+"'") {
					t.Errorf("gateway file lacks the key in %s", name)
				}
			}
			if !slices.Contains(s.RedactionSecrets(), key) {
				t.Errorf("the %s key is not redacted from terminal output", g)
			}
			if !slices.Contains(NewService(s.Root).RedactionSecrets(), key) {
				t.Errorf("after a restart the %s key is not redacted", g)
			}
		})
	}
}

func TestOldKeysStayMaskedUntilTheSessionIsForgotten(t *testing.T) {
	t.Parallel()
	s, _, id := runningSession(t, "sonnet")
	ctx := context.Background()
	const first = "sk-or-v1-first-0123456789abcdef"
	const second = "sk-ant-api03-second-0123456789abcdef"
	if err := s.SetModel(ctx, id, ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: first}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	// The key rotated, on another gateway, then back to the user's Claude: the
	// resumed conversation can still redraw either key.
	if err := s.SetModel(ctx, id, ModelChoice{Model: "claude-opus-5", Gateway: "anthropic", Token: second}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	if err := s.SetModel(ctx, id, ModelChoice{Model: "opus"}, ""); err != nil {
		t.Fatalf("SetModel back: %v", err)
	}
	// A crash mid-write leaves a half-written file holding a key.
	const crashed = "sk-or-v1-crashed-0123456789abcdef"
	if err := os.WriteFile(s.gatewayEnvPath(id)+".tmp", []byte("export ANTHROPIC_AUTH_TOKEN='"+crashed+"'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	secrets := s.RedactionSecrets()
	for _, key := range []string{first, second, crashed} {
		if !slices.Contains(secrets, key) {
			t.Errorf("%s is no longer masked", key)
		}
	}
	if info, err := os.Stat(s.retiredGatewayPath(id)); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("retired keys file = %v, %v; want it owner-only", info, err)
	}

	s.forgetWorkspace(id)
	secrets = s.RedactionSecrets()
	for _, key := range []string{first, second, crashed} {
		if slices.Contains(secrets, key) {
			t.Errorf("%s outlived its session", key)
		}
	}
}

func TestAGatewaySessionWithoutItsKeyFileRefusesToLaunch(t *testing.T) {
	t.Parallel()
	s, fake, id := runningSession(t, "sonnet")
	ctx := context.Background()
	if err := s.SetModel(ctx, id, ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: "sk-or-v1-lost-0123456789abcdef"}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	_ = fake.KillSession(ctx, sessionName(id))
	if err := os.Remove(s.gatewayEnvPath(id)); err != nil {
		t.Fatal(err)
	}
	launches := len(fake.launches)

	if _, err := s.Start(ctx, id, ""); !errors.Is(err, ErrGatewayKeyMissing) {
		t.Errorf("Start = %v, want ErrGatewayKeyMissing", err)
	}
	if _, err := s.Resume(ctx, id, ""); !errors.Is(err, ErrGatewayKeyMissing) {
		t.Errorf("Resume = %v, want ErrGatewayKeyMissing", err)
	}
	if len(fake.launches) != launches {
		t.Errorf("Claude was launched without its key file: %q", fake.lastLaunch())
	}
}

func TestARetiredKeysFileCutShortStillMasksEveryKey(t *testing.T) {
	t.Parallel()
	s, _, id := runningSession(t, "sonnet")
	ctx := context.Background()
	const kept = "sk-or-v1-kept-0123456789abcdef"
	const next = "sk-or-v1-next-0123456789abcdef"
	const last = "sk-or-v1-last-0123456789abcdef"
	// A retired file whose last line lost its newline (written by an append
	// that stopped short), then a crash mid-rewrite leaving a .tmp beside it.
	if err := os.MkdirAll(filepath.Dir(s.retiredGatewayPath(id)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.retiredGatewayPath(id), []byte("export ANTHROPIC_AUTH_TOKEN='"+kept+"'"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.retiredGatewayPath(id)+".tmp", []byte("export ANTHROPIC_AUTH_TOKEN='sk-or-v1-ha"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{next, last} {
		if err := s.SetModel(ctx, id, ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: key}, ""); err != nil {
			t.Fatalf("SetModel: %v", err)
		}
	}
	secrets := s.RedactionSecrets()
	for _, key := range []string{kept, next, last} {
		if !slices.Contains(secrets, key) {
			t.Errorf("%s is not masked; masked: %q", key, secrets)
		}
	}
	s.forgetWorkspace(id)
	if _, err := os.Stat(s.retiredGatewayPath(id) + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("a half-written retired file outlived its session: %v", err)
	}
}
