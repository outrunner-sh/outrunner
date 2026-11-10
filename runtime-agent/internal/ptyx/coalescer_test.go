package ptyx

import (
	"bytes"
	"sync"
	"testing"
	"time"
)

type sink struct {
	mu     sync.Mutex
	frames [][]byte
	seqs   []int
}

func (s *sink) recv(seq int, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make([]byte, len(data))
	copy(cp, data)
	s.frames = append(s.frames, cp)
	s.seqs = append(s.seqs, seq)
	return nil
}

func (s *sink) snapshot() ([][]byte, []int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := make([][]byte, len(s.frames))
	copy(f, s.frames)
	q := make([]int, len(s.seqs))
	copy(q, s.seqs)
	return f, q
}

func TestCoalescerFlushesOnTick(t *testing.T) {
	s := &sink{}
	c := NewCoalescer(5*time.Millisecond, 4096, s.recv)
	go c.Run()
	defer c.Stop()

	_ = c.Write([]byte("hello "))
	_ = c.Write([]byte("world"))

	// wait past a few ticks
	time.Sleep(30 * time.Millisecond)

	frames, seqs := s.snapshot()
	if len(frames) == 0 {
		t.Fatal("expected at least one flush")
	}
	// concatenation of frames == concatenation of writes
	joined := bytes.Join(frames, nil)
	if string(joined) != "hello world" {
		t.Fatalf("expected 'hello world', got %q", string(joined))
	}
	// seq must be strictly monotonic starting at 0
	for i, q := range seqs {
		if q != i {
			t.Fatalf("seq[%d] = %d, want %d (seqs=%v)", i, q, i, seqs)
		}
	}
}

func TestCoalescerFlushesOnThreshold(t *testing.T) {
	s := &sink{}
	// Big interval so only threshold can trigger.
	c := NewCoalescer(10*time.Second, 8, s.recv)
	go c.Run()
	defer c.Stop()

	_ = c.Write([]byte("12345678")) // hits threshold exactly
	time.Sleep(20 * time.Millisecond)

	frames, _ := s.snapshot()
	if len(frames) != 1 || string(frames[0]) != "12345678" {
		t.Fatalf("expected one 8-byte flush, got %v", frames)
	}
}

func TestCoalescerEmptyTickDoesNotFlush(t *testing.T) {
	s := &sink{}
	c := NewCoalescer(5*time.Millisecond, 4096, s.recv)
	go c.Run()
	defer c.Stop()

	time.Sleep(30 * time.Millisecond)

	frames, _ := s.snapshot()
	if len(frames) != 0 {
		t.Fatalf("empty ticker should not emit frames, got %v", frames)
	}
}

func TestCoalescerStopFlushesRemainder(t *testing.T) {
	s := &sink{}
	c := NewCoalescer(10*time.Second, 4096, s.recv)
	done := make(chan struct{})
	go func() { c.Run(); close(done) }()

	_ = c.Write([]byte("tail"))
	c.Stop()
	<-done

	frames, _ := s.snapshot()
	if len(frames) != 1 || string(frames[0]) != "tail" {
		t.Fatalf("stop should flush pending bytes, got %v", frames)
	}
}

// The ticker's flush and a Write over the threshold run on two goroutines:
// their sends must not overlap (the server's redactor keeps state between
// calls) and must go out in seq order, every byte once.
func TestCoalescerSendsOneAtATimeInSeqOrder(t *testing.T) {
	var (
		mu       sync.Mutex
		inSend   bool
		overlaps int
		seqs     []int
		got      bytes.Buffer
	)
	send := func(seq int, data []byte) error {
		mu.Lock()
		if inSend {
			overlaps++
		}
		inSend = true
		mu.Unlock()
		time.Sleep(50 * time.Microsecond) // a write to a slow socket
		mu.Lock()
		inSend = false
		seqs = append(seqs, seq)
		got.Write(data)
		mu.Unlock()
		return nil
	}
	c := NewCoalescer(time.Microsecond, 64, send)
	go c.Run()

	var want bytes.Buffer
	chunk := bytes.Repeat([]byte("x"), 40)
	for i := 0; i < 2000; i++ {
		chunk[0] = byte('a' + i%26)
		want.Write(chunk)
		_ = c.Write(chunk)
	}
	c.Close(nil)

	mu.Lock()
	defer mu.Unlock()
	if overlaps > 0 {
		t.Errorf("%d sends overlapped", overlaps)
	}
	for i := 1; i < len(seqs); i++ {
		if seqs[i] <= seqs[i-1] {
			t.Fatalf("seq %d went out after %d", seqs[i], seqs[i-1])
		}
	}
	if !bytes.Equal(got.Bytes(), want.Bytes()) {
		t.Errorf("output differs from input: %d bytes out, %d in", got.Len(), want.Len())
	}
}

func TestCoalescerCloseSendsTheRestThenTheFinalFrameLast(t *testing.T) {
	s := &sink{}
	c := NewCoalescer(10*time.Second, 4096, s.recv)
	go c.Run()
	_ = c.Write([]byte("tail"))
	c.Close(func(seq func() int) { _ = s.recv(seq(), []byte("final")) })
	// A PTY read still in flight as the socket closes goes nowhere.
	_ = c.Write(bytes.Repeat([]byte("y"), 5000))

	frames, seqs := s.snapshot()
	if len(frames) != 2 || string(frames[0]) != "tail" || string(frames[1]) != "final" {
		t.Fatalf("frames = %q, want tail then final", frames)
	}
	if seqs[1] <= seqs[0] {
		t.Errorf("final frame's seq %d isn't after %d", seqs[1], seqs[0])
	}
}

// Started with Start, a Stop that comes at once still waits for Run's last
// flush: no window before the goroutine is scheduled.
func TestCoalescerStopAfterStartAlwaysWaitsForRun(t *testing.T) {
	for i := 0; i < 1000; i++ {
		s := &sink{}
		c := NewCoalescer(time.Hour, 4096, s.recv)
		c.Start()
		_ = c.Write([]byte("tail"))
		c.Stop()
		select {
		case <-c.exited:
		default:
			t.Fatalf("run %d: Stop returned before Run had", i)
		}
		if frames, _ := s.snapshot(); len(frames) != 1 || string(frames[0]) != "tail" {
			t.Fatalf("run %d: frames = %q, want the tail flushed by Stop", i, frames)
		}
	}
}
