package ask

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// The relay is the MCP server the agent's CLI launches over stdio. It holds no
// question itself: each call is forwarded to the runtime-agent, found afresh
// every time from the address it announces (AddrFile). The desktop app starts
// a new agent, on a new port, every time it launches, while the sessions in
// tmux, and their relays, carry on; a call cut off that way is asked again of
// the new agent, under the same request id.

// RelayConfig says where the relay finds the runtime-agent.
type RelayConfig struct {
	WorkspaceID string
	// AddrFile holds the agent's host:port, rewritten each time it starts.
	AddrFile string
	// TokenFile holds the session's ask token, the agent's proof that a call
	// comes from that session.
	TokenFile string
	// Client sends the calls; nil is a client with no timeout, since a call
	// waits as long as the user takes.
	Client *http.Client
	// RetryFor is how long an agent that can't be reached is tried again
	// before the call fails; zero is ten minutes.
	RetryFor time.Duration
	// RetryEvery is the pause between tries; zero is a second.
	RetryEvery time.Duration
}

// protocolVersions are the MCP versions the relay speaks: its few methods are
// the same in each. A client asking for another gets the newest.
var protocolVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

const toolDescription = `Ask the user one to four multiple-choice questions and wait for their answers. Use it whenever you need the user to decide something, state a preference or give information you can't find yourself before you go on. Outrunner shows the questions in place of the chat box. Give each question 2 to 4 options with a short label and a description of what it means. The user can always type their own answer, so never add an "Other" option. If you recommend an option, list it first and end its label with "(Recommended)". Set multiSelect when more than one option can apply.`

const serverInstructions = "To ask the user a question with choices, call ask_user rather than asking in plain text: Outrunner shows it as a card the user answers with a click. Whenever you need a secret, API key, token, password or private key you don't have, call request_secrets: never ask the user to paste one into the chat. To show a screenshot or recording in a pull request, call upload_media with its file and paste the markdown line it returns."

const secretsToolDescription = `Ask the user for secrets you need and don't have (API keys, tokens, passwords, private keys) and wait for them. Outrunner shows a form in place of the chat box; the values go straight into this session's environment and never into the conversation. Use it instead of ever asking the user to paste a secret in chat. Name each variable as the code reads it (e.g. STRIPE_SECRET_KEY), say in reason what you'll use them for, and mark a variable optional when the work can go on without it. The result says which were provided; they're in your Bash environment from your next command. Never print, echo, log or commit a value. If the user skips the request, don't ask again: use a local substitute or explain why it's needed.`

const mediaToolDescription = `Upload a screenshot or screen recording from this computer to Outrunner and get a public link that GitHub shows, with the markdown line to paste: ![name](url). Use it to prove a change a person can see in a pull request: before and after screenshots, or a GIF of anything that moves. Takes PNG, JPEG, GIF, WebP and MP4 files up to 50 MB. GitHub shows images inline but doesn't play an MP4, so show a recording as a short GIF (under 5 MB: GitHub's image proxy won't show a larger one). An image's link is public and doesn't expire: never upload anything secret. Upload only what goes in the pull request; screenshots you take to check your own work stay on the box.`

var mediaInputSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "path": {"type": "string", "description": "The file to upload, absolute or relative to the session's working folder."},
    "name": {"type": "string", "description": "What it shows, descriptive and unique, the markdown's alt text, e.g. \"Settings page on a phone, after\". Never just \"screenshot\"."},
    "access": {"type": "string", "enum": ["public", "private"], "description": "Who the link opens for. Images default to public; videos to private (only the session's owner), unless public is asked for."}
  },
  "required": ["path", "name"]
}`)

var secretsInputSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "reason": {"type": "string", "description": "What you'll use them for, in one sentence the user reads on the form."},
    "keys": {
      "type": "array",
      "minItems": 1,
      "maxItems": 10,
      "items": {
        "type": "object",
        "properties": {
          "name": {"type": "string", "description": "The environment variable, e.g. OPENAI_API_KEY."},
          "description": {"type": "string", "description": "Where to find it or what kind, e.g. \"A test-mode secret key from the Stripe dashboard\"."},
          "optional": {"type": "boolean", "description": "Whether the work can go on without it."}
        },
        "required": ["name"]
      }
    }
  },
  "required": ["reason", "keys"]
}`)

