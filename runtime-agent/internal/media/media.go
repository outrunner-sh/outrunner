// Package media uploads a file from the box to Outrunner, for a session's
// agent to show its work in a pull request: a screenshot of a change, a GIF of
// it working. Outrunner keeps the file and gives back a public link that
// GitHub can show (`![name](url)`).
//
// Only the agent can upload: it signs each request with its secret, as it does
// its requests for GitHub tokens (package gitcred), and the sessions'
// environment never has the secret. A session uploads through the agent (its
// upload_media tool, or `outrunner media upload`), which says which session
// the file is for. The bytes go straight to storage with a URL the control
// plane signs for the one file, so they never pass through the app:
//
//  1. POST /api/runtime/media: the session, the file's type and size; the org's
//     limits are checked, and the answer is where to PUT the bytes;
//  2. PUT the bytes there;
//  3. POST /api/runtime/media/complete: the control plane checks what was
//     stored and answers with the file's link.
package media

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"runtime-agent/internal/gitcred"
)

// MaxBytes is the largest file Outrunner takes, as the control plane's
// MAX_MEDIA_BYTES (lib/media/media.ts).
const MaxBytes = 50 * 1024 * 1024

// requestTimeout bounds each small request to the control plane; the upload
// itself gets uploadTimeout, time for its largest file on a slow link.
const (
	requestTimeout = 30 * time.Second
	uploadTimeout  = 5 * time.Minute
)

