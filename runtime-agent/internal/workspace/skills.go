package workspace

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// A project's skills: folders holding a SKILL.md, from GitHub repositories
// the project names (a skill picked from the skills.sh catalog, or every
// skill of a repository kept as the project's registry). The computer
// downloads each repository as it is now, finds its skills, and installs
// them where both agents look for a user's own: ~/.claude/skills for Claude
// Code and ~/.agents/skills for Codex. Like the user's own setup
// (agentconfig.go) they are the computer's, which is one session's.
//
// The user's own wins: a skill their import installed is never replaced or
// removed, whatever its name. What a project installed is kept in
// ~/.claude/.outrunner-skills.json, so the next set removes the skills the
// project no longer has, and leaves alone what anything else put there.

// ErrInvalidSkills is a set of skills the computer can't take.
var ErrInvalidSkills = errors.New("invalid skills")

// SkillSource is a GitHub repository skills install from.
type SkillSource struct {
	// Repo is owner/name on GitHub.
	Repo string
	// Ref is the branch to read; empty is the repository's default.
	Ref string
	// Token reads a private repository; empty downloads it unauthenticated.
	Token string
	// Skills are the names to install from it (a SKILL.md's name, or its
	// folder's); none installs every skill it holds.
	Skills []string
}

// SkillFailure is a repository, or one skill of it, that wasn't installed.
type SkillFailure struct {
	Repo  string `json:"repo"`
	Skill string `json:"skill,omitempty"`
	Error string `json:"error"`
}

// SkillsResult is what a set installed, by name, and what it couldn't.
type SkillsResult struct {
	Installed []string       `json:"installed"`
	Failed    []SkillFailure `json:"failed,omitempty"`
}

// skillsState is what the project installed, by name, with the repository
// each came from.
type skillsState struct {
	Skills map[string]string `json:"skills"`
}

const (
	// maxSkillSources bounds the repositories a set downloads.
	maxSkillSources = 50
	// maxSkillArchiveBytes bounds a repository's download, and
	// maxSkillUnpackedBytes what it unpacks to (only its files are kept).
	maxSkillArchiveBytes  = 64 << 20
	maxSkillUnpackedBytes = 256 << 20
	// skillDownloadTimeout bounds one repository's download.
	skillDownloadTimeout = 90 * time.Second
	// maxSkillDepth bounds how deep in a repository a skill is looked for.
	maxSkillDepth = 6
)

// Where repositories download from: GitHub's, or a test's.
var (
	skillsCodeloadBase = "https://codeload.github.com"
	skillsAPIBase      = "https://api.github.com"
)

var (
	skillRepo = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$`)
	skillRef  = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,255}$`)
	// skillName is a folder a skill installs as: Claude's rule for a skill's
	// name, with capitals and dots allowed for what repositories hold.
	skillName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
)

func skillsStatePath(home string) string {
	return filepath.Join(home, ".claude", ".outrunner-skills.json")
}

// skillDirs are where an installed skill goes: Claude's and Codex's.
func skillDirs(home, name string) []string {
	return []string{filepath.Join(home, ".claude", "skills", name), filepath.Join(home, ".agents", "skills", name)}
}

// ValidSkillSources checks a set before anything is downloaded.
func ValidSkillSources(sources []SkillSource) error {
	if len(sources) > maxSkillSources {
		return fmt.Errorf("%w: at most %d repositories", ErrInvalidSkills, maxSkillSources)
	}
	for _, source := range sources {
		if !skillRepo.MatchString(source.Repo) || strings.Contains(source.Repo, "..") {
			return fmt.Errorf("%w: %q is not a GitHub repository", ErrInvalidSkills, source.Repo)
		}
		if source.Ref != "" && (!skillRef.MatchString(source.Ref) || strings.Contains(source.Ref, "..")) {
			return fmt.Errorf("%w: %q is not a branch", ErrInvalidSkills, source.Ref)
		}
		for _, name := range source.Skills {
			if !skillName.MatchString(name) {
				return fmt.Errorf("%w: %q is not a skill's name", ErrInvalidSkills, name)
			}
		}
	}
	return nil
}

