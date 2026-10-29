package workspace

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"runtime-agent/internal/ask"
)

// A Claude session asks the user questions through the ask_user tool (package
// ask): Claude launches this binary's relay (`runtime-agent ask-mcp`) as an
// MCP server, and the relay forwards each question to this agent, which holds
// it until the browser answers. The relay outlives the agent that launched its
// session, so it finds the agent through files under Root rather than through
// anything its launch was given: the address the agent announces when it
// starts, and the session's token, kept for the life of the session.
//
// Codex sessions don't get the tool yet: Codex's default model calls tools
// from a script (code mode), so its transcript doesn't show the question while
// it waits, and nobody could answer it.

// askTimeoutSeconds is how long an agent waits on the user's answer before giving the
// call up. A session's question can sit unanswered while its user is away.
const askTimeoutSeconds = 24 * 60 * 60

// AskPaths are the files a session's relay reads: the agent's announced
// address, and the session's ask token. `outrunner media upload` reads the
// same two (cli.boxAgentFromEnv, written out there since the npm CLI builds
// that package too): move them together; a test there pins them.
func AskPaths(root, workspaceID string) (addrFile, tokenFile string) {
	return filepath.Join(root, "agent.addr"), filepath.Join(root, "ask", workspaceID+".token")
}

// askConfigPath is the MCP config a Claude session launches its relay from.
func (s *Service) askConfigPath(workspaceID string) string {
	return filepath.Join(s.Root, "ask", workspaceID+".mcp.json")
}

// Announce records the address this agent listens on, for the relays: on the
// loopback, which every interface the agent may listen on includes.
func (s *Service) Announce(addr net.Addr) error {
	tcp, ok := addr.(*net.TCPAddr)
	if !ok {
		return fmt.Errorf("announce %s: not a TCP address", addr)
	}
	addrFile, _ := AskPaths(s.Root, "")
	return writeKeysFile(addrFile, net.JoinHostPort("127.0.0.1", strconv.Itoa(tcp.Port))+"\n")
}

// askToken is the session's ask token, made at its first launch and kept until
// it is destroyed: a relay launched before an agent restart still holds it.
func (s *Service) askToken(workspaceID string) (string, error) {
	_, tokenFile := AskPaths(s.Root, workspaceID)
	if data, err := os.ReadFile(tokenFile); err == nil {
		if token := strings.TrimSpace(string(data)); token != "" {
			return token, nil
		}
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	if err := writeKeysFile(tokenFile, token+"\n"); err != nil {
		return "", err
	}
	return token, nil
}

// AskAuthorized reports whether token is the session's ask token: a call
// from its own relay.
func (s *Service) AskAuthorized(workspaceID, token string) bool {
	_, tokenFile := AskPaths(s.Root, workspaceID)
	data, err := os.ReadFile(tokenFile)
	want := strings.TrimSpace(string(data))
	return err == nil && want != "" && subtle.ConstantTimeCompare([]byte(want), []byte(token)) == 1
}

// relayArgs launch a session's relay, after RelayExecutable.
func (s *Service) relayArgs(workspaceID string) []string {
	return []string{"ask-mcp", "--root", s.Root, "--workspace", workspaceID}
}

// askReady readies a launch's ask_user tool, or says it can't have one (no
// relay to launch, no token): the session then asks in the terminal, as
// before.
func (s *Service) askReady(workspaceID string) bool {
	if s.RelayExecutable == "" {
		return false
	}
	if _, err := s.askToken(workspaceID); err != nil {
		log.Printf("workspace %s: no ask_user tool (token: %v)", workspaceID, err)
		return false
	}
	return true
}

// claudeAskArgs give a Claude launch the ask_user tool in place of its own
// AskUserQuestion, whose menu only the terminal shows. The tool is allowed up
// front: asking the user is never something to ask permission for. Its
// timeout also turns off Claude's watchdog on a call that sends no progress,
// which would end the wait after five minutes.
func (s *Service) claudeAskArgs(workspaceID string) []string {
	if !s.askReady(workspaceID) {
		return nil
	}
	config := map[string]any{"mcpServers": map[string]any{ask.ServerName: map[string]any{
		"type":    "stdio",
		"command": s.RelayExecutable,
		"args":    s.relayArgs(workspaceID),
		"timeout": askTimeoutSeconds * 1000,
		// In the prompt from the start, not behind Claude's tool search: a
		// question shouldn't cost the agent a search first.
		"alwaysLoad": true,
	}}}
	path := s.askConfigPath(workspaceID)
	if err := writeJSONFile(path, config, 0o600); err != nil {
		log.Printf("workspace %s: no ask_user tool (config: %v)", workspaceID, err)
		return nil
	}
	return []string{
		"--mcp-config", path,
		"--allowedTools", ask.QualifiedToolName, ask.QualifiedSecretsToolName, ask.QualifiedMediaToolName,
		"--disallowedTools", "AskUserQuestion",
	}
}

// Ask waits for the user's answer to a session's questions, returned as the
// tool's text for its agent.
func (s *Service) Ask(ctx context.Context, workspaceID, requestID string, questions []ask.Question) (string, error) {
	reply, err := s.asks.Ask(ctx, workspaceID, requestID, questions)
	if err != nil {
		return "", err
	}
	return ask.Format(questions, reply), nil
}

// Answer gives the user's reply to the questions a session is waiting on.
func (s *Service) Answer(workspaceID string, questions []ask.Question, reply ask.Reply) error {
	return s.asks.Answer(workspaceID, questions, reply)
}

// forgetAsk removes a destroyed session's token and config.
func (s *Service) forgetAsk(workspaceID string) {
	_, tokenFile := AskPaths(s.Root, workspaceID)
	_ = os.Remove(tokenFile)
	_ = os.Remove(s.askConfigPath(workspaceID))
}
