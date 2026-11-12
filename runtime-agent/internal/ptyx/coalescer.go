package ptyx

import (
	"sync"
	"time"
)

// Coalescer buffers PTY bytes and emits them as `output` frames on a short
// interval or when the buffer fills, whichever comes first. The frozen wire
// contract requires `output` be coalesced; without this, one keystroke = one
// WS frame and the terminal floods with tiny writes.
//
// A Coalescer belongs to one connection: seq is per-socket and monotonic.
// Flush is called on the caller's goroutine (either by Write hitting the
// threshold or by the run loop's ticker); the two are serialised, so frames
// go out in seq order and send (the server's redactor, which keeps state
// between calls) never runs twice at once.
type Coalescer struct {
	interval  time.Duration
	threshold int
	send      func(seq int, data []byte) error

	// sending is held from taking the buffer to send's return.
	sending sync.Mutex

	mu      sync.Mutex
	buf     []byte
	seq     int
	closed  bool
	running bool
	done    chan struct{}
	exited  chan struct{}
}

// NewCoalescer returns a Coalescer flushing at max(interval, threshold-bytes).
// Interval of 16ms + 4KB threshold matches ~60fps terminals without inflating
// per-frame overhead on bursty output.
func NewCoalescer(interval time.Duration, threshold int, send func(seq int, data []byte) error) *Coalescer {
	return &Coalescer{
		interval:  interval,
		threshold: threshold,
		send:      send,
		done:      make(chan struct{}),
		exited:    make(chan struct{}),
	}
}

// Start runs Run on its own goroutine, marked running first, so a Stop or
// Close that follows at once always waits for its last flush.
func (c *Coalescer) Start() {
	c.mu.Lock()
	c.running = true
	c.mu.Unlock()
	go c.run()
}

// Run drives the flush ticker until Stop is called, on the caller's
// goroutine. Stop waits for it only once it has begun; Start has no such
// window.
func (c *Coalescer) Run() {
	c.mu.Lock()
	c.running = true
	c.mu.Unlock()
	c.run()
}

func (c *Coalescer) run() {
	defer close(c.exited)
	t := time.NewTicker(c.interval)
	defer t.Stop()
	for {
		select {
		case <-c.done:
			c.flush()
			return
		case <-t.C:
			c.flush()
		}
	}
}

// Write appends bytes to the coalescer's buffer. If the buffer meets or
// exceeds the threshold, it flushes immediately on the caller's goroutine so
// bursty output doesn't wait for the tick.
func (c *Coalescer) Write(b []byte) error {
	c.mu.Lock()
	if c.closed {
		// After Close: the socket's last frame has gone.
		c.mu.Unlock()
		return nil
	}
	c.buf = append(c.buf, b...)
	over := len(c.buf) >= c.threshold
	c.mu.Unlock()
	if over {
		return c.flush()
	}
	return nil
}

// NextSeq reserves and returns the next per-socket sequence number. The server
// uses it for the final redactor-flush frame emitted after Stop, so that frame
// stays monotonic with the coalesced output stream rather than reusing seq 0.
func (c *Coalescer) NextSeq() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	seq := c.seq
	c.seq++
	return seq
}

// Stop tells Run to exit after one last flush, and waits for it to have if
// it is running: always after Start, only once begun after a bare `go Run()`.
func (c *Coalescer) Stop() {
	c.mu.Lock()
	running := c.running
	select {
	case <-c.done:
	default:
		close(c.done)
	}
	c.mu.Unlock()
	if running {
		<-c.exited
	}
}

// Close stops the Coalescer, flushes what's left, and then calls final with
// the next seq, after every other send has returned and before any later one:
// for the server's last frame (what its redactor held back). Writes after it
// are dropped, as a PTY read still in flight when the socket closes.
func (c *Coalescer) Close(final func(seq func() int)) {
	c.Stop()
	c.sending.Lock()
	defer c.sending.Unlock()
	c.mu.Lock()
	c.closed = true
	data := c.buf
	c.buf = nil
	c.mu.Unlock()
	if len(data) > 0 {
		_ = c.send(c.NextSeq(), data)
	}
	if final != nil {
		final(c.NextSeq)
	}
}

func (c *Coalescer) flush() error {
	c.sending.Lock()
	defer c.sending.Unlock()
	c.mu.Lock()
	if len(c.buf) == 0 {
		c.mu.Unlock()
		return nil
	}
	data := c.buf
	c.buf = nil
	seq := c.seq
	c.seq++
	c.mu.Unlock()
	return c.send(seq, data)
}
