package desktop

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Every new session gets a box of its own (lib/runtime/computer-scope.ts),
// so its browser starts on an empty profile: a person signed in to their app
// in one session had to sign in again in the next. Their sign-ins are
// carried over instead. The box's agent sends the browser's cookies and
// localStorage to the control plane as they change (SignInKeeper), which
// keeps them sealed for that person and project. A new session's box gets
// them back before its browser shows a page (QueueRestore), and whatever
// starts the browser first writes them in through DevTools: start, for a
// launch of this package's, or the keeper, for the desktop's Web Browser. A
// browser that has run on the box already keeps its own.

// restoreFile holds the sign-ins waiting for the browser's first start,
// beside its profile, readable by the box's user alone.
const restoreFile = "sign-ins.restore.json"

// restoreTimeout bounds writing sign-ins in: their cookies in one call, and
// a blank tab for each origin's localStorage.
const restoreTimeout = 30 * time.Second

func (b *Browser) restorePath() string { return filepath.Join(filepath.Dir(b.Profile), restoreFile) }

// FreshProfile reports whether the browser has never run on this box: its
// profile folder isn't there yet.
func (b *Browser) FreshProfile() bool {
	_, err := os.Stat(b.Profile)
	return errors.Is(err, fs.ErrNotExist)
}

// QueueRestore has state written into the browser when it next starts, or
// when the keeper finds it running. Nothing is queued for empty sign-ins.
func (b *Browser) QueueRestore(state StorageState) error {
	if len(state.Cookies) == 0 && len(state.Origins) == 0 {
		return nil
	}
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	dir := filepath.Dir(b.restorePath())
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// Written whole before it's there: a launch never reads half of it.
	tmp, err := os.CreateTemp(dir, restoreFile+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), b.restorePath())
}

// claimRestore takes the sign-ins waiting for the browser, if any, so that
// nothing else writes them in too: the desktop tools' server and this agent
// are each a process of their own, and the rename is what decides.
func (b *Browser) claimRestore() (*StorageState, error) {
	claimed := b.restorePath() + ".claimed-" + strconv.Itoa(os.Getpid()) + "-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	if err := os.Rename(b.restorePath(), claimed); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	defer os.Remove(claimed)
	data, err := os.ReadFile(claimed)
	if err != nil {
		return nil, err
	}
	var state StorageState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("the sign-ins waiting for the browser don't read: %w", err)
	}
	return &state, nil
}

// RestorePending writes the sign-ins waiting for the browser into it, when
// it runs and they still wait: it was started by something other than this
// package (the desktop's Web Browser, from the dock). It returns them, or
// nil when none waited.
func (b *Browser) RestorePending(ctx context.Context) (*StorageState, error) {
	if _, err := os.Stat(b.restorePath()); err != nil {
		return nil, nil
	}
	b.stateMu.Lock()
	defer b.stateMu.Unlock()
	state, err := b.claimRestore()
	if state == nil || err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, restoreTimeout)
	defer cancel()
	return state, b.writeSignIns(ctx, *state)
}

// restoreAt writes state into the browser start just launched on a blank
// tab, then shows rawURL there: the first page opens signed in. A sign-in
// that couldn't be written is said on stderr, by origin, never its value.
func (b *Browser) restoreAt(ctx context.Context, state StorageState, rawURL string) {
	writeCtx, cancel := context.WithTimeout(ctx, restoreTimeout)
	err := b.writeSignIns(writeCtx, state)
	cancel()
	if err != nil {
		fmt.Fprintf(os.Stderr, "desktop: the sign-ins carried over from the last session went in only in part: %v\n", err)
	}
	if rawURL == "" || rawURL == "about:blank" {
		return
	}
	tab, err := b.page(ctx)
	if err == nil {
		var page *cdp
		if page, err = dialPage(ctx, tab); err == nil {
			defer page.Close()
			err = page.call(ctx, "Page.navigate", map[string]any{"url": rawURL}, nil)
		}
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "desktop: the browser started, but didn't go to %s: %v\n", rawURL, err)
	}
}

// cookieParam is a cookie as DevTools adds them (Network.CookieParam), as
// Playwright adds a storageState's.
type cookieParam struct {
	Name     string   `json:"name"`
	Value    string   `json:"value"`
	Domain   string   `json:"domain"`
	Path     string   `json:"path"`
	Expires  *float64 `json:"expires,omitempty"`
	HTTPOnly bool     `json:"httpOnly"`
	Secure   bool     `json:"secure"`
	SameSite string   `json:"sameSite,omitempty"`
}

// cookieParams are cookies to add at now: one already expired is left out,
// and a session cookie (-1) is added with no expiry, as one.
func cookieParams(cookies []Cookie, now time.Time) []cookieParam {
	out := make([]cookieParam, 0, len(cookies))
	for _, c := range cookies {
		if c.Name == "" || c.Domain == "" {
			continue
		}
		p := cookieParam{Name: c.Name, Value: c.Value, Domain: c.Domain, Path: cmp.Or(c.Path, "/"), HTTPOnly: c.HTTPOnly, Secure: c.Secure}
		if c.Expires > 0 {
			if c.Expires <= float64(now.Unix()) {
				continue
			}
			expires := c.Expires
			p.Expires = &expires
		}
		switch c.SameSite {
		case "Strict", "Lax", "None":
			p.SameSite = c.SameSite
		}
		out = append(out, p)
	}
	return out
}

// writeLocalStorage is the script that sets items in the page's
// localStorage. JSON is a script's literal; Go's escapes the line
// separators that once weren't.
func writeLocalStorage(items []NameValue) (string, error) {
	pairs := make([][2]string, len(items))
	for i, item := range items {
		pairs[i] = [2]string{item.Name, item.Value}
	}
	data, err := json.Marshal(pairs)
	if err != nil {
		return "", err
	}
	return "(() => { for (const [name, value] of " + string(data) + ") localStorage.setItem(name, value); return true })()", nil
}

