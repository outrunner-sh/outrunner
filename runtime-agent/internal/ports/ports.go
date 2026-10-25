// Package ports finds the servers running on a box (a dev server, an API),
// for the session's owner to open in their browser through the provider's
// preview URL. Servers bound to loopback count too: Daytona's proxy reaches
// them (checked on a real box, 127.0.0.1 and ::1 both).
package ports

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Port is one server listening on the box.
type Port struct {
	Port int `json:"port"`
	// Process is the program listening on it ("node", "python3"), where the
	// agent can see it: the box user's own processes.
	Process string `json:"process,omitempty"`
}

// providerPorts are Daytona's own daemon on every box: its toolbox, SSH and
// terminal. Not the user's to open.
var providerPorts = map[int]bool{2280: true, 22220: true, 22222: true, 33333: true}

// tcpListen is the LISTEN state in /proc/net/tcp.
const tcpListen = "0A"

// Listening is every TCP port something on the box listens on, lowest first,
// but `skip` (the agent's own, the editor's), the provider's, and ports below
// 1024. procRoot is "/proc" but in tests.
func Listening(procRoot string, skip ...int) ([]Port, error) {
	inodes := map[int]string{} // port -> a socket inode listening on it
	found := false
	for _, file := range []string{"net/tcp", "net/tcp6"} {
		entries, err := readListeners(filepath.Join(procRoot, file))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		found = true
		for port, inode := range entries {
			if _, ok := inodes[port]; !ok {
				inodes[port] = inode
			}
		}
	}
	if !found {
		return nil, os.ErrNotExist
	}
	skipped := map[int]bool{}
	for _, port := range skip {
		skipped[port] = true
	}
	var listening []Port
	owners := socketOwners(procRoot)
	for port, inode := range inodes {
		if port < 1024 || skipped[port] || providerPorts[port] {
			continue
		}
		listening = append(listening, Port{Port: port, Process: owners[inode]})
	}
	sort.Slice(listening, func(i, j int) bool { return listening[i].Port < listening[j].Port })
	return listening, nil
}

// readListeners reads one /proc/net/tcp* table: each listening port and its
// socket's inode.
func readListeners(path string) (map[int]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	listeners := map[int]string{}
	scanner := bufio.NewScanner(f)
	scanner.Scan() // the header
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		// sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
		if len(fields) < 10 || fields[3] != tcpListen {
			continue
		}
		_, hexPort, ok := strings.Cut(fields[1], ":")
		if !ok {
			continue
		}
		port, err := strconv.ParseInt(hexPort, 16, 32)
		if err != nil || port <= 0 {
			continue
		}
		listeners[int(port)] = fields[9]
	}
	return listeners, scanner.Err()
}

// socketOwners maps each socket inode the agent can see to the program that
// holds it, from /proc/<pid>/fd: the box user's own processes (others' fds
// can't be read, and those ports are listed without a name).
func socketOwners(procRoot string) map[string]string {
	owners := map[string]string{}
	pids, _ := os.ReadDir(procRoot)
	for _, pid := range pids {
		if _, err := strconv.Atoi(pid.Name()); err != nil {
			continue
		}
		fds, err := os.ReadDir(filepath.Join(procRoot, pid.Name(), "fd"))
		if err != nil {
			continue
		}
		var name string
		for _, fd := range fds {
			link, err := os.Readlink(filepath.Join(procRoot, pid.Name(), "fd", fd.Name()))
			if err != nil || !strings.HasPrefix(link, "socket:[") {
				continue
			}
			if name == "" {
				comm, _ := os.ReadFile(filepath.Join(procRoot, pid.Name(), "comm"))
				name = strings.TrimSpace(string(comm))
			}
			owners[strings.TrimSuffix(strings.TrimPrefix(link, "socket:["), "]")] = name
		}
	}
	return owners
}
