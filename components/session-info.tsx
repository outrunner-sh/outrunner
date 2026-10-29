"use client";
import { Info } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { SessionInfo as InfoView } from "@/lib/session/session-info";

export function SessionInfo({
  workspaceId,
  local = false,
}: {
  workspaceId: string;
  local?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wide = useMediaQuery("(min-width: 640px)");
  const trigger = (
    <button
      type="button"
      className="studio-icon-button"
      title="Session info"
      aria-label="Session info"
    >
      <Info />
    </button>
  );
  const content = (
    <SessionInfoContent workspaceId={workspaceId} local={local} />
  );
  if (!wide)
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        <DialogContent aria-modal="true" className="bottom-0 left-0 top-auto max-h-[85dvh] w-full max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-b-none">
          <DialogTitle>Session info</DialogTitle>
          <DialogDescription>
            Read-only details. Inspecting never wakes a paused computer.
          </DialogDescription>
          {content}
        </DialogContent>
      </Dialog>
    );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          aria-label="Session info"
          className="z-50 w-[min(390px,calc(100vw-24px))] space-y-4 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl"
        >
          <h2 className="text-sm font-semibold">Session info</h2>
          {content}
          <Popover.Close className="text-xs text-muted-foreground underline underline-offset-2">
            Close
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SessionInfoContent({
  workspaceId,
  local,
}: {
  workspaceId: string;
  local: boolean;
}) {
  const [result, setResult] = useState<{ info?: InfoView; failed?: boolean }>(
    {},
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    const controller = new AbortController();
    if (!local)
      void fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/info`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("unavailable");
          const info = (await response.json()) as InfoView;
          setResult({ info });
        })
        .catch(() => {
          if (!controller.signal.aborted) setResult({ failed: true });
        });
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [workspaceId, local]);
  const info = result.info;
  if (local)
    return (
      <p className="text-sm text-muted-foreground">
        This session runs on your Mac. Runtime resource measurements are
        unavailable.
      </p>
    );
  if (!info)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {result.failed
          ? "Session details unavailable. Close and reopen to try again."
          : "Reading session details…"}
      </p>
    );
  const bytes = (value: number | null) =>
    value === null ? "Unavailable" : `${(value / 1024 ** 3).toFixed(1)} GiB`;
  const stale =
    info.sampledAt !== null && now - Date.parse(info.sampledAt) > 60000;
  return (
    <div className="space-y-4 text-[13px]">
      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 [&>dt]:text-muted-foreground [&>dd]:text-right">
        <dt>State</dt>
        <dd className="capitalize">{info.state}</dd>
        <dt>Environment</dt>
        <dd>{info.environment ?? "Unavailable"}</dd>
        <dt>Provider</dt>
        <dd>{info.provider}</dd>
        <dt>Runtime image</dt>
        <dd>{info.runtimeVersion ?? "Unavailable"}</dd>
      </dl>
      <table className="w-full text-left text-xs">
        <caption className="sr-only">
          Computer resources: allocated and used
        </caption>
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-2 font-normal">Resource</th>
            <th className="font-normal">Allocated</th>
            <th className="text-right font-normal">Used</th>
          </tr>
        </thead>
        <tbody className="[&>tr]:border-t [&>tr]:border-border/60 [&_td]:py-2">
          <tr>
            <td>CPU</td>
            <td>
              {info.cpu.allocated === null
                ? "Unavailable"
                : `${info.cpu.allocated} vCPU`}
            </td>
            <td className="text-right">
              {info.cpu.used === null
                ? "Unavailable"
                : `${info.cpu.used.toFixed(1)} CPU s`}
            </td>
          </tr>
          <tr>
            <td>Memory</td>
            <td>{bytes(info.memory.allocated)}</td>
            <td className="text-right">{bytes(info.memory.used)}</td>
          </tr>
          <tr>
            <td>Disk</td>
            <td>{bytes(info.disk.allocated)}</td>
            <td className="text-right">{bytes(info.disk.used)}</td>
          </tr>
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">
        CPU used is cumulative computer CPU time. Disk shows filesystem capacity
        and use. Resources may be shared by sessions on this computer.
      </p>
      <p role="status" className="text-xs text-muted-foreground">
        {info.sampledAt
          ? `${stale ? "Stale snapshot" : "Snapshot"} · ${new Date(info.sampledAt).toLocaleTimeString()}. Reopen to refresh.`
          : "Measurements unavailable. Paused computers are not woken to inspect them."}{" "}
        No live telemetry.
      </p>
    </div>
  );
}
