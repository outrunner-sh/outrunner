package cli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testGcpSetup(base string) gcpSetup {
	id := "00000000-0000-4000-a000-000000000001"
	name := "outrunner-0000000000004000"
	return gcpSetup{ID: id, Issuer: base + "/api/gcp/identity", JWKS: json.RawMessage(`{"keys":[{"kty":"EC","crv":"P-256","alg":"ES256","x":"public","y":"public"}]}`), Name: name, Region: "us-central1", Pool: name, Provider: "outrunner", Audience: "https://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/" + name + "/providers/outrunner", ServiceAccount: name + "@sandbox-project.iam.gserviceaccount.com"}
}
func fakeGcloud(log *[][]string, exists bool) gcloudRunner {
	return func(_ context.Context, args ...string) ([]byte, error) {
		*log = append(*log, append([]string{}, args...))
		s := strings.Join(args, " ")
		if strings.HasPrefix(s, "auth list") {
			return []byte("admin@example.com\n"), nil
		}
		if strings.HasPrefix(s, "projects describe") {
			return []byte("123456789\n"), nil
		}
		if strings.HasPrefix(s, "billing projects describe") {
			return []byte("True\n"), nil
		}
		if strings.Contains(s, " describe ") && !exists {
			return nil, errors.New("NOT_FOUND: resource not found")
		}
		return []byte("{}"), nil
	}
}
func TestGcpSetupMetadataCannotRedirectTrust(t *testing.T) {
	s := testGcpSetup("https://app.example.com")
	if err := validateGcpSetup("https://app.example.com", "sandbox-project", "123456789", "us-central1-a", s); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*gcpSetup){func(s *gcpSetup) { s.Issuer = "https://attacker.example.com" }, func(s *gcpSetup) { s.Audience = "https://other" }, func(s *gcpSetup) { s.ServiceAccount = "other@another-project.iam.gserviceaccount.com" }, func(s *gcpSetup) { s.ID = "../other" }, func(s *gcpSetup) { s.JWKS = json.RawMessage(`{"keys":[{"kty":"EC","alg":"ES256","d":"private"}]}`) }} {
		copy := s
		mutate(&copy)
		if err := validateGcpSetup("https://app.example.com", "sandbox-project", "123456789", "us-central1-a", copy); err == nil {
			t.Fatal("accepted redirected or private metadata")
		}
	}
}
func TestGcpConfigureUsesScopedKeylessTrustAndPrivateNetworking(t *testing.T) {
	var log [][]string
	s := testGcpSetup("https://app.example.com")
	if err := configureGcp(context.Background(), "sandbox-project", s, fakeGcloud(&log, false), io.Discard); err != nil {
		t.Fatal(err)
	}
	var commands []string
	for _, args := range log {
		commands = append(commands, strings.Join(args, " "))
	}
	all := strings.Join(commands, "\n")
	for _, want := range []string{"providers create-oidc outrunner", "--attribute-condition=assertion.sub == '" + s.ID + "'", "--member=principal://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/" + s.Pool + "/subject/" + s.ID, "--source-ranges=35.235.240.0/20", "--allow=tcp:22", "--target-tags=" + s.Name, "--auto-allocate-nat-external-ips", "compute.instances.setTags"} {
		if !strings.Contains(all, want) {
			t.Errorf("missing %s", want)
		}
	}
	for _, bad := range []string{"keys create", "roles/owner", "roles/editor", "0.0.0.0/0", "--allow=tcp:8080"} {
		if strings.Contains(all, bad) {
			t.Errorf("unexpected broad access %s", bad)
		}
	}
	for _, args := range log {
		if !strings.Contains(strings.Join(args, " "), "--project=sandbox-project") {
			t.Fatal("command used an implicit project")
		}
	}
}
func TestGcpConfigureRerunsWithoutRecreatingExistingResources(t *testing.T) {
	var log [][]string
	if err := configureGcp(context.Background(), "sandbox-project", testGcpSetup("https://app.example.com"), fakeGcloud(&log, true), io.Discard); err != nil {
		t.Fatal(err)
	}
	for _, args := range log {
		for _, arg := range args {
			if arg == "create" || arg == "create-oidc" {
				t.Fatalf("recreated existing resource: %v", args)
			}
		}
	}
}
func TestGcpPermissionDenialDoesNotBecomeCreate(t *testing.T) {
	var log [][]string
	run := func(_ context.Context, args ...string) ([]byte, error) {
		log = append(log, args)
		if strings.Contains(strings.Join(args, " "), "describe") {
			return nil, errors.New("PERMISSION_DENIED")
		}
		return nil, nil
	}
	if err := configureGcp(context.Background(), "sandbox-project", testGcpSetup("https://app.example.com"), run, io.Discard); err == nil {
		t.Fatal("ignored permission denial")
	}
	for _, args := range log {
		if strings.Contains(strings.Join(args, " "), "create") {
			t.Fatalf("created after denied describe: %v", args)
		}
	}
}
func TestGcpConnectRequiresApprovalBeforeMutations(t *testing.T) {
	var log [][]string
	lines := make(chan string, 1)
	lines <- "n"
	close(lines)
	in := terminal{lines: lines, interactive: true, out: io.Discard}
	if err := connectGcp(context.Background(), "https://app.example.com", Config{}, "sandbox-project", "us-central1-a", "small", false, false, in, io.Discard, fakeGcloud(&log, true)); err != nil {
		t.Fatal(err)
	}
	if len(log) != 3 {
		t.Fatalf("expected only read-only checks, got %v", log)
	}
}
func TestGcpVerificationGatesSelectionAndKeepsGoogleCredentialsLocal(t *testing.T) {
	for _, success := range []bool{true, false} {
		t.Run(map[bool]string{true: "success", false: "failed"}[success], func(t *testing.T) {
			var actions []string
			var server *httptest.Server
			server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/cli/sandbox/gcp" || r.Header.Get("Authorization") != "Bearer outrunner-cli-token" {
					t.Error("wrong API authentication")
					http.Error(w, "unauthorized", 401)
					return
				}
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				action := body["action"].(string)
				actions = append(actions, action)
				for k := range body {
					if strings.Contains(strings.ToLower(k), "token") || strings.Contains(strings.ToLower(k), "credential") {
						t.Errorf("uploaded Google credential: %s", k)
					}
				}
				switch action {
				case "begin":
					_ = json.NewEncoder(w).Encode(testGcpSetup(server.URL))
				case "verify":
					if !success {
						w.WriteHeader(502)
						_ = json.NewEncoder(w).Encode(map[string]string{"error": "IAP access denied"})
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]bool{"connected": true})
				case "use":
					_ = json.NewEncoder(w).Encode(map[string]string{"sandbox": "gcp"})
				}
			}))
			defer server.Close()
			old := http.DefaultClient
			http.DefaultClient = server.Client()
			defer func() { http.DefaultClient = old }()
			var log [][]string
			err := connectGcp(context.Background(), server.URL, Config{Token: "outrunner-cli-token"}, "sandbox-project", "us-central1-a", "medium", true, true, terminal{}, io.Discard, fakeGcloud(&log, true))
			if success {
				if err != nil {
					t.Fatal(err)
				}
				if strings.Join(actions, ",") != "begin,verify,use" {
					t.Fatalf("wrong order: %v", actions)
				}
			} else {
				if err == nil || !strings.Contains(err.Error(), "IAP access denied") {
					t.Fatalf("lost verification error: %v", err)
				}
				if strings.Join(actions, ",") != "begin,verify" {
					t.Fatalf("selected failed connection: %v", actions)
				}
			}
		})
	}
}
func TestGcpSandboxHelpDoesNotRequireSignInOrGcloud(t *testing.T) {
	if code := sandboxCommand(context.Background(), "https://app.example.com", "", Config{}, "", []string{"connect", "gcp", "--help"}, terminal{}, io.Discard, io.Discard); code != 0 {
		t.Fatalf("help returned %d", code)
	}
}
