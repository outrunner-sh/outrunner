import { BOX_IMAGE } from "@/lib/runtime/box-image";

/** The existing OCI image lives on the VM's persistent boot disk. Both the
 * container layer and /home/runtime survive stop/start. No cloud identity is
 * attached to the VM, and no deployment/user secrets enter metadata. */
export function gcpStartupScript(): string {
  return `#!/bin/bash
set -euo pipefail
exec > /var/log/outrunner-startup.log 2>&1
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null; then
  apt-get update -q
  apt-get install -y -q docker.io
fi
systemctl enable --now docker
mkdir -p /var/lib/outrunner/home
if ! docker inspect outrunner-workspace >/dev/null 2>&1; then
  docker pull ${BOX_IMAGE}
  docker run --rm --user root --entrypoint bash -v /var/lib/outrunner/home:/mnt ${BOX_IMAGE} -c 'cp -a /home/runtime/. /mnt/; chown -R runtime:runtime /mnt'
  docker run -d --name outrunner-workspace --restart unless-stopped --init --network host \\
    --mount type=bind,src=/var/lib/outrunner/home,dst=/home/runtime ${BOX_IMAGE} sleep infinity
else
  docker start outrunner-workspace
fi
touch /var/lib/outrunner/ready
`;
}
