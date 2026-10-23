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

FROM ubuntu:24.04

ARG NODE_MAJOR
ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION
ARG GH_VERSION
RUN test -n "$NODE_MAJOR" -a -n "$CLAUDE_CODE_VERSION" -a -n "$CODEX_VERSION" -a -n "$GH_VERSION" \
  || (echo "ERROR: build with scripts/box-image.ts build-args" && exit 1)

ENV DEBIAN_FRONTEND=noninteractive

# What the agent needs (tmux, git, jq), and what a coding agent reaches for in
# a repo: search, a compiler toolchain, Python.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git git-lfs gnupg jq less openssh-client \
    procps python3 python3-pip python3-venv ripgrep sudo tmux unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# gh's own release (Ubuntu's is years behind), downloaded whole before unpacking.
RUN arch="$(dpkg --print-architecture)" \
  && dir="gh_${GH_VERSION}_linux_${arch}" \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${dir}.tar.gz" -o /tmp/gh.tar.gz \
  && tar -xzf /tmp/gh.tar.gz -C /tmp \
  && install -m 0755 "/tmp/${dir}/bin/gh" /usr/local/bin/gh \
  && rm -rf /tmp/gh.tar.gz "/tmp/${dir}"

RUN npm install -g "@openai/codex@${CODEX_VERSION}" && npm cache clean --force

# The user the agent and Claude run as: Claude refuses bypassPermissions as
# root. Passwordless sudo, so an agent can still install what a repo needs.
RUN useradd -m -s /bin/bash runtime \
  && echo 'runtime ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runtime \
  && chmod 0440 /etc/sudoers.d/runtime

# Claude Code's own installer, for the box user, at the pinned version; linked
# into /usr/local/bin so it's on every PATH (login shell or not, sudo's too).
USER runtime
WORKDIR /home/runtime
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}"
USER root
RUN ln -sf /home/runtime/.local/bin/claude /usr/local/bin/claude

USER runtime
