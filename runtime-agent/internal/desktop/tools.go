package desktop

import "encoding/json"

// tool is one tool as tools/list describes it.
type tool struct {
	Name         string          `json:"name"`
	Title        string          `json:"title"`
	Description  string          `json:"description"`
	InputSchema  json.RawMessage `json:"inputSchema"`
	OutputSchema json.RawMessage `json:"outputSchema,omitempty"`
	Annotations  map[string]any  `json:"annotations"`
}

var (
	noArgs = json.RawMessage(`{"type": "object", "properties": {}}`)
	xy     = json.RawMessage(`{
  "type": "object",
  "properties": {
    "x": {"type": "integer", "minimum": 0, "description": "Pixels from the screen's left edge, read off the latest screenshot."},
    "y": {"type": "integer", "minimum": 0, "description": "Pixels from the screen's top edge."}
  },
  "required": ["x", "y"]
}`)
)

func readOnly(world bool) map[string]any {
	return map[string]any{"readOnlyHint": true, "openWorldHint": world}
}

func acts(world bool) map[string]any {
	return map[string]any{"readOnlyHint": false, "destructiveHint": false, "openWorldHint": world}
}

// tools are the server's tools, in the order an agent meets them.
var tools = []tool{
	{
		Name:        ToolScreenshot,
		Title:       "Screenshot the desktop",
		Description: "Take a screenshot of the whole desktop and see it. Also saved as a JPEG under .context/desktop/ in the session's folder; the result gives its path, for embedding in your reply. Coordinates for click and the other pointer tools are this image's pixels.",
		InputSchema: noArgs,
		Annotations: readOnly(false),
	},
	{
		Name:        ToolClick,
		Title:       "Click",
		Description: "Click at a point on the desktop. For a web page, browser_click by ref is more reliable.",
		InputSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "x": {"type": "integer", "minimum": 0, "description": "Pixels from the screen's left edge, read off the latest screenshot."},
    "y": {"type": "integer", "minimum": 0, "description": "Pixels from the screen's top edge."},
    "button": {"type": "string", "enum": ["left", "right", "middle"], "description": "Left unless given."}
  },
  "required": ["x", "y"]
}`),
		Annotations: acts(false),
	},
	{
		Name:        ToolDoubleClick,
		Title:       "Double-click",
		Description: "Double-click at a point on the desktop: to open a file or select a word.",
		InputSchema: xy,
		Annotations: acts(false),
	},
	{
		Name:        ToolDrag,
		Title:       "Drag",
		Description: "Press the left button at one point, move to another and release it there.",
		InputSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "from_x": {"type": "integer", "minimum": 0},
    "from_y": {"type": "integer", "minimum": 0},
    "to_x": {"type": "integer", "minimum": 0},
    "to_y": {"type": "integer", "minimum": 0}
  },
  "required": ["from_x", "from_y", "to_x", "to_y"]
}`),
		Annotations: acts(false),
	},
	{
		Name:        ToolScroll,
		Title:       "Scroll",
		Description: "Scroll the mouse wheel with the pointer at a point: what's under it scrolls.",
		InputSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "x": {"type": "integer", "minimum": 0},
    "y": {"type": "integer", "minimum": 0},
    "direction": {"type": "string", "enum": ["up", "down"]},
    "amount": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Wheel steps; 3 unless given."}
  },
  "required": ["x", "y", "direction"]
}`),
		Annotations: acts(false),
	},
	{
		Name:        ToolType,
		Title:       "Type text",
		Description: "Type text into whatever has the keyboard focus, as keystrokes. For a field on a web page, browser_fill by ref is more reliable.",
		InputSchema: json.RawMessage(`{
  "type": "object",
  "properties": {"text": {"type": "string"}},
  "required": ["text"]
}`),
		Annotations: acts(false),
	},
	{
		Name:        ToolKey,
		Title:       "Press keys",
		Description: `Press a key or a chord: "enter", "escape", "tab", "backspace", "page_down", "f5", "ctrl+l", "ctrl+shift+t", "alt+tab".`,
		InputSchema: json.RawMessage(`{
  "type": "object",
  "properties": {"keys": {"type": "string", "description": "One key, or modifiers and a key joined by +."}},
  "required": ["keys"]
}`),
		Annotations: acts(false),
	},
	{
		Name:        ToolOpenBrowser,
		Title:       "Open the browser",
		Description: "Open a web page in Chromium on the desktop (in a new tab if it's already open), and get its browser_snapshot. A dev server on this computer is at http://localhost:<port>. The browser keeps its sign-ins between sessions on this computer.",
		InputSchema: json.RawMessage(`{
  "type": "object",
  "properties": {"url": {"type": "string", "description": "The page, e.g. http://localhost:3000 or https://example.com."}},
  "required": ["url"]
}`),
		Annotations: acts(true),
	},
	{
		Name:        ToolBrowserSnapshot,
		Title:       "Read the page",
		Description: "Read the browser's current page as an accessibility tree: one line per element with its role, name and state, and a ref (e123) to pass to browser_click and browser_fill. Take a new one after the page changes.",
		InputSchema: noArgs,
		Annotations: readOnly(true),
	},
	{
		Name:        ToolBrowserClick,
		Title:       "Click an element",
		Description: "Click the element a browser_snapshot ref names (a link, a button, a checkbox), scrolling it into view first.",
		InputSchema: json.RawMessage(`{
  "type": "object",
  "properties": {"ref": {"type": "string", "description": "The element's ref from the latest browser_snapshot, e.g. e123."}},
  "required": ["ref"]
}`),
		Annotations: acts(true),
	},
	{
		Name:        ToolBrowserFill,
		Title:       "Fill a field",
		Description: "Replace the text in the field a browser_snapshot ref names (a text box, a search box, a text area), typed in so the page sees the input; with submit, press Enter after.",
		InputSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "ref": {"type": "string", "description": "The field's ref from the latest browser_snapshot, e.g. e123."},
    "text": {"type": "string", "description": "What the field should hold; empty to clear it."},
    "submit": {"type": "boolean", "description": "Press Enter after, to submit a form or a search."}
  },
  "required": ["ref", "text"]
}`),
		Annotations: acts(true),
	},
	{
		Name:        ToolBrowserNavigate,
		Title:       "Go to a page",
		Description: "Load a URL in the browser's current tab, wait for it, and get its browser_snapshot.",
		InputSchema: json.RawMessage(`{
  "type": "object",
  "properties": {"url": {"type": "string"}},
  "required": ["url"]
}`),
		Annotations: acts(true),
	},
	{
		Name:        ToolRecordStart,
		Title:       "Start recording the screen",
		Description: "Start recording the desktop as a video, to show a flow as evidence (a bug, its fix, a feature working). One recording runs at a time; it stops by itself after 10 minutes. Call record_stop to save it.",
		InputSchema: json.RawMessage(`{
  "type": "object",
  "properties": {"label": {"type": "string", "description": "A few words for the file name, e.g. \"login fix\"."}}
}`),
		OutputSchema: json.RawMessage(`{
  "type": "object",
  "properties": {"recording": {"type": "boolean"}},
  "required": ["recording"]
}`),
		Annotations: acts(false),
	},
	{
		Name:        ToolRecordStop,
		Title:       "Stop recording",
		Description: "Stop the screen recording and save it as an MP4 (H.264) under .context/desktop/ in the session's folder, named recording-<UTC time>[-<label>].mp4. Gives its path, length and size.",
		InputSchema: noArgs,
		OutputSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "path": {"type": "string", "description": "The MP4's absolute path on this computer."},
    "durationSeconds": {"type": "number"},
    "sizeBytes": {"type": "integer"}
  },
  "required": ["path", "durationSeconds", "sizeBytes"]
}`),
		Annotations: acts(false),
	},
}
