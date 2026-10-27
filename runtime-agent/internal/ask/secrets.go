package ask

import (
	"context"
	"fmt"
	"slices"
	"strings"
)

// A session's agent asks the user for secrets (API keys, tokens) it doesn't
// have through a second tool the relay serves, request_secrets, rather than
// asking for them in the chat: the browser shows a form in place of the chat
// box, and the values go from it to the session's environment, never into
// the conversation. The call names the variables and why; its result names
// which were provided, never a value.

// SecretsToolName is the tool as the relay serves it.
const SecretsToolName = "request_secrets"

// QualifiedSecretsToolName is the tool as Claude names it.
const QualifiedSecretsToolName = "mcp__" + ServerName + "__" + SecretsToolName

// Bounds on a request: a few variables, and a reason the form can show.
const (
	MaxSecretKeys      = 10
	MaxSecretReason    = 300
	MaxSecretDescribed = 200
)

// SecretKey is one variable the agent asks for.
type SecretKey struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// Optional keys can be left out without the request being skipped.
	Optional bool `json:"optional,omitempty"`
}

// SecretRequest is the agent's request: the variables, and what they're for.
type SecretRequest struct {
	Reason string      `json:"reason"`
	Keys   []SecretKey `json:"keys"`
}

// Names are the request's variables, in order.
func (r SecretRequest) Names() []string {
	names := make([]string, len(r.Keys))
	for i, k := range r.Keys {
		names[i] = k.Name
	}
	return names
}

// SecretReply is what the agent is told: the variables the user provided,
// or that they skipped the request.
type SecretReply struct {
	Provided []string
	Skipped  bool
	// EnvFile is where the values are, for the agent to source itself if its
	// shell hasn't picked them up.
	EnvFile string
}

// ValidateSecretRequest checks a request as the agent made it; validName is
// whether a session's environment may set a variable (workspace.ValidEnvName).
// Its errors go back to the agent as the tool's result, so they say what to
// fix.
func ValidateSecretRequest(req SecretRequest, validName func(string) bool) error {
	if strings.TrimSpace(req.Reason) == "" {
		return invalid("say why you need these in reason")
	}
	if len(req.Reason) > MaxSecretReason {
		return invalid("keep reason under %d characters", MaxSecretReason)
	}
	if len(req.Keys) == 0 || len(req.Keys) > MaxSecretKeys {
		return invalid("ask for 1 to %d variables, not %d", MaxSecretKeys, len(req.Keys))
	}
	seen := map[string]bool{}
	required := 0
	for i, k := range req.Keys {
		if !validName(k.Name) {
			return invalid("variable %d, %q, isn't a name a session can set: use letters, digits and _, not a variable Outrunner sets itself", i+1, k.Name)
		}
		if seen[k.Name] {
			return invalid("%s is asked for twice", k.Name)
		}
		seen[k.Name] = true
		if len(k.Description) > MaxSecretDescribed {
			return invalid("keep %s's description under %d characters", k.Name, MaxSecretDescribed)
		}
		if !k.Optional {
			required++
		}
	}
	if required == 0 {
		return invalid("at least one variable must be required")
	}
	return nil
}

// FormatSecrets is the tool's result for the agent. It names variables,
// never their values.
func FormatSecrets(req SecretRequest, reply SecretReply) string {
	if reply.Skipped {
		return "The user skipped this request and provided none of " + strings.Join(req.Names(), ", ") + ". Don't ask for them again: carry on with a local substitute (a mock, a local service, a documented test value) and say so, or explain in plain text why the work needs them."
	}
	var missing []string
	for _, name := range req.Names() {
		if !slices.Contains(reply.Provided, name) {
			missing = append(missing, name)
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "The user provided %s.", strings.Join(reply.Provided, ", "))
	if len(missing) > 0 {
		fmt.Fprintf(&b, " They left out %s: don't ask for them again.", strings.Join(missing, ", "))
	}
	b.WriteString(" They are set in your Bash environment from your next command.")
	if reply.EnvFile != "" {
		fmt.Fprintf(&b, " If a command doesn't see them, run it as `. %s && <command>`.", reply.EnvFile)
	}
	b.WriteString(" Restart anything you started earlier that needs them. Never print, echo, log or commit their values.")
	return b.String()
}

// SecretsBroker holds each session's waiting request for secrets until the
// user answers it in the browser.
type SecretsBroker struct {
	held holder[SecretRequest, SecretReply]
}

func NewSecretsBroker() *SecretsBroker {
	return &SecretsBroker{held: newHolder[SecretRequest, SecretReply]()}
}

// Request waits for the user to answer a session's request, until ctx ends
// (the relay gave the call up). requestID names the call, as Broker.Ask's.
func (b *SecretsBroker) Request(ctx context.Context, workspaceID, requestID string, req SecretRequest) (SecretReply, error) {
	return b.held.wait(ctx, workspaceID, requestID, req)
}

// Answer gives the user's answer to the request a session is waiting on,
// named by its variables (the ones the form showed; any other request is
// ErrNotWaiting). keep, under the lock, keeps the values and makes the
// reply: it runs once, and only for a request still waiting.
func (b *SecretsBroker) Answer(workspaceID string, names []string, keep func(SecretRequest) (SecretReply, error)) error {
	return b.held.answer(workspaceID, func(req SecretRequest) (SecretReply, error) {
		if !slices.Equal(req.Names(), names) {
			return SecretReply{}, ErrNotWaiting
		}
		return keep(req)
	})
}

// Waiting reports whether a session has a request waiting.
func (b *SecretsBroker) Waiting(workspaceID string) bool { return b.held.has(workspaceID) }
