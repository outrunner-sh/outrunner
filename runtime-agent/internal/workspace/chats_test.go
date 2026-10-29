package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// A conversation as Claude records it: a prompt, a reply that runs a tool,
// the tool's result, and the reply after it.
const mainTranscript = `{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-10-29T10:00:00Z","message":{"role":"user","content":"Add dark mode to the settings page"}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-10-29T10:00:05Z","message":{"role":"assistant","content":[{"type":"text","text":"Looking at the settings page."},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/secret/path.ts"}}]}}
{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-10-29T10:00:06Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"file contents nobody needs again"}]}}
{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"2026-10-29T10:00:09Z","message":{"role":"assistant","content":[{"type":"text","text":"Done: the toggle uses sk-test-0123456789abcdef as its key."}]}}
`

// chatSession is a cloud session with a conversation, and a chat in it.
func chatSession(t *testing.T, in ChatInput) (*Service, string, string) {
	t.Helper()
	s, _ := cloudSession(t, CreateInput{WorkspaceID: "ws-chats", Branch: "b", BaseBranch: "main"})
	writeTranscript(t, s, "ws-chats", "main-session.jsonl", mainTranscript, time.Minute)
	if in.ChatID == "" {
		in.ChatID = "c1"
	}
	if err := s.CreateChat(context.Background(), "ws-chats", in); err != nil {
		t.Fatalf("CreateChat: %v", err)
	}
	return s, "ws-chats", ChatKey("ws-chats", in.ChatID)
}

