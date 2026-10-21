package localimport

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"runtime-agent/internal/dotenv"
)

// ProjectEnv is what a repository's cloud sessions could take from this Mac:
// Conductor's variables for it, the files its checkout keeps out of git (its
// .env files), and the scripts Conductor ran around its workspaces. A scan
// gives the variables' and files' names only; their values are read by
// CaptureEnv, for those the user picks.
type ProjectEnv struct {
	// Repo is the repository, "owner/name".
	Repo string `json:"repo"`
	// Root is the checkout the files are read from.
	Root    string    `json:"root,omitempty"`
	Vars    []EnvVar  `json:"vars"`
	Files   []EnvFile `json:"files"`
	Scripts *Scripts  `json:"scripts,omitempty"`
}

// EnvVar is a variable Conductor sets.
type EnvVar struct {
	Name string `json:"name"`
	// Shared is a variable Conductor sets for every repository.
	Shared bool `json:"shared"`
}

// EnvFile is a file out of git that sets variables.
type EnvFile struct {
	// Path is where it is in the checkout.
	Path  string   `json:"path"`
	Names []string `json:"names"`
	Bytes int      `json:"bytes"`
}

// Scripts are what Conductor runs around a workspace. They are shown in full:
// the user is asked to let them run in the cloud.
type Scripts struct {
	Setup   string `json:"setup,omitempty"`
	Run     string `json:"run,omitempty"`
	Archive string `json:"archive,omitempty"`
}

// EnvCapture is the values of what the user picked of a project's environment.
type EnvCapture struct {
	Repo    string            `json:"repo"`
	Env     map[string]string `json:"env"`
	Files   map[string]string `json:"files"`
	Scripts *Scripts          `json:"scripts,omitempty"`
}

// EnvPick is what of a project's environment to capture.
type EnvPick struct {
	Vars    []string
	Files   []string
	Scripts bool
}

const (
	// maxEnvFileBytes is the largest .env file offered.
	maxEnvFileBytes = 256 << 10
	// envFileDepth is how deep in a checkout .env files are looked for.
	envFileDepth = 4
)

// skippedDirs are never searched for .env files: dependencies and builds.
var skippedDirs = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, ".venv": true, "venv": true, "dist": true,
	"build": true, ".next": true, "target": true, ".turbo": true, ".cache": true,
}

// templateSuffixes mark an .env file that is an example, not a secret.
var templateSuffixes = []string{".example", ".sample", ".template", ".dist"}

// conductorRepo is a Conductor repository's row.
type conductorRepo struct {
	ID        *string `json:"id"`
	RemoteURL *string `json:"remote_url"`
	RootPath  *string `json:"root_path"`
	Setup     *string `json:"setup_script"`
	Run       *string `json:"run_script"`
	Archive   *string `json:"archive_script"`
	Config    *string `json:"conductor_config"`
}

// conductorEnvVar is a Conductor variable; Value is read only to capture it.
type conductorEnvVar struct {
	Key     *string `json:"key"`
	Scope   *string `json:"scope"`
	Context *string `json:"context"`
	Value   *string `json:"value"`
}

// projectEnvs finds each repository's environment: from Conductor's
// repositories, and from the checkouts sessions ran in. Values are not kept.
func projectEnvs(ctx context.Context, opts Options, sessions []Session) []ProjectEnv {
	byRepo := map[string]*ProjectEnv{}
	add := func(repo, root string) *ProjectEnv {
		key := strings.ToLower(repo)
		p, ok := byRepo[key]
		if !ok {
			p = &ProjectEnv{Repo: repo, Vars: []EnvVar{}, Files: []EnvFile{}}
			byRepo[key] = p
		}
		if p.Root == "" && root != "" {
			p.Root = root
		}
		return p
	}

	repos, vars := readConductorEnv(ctx, opts.ConductorDB, false)
	for _, r := range repos {
		repo := parseGitHubRemote(str(r.RemoteURL))
		if repo == "" {
			continue
		}
		p := add(repo, str(r.RootPath))
		p.Scripts = conductorScripts(r)
		for _, v := range vars {
			if shared, ok := varApplies(v, str(r.ID)); ok {
				p.Vars = append(p.Vars, EnvVar{Name: str(v.Key), Shared: shared})
			}
		}
	}
	for _, s := range sessions {
		if s.Skip == nil && s.Repo != "" {
			add(s.Repo, s.Worktree)
		}
	}

	envs := make([]ProjectEnv, 0, len(byRepo))
	for _, p := range byRepo {
		if p.Root != "" {
			p.Files = envFiles(ctx, p.Root)
		}
		sort.Slice(p.Vars, func(i, j int) bool { return p.Vars[i].Name < p.Vars[j].Name })
		if len(p.Vars) > 0 || len(p.Files) > 0 || p.Scripts != nil {
			envs = append(envs, *p)
		}
	}
	sort.Slice(envs, func(i, j int) bool { return envs[i].Repo < envs[j].Repo })
	return envs
}

