package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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

	"runtime-agent/internal/workspace"
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
	if info, err := os.Stat(result.Path); err != nil || info.Mode().Perm()&0o044 == 0 {
		t.Fatalf("made %s unreadable to others: %v", result.Path, info.Mode())
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
	if checkMediaName("Media-Row", "/w/media-row.gif") == nil {
		t.Error("the file's own name without its extension was accepted")
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

// The CLI reads the files the agent writes for a session's relay: if those
// move, uploads must move with them.
func TestTheCLIFindsTheAgentWhereTheAgentSaysItIs(t *testing.T) {
	a, err := boxAgentFromEnv(func(k string) string {
		return map[string]string{"OUTRUNNER_BOX_ROOT": "/home/runtime", "OUTRUNNER_SESSION_ID": "ws-9"}[k]
	}, "/")
	if err != nil {
		t.Fatal(err)
	}
	addrFile, tokenFile := workspace.AskPaths("/home/runtime", "ws-9")
	if a.addrFile != addrFile || a.tokenFile != tokenFile {
		t.Fatalf("the CLI reads %s and %s; the agent writes %s and %s", a.addrFile, a.tokenFile, addrFile, tokenFile)
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
	poster := box.asked[1]["path"]
	if len(box.asked) != 2 || poster == GIFPath(video) || filepath.Ext(poster) != ".gif" || box.asked[1]["access"] != "public" {
		t.Fatalf("asked %v", box.asked)
	}
	if _, err := os.Stat(poster); !os.IsNotExist(err) {
		t.Fatalf("the poster %s was left behind (%v)", poster, err)
	}
	if !strings.Contains(stderr, "opens only for you") {
		t.Fatalf("stderr %q doesn't say the video is private", stderr)
	}
	if !strings.Contains(stderr, "first 10 seconds") || !strings.Contains(uploadUsage, "GIF made from an MP4 is public even when its") {
		t.Fatalf("the video/GIF visibility wasn't explained: usage %q, stderr %q", uploadUsage, stderr)
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
	if code, _, _ := run(t, "media", "gif", in, "--duration", "45"); code != 2 {
		t.Fatalf("a 45 second GIF: exit %d", code)
	}
}

// A GIF made with `outrunner media gif` beside the recording survives the
// recording's upload, which makes its own poster elsewhere.
func TestAVideosPosterLeavesTheUsersGIFAlone(t *testing.T) {
	newFakeBox(t)
	fakeFFmpeg(t, func(int) int { return 1000 })
	t.Setenv("PATH", fakeFFmpegOnPath(t))
	video := recording(t)
	mine := []byte("GIF89a cropped by hand")
	if err := os.WriteFile(GIFPath(video), mine, 0o644); err != nil {
		t.Fatal(err)
	}
	if code, _, stderr := run(t, "media", "upload", video, "--name", "Settings walkthrough"); code != 0 {
		t.Fatalf("exit %d, %q", code, stderr)
	}
	if got, _ := os.ReadFile(GIFPath(video)); !bytes.Equal(got, mine) {
		t.Fatalf("the user's GIF was overwritten: %q", got)
	}
}

func TestTheNoticeFitsWhatWasUploaded(t *testing.T) {
	newFakeBox(t)
	shot := filepath.Join(t.TempDir(), "after.png")
	_ = os.WriteFile(shot, []byte("\x89PNG\r\n\x1a\n"), 0o644)
	_, _, stderr := run(t, "media", "upload", shot, "--name", "Settings page, private", "--access", "private")
	if strings.Contains(stderr, "video") || !strings.Contains(stderr, "The link opens only for you") {
		t.Fatalf("a private image's notice: %q", stderr)
	}

	// A video whose poster couldn't be made: no GIF line to paste.
	fakeFFmpeg(t, func(int) int { return MaxGIFBytes + 1 })
	t.Setenv("PATH", fakeFFmpegOnPath(t))
	code, stdout, stderr := run(t, "media", "upload", recording(t), "--name", "Settings walkthrough")
	if code != 0 || strings.Contains(stdout, "[![") || strings.Contains(stderr, "Paste the GIF line") || !strings.Contains(stderr, "not a GIF of it") {
		t.Fatalf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
}

// Bad arguments and a missing file are refused before ffmpeg is looked for,
// let alone installed.
func TestGIFChecksItsArgumentsBeforeFFmpeg(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // no ffmpeg, no apt-get
	if code, _, stderr := run(t, "media", "gif", recording(t), "--duration", "45"); code != 2 || !strings.Contains(stderr, "--duration") {
		t.Fatalf("a 45 second GIF: exit %d, %q", code, stderr)
	}
	if code, _, stderr := run(t, "media", "gif", filepath.Join(t.TempDir(), "missing.mp4")); code != 1 || !strings.Contains(stderr, "can't read") || strings.Contains(stderr, "ffmpeg") {
		t.Fatalf("a missing recording: exit %d, %q", code, stderr)
	}
}

func TestAFailedGIFLeavesNoFileBehind(t *testing.T) {
	in := recording(t)
	out := GIFPath(in)
	old := runFFmpeg
	t.Cleanup(func() { runFFmpeg = old })

	// ffmpeg failing part way, as on a --start past the recording's end.
	runFFmpeg = func(_ context.Context, args []string) error {
		_ = os.WriteFile(args[len(args)-1], nil, 0o644)
		return errors.New("ffmpeg: exit status 234: Error writing trailer: Invalid argument")
	}
	_, err := MakeGIF(context.Background(), in, out, GIFOptions{Start: 10}, nil)
	if err == nil || !strings.Contains(err.Error(), "if --start 10s is past") {
		t.Fatalf("err = %v", err)
	}
	if _, statErr := os.Stat(out); !os.IsNotExist(statErr) {
		t.Fatalf("left %s behind: %v", out, statErr)
	}

	// ffmpeg succeeding with no frames.
	runFFmpeg = func(_ context.Context, args []string) error {
		return os.WriteFile(args[len(args)-1], nil, 0o644)
	}
	if _, err := MakeGIF(context.Background(), in, out, GIFOptions{}, nil); err == nil || !strings.Contains(err.Error(), "empty GIF") {
		t.Fatalf("err = %v", err)
	}
	if _, statErr := os.Stat(out); !os.IsNotExist(statErr) {
		t.Fatalf("left an empty %s behind: %v", out, statErr)
	}
}

func TestUploadingAGIFTooLargeForGitHubWarns(t *testing.T) {
	newFakeBox(t)
	big := filepath.Join(t.TempDir(), "flow.gif")
	_ = os.WriteFile(big, append([]byte("GIF89a"), bytes.Repeat([]byte{0}, MaxGIFBytes)...), 0o644)
	code, _, stderr := run(t, "media", "upload", big, "--name", "Checkout flow on a phone")
	if code != 0 || !strings.Contains(stderr, "shows it broken") {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	small := filepath.Join(t.TempDir(), "small.gif")
	_ = os.WriteFile(small, []byte("GIF89a"), 0o644)
	if _, _, stderr := run(t, "media", "upload", small, "--name", "Checkout flow on a phone"); strings.Contains(stderr, "shows it broken") {
		t.Fatalf("warned of a small GIF: %q", stderr)
	}
}

func TestAGIFIsNeverMadeOverItsInputOrOverAnExistingFileOnFailure(t *testing.T) {
	old := runFFmpeg
	t.Cleanup(func() { runFFmpeg = old })
	ran := false
	runFFmpeg = func(_ context.Context, args []string) error {
		ran = true
		return errors.New("ffmpeg: Invalid argument")
	}

	// `media gif flow.gif`: GIFPath of a GIF is itself.
	dir := t.TempDir()
	gif := filepath.Join(dir, "flow.gif")
	_ = os.WriteFile(gif, []byte("GIF89a keep me"), 0o644)
	if _, err := MakeGIF(context.Background(), gif, GIFPath(gif), GIFOptions{}, nil); err == nil || !strings.Contains(err.Error(), "from the recording") {
		t.Fatalf("err = %v", err)
	}
	if ran {
		t.Fatal("ran ffmpeg over its own input")
	}
	if data, _ := os.ReadFile(gif); string(data) != "GIF89a keep me" {
		t.Fatalf("input changed: %q", data)
	}

	// -o an existing file, ffmpeg failing (a bad --crop, bad input): left as it was.
	in := recording(t)
	existing := filepath.Join(dir, "existing.gif")
	_ = os.WriteFile(existing, []byte("GIF89a earlier"), 0o644)
	if _, err := MakeGIF(context.Background(), in, existing, GIFOptions{Crop: "10:10:0:0"}, nil); err == nil {
		t.Fatal("no error")
	}
	if data, _ := os.ReadFile(existing); string(data) != "GIF89a earlier" {
		t.Fatalf("existing output changed: %q", data)
	}
	// No try left lying about.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".outrunner-gif-") {
			t.Fatalf("left %s behind", e.Name())
		}
	}
}

func TestTheStartHintIsOnlyForFFmpegsOwnFailure(t *testing.T) {
	old := runFFmpeg
	t.Cleanup(func() { runFFmpeg = old })
	runFFmpeg = func(ctx context.Context, args []string) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return os.WriteFile(args[len(args)-1], nil, 0o644)
	}
	in := recording(t)
	// Empty: its own message names --start already, once.
	_, err := MakeGIF(context.Background(), in, GIFPath(in), GIFOptions{Start: 5}, nil)
	if err == nil || strings.Contains(err.Error(), "past the recording's end") {
		t.Fatalf("err = %v", err)
	}
	// Cancelled (Ctrl-C): not a --start problem.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = MakeGIF(ctx, in, GIFPath(in), GIFOptions{Start: 5}, nil)
	if err == nil || strings.Contains(err.Error(), "--start") {
		t.Fatalf("err = %v", err)
	}
}
