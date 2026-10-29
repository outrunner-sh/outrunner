package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"runtime-agent/internal/conversation"
	"runtime-agent/internal/protocol"
	"runtime-agent/internal/redact"
)

// A session can hold several chats: conversations of their own, each its own
// agent in its own tmux session, all working in the session's one worktree.
// The session itself is its main chat, as it always was, so everything that
// knew a session before chats (a Mission, Slack, the API) still reaches it.
// Any other chat runs as a workspace of its own under a key of its own
// (ChatKey), whose facts name the session as its Parent: the service then
// drives it as it does any session (its launch, its prompts, its stops, its
// conversation stream), and only the worktree, the project's environment and
// the secrets provided are its parent's.

// MainChat names a session's main chat where a chat is asked for by id: the
// session itself.
const MainChat = "main"

var chatIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// ValidChatID admits the ids the control plane gives chats (UUIDs) and short
// ones. A chat's key becomes a file name and a tmux session's, so the id is
// held to what both take, and to what a workspace id may be (the ask relay
// names its session by key).
func ValidChatID(id string) bool {
	return id != MainChat && chatIDPattern.MatchString(id)
}

// ChatKey is the key the service runs a session's chat under: the session's
// own id for its main chat (MainChat, or none named), else the session's id
// and the chat's.
func ChatKey(workspaceID, chatID string) string {
	if chatID == "" || chatID == MainChat {
		return workspaceID
	}
	return workspaceID + "_" + chatID
}

var (
	// ErrUnknownChat is a chat the session has no record of.
	ErrUnknownChat = errors.New("unknown chat")
	// ErrChatsUnsupported is a chat asked of the jcode engine, whose bridge
	// runs one conversation per workspace.
	ErrChatsUnsupported = errors.New("this computer's engine runs one chat per session")
)

// owner is the session whose worktree, environment and provided secrets a
// workspace key uses: a chat's parent, else the key's own.
func (s *Service) owner(id string) string {
	if f, ok := s.getFacts(id); ok && f.Parent != "" {
		return f.Parent
	}
	return id
}

// isChat reports whether a key is a session's chat other than its main one.
func (s *Service) isChat(id string) bool {
	f, ok := s.getFacts(id)
	return ok && f.Parent != ""
}

// HasChat reports whether a session has the chat: its main one whenever the
// session is known here, any other once CreateChat has made it.
func (s *Service) HasChat(workspaceID, chatID string) bool {
	if chatID == "" || chatID == MainChat {
		_, ok := s.getFacts(workspaceID)
		return ok
	}
	f, ok := s.getFacts(ChatKey(workspaceID, chatID))
	return ok && f.Parent == workspaceID
}

// chatKeys are the keys of a session's chats other than its main one.
func (s *Service) chatKeys(workspaceID string) []string {
	entries, err := os.ReadDir(filepath.Join(s.Root, "facts"))
	if err != nil {
		return nil
	}
	var keys []string
	for _, entry := range entries {
		key, ok := strings.CutSuffix(entry.Name(), ".json")
		if !ok || !strings.HasPrefix(key, workspaceID+"_") {
			continue
		}
		if f, ok := s.getFacts(key); ok && f.Parent == workspaceID {
			keys = append(keys, key)
		}
	}
	return keys
}

// ChatInput is what CreateChat needs to make a chat.
type ChatInput struct {
	ChatID string
	// Agent is the chat's agent (ValidAgent); empty is the session's own.
	Agent string
	// From is the chat a fork continues (a chat id, or MainChat), with its
	// name for the handoff; empty starts afresh.
	From     string
	FromName string
	// Side makes a side chat of the fork: a quick question about From that
	// doesn't touch its turn, each prompt sent with From's newest turns.
	Side bool
}

