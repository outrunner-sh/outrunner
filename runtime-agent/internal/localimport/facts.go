package localimport

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"unicode/utf8"
)

// transcriptFacts is what the picker shows of a session, read from the start
// and end of its transcript only: a long session's log runs to tens of MB.
type transcriptFacts struct {
	// Cwd is where the session began, the folder its agent files it under.
	Cwd string `json:"cwd,omitempty"`
	// Branch is the git branch the session was last on.
	Branch      string `json:"branch,omitempty"`
	Title       string `json:"title,omitempty"`
	Model       string `json:"model,omitempty"`
	StartedAt   string `json:"startedAt,omitempty"`
	UpdatedAt   string `json:"updatedAt,omitempty"`
	LastMessage string `json:"lastMessage,omitempty"`
}

const (
	// headLines and headBytes bound the start read: the first prompt and the
	// working directory come within the first few records.
	headLines = 50
	headBytes = 1 << 20
	// tailBytes is how much of the end is read for the latest of everything.
	tailBytes = 64 << 10
	// titleRunes and messageRunes bound what is kept of a title or message.
	titleRunes   = 80
	messageRunes = 200
)

// readFacts reads a transcript of the given agent's.
func readFacts(agent, path string) (transcriptFacts, error) {
	file, err := os.Open(path)
	if err != nil {
		return transcriptFacts{}, err
	}
	defer file.Close()
	read := claudeLine
	if agent == AgentCodex {
		read = codexLine
	}

	var head, tail transcriptFacts
	reader := bufio.NewReader(io.LimitReader(file, headBytes))
	for range headLines {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			read(&head, line, true)
		}
		if err != nil {
			break
		}
	}

	info, err := file.Stat()
	if err != nil {
		return transcriptFacts{}, err
	}
	start := max(info.Size()-tailBytes, 0)
	buf := make([]byte, info.Size()-start)
	if _, err := file.ReadAt(buf, start); err != nil && err != io.EOF {
		return transcriptFacts{}, err
	}
	lines := bytes.Split(buf, []byte("\n"))
	if start > 0 && len(lines) > 0 {
		lines = lines[1:] // begins mid-line
	}
	for _, line := range lines {
		if len(line) > 0 {
			read(&tail, line, false)
		}
	}

	// The start says where it began; the end says where it is now.
	return transcriptFacts{
		Cwd:         either(head.Cwd, tail.Cwd),
		Branch:      either(tail.Branch, head.Branch),
		Title:       either(tail.Title, head.Title),
		Model:       either(tail.Model, head.Model),
		StartedAt:   head.StartedAt,
		UpdatedAt:   either(tail.UpdatedAt, head.UpdatedAt),
		LastMessage: either(tail.LastMessage, head.LastMessage),
	}, nil
}

// either is a, else b.
func either(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// claudeRecord is the part of a Claude Code JSONL record read here.
type claudeRecord struct {
	Type        string `json:"type"`
	Cwd         string `json:"cwd"`
	GitBranch   string `json:"gitBranch"`
	Timestamp   string `json:"timestamp"`
	IsSidechain bool   `json:"isSidechain"`
	IsMeta      bool   `json:"isMeta"`
	AITitle     string `json:"aiTitle"`
	Message     struct {
		Role    string          `json:"role"`
		Model   string          `json:"model"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// claudeLine folds one record into f: the first of each fact from the head,
// the last from the tail.
func claudeLine(f *transcriptFacts, line []byte, head bool) {
	var rec claudeRecord
	if json.Unmarshal(line, &rec) != nil || rec.IsSidechain {
		return
	}
	set := func(field *string, value string) {
		if value != "" && (!head || *field == "") {
			*field = value
		}
	}
	if rec.Type == "ai-title" {
		// The latest title is the best one, wherever it is read.
		set(&f.Title, oneLine(rec.AITitle, titleRunes))
		return
	}
	if rec.Type != "user" && rec.Type != "assistant" {
		return
	}
	set(&f.Cwd, rec.Cwd)
	if rec.GitBranch != "HEAD" {
		set(&f.Branch, rec.GitBranch)
	}
	if head {
		set(&f.StartedAt, rec.Timestamp)
	}
	set(&f.UpdatedAt, rec.Timestamp)
	text := messageText(rec.Message.Content)
	switch rec.Type {
	case "user":
		if head && !rec.IsMeta && f.Title == "" {
			f.Title = oneLine(withoutSystemInstruction(text), titleRunes)
		}
	case "assistant":
		set(&f.Model, rec.Message.Model)
		set(&f.LastMessage, oneLine(text, messageRunes))
	}
}

// codexRecord is the part of a Codex rollout line read here.
type codexRecord struct {
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Payload   struct {
		Type    string `json:"type"`
		Cwd     string `json:"cwd"`
		Model   string `json:"model"`
		Message string `json:"message"`
		Git     *struct {
			Branch string `json:"branch"`
		} `json:"git"`
	} `json:"payload"`
}

func codexLine(f *transcriptFacts, line []byte, head bool) {
	var rec codexRecord
	if json.Unmarshal(line, &rec) != nil {
		return
	}
	set := func(field *string, value string) {
		if value != "" && (!head || *field == "") {
			*field = value
		}
	}
	if head {
		set(&f.StartedAt, rec.Timestamp)
	}
	set(&f.UpdatedAt, rec.Timestamp)
	switch {
	case rec.Type == "session_meta":
		set(&f.Cwd, rec.Payload.Cwd)
		if rec.Payload.Git != nil {
			set(&f.Branch, rec.Payload.Git.Branch)
		}
	case rec.Type == "turn_context":
		set(&f.Cwd, rec.Payload.Cwd)
		set(&f.Model, rec.Payload.Model)
	case rec.Type == "event_msg" && rec.Payload.Type == "user_message":
		if head && f.Title == "" {
			f.Title = oneLine(withoutSystemInstruction(rec.Payload.Message), titleRunes)
		}
	case rec.Type == "event_msg" && rec.Payload.Type == "agent_message":
		set(&f.LastMessage, oneLine(rec.Payload.Message, messageRunes))
	}
}

// messageText is a message's text: a string, or its text parts joined.
// Tool calls and results are not text.
func messageText(content json.RawMessage) string {
	var s string
	if json.Unmarshal(content, &s) == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(content, &parts) != nil {
		return ""
	}
	var texts []string
	for _, p := range parts {
		if p.Type == "text" && p.Text != "" {
			texts = append(texts, p.Text)
		}
	}
	return strings.Join(texts, " ")
}

// withoutSystemInstruction drops the orientation Conductor puts before the
// user's first prompt, which would otherwise be every session's title.
func withoutSystemInstruction(text string) string {
	const end = "</system_instruction>"
	if strings.HasPrefix(strings.TrimSpace(text), "<system_instruction>") {
		if _, after, ok := strings.Cut(text, end); ok {
			return after
		}
	}
	return text
}

// oneLine collapses whitespace and cuts to at most n runes.
func oneLine(text string, n int) string {
	text = strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(text) <= n {
		return text
	}
	runes := []rune(text)
	return strings.TrimSpace(string(runes[:n-1])) + "…"
}
