package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// The desktop is Daytona's computer use: a virtual display with a window
// manager, a VNC server and noVNC, which the Daytona daemon on the box starts
// and drives. Its toolbox answers on the box's loopback without a credential
// (anything on the box is already inside it), so the tools here reach it
// directly, and start the desktop themselves the first time one is used:
// nothing has to ask the control plane, and a box whose owner never opened
// the Desktop tab runs no display until the agent needs one.

// DefaultToolbox is where the Daytona daemon's toolbox listens on every box.
const DefaultToolbox = "http://127.0.0.1:2280"

// Toolbox is a client for the toolbox's computer-use routes.
type Toolbox struct {
	// Base is the toolbox's address, DefaultToolbox but in tests.
	Base   string
	Client *http.Client
}

func (t *Toolbox) client() *http.Client {
	if t.Client != nil {
		return t.Client
	}
	return &http.Client{Timeout: 60 * time.Second}
}

// do sends one request and decodes a JSON answer into out (when not nil). A
// refusal carries the toolbox's own words, which say what was wrong.
func (t *Toolbox) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, t.Base+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := t.client().Do(req)
	if err != nil {
		return fmt.Errorf("the desktop's toolbox can't be reached: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var e struct {
			Message string `json:"message"`
			Error   string `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		msg := strings.TrimSpace(e.Message + " " + e.Error)
		if msg == "" {
			msg = strings.TrimSpace(string(data))
		}
		return fmt.Errorf("the desktop refused %s %s: %s %s", method, path, resp.Status, msg)
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("the desktop's answer to %s isn't JSON: %w", path, err)
		}
	}
	return nil
}

// Status is the desktop's: "active" once everything runs, "inactive" before
// it starts, "partial" while some of it is down.
func (t *Toolbox) Status(ctx context.Context) (string, error) {
	var res struct {
		Status string `json:"status"`
	}
	if err := t.do(ctx, http.MethodGet, "/computeruse/status", nil, &res); err != nil {
		return "", err
	}
	return res.Status, nil
}

// Start starts what of the desktop isn't running, unless all of it is: a
// start with everything up is a no-op on Daytona's side too, but asked first
// it costs nothing.
func (t *Toolbox) Start(ctx context.Context) error {
	if status, err := t.Status(ctx); err == nil && status == "active" {
		return nil
	}
	return t.do(ctx, http.MethodPost, "/computeruse/start", map[string]any{}, nil)
}

// Screenshot is the whole screen as a JPEG, the pointer drawn in: small
// enough to hand the model every time, its pixels the screen's own, so a
// point on it is the point to click.
func (t *Toolbox) Screenshot(ctx context.Context) ([]byte, error) {
	var res struct {
		Screenshot string `json:"screenshot"`
	}
	q := url.Values{"format": {"jpeg"}, "quality": {"80"}, "showCursor": {"true"}}
	if err := t.do(ctx, http.MethodGet, "/computeruse/screenshot/compressed?"+q.Encode(), nil, &res); err != nil {
		return nil, err
	}
	return decodeBase64(res.Screenshot)
}

// DisplaySize is the display's width and height: the active one, of the one
// a box has.
func (t *Toolbox) DisplaySize(ctx context.Context) (int, int, error) {
	var res struct {
		Displays []struct {
			Width    int  `json:"width"`
			Height   int  `json:"height"`
			IsActive bool `json:"isActive"`
		} `json:"displays"`
	}
	if err := t.do(ctx, http.MethodGet, "/computeruse/display/info", nil, &res); err != nil {
		return 0, 0, err
	}
	for _, d := range res.Displays {
		if d.IsActive || len(res.Displays) == 1 {
			return d.Width, d.Height, nil
		}
	}
	return 0, 0, fmt.Errorf("the desktop has no display")
}

func (t *Toolbox) Click(ctx context.Context, x, y int, button string, double bool) error {
	return t.do(ctx, http.MethodPost, "/computeruse/mouse/click",
		map[string]any{"x": x, "y": y, "button": button, "double": double}, nil)
}

func (t *Toolbox) Drag(ctx context.Context, fromX, fromY, toX, toY int) error {
	return t.do(ctx, http.MethodPost, "/computeruse/mouse/drag",
		map[string]any{"startX": fromX, "startY": fromY, "endX": toX, "endY": toY, "button": "left"}, nil)
}

func (t *Toolbox) Scroll(ctx context.Context, x, y int, direction string, amount int) error {
	return t.do(ctx, http.MethodPost, "/computeruse/mouse/scroll",
		map[string]any{"x": x, "y": y, "direction": direction, "amount": amount}, nil)
}

func (t *Toolbox) Type(ctx context.Context, text string) error {
	return t.do(ctx, http.MethodPost, "/computeruse/keyboard/type", map[string]any{"text": text}, nil)
}

// Key presses one key or chord: "enter", "ctrl+l", "ctrl+shift+t".
func (t *Toolbox) Key(ctx context.Context, keys string) error {
	return t.do(ctx, http.MethodPost, "/computeruse/keyboard/hotkey", map[string]any{"keys": keys}, nil)
}

// Recording is one of the toolbox's screen recordings.
type Recording struct {
	ID              string  `json:"id"`
	FilePath        string  `json:"filePath"`
	Status          string  `json:"status"`
	StartTime       string  `json:"startTime"`
	DurationSeconds float64 `json:"durationSeconds"`
	SizeBytes       int64   `json:"sizeBytes"`
}

func (t *Toolbox) StartRecording(ctx context.Context, label string) (Recording, error) {
	var rec Recording
	err := t.do(ctx, http.MethodPost, "/computeruse/recordings/start", map[string]any{"label": label}, &rec)
	return rec, err
}

func (t *Toolbox) StopRecording(ctx context.Context, id string) (Recording, error) {
	var rec Recording
	err := t.do(ctx, http.MethodPost, "/computeruse/recordings/stop", map[string]any{"id": id}, &rec)
	return rec, err
}

// Recordings are the recordings whose files are in the toolbox's folder: the
// list is read from there, so one moved out of it is no longer listed.
func (t *Toolbox) Recordings(ctx context.Context) ([]Recording, error) {
	var res struct {
		Recordings []Recording `json:"recordings"`
	}
	err := t.do(ctx, http.MethodGet, "/computeruse/recordings", nil, &res)
	return res.Recordings, err
}

// Available reports whether this box has the desktop at all: the toolbox
// answers its status route, whatever the status. A box on another provider,
// or a Mac, has nothing listening there.
func Available(ctx context.Context, base string) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	t := &Toolbox{Base: base, Client: &http.Client{Timeout: 2 * time.Second}}
	status, err := t.Status(ctx)
	return err == nil && status != ""
}