// inputSchema is AskUserQuestion's, so the agents ask the same way.
var inputSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "questions": {
      "type": "array",
      "minItems": 1,
      "maxItems": 4,
      "description": "The questions to ask, shown one at a time.",
      "items": {
        "type": "object",
        "properties": {
          "question": {"type": "string", "description": "The complete question, ending with a question mark."},
          "header": {"type": "string", "description": "A very short label shown above the question (at most 12 characters), e.g. \"Auth method\"."},
          "options": {
            "type": "array",
            "minItems": 2,
            "maxItems": 4,
            "items": {
              "type": "object",
              "properties": {
                "label": {"type": "string", "description": "The choice, in 1 to 5 words."},
                "description": {"type": "string", "description": "What choosing it means, its trade-offs."}
              },
              "required": ["label"]
            }
          },
          "multiSelect": {"type": "boolean", "description": "Whether the user may pick more than one option."}
        },
        "required": ["question", "options"]
      }
    }
  },
  "required": ["questions"]
}`)

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// Relay serves MCP on in and out until in ends (the CLI closed it) or ctx
// does.
func Relay(ctx context.Context, in io.Reader, out io.Writer, cfg RelayConfig) error {
	if cfg.Client == nil {
		cfg.Client = &http.Client{}
	}
	if cfg.RetryFor == 0 {
		cfg.RetryFor = 10 * time.Minute
	}
	if cfg.RetryEvery == 0 {
		cfg.RetryEvery = time.Second
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	r := &relay{cfg: cfg, out: out, calls: map[string]context.CancelFunc{}}
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var msg rpcMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			r.send(rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{Code: -32700, Message: "parse error"}})
			continue
		}
		r.handle(ctx, msg)
	}
	cancel()
	r.wg.Wait()
	return scanner.Err()
}

type relay struct {
	cfg   RelayConfig
	outMu sync.Mutex
	out   io.Writer
	wg    sync.WaitGroup

	callsMu sync.Mutex
	calls   map[string]context.CancelFunc // in-flight tools/call by request id
}

func (r *relay) send(resp rpcResponse) {
	data, err := json.Marshal(resp)
	if err != nil {
		return
	}
	r.outMu.Lock()
	defer r.outMu.Unlock()
	_, _ = r.out.Write(append(data, '\n'))
}

func (r *relay) result(id json.RawMessage, result any) {
	r.send(rpcResponse{JSONRPC: "2.0", ID: id, Result: result})
}

func (r *relay) handle(ctx context.Context, msg rpcMessage) {
	notification := len(msg.ID) == 0
	switch msg.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(msg.Params, &params)
		version := protocolVersions[0]
		for _, v := range protocolVersions {
			if v == params.ProtocolVersion {
				version = v
			}
		}
		r.result(msg.ID, map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": ServerName, "version": "1"},
			"instructions":    serverInstructions,
		})
	case "ping":
		r.result(msg.ID, map[string]any{})
	case "tools/list":
		r.result(msg.ID, map[string]any{"tools": []any{
			map[string]any{
				"name":        ToolName,
				"title":       "Ask the user",
				"description": toolDescription,
				"inputSchema": inputSchema,
				"annotations": map[string]any{"readOnlyHint": true, "openWorldHint": false},
			},
			map[string]any{
				"name":        SecretsToolName,
				"title":       "Ask the user for secrets",
				"description": secretsToolDescription,
				"inputSchema": secretsInputSchema,
				"annotations": map[string]any{"readOnlyHint": false, "openWorldHint": false},
			},
			map[string]any{
				"name":        MediaToolName,
				"title":       "Upload a screenshot or recording",
				"description": mediaToolDescription,
				"inputSchema": mediaInputSchema,
				"annotations": map[string]any{"readOnlyHint": false, "openWorldHint": true},
			},
		}})
	case "tools/call":
		r.startCall(ctx, msg)
	case "notifications/cancelled":
		var params struct {
			RequestID json.RawMessage `json:"requestId"`
		}
		if json.Unmarshal(msg.Params, &params) == nil {
			r.callsMu.Lock()
			if cancel := r.calls[string(params.RequestID)]; cancel != nil {
				cancel()
			}
			r.callsMu.Unlock()
		}
	default:
		if !notification {
			r.send(rpcResponse{JSONRPC: "2.0", ID: msg.ID, Error: &rpcError{Code: -32601, Message: "method not found: " + msg.Method}})
		}
	}
}

// startCall answers a tools/call once the user has, which may take as long as
// they take: other messages (a ping, its cancellation) are read meanwhile.
func (r *relay) startCall(ctx context.Context, msg rpcMessage) {
	key := string(msg.ID)
	callCtx, cancel := context.WithCancel(ctx)
	r.callsMu.Lock()
	r.calls[key] = cancel
	r.callsMu.Unlock()
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		defer func() {
			r.callsMu.Lock()
			delete(r.calls, key)
			r.callsMu.Unlock()
			cancel()
		}()
		text, failed := r.call(callCtx, msg.Params)
		if callCtx.Err() != nil {
			return // cancelled: MCP sends no response
		}
		r.result(msg.ID, map[string]any{
			"content": []any{map[string]any{"type": "text", "text": text}},
			"isError": failed,
		})
	}()
}

// call forwards a tools/call to the agent, returning the tool's text and
// whether it is an error.
func (r *relay) call(ctx context.Context, raw json.RawMessage) (string, bool) {
	var params struct {
		Name      string `json:"name"`
		Arguments struct {
			Questions json.RawMessage `json:"questions"`
			Reason    json.RawMessage `json:"reason"`
			Keys      json.RawMessage `json:"keys"`
			Path      string          `json:"path"`
			Name      string          `json:"name"`
			Access    string          `json:"access"`
		} `json:"arguments"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return "malformed tool call", true
	}
	var route string
	var request map[string]any
	switch params.Name {
	case ToolName:
		if len(params.Arguments.Questions) == 0 {
			return "ask_user needs questions", true
		}
		route, request = "ask", map[string]any{"questions": params.Arguments.Questions}
	case SecretsToolName:
		if len(params.Arguments.Keys) == 0 {
			return "request_secrets needs keys", true
		}
		reason := params.Arguments.Reason
		if len(reason) == 0 {
			reason = json.RawMessage(`""`)
		}
		route, request = "ask-secrets", map[string]any{"reason": reason, "keys": params.Arguments.Keys}
	case MediaToolName:
		if params.Arguments.Path == "" {
			return "upload_media needs the path of the file to upload", true
		}
		route, request = "media", map[string]any{"path": params.Arguments.Path, "name": params.Arguments.Name, "access": params.Arguments.Access}
	default:
		return "unknown tool " + params.Name, true
	}
	request["requestId"] = newRequestID()
	body, err := json.Marshal(request)
	if err != nil {
		return err.Error(), true
	}

	var unreachableSince time.Time
	for {
		text, failed, err := r.post(ctx, route, body)
		if err == nil {
			return text, failed
		}
		if ctx.Err() != nil {
			return "", true
		}
		if unreachableSince.IsZero() {
			unreachableSince = time.Now()
		} else if time.Since(unreachableSince) > r.cfg.RetryFor {
			return "Outrunner couldn't be reached to show the question (" + err.Error() + "). Ask the user in plain text instead.", true
		}
		select {
		case <-ctx.Done():
			return "", true
		case <-time.After(r.cfg.RetryEvery):
		}
	}
}

