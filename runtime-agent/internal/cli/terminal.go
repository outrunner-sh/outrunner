package cli

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"

	"github.com/creack/pty"
)

// terminal is where the user answers: one reader of stdin for the whole run,
// so a question and setup-token's code prompt never race for the same line.
type terminal struct {
	lines       <-chan string
	interactive bool
	out         io.Writer
}

// readLines hands stdin over a line at a time, closing at its end.
func readLines(stdin io.Reader) <-chan string {
	lines := make(chan string)
	if stdin == nil {
		close(lines)
		return lines
	}
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(stdin)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()
	return lines
}

// isTerminal is whether stdin is someone typing, not a pipe, a file or
// /dev/null. A character device isn't enough (/dev/null is one): only a
// terminal has a window size. Windows has no such call here, so there a
// character device is taken as the console.
func isTerminal(stdin io.Reader) bool {
	file, ok := stdin.(*os.File)
	if !ok {
		return false
	}
	if runtime.GOOS != "windows" {
		_, _, err := pty.Getsize(file)
		return err == nil
	}
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

// confirm asks a yes-or-no question; Enter is yes, and so is no answer at all
// only when there's no one to ask (the caller checks interactive first).
func (t terminal) confirm(question string) bool {
	fmt.Fprintf(t.out, "%s (Y/n) ", question)
	line, ok := <-t.lines
	if !ok {
		fmt.Fprintln(t.out)
		return false
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "" || answer == "y" || answer == "yes"
}

// confirmNo asks a yes-or-no question whose answer is no unless it's said:
// for what can't be undone, where a stray Enter mustn't count as yes.
func (t terminal) confirmNo(question string) bool {
	fmt.Fprintf(t.out, "%s (y/N) ", question)
	line, ok := <-t.lines
	if !ok {
		fmt.Fprintln(t.out)
		return false
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "y" || answer == "yes"
}

// pasted is what the user types while signing in, when someone is typing:
// nothing is asked of a pipe or /dev/null.
func (t terminal) pasted() <-chan string {
	if !t.interactive {
		return nil
	}
	return t.lines
}
