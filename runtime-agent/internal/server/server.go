// Package server is a thin HTTP/WS shell over the workspace service. Next (the
// control plane) calls the HTTP routes; the browser connects directly to WS
// /pty. Every request carries a Runtime token the agent verifies — the agent
// trusts nothing else.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"runtime-agent/internal/ask"
	"runtime-agent/internal/auth"
	"runtime-agent/internal/claude"
	"runtime-agent/internal/conversation"
	"runtime-agent/internal/editor"
	"runtime-agent/internal/gitcred"
	"runtime-agent/internal/media"
	"runtime-agent/internal/ports"
	"runtime-agent/internal/preview"
	"runtime-agent/internal/protocol"
	"runtime-agent/internal/ptyx"
	"runtime-agent/internal/redact"
	"runtime-agent/internal/sessiontools"
	"runtime-agent/internal/workspace"
)

// Frozen wire contract knobs. 16 ms ≈ 60 fps terminal; 4 KB matches xterm's
// natural write chunking. Changing these changes user-visible latency, so keep
// them in one place.
const (
	coalesceInterval  = 16 * time.Millisecond
	coalesceThreshold = 4096
	// SSE keeps proxies from idling out an in-flight but quiet stream; the same
	// interval is the /events-ws ping period.
	sseHeartbeat      = 20 * time.Second
	maxWSMessageBytes = 64 * 1024
	// events-ws keepalive. The browser auto-pongs our ping; a peer that goes
	// silent (suspended WKWebView, NAT drop) misses pongs, trips the read
	// deadline, and the reader unblocks so the handler tears down instead of
	// leaking the watcher goroutine + channel. pongWait > ping period (~3 missed
	// pings). A write deadline stops a stalled client blocking the stream loop.
	eventsWSPongWait  = 60 * time.Second
	eventsWSWriteWait = 10 * time.Second
)

// How often a Conversation stream rechecks the session state, so a "starting"
// stream reports "running" once the session log appears.
const stateCheckInterval = time.Second

type Server struct {
	secret string
	ws     *workspace.Service
	// Editor runs VS Code in the browser on this box (package editor).
	Editor *editor.Editor
	// AgentPort is the port this agent serves on, left out of the box's
	// servers; ProcRoot is where they're read from ("/proc" but in tests).
	AgentPort int
	ProcRoot  string
	upgrader  websocket.Upgrader
	broker    *ptyx.Broker
	// startedAt gives a newly provisioned box a short idle grace. It is kept
	// separate from actual user input so an agent restart cannot refresh the
	// unknown-activity deadline.
	startedAt time.Time
	// lastInput: when a user last did something here (Unix nanoseconds) — typed
	// in a terminal or made a control call.
	lastInput atomic.Int64
}

type claimsContextKey struct{}

func New(secret string, ws *workspace.Service) *Server {
	s := &Server{
		secret:    secret,
		ws:        ws,
		startedAt: time.Now().UTC(),
		broker:    ptyx.NewBroker(),
		Editor:    &editor.Editor{Home: ws.Root, Env: ws.SessionEnv()},
		upgrader: websocket.Upgrader{
			// The Daytona preview proxy already gates access; the Runtime token in
			// the URL is the real authorization check.
			CheckOrigin: func(*http.Request) bool { return true },
		},
	}
	return s
}

// touch records a user's activity now.
func (s *Server) touch() { s.lastInput.Store(time.Now().UnixNano()) }

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("POST /workspaces", s.authed(s.createWorkspace))
	mux.HandleFunc("GET /workspaces", s.authed(s.listWorkspaces))
	mux.HandleFunc("POST /workspaces/{id}/start", s.authed(s.startWorkspace))
	mux.HandleFunc("POST /workspaces/{id}/stop", s.authed(s.stopWorkspace))
	mux.HandleFunc("POST /workspaces/{id}/resume", s.authed(s.resumeWorkspace))
	mux.HandleFunc("POST /workspaces/{id}/archive", s.authed(s.archiveWorkspace))
	mux.HandleFunc("POST /workspaces/{id}/restore", s.authed(s.restoreWorkspace))
	mux.HandleFunc("POST /workspaces/{id}/destroy", s.authed(s.destroyWorkspace))
	mux.HandleFunc("POST /workspaces/{id}/message", s.authed(s.sendMessage))
	mux.HandleFunc("POST /workspaces/{id}/interrupt", s.authed(s.interrupt))
	mux.HandleFunc("POST /workspaces/{id}/compact", s.authed(s.compact))
	mux.HandleFunc("POST /workspaces/{id}/plan", s.authed(s.planAction))
	mux.HandleFunc("POST /workspaces/{id}/editor", s.authed(s.openEditor))
	mux.HandleFunc("GET /workspaces/{id}/ports", s.authed(s.listPorts))
	mux.HandleFunc("POST /workspaces/{id}/answer", s.authed(s.answer))
	mux.HandleFunc("POST /workspaces/{id}/chats", s.authed(s.createChat))
	mux.HandleFunc("POST /workspaces/{id}/chats/{chat}/delete", s.authed(s.deleteChat))
	// The session's own relay asks, with the session's ask token rather than
	// a Runtime token (package ask).
	mux.HandleFunc("POST /workspaces/{id}/ask", s.ask)
	mux.HandleFunc("POST /workspaces/{id}/ask-secrets", s.askSecrets)
	// `runtime-agent preview` asks, with the session's ask token too
	// (package preview).
	mux.HandleFunc("POST /workspaces/{id}/preview", s.createPreview)
	// A session's upload of a screenshot or recording (its upload_media
	// tool, or `outrunner media upload`), with its ask token as ask's.
	mux.HandleFunc("POST /workspaces/{id}/media", s.uploadMedia)
	mux.HandleFunc("POST /workspaces/{id}/secrets", s.authed(s.provideSecrets))
	// git's credential helper and the gh wrapper on this box ask, with the
	// agent's credential token (package gitcred).
	mux.HandleFunc("POST /git-credential", s.gitCredential)
	mux.HandleFunc("POST /session-tools", s.sessionTool)
	mux.HandleFunc("POST /workspaces/{id}/model", s.authed(s.setModel))
	mux.HandleFunc("POST /workspaces/{id}/auth", s.authed(s.setAuth))
	mux.HandleFunc("POST /workspaces/{id}/environment", s.authed(s.setEnvironment))
	mux.HandleFunc("POST /config", s.authed(s.setAgentConfig))
	mux.HandleFunc("POST /skills", s.authed(s.setSkills))
	mux.HandleFunc("POST /agent-context", s.authed(s.setAgentContext))
	mux.HandleFunc("POST /warm", s.authed(s.startWarm))
	mux.HandleFunc("GET /warm", s.authed(s.warmStatus))
	mux.HandleFunc("GET /pty", s.pty)
	mux.HandleFunc("GET /events", s.events)
	mux.HandleFunc("GET /events-ws", s.eventsWS)
	mux.HandleFunc("GET /workspaces/{id}/summary", s.authed(s.workspaceSummary))
	mux.HandleFunc("GET /workspaces/{id}/changes", s.authed(s.workspaceChanges))
	mux.HandleFunc("GET /workspaces/{id}/files", s.authed(s.workspaceFiles))
	mux.HandleFunc("GET /workspaces/{id}/canvas", s.authed(s.workspaceCanvas))
	mux.HandleFunc("GET /workspaces/{id}/canvas/file", s.authed(s.workspaceCanvasFile))
	mux.HandleFunc("GET /activity", s.authed(s.activity))
	return mux
}