// CreateChat records a new chat in a session, ready for Start under its key.
// A chat on the session's agent runs on its model, effort and credential, as
// they are now; one on another agent runs on that agent's own login and
// default model until SetAuth and SetModel give it others. A fork (From)
// carries the conversation it continues over as a handoff its first prompt
// is sent with (handoff). Making a chat that exists is a no-op.
func (s *Service) CreateChat(ctx context.Context, workspaceID string, in ChatInput) error {
	if s.jcode != nil {
		return ErrChatsUnsupported
	}
	if !ValidChatID(in.ChatID) {
		return fmt.Errorf("invalid chat id %q", in.ChatID)
	}
	parent, ok := s.getFacts(workspaceID)
	if !ok || parent.Parent != "" {
		return ErrUnknownWorkspace // a session, not a chat: chats don't nest
	}
	key := ChatKey(workspaceID, in.ChatID)
	defer s.lockLifecycle(key)()
	if _, exists := s.getFacts(key); exists {
		return nil
	}
	agentName := in.Agent
	if agentName == "" {
		agentName = parent.Agent
	}
	if err := s.CheckAgent(agentName); err != nil {
		return err
	}
	sameAgent := agentOrClaude(agentName) == agentOrClaude(parent.Agent)
	from := ""
	if in.From != "" {
		if !s.HasChat(workspaceID, in.From) {
			return ErrUnknownChat
		}
		from = ChatKey(workspaceID, in.From)
	}
	// The main chat's Claude has found its conversation as the newest in the
	// worktree's project folder; a chat's conversation lands there too, so
	// the main one is named by id from here on.
	s.pinClaudeSession(workspaceID)
	f := workspaceFacts{
		Parent:         workspaceID,
		Branch:         parent.Branch,
		BaseBranch:     parent.BaseBranch,
		PermissionMode: parent.PermissionMode,
		RepoPath:       parent.RepoPath,
		InPlace:        parent.InPlace,
		Checkouts:      parent.Checkouts,
		// The worktree is the parent's, warmed or not: no chat runs its
		// warm hook again.
		Warmed:    true,
		Agent:     agentName,
		Name:      parent.Name,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if agentOrClaude(agentName) == AgentClaude {
		// Every chat's conversation is named by id: they share a folder.
		f.ClaudeSessionID = newSessionID()
	}
	if sameAgent {
		f.Model, f.Gateway, f.Effort, f.Auth = parent.Model, parent.Gateway, parent.Effort, parent.Auth
		if err := s.gatewayFiles().put(key, s.gatewayFiles().read(workspaceID)); err != nil {
			return err
		}
		if err := s.authFiles().put(key, s.authFiles().read(workspaceID)); err != nil {
			return err
		}
	}
	if from != "" {
		handoff, err := s.handoff(workspaceID, in.ChatID, from, in.FromName, in.Side)
		if err != nil {
			return err
		}
		f.Handoff = handoff
		if in.Side {
			f.SideOf = from
		}
	}
	s.setFacts(key, f)
	return nil
}

func agentOrClaude(name string) string {
	if name == "" {
		return AgentClaude
	}
	return name
}

// pinClaudeSession names a Claude session's conversation by its id, once it
// has one, so it stops being "the newest in the folder" (claudeAgent's
// sessionLog), which another chat's could become.
func (s *Service) pinClaudeSession(workspaceID string) {
	f, _ := s.getFacts(workspaceID)
	if f.Agent == AgentCodex || f.ClaudeSessionID != "" {
		return
	}
	log := (claudeAgent{s}).sessionLog(workspaceID)
	if log == "" {
		return
	}
	id := strings.TrimSuffix(filepath.Base(log), filepath.Ext(log))
	s.updateFacts(workspaceID, func(f *workspaceFacts) {
		if f.ClaudeSessionID == "" {
			f.ClaudeSessionID = id
		}
	})
}

// chatSessionIDs are the Claude conversations a session's other chats have,
// which its main chat must not take for its own while it has none named.
func (s *Service) chatSessionIDs(workspaceID string) map[string]bool {
	ids := map[string]bool{}
	for _, key := range s.chatKeys(workspaceID) {
		if f, _ := s.getFacts(key); f.ClaudeSessionID != "" {
			ids[f.ClaudeSessionID] = true
		}
	}
	return ids
}

// DeleteChat ends a chat and forgets it: its agent stopped, its conversation
// left where its agent keeps it. The main chat is the session, which Destroy
// ends. Deleting a chat that is gone is a no-op.
func (s *Service) DeleteChat(ctx context.Context, workspaceID, chatID string) error {
	if !ValidChatID(chatID) {
		return fmt.Errorf("invalid chat id %q", chatID)
	}
	key := ChatKey(workspaceID, chatID)
	defer s.lockLifecycle(key)()
	if !s.HasChat(workspaceID, chatID) {
		return nil
	}
	s.endChat(ctx, key)
	return nil
}

// endChat stops a chat and forgets it. Callers hold its lifecycle lock, or
// its session's when the session is going too.
func (s *Service) endChat(ctx context.Context, key string) {
	_ = s.Stop(ctx, key)
	if f, _ := s.getFacts(key); f.Parent != "" {
		_ = os.Remove(s.handoffPath(f.Parent, strings.TrimPrefix(key, f.Parent+"_")))
	}
	s.forgetWorkspace(key)
}

// handoffPath is where a forked chat's transcript of the conversation it
// continues is kept: in the session's .context folder, which the agent is
// told it has and git ignores, or for a session in the user's own folder
// (which has none), beside its facts.
func (s *Service) handoffPath(workspaceID, chatID string) string {
	if f, _ := s.getFacts(workspaceID); !f.InPlace {
		return filepath.Join(s.worktreePath(workspaceID), ".context", "chats", chatID+".md")
	}
	return filepath.Join(s.Root, "chats", ChatKey(workspaceID, chatID)+".md")
}

const (
	// handoffReadLimit is how much of a conversation a fork's transcript is
	// made from: its most recent part, for a long one.
	handoffReadLimit = 32 << 20
	// handoffRecentTurns and handoffRecentBytes bound the latest turns a
	// fork's first prompt carries; the transcript has the rest.
	handoffRecentTurns = 6
	handoffRecentBytes = 8000
	// sideContextTurns and sideContextBytes bound the newest turns each side
	// chat prompt carries of the chat it asks about.
	sideContextTurns = 4
	sideContextBytes = 4000
	// recentTurnBytes bounds any one turn quoted.
	recentTurnBytes = 2000
)

// The tags a chat's prompt wraps what Outrunner adds to it in, so the
// timeline can show it folded away (lib/runtime/conversation-nodes.ts) and a
// transcript leave it out.
const (
	handoffOpen      = "<outrunner-handoff>"
	handoffClose     = "</outrunner-handoff>"
	sideContextOpen  = "<outrunner-side-chat>"
	sideContextClose = "</outrunner-side-chat>"
)

// handoff writes the transcript a fork continues from, and returns what its
// first prompt is sent with. It is made from the conversation as it is now,
// deterministically: no model summarizes it. The transcript keeps what was
// said (the prompts and the replies), names the tools used rather than
// quoting their calls and output, and masks the box's secrets; the raw log
// stays where the source chat's agent keeps it, named for a search.
func (s *Service) handoff(workspaceID, chatID, from, fromName string, side bool) (string, error) {
	log := s.SessionLog(from)
	if fromName == "" {
		fromName = "the main chat"
		if from != workspaceID {
			fromName = "another chat"
		}
	}
	if log == "" {
		// Nothing said there yet: there is nothing to carry over.
		return "", nil
	}
	turns, partial, err := readTurns(log, handoffReadLimit)
	if err != nil {
		return "", fmt.Errorf("read the chat to fork: %w", err)
	}
	mask := s.masker()
	path := s.handoffPath(workspaceID, chatID)
	// Ignored by git before the transcript is written into it.
	s.makeContextDir(context.Background(), workspaceID, s.worktreePath(workspaceID))
	var doc strings.Builder
	fmt.Fprintf(&doc, "# Transcript of %s\n\n", fromName)
	if partial {
		fmt.Fprintf(&doc, "Only the most recent part of a long conversation is here; all of it is in %s.\n\n", log)
	}
	for _, t := range turns {
		fmt.Fprintf(&doc, "## %s\n\n%s\n\n", t.heading(), mask(t.text))
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(doc.String()), 0o600); err != nil {
		return "", err
	}
	var note strings.Builder
	note.WriteString(handoffOpen + "\n")
	if side {
		fmt.Fprintf(&note, "This is a side chat about %s, which carries on meanwhile in the same worktree. ", fromName)
		note.WriteString("Answer questions about it here; read any file you need, but change nothing unless you're asked to.\n")
	} else {
		fmt.Fprintf(&note, "This chat continues from %s, in the same worktree: its files and git state are as that chat left them.\n", fromName)
	}
	fmt.Fprintf(&note, "Its conversation so far is in %s (tool calls named, not quoted; secrets masked); the raw log is %s, to search for anything left out.\n", path, log)
	if recent := recentTurns(turns, handoffRecentTurns, handoffRecentBytes); recent != "" {
		note.WriteString("Its latest turns:\n\n" + mask(recent))
	}
	note.WriteString(handoffClose + "\n\n")
	return note.String(), nil
}

// sideContext is what a side chat's prompt is sent with: the newest turns of
// the chat it asks about, read afresh for each prompt, since that chat goes
// on meanwhile.
func (s *Service) sideContext(source string) string {
	log := s.SessionLog(source)
	if log == "" {
		return ""
	}
	// The newest turns are near the end: a long conversation isn't read whole
	// for every question.
	turns, _, err := readTurns(log, 2<<20)
	if err != nil {
		return ""
	}
	recent := recentTurns(turns, sideContextTurns, sideContextBytes)
	if recent == "" {
		return ""
	}
	return sideContextOpen + "\nThe newest turns of the chat this side chat is about:\n\n" + s.masker()(recent) + sideContextClose + "\n\n"
}

// masker masks the box's secrets in text, as its terminal does.
func (s *Service) masker() func(string) string {
	secrets := s.RedactionSecrets()
	live := s.liveSecrets
	return func(text string) string {
		r := redact.New(secrets).Follow(live)
		return r.Redact([]byte(text)) + r.Flush()
	}
}

// turn is one message of a conversation as a transcript gives it.
type turn struct {
	role string // "user", "assistant", or "note"
	text string
}

func (t turn) heading() string {
	switch t.role {
	case "user":
		return "User"
	case "assistant":
		return "Assistant"
	default:
		return "Note"
	}
}

// readTurns reads a conversation log (Claude's record shape, as SessionLog
// gives every agent's) into its turns: the most recent limit bytes of it,
// partial when that isn't all of it.
func readTurns(path string, limit int64) ([]turn, bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, false, err
	}
	from := int64(0)
	if info.Size() > limit {
		from = info.Size() - limit
	}
	events, err := conversation.Read(path, from)
	if err != nil {
		return nil, false, err
	}
	var turns []turn
	for _, ev := range events {
		if t, ok := turnOf(ev.Message); ok {
			// A reply comes as a record per block: one turn of them.
			if n := len(turns); n > 0 && turns[n-1].role == t.role && t.role == "assistant" {
				turns[n-1].text += "\n\n" + t.text
				continue
			}
			turns = append(turns, t)
		}
	}
	return turns, from > 0, nil
}