// SetSkills installs a project's skills on this computer, in place of the
// ones it installed before. A repository that can't be downloaded keeps
// what it installed last time, and is said in the result rather than
// failing the rest: a session starts without a skill, not without its
// project's others.
func (s *Service) SetSkills(ctx context.Context, sources []SkillSource) (SkillsResult, error) {
	if err := ValidSkillSources(sources); err != nil {
		return SkillsResult{}, err
	}
	home, err := agentConfigHome()
	if err != nil {
		return SkillsResult{}, err
	}
	staging, err := os.MkdirTemp(home, ".outrunner-skills-")
	if err != nil {
		return SkillsResult{}, err
	}
	defer os.RemoveAll(staging)

	// Downloaded side by side: a project of several repositories waits for
	// the slowest, not their sum.
	unpacked := make([]string, len(sources))
	errs := make([]error, len(sources))
	var wg sync.WaitGroup
	for i, source := range sources {
		wg.Add(1)
		go func() {
			defer wg.Done()
			dst := filepath.Join(staging, fmt.Sprint(i))
			errs[i] = downloadSkillRepo(ctx, source, dst)
			unpacked[i] = dst
		}()
	}
	wg.Wait()

	agentConfigMu.Lock()
	defer agentConfigMu.Unlock()

	previous := readSkillsState(home)
	users := userSkills(home)
	result := SkillsResult{Installed: []string{}}
	next := skillsState{Skills: map[string]string{}}
	failedRepos := map[string]bool{}
	for i, source := range sources {
		if errs[i] != nil {
			failedRepos[source.Repo] = true
			result.Failed = append(result.Failed, SkillFailure{Repo: source.Repo, Error: errs[i].Error()})
			continue
		}
		found := findSkills(unpacked[i])
		wanted := map[string]bool{}
		for _, name := range source.Skills {
			wanted[name] = true
		}
		matched := map[string]bool{}
		for _, skill := range found {
			if len(wanted) > 0 {
				if !wanted[skill.name] && !wanted[skill.folder] {
					continue
				}
				matched[skill.name], matched[skill.folder] = true, true
			}
			fail := func(why string) {
				result.Failed = append(result.Failed, SkillFailure{Repo: source.Repo, Skill: skill.name, Error: why})
			}
			switch _, owned := previous.Skills[skill.name]; {
			case users[skill.name]:
				fail("a skill of yours has this name: yours is kept")
				continue
			case next.Skills[skill.name] != "":
				fail("another of the project's skills has this name")
				continue
			case !owned && anyExists(skillDirs(home, skill.name)):
				fail("a skill by this name is on the computer already")
				continue
			}
			if err := installSkill(home, skill.dir, skill.name); err != nil {
				// Said like any other skill not installed, and the rest go on:
				// the state is written whatever happens, so nothing installed
				// goes unrecorded. What a half-done install left (Claude's
				// copy, not Codex's) is taken away; what can't be is kept in
				// the state, for the next set to replace or remove.
				fail(err.Error())
				for _, dir := range skillDirs(home, skill.name) {
					_ = os.RemoveAll(dir)
				}
				if anyExists(skillDirs(home, skill.name)) {
					next.Skills[skill.name] = source.Repo
				}
				continue
			}
			next.Skills[skill.name] = source.Repo
			result.Installed = append(result.Installed, skill.name)
		}
		for _, name := range source.Skills {
			if !matched[name] {
				result.Failed = append(result.Failed, SkillFailure{Repo: source.Repo, Skill: name, Error: "no skill by this name in the repository"})
			}
		}
	}

	// What the project no longer has goes; what a repository that failed
	// just now installed before stays, until it can be read again.
	for name, repo := range previous.Skills {
		if next.Skills[name] != "" {
			continue
		}
		if users[name] {
			// The user's own took the name over: theirs is in ~/.claude, and
			// the project's copy for Codex goes, untracked from now on.
			_ = os.RemoveAll(skillDirs(home, name)[1])
			continue
		}
		if failedRepos[repo] {
			next.Skills[name] = repo
			continue
		}
		for _, dir := range skillDirs(home, name) {
			_ = os.RemoveAll(dir)
		}
	}
	sort.Strings(result.Installed)
	return result, writeJSONFile(skillsStatePath(home), next, 0o600)
}

// userSkills are the skills the user's own setup installed: theirs, which a
// project's never replaces.
func userSkills(home string) map[string]bool {
	names := map[string]bool{}
	for _, item := range readAgentConfigState(home).Items {
		if name, ok := strings.CutPrefix(item, ".claude/skills/"); ok && name != "" {
			names[name] = true
		}
	}
	return names
}

func readSkillsState(home string) skillsState {
	state := skillsState{Skills: map[string]string{}}
	if data, err := os.ReadFile(skillsStatePath(home)); err == nil {
		_ = json.Unmarshal(data, &state)
	}
	if state.Skills == nil {
		state.Skills = map[string]string{}
	}
	return state
}

func anyExists(paths []string) bool {
	for _, p := range paths {
		if _, err := os.Lstat(p); err == nil {
			return true
		}
	}
	return false
}

// installSkill puts a skill's folder in place for each agent, over the one
// the project installed before.
func installSkill(home, src, name string) error {
	for _, dst := range skillDirs(home, name) {
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		tmp := dst + ".outrunner-new"
		_ = os.RemoveAll(tmp)
		if err := copyTree(src, tmp); err != nil {
			_ = os.RemoveAll(tmp)
			return err
		}
		if err := os.RemoveAll(dst); err != nil {
			return err
		}
		if err := os.Rename(tmp, dst); err != nil {
			return err
		}
	}
	return nil
}

// copyTree copies a folder of folders and regular files (all an unpacked
// repository holds).
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, info.Mode().Perm())
	})
}

