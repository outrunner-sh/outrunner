package dotenv

import (
	"reflect"
	"testing"
)

func TestParseReadsWhatLoadersRead(t *testing.T) {
	content := "# comment\n" +
		"PLAIN=value # trailing\n" +
		"export EXPORTED=yes\n" +
		"SINGLE='it''s raw # not a comment'\n" +
		"DOUBLE=\"line one\\nline two \\\"quoted\\\"\"\n" +
		"MULTI=\"first\nsecond\"\n" +
		"EMPTY=\n" +
		"  SPACED = padded  \n" +
		"not an assignment\n" +
		"URL=postgres://u:p@h/db?x=1#frag\n"
	want := []Entry{
		{"PLAIN", "value"},
		{"EXPORTED", "yes"},
		{"SINGLE", "it"},
		{"DOUBLE", "line one\nline two \"quoted\""},
		{"MULTI", "first\nsecond"},
		{"EMPTY", ""},
		{"SPACED", "padded"},
		{"URL", "postgres://u:p@h/db?x=1#frag"},
	}
	if got := Parse(content); !reflect.DeepEqual(got, want) {
		t.Errorf("Parse =\n%q\nwant\n%q", got, want)
	}
}