// turnOf is a message as a transcript keeps it: a prompt's text without what
// Outrunner sent it with, a reply's text with its tool calls named; nothing
// for a tool's result, Claude's own injected records, or a stop's record.
func turnOf(msg *protocol.ConversationMessage) (turn, bool) {
	if msg == nil || msg.Meta || conversation.IsInterruption(msg) {
		return turn{}, false
	}
	if msg.Compact != nil {
		return turn{role: "note", text: "The conversation was compacted here."}, true
	}
	var parts []string
	for _, block := range msg.Content {
		switch {
		case block.Type == "text" && strings.TrimSpace(block.Text) != "":
			text := block.Text
			if msg.Role == "user" {
				text = withoutAdded(text)
			}
			if strings.TrimSpace(text) != "" {
				parts = append(parts, strings.TrimSpace(text))
			}
		case block.Type == "tool_use" && msg.Role == "assistant":
			parts = append(parts, "(used "+block.Name+")")
		}
	}
	if len(parts) == 0 {
		return turn{}, false
	}
	return turn{role: msg.Role, text: strings.Join(parts, "\n\n")}, true
}

// withoutAdded is a prompt without the handoff or side chat context Outrunner
// sent it with: a fork of a fork carries its own, not its source's.
func withoutAdded(text string) string {
	for _, tags := range [][2]string{{handoffOpen, handoffClose}, {sideContextOpen, sideContextClose}} {
		for {
			start := strings.Index(text, tags[0])
			if start < 0 {
				break
			}
			end := strings.Index(text[start:], tags[1])
			if end < 0 {
				break
			}
			text = text[:start] + text[start+end+len(tags[1]):]
		}
	}
	return strings.TrimSpace(text)
}

