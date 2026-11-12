# syntax=docker/dockerfile:1

# The image every cloud box boots from, on every provider: Claude Code, Codex
# and gh at the versions the agent is built for, so nothing is installed when a
# session starts. Built and checked by .github/workflows/box-image.yml and
# published under the tag lib/runtime/box-image.ts names, a hash of this file
# and the pinned versions: change either and that tag must change too (its test
# says to what).
#
# The versions come in as build args from BOX_TOOLS (scripts/box-image.ts
# build-args), never written here, so there is one place to bump them.
#
# Public: nothing in it is secret, and only a public image can be pulled from
# every provider and every user's own account. The runtime-agent isn't baked in;
# it's uploaded on deploy, at the build the control plane runs.

#
# Nothing is piped from a URL into a shell: each download is checked against
# its sha256, pinned beside its version in BOX_TOOL_SHA256, before it's used.

# Pinned by digest, so the base can't change under the tag. To bump: the new
# tag's index digest, e.g. `docker buildx imagetools inspect ubuntu:24.04`.
FROM ubuntu:24.04@sha256:2198e4c65076e9cb0b3d695219df667c0e3b0072da64ca3c2648aca17dcecaf5

ARG NODE_VERSION
ARG NODE_SHA256_AMD64
ARG NODE_SHA256_ARM64
ARG CLAUDE_CODE_VERSION
ARG CLAUDE_CODE_SHA256_AMD64
ARG CLAUDE_CODE_SHA256_ARM64
ARG CODEX_VERSION
ARG GH_VERSION
ARG GH_SHA256_AMD64
ARG GH_SHA256_ARM64
RUN for v in "$NODE_VERSION" "$NODE_SHA256_AMD64" "$NODE_SHA256_ARM64" \
    "$CLAUDE_CODE_VERSION" "$CLAUDE_CODE_SHA256_AMD64" "$CLAUDE_CODE_SHA256_ARM64" \
    "$CODEX_VERSION" "$GH_VERSION" "$GH_SHA256_AMD64" "$GH_SHA256_ARM64"; do \
    test -n "$v" || { echo "ERROR: build with scripts/box-image.ts build-args"; exit 1; }; \
  done

ENV DEBIAN_FRONTEND=noninteractive

# What the agent needs (tmux, git, jq), and what a coding agent reaches for in
# a repo: search, a compiler toolchain, Python.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git git-lfs gnupg jq less openssh-client \
    procps python3 python3-pip python3-venv ripgrep sudo tmux unzip \
  && rm -rf /var/lib/apt/lists/*

# Node's own release (nodejs.org), into /usr/local.
RUN case "$(dpkg --print-architecture)" in \
    amd64) arch=x64 sum="$NODE_SHA256_AMD64" ;; \
    arm64) arch=arm64 sum="$NODE_SHA256_ARM64" ;; \
    *) echo "No Node build for $(dpkg --print-architecture)"; exit 1 ;; \
  esac \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.gz" -o /tmp/node.tar.gz \
  && echo "${sum}  /tmp/node.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 --no-same-owner \
    --exclude='*.md' --exclude=LICENSE \
  && rm /tmp/node.tar.gz

# gh's own release (Ubuntu's is years behind), downloaded whole before unpacking.
RUN arch="$(dpkg --print-architecture)" \
  && case "$arch" in amd64) sum="$GH_SHA256_AMD64" ;; arm64) sum="$GH_SHA256_ARM64" ;; *) sum= ;; esac \
  && dir="gh_${GH_VERSION}_linux_${arch}" \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${dir}.tar.gz" -o /tmp/gh.tar.gz \
  && echo "${sum}  /tmp/gh.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/gh.tar.gz -C /tmp \
  && install -m 0755 "/tmp/${dir}/bin/gh" /usr/local/bin/gh \
  && rm -rf /tmp/gh.tar.gz "/tmp/${dir}"

RUN npm install -g "@openai/codex@${CODEX_VERSION}" && npm cache clean --force

# The user the agent and Claude run as: Claude refuses bypassPermissions as
# root. Passwordless sudo, so an agent can still install what a repo needs.
# Its home readable by all (Ubuntu makes it 0750): claude links into it, and a
# provider may run commands as its own user.
RUN useradd -m -s /bin/bash runtime \
  && chmod 0755 /home/runtime \
  && echo 'runtime ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runtime \
  && chmod 0440 /etc/sudoers.d/runtime

# Claude Code's native build, for the box user, at the pinned version, installed
# by itself as claude.ai/install.sh would (lib/runtime/claude-cli.ts's
# claudeNativeInstallCommand is the same for Modal); linked into /usr/local/bin
# so it's on every PATH (login shell or not, sudo's too). Its updater off, in
# managed settings (whatever env a provider starts it with) and the env: it
# would move a long-lived box off the pin after a session.
USER runtime
WORKDIR /home/runtime
RUN case "$(dpkg --print-architecture)" in \
    amd64) platform=linux-x64 sum="$CLAUDE_CODE_SHA256_AMD64" ;; \
    arm64) platform=linux-arm64 sum="$CLAUDE_CODE_SHA256_ARM64" ;; \
    *) echo "No Claude Code build for $(dpkg --print-architecture)"; exit 1 ;; \
  esac \
  && curl -fsSL "https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}/${platform}/claude" -o /tmp/claude \
  && echo "${sum}  /tmp/claude" | sha256sum -c - \
  && chmod 0755 /tmp/claude \
  && /tmp/claude install "${CLAUDE_CODE_VERSION}" \
  && rm /tmp/claude \
  && echo "${sum}  /home/runtime/.local/share/claude/versions/${CLAUDE_CODE_VERSION}" | sha256sum -c -
USER root
RUN ln -sf /home/runtime/.local/bin/claude /usr/local/bin/claude \
  && mkdir -p /etc/claude-code \
  && echo '{"env":{"DISABLE_AUTOUPDATER":"1"}}' > /etc/claude-code/managed-settings.json
ENV DISABLE_AUTOUPDATER=1

USER runtime
