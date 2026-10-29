package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// TestGoldenFixtures decodes every shared fixture into its Go struct. Together
// with the zod side (test/agent-protocol.test.ts) this guarantees the TS and Go
// representations of the wire contract cannot silently drift.
func TestGoldenFixtures(t *testing.T) {
	raw, err := os.ReadFile(findFixtures(t))
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var groups map[string][]json.RawMessage
	if err := json.Unmarshal(raw, &groups); err != nil {
		t.Fatalf("parse fixtures: %v", err)
	}

	for name, examples := range groups {
		for i, ex := range examples {
			if err := decodeInto(name, ex); err != nil {
				t.Errorf("%s[%d]: %v", name, i, err)
			}
		}
	}
}

// TestTheNewestHealthFixtureNamesEveryFeature ties the features this agent
// advertises to the fixture the zod side checks its own names against
// (test/agent-protocol.test.ts): a feature named differently on either side
// would never be found, and the control plane would upgrade a box forever.
func TestTheNewestHealthFixtureNamesEveryFeature(t *testing.T) {
	raw, err := os.ReadFile(findFixtures(t))
	if err != nil {
		t.Fatal(err)
	}
	var groups struct{ AgentHealth []Health }
	if err := json.Unmarshal(raw, &groups); err != nil {
		t.Fatal(err)
	}
	newest := groups.AgentHealth[len(groups.AgentHealth)-1].Features
	for _, feature := range []string{FeatureImports, FeatureEnvironment, FeatureAgentConfig, FeatureRestoreModel, FeatureEditor, FeaturePorts, FeatureCodexGateway, FeatureWarmHooks, FeatureMultiRepo, FeatureMultiRepoSnapshots, FeatureGitCredential, FeatureMultiRepoWarm, FeaturePlanMode, FeatureCompact, FeatureFiles, FeatureSkills, FeatureCodexMCP, FeatureCanvas, FeatureAgentContext, FeatureMessageKeys, FeatureChats, FeatureChatSnapshots, FeatureRewind} {
		if !slices.Contains(newest, feature) {
			t.Errorf("the newest AgentHealth fixture lacks %s: %q", feature, newest)
		}
	}
}

// TestPtyOutputSeqZeroMarshals guards the marshal direction the golden-fixture
// decode test misses: an output frame with seq 0 must serialize as `"seq":0`,
// not drop it (omitempty on a plain int did, which the zod side rejected as an
// "Invalid PTY frame"). Non-output frames must still omit seq.
func TestPtyOutputSeqZeroMarshals(t *testing.T) {
	zero := 0
	out, err := json.Marshal(PtyServerMessage{T: "output", Data: "x", Seq: &zero})
	if err != nil {
		t.Fatalf("marshal output: %v", err)
	}
	if got := string(out); got != `{"t":"output","data":"x","seq":0}` {
		t.Errorf("output seq 0 not preserved: %s", got)
	}

	writer := true
	role, err := json.Marshal(PtyServerMessage{T: "role", Writer: &writer})
	if err != nil {
		t.Fatalf("marshal role: %v", err)
	}
	if got := string(role); got != `{"t":"role","writer":true}` {
		t.Errorf("role frame should omit seq: %s", got)
	}
}

