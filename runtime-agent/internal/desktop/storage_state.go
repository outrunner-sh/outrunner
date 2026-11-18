package desktop

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// A project's own browser tests (Playwright's) sign in to the app they test
// again and again, in every session. The box's browser is already signed in
// wherever the user or the agent signed in on the desktop: StorageState is
// those sign-ins as Playwright's storageState, which a test's browser context
// starts from (`browser.newContext({ storageState })`), each test isolated in
// a context of its own, all signed in. `outrunner browser state` writes it.
//
// Cookies are the browser's, every one. localStorage, where many single-page
// apps keep their sign-in, the browser gives only for a page open on its
// origin: each origin's is read in a background tab of its own whose page is
// served blank by DevTools, so the app's code never runs there (it could
// redirect, or rotate a token mid-read), and nothing is fetched from the app.
// The origins read are the ones asked for and those of the tabs open.

// StorageState is Playwright's storageState: a browser context's cookies, and
// localStorage by origin.
type StorageState struct {
	Cookies []Cookie      `json:"cookies"`
	Origins []OriginState `json:"origins"`
}

// Cookie is a cookie as Playwright reads and adds them.
type Cookie struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Domain string `json:"domain"`
	Path   string `json:"path"`
	// Expires is Unix seconds, -1 for a session cookie.
	Expires  float64 `json:"expires"`
	HTTPOnly bool    `json:"httpOnly"`
	Secure   bool    `json:"secure"`
	// SameSite is "Strict", "Lax" or "None", which Playwright requires.
	SameSite string `json:"sameSite"`
}

// OriginState is one origin's localStorage.
type OriginState struct {
	Origin       string      `json:"origin"`
	LocalStorage []NameValue `json:"localStorage"`
}

// NameValue is one localStorage item.
type NameValue struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// InvalidOriginError is an origin asked for that isn't one.
type InvalidOriginError struct {
	Origin, Reason string
}

func (e *InvalidOriginError) Error() string {
	return fmt.Sprintf("%q isn't an origin to read sign-ins for: %s (give one like http://localhost:3000)", e.Origin, e.Reason)
}

// NormalizeOrigin is raw as an origin, scheme://host[:port]: an http or https
// URL, with no more than "/" for its path, as Playwright's origins are.
func NormalizeOrigin(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	switch {
	case err != nil:
		return "", &InvalidOriginError{raw, "it doesn't parse as a URL"}
	case u.Scheme != "http" && u.Scheme != "https":
		return "", &InvalidOriginError{raw, "it must start with http:// or https://"}
	case u.Host == "" || u.Hostname() == "":
		return "", &InvalidOriginError{raw, "it has no host"}
	case u.User != nil:
		return "", &InvalidOriginError{raw, "it has a user name or password in it"}
	case (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "":
		return "", &InvalidOriginError{raw, "an origin has no path, query or fragment"}
	}
	host := u.Host
	// The browser's origins leave the scheme's own port out.
	if (u.Scheme == "http" && u.Port() == "80") || (u.Scheme == "https" && u.Port() == "443") {
		host = strings.TrimSuffix(host, ":"+u.Port())
	}
	return strings.ToLower(u.Scheme + "://" + host), nil
}

// tabOrigin is the origin of a page open at address, or "" for one with none
// worth reading (about:blank, chrome://, an extension's).
func tabOrigin(address string) string {
	u, err := url.Parse(address)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Scheme + "://" + u.Host)
}

// devToolsCookie is a cookie as DevTools gives them (Network.Cookie).
type devToolsCookie struct {
	Name         string          `json:"name"`
	Value        string          `json:"value"`
	Domain       string          `json:"domain"`
	Path         string          `json:"path"`
	Expires      float64         `json:"expires"`
	HTTPOnly     bool            `json:"httpOnly"`
	Secure       bool            `json:"secure"`
	Session      bool            `json:"session"`
	SameSite     string          `json:"sameSite"`
	PartitionKey json.RawMessage `json:"partitionKey"`
}

