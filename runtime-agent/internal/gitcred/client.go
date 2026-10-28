// Package gitcred gets a Runtime Computer's sessions GitHub credentials for
// as long as they run. A GitHub App's installation token lasts an hour, so a
// token handed to the box at launch would go stale under a long session:
// instead git's credential helper and the gh wrapper (both this binary, see
// Helper and GitHubToken) ask the agent on the loopback, and the agent asks
// the control plane for a fresh token, signing the request with its secret,
// and keeps it until shortly before it expires (Cache).
//
// The feature is on only when the control plane launches the agent with
// everything it needs (ConfigFromEnv); the desktop app never does, and a box
// without it keeps using the token it was launched with ($GH_TOKEN).
package gitcred

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
	"strings"
	"time"
)

// route is the control plane's credential endpoint, under its app URL.
const route = "/api/runtime/git-credential"

// fetchTimeout bounds one request to the control plane: git waits on it.
const fetchTimeout = 15 * time.Second

// Config is how the agent reaches the control plane for credentials.
type Config struct {
	// AppURL is the control plane's origin, e.g. https://app.outrunner.sh.
	AppURL string
	// SandboxID names this box to the control plane.
	SandboxID string
	// Secret is the agent's RUNTIME_AGENT_SECRET, which signs each request.
	Secret string
}

// ConfigFromEnv reads the Config the control plane launched the agent with;
// ok is false when any of it is missing, and the feature is then off.
func ConfigFromEnv(getenv func(string) string) (cfg Config, ok bool) {
	cfg = Config{
		AppURL:    strings.TrimRight(strings.TrimSpace(getenv("OUTRUNNER_APP_URL")), "/"),
		SandboxID: strings.TrimSpace(getenv("RUNTIME_SANDBOX_ID")),
		Secret:    getenv("RUNTIME_AGENT_SECRET"),
	}
	return cfg, cfg.AppURL != "" && cfg.SandboxID != "" && cfg.Secret != ""
}

// Credential is a token for a repository.
type Credential struct {
	Token string
	// ExpiresAt is when the token stops working; zero when the control plane
	// gave none (the user's own token, which lasts until they revoke it).
	ExpiresAt time.Time
	// Identity is whose token it is: "app" (the GitHub App's installation)
	// or "personal" (the user's own).
	Identity string
}

// Error is the control plane's refusal, its message meant for the user.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }

// Refused reports whether the control plane said no on purpose: no way to
// the GitHub identity the user chose (409), or no access to the repository
// (403). Anything else (it didn't know the box, or failed) may be answered
// with the token the box was launched with.
func (e *Error) Refused() bool {
	return e.Status == http.StatusConflict || e.Status == http.StatusForbidden
}

// Client asks the control plane for credentials.
type Client struct {
	Config
	// HTTP sends the requests; nil is a client with fetchTimeout.
	HTTP *http.Client
	// Now is the clock the requests are timestamped with; nil is time.Now.
	Now func() time.Time
}

// Fetch asks the control plane for a token for repo ("owner/name"), or for
// the box's own project when repo is empty.
func (c *Client) Fetch(ctx context.Context, repo string) (Credential, error) {
	body, err := json.Marshal(struct {
		Repo string `json:"repo,omitempty"`
	}{repo})
	if err != nil {
		return Credential{}, err
	}
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	timestamp := strconv.FormatInt(now().Unix(), 10)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.AppURL+route, bytes.NewReader(body))
	if err != nil {
		return Credential{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Outrunner-Sandbox", c.SandboxID)
	req.Header.Set("X-Outrunner-Timestamp", timestamp)
	req.Header.Set("X-Outrunner-Signature", Sign(c.Secret, c.SandboxID, timestamp, body))
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: fetchTimeout}
	}
	resp, err := client.Do(req)
	if err != nil {
		return Credential{}, fmt.Errorf("couldn't reach Outrunner for a GitHub token: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Credential{}, fmt.Errorf("couldn't read Outrunner's GitHub token: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		var refusal struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &refusal) == nil && refusal.Error != "" {
			return Credential{}, &Error{Status: resp.StatusCode, Message: refusal.Error}
		}
		return Credential{}, &Error{Status: resp.StatusCode, Message: "Outrunner refused a GitHub token: " + resp.Status}
	}
	var answer struct {
		Token     string  `json:"token"`
		ExpiresAt *string `json:"expiresAt"`
		Identity  string  `json:"identity"`
	}
	if err := json.Unmarshal(data, &answer); err != nil || answer.Token == "" {
		return Credential{}, fmt.Errorf("Outrunner sent a malformed GitHub token")
	}
	cred := Credential{Token: answer.Token, Identity: answer.Identity}
	// An expiry that doesn't parse is kept for no longer than a token
	// without one (Cache), well inside an installation token's hour.
	if answer.ExpiresAt != nil {
		if at, err := time.Parse(time.RFC3339, *answer.ExpiresAt); err == nil {
			cred.ExpiresAt = at
		}
	}
	return cred, nil
}

// Sign is the X-Outrunner-Signature of a request: an HMAC-SHA256, keyed by
// the agent's secret, over its purpose, the box, the time and the body, so
// a signature can't be replayed for another box, purpose or request.
func Sign(secret, sandboxID, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("git-credential\n" + sandboxID + "\n" + timestamp + "\n"))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}
