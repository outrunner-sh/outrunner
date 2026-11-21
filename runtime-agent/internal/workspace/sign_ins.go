package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"runtime-agent/internal/desktop"
)

// A person's sign-ins in the desktop browser carry over from one of their
// sessions to their next in the same project (package desktop's sign_ins.go
// has the browser's side). The agent is the go-between, as it is for GitHub
// tokens: it sends the browser's sign-ins to the control plane as they
// change, signing each request with its secret, and a new session's box asks
// for them back before its browser first starts. The control plane keeps
// them sealed for the owner and project of the session the box was made for
// (app/api/runtime/browser-sign-ins): whose they are is the box's to it,
// never something a request says.

const (
	signInsRoute   = "/api/runtime/browser-sign-ins"
	signInsPurpose = "browser-sign-ins"
	// maxSignInsBytes bounds the sign-ins sent, as JSON: no more than the
	// control plane takes (lib/browser-sign-ins/sign-ins.ts MAX_STATE_BYTES).
	maxSignInsBytes = 512 << 10
	// signInsEvery is how often the browser is looked at, and signInsGap
	// the least time between two saves.
	signInsEvery = 10 * time.Second
	signInsGap   = 30 * time.Second
	// signInsTimeout bounds asking for the last session's.
	signInsTimeout = 30 * time.Second
)

// signInKeeper is the box's one keeper of the browser's sign-ins.
func (s *Service) signInKeeper() *desktop.SignInKeeper {
	s.signInsOnce.Do(func() {
		s.signIns = &desktop.SignInKeeper{Browser: s.Browser, Save: s.saveSignIns, MinGap: signInsGap, MaxBytes: maxSignInsBytes}
	})
	return s.signIns
}

// KeepSignIns sends the browser's sign-ins on as they change, until ctx is
// done or the control plane says this box's aren't kept: on a box with the
// desktop browser and the control plane to keep them. It blocks.
func (s *Service) KeepSignIns(ctx context.Context) {
	if s.Browser == nil || s.controlPlane == nil {
		return
	}
	s.signInKeeper().Run(ctx, signInsEvery, s.hasDesktop)
}

// prepareSignIns asks for the person's sign-ins from their last session in
// the project, for the browser to start with: only on a box whose browser
// has never run, which has none of its own to keep. Once per agent, and in
// the background, so a session's setup never waits on it.
func (s *Service) prepareSignIns() {
	if s.Browser == nil || s.controlPlane == nil || !s.signInsAsked.CompareAndSwap(false, true) {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), signInsTimeout)
		defer cancel()
		if err := s.restoreSignIns(ctx); err != nil {
			log.Printf("browser sign-ins: none carried over from the last session: %v", err)
		}
	}()
}

func (s *Service) restoreSignIns(ctx context.Context) error {
	if !s.hasDesktop() || !s.Browser.FreshProfile() {
		return nil
	}
	state, err := s.loadSignIns(ctx)
	if err != nil || state == nil {
		return err
	}
	if err := s.Browser.QueueRestore(*state); err != nil {
		return err
	}
	s.signInKeeper().Seed(*state)
	log.Printf("browser sign-ins: %d cookies, and localStorage for %d origins, carried over for the browser's first start", len(state.Cookies), len(state.Origins))
	return nil
}

// signInsRequest is the agent's call: "load" the sign-ins kept, or "save"
// State as them.
type signInsRequest struct {
	Op    string                `json:"op"`
	State *desktop.StorageState `json:"state,omitempty"`
}

// signInsAnswer is the control plane's: the sign-ins kept, null for none.
type signInsAnswer struct {
	State *desktop.StorageState `json:"state"`
	Error string                `json:"error"`
}

// loadSignIns are the sign-ins kept for this box's session, or nil.
func (s *Service) loadSignIns(ctx context.Context) (*desktop.StorageState, error) {
	status, answer, err := s.postSignIns(ctx, signInsRequest{Op: "load"})
	switch {
	case err != nil:
		return nil, err
	case status == http.StatusConflict:
		// Not a box whose sign-ins are kept: a project's shared one.
		return nil, nil
	case status != http.StatusOK:
		return nil, fmt.Errorf("the control plane answered %d: %s", status, answer.Error)
	}
	return answer.State, nil
}

// saveSignIns sends state on to be kept: desktop.ErrNotKept when this box's
// never are.
func (s *Service) saveSignIns(ctx context.Context, state desktop.StorageState) error {
	status, answer, err := s.postSignIns(ctx, signInsRequest{Op: "save", State: &state})
	switch {
	case err != nil:
		return err
	case status == http.StatusConflict:
		return desktop.ErrNotKept
	case status != http.StatusOK:
		return fmt.Errorf("the control plane answered %d: %s", status, answer.Error)
	}
	return nil
}

func (s *Service) postSignIns(ctx context.Context, call signInsRequest) (int, signInsAnswer, error) {
	body, err := json.Marshal(call)
	if err != nil {
		return 0, signInsAnswer{}, err
	}
	status, data, err := s.controlPlane.Post(ctx, signInsRoute, signInsPurpose, body)
	if err != nil {
		return 0, signInsAnswer{}, fmt.Errorf("couldn't reach Outrunner: %w", err)
	}
	var answer signInsAnswer
	if err := json.Unmarshal(data, &answer); err != nil && status == http.StatusOK {
		return 0, signInsAnswer{}, fmt.Errorf("Outrunner's answer doesn't read: %w", err)
	}
	return status, answer, nil
}
