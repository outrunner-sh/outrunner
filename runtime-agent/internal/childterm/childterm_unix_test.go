//go:build !windows

package childterm

import (
	"os"
	"path/filepath"
	"testing"
)

func fakeProgram(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "fake")
	script := `#!/bin/sh
case "$1" in
print) echo "hello $CHILDTERM_TEST" ;;
echo) printf 'type > '; read line; echo "got $line" ;;
wait) sleep 60 ;;
*) exit 64 ;;
esac
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}
