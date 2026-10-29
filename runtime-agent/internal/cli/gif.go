package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// A pull request shows a recording as a short looping GIF: GitHub plays no
// video from a link, and a GIF plays inline everywhere with no click. GitHub's
// image proxy refuses an image over 5 MiB (the PR shows it broken), so a GIF is
// made at 12 fps and 960 px wide, then made smaller, a step at a time, until
// it fits.

// MaxGIFBytes is the largest GIF that GitHub's image proxy shows.
const MaxGIFBytes = 5 * 1024 * 1024

// Bounds on what of a recording a GIF shows: the interaction, not the session.
const (
	defaultGIFSeconds = 10
	maxGIFSeconds     = 30
	defaultGIFFPS     = 12
	defaultGIFWidth   = 960
)

// GIFOptions say what of a recording becomes the GIF, and how large it starts.
type GIFOptions struct {
	// Start is where in the recording it begins, in seconds.
	Start float64
	// Duration is how many seconds it shows; 0 is defaultGIFSeconds.
	Duration float64
	// Crop is ffmpeg's w:h:x:y, in the recording's pixels: the part that
	// changed, so its text stays readable. Empty is the whole frame.
	Crop string
	// FPS and Width are where the steps start; 0 is 12 fps and 960 px.
	FPS   int
	Width int
}

var cropPattern = regexp.MustCompile(`^\d+:\d+:\d+:\d+$`)

// Validate refuses options that ffmpeg would choke on or that show too much.
func (o GIFOptions) Validate() error {
	if o.Start < 0 {
		return errors.New("--start can't be before the recording starts")
	}
	if o.Duration < 0 || o.Duration > maxGIFSeconds {
		return fmt.Errorf("--duration is at most %d seconds: show the interaction, not the session", maxGIFSeconds)
	}
	if o.Crop != "" && !cropPattern.MatchString(o.Crop) {
		return errors.New("--crop is w:h:x:y in the recording's pixels, e.g. 960:540:0:120")
	}
	if o.FPS < 0 || o.FPS > 30 {
		return errors.New("--fps is between 1 and 30")
	}
	if o.Width < 0 || (o.Width > 0 && o.Width < 160) {
		return errors.New("--width is at least 160 pixels")
	}
	return nil
}

// gifStep is one try's frame rate and width.
type gifStep struct{ fps, width int }

// gifSteps start at the asked frame rate and width and lower both, the width
// first, until the smallest a GIF is still worth watching at.
func gifSteps(fps, width int) []gifStep {
	if fps == 0 {
		fps = defaultGIFFPS
	}
	if width == 0 {
		width = defaultGIFWidth
	}
	steps := []gifStep{{fps, width}}
	for _, f := range []float64{0.85, 0.7} {
		steps = append(steps, gifStep{fps, even(float64(width) * f)})
	}
	for _, s := range []gifStep{{10, 640}, {8, 560}, {8, 480}, {6, 400}} {
		if s.fps <= fps && s.width < steps[len(steps)-1].width {
			steps = append(steps, s)
		}
	}
	return steps
}

func even(v float64) int { return int(v/2) * 2 }

// gifFilter is ffmpeg's filter for one step: crop, frame rate, scale (never
// up), then a palette made from the frames' differences, dithered so
// gradients don't band, and only the changed rectangle redrawn per frame.
func gifFilter(crop string, step gifStep) string {
	filter := ""
	if crop != "" {
		filter = "crop=" + crop + ","
	}
	return filter + fmt.Sprintf("fps=%d,scale='min(%d,iw)':-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle", step.fps, step.width)
}

// gifArgs are ffmpeg's arguments for one step. -ss and -t come before -i:
// palettegen waits for its input to end, so a trim after -i never finishes.
func gifArgs(input, output string, o GIFOptions, step gifStep) []string {
	duration := o.Duration
	if duration == 0 {
		duration = defaultGIFSeconds
	}
	return []string{
		"-v", "error", "-y",
		"-ss", strconv.FormatFloat(o.Start, 'f', -1, 64),
		"-t", strconv.FormatFloat(duration, 'f', -1, 64),
		"-i", input,
		"-vf", gifFilter(o.Crop, step),
		"-loop", "0",
		output,
	}
}

// GIFPath is where a GIF of input goes when no -o is given: beside it.
func GIFPath(input string) string {
	return strings.TrimSuffix(input, filepath.Ext(input)) + ".gif"
}

// GIFResult is a GIF made, and the step that made it fit.
type GIFResult struct {
	Path  string
	Bytes int64
	FPS   int
	Width int
}

// runFFmpeg runs ffmpeg; a variable so tests stand in for it.
var runFFmpeg = func(ctx context.Context, args []string) error {
	out, err := exec.CommandContext(ctx, "ffmpeg", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// MakeGIF makes a GIF of input at output, smaller a step at a time until it
// is under MaxGIFBytes. Still too large at the last step: an error saying to
// show less, the last (smallest) try left at output.
func MakeGIF(ctx context.Context, input, output string, o GIFOptions, progress io.Writer) (GIFResult, error) {
	if err := o.Validate(); err != nil {
		return GIFResult{}, err
	}
	if _, err := os.Stat(input); err != nil {
		return GIFResult{}, fmt.Errorf("can't read %s: %w", input, err)
	}
	var size int64
	for i, step := range gifSteps(o.FPS, o.Width) {
		if err := runFFmpeg(ctx, gifArgs(input, output, o, step)); err != nil {
			return GIFResult{}, err
		}
		info, err := os.Stat(output)
		if err != nil {
			return GIFResult{}, fmt.Errorf("ffmpeg made no GIF: %w", err)
		}
		size = info.Size()
		if size < MaxGIFBytes {
			return GIFResult{Path: output, Bytes: size, FPS: step.fps, Width: step.width}, nil
		}
		if progress != nil {
			fmt.Fprintf(progress, "%s at %d fps and %d px is %s, over GitHub's %s: trying smaller (%d)\n",
				filepath.Base(output), step.fps, step.width, megabytes(size), megabytes(MaxGIFBytes), i+2)
		}
	}
	return GIFResult{}, fmt.Errorf("the GIF is still %s, over GitHub's %s: show less, with a shorter --duration or a tighter --crop", megabytes(size), megabytes(MaxGIFBytes))
}

func megabytes(n int64) string { return fmt.Sprintf("%.1f MB", float64(n)/(1024*1024)) }

// ensureFFmpeg finds ffmpeg, installing it with apt when it's missing and
// sudo needs no password: Daytona's boxes have it, and an image without it
// pays for it only the first time a GIF is made, not at every session start.
func ensureFFmpeg(ctx context.Context, stderr io.Writer) error {
	if _, err := exec.LookPath("ffmpeg"); err == nil {
		return nil
	}
	if _, err := exec.LookPath("apt-get"); err != nil {
		return errors.New("ffmpeg isn't installed: install it to make GIFs")
	}
	fmt.Fprintln(stderr, "ffmpeg isn't installed; installing it (once)…")
	install := exec.CommandContext(ctx, "sh", "-c", "sudo -n apt-get update -qq && sudo -n apt-get install -y -qq --no-install-recommends ffmpeg")
	install.Stdout, install.Stderr = stderr, stderr
	if err := install.Run(); err != nil {
		return fmt.Errorf("ffmpeg isn't installed, and installing it failed (%v): run `sudo apt-get install -y ffmpeg`", err)
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return errors.New("ffmpeg still isn't on PATH after installing it")
	}
	return nil
}