// health answers unauthenticated, so it says nothing but that the agent is up,
// which gateways it can run a session through (public: they're in the
// source), and which agents (whether Codex is installed), for the web app to
// offer only those. An agent from before gateways supports OpenRouter alone;
// one from before agents runs Claude alone.
func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	gateways := []string{}
	for _, g := range claude.Gateways() {
		gateways = append(gateways, string(g))
	}
	writeJSON(w, http.StatusOK, protocol.Health{
		Status:   "ok",
		Gateways: gateways,
		Agents:   s.ws.Agents(),
		Features: []string{protocol.FeatureImports, protocol.FeatureEnvironment, protocol.FeatureAgentConfig, protocol.FeatureRestoreModel, protocol.FeatureEditor, protocol.FeaturePorts, protocol.FeatureCodexGateway, protocol.FeatureInstructions, protocol.FeatureRequestSecrets, protocol.FeatureWarmHooks, protocol.FeatureMultiRepo, protocol.FeatureMultiRepoSnapshots, protocol.FeatureGitCredential, protocol.FeatureMultiRepoWarm, protocol.FeaturePlanMode, protocol.FeatureCompact, protocol.FeatureFiles, protocol.FeatureMessageKeys, protocol.FeatureSkills, protocol.FeatureCodexMCP, protocol.FeatureCanvas, protocol.FeatureAgentContext, protocol.FeatureChats},
	})
}

// authed verifies the Bearer Runtime token before invoking a control handler.
func (s *Server) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := bearer(r)
		claims, err := auth.Verify(token, s.secret)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid Runtime token")
			return
		}
		// A control call that changes something is someone at work. Reads
		// aren't: a poll of a summary mustn't keep an idle box up.
		if r.Method == http.MethodPost {
			s.touch()
		}
		next(w, r.WithContext(context.WithValue(r.Context(), claimsContextKey{}, claims)))
	}
}

func (s *Server) createWorkspace(w http.ResponseWriter, r *http.Request) {
	var req protocol.CreateWorkspaceRequest
	if !decode(w, r, &req) {
		return
	}
	if !s.requireWorkspace(w, r, req.WorkspaceID) {
		return
	}
	mode, err := claude.ParsePermissionMode(req.PermissionMode)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	if req.Model != "" && !claude.ValidModel(req.Model) {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid model")
		return
	}
	if err := s.ws.CheckAgent(req.Agent); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	if err := workspace.ValidGuide(req.Guide); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	var gitUser *workspace.GitUser
	if req.GitUser != nil {
		gitUser = &workspace.GitUser{Name: req.GitUser.Name, Email: req.GitUser.Email}
	}
	worktree, err := s.ws.Create(r.Context(), workspace.CreateInput{
		WorkspaceID:    req.WorkspaceID,
		Branch:         req.Branch,
		BaseBranch:     req.BaseBranch,
		RepoPath:       req.RepoPath,
		PermissionMode: mode,
		Title:          req.Title,
		Model:          req.Model,
		Agent:          req.Agent,
		GitUser:        gitUser,
		Checkouts:      checkouts(req.Repos),
	})
	switch {
	case errors.Is(err, workspace.ErrBypassInFolder), errors.Is(err, workspace.ErrInvalidCheckouts):
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	if err := s.ws.SetGuide(req.WorkspaceID, req.Guide); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"worktree": worktree})
}

func (s *Server) startWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	key, ok := s.chatOf(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	// The Anthropic token is supplied out-of-band by the control plane at
	// provision time and held in agent memory (M2 wiring); empty here.
	name, err := s.ws.Start(r.Context(), key, "")
	respond(w, name, err)
}

func (s *Server) stopWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	key, ok := s.chatOf(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	err := s.ws.Stop(r.Context(), key)
	respond(w, "stopped", err)
}

func (s *Server) resumeWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	key, ok := s.chatOf(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	name, err := s.ws.Resume(r.Context(), key, "")
	respond(w, name, err)
}

func (s *Server) archiveWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	var req protocol.ArchiveWorkspaceRequest
	if !decode(w, r, &req) {
		return
	}
	if req.ArchivedAt == "" || len(req.Uploads) == 0 {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "archive requires archivedAt and upload URLs")
		return
	}
	manifest, err := s.ws.Archive(r.Context(), r.PathValue("id"), req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, manifest)
}

func (s *Server) destroyWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	err := s.ws.Destroy(r.Context(), r.PathValue("id"))
	respond(w, "destroyed", err)
}

func (s *Server) restoreWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	var req protocol.RestoreWorkspaceRequest
	if !decode(w, r, &req) {
		return
	}
	if req.Branch == "" || len(req.Downloads) == 0 {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "restore requires a branch and download URLs")
		return
	}
	if err := validImportRestore(req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	if err := s.ws.CheckAgent(req.Agent); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	if req.Auth != nil {
		if err := validAuth(*req.Auth); err != nil {
			writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
			return
		}
		if err := s.ws.CheckAuth(req.Auth.Kind); err != nil {
			writeError(w, http.StatusConflict, "UNSUPPORTED", err.Error())
			return
		}
	}
	var model *workspace.ModelChoice
	if req.Model != nil {
		choice, err := modelChoice(*req.Model)
		if err != nil {
			writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
			return
		}
		model = &choice
	}
	name, err := s.ws.Restore(r.Context(), r.PathValue("id"), req, model)
	switch {
	case errors.Is(err, workspace.ErrAuthMismatch), errors.Is(err, workspace.ErrGatewayUnsupported), errors.Is(err, workspace.ErrInvalidCheckouts):
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
	case errors.Is(err, workspace.ErrModelUnsupported):
		writeError(w, http.StatusConflict, "CONFLICT", err.Error())
	case err != nil:
		respond(w, name, err)
	default:
		// The worktree too, as create answers it: the control plane has none
		// on record for a session imported from a Mac.
		writeJSON(w, http.StatusOK, map[string]string{"result": name, "worktree": s.ws.Worktree(r.PathValue("id"))})
	}
}

