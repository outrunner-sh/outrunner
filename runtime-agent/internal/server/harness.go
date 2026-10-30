package server

import (
	"encoding/json"
	"net/http"

	"runtime-agent/internal/protocol"
	"runtime-agent/internal/workspace"
)

const featureHarnessSwitch = "harness-switch-v1"

func (s *Server) harnessSelection(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	key, ok := s.chatOf(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	state, err := s.ws.HarnessSelection(r.Context(), key)
	if err != nil {
		respond(w, "", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"harness": state})
}

func (s *Server) switchHarness(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	key, ok := s.chatOf(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	var req struct {
		ID            string                   `json:"id"`
		Agent         string                   `json:"agent"`
		ExpectedAgent string                   `json:"expectedAgent"`
		Selection     json.RawMessage          `json:"selection"`
		Model         protocol.SetModelRequest `json:"model"`
		Auth          protocol.SetAuthRequest  `json:"auth"`
		Content       string                   `json:"content"`
		Resume        bool                     `json:"resume"`
		Retry         bool                     `json:"retry"`
		Ack           bool                     `json:"ack"`
		Mode          string                   `json:"mode"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Ack {
		state, err := s.ws.AcknowledgeHarness(r.Context(), key, req.ID)
		if err != nil {
			writeError(w, http.StatusConflict, "CONFLICT", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"harness": state})
		return
	}
	if req.Retry && workspace.ValidChatID(req.ID) && (req.Agent == "claude" || req.Agent == "codex") {
		state, err := s.ws.HarnessSelection(r.Context(), key)
		if err != nil || state == nil || state.ID != req.ID || state.Agent != req.Agent {
			writeError(w, http.StatusConflict, "CONFLICT", "the chat has moved on from that switch")
			return
		}
		state, err = s.ws.SwitchHarness(r.Context(), key, workspace.HarnessInput{ID: req.ID, Agent: req.Agent})
		if err != nil {
			writeError(w, http.StatusConflict, "CONFLICT", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"harness": state})
		return
	}
	if !workspace.ValidChatID(req.ID) || !workspace.ValidAgent(req.Agent) || req.Agent == "" || !workspace.ValidAgent(req.ExpectedAgent) || req.ExpectedAgent == "" || len(req.Selection) == 0 {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid harness selection")
		return
	}
	if err := validAuth(req.Auth); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	choice, err := modelChoice(req.Model)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	if req.Mode != "" && req.Mode != workspace.ModePlan && req.Mode != workspace.ModeBuild {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid session mode")
		return
	}
	state, err := s.ws.SwitchHarness(r.Context(), key, workspace.HarnessInput{ID: req.ID, Agent: req.Agent, ExpectedAgent: req.ExpectedAgent, Selection: req.Selection, Model: choice, Auth: req.Auth, Prompt: req.Content, Resume: req.Resume, Mode: req.Mode})
	if err != nil {
		writeError(w, http.StatusConflict, "CONFLICT", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"harness": state})
}
