package desktop

import (
	"encoding/json"
	"strings"
	"testing"
)

func val(v string) *AXValue {
	raw, _ := json.Marshal(v)
	return &AXValue{Value: raw}
}

func node(id, parent, role, name string, backend int, children ...string) AXNode {
	n := AXNode{NodeID: id, ParentID: parent, Role: val(role), BackendDOMNodeID: backend, ChildIDs: children}
	if name != "" {
		n.Name = val(name)
	}
	return n
}

func TestATreeReadsAsOneLineAnElementWithRefs(t *testing.T) {
	email := node("5", "3", "textbox", "Email", 52)
	email.Value = val("ada@example.com")
	email.ChildIDs = []string{"9"}
	agree := node("6", "3", "checkbox", "I agree", 53)
	agree.Properties = []AXProp{{Name: "checked", Value: *val("true")}, {Name: "disabled", Value: AXValue{Value: json.RawMessage("false")}}}
	heading := node("2", "1", "heading", "Join the waitlist", 50, "8")
	heading.Properties = []AXProp{{Name: "level", Value: AXValue{Value: json.RawMessage("1")}}}
	hidden := node("7", "3", "button", "Hidden", 54)
	hidden.Ignored = true
	nodes := []AXNode{
		node("1", "", "RootWebArea", "Signup", 1, "2", "3", "4"),
		heading,
		node("3", "1", "generic", "", 51, "5", "6", "7"), // a wrapper: its children are raised
		node("4", "1", "paragraph", "", 55, "10"),
		email,
		agree,
		hidden,
		node("8", "2", "StaticText", "Join the waitlist", 0), // repeats its heading's name
		node("9", "5", "StaticText", "ada@example.com", 0),   // repeats the field's value
		node("10", "4", "StaticText", "Thanks!", 0),
	}
	got := FormatTree(nodes, 100)
	want := strings.Join([]string{
		`- document "Signup"`,
		`  - heading "Join the waitlist" [level=1] [ref=e50]`,
		`  - textbox "Email" value="ada@example.com" [ref=e52]`,
		`  - checkbox "I agree" [checked] [ref=e53]`,
		`  - paragraph [ref=e55]`,
		`    - text "Thanks!"`,
	}, "\n")
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func TestALongTreeIsCutAndSaysSo(t *testing.T) {
	nodes := []AXNode{node("0", "", "RootWebArea", "Long", 1)}
	for i := 1; i <= 20; i++ {
		id := string(rune('a' + i))
		nodes[0].ChildIDs = append(nodes[0].ChildIDs, id)
		nodes = append(nodes, node(id, "0", "link", strings.Repeat("x", 200), 100+i))
	}
	got := FormatTree(nodes, 5)
	lines := strings.Split(got, "\n")
	if len(lines) != 6 || !strings.HasPrefix(lines[5], "… 16 more not shown") {
		t.Fatalf("got\n%s", got)
	}
	if !strings.Contains(lines[1], strings.Repeat("x", maxNameLength)+"…") {
		t.Errorf("a long name wasn't cut: %s", lines[1])
	}
}

func TestATreeWithALoopEnds(t *testing.T) {
	nodes := []AXNode{node("1", "", "RootWebArea", "Loop", 1, "2"), node("2", "1", "group", "g", 2, "1")}
	if got := FormatTree(nodes, 10); strings.Count(got, "\n") != 1 {
		t.Fatalf("got\n%s", got)
	}
}

func TestRefsAreReadBackAsDOMNodes(t *testing.T) {
	if n, err := ParseRef(" e123 "); err != nil || n != 123 {
		t.Fatalf("ParseRef(e123) = %d, %v", n, err)
	}
	for _, bad := range []string{"", "123", "e", "e-1", "e0", "ref=e1", "x12"} {
		if _, err := ParseRef(bad); err == nil {
			t.Errorf("ParseRef(%q) took it", bad)
		}
	}
}