// workspaceSummary serves the current WorkspaceSummary — the canonical, cross-
// milestone summary Mission Engine consumes. Cheap enough for polling; git
// stats are shelled out at request time (typical <20ms on a healthy worktree).
func (s *Server) workspaceSummary(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	key, ok := s.chatOf(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	summary := s.ws.SummaryOf(r.Context(), key)
	writeJSON(w, http.StatusOK, summary)
}

// queryClaims verifies the Runtime token a WebSocket or SSE client carries in
// its URL (browsers cannot set headers on those) and that the workspace it
// names is a well-formed id, since streams use it as a session and path name.
func (s *Server) queryClaims(r *http.Request) (*protocol.RuntimeTokenClaims, error) {
	claims, err := auth.Verify(r.URL.Query().Get("token"), s.secret)
	if err != nil {
		return nil, err
	}
	if !validWorkspaceID(claims.WorkspaceID) {
		return nil, auth.ErrMalformed
	}
	return claims, nil
}

// listWorkspaces lists the local sessions this agent knows — the desktop's
// session list, since local sessions are not in the shared database. It takes
// the listing token only: a workspace's own token covers that workspace alone.
// activity reports the box's activity (protocol.Activity), for the control
// plane to pause an idle box. Box-wide, so only the listing token may ask.
func (s *Server) activity(w http.ResponseWriter, r *http.Request) {
	claims, _ := r.Context().Value(claimsContextKey{}).(*protocol.RuntimeTokenClaims)
	if claims == nil || claims.WorkspaceID != protocol.ListingWorkspaceID {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Runtime token does not authorize reading the box's activity")
		return
	}
	last, turnInProgress, unknown := s.ws.Activity()
	if input := time.Unix(0, s.lastInput.Load()); input.After(last) {
		last = input
	}
	// Boot gives a newly provisioned, otherwise idle box a short window to
	// receive its first request. When session activity is unknown, do not let a
	// runtime-agent restart keep resetting the reconciler's pause clock; the
	// workspace service's persisted unknown interval is authoritative instead.
	if !unknown && s.startedAt.After(last) {
		last = s.startedAt
	}
	// Someone working in the editor is activity: its heartbeat beats while a
	// tab is open on it, so an editor left open also keeps the box awake
	// (the 8-hour link's day, as the terminal's open tab does).
	if used := s.Editor.LastUsed(r.Context()); used.After(last) {
		last = used
	}
	writeJSON(w, http.StatusOK, protocol.Activity{
		LastActivity:   last.UTC().Format(time.RFC3339),
		TurnInProgress: turnInProgress,
	})
}

// startWarm starts warming this box ahead of a session (workspace.Warm).
// Box-wide, so only the listing token may.
func (s *Server) startWarm(w http.ResponseWriter, r *http.Request) {
	if !s.listingOnly(w, r, "warming the box") {
		return
	}
	var req protocol.WarmRequest
	if !decode(w, r, &req) {
		return
	}
	err := s.ws.Warm(r.Context(), workspace.WarmRequest{BaseBranch: req.BaseBranch, Env: req.Env, Files: req.Files, Hook: req.Hook, Checkouts: checkouts(req.Repos)})
	switch {
	case errors.Is(err, workspace.ErrWarmBusy):
		writeError(w, http.StatusConflict, "CONFLICT", err.Error())
	case errors.Is(err, workspace.ErrInvalidEnvironment), errors.Is(err, workspace.ErrInvalidCheckouts):
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
	default:
		respond(w, "warming", err)
	}
}

// warmStatus says how the box's warming went.
func (s *Server) warmStatus(w http.ResponseWriter, r *http.Request) {
	if !s.listingOnly(w, r, "reading the box's warming") {
		return
	}
	st := s.ws.WarmState()
	writeJSON(w, http.StatusOK, protocol.WarmStatus{
		State: st.State, BaseBranch: st.BaseBranch, StartedAt: st.StartedAt, FinishedAt: st.FinishedAt, ExitCode: st.ExitCode, Log: st.Log,
	})
}

// listingOnly refuses a box-wide call made with a workspace's own token.
func (s *Server) listingOnly(w http.ResponseWriter, r *http.Request, what string) bool {
	claims, _ := r.Context().Value(claimsContextKey{}).(*protocol.RuntimeTokenClaims)
	if claims == nil || claims.WorkspaceID != protocol.ListingWorkspaceID {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Runtime token does not authorize "+what)
		return false
	}
	return true
}

func (s *Server) listWorkspaces(w http.ResponseWriter, r *http.Request) {
	claims, _ := r.Context().Value(claimsContextKey{}).(*protocol.RuntimeTokenClaims)
	if claims == nil || claims.WorkspaceID != protocol.ListingWorkspaceID {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Runtime token does not authorize listing workspaces")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspaces": s.ws.LocalSessions(r.Context())})
}

// workspaceChanges serves the Changes panel for a session whose control plane
// cannot reach the worktree itself (a local one): the changed files, or with
// ?path= one file's bounded diff — the shapes /api/workspaces/[id]/changes uses.
func (s *Server) workspaceChanges(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.requireWorkspace(w, r, id) {
		return
	}
	if path := r.URL.Query().Get("path"); path != "" {
		diff, err := s.ws.FileDiff(r.Context(), id, path)
		switch {
		case errors.Is(err, workspace.ErrInvalidPath):
			writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		case errors.Is(err, workspace.ErrNotChanged):
			writeError(w, http.StatusNotFound, "NOT_FOUND", err.Error())
		case err != nil:
			writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		default:
			writeJSON(w, http.StatusOK, map[string]string{"diff": diff})
		}
		return
	}
	files, err := s.ws.Changes(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": files})
}

// workspaceFiles lists the session's files, its changed ones first, for the
// composer's @ mentions.
func (s *Server) workspaceFiles(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.requireWorkspace(w, r, id) {
		return
	}
	files, err := s.ws.Files(r.Context(), id)
	if err != nil {
		respond(w, "", err)
		return
	}
	writeJSON(w, http.StatusOK, files)
}

// workspaceCanvas lists the session's Canvas.
func (s *Server) workspaceCanvas(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.requireWorkspace(w, r, id) {
		return
	}
	canvas, err := s.ws.CanvasFiles(id)
	if err != nil {
		respond(w, "", err)
		return
	}
	writeJSON(w, http.StatusOK, canvas)
}

// workspaceCanvasFile answers one file of the session's Canvas (?path=), as
// bytes: the app says what it is and how it's shown.
func (s *Server) workspaceCanvasFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.requireWorkspace(w, r, id) {
		return
	}
	data, err := s.ws.CanvasFile(id, r.URL.Query().Get("path"))
	switch {
	case errors.Is(err, workspace.ErrInvalidCanvasPath):
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
	case errors.Is(err, fs.ErrNotExist):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "no such file in the Canvas")
	case errors.Is(err, workspace.ErrCanvasFileTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "TOO_LARGE", err.Error())
	case err != nil:
		respond(w, "", err)
	default:
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(data)
	}
}

// requireWorkspace binds a verified Runtime token to the exact workspace a
// control request addresses. A token for one workspace must never be usable to
// stop, archive, destroy, or inspect another workspace on the same computer.
func (s *Server) requireWorkspace(w http.ResponseWriter, r *http.Request, workspaceID string) bool {
	claims, _ := r.Context().Value(claimsContextKey{}).(*protocol.RuntimeTokenClaims)
	if claims == nil || !validWorkspaceID(workspaceID) || claims.WorkspaceID != workspaceID {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Runtime token does not authorize this workspace")
		return false
	}
	return true
}

// chatOf is the key a control request's chat runs under (workspace.ChatKey):
// ?chat= names one of the workspace's chats; none, or "main", its main chat,
// which is all an agent from before chats has. A chat the workspace doesn't
// have is refused rather than taken for the main one.
func (s *Server) chatOf(w http.ResponseWriter, r *http.Request, workspaceID string) (string, bool) {
	chat := r.URL.Query().Get("chat")
	if chat == "" || chat == workspace.MainChat {
		return workspaceID, true
	}
	if !workspace.ValidChatID(chat) {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid chat id")
		return "", false
	}
	if !s.ws.HasChat(workspaceID, chat) {
		writeError(w, http.StatusNotFound, "CHAT_NOT_FOUND", workspace.ErrUnknownChat.Error())
		return "", false
	}
	return workspace.ChatKey(workspaceID, chat), true
}