// recentTurns quotes the last few turns, each cut to recentTurnBytes and all
// of them to max bytes, keeping the newest.
func recentTurns(turns []turn, count, max int) string {
	if len(turns) > count {
		turns = turns[len(turns)-count:]
	}
	var quoted []string
	total := 0
	for i := len(turns) - 1; i >= 0; i-- {
		text := turns[i].text
		if len(text) > recentTurnBytes {
			text = cutAtRune(text, recentTurnBytes) + " …"
		}
		entry := turns[i].heading() + ": " + text + "\n\n"
		if total+len(entry) > max && len(quoted) > 0 {
			break
		}
		total += len(entry)
		quoted = append([]string{entry}, quoted...)
	}
	return strings.Join(quoted, "")
}

// cutAtRune is text's first n bytes, not ending inside a character.
func cutAtRune(text string, n int) string {
	if len(text) <= n {
		return text
	}
	for n > 0 && n < len(text) && text[n]&0xC0 == 0x80 {
		n--
	}
	return text[:n]
}

// chatPromptText is a chat's prompt with what its chat sends it with: a
// fork's handoff, until its first prompt lands, and a side chat's context.
func (s *Service) chatPromptText(key, content string) string {
	f, _ := s.getFacts(key)
	if f.SideOf != "" {
		content = s.sideContext(f.SideOf) + content
	}
	if f.Handoff != "" {
		content = f.Handoff + content
	}
	return content
}

// handedOff forgets a fork's handoff once the prompt it went with landed.
func (s *Service) handedOff(key string) {
	if f, _ := s.getFacts(key); f.Handoff == "" {
		return
	}
	s.updateFacts(key, func(f *workspaceFacts) { f.Handoff = "" })
}
