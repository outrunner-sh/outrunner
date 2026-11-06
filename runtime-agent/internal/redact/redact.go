// Package redact masks secrets in a byte stream that arrives in pieces.
package redact

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
)

// Tokens are secrets that arrive while streams are already being redacted
// (a value the user provides mid-session): every Redactor following them
// masks one from its next call on.
type Tokens struct {
	mu   sync.Mutex
	list []string
	gen  atomic.Uint64
}

// Add makes values secrets for every Redactor following t.
func (t *Tokens) Add(values ...string) {
	if len(values) == 0 {
		return
	}
	t.mu.Lock()
	t.list = append(t.list, values...)
	t.mu.Unlock()
	t.gen.Add(1)
}

// Set replaces the tokens with values: one taken away (its session gone) is
// no longer masked by the followers, who rebuild from it.
func (t *Tokens) Set(values []string) {
	t.mu.Lock()
	t.list = append([]string(nil), values...)
	t.mu.Unlock()
	t.gen.Add(1)
}

func (t *Tokens) snapshot() ([]string, uint64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]string(nil), t.list...), t.gen.Load()
}

// Redactor removes process secrets from terminal output: before it reaches a
// browser, and before it is recorded. It retains a small suffix between calls so a secret split across
// adjacent PTY reads cannot leak one half in an earlier WebSocket frame.
type Redactor struct {
	secrets []string
	maxLen  int
	pending string

	// base are the secrets it was made with; live, when followed, adds to
	// them, and seen is the generation of live it last read.
	base []string
	live *Tokens
	seen uint64
}

// New ignores empty and duplicate secrets. Sorting longest-first keeps
// a shorter secret that is contained in a longer one from leaving a fragment.
func New(secrets []string) *Redactor {
	r := &Redactor{base: secrets}
	r.secrets, r.maxLen = activeSecrets(secrets)
	return r
}

// Follow has r mask live's tokens too, those added later included.
func (r *Redactor) Follow(live *Tokens) *Redactor {
	r.live = live
	r.refresh()
	return r
}

// refresh takes in tokens added since it last looked.
func (r *Redactor) refresh() {
	if r.live == nil || r.live.gen.Load() == r.seen {
		return
	}
	extra, gen := r.live.snapshot()
	r.secrets, r.maxLen = activeSecrets(append(append([]string(nil), r.base...), extra...))
	r.seen = gen
}

func activeSecrets(secrets []string) ([]string, int) {
	seen := make(map[string]struct{})
	active := make([]string, 0, len(secrets))
	maxLen := 0
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		if _, ok := seen[secret]; ok {
			continue
		}
		seen[secret] = struct{}{}
		active = append(active, secret)
		if len(secret) > maxLen {
			maxLen = len(secret)
		}
	}
	for i := 0; i < len(active); i++ {
		for j := i + 1; j < len(active); j++ {
			if len(active[j]) > len(active[i]) {
				active[i], active[j] = active[j], active[i]
			}
		}
	}
	return active, maxLen
}

// Redact emits only text that cannot be the beginning of a secret extending
// into a later PTY read. Call Flush when the stream ends to emit the final
// non-secret suffix.
func (r *Redactor) Redact(data []byte) string {
	r.refresh()
	if len(r.secrets) == 0 {
		return string(data)
	}
	all := r.pending + string(data)
	cut := len(all) - (r.maxLen - 1)
	if cut < 0 {
		cut = 0
	}
	// Do not cut through a partial secret. If the suffix just before cut is a
	// prefix of any secret, retain it until the following read disambiguates it.
	// Moving cut back can land it inside another secret that ended at the old
	// cut (one secret ending with the start of another), which would then be
	// emitted unmasked, so check every secret again until cut stays put.
	for moved := true; moved; {
		moved = false
		for _, secret := range r.secrets {
			limit := len(secret) - 1
			if limit > cut {
				limit = cut
			}
			for n := limit; n > 0; n-- {
				if all[cut-n:cut] == secret[:n] {
					cut -= n
					moved = true
					break
				}
			}
		}
	}

	out := r.replace(all[:cut])
	r.pending = all[cut:]
	return out
}

// Flush emits the final buffered bytes after applying the same replacement.
func (r *Redactor) Flush() string {
	r.refresh()
	out := r.replace(r.pending)
	r.pending = ""
	return out
}

func (r *Redactor) replace(text string) string {
	for _, secret := range r.secrets {
		text = strings.ReplaceAll(text, secret, "***")
	}
	return text
}

// JSON masks the secrets in every string of one JSON document, keys
// included, and leaves the rest as it was: a secret is matched as the text it
// is, not as JSON escapes it, and nothing outside a string can be cut into.
func (r *Redactor) JSON(data []byte) ([]byte, error) {
	r.refresh()
	if len(r.secrets) == 0 {
		return data, nil
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return json.Marshal(r.maskValue(v))
}

func (r *Redactor) maskValue(v any) any {
	switch t := v.(type) {
	case string:
		return r.replace(t)
	case []any:
		for i := range t {
			t[i] = r.maskValue(t[i])
		}
		return t
	case map[string]any:
		masked := make(map[string]any, len(t))
		for k, x := range t {
			masked[r.replace(k)] = r.maskValue(x)
		}
		return masked
	}
	return v
}
