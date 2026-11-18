#!/usr/bin/env bash
# Prepare an Ubuntu host for the release helpers. Runs as root; safe to run
# again, so Compute Engine also uses it as its startup script on every boot
# (gcp/provision.sh). Installs what is missing: Docker Engine with Compose
# from Docker's official repository, and the directories the helpers expect.
# Elsewhere: ssh root@host 'bash -s' < deploy/vm/setup-host.sh
set -euo pipefail
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl python3
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
install -d -m 0755 /opt/outrunner/releases /usr/local/lib/outrunner
install -d -m 0700 /etc/outrunner
