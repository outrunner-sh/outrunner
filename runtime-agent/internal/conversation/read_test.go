package conversation

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadSeeksToATailAndKeepsAbsoluteEventOffsets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "large.jsonl")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	const prefix = 64 << 20
	if _, err := f.Seek(prefix-1, 0); err != nil {
		t.Fatal(err)
	}
	record := `{"type":"user","uuid":"tail","message":{"role":"user","content":"newest prompt"}}` + "\n"
	if _, err := f.WriteString("\n" + record); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	for _, offset := range []int64{prefix - 10, prefix} {
		events, err := Read(path, offset)
		if err != nil {
			t.Fatal(err)
		}
		if len(events) != 1 || events[0].Message.UUID != "tail" || events[0].ID != prefix+int64(len(record)) {
			t.Fatalf("from %d: %+v", offset, events)
		}
	}
	events, err := Read(path, prefix+5)
	if err != nil || len(events) != 0 {
		t.Fatalf("partial record: %+v, %v", events, err)
	}
}
