package workspace

// Several Claude accounts (lib/claude/accounts.ts on the control plane): when
// Claude Code reports its subscription's usage limit, the box asks the
// control plane for the user's next Claude account and carries on there, in
// the same conversation: the session's auth file swapped, Claude Code
// relaunched with --resume, and the unfinished request picked up again.
//
// Only a session on the user's own subscription token (AuthClaudeOAuthToken)
// switches. The token is never sent: the control plane finds the account by
// its SHA-256.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"time"

	"runtime-agent/internal/protocol"
)

const (
	claudeAccountRoute   = "/api/runtime/claude-account"
	claudeAccountPurpose = "claude-account"
	// A limit reply older than this when it's read is history (a relaunch
	// replays the whole transcript), never a reason to switch.
	claudeLimitFresh = 15 * time.Minute
)

var (
	// Claude Code's own notice, never the model's prose: only a <synthetic>
	// reply is tested. "You've hit your session limit · resets 3pm", "You've
	// hit your weekly limit", the older "Claude AI usage limit reached|<unix>".
	claudeLimitText  = regexp.MustCompile(`(?i)\b(you(?:'ve| have) (?:hit|reached) your (?:[\w-]+ )?limit|usage limit (?:reached|exceeded)|weekly (?:usage )?limit|limit reached.*resets)\b`)
	claudeLimitEpoch = regexp.MustCompile(`\|(\d{10})\b`)
	oauthTokenLine   = regexp.MustCompile(`(?m)^export CLAUDE_CODE_OAUTH_TOKEN='([^'\n]+)'$`)
)

// claudeLimit says whether a reply is Claude Code's usage-limit notice, and
// when the limit resets (RFC 3339) where it says so as a Unix time.
func claudeLimit(m *protocol.ConversationMessage) (bool, string) {
	if m == nil || m.Role != "assistant" || m.Model != "<synthetic>" {
		return false, ""
	}
	var text strings.Builder
	for _, block := range m.Content {
		if block.Type == "text" {
			text.WriteString(block.Text)
			text.WriteString("\n")
		}
	}
	if !claudeLimitText.MatchString(text.String()) {
		return false, ""
	}
	if match := claudeLimitEpoch.FindStringSubmatch(text.String()); match != nil {
		if unix, err := strconv.ParseInt(match[1], 10, 64); err == nil {
			return true, time.Unix(unix, 0).UTC().Format(time.RFC3339)
		}
	}
	return true, ""
}

// oauthTokenOf is the subscription token an auth file exports (authEnvFile),
// or "" when it exports none.
func oauthTokenOf(authFile string) string {
	if match := oauthTokenLine.FindStringSubmatch(authFile); match != nil {
		return match[1]
	}
	return ""
}

// claudeAccountRequest is what the box tells the control plane: which session
// hit a limit, on which token (by its hash), and when it resets if known.
type claudeAccountRequest struct {
	Workspace   string `json:"workspace"`
	TokenSHA256 string `json:"tokenSha256"`
	ResetsAt    string `json:"resetsAt,omitempty"`
}

// claudeAccountAnswer is the account to carry on with: its token and name,
// and the name of the one that hit its limit. No token: none can run now.
type claudeAccountAnswer struct {
	Token      string `json:"token"`
	Label      string `json:"label"`
	From       string `json:"from"`
	FirstReset string `json:"firstReset"`
	Error      string `json:"error"`
}

