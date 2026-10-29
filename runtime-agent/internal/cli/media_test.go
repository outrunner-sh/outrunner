package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestGIFStepsStartAsAskedAndOnlyGetSmaller(t *testing.T) {
	steps := gifSteps(0, 0)
	if steps[0] != (gifStep{12, 960}) {
		t.Fatalf("first step = %v, want 12 fps at 960 px", steps[0])
	}
	for i := 1; i < len(steps); i++ {
		if steps[i].fps > steps[i-1].fps || steps[i].width >= steps[i-1].width || steps[i].width%2 != 0 {
			t.Fatalf("steps = %v: each must be narrower, an even width, and no faster", steps)
		}
	}
	if small := gifSteps(8, 600); small[0] != (gifStep{8, 600}) || slices.ContainsFunc(small, func(s gifStep) bool { return s.fps > 8 }) {
		t.Fatalf("steps from 8 fps at 600 px = %v", small)
	}
}

func TestGIFArgsTrimBeforeTheInputAndUseThePaletteFilter(t *testing.T) {
	args := gifArgs("in.mp4", "out.gif", GIFOptions{Start: 1.5, Duration: 6, Crop: "960:540:0:120"}, gifStep{12, 960})
	joined := strings.Join(args, " ")
	input := slices.Index(args, "-i")
	if slices.Index(args, "-ss") > input || slices.Index(args, "-t") > input || input < 0 {
		t.Fatalf("args = %q: -ss and -t must come before -i, or palettegen never finishes", args)
	}
	for _, want := range []string{
		"-ss 1.5 -t 6 -i in.mp4",
		"-vf crop=960:540:0:120,fps=12,scale='min(960,iw)':-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
		"-loop 0 out.gif",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("args = %q, want %q", joined, want)
		}
	}
	if d := gifArgs("in.mp4", "o.gif", GIFOptions{}, gifStep{12, 960}); !strings.Contains(strings.Join(d, " "), "-ss 0 -t 10 -i") {
		t.Errorf("default args = %q, want the first 10 seconds", d)
	}
}

func TestGIFOptionsAreChecked(t *testing.T) {
	for _, bad := range []GIFOptions{{Start: -1}, {Duration: 31}, {Crop: "960x540"}, {Crop: "1:2:3"}, {FPS: 60}, {Width: 100}} {
		if bad.Validate() == nil {
			t.Errorf("%+v was accepted", bad)
		}
	}
	if err := (GIFOptions{Start: 2, Duration: 30, Crop: "640:360:0:0", FPS: 12, Width: 960}).Validate(); err != nil {
		t.Errorf("good options refused: %v", err)
	}
}

// fakeFFmpeg writes a GIF whose size is what sizeAt says for the step's
// width, and records each run's arguments.
func fakeFFmpeg(t *testing.T, sizeAt func(width int) int) *[][]string {
	t.Helper()
	var runs [][]string
	old := runFFmpeg
	runFFmpeg = func(_ context.Context, args []string) error {
		runs = append(runs, args)
		filter := args[slices.Index(args, "-vf")+1]
		var width int
		for _, s := range gifSteps(0, 0) {
			if strings.Contains(filter, "min("+strconv.Itoa(s.width)+",iw)") {
				width = s.width
			}
		}
		return os.WriteFile(args[len(args)-1], bytes.Repeat([]byte{'G'}, sizeAt(width)), 0o644)
	}
	t.Cleanup(func() { runFFmpeg = old })
	return &runs
}