// playwrightCookies are DevTools' cookies as Playwright's, as Playwright
// reads them from Chromium itself: a cookie with no SameSite is Lax, which
// is how Chromium treats it, and a session cookie expires at -1. A
// partitioned cookie (a third-party embed's, CHIPS) is left out: added to a
// context without its partition, it would be a first-party cookie it isn't.
func playwrightCookies(in []devToolsCookie) []Cookie {
	out := make([]Cookie, 0, len(in))
	for _, c := range in {
		if len(c.PartitionKey) > 0 && string(c.PartitionKey) != "null" {
			continue
		}
		expires := c.Expires
		if c.Session || expires <= 0 {
			expires = -1
		}
		sameSite := c.SameSite
		if sameSite != "Strict" && sameSite != "None" {
			sameSite = "Lax"
		}
		out = append(out, Cookie{
			Name: c.Name, Value: c.Value, Domain: c.Domain, Path: c.Path,
			Expires: expires, HTTPOnly: c.HTTPOnly, Secure: c.Secure, SameSite: sameSite,
		})
	}
	return out
}

// originReadTimeout bounds reading one origin's localStorage: a blank page
// served by DevTools, so a few hundred milliseconds but on a box under load.
const originReadTimeout = 15 * time.Second

// StorageState reads the browser's sign-ins: its cookies, and localStorage
// for each of origins and of the tabs open. The browser is started when it
// isn't running, signed in as it was. An origin asked for that can't be read
// is an error; a tab's that can't is a warning, which says why. One read at
// a time: tests run in parallel each asking would otherwise open a tab per
// origin each, in the browser the user is watching.
func (b *Browser) StorageState(ctx context.Context, origins []string) (StorageState, []string, error) {
	var asked []string
	for _, raw := range origins {
		origin, err := NormalizeOrigin(raw)
		if err != nil {
			return StorageState{}, nil, err
		}
		if !slices.Contains(asked, origin) {
			asked = append(asked, origin)
		}
	}
	b.stateMu.Lock()
	defer b.stateMu.Unlock()
	if !b.running(ctx) {
		if err := b.start(ctx, "about:blank"); err != nil {
			return StorageState{}, nil, err
		}
	}
	browser, err := b.dialBrowser(ctx)
	if err != nil {
		return StorageState{}, nil, err
	}
	defer browser.Close()

	var cookies struct {
		Cookies []devToolsCookie `json:"cookies"`
	}
	if err := browser.call(ctx, "Storage.getCookies", nil, &cookies); err != nil {
		return StorageState{}, nil, fmt.Errorf("read the browser's cookies: %w", err)
	}
	state := StorageState{Cookies: playwrightCookies(cookies.Cookies), Origins: []OriginState{}}

	tabs, err := b.tabOrigins(ctx)
	if err != nil {
		return StorageState{}, nil, err
	}
	var warnings []string
	read := func(origin string) ([]NameValue, error) {
		ctx, cancel := context.WithTimeout(ctx, originReadTimeout)
		defer cancel()
		return b.localStorage(ctx, browser, origin)
	}
	for _, origin := range asked {
		items, err := read(origin)
		if err != nil {
			return StorageState{}, nil, fmt.Errorf("read %s's localStorage: %w", origin, err)
		}
		if len(items) > 0 {
			state.Origins = append(state.Origins, OriginState{Origin: origin, LocalStorage: items})
		}
	}
	for _, origin := range tabs {
		if slices.Contains(asked, origin) {
			continue
		}
		items, err := read(origin)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("left out %s's localStorage (a tab's): %v", origin, err))
			continue
		}
		if len(items) > 0 {
			state.Origins = append(state.Origins, OriginState{Origin: origin, LocalStorage: items})
		}
	}
	return state, warnings, nil
}

// dialBrowser connects to the browser itself, rather than one of its tabs:
// its cookies are the browser's, and its tabs are made and closed there.
func (b *Browser) dialBrowser(ctx context.Context) (*cdp, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.base()+"/json/version", nil)
	if err != nil {
		return nil, err
	}
	var version struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := fetchJSON(req, &version); err != nil {
		return nil, fmt.Errorf("find the browser: %w", err)
	}
	return dialPage(ctx, devToolsTarget{WebSocketDebuggerURL: version.WebSocketDebuggerURL})
}

