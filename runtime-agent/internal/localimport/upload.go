package localimport

import (
	"context"
	"errors"
	"fmt"
	"time"

	"runtime-agent/internal/snapshot"
)

// uploadAttempts is how many times one artifact is sent before the import
// gives up on it: from someone's home connection, a long upload can drop.
const uploadAttempts = 3

// uploadBackoff is the wait before each retry; tests shorten it.
var uploadBackoff = []time.Duration{2 * time.Second, 8 * time.Second}

// Upload streams each of a capture's artifacts to its signed upload URL, by
// kind. Every artifact must have one; a URL for one the capture didn't make
// (a rollout, for a Claude session) is not used.
func Upload(ctx context.Context, c Capture, urls map[string]string) error {
	for kind := range c.Artifacts {
		if urls[kind] == "" {
			return fmt.Errorf("the import plan has no upload for the %s", kind)
		}
	}
	for kind, artifact := range c.Artifacts {
		if err := uploadOne(ctx, urls[kind], artifact.Path); err != nil {
			return fmt.Errorf("upload the %s: %w", kind, err)
		}
	}
	return nil
}

// uploadOne sends a file, again after a network failure or a server error;
// a refusal (4xx: expired, too large, already there) is final.
func uploadOne(ctx context.Context, url, path string) error {
	var err error
	for attempt := range uploadAttempts {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(uploadBackoff[min(attempt-1, len(uploadBackoff)-1)]):
			}
		}
		err = snapshot.PutFile(ctx, url, path)
		var status *snapshot.StatusError
		if err == nil || (errors.As(err, &status) && status.Status < 500) {
			return err
		}
	}
	return err
}
