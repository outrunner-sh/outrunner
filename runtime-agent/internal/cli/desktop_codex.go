package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"time"
)

type desktopCodexRequest struct {
	Endpoint string `json:"endpoint"`
	Bearer   string `json:"bearer"`
	Binary   string `json:"binary"`
}

// DesktopCodexAuth is the desktop's bundled, noninteractive helper. Its stdin
// stays open for the attempt: closing it cancels provider login and cleans up
// the isolated home. Only allowlisted device URL/code output reaches stdout.
// Credentials and the scoped capability never appear in argv or diagnostics.
func DesktopCodexAuth(ctx context.Context, in io.Reader, out io.Writer) int {
	var input desktopCodexRequest
	decoder := json.NewDecoder(io.LimitReader(in, 16384))
	if decoder.Decode(&input) != nil || !validDesktopCodexEndpoint(input.Endpoint) || input.Bearer == "" || input.Binary == "" {
		return 1
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	go func() { _, _ = io.Copy(io.Discard, in); cancel() }()
	client := &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	call := func(ctx context.Context, method string, body any) error {
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, input.Endpoint, bytes.NewReader(raw))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+input.Bearer)
		req.Header.Set("Content-Type", "application/json")
		res, err := client.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 65536))
		if res.StatusCode != 200 {
			return errors.New("connection refused")
		}
		return nil
	}
	if call(ctx, http.MethodGet, nil) != nil {
		return 1
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				if call(ctx, http.MethodGet, nil) != nil {
					cancel()
					return
				}
			}
		}
	}()
	tokens, err := CodexLogin(ctx, input.Binary, out)
	if err == nil {
		err = call(ctx, http.MethodPut, map[string]any{"tokens": tokens})
	}
	if err != nil {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = call(cleanup, http.MethodPost, nil)
		return 1
	}
	return 0
}

func validDesktopCodexEndpoint(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.User == nil && u.Host != "" && u.Path == "/api/desktop/codex" && u.RawQuery == "" && u.Fragment == "" &&
		(u.Scheme == "https" || u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))
}
