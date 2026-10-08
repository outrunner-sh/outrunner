package redact

import (
	"strings"
	"testing"
)

func TestRedactorReplacesWholeAndRepeatedSecrets(t *testing.T) {
	r := New([]string{"secret-value"})
	got := r.Redact([]byte("before secret-value after secret-value")) + r.Flush()
	if got != "before *** after ***" {
		t.Fatalf("redacted output = %q", got)
	}
}

func TestRedactorDoesNotLeakSecretsSplitAcrossReads(t *testing.T) {
	r := New([]string{"secret-value"})
	got := r.Redact([]byte("before secret-"))
	got += r.Redact([]byte("value after"))
	got += r.Flush()
	if got != "before *** after" {
		t.Fatalf("split secret leaked or output changed: %q", got)
	}
}

func TestRedactorRetainsOrdinaryShortOutput(t *testing.T) {
	r := New([]string{"secret-value"})
	got := r.Redact([]byte("ok")) + r.Flush()
	if got != "ok" {
		t.Fatalf("ordinary output = %q", got)
	}
}

func TestRedactorNeverCutsIntoASecretWhenAnotherOverlapsItsEnd(t *testing.T) {
	// The key ends with the start of the other secret, and lands right where
	// the held-back tail begins: holding back the other's prefix must not
	// split the key and send its first part unmasked.
	key := "sk-or-v1-0123456789abcdef0123ab"
	other := "abSECRET"
	r := New([]string{key, other})
	tail := strings.Repeat("y", len(key)-1)
	got := r.Redact([]byte("x "+key+tail)) + r.Flush()
	if strings.Contains(got, key[:len(key)-2]) {
		t.Fatalf("key leaked: %q", got)
	}
	if got != "x ***"+tail {
		t.Fatalf("redacted output = %q", got)
	}
}

func TestRedactorMasksOverlappingSecretsSplitAcrossReads(t *testing.T) {
	key := "sk-or-v1-0123456789abcdef0123ab"
	other := "abSECRET"
	r := New([]string{key, other})
	stream := "a " + key + " b " + other + " c " + key + strings.Repeat("z", 40)
	var got strings.Builder
	for i := 0; i < len(stream); i += 7 { // every chunk boundary position
		end := min(i+7, len(stream))
		got.WriteString(r.Redact([]byte(stream[i:end])))
	}
	got.WriteString(r.Flush())
	want := "a *** b *** c ***" + strings.Repeat("z", 40)
	if got.String() != want {
		t.Fatalf("redacted output = %q, want %q", got.String(), want)
	}
}
