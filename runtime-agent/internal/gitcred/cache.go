package gitcred

import (
	"context"
	"sync"
	"time"
)

const (
	// refreshMargin is how long before its expiry a token is replaced: a push
	// that starts with a minute left on it shouldn't fail halfway.
	refreshMargin = 5 * time.Minute
	// unexpiringTTL is how long a token with no expiry (the user's own) is
	// kept before the control plane is asked again: a user who switches the
	// project to the GitHub App, or revokes the token, is followed within it.
	unexpiringTTL = 10 * time.Minute
)

// Cache keeps the tokens the control plane gives, per repository, for every
// session on the box: git asks for one at each fetch and push.
type Cache struct {
	fetch func(ctx context.Context, repo string) (Credential, error)
	now   func() time.Time
	// onToken is called after a token the cache didn't hold is obtained, for
	// the terminals to mask it.
	onToken func()

	mu      sync.Mutex
	entries map[string]*entry
	// issued are the tokens obtained, until they expire (Tokens).
	issued map[string]time.Time
}

type entry struct {
	// mu is held across a fetch, so concurrent asks for one repository wait
	// for the one token instead of each asking the control plane.
	mu    sync.Mutex
	cred  Credential
	until time.Time
}

// NewCache is a cache over client. onToken, when set, is called once a new
// token is among Tokens.
func NewCache(client *Client, onToken func()) *Cache {
	now := time.Now
	if client.Now != nil {
		now = client.Now
	}
	return &Cache{
		fetch:   client.Fetch,
		now:     now,
		onToken: onToken,
		entries: map[string]*entry{},
		issued:  map[string]time.Time{},
	}
}

// Get is a token for repo ("owner/name", or "" for the box's own project):
// the one held while it's fresh, else a new one from the control plane.
func (c *Cache) Get(ctx context.Context, repo string) (Credential, error) {
	repo, err := NormalizeRepo(repo)
	if err != nil {
		return Credential{}, err
	}
	key := repoKey(repo)
	c.mu.Lock()
	e := c.entries[key]
	if e == nil {
		e = &entry{}
		c.entries[key] = e
	}
	c.mu.Unlock()

	e.mu.Lock()
	defer e.mu.Unlock()
	if e.cred.Token != "" && c.now().Before(e.until) {
		return e.cred, nil
	}
	// The fetch serves everyone waiting on it, so one caller giving up
	// mustn't cut it off; the client's timeout bounds it.
	cred, err := c.fetch(context.WithoutCancel(ctx), repo)
	if err != nil {
		return Credential{}, err
	}
	e.cred, e.until = cred, c.expiry(cred)
	if c.record(cred) && c.onToken != nil {
		c.onToken()
	}
	return cred, nil
}

// expiry is when a token stops being handed out.
func (c *Cache) expiry(cred Credential) time.Time {
	if cred.ExpiresAt.IsZero() {
		return c.now().Add(unexpiringTTL)
	}
	return cred.ExpiresAt.Add(-refreshMargin)
}

// record adds a token to those issued, dropping the expired, and reports
// whether it is new.
func (c *Cache) record(cred Credential) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for token, expires := range c.issued {
		if !expires.IsZero() && !now.Before(expires) {
			delete(c.issued, token)
		}
	}
	_, known := c.issued[cred.Token]
	c.issued[cred.Token] = cred.ExpiresAt
	return !known
}

// Erase forgets repo's token: git says it was refused (its credential
// helper's erase), and the next ask gets a new one.
func (c *Cache) Erase(repo string) error {
	repo, err := NormalizeRepo(repo)
	if err != nil {
		return err
	}
	c.mu.Lock()
	delete(c.entries, repoKey(repo))
	c.mu.Unlock()
	return nil
}

// Tokens are the tokens obtained that may still work, for the terminals to
// mask: one that has expired is harmless, and masking every token a box
// ever had would only slow its terminals down.
func (c *Cache) Tokens() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	tokens := make([]string, 0, len(c.issued))
	for token, expires := range c.issued {
		if expires.IsZero() || now.Before(expires) {
			tokens = append(tokens, token)
		}
	}
	return tokens
}