// errUnreachable is an agent that isn't there to answer: not started yet,
// restarting, or gone mid-call. The call is tried again.
var errUnreachable = errors.New("runtime-agent unreachable")

// post sends the call to the agent once. An error means it should be tried
// again; an answer, even a refusal, is returned as the tool's text.
func (r *relay) post(ctx context.Context, route string, body []byte) (string, bool, error) {
	addr, err := readTrimmed(r.cfg.AddrFile)
	if err != nil {
		return "", false, fmt.Errorf("%w: %v", errUnreachable, err)
	}
	token, err := readTrimmed(r.cfg.TokenFile)
	if err != nil {
		return "This session can't ask questions in Outrunner (" + err.Error() + "). Ask the user in plain text instead.", true, nil
	}
	url := "http://" + addr + "/workspaces/" + r.cfg.WorkspaceID + "/" + route
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err.Error(), true, nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := r.cfg.Client.Do(req)
	if err != nil {
		return "", false, fmt.Errorf("%w: %v", errUnreachable, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", false, fmt.Errorf("%w: %v", errUnreachable, err) // cut off mid-answer
	}
	switch {
	case resp.StatusCode == http.StatusOK:
		var answer struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(data, &answer); err != nil {
			return "malformed answer from Outrunner", true, nil
		}
		return answer.Text, false, nil
	case resp.StatusCode == http.StatusBadGateway, resp.StatusCode == http.StatusServiceUnavailable, resp.StatusCode == http.StatusGatewayTimeout:
		return "", false, fmt.Errorf("%w: %s", errUnreachable, resp.Status)
	default:
		var e struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &e) == nil && e.Error.Message != "" {
			return e.Error.Message, true, nil
		}
		return "Outrunner refused the request: " + resp.Status, true, nil
	}
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

// newRequestID names one tool call, across the relay's tries.
func newRequestID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
