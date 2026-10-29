package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// `outrunner media` is how a session on an Outrunner box shows its work in a
// pull request: `gif` makes a small GIF of a screen recording, and `upload`
// sends a screenshot, GIF or recording to Outrunner and prints the line to
// paste. An upload goes through the box's runtime-agent, which signs it with
// the box's own secret (runtime-agent/internal/media): the session proves
// itself to the agent with its ask token, and never holds a credential of
// the user's. `gif` works anywhere ffmpeg does.
//
// On a box the runtime-agent puts `outrunner` first on the sessions' PATH,
// set to find it (OUTRUNNER_BOX_ROOT), and launches each session with its id
// (OUTRUNNER_SESSION_ID).

const mediaUsage = `Usage: outrunner media <command>

Show your work in a pull request (in an Outrunner session's terminal):
  upload   Upload a screenshot, GIF or recording and print the line to paste:
           outrunner media upload after.png --name "Settings page on a phone, after"
  gif      Make a small looping GIF of a screen recording:
           outrunner media gif recording.mp4 --start 2 --duration 6

outrunner media <command> --help for more.
`

const uploadUsage = `Usage: outrunner media upload <file> --name "<what it shows>" [--access public|private] [--json]

Uploads a PNG, JPEG, GIF, WebP or MP4 (up to 50 MB) from this session to
Outrunner, and prints the markdown to paste in the pull request.

  --name     What it shows, descriptive and unique: it's the image's alt
             text, e.g. "Composer draft after reload". Never just "screenshot".
  --access   Who the link opens for. Images are public by default: anyone
             with the link, as a pull request needs. Videos are private by
             default (only you, signed in to Outrunner); --access public opens
             one for anyone. The GIF made from an MP4 is public even when its
             video is private, so it can show in a pull request.

An MP4 is also made into a GIF (outrunner media gif) and uploaded, and a line
that shows the GIF and links to the video is printed: GitHub doesn't play a
video from a link. The automatic GIF shows the recording's first 10 seconds.
For the relevant moment, make a GIF with outrunner media gif and upload it.

Public links are bearer links and don't expire. Upload only what goes in the
pull request: screenshots taken to check your own work stay on the box.
`

const gifUsage = `Usage: outrunner media gif <recording> [-o out.gif] [--start <s>] [--duration <s>]
                          [--crop w:h:x:y] [--fps <n>] [--width <px>]

Makes a looping GIF of an MP4, WebM or MOV recording, under 5 MB so GitHub
shows it: it starts at 12 fps and 960 px wide and lowers both until it fits.

  --start      Where to begin, in seconds (default 0).
  --duration   How long, in seconds (default 10, at most 30). Keep it to the
               interaction, usually 3 to 10 seconds.
  --crop       Only this part, w:h:x:y in the recording's pixels: the area that
               changed, the same for the before and after GIFs.
  -o           Where to write it (default: beside the recording, .gif).
`

func mediaCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, mediaUsage)
		return 2
	}
	switch args[0] {
	case "upload":
		return mediaUploadCommand(ctx, args[1:], stdout, stderr)
	case "gif":
		return mediaGIFCommand(ctx, args[1:], stdout, stderr)
	case "help", "--help", "-h":
		fmt.Fprint(stdout, mediaUsage)
		return 0
	default:
		fmt.Fprintf(stderr, "outrunner: unknown media command %q\n\n%s", args[0], mediaUsage)
		return 2
	}
}

func mediaFlags(name, usage string, stderr io.Writer) *flag.FlagSet {
	set := flag.NewFlagSet("outrunner media "+name, flag.ContinueOnError)
	set.SetOutput(stderr)
	set.Usage = func() { fmt.Fprint(stderr, usage) }
	return set
}

// parseAnywhere reads flags wherever they are among the arguments, as the
// other commands do (commandFlags.parse).
func parseAnywhere(set *flag.FlagSet, args []string) ([]string, int) {
	return commandFlags{set: set}.parse(args)
}

func mediaGIFCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	set := mediaFlags("gif", gifUsage, stderr)
	var o GIFOptions
	output := set.String("o", "", "where to write the GIF")
	set.Float64Var(&o.Start, "start", 0, "where to begin, in seconds")
	set.Float64Var(&o.Duration, "duration", defaultGIFSeconds, "how long, in seconds (at most 30)")
	set.StringVar(&o.Crop, "crop", "", "only this part: w:h:x:y")
	set.IntVar(&o.FPS, "fps", defaultGIFFPS, "frames a second to start at")
	set.IntVar(&o.Width, "width", defaultGIFWidth, "width in pixels to start at")
	positional, code := parseAnywhere(set, args)
	if code >= 0 {
		return code
	}
	if len(positional) != 1 {
		fmt.Fprint(stderr, gifUsage)
		return 2
	}
	input := positional[0]
	if *output == "" {
		*output = GIFPath(input)
	}
	// The cheap checks first: a bad flag or a missing file shouldn't cost
	// an ffmpeg install before it's refused.
	if err := o.Validate(); err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 2
	}
	if _, err := os.Stat(input); err != nil {
		fmt.Fprintf(stderr, "outrunner: can't read %s: %v\n", input, err)
		return 1
	}
	if err := ensureFFmpeg(ctx, stderr); err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 1
	}
	result, err := MakeGIF(ctx, input, *output, o, stderr)
	if err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 1
	}
	fmt.Fprintf(stderr, "Made %s (%s, %d fps, %d px wide).\n", result.Path, megabytes(result.Bytes), result.FPS, result.Width)
	fmt.Fprintln(stdout, result.Path)
	return 0
}