// CaptureEnv reads the values of what the user picked of a repository's
// environment, found again the way the scan found it.
func CaptureEnv(ctx context.Context, opts Options, repo string, pick EnvPick) (EnvCapture, error) {
	sessions, _ := discover(ctx, opts, "")
	var project *ProjectEnv
	for _, p := range projectEnvs(ctx, opts, sessions) {
		if strings.EqualFold(p.Repo, repo) {
			project = &p
			break
		}
	}
	if project == nil {
		return EnvCapture{}, fmt.Errorf("nothing of %s's environment is on this Mac any more", repo)
	}
	out := EnvCapture{Repo: project.Repo, Env: map[string]string{}, Files: map[string]string{}}

	if len(pick.Vars) > 0 {
		wanted := map[string]bool{}
		for _, name := range pick.Vars {
			wanted[name] = true
		}
		repos, vars := readConductorEnv(ctx, opts.ConductorDB, true)
		for _, r := range repos {
			if !strings.EqualFold(parseGitHubRemote(str(r.RemoteURL)), repo) {
				continue
			}
			for _, v := range vars {
				// A repository's own value wins over a shared one of the same name.
				if shared, ok := varApplies(v, str(r.ID)); ok && wanted[str(v.Key)] {
					if _, set := out.Env[str(v.Key)]; !set || !shared {
						out.Env[str(v.Key)] = str(v.Value)
					}
				}
			}
		}
	}
	for _, path := range pick.Files {
		if !offered(project.Files, path) {
			return EnvCapture{}, fmt.Errorf("%s is not a file the scan offered", path)
		}
		data, err := os.ReadFile(filepath.Join(project.Root, path))
		if err != nil {
			return EnvCapture{}, err
		}
		out.Files[path] = string(data)
	}
	if pick.Scripts {
		out.Scripts = project.Scripts
	}
	return out, nil
}

func offered(files []EnvFile, path string) bool {
	for _, f := range files {
		if f.Path == path {
			return true
		}
	}
	return false
}

// varApplies is whether a Conductor variable is set for the repository with
// id, and whether as a shared one.
func varApplies(v conductorEnvVar, repoID string) (shared, ok bool) {
	if str(v.Key) == "" {
		return false, false
	}
	switch str(v.Scope) {
	case "shared":
		return true, true
	case "repo", "repository":
		return false, str(v.Context) == repoID
	}
	return false, false
}

// readConductorEnv reads Conductor's repositories and variables; values only
// when asked. Anything it can't read is nothing.
func readConductorEnv(ctx context.Context, db string, values bool) ([]conductorRepo, []conductorEnvVar) {
	if db == "" || !fileExists(db) {
		return nil, nil
	}
	present, err := conductorColumns(ctx, db)
	if err != nil || !present["repos.id"] || !present["repos.remote_url"] {
		return nil, nil
	}
	col := func(table, name string) string {
		if present[table+"."+name] {
			return name
		}
		return "NULL AS " + name
	}
	var repos []conductorRepo
	query := "SELECT " + strings.Join([]string{"id", "remote_url", col("repos", "root_path"), col("repos", "setup_script"),
		col("repos", "run_script"), col("repos", "archive_script"), col("repos", "conductor_config")}, ", ") + " FROM repos"
	if sqliteJSON(ctx, db, query, &repos) != nil {
		return nil, nil
	}
	var vars []conductorEnvVar
	if present["env_vars.key"] && present["env_vars.scope"] {
		value := "NULL AS value"
		if values {
			value = col("env_vars", "value")
		}
		query := "SELECT key, scope, " + col("env_vars", "context") + ", " + value + " FROM env_vars"
		_ = sqliteJSON(ctx, db, query, &vars)
	}
	return repos, vars
}

// conductorScripts are a repository's scripts: from its conductor.json
// settings (as Conductor now keeps them), else its own columns.
func conductorScripts(r conductorRepo) *Scripts {
	var config struct {
		Scripts Scripts `json:"scripts"`
	}
	if raw := str(r.Config); raw != "" && json.Unmarshal([]byte(raw), &config) == nil && config.Scripts != (Scripts{}) {
		return &config.Scripts
	}
	if root := str(r.RootPath); root != "" {
		if data, err := os.ReadFile(filepath.Join(root, "conductor.json")); err == nil &&
			json.Unmarshal(data, &config) == nil && config.Scripts != (Scripts{}) {
			return &config.Scripts
		}
	}
	scripts := Scripts{Setup: str(r.Setup), Run: str(r.Run), Archive: str(r.Archive)}
	if scripts == (Scripts{}) {
		return nil
	}
	return &scripts
}

// envFiles are a checkout's .env files that git ignores, with the names each
// sets. Examples and templates (committed for others to copy) are not.
func envFiles(ctx context.Context, root string) []EnvFile {
	var candidates []string
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		if d.IsDir() {
			if path != root && (skippedDirs[d.Name()] || strings.Count(rel, string(filepath.Separator)) >= envFileDepth) {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if (name == ".env" || strings.HasPrefix(name, ".env.")) && !isTemplate(name) && d.Type().IsRegular() {
			candidates = append(candidates, rel)
		}
		return nil
	})
	if len(candidates) == 0 {
		return []EnvFile{}
	}
	ignored := ignoredByGit(ctx, root, candidates)
	files := []EnvFile{}
	for _, rel := range candidates {
		if !ignored[rel] {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil || len(data) > maxEnvFileBytes {
			continue
		}
		names := []string{}
		for _, entry := range dotenv.Parse(string(data)) {
			names = append(names, entry.Name)
		}
		files = append(files, EnvFile{Path: rel, Names: names, Bytes: len(data)})
	}
	return files
}

func isTemplate(name string) bool {
	for _, suffix := range templateSuffixes {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}

// ignoredByGit is which of a checkout's paths git ignores: what stays on the
// Mac when the branch moves to the cloud.
func ignoredByGit(ctx context.Context, root string, paths []string) map[string]bool {
	cmd := exec.CommandContext(ctx, "git", "-C", root, "check-ignore", "--stdin", "-z")
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	cmd.Stdin = strings.NewReader(strings.Join(paths, "\x00") + "\x00")
	out, _ := cmd.Output() // exit 1: none is ignored
	ignored := map[string]bool{}
	for _, path := range bytes.Split(out, []byte{0}) {
		if len(path) > 0 {
			ignored[string(path)] = true
		}
	}
	return ignored
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
