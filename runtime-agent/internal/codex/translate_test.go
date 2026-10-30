package codex

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the golden translation in testdata")

// translateAll translates a whole rollout at once, as a session's tail does
// when it catches up, and flushes what is left at the end.
func translateAll(t *testing.T, rollout []byte) []byte {
	t.Helper()
	tr := NewTranslator()
	var out bytes.Buffer
	offset := int64(0)
	for _, line := range bytes.SplitAfter(rollout, []byte("\n")) {
		if !bytes.HasSuffix(line, []byte("\n")) {
			break // a partial last line waits for the rest of it
		}
		for _, rec := range tr.Line(offset, line) {
			out.Write(rec.Line)
		}
		offset += int64(len(line))
	}
	for _, rec := range tr.Flush() {
		out.Write(rec.Line)
	}
	return out.Bytes()
}

// The real rollout of a session (codex-cli 0.146.0, redacted): a prompt that
// creates, edits and lists a file through three tool calls; one whose command
// needed approval; one interrupted mid-reply (Codex wrote nothing of it); and
// one after a resume.
func TestTranslateARealRollout(t *testing.T) {
	rollout, err := os.ReadFile(filepath.Join("testdata", "rollout.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	got := translateAll(t, rollout)
	golden := filepath.Join("testdata", "rollout.translated.jsonl")
	if *update {
		if err := os.WriteFile(golden, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("%v (run with -update to write it)", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("translation differs from %s (run with -update after checking it):\n%s", golden, got)
	}
}

// What the golden file must hold, independent of its exact bytes.
func TestTranslationOfTheRealRollout(t *testing.T) {
	rollout, err := os.ReadFile(filepath.Join("testdata", "rollout.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var recs []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(translateAll(t, rollout)), []byte("\n")) {
		var rec map[string]any
		if err := json.Unmarshal(line, &rec); err != nil {
			t.Fatalf("not JSON: %s", line)
		}
		recs = append(recs, rec)
	}
	var prompts, texts []string
	tools, results, usages := 0, 0, 0
	var parent any
	seen := map[string]bool{}
	for i, rec := range recs {
		uuid := rec["uuid"].(string)
		if seen[uuid] {
			t.Errorf("record %d repeats uuid %s", i, uuid)
		}
		seen[uuid] = true
		if rec["parentUuid"] != parent {
			t.Errorf("record %d's parent = %v, want the record before it (%v)", i, rec["parentUuid"], parent)
		}
		parent = uuid
		msg := rec["message"].(map[string]any)
		if msg["usage"] != nil {
			usages++
		}
		if prompt, ok := msg["content"].(string); ok {
			prompts = append(prompts, prompt)
			continue
		}
		for _, b := range msg["content"].([]any) {
			block := b.(map[string]any)
			switch block["type"] {
			case "text":
				texts = append(texts, block["text"].(string))
				if msg["model"] != "gpt-6-luna" {
					t.Errorf("assistant text %q has model %v", block["text"], msg["model"])
				}
			case "tool_use":
				tools++
				if _, ok := block["input"].(map[string]any)["cmd"]; !ok {
					t.Errorf("tool_use input = %v, want the parsed arguments", block["input"])
				}
			case "tool_result":
				results++
				if !strings.HasPrefix(block["toolUseId"].(string), "call_") {
					t.Errorf("tool_result names %v", block["toolUseId"])
				}
			}
		}
	}
	wantPrompts := []string{
		"Create hello.txt containing hi, then edit it so it says hello world, then run ls -la, then reply done in one word.",
		"Run: curl -sI https://example.com (it needs network, so request escalated permissions). Then reply with the status code.",
		"Count slowly from 1 to 200, writing each number on its own line, with a short sentence about each.",
		"Reply with the word resumed.",
	}
	if strings.Join(prompts, "|") != strings.Join(wantPrompts, "|") {
		t.Errorf("prompts = %q\nwant %q (and never the injected context)", prompts, wantPrompts)
	}
	if want := "I’ll create the file, update its text, then list the directory.|done|200|resumed"; strings.Join(texts, "|") != want {
		t.Errorf("assistant texts = %q, want %q", texts, want)
	}
	if tools != 4 || results != 4 {
		t.Errorf("%d tool calls and %d results, want 4 of each", tools, results)
	}
	if usages != 7 {
		t.Errorf("%d records carry usage, want one per model call that reported it (7)", usages)
	}
}

func TestUsageIsInClaudesTerms(t *testing.T) {
	tr := NewTranslator()
	tr.Line(0, []byte(`{"type":"session_meta","payload":{"id":"s1"}}`+"\n"))
	tr.Line(50, []byte(`{"type":"turn_context","payload":{"model":"gpt-5.5"}}`+"\n"))
	if out := tr.Line(100, []byte(`{"timestamp":"t","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}`+"\n")); len(out) != 0 || !tr.Holding() {
		t.Fatalf("an assistant record was released before its usage: %q", out)
	}
	out := tr.Line(200, []byte(`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":17363,"cached_input_tokens":17140,"cache_write_input_tokens":220,"output_tokens":49}}}}`+"\n"))
	if len(out) != 1 {
		t.Fatalf("token_count released %d records, want 1", len(out))
	}
	var rec struct {
		UUID    string `json:"uuid"`
		Message struct {
			Model string `json:"model"`
			Usage Usage  `json:"usage"`
		} `json:"message"`
	}
	if err := json.Unmarshal(out[0].Line, &rec); err != nil {
		t.Fatal(err)
	}
	want := Usage{InputTokens: 3, OutputTokens: 49, CacheCreationInputTokens: 220, CacheReadInputTokens: 17140}
	if rec.Message.Usage != want || rec.Message.Model != "gpt-5.5" || rec.UUID != "codex-s1-100" || out[0].Offset != 100 {
		t.Errorf("record = %+v at %d, want usage %+v on gpt-5.5, uuid codex-s1-100", rec, out[0].Offset, want)
	}
}

func TestHeldRecordsAreReleasedWhenTheNextCallOrPromptBegins(t *testing.T) {
	const (
		call    = `{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"ls\"}","call_id":"c1"}}` + "\n"
		output  = `{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"a\nb"}}` + "\n"
		reply   = `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}` + "\n"
		prompt  = `{"type":"event_msg","payload":{"type":"user_message","message":"next"}}` + "\n"
		garbage = `{"type":"response_item","payload":{"type":"function_c` + "\n"
	)
	tr := NewTranslator()
	if out := tr.Line(0, []byte(call)); len(out) != 0 {
		t.Fatalf("call released early: %d", len(out))
	}
	if out := tr.Line(100, []byte(output)); len(out) != 0 {
		t.Fatalf("its result released before the call's usage: %d", len(out))
	}
	if out := tr.Line(150, []byte(garbage)); len(out) != 0 {
		t.Fatalf("a torn line produced %d records", len(out))
	}
	// A reply with no token_count between: a new model call.
	out := tr.Line(200, []byte(reply))
	if len(out) != 2 || out[0].Offset != 0 || out[1].Offset != 100 {
		t.Fatalf("a new call released %+v, want the call and its result", out)
	}
	out = tr.Line(300, []byte(prompt))
	if len(out) != 2 || out[0].Offset != 200 || out[1].Offset != 300 || tr.Holding() {
		t.Fatalf("a prompt released %+v, want the reply then the prompt", out)
	}
}

func TestToolInputsAndOutputs(t *testing.T) {
	for in, want := range map[string]string{
		`{"cmd":"ls"}`:                     `{"cmd":"ls"}`,
		"*** Begin Patch\n*** End Patch\n": `{"raw":"*** Begin Patch\n*** End Patch\n"}`,
		`["not","an","object"]`:            `{"raw":"[\"not\",\"an\",\"object\"]"}`,
		``:                                 `{"raw":""}`,
	} {
		if got := string(toolInput(in)); got != want {
			t.Errorf("toolInput(%q) = %s, want %s", in, got, want)
		}
	}
	for in, want := range map[string]string{
		`"Exit code: 0"`:                  `"Exit code: 0"`,
		`{"content":"ok","success":true}`: `"ok"`,
		`{"something":"else"}`:            `{"something":"else"}`,
		``:                                `""`,
	} {
		if got := string(toolOutput(json.RawMessage(in))); got != want {
			t.Errorf("toolOutput(%s) = %s, want %s", in, got, want)
		}
	}
}

func TestRecordUUIDsReadBack(t *testing.T) {
	id, offset, ok := RecordOffset(RecordUUID("01a1596f-41f4-7f30-88f4-b569d1b5bf76", 4242))
	if !ok || id != "01a1596f-41f4-7f30-88f4-b569d1b5bf76" || offset != 4242 {
		t.Errorf("read back %q %d %v", id, offset, ok)
	}
	for _, other := range []string{"u1", "codex-", "codex-x-y", "8f0e-…"} {
		if _, _, ok := RecordOffset(other); ok {
			t.Errorf("%q read as a translated record's", other)
		}
	}
}

func TestUsageThatComesLateGoesOnTheNextReply(t *testing.T) {
	const (
		call   = `{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{}","call_id":"c1"}}` + "\n"
		output = `{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"ok"}}` + "\n"
		usage  = `{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":7}}}}` + "\n"
		reply  = `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}` + "\n"
	)
	tr := NewTranslator()
	tr.Line(0, []byte(call))
	// The tool runs long: the caller gives the call up to show it.
	if out := tr.Flush(); len(out) != 1 {
		t.Fatalf("flush released %d records, want the call", len(out))
	}
	tr.Line(100, []byte(output))
	tr.Line(200, []byte(usage)) // the call's usage, after its records went
	tr.Line(300, []byte(reply))
	out := tr.Line(400, []byte(usage)) // the reply's own
	var rec struct {
		Message struct {
			Usage Usage `json:"usage"`
		} `json:"message"`
	}
	if len(out) != 1 || json.Unmarshal(out[0].Line, &rec) != nil {
		t.Fatalf("the reply's usage released %q", out)
	}
	want := Usage{InputTokens: 80, OutputTokens: 14, CacheReadInputTokens: 120}
	if rec.Message.Usage != want {
		t.Errorf("reply usage = %+v, want both calls' %+v", rec.Message.Usage, want)
	}
}

// The context-usage ring is out of the model's window, which only Codex's
// token_count says: it rides on the record that carries the usage.
func TestUsageCarriesTheModelsContextWindow(t *testing.T) {
	tr := NewTranslator()
	tr.Line(0, []byte(`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}`+"\n"))
	out := tr.Line(100, []byte(`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":2},"model_context_window":258400}}}`+"\n"))
	if len(out) != 1 {
		t.Fatalf("token_count released %d records, want 1", len(out))
	}
	var rec struct {
		Message struct {
			ContextWindow int `json:"context_window"`
		} `json:"message"`
	}
	if err := json.Unmarshal(out[0].Line, &rec); err != nil || rec.Message.ContextWindow != 258400 {
		t.Errorf("record = %s, want context_window 258400", out[0].Line)
	}
}

// A compaction is Claude's compact_boundary, and the summary Codex goes on
// from is not shown as anyone's turn.
func TestACompactionIsAClaudeCompactBoundary(t *testing.T) {
	tr := NewTranslator()
	tr.Line(0, []byte(`{"type":"session_meta","payload":{"id":"s1"}}`+"\n"))
	out := tr.Line(50, []byte(`{"timestamp":"t","type":"compacted","payload":{"message":"The user asked for…"}}`+"\n"))
	if len(out) != 1 {
		t.Fatalf("compacted released %d records, want 1", len(out))
	}
	var rec struct {
		Type            string          `json:"type"`
		Subtype         string          `json:"subtype"`
		UUID            string          `json:"uuid"`
		CompactMetadata json.RawMessage `json:"compactMetadata"`
	}
	if err := json.Unmarshal(out[0].Line, &rec); err != nil {
		t.Fatal(err)
	}
	if rec.Type != "system" || rec.Subtype != "compact_boundary" || rec.UUID != "codex-s1-50" || rec.CompactMetadata == nil {
		t.Errorf("record = %s, want a compact_boundary", out[0].Line)
	}
	if strings.Contains(string(out[0].Line), "The user asked for") {
		t.Errorf("the summary was shown: %s", out[0].Line)
	}
}

// A prompt sent in plan mode is shown as typed, marked as Claude marks one.
func TestAPlanModePromptLosesItsPreamble(t *testing.T) {
	tr := NewTranslator()
	prompt, _ := json.Marshal(PlanPreamble + "Add dark mode")
	out := tr.Line(0, []byte(`{"type":"event_msg","payload":{"type":"user_message","message":`+string(prompt)+`}}`+"\n"))
	var rec struct {
		PermissionMode string `json:"permissionMode"`
		Message        struct {
			Content string `json:"content"`
		} `json:"message"`
	}
	if len(out) != 1 || json.Unmarshal(out[0].Line, &rec) != nil {
		t.Fatalf("released %q", out)
	}
	if rec.Message.Content != "Add dark mode" || rec.PermissionMode != "plan" {
		t.Errorf("record = %+v, want the prompt alone, in plan mode", rec)
	}
	out = tr.Line(100, []byte(`{"type":"event_msg","payload":{"type":"user_message","message":"Build it"}}`+"\n"))
	if len(out) != 1 || strings.Contains(string(out[0].Line), "permissionMode") {
		t.Errorf("a prompt in build mode = %q, want no mode", out)
	}
}

// A call's usage that came late rides on the next call's record, for the
// session's totals; the context that record shows is its own call's alone,
// not the two summed, and out of Codex's window.
func TestLateUsageIsntCountedAsContext(t *testing.T) {
	tr := NewTranslator()
	count := func(input, output int) []byte {
		return []byte(`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":` +
			strconv.Itoa(input) + `,"cached_input_tokens":` + strconv.Itoa(input-10) + `,"output_tokens":` + strconv.Itoa(output) + `},"model_context_window":258400}}}` + "\n")
	}
	tr.Line(0, []byte(`{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{}","call_id":"c1"}}`+"\n"))
	tr.Flush() // the tool ran longer than the caller waits
	tr.Line(100, count(50_000, 100))
	tr.Line(200, []byte(`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}`+"\n"))
	out := tr.Line(300, count(51_000, 20))
	if len(out) != 1 {
		t.Fatalf("released %d records", len(out))
	}
	var rec struct {
		Message struct {
			Usage         Usage `json:"usage"`
			ContextTokens int   `json:"context_tokens"`
			ContextWindow int   `json:"context_window"`
		} `json:"message"`
	}
	if err := json.Unmarshal(out[0].Line, &rec); err != nil {
		t.Fatal(err)
	}
	m := rec.Message
	if m.ContextTokens != 51_020 || m.ContextWindow != 258400 {
		t.Errorf("context = %d of %d, want the last call's 51020 of 258400", m.ContextTokens, m.ContextWindow)
	}
	if total := m.Usage.InputTokens + m.Usage.CacheReadInputTokens; total != 101_000 {
		t.Errorf("usage input = %d, want both calls' kept for the totals", total)
	}
}

func TestTranslationPreservesWhetherAssistantWorkContinues(t *testing.T) {
	for _, tc := range []struct{ payload, want string }{
		{`{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Working."}]}`, "in_progress"},
		{`{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Done."}]}`, "end_turn"},
		{`{"type":"reasoning","summary":[{"type":"summary_text","text":"Thinking"}]}`, "in_progress"},
		{`{"type":"function_call","call_id":"c1","name":"exec","arguments":"{}"}`, "tool_use"},
	} {
		out := translateAll(t, []byte(`{"type":"response_item","payload":`+tc.payload+"}\n"))
		var rec struct {
			Message struct {
				StopReason string `json:"stop_reason"`
			} `json:"message"`
		}
		if err := json.Unmarshal(bytes.TrimSpace(out), &rec); err != nil {
			t.Fatal(err)
		}
		if rec.Message.StopReason != tc.want {
			t.Errorf("payload %s: stop reason %q, want %q", tc.payload, rec.Message.StopReason, tc.want)
		}
	}
}
