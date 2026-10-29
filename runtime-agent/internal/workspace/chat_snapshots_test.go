package workspace

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"runtime-agent/internal/protocol"
)

// storageServer stands in for the snapshots bucket: what is PUT to a path is
// served back from it.
func storageServer(t *testing.T) (*httptest.Server, func(path string) []byte) {
	t.Helper()
	var mu sync.Mutex
	objects := map[string][]byte{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			objects[r.URL.Path] = body
		case http.MethodGet:
			body, ok := objects[r.URL.Path]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = w.Write(body)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, func(path string) []byte {
		mu.Lock()
		defer mu.Unlock()
		return objects[path]
	}
}

const (
	docsChat  = `{"type":"user","uuid":"d1","parentUuid":null,"timestamp":"2026-10-29T11:00:00Z","message":{"role":"user","content":"Write the docs"}}` + "\n"
	codexChat = `{"type":"user","uuid":"x1","parentUuid":null,"timestamp":"2026-10-29T12:00:00Z","message":{"role":"user","content":"Review it"}}` + "\n"
)

func TestArchivingAndRestoringASessionKeepsEveryChat(t *testing.T) {
	ctx := context.Background()
	// A session with a conversation, on a box, and two chats beside it: one
	// on Claude, one on Codex with its rollout.
	s, fake := restoringService(t)
	fake.pane = composerPane // a Claude session's
	mainSession := "main-sess"
	seed := snapshotServer(t, map[string][]byte{"/conversation": []byte(mainTranscript)})
	if _, err := s.Restore(ctx, "ws-r", protocol.RestoreWorkspaceRequest{
		Branch: "feature", BaseBranch: "main", SessionID: &mainSession,
		Downloads: downloads(seed, "bundle", "patch", "conversation"),
	}, nil); err != nil {
		t.Fatalf("seeding the session: %v", err)
	}
	for _, chat := range []ChatInput{{ChatID: "c1"}, {ChatID: "c2", Agent: AgentCodex}} {
		if err := s.CreateChat(ctx, "ws-r", chat); err != nil {
			t.Fatal(err)
		}
	}
	docs, _ := s.getFacts(ChatKey("ws-r", "c1"))
	writeTranscript(t, s, ChatKey("ws-r", "c1"), docs.ClaudeSessionID+".jsonl", docsChat, 0)
	codexKey := ChatKey("ws-r", "c2")
	if err := os.MkdirAll(filepath.Dir(conversationPath(s.Root, codexKey)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(conversationPath(s.Root, codexKey), []byte(codexChat), 0o644); err != nil {
		t.Fatal(err)
	}
	rollout := filepath.Join(t.TempDir(), "rollout-2026-10-29T12-00-00-"+fixtureSessionID+".jsonl")
	if err := os.WriteFile(rollout, fixtureRollout(t, s.worktreePath("ws-r")), 0o644); err != nil {
		t.Fatal(err)
	}
	s.updateFacts(codexKey, func(f *workspaceFacts) { f.CodexRollout, f.CodexSessionID = rollout, fixtureSessionID })

	// Archived: every chat's conversation goes to storage, and the manifest
	// names each with what the control plane knows of it.
	store, stored := storageServer(t)
	var uploads []protocol.ArchiveUpload
	for _, a := range []string{"conversation", "cast", "bundle", "patch", "summary", "manifest"} {
		uploads = append(uploads, protocol.ArchiveUpload{Artifact: a, URL: store.URL + "/" + a})
	}
	from := MainChat
	manifest, err := s.Archive(ctx, "ws-r", protocol.ArchiveWorkspaceRequest{
		ArchivedAt: "2026-10-29T13:00:00Z",
		Uploads:    uploads,
		Chats: []protocol.ArchiveChat{
			{ChatID: "c1", Name: "Docs", Kind: "chat", Agent: AgentClaude, Conversation: store.URL + "/chats/c1/conversation"},
			{ChatID: "c2", Name: "Review", Kind: "chat", ForkedFrom: &from, Agent: AgentCodex,
				Model:        &protocol.ChatModel{Provider: "codex", ID: "gpt-6-luna"},
				Conversation: store.URL + "/chats/c2/conversation", Rollout: store.URL + "/chats/c2/rollout"},
			// One the box never had (lost in an earlier restore): nothing to keep.
			{ChatID: "c3", Name: "Gone", Kind: "chat", Agent: AgentClaude, Conversation: store.URL + "/chats/c3/conversation"},
		},
	})
	if err != nil {
		t.Fatalf("Archive: %v", err)
	}
	if len(manifest.Chats) != 2 {
		t.Fatalf("manifest chats = %+v, want the two the session has", manifest.Chats)
	}
	c1, c2 := manifest.Chats[0], manifest.Chats[1]
	if c1.Name != "Docs" || c1.Agent != AgentClaude || c1.SessionID == nil || *c1.SessionID != docs.ClaudeSessionID || c1.Conversation != "chats/c1/conversation.jsonl" {
		t.Errorf("c1 = %+v", c1)
	}
	if c2.Name != "Review" || c2.Agent != AgentCodex || c2.Model == nil || c2.Model.ID != "gpt-6-luna" || c2.Rollout != "chats/c2/rollout.jsonl" ||
		c2.SessionID == nil || *c2.SessionID != fixtureSessionID {
		t.Errorf("c2 = %+v", c2)
	}
	for _, name := range []string{c1.Conversation, c2.Conversation, c2.Rollout} {
		if manifest.Checksums[name] == "" {
			t.Errorf("no checksum for %s", name)
		}
	}
	if string(stored("/chats/c1/conversation")) != docsChat || string(stored("/chats/c2/conversation")) != codexChat {
		t.Fatal("a chat's conversation didn't reach storage as it was")
	}
	if stored("/chats/c3/conversation") != nil {
		t.Error("a chat the box didn't have was uploaded")
	}

	// Restored on a fresh box: each chat is back, with its history, where its
	// agent resumes it.
	fresh, freshTmux := restoringService(t)
	freshTmux.pane = composerPane
	if _, err := fresh.Restore(ctx, "ws-r", protocol.RestoreWorkspaceRequest{
		Branch: "feature", BaseBranch: "main", SessionID: manifest.SessionID,
		Downloads: []protocol.RestoreDownload{
			{Artifact: "bundle", URL: store.URL + "/bundle"},
			{Artifact: "patch", URL: store.URL + "/patch"},
			{Artifact: "conversation", URL: store.URL + "/conversation"},
		},
		Chats: []protocol.RestoreChat{
			{ChatID: c1.ID, Agent: c1.Agent, SessionID: c1.SessionID, Conversation: store.URL + "/chats/c1/conversation"},
			{ChatID: c2.ID, Agent: c2.Agent, SessionID: c2.SessionID, Conversation: store.URL + "/chats/c2/conversation", Rollout: store.URL + "/chats/c2/rollout"},
		},
	}, nil); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if !fresh.HasChat("ws-r", "c1") || !fresh.HasChat("ws-r", "c2") {
		t.Fatal("the chats didn't come back")
	}
	if got := readFileString(t, fresh.SessionLog(ChatKey("ws-r", "c1"))); got != docsChat {
		t.Errorf("c1's conversation = %q", got)
	}
	if got := readFileString(t, fresh.SessionLog(codexKey)); got != codexChat {
		t.Errorf("c2's conversation = %q", got)
	}
	if f, _ := fresh.getFacts(codexKey); f.CodexSessionID != fixtureSessionID || !strings.HasPrefix(f.CodexRollout, filepath.Join(fresh.codexHomeFor(codexKey), "sessions")) {
		t.Errorf("c2's facts = %+v, want it resumed by its rollout", f)
	}
	// The main chat is named by its id, and finds its own conversation, not
	// a chat's newer one.
	if f, _ := fresh.getFacts("ws-r"); f.ClaudeSessionID != mainSession {
		t.Errorf("main chat's session = %q, want %s", f.ClaudeSessionID, mainSession)
	}
	if got := readFileString(t, fresh.SessionLog("ws-r")); got != mainTranscript {
		t.Errorf("main chat's conversation = %q", got)
	}
}

func TestARestoreContinuesWhenASideChatCantBeRestored(t *testing.T) {
	s, fake := restoringService(t)
	fake.pane = composerPane
	main := "main-sess"
	mainChat := MainChat
	sideSession := "side-sess"
	srv := snapshotServer(t, map[string][]byte{"/conversation": []byte(mainTranscript), "/chat": []byte(docsChat)})
	bad := "../escape"
	_, err := s.Restore(context.Background(), "ws-r", protocol.RestoreWorkspaceRequest{
		Branch: "feature", BaseBranch: "main", SessionID: &main,
		Downloads: downloads(srv, "bundle", "patch", "conversation"),
		Chats: []protocol.RestoreChat{
			{ChatID: "bad-chat", Kind: "chat", SessionID: &bad, Conversation: srv.URL + "/missing"},
			{ChatID: "good-chat", Kind: "side", ForkedFrom: &mainChat, SessionID: &sideSession, Conversation: srv.URL + "/chat"},
		},
	}, nil)
	if err != nil {
		t.Fatalf("Restore: a failed side chat blocked the session: %v", err)
	}
	if s.HasChat("ws-r", "bad-chat") {
		t.Fatal("the chat with a session id that would escape its folder was restored")
	}
	if !s.HasChat("ws-r", "good-chat") {
		t.Fatal("the valid side chat after the failure wasn't restored")
	}
	if f, _ := s.getFacts(ChatKey("ws-r", "good-chat")); f.SideOf != "ws-r" || f.Handoff != "" {
		t.Fatalf("restored side chat facts = %+v, want side-of main with no spent handoff", f)
	}
	if prompt := s.chatPromptText(ChatKey("ws-r", "good-chat"), "What next?"); !strings.Contains(prompt, "Add dark mode to the settings page") {
		t.Fatalf("restored side chat prompt lost its source turns: %q", prompt)
	}
	if f, _ := s.getFacts("ws-r"); f.ClaudeSessionID != main {
		t.Fatalf("main chat session = %q, want %s", f.ClaudeSessionID, main)
	}
}

func TestRefusedArchiveLeavesTheSessionAndChatsRunning(t *testing.T) {
	s, id, key := chatSession(t, ChatInput{From: MainChat})
	sessions := s.tmux.(*fakeSessions)
	sessions.running[sessionName(id)] = true
	sessions.running[sessionName(key)] = true
	_, err := s.Archive(context.Background(), id, protocol.ArchiveWorkspaceRequest{Chats: []protocol.ArchiveChat{{ChatID: "c1"}}})
	if err == nil || !strings.Contains(err.Error(), "unspent fork handoff") {
		t.Fatalf("archive refusal: %v", err)
	}
	if !sessions.running[sessionName(id)] || !sessions.running[sessionName(key)] {
		t.Fatal("refused archive stopped a running conversation")
	}
}