// skillArchiveURL is where a repository's tarball downloads from: GitHub's
// API with a token (it sends the download on to codeload with one of its
// own), codeload itself without one, which counts against no API limit.
func skillArchiveURL(source SkillSource) string {
	owner, name, _ := strings.Cut(source.Repo, "/")
	if source.Token != "" {
		u := skillsAPIBase + "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name) + "/tarball"
		if source.Ref != "" {
			u += "/" + source.Ref
		}
		return u
	}
	ref := source.Ref
	if ref == "" {
		ref = "HEAD"
	}
	return skillsCodeloadBase + "/" + url.PathEscape(owner) + "/" + url.PathEscape(name) + "/tar.gz/" + ref
}

// downloadSkillRepo downloads a repository and unpacks its files into dst.
func downloadSkillRepo(ctx context.Context, source SkillSource, dst string) error {
	ctx, cancel := context.WithTimeout(ctx, skillDownloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, skillArchiveURL(source), nil)
	if err != nil {
		return err
	}
	if source.Token != "" {
		// Dropped by the client on the redirect to another host: the
		// download's URL carries its own.
		req.Header.Set("Authorization", "Bearer "+source.Token)
		req.Header.Set("Accept", "application/vnd.github+json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// The URL alone: never the token, which isn't in it.
		return fmt.Errorf("couldn't download %s", source.Repo)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusNotFound {
			return fmt.Errorf("%s isn't on GitHub, or this computer can't read it", source.Repo)
		}
		return fmt.Errorf("download %s: status %d", source.Repo, resp.StatusCode)
	}
	return unpackSkillRepo(io.LimitReader(resp.Body, maxSkillArchiveBytes+1), dst)
}

// unpackSkillRepo unpacks a GitHub tarball's folders and regular files,
// without the top folder GitHub puts them in. Links and anything else are
// left out: a skill is text and scripts.
func unpackSkillRepo(r io.Reader, dst string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidSkills, err)
	}
	tr := tar.NewReader(gz)
	var total int64
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			if errors.Is(err, io.ErrUnexpectedEOF) {
				return fmt.Errorf("%w: the download is too large or cut short", ErrInvalidSkills)
			}
			return fmt.Errorf("%w: %v", ErrInvalidSkills, err)
		}
		_, rel, _ := strings.Cut(strings.TrimSuffix(header.Name, "/"), "/")
		if rel == "" {
			continue // the top folder, or GitHub's pax header
		}
		if path.Clean(rel) != rel || path.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, "../") {
			return fmt.Errorf("%w: %q is outside the repository", ErrInvalidSkills, header.Name)
		}
		target := filepath.Join(dst, filepath.FromSlash(rel))
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			total += header.Size
			if total > maxSkillUnpackedBytes {
				return fmt.Errorf("%w: the repository unpacks too large", ErrInvalidSkills)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			mode := os.FileMode(0o644)
			if header.Mode&0o111 != 0 {
				mode = 0o755 // a skill's script
			}
			file, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
			if err != nil {
				return err
			}
			_, err = io.CopyN(file, tr, header.Size)
			if cerr := file.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
			}
		}
	}
}

// foundSkill is a skill in an unpacked repository: its folder, the folder's
// name, and the name it installs as.
type foundSkill struct {
	dir, folder, name string
}

// findSkills finds the skills in an unpacked repository: each folder that
// holds a SKILL.md, in path order (a skill's own folders aren't looked in).
// It installs as its SKILL.md's name, or its folder's when that has none
// fit to be a folder's.
func findSkills(root string) []foundSkill {
	var found []foundSkill
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		if rel != "." && (skippedDirs[d.Name()] || strings.Count(rel, string(filepath.Separator)) >= maxSkillDepth) {
			return filepath.SkipDir
		}
		manifest := filepath.Join(p, "SKILL.md")
		if info, err := os.Stat(manifest); err != nil || !info.Mode().IsRegular() {
			return nil
		}
		folder := d.Name()
		if rel == "." {
			folder = ""
		}
		name := skillManifestName(manifest)
		if !skillName.MatchString(name) {
			name = folder
		}
		if skillName.MatchString(name) {
			found = append(found, foundSkill{dir: p, folder: folder, name: name})
		}
		if rel == "." {
			return nil // a repository that is one skill may hold others too
		}
		return filepath.SkipDir
	})
	// A repository that is a skill and holds others is taken for a
	// collection of them: installing its root too would copy every one of
	// them twice.
	if len(found) > 1 && found[0].folder == "" {
		found = found[1:]
	}
	return found
}

// skillManifestName is the `name:` of a SKILL.md's front matter, or "": a
// top-level key only (a nested `name:` under another key is that key's),
// the last one where it has several, as lib/environments/skills.ts reads it
// for the page.
func skillManifestName(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	scanner := bufio.NewScanner(io.LimitReader(file, 64<<10))
	name := ""
	for i := 0; scanner.Scan(); i++ {
		line := scanner.Text()
		if strings.TrimSpace(line) == "---" {
			if i == 0 {
				continue
			}
			return name
		}
		if i == 0 {
			return ""
		}
		if value, ok := strings.CutPrefix(line, "name:"); ok {
			name = unquote(strings.TrimSpace(value))
		}
	}
	return name
}

// unquote takes the quotes off a YAML scalar quoted whole.
func unquote(value string) string {
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
		return value[1 : len(value)-1]
	}
	return value
}
