package server

import (
	"testing"

	"runtime-agent/internal/protocol"
)

func TestValidImportRestoreRefusesWhatCouldEscape(t *testing.T) {
	ok := protocol.RestoreWorkspaceRequest{
		Branch:         "ada/x-imported",
		BundleRef:      "ada/x",
		OriginWorktree: "/Users/ada/app",
		Downloads:      []protocol.RestoreDownload{{Artifact: "patch", URL: "https://s/p", Encoding: "gzip"}},
	}
	if err := validImportRestore(ok); err != nil {
		t.Fatalf("valid import restore refused: %v", err)
	}
	for name, mutate := range map[string]func(*protocol.RestoreWorkspaceRequest){
		"unknown encoding":        func(r *protocol.RestoreWorkspaceRequest) { r.Downloads[0].Encoding = "br" },
		"refspec in bundle ref":   func(r *protocol.RestoreWorkspaceRequest) { r.BundleRef = "a:refs/heads/main" },
		"option as bundle ref":    func(r *protocol.RestoreWorkspaceRequest) { r.BundleRef = "--upload-pack=x" },
		"traversal in bundle ref": func(r *protocol.RestoreWorkspaceRequest) { r.BundleRef = "a/../b" },
		"relative origin":         func(r *protocol.RestoreWorkspaceRequest) { r.OriginWorktree = "app" },
		"root origin":             func(r *protocol.RestoreWorkspaceRequest) { r.OriginWorktree = "/" },
		"unclean origin":          func(r *protocol.RestoreWorkspaceRequest) { r.OriginWorktree = "/Users/ada/../bob" },
	} {
		req := ok
		req.Downloads = append([]protocol.RestoreDownload(nil), ok.Downloads...)
		mutate(&req)
		if validImportRestore(req) == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
