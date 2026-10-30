package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"runtime-agent/internal/ask"
	"runtime-agent/internal/claude"
)

// A Claude session asks the user for secrets through request_secrets (package
// ask); the values the user provides are the session's own, kept apart from
// its project's environment, which SetEnvironment replaces on a restore:
//
//   - $ROOT/provided/<id>.env, owner-only exports, sourced by every launch
//     after the project's environment (so a value provided wins) and masked
//     in the terminal like the session's credential (keyFiles);
//   - $ROOT/provided/<id>.json, the same values as JSON, so the next request
//     adds to them rather than parse the shell file back.
//
// Claude's SessionStart hook appends source commands to Claude's own
// CLAUDE_ENV_FILE. Each Bash call then reads the current project and provided
// files, including secrets supplied after Claude started, without depending
// on file watchers or Claude's cache invalidation.

// minMaskedProvided is the shortest provided value masked in the terminal:
// shorter than a project's variables' (minMaskedEnv), since every one is a
// secret the user typed in for that.
const minMaskedProvided = 6

// maxProvidedBytes bounds a session's provided values, as a project's
// environment is bounded.
const maxProvidedBytes = 256 << 10

func (s *Service) providedFiles() keyFiles {
	return keyFiles{dir: filepath.Join(s.Root, "provided")}
}

// ProvidedEnvPath is the file of a session's provided secrets: its
// CLAUDE_ENV_FILE, and what the tool's result tells the agent to source.
//
// A chat's are its session's (owner): a secret given in one chat is there
// for every other.
func (s *Service) ProvidedEnvPath(workspaceID string) string {
	return s.providedFiles().path(s.owner(workspaceID))
}

func (s *Service) providedJSONPath(workspaceID string) string {
	return filepath.Join(s.Root, "provided", s.owner(workspaceID)+".json")
}

// RequestSecrets waits for the user to answer a session's request for
// secrets, returned as the tool's text for its agent.
func (s *Service) RequestSecrets(ctx context.Context, workspaceID, requestID string, req ask.SecretRequest) (string, error) {
	if err := ask.ValidateSecretRequest(req, ValidEnvName); err != nil {
		return "", err
	}
	reply, err := s.secretAsks.Request(ctx, workspaceID, requestID, req)
	if err != nil {
		return "", err
	}
	return ask.FormatSecrets(req, reply), nil
}

// ProvideSecrets answers the request a session is waiting on, named by its
// variables (names, as the form showed them): values (some of them; a
// variable left out is not provided) are added to the session's own, or,
// skipped, none are. Values for variables the request didn't name are
// refused.
func (s *Service) ProvideSecrets(workspaceID string, names []string, values map[string]string, skipped bool) error {
	return s.secretAsks.Answer(workspaceID, names, func(req ask.SecretRequest) (ask.SecretReply, error) {
		if skipped {
			return ask.SecretReply{Skipped: true}, nil
		}
		var provided []string
		for name, value := range values {
			if !slices.Contains(names, name) {
				return ask.SecretReply{}, fmt.Errorf("%w: %s wasn't asked for", ErrInvalidEnvironment, name)
			}
			if value == "" {
				return ask.SecretReply{}, fmt.Errorf("%w: %s has no value", ErrInvalidEnvironment, name)
			}
			if strings.ContainsRune(value, 0) {
				return ask.SecretReply{}, fmt.Errorf("%w: %s's value holds a NUL byte", ErrInvalidEnvironment, name)
			}
			provided = append(provided, name)
		}
		for _, k := range req.Keys {
			if !k.Optional && values[k.Name] == "" {
				return ask.SecretReply{}, fmt.Errorf("%w: %s is required", ErrInvalidEnvironment, k.Name)
			}
		}
		if err := s.addProvided(workspaceID, values); err != nil {
			return ask.SecretReply{}, err
		}
		// Masked at once in the terminals and recordings already open, which
		// read RedactionSecrets when they started. The files are the source of
		// truth: the live list is what they hold, and the GitHub tokens
		// handed out (refreshLiveSecrets), no more.
		s.refreshLiveSecrets()
		// In the order asked for, as the result names them.
		sort.Slice(provided, func(i, j int) bool {
			return slices.Index(names, provided[i]) < slices.Index(names, provided[j])
		})
		return ask.SecretReply{Provided: provided, EnvFile: s.ProvidedEnvPath(workspaceID)}, nil
	})
}

