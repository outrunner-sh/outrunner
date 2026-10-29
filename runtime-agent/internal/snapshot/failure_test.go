package snapshot

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUploadFailureDiagnosticsPreserveOriginalFiles(t *testing.T) {
	repo := gitRepoWithWIP(t)
	marker := filepath.Join(repo, "brand-new.txt")
	before, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}
	store := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
		_, _ = w.Write([]byte("private signed=https://storage.test?token=secret"))
	}))
	defer store.Close()
	manifest, err := Produce(context.Background(), Input{WorkspaceID: "fixture", Worktree: repo, Uploads: allArtifactUploads(store.URL)})
	if err == nil || manifest != nil {
		t.Fatalf("expected refused upload: %v", err)
	}
	diagnostic := DiagnosticOf(err)
	if diagnostic == nil || diagnostic.Stage != "upload" || diagnostic.Artifact != "conversation" || diagnostic.Cause != "storage_http" || diagnostic.HTTPStatus != 503 {
		t.Fatalf("diagnostic: %+v", diagnostic)
	}
	var status *StatusError
	if !errors.As(err, &status) || status.Status != 503 {
		t.Fatal("original error lost")
	}
	data, _ := json.Marshal(diagnostic)
	if strings.Contains(string(data), "secret") || strings.Contains(string(data), "storage.test") {
		t.Fatalf("unsafe diagnostics: %s", data)
	}
	after, err := os.ReadFile(marker)
	if err != nil || string(after) != string(before) {
		t.Fatal("original marker was lost")
	}
}

func TestCaptureFailureDiagnosticsIdentifyGitWithoutExposingItsOutput(t *testing.T) {
	_, err := Produce(context.Background(), Input{WorkspaceID: "fixture", Worktree: filepath.Join(t.TempDir(), "missing-private-path")})
	diagnostic := DiagnosticOf(err)
	if diagnostic == nil || diagnostic.Stage != "capture" || diagnostic.Artifact != "bundle" || diagnostic.Cause != "command_failed" || diagnostic.ExitCode == nil || *diagnostic.ExitCode != 128 {
		t.Fatalf("%+v: %v", diagnostic, err)
	}
	data, _ := json.Marshal(diagnostic)
	if strings.Contains(string(data), "private-path") {
		t.Fatalf("unsafe diagnostics: %s", data)
	}
}
