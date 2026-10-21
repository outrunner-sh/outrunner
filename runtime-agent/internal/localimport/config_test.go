package localimport

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// The user's setup is offered by name, MCP servers that only run on this Mac
// say so, no key is in the scan; a capture archives what was picked (no
// links) and reads the picked servers in full.
func TestConfigIsOfferedByNameAndCapturedAsPicked(t *testing.T) {
	home, _ := testHome(t)
	writeFile(t, filepath.Join(home, ".claude", "CLAUDE.md"), "be brief")
	writeFile(t, filepath.Join(home, ".claude", "skills", "review", "SKILL.md"), "review")
	writeFile(t, filepath.Join(home, ".claude", "skills", "review", "scripts", "run.sh"), "echo")
	if err := os.Symlink("/etc/passwd", filepath.Join(home, ".claude", "skills", "review", "passwd")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(home, ".claude", "agents", "scout.md"), "scout")
	writeFile(t, filepath.Join(home, ".claude", "commands", "git", "ship.md"), "ship")
	writeFile(t, filepath.Join(home, ".codex", "AGENTS.md"), "rules")
	writeFile(t, filepath.Join(home, ".claude.json"), `{"mcpServers": {
		"remote": {"type": "http", "url": "https://mcp.example/mcp", "headers": {"Authorization": "Bearer secret-remote-token"}},
		"npm": {"command": "npx", "args": ["-y", "@acme/mcp"], "env": {"ACME_KEY": "secret-acme-key"}},
		"local-bin": {"command": "/Applications/Tool.app/server"},
		"local-script": {"command": "npx", "args": ["tsx", "/Users/ada/mcp/server.ts"]},
		"local-http": {"type": "http", "url": "http://localhost:3845/mcp"}
	}}`)
	writeFile(t, filepath.Join(home, ".claude", "settings.json"), `{"enabledPlugins": {"review@market": true, "off@market": false}, "hooks": {"Stop": []}}`)

	config := scanConfig(home)
	data, _ := json.Marshal(config)
	for _, secret := range []string{"secret-remote-token", "secret-acme-key"} {
		if strings.Contains(string(data), secret) {
			t.Errorf("the scan carries a key: %s", secret)
		}
	}
	var ids []string
	for _, item := range config.Items {
		ids = append(ids, item.ID)
	}
	sort.Strings(ids)
	if want := []string{"agent:scout", "agents-md", "claude-md", "command:git/ship", "skill:review"}; !reflect.DeepEqual(ids, want) {
		t.Errorf("items = %v, want %v", ids, want)
	}
	skipped := map[string]bool{}
	for _, server := range config.MCPServers {
		skipped[server.Name] = server.Skip != nil
	}
	if want := map[string]bool{"remote": false, "npm": false, "local-bin": true, "local-script": true, "local-http": true}; !reflect.DeepEqual(skipped, want) {
		t.Errorf("unportable = %v, want %v", skipped, want)
	}
	if !reflect.DeepEqual(config.Plugins, []string{"review@market"}) {
		t.Errorf("plugins = %v", config.Plugins)
	}

	out := t.TempDir()
	capture, err := CaptureConfig(home, ConfigPick{Items: []string{"claude-md", "skill:review"}, MCP: []string{"remote"}, Plugins: true}, out)
	if err != nil {
		t.Fatal(err)
	}
	if got := archiveNames(t, capture.Archive.Path); !reflect.DeepEqual(got, []string{
		".claude/CLAUDE.md", ".claude/skills/review/", ".claude/skills/review/SKILL.md",
		".claude/skills/review/scripts/", ".claude/skills/review/scripts/run.sh",
	}) {
		t.Errorf("archive = %v", got)
	}
	if !strings.Contains(string(capture.MCPServers["remote"]), "secret-remote-token") || len(capture.MCPServers) != 1 {
		t.Errorf("MCP servers = %s", capture.MCPServers)
	}
	if _, ok := capture.Settings["enabledPlugins"]; !ok || capture.Settings["hooks"] != nil {
		t.Errorf("settings = %s", capture.Settings)
	}
	for _, pick := range []ConfigPick{{MCP: []string{"local-bin"}}, {MCP: []string{"nope"}}, {Items: []string{"skill:../../.ssh"}}} {
		if _, err := CaptureConfig(home, pick, t.TempDir()); err == nil {
			t.Errorf("captured %+v, which the scan didn't offer", pick)
		}
	}
}

func archiveNames(t *testing.T, path string) []string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	var names []string
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		names = append(names, h.Name)
	}
	sort.Strings(names)
	return names
}