// addProvided adds values to the session's provided secrets and rewrites
// its env file, which also moves the file Claude watches.
func (s *Service) addProvided(workspaceID string, values map[string]string) error {
	all := s.provided(workspaceID)
	for name, value := range values {
		all[name] = value
	}
	names := make([]string, 0, len(all))
	for name := range all {
		names = append(names, name)
	}
	sort.Strings(names)
	var content strings.Builder
	for _, name := range names {
		content.WriteString("export " + name + "=" + claude.ShellQuote(all[name]) + "\n")
	}
	if content.Len() > maxProvidedBytes {
		return fmt.Errorf("%w: too large", ErrInvalidEnvironment)
	}
	if err := writeJSONFile(s.providedJSONPath(workspaceID), all, 0o600); err != nil {
		return err
	}
	return s.providedFiles().put(s.owner(workspaceID), content.String())
}

// provided are the session's provided secrets, by name.
func (s *Service) provided(workspaceID string) map[string]string {
	all := map[string]string{}
	if data, err := os.ReadFile(s.providedJSONPath(workspaceID)); err == nil {
		_ = json.Unmarshal(data, &all)
	}
	return all
}

// providedTokens are the provided values worth masking, every session's:
// read from the JSON, which holds them exactly (a value with a quote, or on
// several lines), not the shell file.
func (s *Service) providedTokens() []string {
	files, _ := filepath.Glob(filepath.Join(s.Root, "provided", "*.json"))
	var tokens []string
	for _, file := range files {
		all := map[string]string{}
		if data, err := os.ReadFile(file); err == nil && json.Unmarshal(data, &all) == nil {
			for _, value := range all {
				if len(value) >= minMaskedProvided {
					tokens = append(tokens, value)
				}
			}
		}
	}
	return tokens
}

// withProvided has a launch source the session's provided secrets, after
// whatever it sources already.
func (s *Service) withProvided(workspaceID string, argv []string) []string {
	path := s.ProvidedEnvPath(workspaceID)
	if !fileExists(path) {
		return argv
	}
	return claude.WithEnvFile(argv, path)
}

// claudeSecretsLaunch makes the settings that load the project's environment
// and secrets provided while Claude runs. The source commands go in Claude's
// own hook env file, rather than overriding CLAUDE_ENV_FILE at launch.
func (s *Service) claudeSecretsLaunch(workspaceID string) string {
	settings := filepath.Join(s.Root, "ask", workspaceID+".settings.json")
	if err := writeJSONFile(settings, secretsSettings(s.envFiles().path(s.owner(workspaceID)), s.ProvidedEnvPath(workspaceID), userSettings()), 0o600); err != nil {
		return ""
	}
	return settings
}

// secretsSettings keeps the user's settings and hooks. Store references to
// our files, not their contents: Claude may cache the hook env file, while
// the referenced files must be read anew for every Bash command.
func secretsSettings(projectPath, providedPath string, user map[string]any) map[string]any {
	var source strings.Builder
	for _, path := range []string{projectPath, providedPath} {
		quoted := claude.ShellQuote(path)
		source.WriteString("if [ -f " + quoted + " ]; then . " + quoted + "; fi\n")
	}
	command := `if [ -n "$CLAUDE_ENV_FILE" ]; then printf '%s\n' ` + claude.ShellQuote(source.String()) + ` >> "$CLAUDE_ENV_FILE"; fi`
	settings := map[string]any{}
	for k, v := range user {
		settings[k] = v
	}
	hooks := map[string]any{}
	if theirs, ok := settings["hooks"].(map[string]any); ok {
		for k, v := range theirs {
			hooks[k] = v
		}
	}
	existing, _ := hooks["SessionStart"].([]any)
	hooks["SessionStart"] = append(append([]any{}, existing...), map[string]any{
		"hooks": []any{map[string]any{"type": "command", "command": command}},
	})
	settings["hooks"] = hooks
	return settings
}

// userSettings are the user's imported Claude settings, or none.
func userSettings() map[string]any {
	settings := map[string]any{}
	home, err := agentConfigHome()
	if err != nil {
		return settings
	}
	if data, err := os.ReadFile(settingsPath(home)); err == nil {
		_ = json.Unmarshal(data, &settings)
	}
	return settings
}

// removeProvided forgets a destroyed session's provided secrets.
func (s *Service) removeProvided(workspaceID string) {
	s.providedFiles().remove(workspaceID)
	_ = os.Remove(s.providedJSONPath(workspaceID))
	s.refreshLiveSecrets()
	_ = os.Remove(filepath.Join(s.Root, "ask", workspaceID+".settings.json"))
}