// claudeLimitReached runs when a session's transcript shows Claude Code's
// usage-limit notice (Summary.onLimit). Each notice is handled once, ever:
// its id is kept with the session's facts before anything else, so a
// relaunch replaying it, or a switch that fails, never loops.
func (s *Service) claudeLimitReached(id, uuid, resetsAt string, at time.Time) {
	if s.controlPlane == nil || uuid == "" {
		return
	}
	var claimed, fresh bool
	unlock := s.lockLifecycle(id)
	s.updateFacts(id, func(f *workspaceFacts) {
		if agentOrClaude(f.Agent) != AgentClaude || f.Auth != AuthClaudeOAuthToken || f.Harness != nil || f.ClaudeLimitSeen == uuid {
			return
		}
		f.ClaudeLimitSeen = uuid
		claimed = true
		fresh = !at.IsZero() && time.Since(at) <= claudeLimitFresh
	})
	token := oauthTokenOf(s.authFiles().read(id))
	unlock()
	if !claimed || !fresh || token == "" {
		return
	}

	hash := sha256.Sum256([]byte(token))
	body, _ := json.Marshal(claudeAccountRequest{Workspace: s.owner(id), TokenSHA256: hex.EncodeToString(hash[:]), ResetsAt: resetsAt})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	status, data, err := s.controlPlane.Post(ctx, claudeAccountRoute, claudeAccountPurpose, body)
	if err != nil {
		log.Printf("session %s hit its Claude usage limit; couldn't ask for another account: %v", id, err)
		return
	}
	var answer claudeAccountAnswer
	if json.Unmarshal(data, &answer) != nil || status != 200 {
		log.Printf("session %s hit its Claude usage limit; the control plane answered %d %s", id, status, answer.Error)
		return
	}
	if answer.Token == "" {
		log.Printf("session %s hit its Claude usage limit; no other Claude account can run now (first reset %s)", id, answer.FirstReset)
		return
	}
	switchAccount := s.claudeAccountSwitch
	if switchAccount == nil {
		switchAccount = s.SwitchClaudeAccount
	}
	if err := switchAccount(context.Background(), id, answer.Token, continueOnAccount(answer.From, answer.Label)); err != nil {
		log.Printf("session %s hit its Claude usage limit; switching to Claude account %q failed: %v", id, answer.Label, err)
	}
}

// continueOnAccount is the message that picks the unfinished request up
// again on the next account. The user sees it in the conversation, so it
// says what happened.
func continueOnAccount(from, to string) string {
	switched := "This session hit a Claude usage limit and now runs on another of your Claude accounts."
	if from != "" && to != "" {
		switched = fmt.Sprintf("Claude account %q hit its usage limit, so this session now runs on %q.", from, to)
	}
	return switched + " Continue the unfinished request from where it stopped. Check what's already done before repeating anything."
}

// SwitchClaudeAccount moves a Claude session onto another subscription token
// in the same conversation: the auth file swapped, Claude Code relaunched
// with --resume, and `resume` sent when a request was left unfinished.
// Lifecycle and send locks cover the whole move, so no message lands on the
// old login.
func (s *Service) SwitchClaudeAccount(ctx context.Context, id, token, resume string) error {
	if !ValidAuthToken(AuthClaudeOAuthToken, token) {
		return ErrAuthMismatch
	}
	defer s.lockLifecycle(id)()
	lock := s.lockSend(id)
	defer lock.Unlock()
	base, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*switchRelaunchTimeout)
	defer cancel()
	f, ok := s.getFacts(id)
	if !ok {
		return ErrUnknownWorkspace
	}
	if agentOrClaude(f.Agent) != AgentClaude || f.Auth != AuthClaudeOAuthToken || f.Harness != nil {
		return ErrAuthMismatch
	}
	_, pending := s.resumeRequest(id)
	unfinished := pending == nil
	if err := s.interruptHeld(base, id); err != nil {
		return err
	}
	if err := s.authFiles().put(id, authEnvFile(AuthClaudeOAuthToken, token)); err != nil {
		return err
	}
	s.refreshLiveSecrets()
	if _, err := s.relaunchHeld(base, id, "", s.nativeLog(id) != "", lock); err != nil {
		return err
	}
	if !unfinished || strings.TrimSpace(resume) == "" {
		return nil
	}
	return s.deliverHeld(id, resume, lock)
}
