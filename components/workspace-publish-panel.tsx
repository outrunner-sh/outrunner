"use client";

import { ExternalLink, GitPullRequest } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { Textarea } from "@/components/ui/textarea";
import type { WorkspacePullRequest } from "@/lib/runtime/types";

export function WorkspacePublishPanel({
  workspaceId,
  branch,
  baseBranch,
  pullRequest,
  active,
  defaultTitle,
}: {
  workspaceId: string;
  branch: string;
  baseBranch: string;
  pullRequest: WorkspacePullRequest | null;
  active: boolean;
  /** The session's title, to start the pull request's title from. */
  defaultTitle?: string | null;
}) {
  const router = useRouter();
  // The session's name (its first prompt) reads as a pull request title;
  // the generated branch name does not.
  const [title, setTitle] = useState(defaultTitle ?? branch);
  const [body, setBody] = useState("");
  // Why it didn't publish, and git's own words when it was git that refused.
  const [message, setMessage] = useState<{ text: string; detail: string | null } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [created, setCreated] = useState<WorkspacePullRequest | null>(pullRequest);

  if (created) {
    return (
      <div className="space-y-3">
        <p className="text-muted-foreground text-sm">
          Published to a pull request against{" "}
          <span className="font-mono">{created.baseBranch}</span>.
        </p>
        <Button asChild size="sm" variant="outline">
          <a href={created.url} rel="noreferrer" target="_blank">
            <GitPullRequest />
            Pull request #{created.number}
            <ExternalLink />
          </a>
        </Button>
      </div>
    );
  }

  function publish(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (publishing || !active) return;
    setPublishing(true);
    void (async () => {
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim(), body }),
        });
        const result = (await response.json().catch(() => ({}))) as {
          pullRequest?: WorkspacePullRequest;
          error?: string;
          detail?: string | null;
        };
        if (!response.ok || !result.pullRequest) {
          setMessage({ text: result.error ?? "Couldn't publish this session.", detail: result.detail ?? null });
          return;
        }
        setMessage(null);
        setCreated(result.pullRequest);
        router.refresh();
      } catch {
        setMessage({ text: "Couldn't reach Outrunner. Check your connection.", detail: null });
      } finally {
        setPublishing(false);
      }
    })();
  }

  return (
    <form className="space-y-3" onSubmit={publish}>
      <p className="text-muted-foreground text-xs">
        Commits all changes as you, pushes <span className="font-mono">{branch}</span>, and opens a
        pull request into <span className="font-mono">{baseBranch}</span>.
      </p>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="pr-title">
          Pull request title
        </label>
        <Input
          id="pr-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={publishing || !active}
          maxLength={256}
          spellCheck={false}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="pr-body">
          Description <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <Textarea
          id="pr-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="What changed and why…"
          disabled={publishing || !active}
          maxLength={8_000}
          rows={3}
          spellCheck={false}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {/* Busy is not disabled: while publishing, the button stays where it is
            and ignores clicks; after a failure it offers to try again. */}
        <LoadingButton
          type="submit"
          status={publishing ? "pending" : message ? "error" : "idle"}
          labels={{ idle: "Publish pull request", pending: "Publishing" }}
          icon={<GitPullRequest />}
          disabled={!active || title.trim().length === 0}
        />
      </div>
      {message && <InlineMessage details={message.detail}>{message.text}</InlineMessage>}
      {!active && (
        <p className="text-muted-foreground text-xs">
          Publishing is available once the workspace is ready.
        </p>
      )}
    </form>
  );
}
