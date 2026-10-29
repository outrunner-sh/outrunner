package snapshot

import (
	"context"
	"errors"
	"io/fs"
	"net"
	"os/exec"

	"runtime-agent/internal/protocol"
)

// Failure retains the original error for errors.Is/As and attaches safe,
// structured evidence about the operation that actually failed.
type Failure struct {
	Diagnostic protocol.SnapshotFailure
	Err        error
}

func (e *Failure) Error() string { return e.Err.Error() }
func (e *Failure) Unwrap() error { return e.Err }

func FailureAt(stage, artifact string, err error) error {
	if err == nil {
		return nil
	}
	var existing *Failure
	if errors.As(err, &existing) {
		return err
	}
	d := protocol.SnapshotFailure{Stage: stage, Artifact: artifact, Cause: "other"}
	var status *StatusError
	var command *exec.ExitError
	var network net.Error
	switch {
	case errors.As(err, &status):
		d.Cause, d.HTTPStatus = "storage_http", status.Status
	case errors.Is(err, fs.ErrNotExist):
		d.Cause = "missing_file"
	case errors.Is(err, fs.ErrPermission):
		d.Cause = "permission_denied"
	case errors.As(err, &command):
		d.Cause = "command_failed"
		if code := command.ExitCode(); code >= 0 && code <= 255 {
			d.ExitCode = &code
		}
	case errors.As(err, &network), errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		d.Cause = "network"
	}
	return &Failure{Diagnostic: d, Err: err}
}

func DiagnosticOf(err error) *protocol.SnapshotFailure {
	var failure *Failure
	if errors.As(err, &failure) {
		d := failure.Diagnostic
		return &d
	}
	return nil
}
