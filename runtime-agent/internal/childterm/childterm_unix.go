//go:build !windows

package childterm

import (
	"errors"
	"os"
	"os/exec"

	"github.com/creack/pty"
)

type unixTerminal struct {
	*os.File
	cmd *exec.Cmd
}

// Start runs binary with args, in dir with env, on a PTY.
func Start(binary string, args []string, dir string, env []string) (Terminal, error) {
	cmd := exec.Command(binary, args...)
	cmd.Dir = dir
	cmd.Env = env
	file, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
	if errors.Is(err, pty.ErrUnsupported) {
		return nil, ErrUnsupported
	}
	if err != nil {
		return nil, err
	}
	return &unixTerminal{File: file, cmd: cmd}, nil
}

func (t *unixTerminal) Close() error {
	_ = t.cmd.Process.Kill()
	err := t.File.Close()
	_ = t.cmd.Wait()
	return err
}
