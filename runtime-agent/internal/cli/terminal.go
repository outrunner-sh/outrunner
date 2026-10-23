package cli

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
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

// isTerminal is whether stdin is someone typing, not a pipe or a file.
func isTerminal(stdin io.Reader) bool {
	file, ok := stdin.(*os.File)
	if !ok {
		return false
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
