package ports

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"testing"
)

const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

// fakeProc writes /proc/net/tcp and tcp6 tables, and one process holding a
// socket, under a scratch root.
func fakeProc(t *testing.T, tcp, tcp6 string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "net"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(root, "net", "tcp"), []byte(header+tcp), 0o644)
	_ = os.WriteFile(filepath.Join(root, "net", "tcp6"), []byte(header+tcp6), 0o644)
	pid := filepath.Join(root, "4242")
	_ = os.MkdirAll(filepath.Join(pid, "fd"), 0o755)
	_ = os.WriteFile(filepath.Join(pid, "comm"), []byte("node\n"), 0o644)
	if err := os.Symlink("socket:[111]", filepath.Join(pid, "fd", "21")); err != nil {
		t.Fatal(err)
	}
	return root
}

func line(local, state, inode string) string {
	return "   0: " + local + " 00000000:0000 " + state + " 00000000:00000000 00:00000000 00000000  1001        0 " + inode + " 1 0000000000000000 100 0 0 10 0\n"
}

func TestTheServersOnTheBoxAreListedWithTheirProgram(t *testing.T) {
	root := fakeProc(t,
		line("00000000:0BB8", "0A", "111")+ // 3000, node
			line("0100007F:1645", "0A", "222")+ // 5701 on loopback, someone else's
			line("0100007F:1F90", "0A", "333")+ // 8080: the agent
			line("00000000:20FB", "0A", "444")+ // 8443: the editor
			line("00000000:0016", "0A", "555")+ // 22: privileged
			line("0100007F:0BB9", "01", "666"), // 3001: a connection, not a listener
		line("00000000000000000000000000000000:08E8", "0A", "777")+ // 2280: Daytona's
			line("00000000000000000000000000000000:0BB8", "0A", "888"), // 3000 again, on IPv6
	)
	got, err := Listening(root, 8080, 8443)
	if err != nil {
		t.Fatal(err)
	}
	want := []Port{{Port: 3000, Process: "node"}, {Port: 5701}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestNoTablesIsAnError(t *testing.T) {
	if _, err := Listening(t.TempDir()); err == nil {
		t.Fatal("a box with no /proc/net/tcp listed nothing, silently")
	}
}

func TestARealListenerIsFound(t *testing.T) {
	if _, err := os.Stat("/proc/net/tcp"); err != nil {
		t.Skip("no /proc here")
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	port := l.Addr().(*net.TCPAddr).Port
	got, err := Listening("/proc")
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range got {
		if p.Port == port {
			if p.Process == "" {
				t.Errorf("port %d has no program; this test's own is %q", port, strconv.Itoa(os.Getpid()))
			}
			return
		}
	}
	t.Fatalf("port %d not listed in %+v", port, got)
}

func TestProviderPortsMatchTheSharedList(t *testing.T) {
	dir, _ := os.Getwd()
	for {
		if _, err := os.Stat(filepath.Join(dir, "lib", "runtime", "agent-protocol.fixtures.json")); err == nil {
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("agent-protocol.fixtures.json not found")
		}
		dir = parent
	}
	data, err := os.ReadFile(filepath.Join(dir, "lib", "runtime", "agent-protocol.fixtures.json"))
	var fixtures struct {
		ProviderPorts [][]int `json:"ProviderPorts"`
	}
	if err != nil || json.Unmarshal(data, &fixtures) != nil || len(fixtures.ProviderPorts) != 1 {
		t.Fatalf("read the shared list: %v", err)
	}
	got := append([]int{}, ProviderPorts...)
	want := append([]int{}, fixtures.ProviderPorts[0]...)
	sort.Ints(got)
	sort.Ints(want)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ProviderPorts = %v, the shared list = %v", got, want)
	}
}
