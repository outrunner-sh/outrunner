// Package autoscale watches the box's real cgroup memory use. Pressure only
// asks the control plane to check; the agent cannot choose a new allocation.
package autoscale

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"runtime-agent/internal/gitcred"
	"runtime-agent/internal/media"
)

const (
	interval = 2 * time.Second
	cooldown = 90 * time.Second
)

// Reading measures a cgroup, never the host's /proc/meminfo. Inactive file
// cache can be reclaimed without killing a process, so subtract it.
type Reading struct {
	Limit, WorkingSet uint64
}

func ReadMemory(root string) (Reading, error) {
	read := func(name string) (uint64, error) {
		data, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			return 0, err
		}
		return strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
	}
	limit, err := read("memory.max")
	if err != nil || limit == 0 {
		return Reading{}, fmt.Errorf("no finite cgroup memory limit")
	}
	used, err := read("memory.current")
	if err != nil {
		return Reading{}, err
	}
	stat, err := os.ReadFile(filepath.Join(root, "memory.stat"))
	if err != nil {
		return Reading{}, err
	}
	for _, line := range strings.Split(string(stat), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "inactive_file" {
			inactive, err := strconv.ParseUint(fields[1], 10, 64)
			if err != nil || inactive > used {
				return Reading{}, fmt.Errorf("invalid cgroup file cache")
			}
			used -= inactive
			return Reading{Limit: limit, WorkingSet: used}, nil
		}
	}
	return Reading{}, fmt.Errorf("missing cgroup file cache")
}

type Monitor struct {
	gitcred.Config
	HTTP *http.Client
	// Read and Now are test seams; nil uses the local cgroup and time.Now.
	Read func() (Reading, error)
	Now  func() time.Time

	highSamples int
	nextRequest time.Time
}

// Run uses a single goroutine and at most one in-flight notification. The
// cooldown survives HTTP failures; restarting the agent cannot bypass the
// server's database lease. Hosts without cgroup v2 quietly do nothing.
func (m *Monitor) Run(ctx context.Context) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := m.Check(ctx); err != nil && ctx.Err() == nil {
				log.Printf("memory autoscaling: %v", err)
			}
		}
	}
}

// Check requires two consecutive samples over 80%, or one over 95%. A sharp
// build-time spike shouldn't have to wait for another sample to request RAM.
func (m *Monitor) Check(ctx context.Context) error {
	now := time.Now()
	if m.Now != nil {
		now = m.Now()
	}
	if now.Before(m.nextRequest) {
		return nil
	}
	read := m.Read
	if read == nil {
		read = func() (Reading, error) { return ReadMemory("/sys/fs/cgroup") }
	}
	r, err := read()
	if err != nil || r.Limit == 0 {
		m.highSamples = 0
		return nil
	}
	pressure := float64(r.WorkingSet) / float64(r.Limit)
	if pressure < 0.8 {
		m.highSamples = 0
		return nil
	}
	m.highSamples++
	if m.highSamples < 2 && pressure < 0.95 {
		return nil
	}
	m.highSamples = 0
	m.nextRequest = now.Add(cooldown)
	return m.notify(ctx, now)
}

func (m *Monitor) notify(ctx context.Context, now time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, 75*time.Second)
	defer cancel()
	body := []byte("{}")
	timestamp := strconv.FormatInt(now.Unix(), 10)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.AppURL+"/api/runtime/memory-scale", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Outrunner-Sandbox", m.SandboxID)
	req.Header.Set("X-Outrunner-Timestamp", timestamp)
	req.Header.Set("X-Outrunner-Signature", media.Sign(m.Secret, "memory-scale", m.SandboxID, timestamp, body))
	client := m.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("could not notify Outrunner: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// Old control planes, disabled resizing, bad credentials: back off
		// rather than hammer the server while the box is under pressure.
		m.nextRequest = now.Add(5 * time.Minute)
		return fmt.Errorf("Outrunner refused the memory check (HTTP %d)", resp.StatusCode)
	}
	var result struct {
		Outcome           string `json:"outcome"`
		MemoryGB          int    `json:"memoryGb"`
		RetryAfterSeconds int    `json:"retryAfterSeconds"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&result); err != nil {
		return fmt.Errorf("invalid memory scaling response: %w", err)
	}
	if result.RetryAfterSeconds > 90 && result.RetryAfterSeconds <= 600 {
		m.nextRequest = now.Add(time.Duration(result.RetryAfterSeconds) * time.Second)
	}
	if result.Outcome == "scaled" {
		log.Printf("memory autoscaling: increased sandbox memory to %d GiB", result.MemoryGB)
	} else if result.Outcome == "at-limit" {
		log.Printf("memory autoscaling: sandbox is at its plan's memory limit")
	}
	return nil
}
