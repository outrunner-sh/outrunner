// Package childterm runs a program on a terminal of its own, for a TUI that
// needs one (`claude setup-token`): a Unix PTY, or a Windows ConPTY.
package childterm

import (
	"errors"
	"io"
)

// Terminal is a program running on a terminal of its own: reading it is
// what the program printed, writing to it is typing. Reads end once the
// program has exited and everything it printed has been read.
//
// Start opens one: a Unix PTY (childterm_unix.go) or a Windows ConPTY
// (childterm_windows.go).
type Terminal interface {
	io.ReadWriter
	// Close stops the program if it's still running, with anything it
	// started on the terminal, and frees the terminal.
	Close() error
}

// The terminal's size: wide enough that a sign-in link is never wrapped
// onto lines of its own.
const (
	cols = 1000
	rows = 48
)

// ErrUnsupported is a system that can't give a program a terminal of
// its own: an OS without PTYs, or a Windows older than 10 (1809).
var ErrUnsupported = errors.New("no pseudo-terminal on this system")
