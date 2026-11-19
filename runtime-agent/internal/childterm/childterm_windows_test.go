//go:build windows

package childterm

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeProgram is a .cmd, as npm installs `claude`: it runs under cmd.exe,
// and `wait` leaves ping running under that.
func fakeProgram(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "fake.cmd")
	script := strings.Join([]string{
		`@echo off`,
		`if "%1"=="print" goto print`,
		`if "%1"=="echo" goto echo`,
		`if "%1"=="wait" goto wait`,
		`exit /b 64`,
		`:print`,
		`echo hello %CHILDTERM_TEST%`,
		`exit /b 0`,
		`:echo`,
		`set /p line=type ^> `,
		`echo got %line%`,
		`exit /b 0`,
		`:wait`,
		`ping -n 60 127.0.0.1 >nul`,
		`exit /b 0`,
		``,
	}, "\r\n")
	if err := os.WriteFile(path, []byte(script), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestWindowsCommandLine(t *testing.T) {
	for _, c := range []struct{ binary, want string }{
		{`C:\Users\me\.local\bin\claude.exe`, `C:\Users\me\.local\bin\claude.exe setup-token`},
		{`C:\Users\A B\AppData\Roaming\npm\claude.cmd`, ` /d /s /c ""C:\Users\A B\AppData\Roaming\npm\claude.cmd" setup-token"`},
	} {
		if got := windowsCommandLine(c.binary, []string{"setup-token"}); !strings.HasSuffix(got, c.want) {
			t.Errorf("%s: got %s, want …%s", c.binary, got, c.want)
		}
	}
}
