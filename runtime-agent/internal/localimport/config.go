package localimport

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// AgentConfig is what of the user's own agent setup could follow them to the
// cloud: Claude Code's CLAUDE.md, skills, subagents and slash commands, Codex's
// AGENTS.md, Claude's MCP servers and plugins. A scan gives names; an MCP
// server's environment and headers (its keys) only by name.
type AgentConfig struct {
	Items      []ConfigItem `json:"items"`
	MCPServers []MCPServer  `json:"mcpServers"`
	// Plugins are the Claude Code plugins the user enabled.
	Plugins []string `json:"plugins"`
}

// ConfigItem is a file or folder of the user's agent setup.
type ConfigItem struct {
	// ID names it for a capture: "<kind>:<name>", or the kind alone for
	// CLAUDE.md and AGENTS.md.
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Name string `json:"name"`
	// Path is where it is under the home folder.
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
	// Omitted counts links in it, which are not taken.
	Omitted int   `json:"omitted,omitempty"`
	Skip    *Skip `json:"skip,omitempty"`
}

// MCPServer is one of Claude Code's user-wide MCP servers.
type MCPServer struct {
	Name      string `json:"name"`
	Transport string `json:"transport"`
	Command   string `json:"command,omitempty"`
	URL       string `json:"url,omitempty"`
	// EnvNames and HeaderNames are its secrets' names; their values come
	// only in a capture.
	EnvNames    []string `json:"envNames"`
	HeaderNames []string `json:"headerNames"`
	// Skip is a server that only runs on this Mac.
	Skip *Skip `json:"skip,omitempty"`
}

// The kinds of ConfigItem.
const (
	ConfigClaudeMD = "claude-md"
	ConfigSkill    = "skill"
	ConfigAgent    = "agent"
	ConfigCommand  = "command"
	ConfigAgentsMD = "agents-md"
)

const (
	// maxConfigItemBytes is the largest item offered; maxConfigBytes all of
	// them together in a capture.
	maxConfigItemBytes = 10 << 20
	maxConfigBytes     = 50 << 20
	// ConfigArchiveName is the archive a config capture writes.
	ConfigArchiveName = "agent-config.tar.gz"
)

// scanConfig finds the user's agent setup. Anything unreadable is left out.
func scanConfig(home string) AgentConfig {
	config := AgentConfig{Items: []ConfigItem{}, MCPServers: []MCPServer{}, Plugins: []string{}}
	add := func(kind, name, rel string) {
		bytes, omitted, err := treeSize(filepath.Join(home, rel))
		if err != nil {
			return
		}
		id := kind + ":" + name
		if kind == ConfigClaudeMD || kind == ConfigAgentsMD {
			id = kind // one of each
		}
		item := ConfigItem{ID: id, Kind: kind, Name: name, Path: rel, Bytes: bytes, Omitted: omitted}
		if bytes > maxConfigItemBytes {
			item.Skip = &Skip{Reason: SkipTooLarge, Detail: "over 10 MB"}
		}
		config.Items = append(config.Items, item)
	}
	if fileExists(filepath.Join(home, ".claude", "CLAUDE.md")) {
		add(ConfigClaudeMD, "CLAUDE.md", filepath.Join(".claude", "CLAUDE.md"))
	}
	for _, dir := range readDirNames(filepath.Join(home, ".claude", "skills"), true) {
		add(ConfigSkill, dir, filepath.Join(".claude", "skills", dir))
	}
	for _, file := range readDirNames(filepath.Join(home, ".claude", "agents"), false) {
		if strings.HasSuffix(file, ".md") {
			add(ConfigAgent, strings.TrimSuffix(file, ".md"), filepath.Join(".claude", "agents", file))
		}
	}
	commands := filepath.Join(home, ".claude", "commands")
	_ = filepath.WalkDir(commands, func(path string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() && strings.HasSuffix(d.Name(), ".md") {
			rel, _ := filepath.Rel(commands, path)
			add(ConfigCommand, strings.TrimSuffix(filepath.ToSlash(rel), ".md"), filepath.Join(".claude", "commands", rel))
		}
		return nil
	})
	if fileExists(filepath.Join(home, ".codex", "AGENTS.md")) {
		add(ConfigAgentsMD, "AGENTS.md", filepath.Join(".codex", "AGENTS.md"))
	}

	servers, _ := userMCPServers(home)
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		config.MCPServers = append(config.MCPServers, describeMCP(home, name, servers[name]))
	}
	settings := claudeSettings(home)
	for name, enabled := range settings.EnabledPlugins {
		if on, _ := enabled.(bool); on {
			config.Plugins = append(config.Plugins, name)
		}
	}
	sort.Strings(config.Plugins)
	return config
}

