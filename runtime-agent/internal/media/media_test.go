package media

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/gitcred"
)

var png = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR rest of the image")

func TestContentTypeIsReadFromTheFirstBytes(t *testing.T) {
	for _, c := range []struct {
		head string
		want string
	}{
		{string(png), "image/png"},
		{"\xff\xd8\xff\xe0", "image/jpeg"},
		{"GIF89a....", "image/gif"},
		{"RIFF\x00\x00\x00\x00WEBPVP8 ", "image/webp"},
		{"\x00\x00\x00\x20ftypisom", "video/mp4"},
		{"<svg xmlns=", ""},
		{"", ""},
	} {
		if got := ContentType([]byte(c.head)); got != c.want {
			t.Errorf("ContentType(%q) = %q, want %q", c.head, got, c.want)
		}
	}
}

// fakeOutrunner is a control plane and its storage: it checks each request's
// signature as the app does, and keeps what is PUT.
type fakeOutrunner struct {
	t       *testing.T
	server  *httptest.Server
	stored  []byte
	storedT string
	asked   map[string]any
	refuse  string
}

func newFakeOutrunner(t *testing.T) *fakeOutrunner {
	f := &fakeOutrunner{t: t}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/runtime/media", "/api/runtime/media/complete":
			body, _ := io.ReadAll(r.Body)
			purpose := "media-upload"
			if strings.HasSuffix(r.URL.Path, "complete") {
				purpose = "media-complete"
			}
			want := Sign("secret", purpose, "sb-1", r.Header.Get("X-Outrunner-Timestamp"), body)
			if r.Header.Get("X-Outrunner-Sandbox") != "sb-1" || r.Header.Get("X-Outrunner-Signature") != want {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = io.WriteString(w, `{"error":"Bad signature."}`)
				return
			}
			var asked map[string]any
			_ = json.Unmarshal(body, &asked)
			if purpose == "media-upload" {
				if f.refuse != "" {
					w.WriteHeader(http.StatusTooManyRequests)
					_, _ = io.WriteString(w, `{"error":"`+f.refuse+`"}`)
					return
				}
				f.asked = asked
				w.WriteHeader(http.StatusCreated)
				_, _ = io.WriteString(w, `{"id":"m1","uploadUrl":"`+f.server.URL+`/storage/o1/m1?token=t"}`)
				return
			}
			if asked["id"] != "m1" || asked["workspaceId"] != "ws-1" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = io.WriteString(w, `{"id":"m1","url":"https://app/m/x.png","pageUrl":"https://app/media/m1","markdown":"![After](https://app/m/x.png)","name":"After","contentType":"image/png","sizeBytes":1}`)
		case "/storage/o1/m1":
			if r.Method != http.MethodPut {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			f.stored, _ = io.ReadAll(r.Body)
			f.storedT = r.Header.Get("Content-Type")
			_, _ = io.WriteString(w, `{"Key":"media/o1/m1"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeOutrunner) client() *Client {
	return &Client{Config: gitcred.Config{AppURL: f.server.URL, SandboxID: "sb-1", Secret: "secret"}, Now: time.Now}
}

func writeFile(t *testing.T, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestUploadPutsTheBytesInStorageAndReturnsTheLink(t *testing.T) {
	f := newFakeOutrunner(t)
	result, err := f.client().Upload(context.Background(), "ws-1", writeFile(t, "after.png", png), Options{Name: "After"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Markdown != "![After](https://app/m/x.png)" || result.PageURL != "https://app/media/m1" {
		t.Fatalf("result = %+v", result)
	}
	if string(f.stored) != string(png) || f.storedT != "image/png" {
		t.Fatalf("stored %q as %q", f.stored, f.storedT)
	}
	if f.asked["workspaceId"] != "ws-1" || f.asked["contentType"] != "image/png" || f.asked["sizeBytes"] != float64(len(png)) || f.asked["name"] != "After" {
		t.Fatalf("asked %v", f.asked)
	}
	if text := Text(result); !strings.HasPrefix(text, "![After](https://app/m/x.png)\n") || !strings.Contains(text, "https://app/media/m1") {
		t.Fatalf("Text = %q", text)
	}
}

func TestUploadNamesTheFileByItsOwnNameWhenNotGiven(t *testing.T) {
	f := newFakeOutrunner(t)
	if _, err := f.client().Upload(context.Background(), "ws-1", writeFile(t, "after.png", png), Options{Name: " "}); err != nil {
		t.Fatal(err)
	}
	if f.asked["name"] != "after.png" {
		t.Fatalf("name = %v", f.asked["name"])
	}
	if _, asked := f.asked["access"]; asked {
		t.Fatalf("access asked for with none given: %v", f.asked)
	}
}

func TestUploadAsksForTheAccessGiven(t *testing.T) {
	f := newFakeOutrunner(t)
	if _, err := f.client().Upload(context.Background(), "ws-1", writeFile(t, "after.png", png), Options{Name: "x", Access: "private"}); err != nil {
		t.Fatal(err)
	}
	if f.asked["access"] != "private" {
		t.Fatalf("asked %v", f.asked)
	}
	_, err := f.client().Upload(context.Background(), "ws-1", writeFile(t, "after.png", png), Options{Access: "friends"})
	var refused *Error
	if !errors.As(err, &refused) {
		t.Fatalf("err = %v, want a refusal", err)
	}
}

func TestTextSaysWhoTheLinkOpensFor(t *testing.T) {
	public := Text(Result{Markdown: "![a](u)", URL: "u", PageURL: "p", Access: "public"})
	private := Text(Result{Markdown: "[v](u)", URL: "u", PageURL: "p", Access: "private"})
	if !strings.Contains(public, "public") || !strings.Contains(private, "private") || !strings.Contains(private, "](u)") {
		t.Fatalf("public %q, private %q", public, private)
	}
}

func TestUploadRefusesWhatOutrunnerWouldNot(t *testing.T) {
	f := newFakeOutrunner(t)
	c := f.client()
	for name, data := range map[string][]byte{
		"page.html": []byte("<html><body>hi</body></html>"),
		"empty.png": nil,
	} {
		_, err := c.Upload(context.Background(), "ws-1", writeFile(t, name, data), Options{})
		var refused *Error
		if !errors.As(err, &refused) {
			t.Errorf("%s: err = %v, want a refusal", name, err)
		}
	}
	if _, err := c.Upload(context.Background(), "ws-1", filepath.Join(t.TempDir(), "missing.png"), Options{}); err == nil {
		t.Error("a missing file uploaded")
	}
	if f.asked != nil {
		t.Errorf("Outrunner was asked for %v", f.asked)
	}
}

func TestUploadPassesOnOutrunnersRefusal(t *testing.T) {
	f := newFakeOutrunner(t)
	f.refuse = "Your org's uploads are at their 10 GB limit."
	_, err := f.client().Upload(context.Background(), "ws-1", writeFile(t, "after.png", png), Options{})
	var refused *Error
	if !errors.As(err, &refused) || refused.Message != f.refuse || refused.Status != http.StatusTooManyRequests {
		t.Fatalf("err = %v", err)
	}
	if f.stored != nil {
		t.Fatal("bytes were uploaded after a refusal")
	}
}

func TestSignMatchesTheControlPlanes(t *testing.T) {
	// The value lib/media/box-auth.ts's mediaRequestSignature gives for the
	// same input; test/media.test.ts checks it there.
	got := Sign("secret", "media-upload", "sb-1", "1800000000", []byte(`{"workspaceId":"w"}`))
	const want = "sha256=f7cad8db0fa8de3b5ff54f9ed50ee5282207ac63b825b9dca2b534f0c405d962"
	if got != want {
		t.Fatalf("Sign = %s, want %s", got, want)
	}
}
