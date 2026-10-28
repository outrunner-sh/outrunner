package gitcred

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func writeScript(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestGhWrapperQuotesItsPaths(t *testing.T) {
	got := GhWrapper("/opt/it's here/runtime-agent", "/home/runtime", "/usr/bin/gh")
	want := "#!/bin/sh\n" +
		`if token=$('/opt/it'\''s here/runtime-agent' github-token --root '/home/runtime' -- "$@") && [ -n "$token" ]; then` + "\n" +
		"\tGH_TOKEN=$token; export GH_TOKEN\n" +
		"else\n" +
		"\tunset GH_TOKEN GITHUB_TOKEN\n" +
		"fi\n" +
		`exec '/usr/bin/gh' "$@"` + "\n"
	if got != want {
		t.Fatalf("wrapper =\n%s\nwant\n%s", got, want)
	}
}

// Run through sh, with paths that need quoting: the real gh gets the
// arguments as given, with the token github-token prints as $GH_TOKEN (the
// launch's own where it falls back to it), and none from the environment
// when it prints none.
func TestGhWrapperRunsTheRealGhWithTheToken(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "it's a dir")
	exe, realGh, wrapper := filepath.Join(dir, "agent"), filepath.Join(dir, "real gh"), filepath.Join(dir, "bin", "gh")
	writeScript(t, exe, `[ "$1 $2 $3 $4" = "github-token --root /r --" ] || exit 9
shift 4
[ -n "$FAIL" ] && exit 1
[ -n "$FALLBACK" ] && { echo "$GH_TOKEN"; exit 0; }
echo "fresh-for-$*"
`)
	writeScript(t, realGh, `printf '%s|' "$GH_TOKEN$GITHUB_TOKEN" "$@"`)
	if err := os.MkdirAll(filepath.Dir(wrapper), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wrapper, []byte(GhWrapper(exe, "/r", realGh)), 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(env ...string) string {
		cmd := exec.Command(wrapper, "pr", "create", "--title", "a b")
		cmd.Env = append([]string{"PATH=/usr/bin:/bin"}, env...)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("wrapper: %v", err)
		}
		return string(out)
	}
	if got := run("GH_TOKEN=gho_launch"); got != "fresh-for-pr create --title a b|pr|create|--title|a b|" {
		t.Fatalf("with a token: %q", got)
	}
	if got := run("GH_TOKEN=gho_launch", "FALLBACK=1"); got != "gho_launch|pr|create|--title|a b|" {
		t.Fatalf("falling back: %q", got)
	}
	// Refused: not the launch's token, nor one gh would find on its own.
	if got := run("GH_TOKEN=gho_launch", "GITHUB_TOKEN=gho_other", "FAIL=1"); got != "|pr|create|--title|a b|" {
		t.Fatalf("refused: %q", got)
	}
}

func TestHelperCommand(t *testing.T) {
	if got := HelperCommand("/usr/local/bin/runtime-agent", "/home/run'time"); got != `!'/usr/local/bin/runtime-agent' git-credential --root '/home/run'\''time'` {
		t.Fatalf("helper = %s", got)
	}
}

func TestFindExecutableSkipsTheWrapper(t *testing.T) {
	root := t.TempDir()
	bin, usr, empty := filepath.Join(root, "bin"), filepath.Join(root, "usr"), filepath.Join(root, "empty")
	wrapper := filepath.Join(bin, "gh")
	writeScript(t, wrapper, "")
	writeScript(t, filepath.Join(usr, "gh"), "")
	if err := os.MkdirAll(empty, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(empty, "gh"), []byte("not executable"), 0o644); err != nil {
		t.Fatal(err)
	}
	path := strings.Join([]string{"relative", bin, empty, usr}, string(os.PathListSeparator))
	if got, ok := FindExecutable("gh", path, bin, wrapper); !ok || got != filepath.Join(usr, "gh") {
		t.Fatalf("found %q, %v", got, ok)
	}

	// A link to the wrapper elsewhere on PATH isn't the real gh either.
	link := filepath.Join(root, "link")
	if err := os.MkdirAll(link, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(wrapper, filepath.Join(link, "gh")); err != nil {
		t.Fatal(err)
	}
	if got, _ := FindExecutable("gh", link+string(os.PathListSeparator)+usr, bin, wrapper); got != filepath.Join(usr, "gh") {
		t.Fatalf("found %q", got)
	}
	if _, ok := FindExecutable("gh", bin, bin, wrapper); ok {
		t.Fatal("found the wrapper")
	}
}