func decodeInto(name string, raw json.RawMessage) error {
	switch name {
	case "RuntimeTokenClaims":
		return json.Unmarshal(raw, &RuntimeTokenClaims{})
	case "PtyClientMessage":
		return json.Unmarshal(raw, &PtyClientMessage{})
	case "PtyServerMessage":
		return json.Unmarshal(raw, &PtyServerMessage{})
	case "CreateWorkspaceRequest":
		return json.Unmarshal(raw, &CreateWorkspaceRequest{})
	case "WorkspaceActionRequest":
		return json.Unmarshal(raw, &WorkspaceActionRequest{})
	case "ArchiveWorkspaceRequest":
		return json.Unmarshal(raw, &ArchiveWorkspaceRequest{})
	case "RestoreWorkspaceRequest":
		return json.Unmarshal(raw, &RestoreWorkspaceRequest{})
	case "SetAgentConfigRequest":
		return json.Unmarshal(raw, &SetAgentConfigRequest{})
	case "SetSkillsRequest":
		return json.Unmarshal(raw, &SetSkillsRequest{})
	case "SetSkillsResponse":
		return json.Unmarshal(raw, &SetSkillsResponse{})
	case "SetAgentContextRequest":
		return json.Unmarshal(raw, &SetAgentContextRequest{})
	case "SetEnvironmentRequest":
		return json.Unmarshal(raw, &SetEnvironmentRequest{})
	case "WarmRequest":
		return json.Unmarshal(raw, &WarmRequest{})
	case "WarmStatus":
		return json.Unmarshal(raw, &WarmStatus{})
	case "ProvideSecretsRequest":
		return json.Unmarshal(raw, &ProvideSecretsRequest{})
	case "ProviderPorts", "DesktopPorts":
		return json.Unmarshal(raw, &[]int{})
	case "ReservedEnv":
		return json.Unmarshal(raw, &[]string{})
	case "ErrorResponse":
		return json.Unmarshal(raw, &ErrorResponse{})
	case "SessionUrls":
		return json.Unmarshal(raw, &SessionUrls{})
	case "WorkspaceSummary":
		return json.Unmarshal(raw, &WorkspaceSummary{})
	case "Activity":
		return json.Unmarshal(raw, &Activity{})
	case "EditorResponse":
		return json.Unmarshal(raw, &EditorResponse{})
	case "PortsResponse":
		return json.Unmarshal(raw, &PortsResponse{})
	case "ConversationMessage":
		return json.Unmarshal(raw, &ConversationMessage{})
	case "SendMessageRequest":
		return json.Unmarshal(raw, &SendMessageRequest{})
	case "CreateChatRequest":
		return json.Unmarshal(raw, &CreateChatRequest{})
	case "RewindRequest":
		return json.Unmarshal(raw, &RewindRequest{})
	case "RewindResponse":
		return json.Unmarshal(raw, &RewindResponse{})
	case "ConversationRewound":
		return json.Unmarshal(raw, &ConversationRewound{})
	case "PlanActionRequest":
		return json.Unmarshal(raw, &PlanActionRequest{})
	case "PlanActionResponse":
		return json.Unmarshal(raw, &PlanActionResponse{})
	case "CompactRequest":
		return json.Unmarshal(raw, &CompactRequest{})
	case "FilesResponse":
		return json.Unmarshal(raw, &FilesResponse{})
	case "CanvasResponse":
		return json.Unmarshal(raw, &CanvasResponse{})
	case "TokenUsage":
		return json.Unmarshal(raw, &TokenUsage{})
	case "WorkspaceStateChanged":
		return json.Unmarshal(raw, &WorkspaceStateChanged{})
	case "SetAuthRequest":
		return json.Unmarshal(raw, &SetAuthRequest{})
	case "AgentHealth":
		return json.Unmarshal(raw, &Health{})
	case "LocalSession":
		return json.Unmarshal(raw, &LocalSession{})
	default:
		// A new fixture group with no Go struct is a drift we want to catch.
		return errUnknown(name)
	}
}

type unknownGroup string

func (u unknownGroup) Error() string { return "no Go struct for fixture group " + string(u) }
func errUnknown(name string) error   { return unknownGroup(name) }

// findFixtures walks up from the test's working directory to the repo root.
func findFixtures(t *testing.T) string {
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		p := filepath.Join(dir, "lib", "runtime", "agent-protocol.fixtures.json")
		if _, err := os.Stat(p); err == nil {
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("agent-protocol.fixtures.json not found walking up from cwd")
		}
		dir = parent
	}
}
