package sessiontools

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

// A command's arguments become its tool's: the instruction from its
// arguments, or stdin; a command used wrongly goes nowhere.
func TestParse(t *testing.T) {
	tool, args, err := parse("suggest-learning", []string{"--title", " Commits ", "-"}, strings.NewReader("  Use Conventional Commits.\n"))
	if err != nil || tool != "suggest_learning" || string(args) != `{"body":"Use Conventional Commits.","scope":"personal","title":"Commits"}` {
		t.Fatalf("parse = %q, %s, %v", tool, args, err)
	}
	for _, bad := range [][]string{{"suggest-learning", "instruction"}, {"suggest-learning", "--title", "T"}, {"forget-everything"}} {
		if _, _, err := parse(bad[0], bad[1:], strings.NewReader("")); err == nil {
			t.Errorf("parse(%q) took it", bad)
		}
	}
}

func TestMainSaysHowToUseIt(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := Main(context.Background(), nil, func(string) string { return "" }, strings.NewReader(""), &stdout, &stderr, Local{}); code != 2 ||
		!strings.Contains(stderr.String(), "suggest-learning") {
		t.Fatalf("no command = %d, %q", code, stderr.String())
	}
	stderr.Reset()
	if code := Main(context.Background(), []string{"suggest-learning", "x"}, func(string) string { return "ws" }, strings.NewReader(""), &stdout, &stderr, Local{}); code != 2 {
		t.Fatalf("a command used wrongly = %d, %q", code, stderr.String())
	}
}

func TestWrapper(t *testing.T) {
	if got := Wrapper("/opt/it's/runtime-agent", "/home/runtime"); got != "#!/bin/sh\nexec '/opt/it'\\''s/runtime-agent' session-tool --root '/home/runtime' \"$@\"\n" {
		t.Fatalf("Wrapper = %q", got)
	}
}

// memory's search is its flag and any words after; remember's note is its
// arguments or stdin, shared with the org on --org.
func TestParseMemory(t *testing.T) {
	tool, args, err := parse("memory", []string{"--search", "pnpm", "tests"}, strings.NewReader(""))
	if err != nil || tool != "read_memory" || string(args) != `{"query":"pnpm tests"}` {
		t.Fatalf("memory = %q, %s, %v", tool, args, err)
	}
	if _, args, _ := parse("memory", nil, strings.NewReader("")); string(args) != `{"query":""}` {
		t.Fatalf("memory alone = %s", args)
	}
	tool, args, err = parse("remember", []string{"--org", "-"}, strings.NewReader("CI runs on Node 22.\n"))
	if err != nil || tool != "remember" || string(args) != `{"body":"CI runs on Node 22.","scope":"org"}` {
		t.Fatalf("remember = %q, %s, %v", tool, args, err)
	}
	if _, _, err := parse("remember", nil, strings.NewReader("  ")); err == nil {
		t.Fatal("remember took no note")
	}
}
