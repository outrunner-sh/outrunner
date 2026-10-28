package gitcred

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// localTimeout bounds a call to the agent: longer than the agent's own call
// to the control plane, so its refusal arrives rather than a timeout.
const localTimeout = fetchTimeout + 5*time.Second

// Local is how the helpers reach the agent on the box: found afresh at every
// call, from the address it announces and the token it writes when it starts,
// since a session's git outlives an agent restart.
type Local struct {
	// AddrFile holds the agent's host:port.
	AddrFile string
	// TokenFile holds the agent's credential token, its proof that a call
	// comes from this box.
	TokenFile string
	// Client sends the calls; nil is a client with localTimeout.
	Client *http.Client
}

// LocalRequest is POST /git-credential's body.
type LocalRequest struct {
	// Repo is "owner/name", or "" for the box's own project.
	Repo string `json:"repo"`
	// Erase forgets the agent's token for Repo instead: git was refused it.
	Erase bool `json:"erase,omitempty"`
}

// LocalResponse is POST /git-credential's answer.
type LocalResponse struct {
	Token string `json:"token"`
	// ExpiresAt is RFC 3339, or null for a token with no expiry.
	ExpiresAt *string `json:"expiresAt"`
}

// LocalError is POST /git-credential's refusal.
type LocalError struct {
	Error string `json:"error"`
}

// RefusedError is the control plane saying no on purpose (Error.Refused),
// passed on by the agent: the helpers don't fall back to the box's own
// token for it.
type RefusedError struct{ Message string }

func (e *RefusedError) Error() string { return e.Message }

// Token asks the agent for a token for repo.
func (l Local) Token(ctx context.Context, repo string) (string, error) {
	data, err := l.post(ctx, LocalRequest{Repo: repo})
	if err != nil {
		return "", err
	}
	var answer LocalResponse
	if err := json.Unmarshal(data, &answer); err != nil || answer.Token == "" {
		return "", fmt.Errorf("the runtime agent sent a malformed token")
	}
	return answer.Token, nil
}

// Erase tells the agent to forget its token for repo.
func (l Local) Erase(ctx context.Context, repo string) error {
	_, err := l.post(ctx, LocalRequest{Repo: repo, Erase: true})
	return err
}

func (l Local) post(ctx context.Context, body LocalRequest) ([]byte, error) {
	addr, err := readTrimmed(l.AddrFile)
	if err != nil {
		return nil, fmt.Errorf("the runtime agent isn't running: %w", err)
	}
	token, err := readTrimmed(l.TokenFile)
	if err != nil {
		return nil, fmt.Errorf("the runtime agent gives no GitHub tokens: %w", err)
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+addr+"/git-credential", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	client := l.Client
	if client == nil {
		client = &http.Client{Timeout: localTimeout}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("couldn't reach the runtime agent: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("couldn't read the runtime agent's answer: %w", err)
	}
	if resp.StatusCode/100 != 2 {
		var refusal LocalError
		if json.Unmarshal(data, &refusal) == nil && refusal.Error != "" {
			if resp.StatusCode == http.StatusConflict {
				return nil, &RefusedError{Message: refusal.Error}
			}
			return nil, errors.New(refusal.Error)
		}
		return nil, fmt.Errorf("the runtime agent refused: %s", resp.Status)
	}
	return data, nil
}

func readTrimmed(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(data))
	if value == "" {
		return "", fmt.Errorf("%s is empty", path)
	}
	return value, nil
}
