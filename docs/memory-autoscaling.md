# Automatic sandbox memory

Daytona sessions automatically request more RAM under memory pressure. The
runtime agent samples cgroup v2 every two seconds, subtracting reclaimable
inactive file cache. Two consecutive samples at 80% of the limit trigger a
check; at 95%, one sample is enough. This runs without an open browser.

The notification to `/api/runtime/memory-scale` is signed with the box's agent
secret. The server checks the ready computer, its owner's org membership and
current session plan (including the automation connector's own plan). It takes
a database lease for that sandbox, then independently reads live cgroup usage.
Old reports cannot repeatedly grow a box whose pressure has already cleared.
Pooled and stopped computers are excluded.

Memory grows to the next 2, 4, 8 or 16 GiB step, capped at the session plan's
largest size: Free and automation connectors at 4 GiB, Pro at 8 GiB, Max and
Enterprise at 16 GiB. This cap also applies to sessions on user-owned Daytona.
Daytona must allow resizing for the account; provider refusals are logged and
retried with backoff. The control plane enables the monitor only on backends
that support hot memory growth; other providers do not resize.

The resize changes only RAM. CPU, disk, processes and files stay in place, and
cloud-hour metering keeps using the unchanged CPU allocation. A 90-second
database lease prevents concurrent requests or an agent restart from causing
successive increases. At the plan cap, notifications back off to five minutes.
Memory is not automatically decreased: Daytona requires stopping a box to
shrink it. The existing idle pause still applies.

This reduces build-time OOMs but cannot guarantee avoiding a sudden allocation
spike. It does not restart a process already killed by the kernel or lift a
separate memory limit inside a nested container. New or upgraded runtime agents
run the monitor; older agents need their usual upgrade before they report
pressure. No manual environment configuration or database migrations are required.
