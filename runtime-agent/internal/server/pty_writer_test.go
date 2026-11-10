package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"runtime-agent/internal/protocol"
)

// A /pty write that fails (here: its deadline already past, as for a client
// that stopped reading) closes the socket, so the handler's read returns and
// it unwinds, instead of keeping a socket that never carries output again.
func TestAFailedPtyWriteClosesTheSocket(t *testing.T) {
	readErr := make(chan error, 1)
	writeErr := make(chan error, 1)
	upgrader := websocket.Upgrader{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		writeErr <- ptyFrameWriter(conn, -time.Second)(protocol.PtyServerMessage{T: "pong"})
		_, _, err = conn.ReadMessage() // pumpIn's read
		readErr <- err
	}))
	defer ts.Close()

	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(ts.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close() // the client stays connected and sends nothing

	if err := <-writeErr; err == nil {
		t.Fatal("a write past its deadline succeeded")
	}
	select {
	case err := <-readErr:
		if err == nil {
			t.Fatal("read returned no error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the handler's read still blocks after a failed write")
	}
}
