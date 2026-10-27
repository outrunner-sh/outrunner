package ask

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func validName(name string) bool { return name != "" && name != "PATH" && !strings.Contains(name, "-") }

func TestValidateSecretRequest(t *testing.T) {
	ok := SecretRequest{Reason: "Deploy", Keys: []SecretKey{{Name: "A"}, {Name: "B", Optional: true}}}
	if err := ValidateSecretRequest(ok, validName); err != nil {
		t.Fatalf("valid request refused: %v", err)
	}
	for name, req := range map[string]SecretRequest{
		"no reason":     {Keys: []SecretKey{{Name: "A"}}},
		"no keys":       {Reason: "x"},
		"reserved name": {Reason: "x", Keys: []SecretKey{{Name: "PATH"}}},
		"bad name":      {Reason: "x", Keys: []SecretKey{{Name: "a-b"}}},
		"twice":         {Reason: "x", Keys: []SecretKey{{Name: "A"}, {Name: "A"}}},
		"all optional":  {Reason: "x", Keys: []SecretKey{{Name: "A", Optional: true}}},
		"long reason":   {Reason: strings.Repeat("x", MaxSecretReason+1), Keys: []SecretKey{{Name: "A"}}},
	} {
		if err := ValidateSecretRequest(req, validName); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v, want ErrInvalid", name, err)
		}
	}
}

func TestFormatSecretsNamesNoValues(t *testing.T) {
	req := SecretRequest{Reason: "x", Keys: []SecretKey{{Name: "A"}, {Name: "B", Optional: true}}}
	text := FormatSecrets(req, SecretReply{Provided: []string{"A"}, EnvFile: "/root/env/ws.provided"})
	for _, want := range []string{"provided A.", "left out B", ". /root/env/ws.provided && <command>", "Never print"} {
		if !strings.Contains(text, want) {
			t.Errorf("result %q lacks %q", text, want)
		}
	}
	if skipped := FormatSecrets(req, SecretReply{Skipped: true}); !strings.Contains(skipped, "skipped") || !strings.Contains(skipped, "Don't ask for them again") {
		t.Errorf("skipped result = %q", skipped)
	}
}

// The answer reaches the waiting call once, and only for the request the
// form showed; keep runs before the call is answered.
func TestSecretsBrokerAnswersTheRequestShown(t *testing.T) {
	b := NewSecretsBroker()
	req := SecretRequest{Reason: "x", Keys: []SecretKey{{Name: "A"}, {Name: "B"}}}
	got := make(chan SecretReply, 1)
	go func() {
		reply, err := b.Request(context.Background(), "ws", "r1", req)
		if err != nil {
			t.Errorf("Request: %v", err)
		}
		got <- reply
	}()
	waitFor(t, func() bool { return b.held.has("ws") })

	kept := 0
	keep := func(SecretRequest) (SecretReply, error) {
		kept++
		return SecretReply{Provided: []string{"A", "B"}}, nil
	}
	if err := b.Answer("ws", []string{"B", "A"}, keep); !errors.Is(err, ErrNotWaiting) {
		t.Fatalf("answer to another request = %v, want ErrNotWaiting", err)
	}
	if err := b.Answer("ws", []string{"A", "B"}, keep); err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if r := <-got; len(r.Provided) != 2 || kept != 1 {
		t.Fatalf("reply %+v, kept %d times", r, kept)
	}
	if err := b.Answer("ws", []string{"A", "B"}, keep); !errors.Is(err, ErrNotWaiting) || kept != 1 {
		t.Fatalf("second answer = %v (kept %d), want ErrNotWaiting", err, kept)
	}
}