// writeSignIns writes state into the running browser: its cookies, and each
// origin's localStorage in a background tab served a blank page at the
// origin (inBlankTab), so the app's code never runs and nothing is asked of
// it. Cookies DevTools refuses as a whole are added one at a time, so one it
// won't take doesn't keep the rest out. What couldn't go in is the error,
// after the rest has.
func (b *Browser) writeSignIns(ctx context.Context, state StorageState) error {
	browser, err := b.dialBrowser(ctx)
	if err != nil {
		return err
	}
	defer browser.Close()
	var problems []string
	cookies := cookieParams(state.Cookies, time.Now())
	if len(cookies) > 0 {
		if err := browser.call(ctx, "Storage.setCookies", map[string]any{"cookies": cookies}, nil); err != nil {
			refused := 0
			for _, c := range cookies {
				if browser.call(ctx, "Storage.setCookies", map[string]any{"cookies": []cookieParam{c}}, nil) != nil {
					refused++
				}
			}
			if refused > 0 {
				problems = append(problems, fmt.Sprintf("%d of %d cookies were refused", refused, len(cookies)))
			}
		}
	}
	for _, o := range state.Origins {
		origin, err := NormalizeOrigin(o.Origin)
		if err != nil || len(o.LocalStorage) == 0 {
			continue
		}
		script, err := writeLocalStorage(o.LocalStorage)
		if err == nil {
			originCtx, cancel := context.WithTimeout(ctx, originReadTimeout)
			err = b.inBlankTab(originCtx, browser, origin, script, nil)
			cancel()
		}
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s's localStorage: %v", origin, err))
		}
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

// ErrBrowserNotRunning is sign-ins asked of a browser that isn't running,
// which SignIns doesn't start for them.
var ErrBrowserNotRunning = errors.New("the browser isn't running")

// SignIns are the running browser's sign-ins, as they're kept between
// sessions: every cookie (as StorageState reads them), and the localStorage
// of each origin a tab is open on, by origin. Unlike StorageState, it opens
// no tab and runs nothing in one, so it can look as often as the keeper
// does: each tab's is read through DevTools' own inspection of its DOM
// storage, which the app's code can't see. A tab that can't be read
// (closing, or still loading) is left out.
func (b *Browser) SignIns(ctx context.Context) ([]Cookie, map[string][]NameValue, error) {
	if !b.running(ctx) {
		return nil, nil, ErrBrowserNotRunning
	}
	browser, err := b.dialBrowser(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer browser.Close()
	var cookies struct {
		Cookies []devToolsCookie `json:"cookies"`
	}
	if err := browser.call(ctx, "Storage.getCookies", nil, &cookies); err != nil {
		return nil, nil, fmt.Errorf("read the browser's cookies: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.base()+"/json/list", nil)
	if err != nil {
		return nil, nil, err
	}
	var targets []devToolsTarget
	if err := fetchJSON(req, &targets); err != nil {
		return nil, nil, fmt.Errorf("list the browser's tabs: %w", err)
	}
	origins := map[string][]NameValue{}
	for _, t := range targets {
		if t.Type != "page" || tabOrigin(t.URL) == "" {
			continue
		}
		tabCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		origin, items, err := b.tabLocalStorage(tabCtx, t.ID)
		cancel()
		if err != nil || origin == "" {
			continue
		}
		if _, read := origins[origin]; !read {
			origins[origin] = items
		}
	}
	return playwrightCookies(cookies.Cookies), origins, nil
}

// tabLocalStorage reads the localStorage of the page open in tab id, with
// the origin of the page it was read from, its items in order of name.
func (b *Browser) tabLocalStorage(ctx context.Context, id string) (string, []NameValue, error) {
	page, err := dialPage(ctx, devToolsTarget{WebSocketDebuggerURL: b.pageSocket(id)})
	if err != nil {
		return "", nil, err
	}
	defer page.Close()
	var tree struct {
		FrameTree struct {
			Frame struct {
				URL string `json:"url"`
			} `json:"frame"`
		} `json:"frameTree"`
	}
	if err := page.call(ctx, "Page.getFrameTree", nil, &tree); err != nil {
		return "", nil, err
	}
	origin := tabOrigin(tree.FrameTree.Frame.URL)
	if origin == "" {
		return "", nil, nil
	}
	var storage struct {
		Entries [][]string `json:"entries"`
	}
	storageID := map[string]any{"securityOrigin": origin, "isLocalStorage": true}
	if err := page.call(ctx, "DOMStorage.getDOMStorageItems", map[string]any{"storageId": storageID}, &storage); err != nil {
		return "", nil, err
	}
	items := make([]NameValue, 0, len(storage.Entries))
	for _, entry := range storage.Entries {
		if len(entry) == 2 {
			items = append(items, NameValue{Name: entry[0], Value: entry[1]})
		}
	}
	slices.SortFunc(items, func(a, b NameValue) int { return strings.Compare(a.Name, b.Name) })
	return origin, items, nil
}

// sortedOrigins are origins as a storageState's, in order of origin, those
// with nothing in their localStorage left out.
func sortedOrigins(origins map[string][]NameValue) []OriginState {
	out := make([]OriginState, 0, len(origins))
	for origin, items := range origins {
		if len(items) > 0 {
			out = append(out, OriginState{Origin: origin, LocalStorage: items})
		}
	}
	slices.SortFunc(out, func(a, b OriginState) int { return strings.Compare(a.Origin, b.Origin) })
	return out
}