// tabOrigins are the origins of the pages open, each once, in DevTools'
// order (the most recently active first).
func (b *Browser) tabOrigins(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.base()+"/json/list", nil)
	if err != nil {
		return nil, err
	}
	var targets []devToolsTarget
	if err := fetchJSON(req, &targets); err != nil {
		return nil, fmt.Errorf("list the browser's tabs: %w", err)
	}
	var origins []string
	for _, t := range targets {
		if t.Type != "page" {
			continue
		}
		if origin := tabOrigin(t.URL); origin != "" && !slices.Contains(origins, origin) {
			origins = append(origins, origin)
		}
	}
	return origins, nil
}

// blankPage is what a background tab is served at the origin it reads.
var blankPage = base64.StdEncoding.EncodeToString([]byte("<!doctype html><title></title>"))

// readLocalStorage is every item, in the page's localStorage.
const readLocalStorage = `Object.keys(localStorage).map((name) => ({ name, value: localStorage.getItem(name) }))`

// localStorage reads origin's localStorage in a background tab of its own,
// closed after, whose requests DevTools answers itself: the page at origin
// is blank, and anything else is refused. A service worker the app has there
// is bypassed, or it would serve the app's own page.
func (b *Browser) localStorage(ctx context.Context, browser *cdp, origin string) ([]NameValue, error) {
	var created struct {
		TargetID string `json:"targetId"`
	}
	if err := browser.call(ctx, "Target.createTarget", map[string]any{"url": "about:blank", "background": true}, &created); err != nil {
		return nil, fmt.Errorf("open a background tab: %w", err)
	}
	defer func() {
		// Closed even when ctx is done: a tab left over is one the user sees.
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = browser.call(closeCtx, "Target.closeTarget", map[string]any{"targetId": created.TargetID}, nil)
	}()
	page, err := dialPage(ctx, devToolsTarget{WebSocketDebuggerURL: "ws://127.0.0.1:" + strconv.Itoa(b.Port) + "/devtools/page/" + created.TargetID})
	if err != nil {
		return nil, err
	}
	defer page.Close()
	for _, step := range []struct {
		method string
		params map[string]any
	}{
		{"Network.enable", nil},
		{"Network.setBypassServiceWorker", map[string]any{"bypass": true}},
		{"Fetch.enable", map[string]any{"patterns": []map[string]any{{"urlPattern": "*"}}}},
	} {
		if err := page.call(ctx, step.method, step.params, nil); err != nil {
			return nil, err
		}
	}
	document := origin + "/"
	answer := func(method string, raw json.RawMessage) error {
		if method != "Fetch.requestPaused" {
			return nil
		}
		var paused struct {
			RequestID string `json:"requestId"`
			Request   struct {
				URL string `json:"url"`
			} `json:"request"`
		}
		if err := json.Unmarshal(raw, &paused); err != nil {
			return err
		}
		if paused.Request.URL == document {
			return page.send("Fetch.fulfillRequest", map[string]any{
				"requestId":       paused.RequestID,
				"responseCode":    200,
				"responseHeaders": []map[string]string{{"name": "Content-Type", "value": "text/html"}},
				"body":            blankPage,
			})
		}
		return page.send("Fetch.failRequest", map[string]any{"requestId": paused.RequestID, "errorReason": "BlockedByClient"})
	}
	var navigated struct {
		ErrorText string `json:"errorText"`
	}
	if err := page.callHandling(ctx, "Page.navigate", map[string]any{"url": document}, &navigated, answer); err != nil {
		return nil, err
	}
	if navigated.ErrorText != "" {
		return nil, errors.New(navigated.ErrorText)
	}
	var items struct {
		Result struct {
			Value []NameValue `json:"value"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text string `json:"text"`
		} `json:"exceptionDetails"`
	}
	if err := page.callHandling(ctx, "Runtime.evaluate", map[string]any{"expression": readLocalStorage, "returnByValue": true}, &items, answer); err != nil {
		return nil, err
	}
	if items.ExceptionDetails != nil {
		return nil, errors.New(items.ExceptionDetails.Text)
	}
	return items.Result.Value, nil
}