// ConfigCapture is what of the user's setup was picked: an archive of the
// files (laid out as under their home), and the MCP servers and plugin
// settings in full, keys and all.
type ConfigCapture struct {
	Archive    *Artifact                  `json:"archive,omitempty"`
	Items      []string                   `json:"items"`
	MCPServers map[string]json.RawMessage `json:"mcpServers"`
	// Settings are Claude Code settings the plugins need: enabledPlugins and
	// extraKnownMarketplaces.
	Settings map[string]json.RawMessage `json:"settings"`
}

// ConfigPick is what of the setup to capture.
type ConfigPick struct {
	Items   []string
	MCP     []string
	Plugins bool
}

// CaptureConfig writes the picked items into an archive in out and reads the
// picked MCP servers and plugin settings. Only what a scan offers is taken.
func CaptureConfig(home string, pick ConfigPick, out string) (ConfigCapture, error) {
	config := scanConfig(home)
	capture := ConfigCapture{Items: []string{}, MCPServers: map[string]json.RawMessage{}, Settings: map[string]json.RawMessage{}}

	var paths []string
	var total int64
	for _, id := range pick.Items {
		item, ok := findItem(config.Items, id)
		if !ok || item.Skip != nil {
			return ConfigCapture{}, fmt.Errorf("%s is not something the scan offered", id)
		}
		total += item.Bytes
		paths = append(paths, item.Path)
		capture.Items = append(capture.Items, id)
	}
	if total > maxConfigBytes {
		return ConfigCapture{}, &SkipError{Skip: Skip{Reason: SkipTooLarge, Detail: "the picked settings are over 50 MB"}}
	}
	if len(paths) > 0 {
		archive, err := writeConfigArchive(home, paths, filepath.Join(out, ConfigArchiveName))
		if err != nil {
			return ConfigCapture{}, err
		}
		capture.Archive = &archive
	}

	if len(pick.MCP) > 0 {
		servers, err := userMCPServers(home)
		if err != nil {
			return ConfigCapture{}, err
		}
		for _, name := range pick.MCP {
			raw, ok := servers[name]
			if !ok || describeMCP(home, name, raw).Skip != nil {
				return ConfigCapture{}, fmt.Errorf("MCP server %s is not one the scan offered", name)
			}
			capture.MCPServers[name] = raw
		}
	}
	if pick.Plugins {
		settings := claudeSettings(home)
		for _, key := range []string{"enabledPlugins", "extraKnownMarketplaces"} {
			if raw, ok := settings.Raw[key]; ok {
				capture.Settings[key] = raw
			}
		}
	}
	return capture, nil
}

func findItem(items []ConfigItem, id string) (ConfigItem, bool) {
	for _, item := range items {
		if item.ID == id {
			return item, true
		}
	}
	return ConfigItem{}, false
}

// writeConfigArchive archives the paths (under home) as a gzipped tar of
// regular files and folders, named as under home; links are left out.
func writeConfigArchive(home string, paths []string, dst string) (Artifact, error) {
	file, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return Artifact{}, err
	}
	digest := sha256.New()
	counted := &countingWriter{w: io.MultiWriter(file, digest)}
	gz := gzip.NewWriter(counted)
	tw := tar.NewWriter(gz)
	werr := func() error {
		for _, rel := range paths {
			err := filepath.WalkDir(filepath.Join(home, rel), func(path string, d fs.DirEntry, err error) error {
				if err != nil {
					return err
				}
				if !d.IsDir() && !d.Type().IsRegular() {
					return nil // a link, a socket: not taken
				}
				info, err := d.Info()
				if err != nil {
					return err
				}
				name, _ := filepath.Rel(home, path)
				header := &tar.Header{Name: filepath.ToSlash(name), Mode: int64(info.Mode().Perm()), ModTime: info.ModTime()}
				if d.IsDir() {
					header.Typeflag, header.Name = tar.TypeDir, header.Name+"/"
					return tw.WriteHeader(header)
				}
				header.Typeflag, header.Size = tar.TypeReg, info.Size()
				if err := tw.WriteHeader(header); err != nil {
					return err
				}
				src, err := os.Open(path)
				if err != nil {
					return err
				}
				defer src.Close()
				_, err = io.CopyN(tw, src, info.Size())
				return err
			})
			if err != nil {
				return err
			}
		}
		if err := tw.Close(); err != nil {
			return err
		}
		return gz.Close()
	}()
	if cerr := file.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		os.Remove(dst)
		return Artifact{}, fmt.Errorf("archive the settings: %w", werr)
	}
	return Artifact{Name: ConfigArchiveName, Path: dst, SHA256: digestString(digest), Size: counted.n, Encoding: EncodingGzip}, nil
}

