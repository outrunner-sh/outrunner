// Package cli is the `outrunner` command a user pastes into their terminal.
// It signs the terminal in to Outrunner through the browser, then hands the
// rest of onboarding to the web app.
//
// Signing in (the server's half is lib/auth/cli-login.ts): listen on
// 127.0.0.1, open /cli-login in the browser with the port, a state and a PKCE
// challenge; the user approves there, and the browser comes back to
// /callback with a one-time code; trade that code and the verifier for a
// token at /api/cli/token. The verifier never leaves this process until that
// trade, so a code seen anywhere else is no use.
package cli

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// loginTimeout is how long to wait for the user to approve in the browser.
const loginTimeout = 5 * time.Minute

// User is who a token signs in, as the server says.
type User struct {
	Login string  `json:"login"`
	Name  string  `json:"name"`
	Email *string `json:"email"`
}

// LoginOptions are what a sign-in needs from the command.
type LoginOptions struct {
	// BaseURL is the app's origin, e.g. https://app.outrunner.sh.
	BaseURL string
	// DeviceName is how /cli-login names this computer to the user.
	DeviceName string
	// After is the app path the browser goes to once signed in.
	After string
	// OpenBrowser opens a URL; an error only means the user opens it.
	OpenBrowser func(string) error
	// Out is where progress is printed.
	Out io.Writer
	// HTTP is the client for the token trade; nil is http.DefaultClient.
	HTTP *http.Client
}

// Login signs this terminal in and returns the token and who it is.
func Login(ctx context.Context, opts LoginOptions) (string, User, error) {
	state, err := randomString(24)
	if err != nil {
		return "", User{}, err
	}
	verifier, err := randomString(32)
	if err != nil {
		return "", User{}, err
	}
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", User{}, fmt.Errorf("listen for the browser: %w", err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port

	type result struct {
		token string
		user  User
		err   error
	}
	done := make(chan result, 1)
	finish := func(r result) {
		select {
		case done <- r:
		default:
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if query.Get("state") != state {
			// Not the browser this sign-in sent: ignore it, keep waiting.
			http.Error(w, "This sign-in link is for another terminal.", http.StatusBadRequest)
			return
		}
		token, user, err := exchange(r.Context(), opts, query.Get("code"), verifier)
		if err != nil {
			http.Error(w, err.Error()+"\n\nGo back to your terminal and try again.", http.StatusBadRequest)
			finish(result{err: err})
			return
		}
		http.Redirect(w, r, appURL(opts.BaseURL, opts.After), http.StatusFound)
		finish(result{token: token, user: user})
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = server.Serve(listener) }()
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()

	loginURL := loginPageURL(opts.BaseURL, port, state, challenge, opts.DeviceName)
	fmt.Fprintln(opts.Out, "Opening browser to sign in...")
	fmt.Fprintln(opts.Out, "If the browser doesn't open, visit:")
	fmt.Fprintf(opts.Out, "%s\n\n", loginURL)
	if opts.OpenBrowser != nil {
		_ = opts.OpenBrowser(loginURL)
	}

	ctx, cancel := context.WithTimeout(ctx, loginTimeout)
	defer cancel()
	select {
	case r := <-done:
		return r.token, r.user, r.err
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", User{}, errors.New("sign-in timed out waiting for the browser")
		}
		return "", User{}, ctx.Err()
	}
}

func loginPageURL(base string, port int, state, challenge, deviceName string) string {
	query := url.Values{}
	query.Set("port", fmt.Sprint(port))
	query.Set("state", state)
	query.Set("challenge", challenge)
	query.Set("name", deviceName)
	return appURL(base, "/cli-login") + "?" + query.Encode()
}

func appURL(base, path string) string {
	return strings.TrimRight(base, "/") + path
}

// exchange trades the browser's code and the verifier for a token.
func exchange(ctx context.Context, opts LoginOptions, code, verifier string) (string, User, error) {
	body, _ := json.Marshal(map[string]string{"code": code, "verifier": verifier})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, appURL(opts.BaseURL, "/api/cli/token"), bytes.NewReader(body))
	if err != nil {
		return "", User{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	var answer struct {
		Token string `json:"token"`
		User  User   `json:"user"`
	}
	if err := do(httpClient(opts.HTTP), req, &answer); err != nil {
		return "", User{}, err
	}
	if answer.Token == "" {
		return "", User{}, errors.New("Outrunner answered without a token")
	}
	return answer.Token, answer.User, nil
}

// WhoAmI asks who a token signs in; ErrSignedOut when it no longer does.
func WhoAmI(ctx context.Context, client *http.Client, base, token string) (User, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, appURL(base, "/api/cli/whoami"), nil)
	if err != nil {
		return User{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	var user User
	return user, do(httpClient(client), req, &user)
}

// Logout stops a token working on the server.
func Logout(ctx context.Context, client *http.Client, base, token string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, appURL(base, "/api/cli/token"), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	return do(httpClient(client), req, nil)
}

// ErrSignedOut is a token the server no longer takes.
var ErrSignedOut = errors.New("not signed in")

// do sends a request and reads its JSON answer into out (when not nil). An
// error answer becomes its `error` message.
func do(client *http.Client, req *http.Request, out any) error {
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("reach Outrunner at %s: %w", req.URL.Host, err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode == http.StatusUnauthorized {
		return ErrSignedOut
	}
	if res.StatusCode >= 300 {
		var failure struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &failure) == nil && failure.Error != "" {
			return errors.New(failure.Error)
		}
		return fmt.Errorf("Outrunner answered %s", res.Status)
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

func httpClient(client *http.Client) *http.Client {
	if client != nil {
		return client
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func randomString(bytes int) (string, error) {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// DeviceName is this computer's name for /cli-login.
func DeviceName() string {
	name, err := os.Hostname()
	if err != nil || name == "" {
		return "Terminal"
	}
	return strings.TrimSuffix(name, ".local")
}