// genericNames are names that say nothing of what a file shows: the alt
// text a reader of the pull request gets.
var genericNames = map[string]bool{
	"screenshot": true, "screen shot": true, "screenshots": true, "image": true, "picture": true,
	"gif": true, "video": true, "recording": true, "screen recording": true, "demo": true,
	"before": true, "after": true, "test": true, "untitled": true,
}

// checkMediaName refuses an upload's name that doesn't say what it shows.
func checkMediaName(name, path string) error {
	name = strings.TrimSpace(name)
	lower := strings.ToLower(name)
	switch {
	case name == "":
		return errors.New(`name what the file shows with --name, e.g. --name "Composer draft after reload"`)
	case genericNames[lower] || lower == strings.ToLower(filepath.Base(path)) || lower == strings.ToLower(fileStem(path)):
		return fmt.Errorf(`--name %q doesn't say what it shows: it's the alt text a reader gets, e.g. "Composer draft after reload"`, name)
	}
	return nil
}

// fileStem is a path's file name without its extension: "after" of
// "/w/after.png".
func fileStem(path string) string {
	return strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
}

// boxAgent is the session's way to its box's runtime-agent.
type boxAgent struct {
	addrFile, tokenFile, sessionID string
	client                         *http.Client
}

// errNotOnBox is a terminal that isn't an Outrunner session's.
var errNotOnBox = errors.New("uploads work in an Outrunner session's terminal, on its box: this isn't one")

// boxAgentFromEnv finds the agent as a session's relay does: the address it
// announces and the session's token, under the box's root. The paths are
// workspace.AskPaths's, written out here so this package, which the npm CLI
// builds too, needn't import the agent's; a test pins the two together. The session is
// the one the terminal was launched in, or else the one whose worktree
// (Root/workspaces/<id>) the command runs in.
func boxAgentFromEnv(getenv func(string) string, cwd string) (boxAgent, error) {
	root, session := strings.TrimSpace(getenv("OUTRUNNER_BOX_ROOT")), strings.TrimSpace(getenv("OUTRUNNER_SESSION_ID"))
	if root == "" {
		return boxAgent{}, errNotOnBox
	}
	if session == "" {
		session = sessionOfFolder(root, cwd)
	}
	if session == "" {
		return boxAgent{}, errors.New("run it in the session's own terminal or folder: this one isn't a session's")
	}
	return boxAgent{
		addrFile:  filepath.Join(root, "agent.addr"),
		tokenFile: filepath.Join(root, "ask", session+".token"),
		sessionID: session,
		client:    &http.Client{},
	}, nil
}

