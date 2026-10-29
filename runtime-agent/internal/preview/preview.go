// Package preview lets a session's agent make a preview of a server it
// runs: a stable link on Outrunner's preview domain, behind sign-in, that
// the user can open and share (docs/previews.md in the web app). The agent
// runs `runtime-agent preview <port>` (Main), which asks this box's
// runtime-agent on the loopback with the session's ask token, and the
// runtime-agent asks the control plane (Client), signing the request with
// its secret as it does for GitHub tokens (package gitcred), for this
// purpose alone.
//
// The control plane makes sign-in previews only from here: making one
// public is the session owner's, in Outrunner.
package preview

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// route is the control plane's preview endpoint, under its app URL.
const route = "/api/runtime/previews"

// requestTimeout bounds one request to the control plane.
const requestTimeout = 20 * time.Second

// Preview is a preview as the control plane answers with it.
type Preview struct {
	ID    string  `json:"id"`
	Port  int     `json:"port"`
	Label *string `json:"label"`
	// Mode is "login" (signed-in members of the org who can see the
	// repository) or "public" (anyone with the link).
	Mode string `json:"mode"`
	URL  string `json:"url"`
}

// Error is the control plane's refusal, its message meant for the agent
// to pass on.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }

// Client asks the control plane for previews: the same config as GitHub
// tokens' (gitcred.ConfigFromEnv).
type Client struct {
	AppURL    string
	SandboxID string
	Secret    string
	// HTTP sends the requests; nil is a client with requestTimeout.
	HTTP *http.Client
	// Now is the clock the requests are timestamped with; nil is time.Now.
	Now func() time.Time
}

// Create asks for a preview of port for the session workspaceID, or the
// one the port has.
func (c *Client) Create(ctx context.Context, workspaceID string, port int, label string) (Preview, error) {
	body, err := json.Marshal(struct {
		WorkspaceID string `json:"workspaceId"`
		Port        int    `json:"port"`
		Label       string `json:"label,omitempty"`
	}{workspaceID, port, label})
	if err != nil {
		return Preview{}, err
	}
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	timestamp := strconv.FormatInt(now().Unix(), 10)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.AppURL+route, bytes.NewReader(body))
	if err != nil {
		return Preview{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Outrunner-Sandbox", c.SandboxID)
	req.Header.Set("X-Outrunner-Timestamp", timestamp)
	req.Header.Set("X-Outrunner-Signature", Sign(c.Secret, c.SandboxID, timestamp, body))
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: requestTimeout}
	}
	resp, err := client.Do(req)
	if err != nil {
		return Preview{}, fmt.Errorf("couldn't reach Outrunner for a preview: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Preview{}, fmt.Errorf("couldn't read Outrunner's preview: %w", err)
	}
	if resp.StatusCode/100 != 2 {
		var refusal struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &refusal) == nil && refusal.Error != "" {
			return Preview{}, &Error{Status: resp.StatusCode, Message: refusal.Error}
		}
		if resp.StatusCode == http.StatusNotFound {
			return Preview{}, &Error{Status: resp.StatusCode, Message: "This Outrunner doesn't make previews yet."}
		}
		return Preview{}, &Error{Status: resp.StatusCode, Message: "Outrunner refused the preview: " + resp.Status}
	}
	var answer struct {
		Preview Preview `json:"preview"`
	}
	if err := json.Unmarshal(data, &answer); err != nil || answer.Preview.URL == "" {
		return Preview{}, fmt.Errorf("Outrunner sent a malformed preview")
	}
	return answer.Preview, nil
}

// Sign is the X-Outrunner-Signature of a preview request: an HMAC-SHA256,
// keyed by the agent's secret, over its purpose, the box, the time and the
// body, so it is never good for a GitHub token (gitcred.Sign), another box
// or another request.
func Sign(secret, sandboxID, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("preview\n" + sandboxID + "\n" + timestamp + "\n"))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}
