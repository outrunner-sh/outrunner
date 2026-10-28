package gitcred

import (
	"context"
	"errors"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeFetch hands out numbered tokens, recording the repositories asked for.
type fakeFetch struct {
	mu      sync.Mutex
	repos   []string
	expires func(n int) time.Time
	err     error
	delay   time.Duration
}

func (f *fakeFetch) fetch(_ context.Context, repo string) (Credential, error) {
	time.Sleep(f.delay)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return Credential{}, f.err
	}
	f.repos = append(f.repos, repo)
	n := len(f.repos)
	cred := Credential{Token: "tok-" + string(rune('0'+n))}
	if f.expires != nil {
		cred.ExpiresAt = f.expires(n)
	}
	return cred, nil
}

func (f *fakeFetch) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.repos)
}

type clock struct{ now time.Time }

func (c *clock) Now() time.Time      { return c.now }
func (c *clock) add(d time.Duration) { c.now = c.now.Add(d) }

func newTestCache(f *fakeFetch, c *clock, onToken func()) *Cache {
	cache := NewCache(&Client{Now: c.Now}, onToken)
	cache.fetch = f.fetch
	return cache
}

func get(t *testing.T, c *Cache, repo string) string {
	t.Helper()
	cred, err := c.Get(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	return cred.Token
}

// An installation token is handed out until five minutes before it expires.
func TestCacheKeepsAnAppTokenUntilShortlyBeforeItExpires(t *testing.T) {
	c := &clock{now: testNow}
	f := &fakeFetch{expires: func(int) time.Time { return c.now.Add(time.Hour) }}
	cache := newTestCache(f, c, nil)
	if got := get(t, cache, "acme/widgets"); got != "tok-1" {
		t.Fatalf("first = %s", got)
	}
	c.add(54 * time.Minute)
	if got := get(t, cache, "Acme/Widgets.git"); got != "tok-1" {
		t.Fatalf("at 54 minutes = %s, want the cached token", got)
	}
	c.add(time.Minute)
	if got := get(t, cache, "Acme/Widgets"); got != "tok-2" {
		t.Fatalf("at 55 minutes = %s, want a new token", got)
	}
	if !slices.Equal(f.repos, []string{"acme/widgets", "Acme/Widgets"}) {
		t.Fatalf("asked for %q", f.repos)
	}
}

// The user's own token, which has no expiry, is asked for again every ten
// minutes.
func TestCacheKeepsATokenWithoutExpiryForTenMinutes(t *testing.T) {
	c := &clock{now: testNow}
	f := &fakeFetch{}
	cache := newTestCache(f, c, nil)
	get(t, cache, "")
	c.add(9*time.Minute + 59*time.Second)
	if got := get(t, cache, ""); got != "tok-1" {
		t.Fatalf("before ten minutes = %s", got)
	}
	c.add(time.Second)
	if got := get(t, cache, ""); got != "tok-2" {
		t.Fatalf("at ten minutes = %s", got)
	}
}

func TestCacheKeepsATokenPerRepository(t *testing.T) {
	c := &clock{now: testNow}
	f := &fakeFetch{}
	cache := newTestCache(f, c, nil)
	a, b, project := get(t, cache, "acme/a"), get(t, cache, "acme/b"), get(t, cache, "")
	if a == b || b == project || get(t, cache, "acme/a") != a || f.count() != 3 {
		t.Fatalf("a=%s b=%s project=%s after %d fetches", a, b, project, f.count())
	}
}

func TestCacheEraseForgetsTheToken(t *testing.T) {
	c := &clock{now: testNow}
	f := &fakeFetch{}
	cache := newTestCache(f, c, nil)
	get(t, cache, "acme/a")
	get(t, cache, "acme/b")
	if err := cache.Erase("ACME/a.git"); err != nil {
		t.Fatal(err)
	}
	if got := get(t, cache, "acme/a"); got != "tok-3" {
		t.Fatalf("after erase = %s, want a new token", got)
	}
	if got := get(t, cache, "acme/b"); got != "tok-2" {
		t.Fatalf("another repository's token went too: %s", got)
	}
	if err := cache.Erase("not a repo"); !errors.Is(err, ErrInvalidRepo) {
		t.Fatalf("erase of an invalid repo: %v", err)
	}
}

func TestCacheSharesOneFetchBetweenConcurrentAsks(t *testing.T) {
	c := &clock{now: testNow}
	f := &fakeFetch{delay: 50 * time.Millisecond}
	cache := newTestCache(f, c, nil)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = cache.Get(context.Background(), "acme/widgets")
		}()
	}
	wg.Wait()
	if f.count() != 1 {
		t.Fatalf("%d fetches for one repository", f.count())
	}
}

func TestCacheDoesNotKeepAFailure(t *testing.T) {
	c := &clock{now: testNow}
	f := &fakeFetch{err: &Error{Status: 403, Message: "no access"}}
	cache := newTestCache(f, c, nil)
	if _, err := cache.Get(context.Background(), "acme/a"); err == nil || err.Error() != "no access" {
		t.Fatalf("err = %v", err)
	}
	f.err = nil
	if got := get(t, cache, "acme/a"); got != "tok-1" {
		t.Fatalf("after the failure = %s", got)
	}
	if _, err := cache.Get(context.Background(), "../etc"); !errors.Is(err, ErrInvalidRepo) {
		t.Fatalf("invalid repo: %v", err)
	}
}

// Every token handed out is among Tokens, for the terminals to mask, until
// it expires; onToken says when there is a new one.
func TestCacheTokensAreTheOnesThatMayStillWork(t *testing.T) {
	c := &clock{now: testNow}
	f := &fakeFetch{expires: func(n int) time.Time {
		if n == 2 {
			return time.Time{} // the user's own
		}
		return c.now.Add(time.Hour)
	}}
	var calls atomic.Int32
	cache := newTestCache(f, c, func() { calls.Add(1) })
	get(t, cache, "acme/a")
	get(t, cache, "acme/b")
	get(t, cache, "acme/a")
	if tokens := cache.Tokens(); len(tokens) != 2 || !slices.Contains(tokens, "tok-1") || !slices.Contains(tokens, "tok-2") || calls.Load() != 2 {
		t.Fatalf("tokens = %q after %d calls", tokens, calls.Load())
	}
	c.add(time.Hour)
	if tokens := cache.Tokens(); !slices.Equal(tokens, []string{"tok-2"}) {
		t.Fatalf("after the hour, tokens = %q", tokens)
	}
}
