package gitcred

import "testing"

func TestNormalizeRepo(t *testing.T) {
	cases := map[string]string{
		"":                  "",
		"acme/widgets":      "acme/widgets",
		"/Acme/widgets.git": "Acme/widgets",
		" acme/my.repo_1 ":  "acme/my.repo_1",
	}
	for in, want := range cases {
		if got, err := NormalizeRepo(in); err != nil || got != want {
			t.Errorf("NormalizeRepo(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"acme", "acme/widgets/extra", "acme/../x", "a b/c", "acme/wid;gets", "../etc", "acme/.", "./x"} {
		if _, err := NormalizeRepo(bad); err == nil {
			t.Errorf("NormalizeRepo(%q) accepted", bad)
		}
	}
}

func TestRepoFromRemote(t *testing.T) {
	cases := map[string]string{
		"https://github.com/acme/widgets":                     "acme/widgets",
		"https://github.com/acme/widgets.git":                 "acme/widgets",
		"https://x-access-token:tok@github.com/acme/widgets/": "acme/widgets",
		"git@github.com:acme/widgets.git":                     "acme/widgets",
		"git@github.com:acme/widgets":                         "acme/widgets",
		"ssh://git@github.com/acme/widgets.git":               "acme/widgets",
		"ssh://git@github.com:22/acme/widgets.git":            "acme/widgets",
		"https://GitHub.com/Acme/Widgets.git\n":               "Acme/Widgets",
		"https://github.com/acme/widgets/pull/12":             "acme/widgets",
	}
	for in, want := range cases {
		if got, ok := RepoFromRemote(in); !ok || got != want {
			t.Errorf("RepoFromRemote(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, other := range []string{"", "https://gitlab.com/acme/widgets.git", "git@example.com:acme/widgets", "/srv/git/widgets.git", "https://github.com/acme", "file:///tmp/x"} {
		if got, ok := RepoFromRemote(other); ok {
			t.Errorf("RepoFromRemote(%q) = %q", other, got)
		}
	}
}

func TestRepoFromGhArgs(t *testing.T) {
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"pr", "create", "-R", "acme/widgets", "--fill"}, "acme/widgets"},
		{[]string{"pr", "list", "--repo", "acme/widgets"}, "acme/widgets"},
		{[]string{"pr", "list", "--repo=acme/widgets"}, "acme/widgets"},
		{[]string{"pr", "list", "-Racme/widgets"}, "acme/widgets"},
		{[]string{"issue", "view", "1", "-R", "github.com/acme/widgets"}, "acme/widgets"},
		{[]string{"issue", "view", "1", "-R", "https://github.com/acme/widgets.git"}, "acme/widgets"},
	}
	for _, c := range cases {
		if got, ok := RepoFromGhArgs(c.args); !ok || got != c.want {
			t.Errorf("RepoFromGhArgs(%q) = %q, %v; want %q", c.args, got, ok, c.want)
		}
	}
	for _, args := range [][]string{
		{"pr", "create", "--fill"},
		{"pr", "list", "-R"},
		{"pr", "list", "-R", "ghe.example.com/acme/widgets"},
		{"api", "--", "-R", "acme/widgets"},
	} {
		if got, ok := RepoFromGhArgs(args); ok {
			t.Errorf("RepoFromGhArgs(%q) = %q", args, got)
		}
	}
}

// gh's own order: -R, then $GH_REPO, then the working directory's origin,
// which isn't asked for when it isn't needed.
func TestDetectRepo(t *testing.T) {
	asked := false
	origin := func() string { asked = true; return "git@github.com:acme/origin.git" }
	if got := DetectRepo([]string{"pr", "view", "-R", "acme/flag"}, "acme/env", origin); got != "acme/flag" || asked {
		t.Fatalf("with -R: %q (origin asked: %v)", got, asked)
	}
	if got := DetectRepo([]string{"pr", "view"}, "acme/env", origin); got != "acme/env" || asked {
		t.Fatalf("with GH_REPO: %q (origin asked: %v)", got, asked)
	}
	if got := DetectRepo([]string{"pr", "view"}, "", origin); got != "acme/origin" {
		t.Fatalf("from origin: %q", got)
	}
	if got := DetectRepo(nil, "", func() string { return "" }); got != "" {
		t.Fatalf("with nothing: %q", got)
	}
	if got := DetectRepo(nil, "", func() string { return "https://gitlab.com/acme/x" }); got != "" {
		t.Fatalf("with another host's origin: %q", got)
	}
}
