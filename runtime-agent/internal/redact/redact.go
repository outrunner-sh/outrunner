// Package redact masks secrets in a byte stream that arrives in pieces.
package redact

import "strings"

// Redactor removes process secrets from terminal output: before it reaches a
// browser, and before it is recorded. It retains a small suffix between calls so a secret split across
// adjacent PTY reads cannot leak one half in an earlier WebSocket frame.
type Redactor struct {
	secrets []string
	maxLen  int
	pending string
}

// New ignores empty and duplicate secrets. Sorting longest-first keeps
// a shorter secret that is contained in a longer one from leaving a fragment.
func New(secrets []string) *Redactor {
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
	return &Redactor{secrets: active, maxLen: maxLen}
}

// AddSecrets masks secrets from the next Redact on, as well as those it
// already masks, keeping the tail it holds back. A stream whose process
// switched to a new key keeps masking the old one too, since output from
// before the switch can be drawn again.
func (r *Redactor) AddSecrets(secrets []string) {
	next := New(append(append([]string(nil), r.secrets...), secrets...))
	next.pending = r.pending
	*r = *next
}

// Redact emits only text that cannot be the beginning of a secret extending
// into a later PTY read. Call Flush when the stream ends to emit the final
// non-secret suffix.
func (r *Redactor) Redact(data []byte) string {
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