// createChat makes a chat in the workspace's session and starts its agent
// (workspace.CreateChat): afresh, or forked from one of its chats. Making
// one that exists starts it, as start does.
func (s *Server) createChat(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.requireWorkspace(w, r, id) {
		return
	}
	var req protocol.CreateChatRequest
	if !decode(w, r, &req) {
		return
	}
	if !workspace.ValidChatID(req.ChatID) {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid chat id")
		return
	}
	if req.From != "" && req.From != workspace.MainChat && !workspace.ValidChatID(req.From) {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid chat to fork")
		return
	}
	if req.Side && req.From == "" {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "a side chat is about another chat: name it in from")
		return
	}
	if err := s.ws.CheckAgent(req.Agent); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	err := s.ws.CreateChat(r.Context(), id, workspace.ChatInput{
		ChatID: req.ChatID, Agent: req.Agent, From: req.From, FromName: req.FromName, Side: req.Side,
	})
	switch {
	case errors.Is(err, workspace.ErrUnknownChat):
		writeError(w, http.StatusNotFound, "CHAT_NOT_FOUND", err.Error())
		return
	case errors.Is(err, workspace.ErrChatsUnsupported), errors.Is(err, workspace.ErrAgentUnsupported):
		writeError(w, http.StatusConflict, "UNSUPPORTED", err.Error())
		return
	case err != nil:
		respond(w, "", err)
		return
	}
	if req.NoStart {
		respond(w, "created", nil)
		return
	}
	name, err := s.ws.Start(r.Context(), workspace.ChatKey(id, req.ChatID), "")
	respond(w, name, err)
}

// deleteChat ends one of the workspace's chats and forgets it.
func (s *Server) deleteChat(w http.ResponseWriter, r *http.Request) {
	id, chat := r.PathValue("id"), r.PathValue("chat")
	if !s.requireWorkspace(w, r, id) {
		return
	}
	if !workspace.ValidChatID(chat) {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid chat id; the main chat ends with its session")
		return
	}
	respond(w, "deleted", s.ws.DeleteChat(r.Context(), id, chat))
}

// validWorkspaceID admits the ids the control plane mints (UUIDs) and the short
// ones tests use. The id becomes a path segment under the agent root, so
// anything that could climb out of it is refused before it reaches a handler.
func validWorkspaceID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !(c == '-' || c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
			return false
		}
	}
	return true
}

// sendMessage delivers a user prompt to the workspace's agent session (jcode
// engine). Replaces typing into the PTY: the browser composer POSTs the prompt
// and observes the reply on the conversation SSE stream.
func (s *Server) sendMessage(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	key, ok := s.chatOf(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	var req protocol.SendMessageRequest
	if !decode(w, r, &req) {
		return
	}
	if req.Content == "" {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "message requires content")
		return
	}
	if req.Mode != "" && req.Mode != workspace.ModePlan && req.Mode != workspace.ModeBuild {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "mode is plan or build")
		return
	}
	err := s.ws.SendPromptOnce(key, workspace.Prompt{Content: req.Content, Mode: req.Mode, Dismiss: req.Dismiss}, req.Key)
	switch {
	case errors.Is(err, workspace.ErrInvalidMessageKey):
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
	case errors.Is(err, workspace.ErrModeBusy), errors.Is(err, workspace.ErrSessionUnchecked):
		writeError(w, http.StatusConflict, "CONFLICT", err.Error())
	case errors.Is(err, workspace.ErrModeUnsupported):
		writeError(w, http.StatusConflict, "UNSUPPORTED", err.Error())
	default:
		respond(w, "sent", err)
	}
}

// planAction answers the plan the workspace's agent waits on: approved, it
// goes on to build it (Service.ApprovePlan).
func (s *Server) planAction(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	key, ok := s.chatOf(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	var req protocol.PlanActionRequest
	if !decode(w, r, &req) {
		return
	}
	if req.Action != "approve" {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "a plan is approved here; revise it with a prompt in plan mode")
		return
	}
	via, err := s.ws.ApprovePlan(key)
	switch {
	case errors.Is(err, workspace.ErrNoPlanWaiting):
		// Answered already (another tab, the terminal): nothing failed. The
		// answer says the mode the session is in, which only its screen
		// knows for sure, for the page's toggle.
		writeJSON(w, http.StatusOK, protocol.PlanActionResponse{Result: "answered", Mode: s.ws.PlanAnsweredMode(key)})
	case errors.Is(err, workspace.ErrModeBusy),
		errors.Is(err, workspace.ErrSessionUnchecked), errors.Is(err, workspace.ErrNotInterrupted):
		writeError(w, http.StatusConflict, "CONFLICT", err.Error())
	case errors.Is(err, workspace.ErrModeUnsupported):
		writeError(w, http.StatusConflict, "UNSUPPORTED", err.Error())
	case err != nil:
		respond(w, "", err)
	default:
		writeJSON(w, http.StatusOK, protocol.PlanActionResponse{Result: "approved", Via: via})
	}
}

// compact compacts the workspace's conversation, as /compact does in its
// terminal; the stream shows the compaction once the agent has written it.
func (s *Server) compact(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	key, ok := s.chatOf(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	// A body is optional: /compact alone takes none.
	var req protocol.CompactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "malformed JSON body")
		return
	}
	err := s.ws.Compact(key, req.Instructions)
	switch {
	case errors.Is(err, workspace.ErrCompactBusy), errors.Is(err, workspace.ErrSessionUnchecked),
		errors.Is(err, workspace.ErrPromptStaged):
		writeError(w, http.StatusConflict, "CONFLICT", err.Error())
	case errors.Is(err, workspace.ErrCompactUnsupported):
		writeError(w, http.StatusConflict, "UNSUPPORTED", err.Error())
	default:
		respond(w, "compacting", err)
	}
}

// interrupt stops the turn the workspace's session is running, if any.
func (s *Server) interrupt(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	key, ok := s.chatOf(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	err := s.ws.Interrupt(r.Context(), key)
	if errors.Is(err, workspace.ErrNotInterrupted) {
		writeError(w, http.StatusConflict, "CONFLICT", err.Error())
		return
	}
	respond(w, "interrupted", err)
}

// openEditor has the box's editor running and says where it is, and the
// session's folder to open it on.
func (s *Server) openEditor(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.requireWorkspace(w, r, id) {
		return
	}
	folder, err := s.ws.Folder(id)
	if err != nil {
		respond(w, "", err)
		return
	}
	port, err := s.Editor.Ensure(r.Context())
	if errors.Is(err, editor.ErrStarting) {
		// Being installed or started: the caller asks again.
		writeJSON(w, http.StatusAccepted, map[string]string{"result": "starting"})
		return
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, "EDITOR", err.Error())
		return
	}
	s.touch()
	writeJSON(w, http.StatusOK, protocol.EditorResponse{Port: port, Folder: folder})
}

// listPorts says which servers are running on the box: not the agent's own,
// the editor's, or the provider's.
func (s *Server) listPorts(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.requireWorkspace(w, r, id) {
		return
	}
	if _, err := s.ws.Folder(id); err != nil {
		respond(w, "", err)
		return
	}
	root := s.ProcRoot
	if root == "" {
		root = "/proc"
	}
	// AgentPort is set by main from the port it bound; the control plane's
	// AGENT_PORT is what boxes are deployed with.
	found, err := ports.Listening(root, s.AgentPort, editor.Port)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", "can't read this box's servers: "+err.Error())
		return
	}
	out := protocol.PortsResponse{Ports: []protocol.ListeningPort{}}
	for _, p := range found {
		out.Ports = append(out.Ports, protocol.ListeningPort{Port: p.Port, Process: p.Process})
	}
	writeJSON(w, http.StatusOK, out)
}

