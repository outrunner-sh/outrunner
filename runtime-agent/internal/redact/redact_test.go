package redact

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
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

// A token added while a stream is redacted is masked from the next read on,
// in a redactor made before it existed.
func TestFollowedTokensAddedLaterAreMasked(t *testing.T) {
	live := &Tokens{}
	r := New([]string{"static-secret"}).Follow(live)
	if got := r.Redact([]byte("a static-secret b ")) + r.Flush(); got != "a *** b " {
		t.Fatalf("before = %q", got)
	}
	live.Add("provided-later")
	if got := r.Redact([]byte("x provided-later y static-secret")) + r.Flush(); got != "x *** y ***" {
		t.Fatalf("after = %q", got)
	}
}

func TestSetTokensTakesOneAway(t *testing.T) {
	live := &Tokens{}
	live.Add("first-secret", "second-secret")
	r := New(nil).Follow(live)
	live.Set([]string{"second-secret"})
	if got := r.Redact([]byte("first-secret second-secret")) + r.Flush(); got != "first-secret ***" {
		t.Fatalf("got %q", got)
	}
}

func TestRedactorJSONMasksStringsAsWrittenAndEscaped(t *testing.T) {
	r := New([]string{"canary-2682b7c55940", `q"uo<te>&`})
	got, err := r.JSON([]byte(`{"content":[{"type":"text","text":"canary-2682b7c55940\n"}],"n":12345678901234567890,"k":"q\"uo\u003cte\u003e\u0026!"}`))
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(got, &back); err != nil {
		t.Fatalf("masked JSON is not JSON: %s", got)
	}
	if s := string(got); strings.Contains(s, "canary") || strings.Contains(s, "uo") {
		t.Fatalf("secret left in %s", s)
	}
	if !strings.Contains(string(got), `"n":12345678901234567890`) || back["k"] != "***!" {
		t.Fatalf("masked JSON changed more than its secrets: %s", got)
	}
}

func TestRedactorJSONFollowsLiveTokens(t *testing.T) {
	live := &Tokens{}
	r := New(nil).Follow(live)
	live.Add("provided-later-value")
	got, err := r.JSON([]byte(`{"text":"provided-later-value"}`))
	if err != nil || string(got) != `{"text":"***"}` {
		t.Fatalf("JSON = %s, %v", got, err)
	}
}

func TestRedactorMasksASecretsEncodedForms(t *testing.T) {
	secret := "s3cr3t/value+with&chars"
	r := New([]string{secret})
	for _, prefix := range []string{"", "a", "ab"} {
		// base64 of the secret inside longer data, at each alignment.
		encoded := base64.StdEncoding.EncodeToString([]byte(prefix + secret + "\n"))
		got := r.Redact([]byte(encoded)) + r.Flush()
		if !strings.Contains(got, "***") || strings.Contains(got, base64.StdEncoding.EncodeToString([]byte(secret[3:15]))) {
			t.Fatalf("base64 after %q not masked: %q -> %q", prefix, encoded, got)
		}
	}
	for _, form := range []string{url.QueryEscape(secret), `s3cr3t/value+with\u0026chars`} {
		if got := r.Redact([]byte("x "+form+" y")) + r.Flush(); got != "x *** y" {
			t.Fatalf("%q -> %q", form, got)
		}
	}
}

func TestRedactorMasksEachLineOfAMultiLineSecret(t *testing.T) {
	key := "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----"
	r := New([]string{key})
	got := r.Redact([]byte("cat: MIIEvQIBADANBgkqhkiG9w0BAQEFAASC and -----END PRIVATE KEY-----")) + r.Flush()
	if got != "cat: *** and -----END PRIVATE KEY-----" {
		t.Fatalf("multi-line secret = %q", got)
	}
}
