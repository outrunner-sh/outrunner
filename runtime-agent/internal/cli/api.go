package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// API is the app's public API (/api/v1, docs/api.md) as the CLI calls it:
// with OUTRUNNER_API_KEY when it's set (a script, CI), else the token
// `outrunner login` keeps, which the API takes as a personal key.
type API struct {
	Client *http.Client
	Base   string
	Token  string
	// The org to act in (its name or id); empty is the key's own, or the
	// user's personal org.
	Org string
}

// APIError is the API's refusal: its stable code and its sentence.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string { return e.Message }

// apiToken is the credential the API commands send.
func apiToken(config Config) string {
	return firstNonEmpty(strings.TrimSpace(os.Getenv("OUTRUNNER_API_KEY")), config.Token)
}

// Call makes one API call: query and body (when not nil) as JSON, and the
// answer decoded into out, also returned raw for --json.
func (a API) Call(ctx context.Context, method, path string, query url.Values, body, out any) (json.RawMessage, error) {
	if query == nil {
		query = url.Values{}
	}
	if a.Org != "" {
		query.Set("org", a.Org)
	}
	target := appURL(a.Base, "/api/v1"+path)
	if encoded := query.Encode(); encoded != "" {
		target += "?" + encoded
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+a.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := a.Client
	if client == nil {
		// No overall cap: `wait` holds a call up to ten minutes, and ctx
		// is what ends one.
		client = &http.Client{}
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("reach Outrunner at %s: %w", req.URL.Host, err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if res.StatusCode >= 300 {
		var failure struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &failure) == nil && failure.Error.Message != "" {
			return nil, &APIError{Status: res.StatusCode, Code: failure.Error.Code, Message: failure.Error.Message}
		}
		return nil, &APIError{Status: res.StatusCode, Message: fmt.Sprintf("Outrunner answered %s", res.Status)}
	}
	if len(data) == 0 {
		return nil, nil
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return nil, err
		}
	}
	return data, nil
}

// printJSON writes an answer as the API gave it, indented.
func printJSON(out io.Writer, raw json.RawMessage) {
	if len(raw) == 0 {
		raw = json.RawMessage("{}")
	}
	var pretty bytes.Buffer
	if json.Indent(&pretty, raw, "", "  ") != nil {
		pretty.Write(raw)
	}
	fmt.Fprintln(out, pretty.String())
}

// ago is a time as the lists show it: how long ago, roughly.
func ago(iso string, now time.Time) string {
	at, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return ""
	}
	d := now.Sub(at)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}