func recording(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "recording.mp4")
	if err := os.WriteFile(path, []byte("\x00\x00\x00\x20ftypisom"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAGIFOverFiveMegabytesIsMadeSmallerUntilItFits(t *testing.T) {
	runs := fakeFFmpeg(t, func(width int) int {
		if width >= 816 {
			return MaxGIFBytes + 1
		}
		return MaxGIFBytes - 1
	})
	var progress bytes.Buffer
	in := recording(t)
	result, err := MakeGIF(context.Background(), in, GIFPath(in), GIFOptions{}, &progress)
	if err != nil {
		t.Fatal(err)
	}
	if len(*runs) != 3 || result.Width != 672 || result.FPS != 12 || result.Bytes != MaxGIFBytes-1 {
		t.Fatalf("result = %+v after %d runs", result, len(*runs))
	}
	if result.Path != strings.TrimSuffix(in, ".mp4")+".gif" || !strings.Contains(progress.String(), "trying smaller") {
		t.Fatalf("path %q, progress %q", result.Path, progress.String())
	}
}

func TestAGIFThatNeverFitsSaysToShowLess(t *testing.T) {
	fakeFFmpeg(t, func(int) int { return MaxGIFBytes + 1 })
	in := recording(t)
	_, err := MakeGIF(context.Background(), in, GIFPath(in), GIFOptions{}, nil)
	if err == nil || !strings.Contains(err.Error(), "--duration") || !strings.Contains(err.Error(), "--crop") {
		t.Fatalf("err = %v", err)
	}
}

// With ffmpeg on this machine, a real recording becomes a real GIF.
func TestMakeGIFWithFFmpeg(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("no ffmpeg here")
	}
	dir := t.TempDir()
	in := filepath.Join(dir, "rec.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=4:size=1280x720:rate=30", "-pix_fmt", "yuv420p", in).CombinedOutput(); err != nil {
		t.Fatalf("make a recording: %v %s", err, out)
	}
	result, err := MakeGIF(context.Background(), in, GIFPath(in), GIFOptions{Start: 1, Duration: 2, Crop: "640:360:0:0"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	head := make([]byte, 6)
	f, _ := os.Open(result.Path)
	defer f.Close()
	_, _ = io.ReadFull(f, head)
	if string(head) != "GIF89a" || result.Bytes >= MaxGIFBytes {
		t.Fatalf("made %q, %d bytes", head, result.Bytes)
	}
}

func TestAnUploadMustSayWhatItShows(t *testing.T) {
	for _, name := range []string{"", "  ", "screenshot", "Screenshot", "after", "recording", "after.png"} {
		if checkMediaName(name, "/w/after.png") == nil {
			t.Errorf("name %q was accepted", name)
		}
	}
	if err := checkMediaName("Composer draft after reload", "/w/after.png"); err != nil {
		t.Errorf("a descriptive name was refused: %v", err)
	}
}

func TestTheSessionIsTheLaunchsOrTheFoldersIn(t *testing.T) {
	env := func(vars map[string]string) func(string) string { return func(k string) string { return vars[k] } }
	if _, err := boxAgentFromEnv(env(nil), "/home/runtime/workspaces/ws-1"); err != errNotOnBox {
		t.Fatalf("off a box: err = %v", err)
	}
	a, err := boxAgentFromEnv(env(map[string]string{"OUTRUNNER_BOX_ROOT": "/r", "OUTRUNNER_SESSION_ID": "ws-1"}), "/tmp")
	if err != nil || a.sessionID != "ws-1" || a.tokenFile != "/r/ask/ws-1.token" || a.addrFile != "/r/agent.addr" {
		t.Fatalf("agent = %+v, %v", a, err)
	}
	a, err = boxAgentFromEnv(env(map[string]string{"OUTRUNNER_BOX_ROOT": "/r"}), "/r/workspaces/ws-2/app/src")
	if err != nil || a.sessionID != "ws-2" {
		t.Fatalf("from its folder: agent = %+v, %v", a, err)
	}
	if _, err := boxAgentFromEnv(env(map[string]string{"OUTRUNNER_BOX_ROOT": "/r"}), "/r"); err == nil {
		t.Fatal("a folder that's no session's found one")
	}
}

// fakeBox is a box's root with an agent that answers uploads as the real one
// does, keeping what it was asked.
type fakeBox struct {
	root  string
	asked []map[string]string
}

func newFakeBox(t *testing.T) *fakeBox {
	t.Helper()
	box := &fakeBox{root: t.TempDir()}
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/workspaces/ws-1/media" || r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":{"code":"UNAUTHORIZED","message":"this session can't upload files here"}}`)
			return
		}
		var req map[string]string
		_ = json.NewDecoder(r.Body).Decode(&req)
		box.asked = append(box.asked, req)
		if strings.HasSuffix(req["path"], ".bmp") {
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = io.WriteString(w, `{"error":{"code":"REFUSED","message":"isn't a PNG, JPEG, GIF, WebP or MP4 file"}}`)
			return
		}
		ext := filepath.Ext(req["path"])
		access := req["access"]
		if access == "" {
			access = map[bool]string{true: "private", false: "public"}[ext == ".mp4"]
		}
		url := "https://app/m/id" + ext
		markdown := "![" + req["name"] + "](" + url + ")"
		if ext == ".mp4" {
			markdown = "[" + req["name"] + "](" + url + ")"
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"text": markdown, "url": url, "pageUrl": "https://app/media/m", "markdown": markdown, "access": access,
		})
	}))
	t.Cleanup(agent.Close)
	if err := os.MkdirAll(filepath.Join(box.root, "ask"), 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(box.root, "agent.addr"), []byte(strings.TrimPrefix(agent.URL, "http://")+"\n"), 0o600)
	_ = os.WriteFile(filepath.Join(box.root, "ask", "ws-1.token"), []byte("tok\n"), 0o600)
	t.Setenv("OUTRUNNER_BOX_ROOT", box.root)
	t.Setenv("OUTRUNNER_SESSION_ID", "ws-1")
	return box
}

func run(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := Main(context.Background(), args, strings.NewReader(""), &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestUploadPrintsTheLineToPaste(t *testing.T) {
	box := newFakeBox(t)
	shot := filepath.Join(t.TempDir(), "after.png")
	_ = os.WriteFile(shot, []byte("\x89PNG\r\n\x1a\n"), 0o644)

	code, stdout, stderr := run(t, "media", "upload", shot, "--name", "Settings page on a phone, after")
	if code != 0 || stdout != "![Settings page on a phone, after](https://app/m/id.png)\n" {
		t.Fatalf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
	if box.asked[0]["path"] != shot || box.asked[0]["access"] != "" || !strings.Contains(stderr, "https://app/media/m") {
		t.Fatalf("asked %v, stderr %q", box.asked, stderr)
	}

	if code, _, stderr := run(t, "media", "upload", shot, "--name", "Before", "--access", "private"); code != 2 || !strings.Contains(stderr, "doesn't say what it shows") {
		t.Fatalf("a generic name: exit %d, %q", code, stderr)
	}
	if code, _, _ := run(t, "media", "upload", shot, "--name", "Settings, private", "--access", "private"); code != 0 || box.asked[1]["access"] != "private" {
		t.Fatalf("--access private: exit %d, asked %v", code, box.asked)
	}
	bmp := filepath.Join(t.TempDir(), "x.bmp")
	_ = os.WriteFile(bmp, []byte("BM"), 0o644)
	if code, _, stderr := run(t, "media", "upload", bmp, "--name", "A bitmap of the page"); code != 1 || !strings.Contains(stderr, "isn't a PNG") {
		t.Fatalf("a refusal: exit %d, %q", code, stderr)
	}
}

func TestAVideoIsUploadedWithAGIFThatLinksToIt(t *testing.T) {
	box := newFakeBox(t)
	fakeFFmpeg(t, func(int) int { return 1000 })
	t.Setenv("PATH", fakeFFmpegOnPath(t))
	video := recording(t)

	code, stdout, stderr := run(t, "media", "upload", video, "--name", "Settings walkthrough")
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	lines := strings.Split(strings.TrimSpace(stdout), "\n")
	want := []string{
		"[Settings walkthrough](https://app/m/id.mp4)",
		"[![Settings walkthrough](https://app/m/id.gif)](https://app/m/id.mp4)",
	}
	if !slices.Equal(lines, want) {
		t.Fatalf("stdout = %q, want %q", lines, want)
	}
	if len(box.asked) != 2 || box.asked[1]["path"] != GIFPath(video) || box.asked[1]["access"] != "public" {
		t.Fatalf("asked %v", box.asked)
	}
	if !strings.Contains(stderr, "opens only for you") {
		t.Fatalf("stderr %q doesn't say the video is private", stderr)
	}
}

// fakeFFmpegOnPath is a PATH with an `ffmpeg` (never run: runFFmpeg is
// faked), so ensureFFmpeg finds one.
func fakeFFmpegOnPath(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ffmpeg"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestUploadOffABoxSaysWhere(t *testing.T) {
	t.Setenv("OUTRUNNER_BOX_ROOT", "")
	t.Setenv("OUTRUNNER_SESSION_ID", "")
	shot := filepath.Join(t.TempDir(), "after.png")
	_ = os.WriteFile(shot, []byte("\x89PNG\r\n\x1a\n"), 0o644)
	if code, _, stderr := run(t, "media", "upload", shot, "--name", "Settings page after"); code != 1 || !strings.Contains(stderr, "Outrunner session's terminal") {
		t.Fatalf("exit %d, %q", code, stderr)
	}
}

func TestGIFCommandPrintsThePath(t *testing.T) {
	fakeFFmpeg(t, func(int) int { return 1000 })
	t.Setenv("PATH", fakeFFmpegOnPath(t))
	in := recording(t)
	code, stdout, stderr := run(t, "media", "gif", in, "--start", "1", "--duration", "5", "--crop", "640:360:0:0")
	if code != 0 || strings.TrimSpace(stdout) != GIFPath(in) {
		t.Fatalf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
	if code, _, _ := run(t, "media", "gif", in, "--duration", "45"); code != 1 {
		t.Fatalf("a 45 second GIF: exit %d", code)
	}
}
