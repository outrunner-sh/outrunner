package localimport

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// cacheVersion is bumped when transcriptFacts changes meaning, so a cache
// written by an older agent is read as empty rather than wrong.
const cacheVersion = 1

// scanCache keeps what was read of each transcript, keyed by its path and
// valid while its size and modification time are unchanged: a second scan
// reads only the sessions that moved on since.
type scanCache struct {
	mu      sync.Mutex
	entries map[string]cacheEntry
	// used are the entries this scan looked up; only those are saved, so a
	// deleted transcript's entry goes.
	used map[string]bool
}

type cacheEntry struct {
	Size    int64           `json:"size"`
	ModTime int64           `json:"modTime"`
	Facts   transcriptFacts `json:"facts"`
}

type cacheFile struct {
	Version int                   `json:"version"`
	Entries map[string]cacheEntry `json:"entries"`
}

// loadCache reads the cache at path; anything unreadable is an empty cache.
func loadCache(path string) *scanCache {
	c := &scanCache{entries: map[string]cacheEntry{}, used: map[string]bool{}}
	if path == "" {
		return c
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return c
	}
	var file cacheFile
	if json.Unmarshal(data, &file) == nil && file.Version == cacheVersion && file.Entries != nil {
		c.entries = file.Entries
	}
	return c
}

// facts returns a transcript's facts and size, read again only if it changed.
func (c *scanCache) facts(agent, path string) (transcriptFacts, int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return transcriptFacts{}, 0, err
	}
	size, mod := info.Size(), info.ModTime().UnixNano()
	c.mu.Lock()
	entry, ok := c.entries[path]
	c.used[path] = true
	c.mu.Unlock()
	if ok && entry.Size == size && entry.ModTime == mod {
		return entry.Facts, size, nil
	}
	facts, err := readFacts(agent, path)
	if err != nil {
		return transcriptFacts{}, 0, err
	}
	c.mu.Lock()
	c.entries[path] = cacheEntry{Size: size, ModTime: mod, Facts: facts}
	c.mu.Unlock()
	return facts, size, nil
}

// save writes the entries this scan used, replacing the file in one step. A
// cache that can't be written costs only the next scan's time.
func (c *scanCache) save(path string) {
	if path == "" {
		return
	}
	c.mu.Lock()
	kept := make(map[string]cacheEntry, len(c.used))
	for p := range c.used {
		if e, ok := c.entries[p]; ok {
			kept[p] = e
		}
	}
	c.mu.Unlock()
	data, err := json.Marshal(cacheFile{Version: cacheVersion, Entries: kept})
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".import-scan-*")
	if err != nil {
		return
	}
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr != nil || cerr != nil || os.Rename(tmp.Name(), path) != nil {
		os.Remove(tmp.Name())
	}
}
