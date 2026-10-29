package desktop

import (
	"encoding/json"
	"fmt"
	"strings"
)

// AXNode is one node of a page's accessibility tree as DevTools gives it
// (Accessibility.getFullAXTree): its role and name, as a screen reader would
// read them, and the DOM node behind it, which a ref names.
type AXNode struct {
	NodeID           string   `json:"nodeId"`
	Ignored          bool     `json:"ignored"`
	Role             *AXValue `json:"role"`
	Name             *AXValue `json:"name"`
	Value            *AXValue `json:"value"`
	Properties       []AXProp `json:"properties"`
	ChildIDs         []string `json:"childIds"`
	ParentID         string   `json:"parentId"`
	BackendDOMNodeID int      `json:"backendDOMNodeId"`
}

type AXValue struct {
	Value json.RawMessage `json:"value"`
}

type AXProp struct {
	Name  string  `json:"name"`
	Value AXValue `json:"value"`
}

// text is a value as text: a string as is, anything else as JSON.
func (v *AXValue) text() string {
	if v == nil || len(v.Value) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(v.Value, &s) == nil {
		return s
	}
	return string(v.Value)
}

// hiddenRoles carry nothing a reader needs: layout wrappers, and the pieces
// a text is broken into. Their children are read in their place.
var hiddenRoles = map[string]bool{
	"generic": true, "none": true, "presentation": true, "InlineTextBox": true,
	"LineBreak": true, "ListMarker": true,
}

// shownProps are the states worth a word in a snapshot, as Playwright's
// snapshots show them.
var shownProps = []string{"checked", "selected", "expanded", "pressed", "disabled", "focused", "required", "level"}

// maxNameLength cuts a long name (a paragraph's text) short.
const maxNameLength = 120

// FormatTree renders a page's accessibility tree the way an agent reads it
// best: one line a node, indented by depth, its role, name and states, and a
// ref (e<DOM node>) for each element, which browser_click and browser_fill
// take. Wrappers and nodes hidden from the tree are left out and their
// children raised; a text that only repeats its parent's name is left out
// too. Past maxLines the rest is cut, and the cut says so.
func FormatTree(nodes []AXNode, maxLines int) string {
	if len(nodes) == 0 {
		return "(the page has nothing in it yet)"
	}
	byID := make(map[string]*AXNode, len(nodes))
	for i := range nodes {
		byID[nodes[i].NodeID] = &nodes[i]
	}
	root := &nodes[0]
	for i := range nodes {
		if nodes[i].ParentID == "" {
			root = &nodes[i]
			break
		}
	}
	f := &treeFormatter{byID: byID, maxLines: maxLines, seen: map[string]bool{}}
	f.walk(root, 0, "")
	out := strings.Join(f.lines, "\n")
	if f.cut > 0 {
		out += fmt.Sprintf("\n… %d more not shown: scroll, or go to the part of the page you need, and take another snapshot.", f.cut)
	}
	return out
}

type treeFormatter struct {
	byID     map[string]*AXNode
	maxLines int
	lines    []string
	cut      int
	seen     map[string]bool
}

func (f *treeFormatter) emit(line string) {
	if len(f.lines) >= f.maxLines {
		f.cut++
		return
	}
	f.lines = append(f.lines, line)
}

func (f *treeFormatter) children(n *AXNode, depth int, parentName string) {
	for _, id := range n.ChildIDs {
		if child := f.byID[id]; child != nil {
			f.walk(child, depth, parentName)
		}
	}
}

// walk renders n at depth; parentName is the name (and value) of the
// nearest node shown above it, which a text repeating it adds nothing to.
func (f *treeFormatter) walk(n *AXNode, depth int, parentName string) {
	if f.seen[n.NodeID] {
		return // a malformed tree's loop
	}
	f.seen[n.NodeID] = true
	role, name := n.Role.text(), strings.TrimSpace(n.Name.text())
	if n.Ignored || (hiddenRoles[role] && name == "") {
		f.children(n, depth, parentName)
		return
	}
	indent := strings.Repeat("  ", depth)
	if role == "StaticText" {
		if name != "" && !strings.Contains(parentName, name) {
			f.emit(fmt.Sprintf("%s- text %q", indent, shorten(name)))
		}
		return
	}
	if role == "RootWebArea" {
		role = "document"
	}
	var b strings.Builder
	b.WriteString(indent + "- " + role)
	if name != "" {
		fmt.Fprintf(&b, " %q", shorten(name))
	}
	if value := strings.TrimSpace(n.Value.text()); value != "" && value != name {
		fmt.Fprintf(&b, " value=%q", shorten(value))
	}
	for _, want := range shownProps {
		for _, p := range n.Properties {
			if p.Name != want {
				continue
			}
			switch v := p.Value.text(); v {
			case "false", "":
			case "true":
				b.WriteString(" [" + want + "]")
			default:
				b.WriteString(" [" + want + "=" + v + "]")
			}
		}
	}
	if n.BackendDOMNodeID > 0 && role != "document" {
		fmt.Fprintf(&b, " [ref=e%d]", n.BackendDOMNodeID)
	}
	f.emit(b.String())
	// A field's text is its value, shown already.
	f.children(n, depth+1, name+"\n"+n.Value.text())
}

func shorten(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > maxNameLength {
		return string(r[:maxNameLength]) + "…"
	}
	return s
}
