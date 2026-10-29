package cli

import (
	"os/exec"
	"strconv"
)

// The npm entry point can own a native child on Windows too. taskkill is an
// OS utility; /T includes that process tree. No credentials go on its argv.
func configureCodexLoginProcess(cmd *exec.Cmd) {
	cmd.Cancel = func() error {
		if err := exec.Command("taskkill.exe", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run(); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
}
