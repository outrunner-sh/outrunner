package localimport

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// An upload that drops or meets a server error is sent again; one the storage
// refuses is not, and an artifact with no URL fails before any is sent.
func TestUploadRetriesWhatCanSucceed(t *testing.T) {
	uploadBackoff = []time.Duration{time.Millisecond}
	t.Cleanup(func() { uploadBackoff = []time.Duration{2 * time.Second, 8 * time.Second} })

	path := filepath.Join(t.TempDir(), "conversation.jsonl.gz")
	if err := os.WriteFile(path, []byte("stored bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	c := Capture{Artifacts: map[string]Artifact{"conversation": {Path: path}}}

	for name, tc := range map[string]struct {
		statuses []int
		wantErr  bool
		wantPuts int32
	}{
		"a server error, then success": {statuses: []int{503, 200}, wantPuts: 2},
		"server errors every time":     {statuses: []int{500, 502, 503}, wantErr: true, wantPuts: 3},
		"refused":                      {statuses: []int{400}, wantErr: true, wantPuts: 1},
	} {
		t.Run(name, func(t *testing.T) {
			var puts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := puts.Add(1)
				body, _ := io.ReadAll(r.Body)
				if r.Method != http.MethodPut || string(body) != "stored bytes" {
					t.Errorf("got %s %q", r.Method, body)
				}
				w.WriteHeader(tc.statuses[n-1])
			}))
			defer server.Close()

			err := Upload(context.Background(), c, map[string]string{"conversation": server.URL, "rollout": server.URL})
			if (err != nil) != tc.wantErr || puts.Load() != tc.wantPuts {
				t.Errorf("err = %v after %d puts, want error %v after %d", err, puts.Load(), tc.wantErr, tc.wantPuts)
			}
		})
	}

	if err := Upload(context.Background(), c, map[string]string{"bundle": "https://x"}); err == nil {
		t.Error("an artifact with no upload URL was accepted")
	}
}