func TestAChatWorksInItsSessionsWorktreeUnderAConversationOfItsOwn(t *testing.T) {
	s, id, key := chatSession(t, ChatInput{})
	if got, want := s.worktreePath(key), s.worktreePath(id); got != want {
		t.Errorf("the chat works in %s, want its session's %s", got, want)
	}
	f, _ := s.getFacts(key)
	if f.Parent != id || f.ClaudeSessionID == "" {
		t.Fatalf("chat facts = %+v, want its parent and a conversation named by id", f)
	}
	if _, err := s.Start(context.Background(), key, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	fake := s.tmux.(*fakeSessions)
	if !fake.running[sessionName(key)] {
		t.Fatalf("the chat has no tmux session of its own: %v", fake.running)
	}
	if launch := fake.lastLaunch(); !slices.Contains(launch, "--session-id") || !slices.Contains(launch, f.ClaudeSessionID) {
		t.Errorf("the chat launched as %q, want its own --session-id %s", launch, f.ClaudeSessionID)
	}
	if !s.HasChat(id, "c1") || !s.HasChat(id, MainChat) || s.HasChat(id, "c2") {
		t.Error("HasChat doesn't know the session's chats")
	}
}

func TestMakingAChatNamesTheMainConversationByID(t *testing.T) {
	s, id, key := chatSession(t, ChatInput{})
	if f, _ := s.getFacts(id); f.ClaudeSessionID != "main-session" {
		t.Fatalf("main chat's conversation id = %q, want the one it had (main-session)", f.ClaudeSessionID)
	}
	// The chat's conversation is newer, and the main one is found all the same.
	f, _ := s.getFacts(key)
	writeTranscript(t, s, key, f.ClaudeSessionID+".jsonl", `{"type":"user","message":{"role":"user","content":"hi"}}`+"\n", 0)
	if got := filepath.Base(s.SessionLog(id)); got != "main-session.jsonl" {
		t.Errorf("main chat's log = %s, want main-session.jsonl", got)
	}
	if got := filepath.Base(s.SessionLog(key)); got != f.ClaudeSessionID+".jsonl" {
		t.Errorf("the chat's log = %s, want its own", got)
	}
}

func TestAMainChatWithNoConversationYetDoesNotTakeAChatsForItsOwn(t *testing.T) {
	s, _ := cloudSession(t, CreateInput{WorkspaceID: "ws-fresh", Branch: "b", BaseBranch: "main"})
	if err := s.CreateChat(context.Background(), "ws-fresh", ChatInput{ChatID: "c1"}); err != nil {
		t.Fatal(err)
	}
	key := ChatKey("ws-fresh", "c1")
	f, _ := s.getFacts(key)
	writeTranscript(t, s, key, f.ClaudeSessionID+".jsonl", `{"type":"user","message":{"role":"user","content":"hi"}}`+"\n", 0)
	if got := s.SessionLog("ws-fresh"); got != "" {
		t.Errorf("main chat's log = %s, want none: that one is the chat's", got)
	}
	if got := s.userTurns("ws-fresh"); got != 0 {
		t.Errorf("main chat counts %d prompts, want 0: the chat's aren't its own", got)
	}
}

func TestAForkCarriesTheConversationOverCleanedAndMasked(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	s, _, key := chatSession(t, ChatInput{From: MainChat, FromName: "Dark mode"})
	s.secrets = append(s.secrets, "sk-test-0123456789abcdef")
	f, _ := s.getFacts(key)
	if !strings.HasPrefix(f.Handoff, handoffOpen) || !strings.Contains(f.Handoff, "continues from Dark mode") {
		t.Fatalf("handoff = %q", f.Handoff)
	}
	transcript := s.handoffPath("ws-chats", "c1")
	if !strings.Contains(f.Handoff, transcript) {
		t.Errorf("the handoff doesn't name its transcript %s", transcript)
	}
	data, err := os.ReadFile(transcript)
	if err != nil {
		t.Fatalf("no transcript: %v", err)
	}
	doc := string(data)
	for _, want := range []string{"Add dark mode to the settings page", "(used Read)", "Done: the toggle"} {
		if !strings.Contains(doc, want) {
			t.Errorf("transcript lacks %q:\n%s", want, doc)
		}
	}
	for _, noise := range []string{"/secret/path.ts", "file contents nobody needs again"} {
		if strings.Contains(doc, noise) {
			t.Errorf("transcript keeps tool noise %q", noise)
		}
	}
	// Under the worktree's .context, which git ignores.
	if !strings.HasPrefix(transcript, filepath.Join(s.worktreePath("ws-chats"), ".context")) {
		t.Errorf("transcript at %s, want in the session's .context", transcript)
	}
	if _, err := os.Stat(filepath.Join(s.worktreePath("ws-chats"), ".context", ".gitignore")); err != nil {
		t.Errorf(".context isn't ignored: %v", err)
	}
}

func TestAForksTranscriptMasksTheBoxsSecrets(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ANTHROPIC_API_KEY", "sk-test-0123456789abcdef")
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	if err := os.MkdirAll(s.worktreePath("ws-mask"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(context.Background(), CreateInput{WorkspaceID: "ws-mask", Branch: "b", BaseBranch: "main"}); err != nil {
		t.Fatal(err)
	}
	writeTranscript(t, s, "ws-mask", "m.jsonl", mainTranscript, time.Minute)
	if err := s.CreateChat(context.Background(), "ws-mask", ChatInput{ChatID: "c1", From: MainChat}); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(s.handoffPath("ws-mask", "c1"))
	f, _ := s.getFacts(ChatKey("ws-mask", "c1"))
	if strings.Contains(string(data), "sk-test-0123456789abcdef") || strings.Contains(f.Handoff, "sk-test-0123456789abcdef") {
		t.Error("a secret of the box's reached the fork")
	}
}

func TestAForksFirstPromptGoesWithItsHandoffOnce(t *testing.T) {
	s, _, key := chatSession(t, ChatInput{From: MainChat})
	fake := s.tmux.(*fakeSessions)
	if _, err := s.Start(context.Background(), key, ""); err != nil {
		t.Fatal(err)
	}
	f, _ := s.getFacts(key)
	log := filepath.Join(s.claudeConvDir(key), f.ClaudeSessionID+".jsonl")
	fake.onEnter = func() string {
		file, err := os.OpenFile(log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = file.WriteString(`{"type":"user"}` + "\n")
			_ = file.Close()
		}
		return ""
	}
	for _, prompt := range []string{"Now add a test", "And another"} {
		if err := s.SendMessage(key, prompt); err != nil {
			t.Fatalf("SendMessage: %v", err)
		}
	}
	if len(fake.pasted) != 2 || !strings.HasPrefix(fake.pasted[0], handoffOpen) || !strings.HasSuffix(fake.pasted[0], "Now add a test") {
		t.Fatalf("first paste = %q, want the handoff then the prompt", fake.pasted)
	}
	if fake.pasted[1] != "And another" {
		t.Errorf("second paste = %q, want the prompt alone", fake.pasted[1])
	}
}

func TestASideChatsPromptsGoWithTheNewestTurnsOfTheChatTheyAreAbout(t *testing.T) {
	s, _, key := chatSession(t, ChatInput{From: MainChat, Side: true})
	text := s.promptText(key, "why the toggle?")
	if !strings.Contains(text, sideContextOpen) || !strings.Contains(text, "Done: the toggle") || !strings.HasSuffix(text, "why the toggle?") {
		t.Errorf("side chat prompt = %q", text)
	}
	if !strings.Contains(text, "change nothing unless you're asked to") {
		t.Errorf("a side chat isn't told to leave the files alone: %q", text)
	}
}

func TestACodexChatOfAClaudeSessionRunsOnItsOwnLogin(t *testing.T) {
	s, _ := cloudSession(t, CreateInput{WorkspaceID: "ws-x", Branch: "b", BaseBranch: "main", Model: "opus"})
	s.lookPath = func(string) (string, error) { return "/usr/bin/codex", nil }
	if err := s.authFiles().put("ws-x", authEnvFile(AuthClaudeOAuthToken, "sk-ant-oat01-"+strings.Repeat("x", 40))); err != nil {
		t.Fatal(err)
	}
	s.updateFacts("ws-x", func(f *workspaceFacts) { f.Auth = AuthClaudeOAuthToken })
	if err := s.CreateChat(context.Background(), "ws-x", ChatInput{ChatID: "cx", Agent: AgentCodex, From: MainChat}); err != nil {
		t.Fatal(err)
	}
	f, _ := s.getFacts(ChatKey("ws-x", "cx"))
	if f.Agent != AgentCodex || f.Model != "" || f.Auth != "" || f.ClaudeSessionID != "" {
		t.Errorf("codex chat facts = %+v, want Codex on its own login and model", f)
	}
	if s.authFiles().read(ChatKey("ws-x", "cx")) != "" {
		t.Error("a Claude credential was given to a Codex chat")
	}
}

func TestDeletingAChatLeavesItsSessionAlone(t *testing.T) {
	s, id, key := chatSession(t, ChatInput{From: MainChat})
	if _, err := s.Start(context.Background(), key, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.SetEnvironment(context.Background(), id, map[string]string{"FOO": "bar"}, nil, ""); err != nil {
		t.Fatal(err)
	}
	transcript := s.handoffPath(id, "c1")
	if err := s.DeleteChat(context.Background(), id, "c1"); err != nil {
		t.Fatalf("DeleteChat: %v", err)
	}
	if s.HasChat(id, "c1") || s.tmux.(*fakeSessions).running[sessionName(key)] {
		t.Error("the chat is still there")
	}
	if _, err := os.Stat(transcript); !os.IsNotExist(err) {
		t.Error("the fork's transcript was left behind")
	}
	if _, ok := s.getFacts(id); !ok {
		t.Fatal("deleting a chat forgot its session")
	}
	if _, err := os.Stat(s.envFiles().path(id)); err != nil {
		t.Errorf("deleting a chat took its session's environment: %v", err)
	}
	if err := s.DeleteChat(context.Background(), id, "c1"); err != nil {
		t.Errorf("deleting it again = %v, want nil", err)
	}
}

func TestDestroyingASessionEndsItsChats(t *testing.T) {
	s, id, key := chatSession(t, ChatInput{})
	if _, err := s.Start(context.Background(), key, ""); err != nil {
		t.Fatal(err)
	}
	// This worktree isn't one of a mirror's, so its removal fails: after the
	// chats are ended, which they are first.
	_ = s.Destroy(context.Background(), id)
	if _, ok := s.getFacts(key); ok || s.tmux.(*fakeSessions).running[sessionName(key)] {
		t.Error("the session's chat outlived it")
	}
}

func TestChatsAreRefusedWhereTheyCantBe(t *testing.T) {
	s, id, key := chatSession(t, ChatInput{})
	if err := s.CreateChat(context.Background(), key, ChatInput{ChatID: "c2"}); !errors.Is(err, ErrUnknownWorkspace) {
		t.Errorf("a chat of a chat = %v, want ErrUnknownWorkspace", err)
	}
	if err := s.CreateChat(context.Background(), id, ChatInput{ChatID: "c3", From: "nope"}); !errors.Is(err, ErrUnknownChat) {
		t.Errorf("a fork of a chat that isn't = %v, want ErrUnknownChat", err)
	}
	for _, bad := range []string{"main", "", "../x", "A", strings.Repeat("a", 65)} {
		if err := s.CreateChat(context.Background(), id, ChatInput{ChatID: bad}); err == nil {
			t.Errorf("chat id %q accepted", bad)
		}
	}
	if sessions := s.LocalSessions(context.Background()); len(sessions) != 0 {
		t.Errorf("a cloud session's chat listed as a local session: %+v", sessions)
	}
}

func TestStoppingASessionStopsItsChats(t *testing.T) {
	s, id, key := chatSession(t, ChatInput{})
	for _, k := range []string{id, key} {
		if _, err := s.Start(context.Background(), k, ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Stop(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if fake := s.tmux.(*fakeSessions); fake.running[sessionName(key)] {
		t.Error("the chat runs on after its session stopped")
	}
}