// ask holds a question the session's agent asked (its ask_user relay's call)
// until the user answers it in the browser, or the relay gives the call up.
func (s *Server) ask(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validWorkspaceID(id) || !s.ws.AskAuthorized(id, bearer(r)) {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "this session can't ask questions here")
		return
	}
	var req struct {
		RequestID string         `json:"requestId"`
		Questions []ask.Question `json:"questions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "malformed questions: "+err.Error())
		return
	}
	if req.RequestID == "" {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "ask requires a requestId")
		return
	}
	// Read to the end: only then does the server watch the connection, so a
	// relay giving the call up (its agent interrupted) ends the wait.
	_, _ = io.Copy(io.Discard, r.Body)
	text, err := s.ws.Ask(r.Context(), id, req.RequestID, req.Questions)
	switch {
	case r.Context().Err() != nil:
		return // the relay gave the call up: nobody to answer
	case errors.Is(err, ask.ErrInvalid):
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
	case errors.Is(err, ask.ErrBusy), errors.Is(err, ask.ErrReplaced):
		writeError(w, http.StatusConflict, "CONFLICT", err.Error())
	case err != nil:
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
	default:
		writeJSON(w, http.StatusOK, map[string]string{"text": text})
	}
}

// answer gives the user's reply to the questions the session is waiting on.
func (s *Server) answer(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	key, ok := s.chatOf(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	var req struct {
		Questions []ask.Question `json:"questions"`
		ask.Reply
	}
	if !decode(w, r, &req) {
		return
	}
	err := s.ws.Answer(key, req.Questions, req.Reply)
	switch {
	case errors.Is(err, ask.ErrNotWaiting):
		writeError(w, http.StatusConflict, "CONFLICT", err.Error())
	case errors.Is(err, ask.ErrInvalid):
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
	default:
		respond(w, "answered", err)
	}
}

// createPreview makes a preview of a server the session runs, for its
// agent's `runtime-agent preview`: the control plane's refusal (a port it
// won't preview, previews off) comes back as its own status and sentence.
func (s *Server) createPreview(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validWorkspaceID(id) || !s.ws.AskAuthorized(id, bearer(r)) {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "this session can't make previews here")
		return
	}
	if !s.ws.PreviewsEnabled() {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Previews are for Outrunner's cloud sessions.")
		return
	}
	var req preview.LocalRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "malformed request: "+err.Error())
		return
	}
	if req.Port < 1 || req.Port > 65535 || len(req.Label) > 200 {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "a preview needs a port, and a short label at most")
		return
	}
	made, err := s.ws.CreatePreview(r.Context(), id, req.Port, req.Label)
	var refusal *preview.Error
	switch {
	case errors.As(err, &refusal):
		status := refusal.Status
		if status < 400 || status > 599 {
			status = http.StatusBadGateway
		}
		writeError(w, status, "REFUSED", refusal.Message)
	case err != nil:
		writeError(w, http.StatusBadGateway, "UNAVAILABLE", err.Error())
	default:
		writeJSON(w, http.StatusOK, preview.LocalResponse{Preview: made})
	}
}

// askSecrets holds a request for secrets the session's agent made (its
// request_secrets call) until the user answers it in the browser, or the
// relay gives the call up. The request names variables; no value comes this
// way.
func (s *Server) askSecrets(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validWorkspaceID(id) || !s.ws.AskAuthorized(id, bearer(r)) {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "this session can't ask for secrets here")
		return
	}
	var req struct {
		RequestID string `json:"requestId"`
		ask.SecretRequest
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "malformed request: "+err.Error())
		return
	}
	if req.RequestID == "" {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "a request needs a requestId")
		return
	}
	_, _ = io.Copy(io.Discard, r.Body) // as ask: the server then watches the connection
	text, err := s.ws.RequestSecrets(r.Context(), id, req.RequestID, req.SecretRequest)
	switch {
	case r.Context().Err() != nil:
		return
	case errors.Is(err, ask.ErrInvalid):
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
	case errors.Is(err, ask.ErrBusy), errors.Is(err, ask.ErrReplaced):
		writeError(w, http.StatusConflict, "CONFLICT", err.Error())
	case err != nil:
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
	default:
		writeJSON(w, http.StatusOK, map[string]string{"text": text})
	}
}

// uploadMedia uploads a file from the box for the session, to Outrunner,
// answering with its link and the markdown that shows it. A refusal (a file
// too large, an org at its limit) is the session's agent's to read: its
// message is the error's.
func (s *Server) uploadMedia(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validWorkspaceID(id) || !s.ws.AskAuthorized(id, bearer(r)) {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "this session can't upload files here")
		return
	}
	var req struct {
		Path   string `json:"path"`
		Name   string `json:"name"`
		Access string `json:"access"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "malformed upload: "+err.Error())
		return
	}
	result, err := s.ws.UploadMedia(r.Context(), id, req.Path, media.Options{Name: req.Name, Access: req.Access})
	var refused *media.Error
	switch {
	case errors.As(err, &refused):
		writeError(w, http.StatusUnprocessableEntity, "REFUSED", refused.Message)
	case errors.Is(err, workspace.ErrNoMedia):
		writeError(w, http.StatusConflict, "UNSUPPORTED", err.Error())
	case err != nil:
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
	default:
		writeJSON(w, http.StatusOK, struct {
			Text string `json:"text"`
			media.Result
		}{media.Text(result), result})
	}
}

