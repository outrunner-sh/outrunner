//go:build windows

package childterm

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows has no PTYs; its pseudo-console (ConPTY, Windows 10 1809 and
// later) is the same thing: a console whose screen comes out of one pipe as
// VT text, and whose keyboard is what's written to another.

// procCreatePseudoConsole is looked up first: calling it where it's missing
// would panic.
var procCreatePseudoConsole = windows.NewLazySystemDLL("kernel32.dll").NewProc("CreatePseudoConsole")

const (
	// A ConPTY paints its screen out of the pipe a little after the program
	// writes to it, so its last words can still be on their way when the
	// program exits. The console is closed once its output has been quiet
	// this long, or after drainMax at the most.
	drainQuiet = 200 * time.Millisecond
	drainMax   = 2 * time.Second
)

type windowsTerminal struct {
	in, out *os.File
	process windows.Handle
	// closeConsole closes the pseudo-console, ending every program still on
	// it and, after its last output, the output pipe: a ConPTY's output
	// stays open after its program exits until then.
	closeConsole func()
	// lastOutput is when output was last read, in Unix nanoseconds.
	lastOutput atomic.Int64
	closing    chan struct{}
	exited     chan struct{}
	closeOnce  sync.Once
}

// Start runs binary with args, in dir with env, on a
// pseudo-console.
func Start(binary string, args []string, dir string, env []string) (Terminal, error) {
	if procCreatePseudoConsole.Find() != nil {
		return nil, ErrUnsupported
	}
	commandLine, err := windows.UTF16PtrFromString(windowsCommandLine(binary, args))
	if err != nil {
		return nil, err
	}
	var workDir *uint16
	if dir != "" {
		if workDir, err = windows.UTF16PtrFromString(dir); err != nil {
			return nil, err
		}
	}
	envBlock, err := windowsEnvBlock(env)
	if err != nil {
		return nil, err
	}

	// The program reads what's typed from one pipe and prints to the other.
	var inRead, inWrite, outRead, outWrite windows.Handle
	if err := windows.CreatePipe(&inRead, &inWrite, nil, 0); err != nil {
		return nil, fmt.Errorf("create the console's input pipe: %w", err)
	}
	if err := windows.CreatePipe(&outRead, &outWrite, nil, 0); err != nil {
		_ = windows.CloseHandle(inRead)
		_ = windows.CloseHandle(inWrite)
		return nil, fmt.Errorf("create the console's output pipe: %w", err)
	}
	var console windows.Handle
	err = windows.CreatePseudoConsole(windows.Coord{X: cols, Y: rows}, inRead, outWrite, 0, &console)
	// The console keeps its own copies of the program's ends.
	_ = windows.CloseHandle(inRead)
	_ = windows.CloseHandle(outWrite)
	in := os.NewFile(uintptr(inWrite), "conpty-in")
	out := os.NewFile(uintptr(outRead), "conpty-out")
	if err != nil {
		_ = in.Close()
		_ = out.Close()
		return nil, fmt.Errorf("create a pseudo-console: %w", err)
	}
	closeConsole := sync.OnceFunc(func() { windows.ClosePseudoConsole(console) })
	fail := func(err error) (Terminal, error) {
		closeConsole()
		_ = in.Close()
		_ = out.Close()
		return nil, err
	}

	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return fail(err)
	}
	defer attrs.Delete()
	// This attribute's value is the console handle itself, not a pointer to it.
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, *(*unsafe.Pointer)(unsafe.Pointer(&console)), unsafe.Sizeof(console)); err != nil {
		return fail(fmt.Errorf("attach the pseudo-console: %w", err))
	}
	startup := &windows.StartupInfoEx{ProcThreadAttributeList: attrs.List()}
	startup.Cb = uint32(unsafe.Sizeof(*startup))
	var info windows.ProcessInformation
	// No handles inherited, and no STARTF_USESTDHANDLES: the program's
	// standard handles are the pseudo-console's.
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT)
	if err := windows.CreateProcess(nil, commandLine, nil, nil, false, flags, envBlock, workDir, &startup.StartupInfo, &info); err != nil {
		return fail(fmt.Errorf("start %s: %w", binary, err))
	}
	_ = windows.CloseHandle(info.Thread)

	t := &windowsTerminal{
		in:           in,
		out:          out,
		process:      info.Process,
		closeConsole: closeConsole,
		closing:      make(chan struct{}),
		exited:       make(chan struct{}),
	}
	t.lastOutput.Store(time.Now().UnixNano())
	go t.closeOnExit()
	return t, nil
}

// closeOnExit closes the console once the program has exited and its last
// output is out, so reads end as they do on a PTY.
func (t *windowsTerminal) closeOnExit() {
	defer close(t.exited)
	_, _ = windows.WaitForSingleObject(t.process, windows.INFINITE)
	deadline := time.Now().Add(drainMax)
	for time.Now().Before(deadline) && time.Since(time.Unix(0, t.lastOutput.Load())) < drainQuiet {
		select {
		case <-t.closing:
			deadline = time.Time{}
		case <-time.After(drainQuiet / 4):
		}
	}
	t.closeConsole()
}

func (t *windowsTerminal) Read(p []byte) (int, error) {
	n, err := t.out.Read(p)
	if n > 0 {
		t.lastOutput.Store(time.Now().UnixNano())
	}
	return n, err
}

func (t *windowsTerminal) Write(p []byte) (int, error) {
	return t.in.Write(p)
}

func (t *windowsTerminal) Close() error {
	t.closeOnce.Do(func() {
		close(t.closing)
		// Closing the console ends everything on it, as closing a console
		// window does: under npm's claude.cmd, that's node as well as the
		// cmd.exe that started it.
		t.closeConsole()
		_ = windows.TerminateProcess(t.process, 1)
		<-t.exited
		_ = t.in.Close()
		_ = t.out.Close()
		_ = windows.CloseHandle(t.process)
	})
	return nil
}

// windowsCommandLine is binary with args as CreateProcess takes them. A .cmd
// or .bat, like npm's claude.cmd, runs under cmd.exe; /s has cmd take the
// line inside the outer quotes as it is, quoted paths and all.
func windowsCommandLine(binary string, args []string) string {
	line := windows.ComposeCommandLine(append([]string{binary}, args...))
	switch strings.ToLower(filepath.Ext(binary)) {
	case ".cmd", ".bat":
		shell := os.Getenv("ComSpec")
		if shell == "" {
			shell = filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe")
		}
		return windows.EscapeArg(shell) + ` /d /s /c "` + line + `"`
	}
	return line
}

// windowsEnvBlock is env as CreateProcess takes it with
// CREATE_UNICODE_ENVIRONMENT: each entry NUL-terminated, then one more NUL.
// Nil is the caller's environment.
func windowsEnvBlock(env []string) (*uint16, error) {
	if env == nil {
		return nil, nil
	}
	var block []uint16
	for _, entry := range env {
		utf16, err := windows.UTF16FromString(entry) // NUL-terminated
		if err != nil {
			return nil, fmt.Errorf("environment variable %q: %w", strings.SplitN(entry, "=", 2)[0], err)
		}
		block = append(block, utf16...)
	}
	if len(block) == 0 {
		block = append(block, 0)
	}
	block = append(block, 0)
	return &block[0], nil
}
