package workspace

import (
	"archive/tar"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

// skillHub stands in for GitHub: codeload's tarballs by path, and the API's,
// which need the token, by path too. It counts what was asked, and with
// which Authorization.
type skillHub struct {
	mu       sync.Mutex
	archives map[string][]byte
	asked    map[string]string
}

func newSkillHub(t *testing.T) *skillHub {
	t.Helper()
	hub := &skillHub{archives: map[string][]byte{}, asked: map[string]string{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hub.mu.Lock()
		hub.asked[r.URL.Path] = r.Header.Get("Authorization")
		data, ok := hub.archives[r.URL.Path]
		hub.mu.Unlock()
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Header.Get("Authorization") != "Bearer ghs_secret" {
			http.NotFound(w, r)
			return
		}
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(server.Close)
	codeload, api := skillsCodeloadBase, skillsAPIBase
	skillsCodeloadBase, skillsAPIBase = server.URL, server.URL+"/api"
	t.Cleanup(func() { skillsCodeloadBase, skillsAPIBase = codeload, api })
	return hub
}

// repoArchive is a GitHub tarball of a repository: its files under one top
// folder.
func repoArchive(t *testing.T, files map[string]string) []byte {
	t.Helper()
	entries := []tarEntry{{name: "repo-abc123/", kind: tar.TypeDir}}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		entries = append(entries, tarEntry{name: "repo-abc123/" + name, body: files[name]})
	}
	data, _ := configArchive(t, entries...)
	return data
}

func skillMD(name string) string {
	return "---\nname: " + name + "\ndescription: does " + name + "\n---\n\n# " + name + "\n"
}

// A catalog skill installs from its repository by its SKILL.md's name, for
// Claude and for Codex; a registry installs every skill it holds; the next
// set removes what the project dropped.
func TestSetSkillsInstallsForBothAgentsAndRemovesWhatWentAway(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	hub := newSkillHub(t)
	hub.archives["/anthropics/skills/tar.gz/HEAD"] = repoArchive(t, map[string]string{
		"README.md":                          "skills",
		"skills/pdf/SKILL.md":                skillMD("pdf"),
		"skills/pdf/scripts/fill.py":         "print('fill')",
		"skills/docx/SKILL.md":               skillMD("docx"),
		"skills/react-best/SKILL.md":         skillMD("vercel-react-best-practices"),
		"node_modules/dep/skills/x/SKILL.md": skillMD("x"),
	})
	hub.archives["/api/repos/acme/registry/tarball/main"] = repoArchive(t, map[string]string{
		".claude/skills/deploy/SKILL.md": skillMD("deploy"),
		"review/SKILL.md":                "no front matter, so its folder's name",
	})
	s := NewService(t.TempDir())
	ctx := context.Background()

	result, err := s.SetSkills(ctx, []SkillSource{
		{Repo: "anthropics/skills", Skills: []string{"pdf", "vercel-react-best-practices"}},
		{Repo: "acme/registry", Ref: "main", Token: "ghs_secret"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"deploy", "pdf", "review", "vercel-react-best-practices"}; !slices.Equal(result.Installed, want) || len(result.Failed) > 0 {
		t.Fatalf("installed %q, failed %+v; want %q", result.Installed, result.Failed, want)
	}
	for _, dir := range []string{".claude/skills", ".agents/skills"} {
		if got := readFile(filepath.Join(home, dir, "pdf", "scripts", "fill.py")); got != "print('fill')" {
			t.Errorf("%s/pdf's script = %q", dir, got)
		}
		if !fileExists(filepath.Join(home, dir, "vercel-react-best-practices", "SKILL.md")) {
			t.Errorf("%s lacks the skill named apart from its folder", dir)
		}
		if fileExists(filepath.Join(home, dir, "docx")) || fileExists(filepath.Join(home, dir, "x")) {
			t.Errorf("%s has a skill that wasn't asked for", dir)
		}
	}
	if hub.asked["/anthropics/skills/tar.gz/HEAD"] != "" {
		t.Error("a public repository was downloaded with a token")
	}

	if _, err := s.SetSkills(ctx, []SkillSource{{Repo: "anthropics/skills", Skills: []string{"docx"}}}); err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{"pdf", "deploy", "review"} {
		if anyExists(skillDirs(home, gone)) {
			t.Errorf("%s, which the project dropped, is still installed", gone)
		}
	}
	if !fileExists(filepath.Join(home, ".agents", "skills", "docx", "SKILL.md")) {
		t.Error("docx wasn't installed")
	}
}

// The user's own skill wins over a project's of the same name, and is never
// removed; nor is one something else put on the computer.
func TestSetSkillsLeavesTheUsersOwnAlone(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	hub := newSkillHub(t)
	hub.archives["/acme/skills/tar.gz/HEAD"] = repoArchive(t, map[string]string{
		"review/SKILL.md": skillMD("review"),
		"boxed/SKILL.md":  skillMD("boxed"),
		"lint/SKILL.md":   skillMD("lint"),
	})
	writeTestFile(t, filepath.Join(home, ".claude", "skills", "review", "SKILL.md"), "mine")
	if err := writeJSONFile(agentConfigStatePath(home), agentConfigState{Version: "v", Items: []string{".claude/skills/review"}}, 0o600); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(home, ".agents", "skills", "boxed", "SKILL.md"), "the image's")
	s := NewService(t.TempDir())

	result, err := s.SetSkills(context.Background(), []SkillSource{{Repo: "acme/skills"}})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(result.Installed, []string{"lint"}) || len(result.Failed) != 2 {
		t.Fatalf("installed %q, failed %+v", result.Installed, result.Failed)
	}
	if readFile(filepath.Join(home, ".claude", "skills", "review", "SKILL.md")) != "mine" {
		t.Error("the user's skill was replaced")
	}
	if _, err := s.SetSkills(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if readFile(filepath.Join(home, ".claude", "skills", "review", "SKILL.md")) != "mine" ||
		readFile(filepath.Join(home, ".agents", "skills", "boxed", "SKILL.md")) != "the image's" {
		t.Error("removing the project's skills took what wasn't the project's")
	}
	if anyExists(skillDirs(home, "lint")) {
		t.Error("the project's skill wasn't removed")
	}
}

// A repository that can't be read is said, and keeps what it installed last
// time; a skill not in its repository is said too.
func TestSetSkillsKeepsAFailedRepositorysSkills(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	hub := newSkillHub(t)
	hub.archives["/acme/skills/tar.gz/HEAD"] = repoArchive(t, map[string]string{"lint/SKILL.md": skillMD("lint")})
	s := NewService(t.TempDir())
	ctx := context.Background()
	if _, err := s.SetSkills(ctx, []SkillSource{{Repo: "acme/skills"}}); err != nil {
		t.Fatal(err)
	}

	delete(hub.archives, "/acme/skills/tar.gz/HEAD")
	hub.archives["/acme/other/tar.gz/HEAD"] = repoArchive(t, map[string]string{"fmt/SKILL.md": skillMD("fmt")})
	result, err := s.SetSkills(ctx, []SkillSource{{Repo: "acme/skills"}, {Repo: "acme/other", Skills: []string{"fmt", "missing"}}})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(result.Installed, []string{"fmt"}) || len(result.Failed) != 2 {
		t.Fatalf("installed %q, failed %+v", result.Installed, result.Failed)
	}
	if result.Failed[0].Repo != "acme/skills" || result.Failed[1].Skill != "missing" {
		t.Errorf("failures = %+v", result.Failed)
	}
	if !fileExists(filepath.Join(home, ".claude", "skills", "lint", "SKILL.md")) {
		t.Error("the skill of a repository that couldn't be read was removed")
	}
}

// What isn't a GitHub repository, a branch or a skill's name is refused
// before anything is downloaded; a download holding a path out of the
// repository installs nothing.
func TestSetSkillsRefusesWhatIsNotASkillSource(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	hub := newSkillHub(t)
	s := NewService(t.TempDir())
	for name, source := range map[string]SkillSource{
		"a path":          {Repo: "../etc/passwd"},
		"a URL":           {Repo: "https://github.com/acme/skills"},
		"a ref out":       {Repo: "acme/skills", Ref: "../../x"},
		"a name with a /": {Repo: "acme/skills", Skills: []string{"a/b"}},
	} {
		if _, err := s.SetSkills(context.Background(), []SkillSource{source}); !errors.Is(err, ErrInvalidSkills) {
			t.Errorf("%s: %v", name, err)
		}
	}

	evil, _ := configArchive(t, tarEntry{name: "repo-abc/../../escape/SKILL.md", body: skillMD("escape")})
	hub.archives["/acme/evil/tar.gz/HEAD"] = evil
	result, err := s.SetSkills(context.Background(), []SkillSource{{Repo: "acme/evil"}})
	if err != nil || len(result.Installed) != 0 || len(result.Failed) != 1 {
		t.Fatalf("installed %q, failed %+v, %v", result.Installed, result.Failed, err)
	}
	if fileExists(filepath.Join(home, "escape")) || anyExists(skillDirs(home, "escape")) {
		t.Error("a path out of the repository was unpacked")
	}
}

// A skill that can't be installed for both agents (Codex's folder isn't one
// here) is said like any other, the rest go on, and the state is written:
// nothing installed goes unrecorded, and the next set installs it.
func TestSetSkillsRecordsWhatItInstalledWhenOneFails(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	hub := newSkillHub(t)
	hub.archives["/acme/skills/tar.gz/HEAD"] = repoArchive(t, map[string]string{"lint/SKILL.md": skillMD("lint")})
	hub.archives["/acme/more/tar.gz/HEAD"] = repoArchive(t, map[string]string{"fmt/SKILL.md": skillMD("fmt")})
	writeTestFile(t, filepath.Join(home, ".agents", "skills"), "not a folder")
	s := NewService(t.TempDir())
	ctx := context.Background()

	result, err := s.SetSkills(ctx, []SkillSource{{Repo: "acme/skills"}, {Repo: "acme/more"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Installed) != 0 || len(result.Failed) != 2 {
		t.Fatalf("installed %q, failed %+v", result.Installed, result.Failed)
	}
	if fileExists(filepath.Join(home, ".claude", "skills", "lint")) {
		t.Error("half an install (Claude's copy alone) was left behind")
	}
	if !fileExists(skillsStatePath(home)) {
		t.Fatal("the state wasn't written")
	}

	if err := os.Remove(filepath.Join(home, ".agents", "skills")); err != nil {
		t.Fatal(err)
	}
	result, err = s.SetSkills(ctx, []SkillSource{{Repo: "acme/skills"}, {Repo: "acme/more"}})
	if err != nil || !slices.Equal(result.Installed, []string{"fmt", "lint"}) || len(result.Failed) > 0 {
		t.Fatalf("installed %q, failed %+v, %v", result.Installed, result.Failed, err)
	}
}

// When the user's own import takes over a name the project installed, the
// project's copy for Codex goes too, and the state no longer has it.
func TestSetSkillsGivesUpANameTheUserTakesOver(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	hub := newSkillHub(t)
	hub.archives["/acme/skills/tar.gz/HEAD"] = repoArchive(t, map[string]string{"review/SKILL.md": skillMD("review")})
	s := NewService(t.TempDir())
	ctx := context.Background()
	if _, err := s.SetSkills(ctx, []SkillSource{{Repo: "acme/skills"}}); err != nil {
		t.Fatal(err)
	}

	writeTestFile(t, filepath.Join(home, ".claude", "skills", "review", "SKILL.md"), "mine")
	if err := writeJSONFile(agentConfigStatePath(home), agentConfigState{Version: "v", Items: []string{".claude/skills/review"}}, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetSkills(ctx, []SkillSource{{Repo: "acme/skills"}}); err != nil {
		t.Fatal(err)
	}
	if fileExists(filepath.Join(home, ".agents", "skills", "review")) {
		t.Error("the project's copy for Codex outlived the user's taking the name")
	}
	if readFile(filepath.Join(home, ".claude", "skills", "review", "SKILL.md")) != "mine" {
		t.Error("the user's skill was touched")
	}
	if _, owned := readSkillsState(home).Skills["review"]; owned {
		t.Error("the state still has the user's skill as the project's")
	}
}

// A repository that is a skill and holds others installs the others alone,
// not its root as well (which would copy them all twice).
func TestSetSkillsTakesARootSkillWithOthersForACollection(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	hub := newSkillHub(t)
	hub.archives["/acme/skills/tar.gz/HEAD"] = repoArchive(t, map[string]string{
		"SKILL.md":             skillMD("collection"),
		"skills/lint/SKILL.md": skillMD("lint"),
	})
	hub.archives["/acme/one/tar.gz/HEAD"] = repoArchive(t, map[string]string{"SKILL.md": skillMD("one"), "notes.md": "x"})
	s := NewService(t.TempDir())
	result, err := s.SetSkills(context.Background(), []SkillSource{{Repo: "acme/skills"}, {Repo: "acme/one"}})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(result.Installed, []string{"lint", "one"}) {
		t.Fatalf("installed %q, failed %+v", result.Installed, result.Failed)
	}
}

// The name a skill installs as is its front matter's top-level `name:`, the
// last where there are several; a nested one is its parent's. The same case
// is in test/environment-skills.test.ts, so the page and the box agree.
func TestSkillManifestNameIsTheTopLevelLastOne(t *testing.T) {
	dir := t.TempDir()
	for text, want := range map[string]string{
		"---\nname: first\nmetadata:\n  name: nested\nname: \"last\"\n---\nname: body\n": "last",
		"---\ndescription: x\nmetadata:\n  name: nested\n---\n":                          "",
		"# no front matter\nname: x\n":                                                   "",
		"---\r\nname: 'crlf'\r\n---\r\n":                                                 "crlf",
	} {
		path := filepath.Join(dir, "SKILL.md")
		writeTestFile(t, path, text)
		if got := skillManifestName(path); got != want {
			t.Errorf("%q: name = %q, want %q", text, got, want)
		}
	}
}