// provideSecrets gives the user's answer to the request for secrets the
// session is waiting on. Its values are never logged or echoed back.
func (s *Server) provideSecrets(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	key, ok := s.chatOf(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	var req protocol.ProvideSecretsRequest
	if !decode(w, r, &req) {
		return
	}
	err := s.ws.ProvideSecrets(key, req.Keys, req.Values, req.Skipped)
	switch {
	case errors.Is(err, ask.ErrNotWaiting):
		writeError(w, http.StatusConflict, "CONFLICT", err.Error())
	case errors.Is(err, workspace.ErrInvalidEnvironment):
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
	default:
		respond(w, "provided", err)
	}
}

// gitCredential gives git's credential helper or the gh wrapper a GitHub
// token for a repository, from the control plane, or forgets one git was
// refused. Its refusals are {"error": message}, the helpers' to show: a
// message from the control plane (a repository the user's GitHub doesn't
// reach) is passed on as it came.
func (s *Server) gitCredential(w http.ResponseWriter, r *http.Request) {
	refuse := func(status int, message string) {
		writeJSON(w, status, gitcred.LocalError{Error: message})
	}
	if !s.ws.GitCredentialEnabled() {
		refuse(http.StatusNotFound, "this computer gets no GitHub tokens from Outrunner")
		return
	}
	if !s.ws.GitCredentialAuthorized(bearer(r)) {
		refuse(http.StatusUnauthorized, "invalid credential token")
		return
	}
	var req gitcred.LocalRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		refuse(http.StatusBadRequest, "malformed request")
		return
	}
	if req.Erase {
		if err := s.ws.EraseGitCredential(req.Repo); err != nil {
			refuse(http.StatusBadRequest, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	cred, err := s.ws.GitCredential(r.Context(), req.Repo)
	var refusal *gitcred.Error
	switch {
	case errors.Is(err, gitcred.ErrInvalidRepo):
		refuse(http.StatusBadRequest, err.Error())
		return
	case errors.As(err, &refusal) && refusal.Refused():
		// Outrunner said no (the user chose the App, and it isn't installed
		// there): the helpers mustn't answer with the box's own token instead.
		refuse(http.StatusConflict, err.Error())
		return
	case err != nil:
		refuse(http.StatusBadGateway, err.Error())
		return
	}
	answer := gitcred.LocalResponse{Token: cred.Token}
	if !cred.ExpiresAt.IsZero() {
		at := cred.ExpiresAt.UTC().Format(time.RFC3339)
		answer.ExpiresAt = &at
	}
	writeJSON(w, http.StatusOK, answer)
}

// setModel switches the workspace's session to another model, relaunching a
// running session on it (its conversation continues).
func (s *Server) setModel(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	key, ok := s.chatOf(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	var req protocol.SetModelRequest
	if !decode(w, r, &req) {
		return
	}
	choice, err := modelChoice(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	err = s.ws.SetModel(r.Context(), key, choice, "")
	switch {
	case errors.Is(err, workspace.ErrUnknownWorkspace):
		writeError(w, http.StatusNotFound, "NOT_FOUND", err.Error())
	case errors.Is(err, workspace.ErrGatewayUnsupported):
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
	case errors.Is(err, workspace.ErrSessionBusy), errors.Is(err, workspace.ErrSessionUnchecked),
		errors.Is(err, workspace.ErrModelUnsupported):
		writeError(w, http.StatusConflict, "CONFLICT", err.Error())
	case err != nil:
		respond(w, req.Model, err)
	default:
		// The effort is always answered, empty or not: an agent from before
		// efforts answers without it, which tells the web app the effort it
		// asked for wasn't applied.
		writeJSON(w, http.StatusOK, map[string]string{"result": req.Model, "effort": req.Effort})
	}
}

// modelChoice checks a model as set or restored: a model Claude takes, a
// gateway it knows with its key (and a key only with one), and an effort it
// knows, or none.
func modelChoice(req protocol.SetModelRequest) (workspace.ModelChoice, error) {
	if !claude.ValidModel(req.Model) {
		return workspace.ModelChoice{}, errors.New("invalid model")
	}
	gateway, err := claude.ParseGateway(req.Gateway)
	if err != nil {
		return workspace.ModelChoice{}, err
	}
	if (gateway == claude.NoGateway) != (req.Token == "") || (req.Token != "" && !claude.ValidGatewayToken(req.Token)) {
		return workspace.ModelChoice{}, errors.New("a gateway needs its key, and only a gateway takes one")
	}
	if req.Effort != "" && !claude.ValidEffort(req.Effort) {
		return workspace.ModelChoice{}, errors.New("invalid effort")
	}
	return workspace.ModelChoice{Model: req.Model, Gateway: gateway, Token: req.Token, Effort: req.Effort}, nil
}

// setAuth gives the workspace's session its own credential, or takes it away;
// it applies at the session's next launch. The token is checked like a
// gateway key: it goes into a sourced file, and is masked in every session's
// output.
func (s *Server) setAuth(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	key, ok := s.chatOf(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	var req protocol.SetAuthRequest
	if !decode(w, r, &req) {
		return
	}
	if err := validAuth(req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	err := s.ws.SetAuth(r.Context(), key, req.Kind, req.Token)
	if errors.Is(err, workspace.ErrAuthMismatch) {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	if errors.Is(err, workspace.ErrAuthUnsupported) {
		writeError(w, http.StatusConflict, "UNSUPPORTED", err.Error())
		return
	}
	respond(w, req.Kind, err)
}

func (s *Server) setEnvironment(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	var req protocol.SetEnvironmentRequest
	if !decode(w, r, &req) {
		return
	}
	// Checked first, so a refusal changes nothing: not the variables, files
	// and setup without the instructions.
	err := workspace.ValidInstructions(req.Instructions)
	if err == nil {
		err = workspace.ValidHooks(req.WarmHook, req.StartHook)
	}
	if err == nil {
		err = s.ws.SetEnvironment(r.Context(), r.PathValue("id"), req.Env, req.Files, req.Setup)
	}
	if err == nil {
		err = s.ws.SetInstructions(r.PathValue("id"), req.Instructions)
	}
	if err == nil {
		err = s.ws.SetHooks(r.PathValue("id"), req.WarmHook, req.StartHook)
	}
	if errors.Is(err, workspace.ErrInvalidEnvironment) {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	respond(w, "set", err)
}

// setAgentConfig installs the user's own agent setup on this computer. Any
// session's token may: the computer is that user's, for that project.
func (s *Server) setAgentConfig(w http.ResponseWriter, r *http.Request) {
	var req protocol.SetAgentConfigRequest
	if !decode(w, r, &req) {
		return
	}
	if req.URL != "" && (req.Version == "" || !strings.HasPrefix(req.SHA256, "sha256:")) {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "an archive needs its version and digest")
		return
	}
	err := s.ws.SetAgentConfig(r.Context(), workspace.AgentConfigRequest{
		Version:    req.Version,
		URL:        req.URL,
		SHA256:     req.SHA256,
		MCPServers: req.MCPServers,
		Settings:   req.Settings,
	})
	if errors.Is(err, workspace.ErrInvalidAgentConfig) {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	respond(w, "set", err)
}

// sessionTool passes a session's own command on to the control plane, proven
// to come from this box as git's credential helper is, and answers as it did.
func (s *Server) sessionTool(w http.ResponseWriter, r *http.Request) {
	refuse := func(status int, message string) {
		writeJSON(w, status, sessiontools.Answer{Error: message})
	}
	if !s.ws.SessionToolsEnabled() {
		refuse(http.StatusNotFound, workspace.ErrNoSessionTools.Error())
		return
	}
	if !s.ws.GitCredentialAuthorized(bearer(r)) {
		refuse(http.StatusUnauthorized, "invalid credential token")
		return
	}
	var call sessiontools.Call
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10)).Decode(&call); err != nil || !sessiontools.ValidTool(call.Tool) {
		refuse(http.StatusBadRequest, "malformed request")
		return
	}
	status, answer, err := s.ws.SessionTool(r.Context(), call)
	switch {
	case errors.Is(err, workspace.ErrUnknownWorkspace):
		refuse(http.StatusNotFound, "no such session on this computer")
	case err != nil:
		refuse(http.StatusBadGateway, err.Error())
	default:
		writeJSON(w, status, answer)
	}
}

// setSkills installs a project's skills on this computer. Any session's
// token may, as for the user's own setup: the computer is that session's.
func (s *Server) setSkills(w http.ResponseWriter, r *http.Request) {
	var req protocol.SetSkillsRequest
	if !decode(w, r, &req) {
		return
	}
	sources := make([]workspace.SkillSource, 0, len(req.Sources))
	for _, source := range req.Sources {
		sources = append(sources, workspace.SkillSource{Repo: source.Repo, Ref: source.Ref, Token: source.Token, Skills: source.Skills})
	}
	result, err := s.ws.SetSkills(r.Context(), sources)
	if errors.Is(err, workspace.ErrInvalidSkills) {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	if err != nil {
		respond(w, "set", err)
		return
	}
	failed := make([]protocol.SkillFailure, 0, len(result.Failed))
	for _, f := range result.Failed {
		failed = append(failed, protocol.SkillFailure{Repo: f.Repo, Skill: f.Skill, Error: f.Error})
	}
	writeJSON(w, http.StatusOK, protocol.SetSkillsResponse{Installed: result.Installed, Failed: failed})
}

// setAgentContext puts what every session reads besides its orientation (the
// user's and org's learnings) in Claude's CLAUDE.md and Codex's AGENTS.md,
// in a block of its own.
func (s *Server) setAgentContext(w http.ResponseWriter, r *http.Request) {
	var req protocol.SetAgentContextRequest
	if !decode(w, r, &req) {
		return
	}
	err := s.ws.SetAgentContext(req.Content)
	if errors.Is(err, workspace.ErrInvalidAgentContext) {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	respond(w, "set", err)
}

// validAuth checks a session credential as set or restored: a known kind, and
// a token shaped like a key for any kind but none, which takes none.
func validAuth(req protocol.SetAuthRequest) error {
	if !workspace.ValidAuthKind(req.Kind) {
		return fmt.Errorf("unknown credential kind %q", req.Kind)
	}
	if (req.Kind == workspace.AuthNone) != (req.Token == "") || (req.Token != "" && !claude.ValidGatewayToken(req.Token)) {
		return errors.New("a credential needs a valid token, and none takes one")
	}
	return nil
}

// pty bridges the browser WebSocket to the workspace's tmux PTY. Every attach
// receives PTY output (tmux fans it out), but only the current writer's
// keystrokes reach the PTY — the broker enforces one-writer per workspace.
func (s *Server) pty(w http.ResponseWriter, r *http.Request) {
	claims, err := s.queryClaims(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid Runtime token")
		return
	}
	key, ok := s.chatOf(w, r, claims.WorkspaceID)
	if !ok {
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(maxWSMessageBytes)

	sess, err := ptyx.Attach(s.ws.SessionName(key))
	if err != nil {
		_ = conn.WriteJSON(protocol.PtyServerMessage{T: "exit", Code: intptr(1)})
		return
	}
	defer sess.Close()

	// Serialize all WriteJSON calls on this connection — the coalescer flushes
	// from its own goroutine, role updates from the broker's, and pongs from
	// pumpIn. gorilla/websocket requires exclusive writer access.
	var writeMu sync.Mutex
	writeFrame := func(msg protocol.PtyServerMessage) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteJSON(msg)
	}

	// Broker role: attaches this connection, tells us if we're the writer, and
	// re-notifies us later if a reader is promoted after the writer detaches.
	setRole := func(writer bool) {
		w := writer
		_ = writeFrame(protocol.PtyServerMessage{T: "role", Writer: &w})
	}
	attachment := s.broker.Attach(key, setRole)
	defer attachment.Detach()

	// Output pipeline: PTY → coalescer → WS. Coalescing satisfies the frozen
	// contract ("output is coalesced") and prevents one-keystroke-per-frame
	// flooding. The redactor preserves a suffix between calls so no secret can
	// leak when it crosses a PTY read boundary.
	// Following the live ones: a secret provided while this terminal is open
	// is masked in it from then on.
	redactor := redact.New(append(s.ws.RedactionSecrets(), s.secret)).Follow(s.ws.LiveSecrets())
	coalescer := ptyx.NewCoalescer(coalesceInterval, coalesceThreshold, func(seq int, data []byte) error {
		output := redactor.Redact(data)
		if output == "" {
			return nil
		}
		return writeFrame(protocol.PtyServerMessage{T: "output", Data: output, Seq: intptr(seq)})
	})
	go coalescer.Run()
	defer func() {
		coalescer.Stop()
		if output := redactor.Flush(); output != "" {
			_ = writeFrame(protocol.PtyServerMessage{T: "output", Data: output, Seq: intptr(coalescer.NextSeq())})
		}
	}()

	go pumpOut(sess, coalescer, writeFrame, func() bool {
		return s.ws.SessionAlive(context.Background(), key)
	})
	pumpIn(conn, sess, attachment.IsWriter, writeFrame, s.touch)
}

// pumpOut reads PTY bytes and hands them to the coalescer, which decides when
// to flush an `output` frame. On PTY EOF/error it returns; it only sends `exit`
// if the tmux session is actually gone.
//
// The PTY is a `tmux attach` client, and that client EOFs on *detach* (a
// reconnect, resize race, or a competing attach) just as it does on Claude's
// real *exit*. Reporting exit on every EOF made the UI show "Claude exited"
// while Claude was still sitting at its prompt, and each false exit triggered
// another reconnect. sessionAlive() distinguishes the two: if the session still
// exists it was a detach — close quietly and let the client re-attach.
func pumpOut(sess *ptyx.Session, c *ptyx.Coalescer, send func(protocol.PtyServerMessage) error, sessionAlive func() bool) {
	buf := make([]byte, 8192)
	for {
		n, err := sess.Read(buf)
		if n > 0 {
			_ = c.Write(buf[:n])
		}
		if err != nil {
			if !sessionAlive() {
				_ = send(protocol.PtyServerMessage{T: "exit", Code: intptr(0)})
			}
			return
		}
	}
}

// pumpIn forwards writer input to the PTY; reader input frames are dropped.
// Resize is honored from any client so a late-joining reader can right-size
// its own xterm. Ping/pong keeps the connection alive.
func pumpIn(conn *websocket.Conn, sess *ptyx.Session, isWriter func() bool, send func(protocol.PtyServerMessage) error, touch func()) {
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var m protocol.PtyClientMessage
		if json.Unmarshal(data, &m) != nil || !m.Valid() {
			continue
		}
		switch m.T {
		case "input":
			if isWriter() {
				touch()
				_, _ = sess.Write([]byte(m.Data))
			}
		case "resize":
			_ = sess.Resize(m.Cols, m.Rows)
		case "ping":
			_ = send(protocol.PtyServerMessage{T: "pong"})
		}
	}
}

// events serves the Conversation event stream as SSE.
//
// Frames:
//
//	id: <byte-offset-into-JSONL>
//	data: <AgentEvent JSON>
//
// The `id:` line is the JSONL byte offset AT THE END of the emitted record.
// On reconnect, the browser's EventSource resends it as `Last-Event-ID`; the
// agent starts its watcher at that offset, so no event is duplicated or
// skipped between disconnect and reconnect. This is the entire correctness
// contract of the stream.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	claims, err := s.queryClaims(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid Runtime token")
		return
	}

	key, ok := s.chatOf(w, r, claims.WorkspaceID)
	if !ok {
		return
	}

	fromOffset := int64(0)
	if h := r.Header.Get("Last-Event-ID"); h != "" {
		if v, perr := strconv.ParseInt(h, 10, 64); perr == nil && v > 0 {
			fromOffset = v
		}
	}
	// Programmatic reconnects (browser-initiated close then reopen) can't set
	// the header; allow ?lastEventId= as an escape hatch.
	if q := r.URL.Query().Get("lastEventId"); q != "" && fromOffset == 0 {
		if v, perr := strconv.ParseInt(q, 10, 64); perr == nil && v > 0 {
			fromOffset = v
		}
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx/proxy buffering
	w.WriteHeader(http.StatusOK)
	// Send the headers now: a resume with nothing new writes no frame, and the
	// client would otherwise wait for the first heartbeat to see the stream open.
	flusher.Flush()

	// Serialize every write on this response — the ticker, the watcher goroutine,
	// and the state emitter all write frames concurrently.
	var writeMu sync.Mutex
	writeSSE := func(id int64, payload []byte) bool {
		writeMu.Lock()
		defer writeMu.Unlock()
		if _, err := fmt.Fprintf(w, "id: %d\ndata: %s\n\n", id, payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	writeHeartbeat := func() bool {
		writeMu.Lock()
		defer writeMu.Unlock()
		if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	s.streamEvents(r.Context(), claims.WorkspaceID, key, fromOffset, writeSSE, writeHeartbeat)
}

// streamEvents produces the Conversation event stream for a verified session and
// delivers it through transport-agnostic callbacks, so the SSE (`/events`) and
// WebSocket (`/events-ws`) handlers share one implementation.
//
//   - `writeEvent(id, payload)` emits one AgentEvent; `id` is the JSONL byte
//     offset (0 for the connect-time state event; a later state event carries
//     the current cursor, see below). Return false to stop (the transport is
//     gone).
//   - `heartbeat()` keeps the connection alive on idle. Return false to stop.
//
// key is the chat whose conversation it follows: the workspace's own id for
// its main chat (workspace.ChatKey).
//
// A synthetic `state` event is emitted first on fresh connects (fromOffset == 0)
// so subscribers know whether the workspace is running before any conversation
// event lands; a resume (fromOffset > 0) skips it. A stream that opens
// "starting" then sends "running" once the session log appears, so no client
// is left showing a stale start. That is the only change it reports: a log
// that goes away mid-session is a teardown or a session briefly looking empty,
// not a session starting again, and a late "starting" would sit under the
// whole conversation. The "running" carries the resume cursor (the last
// event's offset, or fromOffset) as its id: state isn't in the JSONL, so
// resuming there skips and repeats nothing, and an SSE client's Last-Event-ID
// never moves backwards.
// Returns when ctx is cancelled (client gone) or a write fails.
func (s *Server) streamEvents(
	ctx context.Context,
	workspaceID, key string,
	fromOffset int64,
	writeEvent func(id int64, payload []byte) bool,
	heartbeat func() bool,
) {
	cursor := fromOffset
	running := s.ws.SessionLog(key) != ""
	writeState := func(state string) bool {
		payload, _ := json.Marshal(protocol.WorkspaceStateChanged{
			T: "state", WorkspaceID: workspaceID, State: state,
		})
		return writeEvent(cursor, payload)
	}
	// reportRunning sends "running" the first time the stream sees the log.
	reportRunning := func() bool {
		if running {
			return true
		}
		running = true
		return writeState("running")
	}
	if fromOffset == 0 {
		state := "starting"
		if running {
			state = "running"
		}
		if !writeState(state) {
			return
		}
	}

	// Watcher tails the JSONL and delivers events on `out`. Its lifetime is tied
	// to ctx — when the client disconnects, ctx cancels and the watcher exits.
	pathFn := func() string { return s.ws.SessionLog(key) }
	watcher := conversation.New(pathFn, fromOffset)
	out := make(chan conversation.Event, 64)
	go watcher.Run(ctx, out)

	ticker := time.NewTicker(sseHeartbeat)
	defer ticker.Stop()
	// Watch for the log only while the stream is still "starting"; a nil
	// channel never fires, so a running stream does no extra lookups.
	var stateCheck <-chan time.Time
	stopStateCheck := func() {}
	if !running {
		stateTicker := time.NewTicker(stateCheckInterval)
		defer stateTicker.Stop()
		stateCheck = stateTicker.C
		stopStateCheck = func() { stateTicker.Stop(); stateCheck = nil }
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-stateCheck:
			if s.ws.SessionLog(key) != "" {
				stopStateCheck()
				if !reportRunning() {
					return
				}
			}
		case ev := <-out:
			// The log just yielded an event, so it exists: the "running" lands
			// before the first message it explains. No SessionLog lookup here,
			// since a fresh connect replays the whole log through this path.
			stopStateCheck()
			if !reportRunning() {
				return
			}
			var payload []byte
			var mErr error
			switch {
			case ev.Message != nil:
				payload, mErr = json.Marshal(ev.Message)
			case ev.Usage != nil:
				payload, mErr = json.Marshal(ev.Usage)
			default:
				continue
			}
			if mErr != nil {
				continue
			}
			if !writeEvent(ev.ID, payload) {
				return
			}
			cursor = ev.ID
		case <-ticker.C:
			if !heartbeat() {
				return
			}
		}
	}
}

// eventsWSFrame is one Conversation event over the WebSocket transport: the
// resumable byte-offset id (as a string, matching the SSE `id:` field) plus the
// AgentEvent payload. WebSockets stream reliably where an embedded WKWebView
// buffers SSE, so the browser Conversation stream rides this in the app.
type eventsWSFrame struct {
	ID   string          `json:"id"`
	Data json.RawMessage `json:"data"`
}

// eventsWS is the WebSocket twin of events: same tokens, same resume protocol
// (`?lastEventId=`), same event sequence — delivered as JSON frames over a WS so
// clients whose SSE is buffered (WKWebView) still get real-time updates. The
// keepalive is a WS ping (browsers pong automatically).
func (s *Server) eventsWS(w http.ResponseWriter, r *http.Request) {
	claims, err := s.queryClaims(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid Runtime token")
		return
	}

	key, ok := s.chatOf(w, r, claims.WorkspaceID)
	if !ok {
		return
	}

	fromOffset := int64(0)
	if q := r.URL.Query().Get("lastEventId"); q != "" {
		if v, perr := strconv.ParseInt(q, 10, 64); perr == nil && v > 0 {
			fromOffset = v
		}
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(maxWSMessageBytes)

	// Detect a silent peer: require a pong (or any frame) within pongWait, and
	// extend the deadline every time one arrives. A vanished client stops
	// ponging, so the reader's ReadMessage below times out and cancels ctx.
	_ = conn.SetReadDeadline(time.Now().Add(eventsWSPongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(eventsWSPongWait))
	})

	// gorilla/websocket requires exclusive writer access; both event frames and
	// ping heartbeats write from the same serialized path, each with a write
	// deadline so a stuck client can't block the stream loop indefinitely.
	var writeMu sync.Mutex
	writeEvent := func(id int64, payload []byte) bool {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(eventsWSWriteWait))
		return conn.WriteJSON(eventsWSFrame{ID: strconv.FormatInt(id, 10), Data: json.RawMessage(payload)}) == nil
	}
	heartbeat := func() bool {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(eventsWSWriteWait)) == nil
	}

	// Cancel the stream as soon as the client closes: a reader goroutine surfaces
	// the close (and drains client control frames) so streamEvents can exit.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		for {
			if _, _, rerr := conn.ReadMessage(); rerr != nil {
				cancel()
				return
			}
		}
	}()

	s.streamEvents(ctx, claims.WorkspaceID, key, fromOffset, writeEvent, heartbeat)
}

// ---------------------------------------------------------------------------

func respond(w http.ResponseWriter, ok string, err error) {
	if errors.Is(err, workspace.ErrUnknownWorkspace) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"result": ok})
}

func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "malformed JSON body")
		return false
	}
	return true
}

