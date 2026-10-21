package localimport

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// A repository's environment is offered by name only; its values are read
// for what the user picks, and only from what the scan offered.
func TestEnvironmentIsOfferedByNameAndCapturedAsPicked(t *testing.T) {
	home, opts := testHome(t)
	root := filepath.Join(home, "conductor", "repos", "app")
	if err := os.MkdirAll(filepath.Dir(root), 0o755); err != nil {
		t.Fatal(err)
	}
	repoWithOrigin(t, root)
	writeFile(t, filepath.Join(root, ".gitignore"), ".env\n.env.local\nnode_modules\n")
	writeFile(t, filepath.Join(root, ".env.example"), "API_KEY=\n")
	gitIn(t, root, "add", "-A")
	gitIn(t, root, "commit", "-q", "-m", "ignore env")
	writeFile(t, filepath.Join(root, "api", ".env"), "DATABASE_URL=postgres://secret-db-password@db/app\n")
	writeFile(t, filepath.Join(root, ".env.local"), "STRIPE_KEY=sk_live_secret_stripe\n")
	writeFile(t, filepath.Join(root, "node_modules", "dep", ".env"), "NOPE=1\n")

	if err := os.MkdirAll(filepath.Dir(opts.ConductorDB), 0o755); err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(map[string]any{"scripts": map[string]string{"setup": "pnpm install\nln -sf $CONDUCTOR_ROOT_PATH/api/.env api/.env"}})
	sqliteExec(t, opts.ConductorDB, readTestdata(t, "conductor-current.sql")+fmt.Sprintf(`
		CREATE TABLE env_vars (key TEXT, scope TEXT, context TEXT, value TEXT);
		INSERT INTO repos (id, name, root_path, remote_url, conductor_config)
			VALUES ('r1', 'app', '%s', 'git@github.com:ada/app.git', '%s');
		INSERT INTO env_vars VALUES ('OPENAI_API_KEY', 'shared', 'local', 'sk-shared-openai-secret');
		INSERT INTO env_vars VALUES ('APP_TOKEN', 'repo', 'r1', 'repo-scoped-token-secret');
		INSERT INTO env_vars VALUES ('OTHER_TOKEN', 'repo', 'r2', 'another-repos-secret');
	`, root, config))

	scan := Run(context.Background(), opts)
	data, _ := json.Marshal(scan)
	for _, secret := range []string{"secret-db-password", "sk_live_secret_stripe", "sk-shared-openai-secret", "repo-scoped-token-secret"} {
		if strings.Contains(string(data), secret) {
			t.Errorf("the scan carries a value: %s", secret)
		}
	}
	if len(scan.Projects) != 1 {
		t.Fatalf("projects = %+v, want ada/app's", scan.Projects)
	}
	p := scan.Projects[0]
	want := ProjectEnv{
		Repo: "ada/app",
		Root: root,
		Vars: []EnvVar{{Name: "APP_TOKEN"}, {Name: "OPENAI_API_KEY", Shared: true}},
		Files: []EnvFile{
			{Path: ".env.local", Names: []string{"STRIPE_KEY"}, Bytes: 33},
			{Path: filepath.Join("api", ".env"), Names: []string{"DATABASE_URL"}, Bytes: 50},
		},
		Scripts: &Scripts{Setup: "pnpm install\nln -sf $CONDUCTOR_ROOT_PATH/api/.env api/.env"},
	}
	if !reflect.DeepEqual(p, want) {
		t.Errorf("project =\n%+v\nwant\n%+v", p, want)
	}

	got, err := CaptureEnv(context.Background(), opts, "ada/app", EnvPick{Vars: []string{"APP_TOKEN"}, Files: []string{"api/.env"}, Scripts: true})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Env, map[string]string{"APP_TOKEN": "repo-scoped-token-secret"}) ||
		!reflect.DeepEqual(got.Files, map[string]string{"api/.env": "DATABASE_URL=postgres://secret-db-password@db/app\n"}) ||
		got.Scripts == nil {
		t.Errorf("captured %+v", got)
	}
	for _, path := range []string{"../../.ssh/id_rsa", ".env.example", "node_modules/dep/.env"} {
		if _, err := CaptureEnv(context.Background(), opts, "ada/app", EnvPick{Files: []string{path}}); err == nil {
			t.Errorf("captured %s, which the scan didn't offer", path)
		}
	}
}
