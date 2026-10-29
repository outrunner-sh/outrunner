//go:build unix

package cli

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// npm's codex entry point starts the native CLI as a child. Give this login
// its own process group so cancellation also stops that child before its
// temporary credential directory is removed. Never signal the caller's group.
func configureCodexLoginProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
}