func bearer(r *http.Request) string {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if len(h) > len(prefix) && h[:len(prefix)] == prefix {
		return h[len(prefix):]
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("write response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	var body protocol.ErrorResponse
	body.Error.Code = code
	body.Error.Message = message
	writeJSON(w, status, body)
}

func intptr(v int) *int { return &v }

// validImportRestore checks what a restore of an imported session adds: a
// known encoding, a bundle branch that can't be read as a refspec of more
// than one ref, and an absolute folder to move the conversation from.
func validImportRestore(req protocol.RestoreWorkspaceRequest) error {
	for _, d := range req.Downloads {
		if d.Encoding != "" && d.Encoding != "gzip" {
			return fmt.Errorf("unknown encoding %q for %s", d.Encoding, d.Artifact)
		}
	}
	if ref := req.BundleRef; ref != "" &&
		(strings.HasPrefix(ref, "-") || strings.ContainsAny(ref, ": \t\n~^?*[\\") || strings.Contains(ref, "..")) {
		return fmt.Errorf("invalid bundle branch %q", ref)
	}
	if o := req.OriginWorktree; o != "" && (!path.IsAbs(o) || path.Clean(o) != o || o == "/") {
		return fmt.Errorf("invalid origin folder %q", o)
	}
	return nil
}

// checkouts are a request's repositories as the workspace takes them.
func checkouts(repos []protocol.RepoCheckout) []workspace.Checkout {
	if len(repos) == 0 {
		return nil
	}
	out := make([]workspace.Checkout, len(repos))
	for i, r := range repos {
		out[i] = workspace.Checkout{Name: r.Checkout, FullName: r.FullName, BaseBranch: r.BaseBranch}
	}
	return out
}