// Result is an uploaded file's link, and the markdown that shows it.
type Result struct {
	ID          string `json:"id"`
	URL         string `json:"url"`
	PageURL     string `json:"pageUrl"`
	Markdown    string `json:"markdown"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	SizeBytes   int64  `json:"sizeBytes"`
	// Access is who the link opens for: "public", anyone; "private", its
	// uploader alone, signed in to Outrunner.
	Access string `json:"access"`
}

// Options are an upload's name and access.
type Options struct {
	// Name is what the file shows, the markdown's alt text; empty is the
	// file's own name.
	Name string
	// Access is "public" or "private"; empty is Outrunner's default for the
	// type: public for an image, private for a video.
	Access string
}

// Error is a refusal the agent should read and act on: a file too large, a
// type Outrunner doesn't take, an org at its limit.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }

// Client uploads files to the control plane its Config names.
type Client struct {
	gitcred.Config
	// HTTP sends the requests; nil is a client with no timeout of its own
	// (each request has its context's).
	HTTP *http.Client
	// Now is the clock requests are timestamped with; nil is time.Now.
	Now func() time.Time
}

// ContentType is the type a file's first bytes say it is, of those Outrunner
// takes, or "" for anything else. As the control plane's sniffMediaType: it
// checks the stored bytes the same way.
func ContentType(head []byte) string {
	switch {
	case len(head) >= 8 && bytes.Equal(head[:8], []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case len(head) >= 3 && head[0] == 0xff && head[1] == 0xd8 && head[2] == 0xff:
		return "image/jpeg"
	case len(head) >= 6 && (string(head[:6]) == "GIF87a" || string(head[:6]) == "GIF89a"):
		return "image/gif"
	case len(head) >= 12 && string(head[:4]) == "RIFF" && string(head[8:12]) == "WEBP":
		return "image/webp"
	case len(head) >= 12 && string(head[4:8]) == "ftyp":
		return "video/mp4"
	}
	return ""
}

// Upload sends the file at path to Outrunner for the session workspaceID and
// returns its link.
func (c *Client) Upload(ctx context.Context, workspaceID, path string, opts Options) (Result, error) {
	if opts.Access != "" && opts.Access != "public" && opts.Access != "private" {
		return Result{}, &Error{Message: `access is "public" or "private"`}
	}
	f, err := os.Open(path)
	if err != nil {
		return Result{}, &Error{Message: fmt.Sprintf("can't read %s: %v", path, err)}
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return Result{}, err
	}
	if !info.Mode().IsRegular() {
		return Result{}, &Error{Message: path + " isn't a file"}
	}
	if info.Size() == 0 {
		return Result{}, &Error{Message: path + " is empty"}
	}
	if info.Size() > MaxBytes {
		return Result{}, &Error{Message: fmt.Sprintf("%s is %.1f MB; Outrunner takes files up to %d MB. Make it smaller (a GIF: fewer frames per second, or narrower).", path, float64(info.Size())/(1024*1024), MaxBytes/(1024*1024))}
	}
	head := make([]byte, 16)
	n, _ := io.ReadFull(f, head)
	contentType := ContentType(head[:n])
	if contentType == "" {
		return Result{}, &Error{Message: path + " isn't a PNG, JPEG, GIF, WebP or MP4 file. Save the screenshot or recording as one of those."}
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return Result{}, err
	}
	name := opts.Name
	if strings.TrimSpace(name) == "" {
		name = filepath.Base(path)
	}

	var started struct {
		ID        string `json:"id"`
		UploadURL string `json:"uploadUrl"`
	}
	request := map[string]any{
		"workspaceId": workspaceID,
		"name":        name,
		"contentType": contentType,
		"sizeBytes":   info.Size(),
	}
	if opts.Access != "" {
		request["access"] = opts.Access
	}
	if err := c.call(ctx, "/api/runtime/media", "media-upload", request, &started); err != nil {
		return Result{}, err
	}
	if started.ID == "" || started.UploadURL == "" {
		return Result{}, errors.New("Outrunner sent a malformed upload")
	}
	if err := c.put(ctx, started.UploadURL, f, info.Size(), contentType); err != nil {
		return Result{}, err
	}
	var result Result
	if err := c.call(ctx, "/api/runtime/media/complete", "media-complete", map[string]any{
		"workspaceId": workspaceID,
		"id":          started.ID,
	}, &result); err != nil {
		return Result{}, err
	}
	if result.URL == "" || result.Markdown == "" {
		return Result{}, errors.New("Outrunner sent a malformed link")
	}
	return result, nil
}

// Sign is a request's X-Outrunner-Signature: HMAC-SHA256 under the agent's
// secret of the purpose, sandbox, time and body, a line each, as the control
// plane's mediaRequestSignature (lib/media/box-auth.ts).
func Sign(secret, purpose, sandboxID, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(purpose + "\n" + sandboxID + "\n" + timestamp + "\n"))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// call POSTs a signed JSON request to the control plane and reads its JSON
// answer into out.
func (c *Client) call(ctx context.Context, route, purpose string, request any, out any) error {
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	timestamp := strconv.FormatInt(now().Unix(), 10)
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.AppURL+route, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Outrunner-Sandbox", c.SandboxID)
	req.Header.Set("X-Outrunner-Timestamp", timestamp)
	req.Header.Set("X-Outrunner-Signature", Sign(c.Secret, purpose, c.SandboxID, timestamp, body))
	resp, err := c.client().Do(req)
	if err != nil {
		return fmt.Errorf("couldn't reach Outrunner to upload: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("couldn't read Outrunner's answer: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var refusal struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &refusal) == nil && refusal.Error != "" {
			return &Error{Status: resp.StatusCode, Message: refusal.Error}
		}
		return &Error{Status: resp.StatusCode, Message: "Outrunner refused the upload: " + resp.Status}
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("Outrunner sent a malformed answer: %w", err)
	}
	return nil
}

// put sends the bytes to the URL storage signed for them.
func (c *Client) put(ctx context.Context, url string, body io.Reader, size int64, contentType string) error {
	ctx, cancel := context.WithTimeout(ctx, uploadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, body)
	if err != nil {
		return err
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", contentType)
	resp, err := c.client().Do(req)
	if err != nil {
		return fmt.Errorf("couldn't upload the file: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("storage refused the file: %s %s", resp.Status, strings.TrimSpace(string(detail)))
	}
	return nil
}

func (c *Client) client() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

// Text is what a session's agent is told of an uploaded file: the line to
// paste, and where its owner manages it.
func Text(r Result) string {
	if r.Access == "private" {
		return r.Markdown + "\n\nThe link is private: it opens only for the session's owner, signed in to Outrunner. " +
			"In a pull request, show a short GIF made from it that links to it: [![name](gif-url)](" + r.URL + "). " +
			"Upload it again with access public only if it should open for anyone. Manage it at " + r.PageURL + "."
	}
	return r.Markdown + "\n\nPaste that line where the file should show: a pull request's body, an issue, a comment. " +
		"The link is public and doesn't expire; it can be deleted, or the link replaced, at " + r.PageURL + "."
}
