package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Only the native device URL and human approval code are printed. Native CLI
// diagnostics may contain credentials; never echo them on success or failure.
var codexDeviceURL = regexp.MustCompile(`^https://auth\.openai\.com/(?:codex/)?device(?:auth)?(?:/[A-Za-z0-9/_-]*)?$`)
var codexDeviceCode = regexp.MustCompile(`^[A-Z0-9]{4}-[A-Z0-9]{4,5}$`)

type codexPrompt struct {
	mu      sync.Mutex
	pending string
	out     io.Writer
	seen    map[string]bool
}

func (p *codexPrompt) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pending += string(b)
	// Retain only a bounded tail while scanning chunked stdout and stderr.
	if len(p.pending) > 65536 {
		p.pending = p.pending[len(p.pending)-32768:]
	}

	for {
		line, rest, ok := strings.Cut(p.pending, "\n")
		if !ok {
			break
		}
		p.pending = rest
		clean := strings.TrimSpace(stripANSI(line))
		for _, pattern := range []*regexp.Regexp{codexDeviceURL, codexDeviceCode} {
			for _, value := range pattern.FindAllString(clean, -1) {
				if !p.seen[value] {
					fmt.Fprintln(p.out, "  "+value)
					p.seen[value] = true
				}
			}
		}
	}

	return len(b), nil
}

// CodexLogin runs the official device login in a new, file-only CODEX_HOME.
// It never reads/replaces an existing provider login or copies a keychain.
func CodexLogin(ctx context.Context, binary string, out io.Writer) (json.RawMessage, error) {
	home, err := os.MkdirTemp("", "outrunner-codex-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(home)
	if err = os.WriteFile(filepath.Join(home, "config.toml"), []byte("cli_auth_credentials_store = \"file\"\n"), 0600); err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, binary, "login", "--device-auth")
	configureCodexLoginProcess(cmd)
	cmd.WaitDelay = time.Second
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(name, "CODEX_") && !strings.HasPrefix(name, "OPENAI_") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, "CODEX_HOME="+home)
	prompt := &codexPrompt{out: out, seen: map[string]bool{}}
	cmd.Stdout = prompt
	cmd.Stderr = prompt
	if err = cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, errors.New("Codex sign-in canceled or timed out; run the command again")
		}
		return nil, errors.New("Codex sign-in did not finish. Enable device-code login in ChatGPT security settings and try again with an up-to-date official Codex CLI")
	}
	f, err := os.Open(filepath.Join(home, "auth.json"))
	if err != nil {
		return nil, errors.New("Codex did not save a login")
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil || len(raw) > 65536 {
		return nil, errors.New("invalid Codex login file")
	}
	var login struct {
		Tokens json.RawMessage `json:"tokens"`
	}
	if json.Unmarshal(raw, &login) != nil || len(login.Tokens) == 0 {
		return nil, errors.New("Codex did not return account credentials")
	}
	return login.Tokens, nil
}

func codexCall(ctx context.Context, base, token, org, method string, body any, out any) error {
	endpoint := appURL(base, "/api/cli/codex")
	if org != "" {
		endpoint += "?org=" + url.QueryEscape(org)
	}
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	return do(httpClient(nil), req, out)
}
func connectCodex(ctx context.Context, base string, config Config, args []string, out, errout io.Writer) int {
	parsed, err := url.Parse(base)
	if err != nil || (parsed.Scheme != "https" && !(parsed.Scheme == "http" && (parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1"))) {
		fmt.Fprintln(errout, "Codex connections require an HTTPS Outrunner address.")
		return 1
	}
	flags := flag.NewFlagSet("codex-auth", flag.ContinueOnError)
	flags.SetOutput(errout)
	org := flags.String("org", "", "organization UUID (requires admin; default is personal)")
	attempt := flags.String("attempt", "", "sign-in attempt from Settings")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return 1
	}
	binary, err := exec.LookPath("codex")
	if err != nil {
		fmt.Fprintln(errout, "Install the official Codex CLI with `npm install -g @openai/codex`, then run this command again.")
		return 1
	}
	var started struct {
		Attempt string `json:"attempt"`
	}
	if err = codexCall(ctx, base, config.Token, *org, "POST", map[string]string{"action": "begin", "attempt": *attempt}, &started); err != nil {
		fmt.Fprintln(errout, "outrunner:", err)
		return 1
	}
	scope := "your personal Outrunner account"
	if *org != "" {
		scope = "Outrunner organization " + *org + " (shared with its current members)"
	}
	fmt.Fprintln(out, "Connect Codex to "+scope+".\nApprove the official device login in your browser:")
	loginCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	// Once a browser cancels the attempt, stop the native login as well.
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-loginCtx.Done():
				return
			case <-ticker.C:
				var status struct {
					Pending *struct {
						ID string `json:"id"`
					} `json:"pending"`
				}
				if codexCall(loginCtx, base, config.Token, *org, "GET", nil, &status) == nil && (status.Pending == nil || status.Pending.ID != started.Attempt) {
					cancel()
					return
				}
			}
		}
	}()
	tokens, err := CodexLogin(loginCtx, binary, out)
	if err == nil {
		err = codexCall(ctx, base, config.Token, *org, "PUT", map[string]any{"attempt": started.Attempt, "tokens": tokens}, nil)
	}
	if err != nil {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = codexCall(cleanup, base, config.Token, *org, "POST", map[string]string{"action": "cancel", "attempt": started.Attempt}, nil)
		fmt.Fprintln(errout, "outrunner:", err)
		return 1
	}
	fmt.Fprintln(out, "Codex connected. Return to Settings → Providers → Codex. Your existing authentication choice is unchanged.")
	return 0
}