// userMCPServers are the MCP servers in ~/.claude.json, user-wide.
func userMCPServers(home string) (map[string]json.RawMessage, error) {
	data, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	if os.IsNotExist(err) {
		return map[string]json.RawMessage{}, nil
	}
	if err != nil {
		return nil, err
	}
	var config struct {
		MCPServers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}
	if config.MCPServers == nil {
		config.MCPServers = map[string]json.RawMessage{}
	}
	return config.MCPServers, nil
}

// portableCommands run an MCP server a cloud computer can run too: each
// fetches its package itself.
var portableCommands = map[string]bool{"npx": true, "bunx": true, "pnpm": true, "yarn": true}

// describeMCP says what an MCP server is, and whether it can run on a cloud
// computer: a remote one can; a local one only through a package runner, and
// never one that names something on this Mac.
func describeMCP(home, name string, raw json.RawMessage) MCPServer {
	var c struct {
		Type    string            `json:"type"`
		Command string            `json:"command"`
		Args    []string          `json:"args"`
		URL     string            `json:"url"`
		Env     map[string]string `json:"env"`
		Headers map[string]string `json:"headers"`
	}
	server := MCPServer{Name: name, EnvNames: []string{}, HeaderNames: []string{}}
	if err := json.Unmarshal(raw, &c); err != nil {
		server.Skip = &Skip{Reason: SkipUnportableMCP, Detail: "its settings can't be read"}
		return server
	}
	for k := range c.Env {
		server.EnvNames = append(server.EnvNames, k)
	}
	for k := range c.Headers {
		server.HeaderNames = append(server.HeaderNames, k)
	}
	sort.Strings(server.EnvNames)
	sort.Strings(server.HeaderNames)

	if c.URL != "" {
		server.Transport, server.URL = c.Type, c.URL
		if server.Transport == "" {
			server.Transport = "http"
		}
		if u, err := url.Parse(c.URL); err != nil || localHost(u.Hostname()) {
			server.Skip = &Skip{Reason: SkipUnportableMCP, Detail: "it is served on this Mac"}
		}
		return server
	}
	server.Transport, server.Command = "stdio", c.Command
	base := filepath.Base(c.Command)
	switch {
	case c.Command == "":
		server.Skip = &Skip{Reason: SkipUnportableMCP, Detail: "it has no command"}
	case !portableCommands[base] || strings.ContainsRune(c.Command, '/'):
		server.Skip = &Skip{Reason: SkipUnportableMCP, Detail: "it runs " + c.Command + ", which only this Mac has"}
	default:
		for _, arg := range c.Args {
			if strings.HasPrefix(arg, "/") || strings.HasPrefix(arg, "~") || strings.HasPrefix(arg, "./") || strings.HasPrefix(arg, home) {
				server.Skip = &Skip{Reason: SkipUnportableMCP, Detail: "it reads " + arg + " on this Mac"}
				break
			}
		}
	}
	return server
}

func localHost(host string) bool {
	return host == "localhost" || host == "::1" || strings.HasPrefix(host, "127.") || strings.HasSuffix(host, ".local") || host == "0.0.0.0"
}

// settingsFile is Claude Code's ~/.claude/settings.json, as far as read.
type settingsFile struct {
	EnabledPlugins map[string]any
	Raw            map[string]json.RawMessage
}

func claudeSettings(home string) settingsFile {
	settings := settingsFile{EnabledPlugins: map[string]any{}, Raw: map[string]json.RawMessage{}}
	data, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil || json.Unmarshal(data, &settings.Raw) != nil {
		return settings
	}
	if raw, ok := settings.Raw["enabledPlugins"]; ok {
		_ = json.Unmarshal(raw, &settings.EnabledPlugins)
	}
	return settings
}

// treeSize is the bytes of a file or a folder's regular files, and how many
// links it has (which are not taken).
func treeSize(path string) (int64, int, error) {
	var size int64
	omitted := 0
	err := filepath.WalkDir(path, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&fs.ModeSymlink != 0 {
			omitted++
			return nil
		}
		if d.Type().IsRegular() {
			info, err := d.Info()
			if err != nil {
				return err
			}
			size += info.Size()
		}
		return nil
	})
	return size, omitted, err
}

// readDirNames are a folder's entries that are folders (dirs) or files.
func readDirNames(dir string, dirs bool) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if (dirs && e.IsDir()) || (!dirs && e.Type().IsRegular()) {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names
}