// MediaLink is an uploaded file as the agent answers with it.
type MediaLink struct {
	URL         string `json:"url"`
	PageURL     string `json:"pageUrl"`
	Markdown    string `json:"markdown"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Access      string `json:"access"`
}

// upload has the agent upload the file at path, absolute.
func (a boxAgent) upload(ctx context.Context, path, name, access string) (MediaLink, error) {
	addr, err := readTrimmed(a.addrFile)
	if err != nil {
		return MediaLink{}, fmt.Errorf("can't find this box's Outrunner agent: %w", err)
	}
	token, err := readTrimmed(a.tokenFile)
	if err != nil {
		return MediaLink{}, fmt.Errorf("this session can't upload: %w", err)
	}
	body, err := json.Marshal(map[string]string{"path": path, "name": name, "access": access})
	if err != nil {
		return MediaLink{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+addr+"/workspaces/"+a.sessionID+"/media", bytes.NewReader(body))
	if err != nil {
		return MediaLink{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := a.client.Do(req)
	if err != nil {
		return MediaLink{}, fmt.Errorf("can't reach this box's Outrunner agent: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return MediaLink{}, err
	}
	if resp.StatusCode == http.StatusNotFound {
		return MediaLink{}, errors.New("this box's Outrunner agent can't upload yet: it's from before uploads")
	}
	if resp.StatusCode != http.StatusOK {
		var refusal struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &refusal) == nil && refusal.Error.Message != "" {
			return MediaLink{}, errors.New(refusal.Error.Message)
		}
		return MediaLink{}, fmt.Errorf("the upload failed: %s", resp.Status)
	}
	var link MediaLink
	if err := json.Unmarshal(data, &link); err != nil || link.URL == "" {
		return MediaLink{}, errors.New("the agent sent a malformed answer")
	}
	return link, nil
}

// sessionOfFolder is the session whose worktree dir is in, or "".
func sessionOfFolder(root, dir string) string {
	rel, err := filepath.Rel(filepath.Join(root, "workspaces"), dir)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return ""
	}
	return strings.Split(filepath.ToSlash(rel), "/")[0]
}

func readTrimmed(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(data))
	if value == "" {
		return "", fmt.Errorf("%s is empty", path)
	}
	return value, nil
}

// isVideo says whether a file is a recording, by its name: the agent checks
// what it really is.
func isVideo(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp4", ".m4v", ".mov", ".webm":
		return true
	}
	return false
}

// posterLine shows a GIF that links to its video: how a pull request shows a
// recording.
func posterLine(name string, gif, video MediaLink) string {
	return fmt.Sprintf("[![%s](%s)](%s)", name, gif.URL, video.URL)
}

func mediaUploadCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	set := mediaFlags("upload", uploadUsage, stderr)
	name := set.String("name", "", "what it shows: the alt text")
	access := set.String("access", "", "public or private")
	asJSON := set.Bool("json", false, "print the links as JSON")
	positional, code := parseAnywhere(set, args)
	if code >= 0 {
		return code
	}
	if len(positional) != 1 {
		fmt.Fprint(stderr, uploadUsage)
		return 2
	}
	path, err := filepath.Abs(positional[0])
	if err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 1
	}
	if err := checkMediaName(*name, path); err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 2
	}
	if *access != "" && *access != "public" && *access != "private" {
		fmt.Fprintln(stderr, `outrunner: --access is "public" or "private"`)
		return 2
	}
	cwd, _ := os.Getwd()
	agent, err := boxAgentFromEnv(os.Getenv, cwd)
	if err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 1
	}

	link, err := agent.upload(ctx, path, strings.TrimSpace(*name), *access)
	if err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 1
	}
	out := map[string]any{"file": link}
	lines := []string{link.Markdown}

	// A recording shows in a pull request as its GIF, linking to it.
	if isVideo(path) {
		gif, err := uploadPoster(ctx, agent, path, strings.TrimSpace(*name), stderr)
		if err != nil {
			fmt.Fprintf(stderr, "outrunner: uploaded the video, but not a GIF of it (%v); make one with `outrunner media gif` and upload it\n", err)
		} else {
			out["gif"] = gif
			poster := posterLine(strings.TrimSpace(*name), gif, link)
			out["poster"] = poster
			lines = append(lines, poster)
			fmt.Fprintln(stderr, "\nThe GIF shows the recording's first 10 seconds. For the part that matters, make one with `outrunner media gif --start <s> --duration <s> --crop w:h:x:y` and upload it.")
		}
	}

	if *asJSON {
		data, _ := json.MarshalIndent(out, "", "  ")
		fmt.Fprintln(stdout, string(data))
		return 0
	}
	for _, line := range lines {
		fmt.Fprintln(stdout, line)
	}
	switch {
	case link.Access != "private":
	case out["poster"] != nil:
		fmt.Fprintln(stderr, "\nThe video's link opens only for you, signed in to Outrunner. Paste the GIF line: it shows the GIF to anyone and links to the video. Upload with --access public to open the video for anyone.")
	default:
		fmt.Fprintln(stderr, "\nThe link opens only for you, signed in to Outrunner. Upload with --access public to open it for anyone.")
	}
	fmt.Fprintf(stderr, "\nManage it (who it opens for, a new link, delete) at %s\n", link.PageURL)
	return 0
}

// uploadPoster makes a GIF of a recording and uploads it: the image a pull
// request shows for the video. It's made in a folder of its own, never
// beside the recording, where a GIF made with `outrunner media gif` (cropped,
// trimmed) would be overwritten by this one, and removed once uploaded.
func uploadPoster(ctx context.Context, agent boxAgent, video, name string, stderr io.Writer) (MediaLink, error) {
	if err := ensureFFmpeg(ctx, stderr); err != nil {
		return MediaLink{}, err
	}
	dir, err := os.MkdirTemp("", "outrunner-poster-")
	if err != nil {
		return MediaLink{}, err
	}
	defer os.RemoveAll(dir)
	result, err := MakeGIF(ctx, video, filepath.Join(dir, fileStem(video)+".gif"), GIFOptions{}, stderr)
	if err != nil {
		return MediaLink{}, err
	}
	return agent.upload(ctx, result.Path, name+" (GIF)", "public")
}
