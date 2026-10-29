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

// ProviderPorts are Daytona's own daemon on every box: its toolbox, SSH and
// terminal. Not the user's to open. lib/runtime/box-ports.ts holds the same
// list, which the control plane refuses a preview link for; both match
// ProviderPorts in agent-protocol.fixtures.json.
var ProviderPorts = []int{2280, 22220, 22222, 33333}

// DesktopPorts are the desktop's: x11vnc and noVNC's proxy, which Daytona's
// computer use starts, and the DevTools port of the browser the agent's
// desktop tools launch. Not servers of the user's either: the Desktop tab is
// the way to the desktop, through a link that lasts minutes, and a preview
// link to any of these would be a key to the box's desktop or its browser
// good for hours. lib/runtime/box-ports.ts holds the same list; both match
// DesktopPorts in agent-protocol.fixtures.json.
var DesktopPorts = []int{5900, 5901, 6080, 19222}

// tcpListen is the LISTEN state in /proc/net/tcp.
const tcpListen = "0A"

// Listening is every TCP port something on the box listens on, lowest first,
// but `skip` (the agent's own, the editor's), the provider's, the desktop's,
// and ports below 1024. procRoot is "/proc" but in tests.
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
	for _, port := range append(append(append([]int{}, skip...), ProviderPorts...), DesktopPorts...) {
		skipped[port] = true
	}
	var listening []Port
	wanted := map[string]bool{}
	for port, inode := range inodes {
		if port < 1024 || skipped[port] {
			continue
		}
		listening = append(listening, Port{Port: port})
		wanted[inode] = true
	}
	owners := socketOwners(procRoot, wanted)
	for i := range listening {
		listening[i].Process = owners[inodes[listening[i].Port]]
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

// socketOwners maps each `wanted` socket inode to the program that holds it,
// from /proc/<pid>/fd: the box user's own processes (others' fds can't be
// read, and those ports are listed without a name). It stops once all are
// found, and looks at nothing when none are wanted: a poll's cost follows the
// listeners, not every fd on the box.
func socketOwners(procRoot string, wanted map[string]bool) map[string]string {
	owners := map[string]string{}
	if len(wanted) == 0 {
		return owners
	}
	pids, _ := os.ReadDir(procRoot)
	for _, pid := range pids {
		if len(owners) == len(wanted) {
			break
		}
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
			inode := strings.TrimSuffix(strings.TrimPrefix(link, "socket:["), "]")
			if !wanted[inode] {
				continue
			}
			if name == "" {
				comm, _ := os.ReadFile(filepath.Join(procRoot, pid.Name(), "comm"))
				name = strings.TrimSpace(string(comm))
			}
			owners[inode] = name
		}
	}
	return owners
}
