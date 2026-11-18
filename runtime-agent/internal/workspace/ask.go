package workspace

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"

	"runtime-agent/internal/ask"
	"runtime-agent/internal/codex"
	"runtime-agent/internal/conversation"
	"runtime-agent/internal/protocol"
)

// A Claude session asks the user questions through the ask_user tool (package
// ask): Claude launches this binary's relay (`runtime-agent ask-mcp`) as an
// MCP server, and the relay forwards each question to this agent, which holds
// it until the browser answers. The relay outlives the agent that launched its
// session, so it finds the agent through files under Root rather than through
// anything its launch was given: the address the agent announces when it
// starts, and the session's token, kept for the life of the session.
//
// Codex gets request_secrets too. Its runtime writes a form record directly
// to the conversation, so a call hidden inside code mode can still be answered.

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

// codexSecretsArgs gives every Codex launch the secret tool, including ones
// using the user's own Codex home. Restrict this relay to the supported tool;
// normal questions retain their existing Codex behavior.
func (s *Service) codexSecretsArgs(workspaceID string) []string {
	if !s.askReady(workspaceID) {
		return nil
	}
	args := make([]string, 0)
	for _, arg := range s.relayArgs(workspaceID) {
		args = append(args, codex.TOMLString(arg))
	}
	key := "mcp_servers." + ask.ServerName + "."
	return []string{
		"-c", key + "command=" + codex.TOMLString(s.RelayExecutable),
		"-c", key + "args=[" + strings.Join(args, ", ") + "]",
		"-c", key + "enabled=true",
		"-c", key + "enabled_tools=[" + codex.TOMLString(ask.SecretsToolName) + "]",
		"-c", key + "tool_timeout_sec=" + strconv.Itoa(askTimeoutSeconds),
	}
}

// Ask waits for the user's answer to a session's questions, returned as the
// tool's text for its agent. toolUseHint is the transcript's tool_use id as
// the agent's CLI told the relay, if it did.
func (s *Service) Ask(ctx context.Context, workspaceID, requestID, toolUseHint string, questions []ask.Question) (string, error) {
	reply, err := s.asks.AskCall(ctx, workspaceID, requestID, toolUseHint, questions)
	if err != nil {
		return "", err
	}
	return ask.Format(questions, reply), nil
}

// Answer gives the user's reply to the questions a session is waiting on,
// matched by their text: a client that names no call.
func (s *Service) Answer(workspaceID string, questions []ask.Question, reply ask.Reply) error {
	return s.asks.Answer(workspaceID, questions, reply)
}

// AnswerCall gives the user's reply to the exact call id names
// (ask.Broker.AnswerCall).
func (s *Service) AnswerCall(workspaceID string, id ask.CallIdentity, operationID string, questions []ask.Question, reply ask.Reply) (ask.AnswerResult, error) {
	return s.asks.AnswerCall(workspaceID, id, operationID, questions, reply)
}

// PendingQuestion is the ask_user call a chat (key) waits on, if any, with
// its transcript tool_use where the transcript bears it out (pendingAskUse).
func (s *Service) PendingQuestion(key string) (ask.PendingCall, string, bool) {
	call, ok := s.asks.Pending(key)
	if !ok {
		return ask.PendingCall{}, "", false
	}
	return call, verifiedToolUse(s.SessionLog(key), call), true
}

// verifiedToolUse is the transcript's tool_use for call: the chat's pending
// ask_user call (the newest, with no result and no prompt since) where it
// asks the same questions and, if the CLI named the call's tool_use, is that
// one. "" where the transcript doesn't bear it out (not written yet, another
// call, no log): the association isn't assumed.
func verifiedToolUse(log string, call ask.PendingCall) string {
	if log == "" {
		return ""
	}
	id, input, ok := pendingAskUse(log)
	if !ok || (call.ToolUseHint != "" && call.ToolUseHint != id) {
		return ""
	}
	var asked struct {
		Questions []ask.Question `json:"questions"`
	}
	if json.Unmarshal(input, &asked) != nil || !reflect.DeepEqual(asked.Questions, call.Questions) {
		return ""
	}
	return id
}

// pendingAskUse is the newest ask_user tool_use in a conversation log still
// waiting on its result, as lib/runtime/pending-question.ts reads it
// (pendingToolCall): a result for it, a prompt or a stopped turn after it
// ends it.
func pendingAskUse(log string) (string, json.RawMessage, bool) {
	var id string
	var input json.RawMessage
	err := conversation.Walk(log, 0, func(ev conversation.Event) bool {
		msg := ev.Message
		if msg == nil {
			return true
		}
		if msg.Role == "user" && !msg.Meta && hasText(msg.Content) {
			id, input = "", nil // a prompt, or the record of a stop
			return true
		}
		for _, block := range msg.Content {
			switch {
			case block.Type == "tool_use" && block.Name == ask.QualifiedToolName:
				id, input = block.ID, block.Input
			case block.Type == "tool_result" && id != "" && block.ToolUseID == id:
				id, input = "", nil
			}
		}
		return true
	})
	return id, input, err == nil && id != ""
}

func hasText(blocks []protocol.ContentBlock) bool {
	for _, b := range blocks {
		if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
			return true
		}
	}
	return false
}

// forgetAsk removes a destroyed session's token and config.
func (s *Service) forgetAsk(workspaceID string) {
	_, tokenFile := AskPaths(s.Root, workspaceID)
	_ = os.Remove(tokenFile)
	_ = os.Remove(s.askConfigPath(workspaceID))
}
