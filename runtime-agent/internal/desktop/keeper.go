package desktop

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"
	"sync"
	"time"
)

// ErrNotKept is Save's answer when the control plane won't keep this box's
// sign-ins at all (a project's shared box, from before every session had
// its own): the keeper stops.
var ErrNotKept = errors.New("this box's browser sign-ins aren't kept between sessions")

// SignInKeeper sends the box browser's sign-ins on to be kept for the
// person's next session, as they change. It looks every so often while the
// browser runs (Tick). Its first look only notes them, so a box resumed, or
// this agent restarted, sends nothing it hasn't seen change; after that a
// change is sent at once, and then no more often than MinGap, since a
// signed-in site can rewrite a cookie on every page. Cookies are the
// browser's own; localStorage is each origin's as last read from a tab open
// on it, so an origin whose tab was closed keeps what it had. The sign-ins
// waiting for the browser (QueueRestore) are written in when the keeper
// finds it running first: the desktop's Web Browser, from the dock.
type SignInKeeper struct {
	Browser *Browser
	// Save sends the sign-ins on. ErrNotKept stops the keeper.
	Save func(ctx context.Context, state StorageState) error
	// MinGap is the least time between two saves.
	MinGap time.Duration
	// MaxBytes bounds what's sent, as JSON. localStorage is left out to fit,
	// the largest origin's first; sign-ins whose cookies alone don't fit
	// aren't sent.
	MaxBytes int

	mu      sync.Mutex
	origins map[string][]NameValue
	seen    bool
	last    [sha256.Size]byte
	savedAt time.Time
}

// Seed has the keeper start from state, the sign-ins carried over: their
// localStorage is kept for origins with no tab open yet.
func (k *SignInKeeper) Seed(state StorageState) {
	k.mu.Lock()
	defer k.mu.Unlock()
	for _, o := range state.Origins {
		if origin, err := NormalizeOrigin(o.Origin); err == nil && len(o.LocalStorage) > 0 {
			if k.origins == nil {
				k.origins = map[string][]NameValue{}
			}
			k.origins[origin] = o.LocalStorage
		}
	}
}

// Run looks every `every` until ctx is done or the keeper stops, and every
// second while sign-ins wait to be written in, so a browser started from
// the dock gets them before anyone can type an address; looking only while
// active() (the box has a desktop) is true.
func (k *SignInKeeper) Run(ctx context.Context, every time.Duration, active func() bool) {
	ticker := time.NewTicker(min(every, time.Second))
	defer ticker.Stop()
	var looked time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		now := time.Now()
		if now.Sub(looked) < every && !k.Browser.restoreWaiting() {
			continue
		}
		if active != nil && !active() {
			continue
		}
		looked = now
		if !k.Tick(ctx, now) {
			return
		}
	}
}

// Tick looks once, at now. It's false once the keeper is done for good.
// Nothing it logs has a cookie's or an item's value in it.
func (k *SignInKeeper) Tick(ctx context.Context, now time.Time) bool {
	if !k.Browser.running(ctx) {
		return true
	}
	if restored, err := k.Browser.RestorePending(ctx); restored != nil || err != nil {
		if restored != nil {
			k.Seed(*restored)
		}
		if err != nil {
			log.Printf("browser sign-ins: the ones carried over went in only in part: %v", err)
		}
	}
	cookies, tabs, err := k.Browser.SignIns(ctx)
	if err != nil {
		if !errors.Is(err, ErrBrowserNotRunning) {
			log.Printf("browser sign-ins: couldn't read them: %v", err)
		}
		return true
	}
	state, sum, ok := k.next(cookies, tabs)
	if !ok {
		log.Printf("browser sign-ins: not kept, %d cookies are more than %d bytes", len(cookies), k.MaxBytes)
		return true
	}

	k.mu.Lock()
	first := !k.seen
	k.seen = true
	if first {
		k.last = sum
	}
	due := !first && sum != k.last && (k.savedAt.IsZero() || now.Sub(k.savedAt) >= k.MinGap)
	if due {
		// Spaced out even when it fails: the control plane isn't asked
		// again at once.
		k.savedAt = now
	}
	k.mu.Unlock()
	if !due {
		return true
	}

	switch err := k.Save(ctx, state); {
	case errors.Is(err, ErrNotKept):
		log.Printf("browser sign-ins: %v", err)
		return false
	case err != nil:
		log.Printf("browser sign-ins: couldn't keep them: %v", err)
	default:
		k.mu.Lock()
		k.last = sum
		k.mu.Unlock()
	}
	return true
}

// next is the sign-ins to keep, from the browser's cookies and the
// localStorage of the tabs open now, over what the keeper knew, and their
// hash; ok is false when the cookies alone are more than MaxBytes.
func (k *SignInKeeper) next(cookies []Cookie, tabs map[string][]NameValue) (StorageState, [sha256.Size]byte, bool) {
	k.mu.Lock()
	if k.origins == nil {
		k.origins = map[string][]NameValue{}
	}
	for origin, items := range tabs {
		// Read empty is signed out there, or never signed in.
		if len(items) == 0 {
			delete(k.origins, origin)
		} else {
			k.origins[origin] = items
		}
	}
	origins := sortedOrigins(k.origins)
	k.mu.Unlock()

	// In an order of their own, so the same cookies hash the same.
	cookies = slices.Clone(cookies)
	slices.SortFunc(cookies, func(a, b Cookie) int {
		return strings.Compare(a.Domain+"\x00"+a.Path+"\x00"+a.Name, b.Domain+"\x00"+b.Path+"\x00"+b.Name)
	})
	state := StorageState{Cookies: cookies, Origins: origins}
	data, ok := fit(&state, k.MaxBytes)
	return state, sha256.Sum256(data), ok
}

// fit leaves origins' localStorage out of state, the largest first, until
// its JSON is no more than max bytes (0: any), and returns that JSON. It's
// false when no origin is left and the cookies are still more.
func fit(state *StorageState, max int) ([]byte, bool) {
	for {
		data, err := json.Marshal(state)
		if err != nil {
			panic(fmt.Sprintf("a storageState always marshals: %v", err))
		}
		if max <= 0 || len(data) <= max {
			return data, true
		}
		if len(state.Origins) == 0 {
			return data, false
		}
		largest, size := 0, -1
		for i, o := range state.Origins {
			n := 0
			for _, item := range o.LocalStorage {
				n += len(item.Name) + len(item.Value)
			}
			if n > size {
				largest, size = i, n
			}
		}
		state.Origins = slices.Delete(slices.Clone(state.Origins), largest, largest+1)
	}
}
