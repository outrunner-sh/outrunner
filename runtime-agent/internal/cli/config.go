package cli

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// Config is what the CLI keeps between runs: the app it signed in to, and
// its token there. Only the owner can read it (0600), like ~/.netrc.
type Config struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	Login string `json:"login,omitempty"`
}

// ConfigPath is where the config lives: OUTRUNNER_CONFIG, or
// ~/.outrunner/cli.json beside the local sessions' folder.
func ConfigPath() (string, error) {
	if path := os.Getenv("OUTRUNNER_CONFIG"); path != "" {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".outrunner", "cli.json"), nil
}

// LoadConfig reads the config; none yet is an empty one.
func LoadConfig(path string) (Config, error) {
	var config Config
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return config, nil
	}
	if err != nil {
		return config, err
	}
	return config, json.Unmarshal(data, &config)
}

// SaveConfig writes the config where only this user can read it.
func SaveConfig(path string, config Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
