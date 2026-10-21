package localimport

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The scan's and capture's JSON is read by the web app: the shared examples in
// lib/runtime/import-scan.fixtures.json decode into these types with no field
// left over, and encode back the same. The TypeScript side checks the same
// file against its schema, so neither side drifts alone.
func TestFixturesRoundTrip(t *testing.T) {
	data, err := os.ReadFile(findFixtures(t))
	if err != nil {
		t.Fatal(err)
	}
	var groups map[string][]json.RawMessage
	if err := json.Unmarshal(data, &groups); err != nil {
		t.Fatal(err)
	}
	decoders := map[string]func() any{
		"Scan":        func() any { return new(Scan) },
		"Capture":     func() any { return new(Capture) },
		"CaptureSkip": func() any { return new(map[string]Skip) },
		"EnvCapture":  func() any { return new(EnvCapture) },
	}
	for name, examples := range groups {
		newValue, ok := decoders[name]
		if !ok {
			t.Errorf("no Go type for fixture group %s", name)
			continue
		}
		for i, raw := range examples {
			v := newValue()
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.DisallowUnknownFields()
			if err := dec.Decode(v); err != nil {
				t.Errorf("%s[%d]: %v", name, i, err)
				continue
			}
			again, err := json.Marshal(v)
			if err != nil {
				t.Fatal(err)
			}
			if !sameJSON(t, raw, again) {
				t.Errorf("%s[%d] does not encode back the same:\n%s", name, i, again)
			}
		}
	}
}

func sameJSON(t *testing.T, a, b []byte) bool {
	t.Helper()
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	xs, _ := json.Marshal(x)
	ys, _ := json.Marshal(y)
	return bytes.Equal(xs, ys)
}

// findFixtures walks up from the test's folder to the repository root.
func findFixtures(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		p := filepath.Join(dir, "lib", "runtime", "import-scan.fixtures.json")
		if _, err := os.Stat(p); err == nil {
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("import-scan.fixtures.json not found walking up from the test")
		}
		dir = parent
	}
}
