"use client";

import { Archive, MessageSquarePlus, PanelRight, PanelRightClose } from "lucide-react";
import Link from "next/link";
import { DRAFTS } from "@/lib/client/drafts";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { CollapsedSidebarButtons, MobileNavButton } from "@/components/app-frame";
import { useAppData } from "@/components/app-data";
import { ChatSwitcher } from "@/components/chat-switcher";
import { ArchiveSessionDialog } from "@/components/archive-session-dialog";
import { ArchiveMissionDialog } from "@/components/missions/archive-mission-dialog";
import { SessionInfo } from "@/components/session-info";
import { MissionHeader } from "@/components/missions/mission-header";
import { RunnersPane } from "@/components/missions/runners-pane";
import { OpenEditorButton } from "@/components/open-editor-button";
import { SlackThreadLink } from "@/components/slack-thread-link";
import { SessionComposer } from "@/components/session-composer";
import { SessionDidntStart } from "@/components/session-didnt-start";
import { SetupStalled } from "@/components/setup-stalled";
import { Spinner } from "@/components/ui/loaders";
import { WorkspaceCreating } from "@/components/workspace-creating";
import { WorkspaceDesktop } from "@/components/workspace-desktop";
import { WorkspaceEnvironment } from "@/components/workspace-environment";
import { type SessionSender, WorkspaceSession } from "@/components/workspace-session";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useMission } from "@/hooks/use-missions";
import { useModalPanel } from "@/hooks/use-modal-panel";
import { useSessionChats } from "@/hooks/use-session-chats";
import { useRestoreOnOpen } from "@/hooks/use-restore-on-open";
import { useWorkspaceSetup } from "@/hooks/use-workspace-setup";
import { AGENT_IDS } from "@/lib/agents/registry";
import { replaceAddressBar } from "@/lib/client/address-bar";
import { localSessionLabel } from "@/lib/desktop/local-sessions";
import { missionArchiveOffer, unarchivedShipCount } from "@/lib/missions/archive";
import type { LocalSession } from "@/lib/desktop/local-runtime";
import { workspaceLabel } from "@/lib/nav/session-title";
import { onRuntimeComputer, opensInBrowser, type Workspace, type WorkspacePullRequest } from "@/lib/runtime/types";
import { archiveOffer } from "@/lib/session/archive-control";
import { type InspectorTabId, inspectorTabs, shownTab } from "@/lib/session/inspector-tabs";
import { chatRoute, chatStateKey, MAIN_CHAT, mainChatOf, parseChatId, type SessionChat } from "@/lib/session/chats";
import { askSideChat } from "@/lib/session/chat-actions";
import { cn } from "@/lib/utils";

/** The session itself: a header across the top, then the chat, with its
 *  Environment (changes, branch, pull request) on the right, and beside it in
 *  a tab, on a cloud session that has one, its box's Desktop. The app
 *  sidebar to its left belongs to the layout (app/(app)/layout.tsx); collapsed,
 *  its buttons sit at the start of this header. */
export function WorkspaceStudio({
  workspace,
  projectName,
  local,
  pullRequest,
  initialPrompt,
  initialPromptKey,
  initialAttachmentIds,
}: {
  workspace: Workspace;
  /** The repository's name, shown while a new cloud session's box is set up. */
  projectName?: string;
  /** Set for a local session, which runs on this Mac and is driven through the
   *  Outrunner app rather than the server. */
  local?: LocalSession;
  /** The session's pull request, shown in the Environment panel when there is one. */
  pullRequest: WorkspacePullRequest | null;
  /** First prompt carried in from the new-session screen, sent once connected. */
  initialPrompt?: string;
  /** The first prompt's idempotency key (lib/session/first-prompt.ts). */
  initialPromptKey?: string;
  /** Attachment ids staged on the home composer, sent with the first prompt. */
  initialAttachmentIds?: string[];
}) {
  // Where the window is narrow, the panel covers the chat (globals.css), so
  // it starts closed there, and open beside the chat where there's room. A
  // choice holds until the window crosses that width.
  const narrow = useMediaQuery("(max-width: 1100px)");
  const [rightChoice, setRightChoice] = useState<{ narrow: boolean; open: boolean } | null>(null);
  const rightOpen = rightChoice?.narrow === narrow ? rightChoice.open : !narrow;
  const setRightOpen = (open: boolean) => setRightChoice({ narrow, open });
  // Covering the chat, it is a dialog: a backdrop, Esc, and focus kept in it.
  const overlay = narrow && rightOpen;
  const inspector = useModalPanel<HTMLElement>(overlay, () => setRightOpen(false));
  // How the Environment panel's Create PR sends into the session, while it can.
  const [sender, setSender] = useState<SessionSender | null>(null);
  const coAuthor = useAppData()?.coAuthor;
  const isLocal = local !== undefined;
  const { state: setup, phase, hasComputer, keepWaiting } = useWorkspaceSetup(workspace, !isLocal);
  // An archived session (one imported from a Mac) comes back as it opens.
  const restore = useRestoreOnOpen(workspace, !isLocal);
  const isReady = workspace.status === "ready" || workspace.status === "idle";
  const hasLiveSession = isReady && (onRuntimeComputer(workspace.provider) || isLocal);
  const offline = offlineCopy({ workspace, isReady });
  const [infoOpen, setInfoOpen] = useState(false);
  // Beside the title: the repository by its short name, or this Mac's folder.
  const place = local ? local.name : projectName?.split("/").pop();
  // A Runner's page: its header, and its Ships where a session's
  // Environment is (components/missions).
  const isMission = workspace.kind === "mission";
  const { mission } = useMission(isMission ? workspace.id : undefined);
  // Archive, for a cloud session that has a Snapshot to restore from; a
  // Runner's takes its Ships with it. Once it is archived, leave it: left
  // open, this page would restore it at once.
  const archive = isLocal ? null : isMission ? missionArchiveOffer(workspace) : archiveOffer(workspace);
  const archiveLabel = isMission ? "Archive Runner" : "Archive session";
  const [archiving, setArchiving] = useState(false);
  const router = useRouter();
  const leave = () => {
    router.push("/");
    router.refresh();
  };
  // The right pane's tabs, its strip shown where there are two or more. The
  // pane remembers the one chosen while it's closed, not across pages.
  const tabs = inspectorTabs(workspace, isLocal);
  const [chosenTab, setChosenTab] = useState<InspectorTabId>("environment");
  const tab = shownTab(tabs, chosenTab);
  // The chat shown (?chat=): the session's main one unless another is
  // picked. A local session, and a Mission, have the main one alone.
  const chatsOffered = hasLiveSession && !isLocal && !isMission;
  const main = mainChatOf(workspace);
  const chats = useSessionChats(workspace.id, main, chatsOffered);
  const search = useSearchParams();
  const [chatId, setChatId] = useState(() => parseChatId(search.get("chat")) ?? MAIN_CHAT);
  const [shownSession, setShownSession] = useState(workspace.id);
  if (shownSession !== workspace.id) {
    setShownSession(workspace.id);
    setChatId(parseChatId(search.get("chat")) ?? MAIN_CHAT);
  }
  const current = chats.chats.find((chat) => chat.id === chatId) ?? main;
  const pick = (chat: SessionChat) => {
    if (!chats.isCurrent()) return;
    setChatId(chat.id);
    const url = new URL(window.location.href);
    if (chat.id === MAIN_CHAT) url.searchParams.delete("chat");
    else url.searchParams.set("chat", chat.id);
    replaceAddressBar(url.toString());
  };
  // `/btw`: a side chat about the one shown, asked at once, then shown.
  // The chat it is about carries on with its turn.
  const askAside = async (question: string): Promise<boolean> => {
    try {
      const accepted = await askSideChat({
        create: () => chats.start({ from: current.id, side: true, question }),
        send: async (side) => (await fetch(chatRoute(workspace.id, side.id, "message"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: question }),
        })).ok,
        remove: (side) => chats.remove(side.id),
        pick,
      });
      if (!accepted) chats.reportError("Couldn't send the side-chat question. Please try again.");
      return accepted;
    } catch (error) {
      console.warn(`Side chat: couldn't ask in ${workspace.id}`, error);
      chats.reportError(error instanceof Error ? error.message : "Couldn't start the chat. Please try again.");
      return false;
    }
  };

  return (
    <div
      className={cn(
        "studio-shell",
        !rightOpen && "no-inspector",
        isMission && "is-mission",
        rightOpen && tab === "desktop" && "desktop-open",
      )}
    >
      <header className="studio-header">
        <div className="studio-title">
          <MobileNavButton className="-ml-2" />
          <CollapsedSidebarButtons className="mr-1 flex shrink-0 items-center gap-0.5" />
          {isMission ? (
            <MissionHeader missionId={workspace.id} fallbackTitle={workspaceLabel(workspace)} />
          ) : (
            <>
              <span
                className={cn("studio-status", `is-${workspace.status}`)}
                title={workspace.status}
                aria-label={`Session ${workspace.status}`}
                role="img"
              />
              <h2>{local ? localSessionLabel(local) : workspaceLabel(workspace)}</h2>
              {place && <span className="studio-title-place">{place}</span>}
              {chatsOffered && <ChatSwitcher chats={chats} current={current} agents={AGENT_IDS} onPick={pick} />}
            </>
          )}
        </div>
        <div className="studio-header-actions">
          <SessionInfo
            workspaceId={workspace.id}
            local={isLocal}
            open={infoOpen}
            onOpenChange={setInfoOpen}
            details={setup !== "ended" ? <WorkspaceCreating
              projectName={projectName ?? workspaceLabel(workspace)}
              branch={workspace.baseBranch}
              startedAt={workspace.createdAt}
              phase={phase}
              hasExistingComputer={hasComputer}
              stalled={setup === "stalled" && <SetupStalled workspace={workspace} onKeepWaiting={keepWaiting} />}
            /> : undefined}
          />
          {/* VS Code on the session's own box: cloud sessions only. */}
          {!isLocal && workspace.slackThreadUrl && (
            <SlackThreadLink workspaceId={workspace.id} url={workspace.slackThreadUrl} sync={workspace.slackSync !== false} />
          )}
          {hasLiveSession && !isLocal && opensInBrowser(workspace.provider) && <OpenEditorButton workspaceId={workspace.id} />}
          {archive && (
            <button
              className="studio-icon-button aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
              // Not `disabled`: a disabled button shows no tooltip saying why.
              aria-disabled={!archive.can}
              onClick={() => {
                if (archive.can) setArchiving(true);
              }}
              title={archive.can ? archiveLabel : archive.why}
              aria-label={archiveLabel}
            >
              <Archive />
            </button>
          )}
          <button
            className="studio-icon-button"
            onClick={() => setRightOpen(!rightOpen)}
            title={isMission ? (rightOpen ? "Hide Ships" : "Show Ships") : rightOpen ? "Hide environment" : "Show environment"}
            aria-pressed={rightOpen}
          >
            {rightOpen ? <PanelRightClose /> : <PanelRight />}
          </button>
        </div>
      </header>
      {isMission ? (
        <ArchiveMissionDialog
          mission={archiving ? { id: workspace.id, title: mission?.title ?? workspaceLabel(workspace), ships: unarchivedShipCount(mission?.runners ?? []) } : null}
          onOpenChange={setArchiving}
          onArchived={leave}
        />
      ) : (
        <ArchiveSessionDialog
          session={archiving ? { id: workspace.id, title: workspaceLabel(workspace) } : null}
          onOpenChange={setArchiving}
          // The sidebar marks it archived at once (lib/session/optimistic-archive.ts).
          onArchived={() => router.push("/")}
        />
      )}

      <section className="studio-chat">
        {hasLiveSession && chatId !== MAIN_CHAT && !chats.loaded && !chats.chats.some((chat) => chat.id === chatId) ? (
          <div className="studio-offline"><div className="studio-empty-chat" role="status"><Spinner /> Loading chat…</div></div>
        ) : hasLiveSession && chatId !== MAIN_CHAT && !chats.chats.some((chat) => chat.id === chatId) ? (
          <div className="studio-offline"><div className="studio-empty-chat" role="alert"><h3>{chats.error ?? "This chat is no longer available."}</h3></div></div>
        ) : hasLiveSession || setup !== "ended" ? (
          <WorkspaceSession
            // Each chat its own page state: its conversation, queue, picks.
            key={current.id}
            workspaceId={workspace.id}
            startup={setup !== "ended" ? { startedAt: workspace.createdAt, stalled: setup === "stalled", onDetails: () => setInfoOpen(true) } : undefined}
            chatId={current.id}
            projectId={isLocal ? undefined : workspace.projectId}
            agent={current.agent}
            recorded={current.model}
            initialMode={current.id === MAIN_CHAT ? workspace.mode : "build"}
            local={isLocal}
            untitled={!isLocal && !workspace.title && current.id === MAIN_CHAT}
            // The session's first prompt is its main chat's.
            initialPrompt={current.id === MAIN_CHAT ? initialPrompt : undefined}
            initialPromptKey={current.id === MAIN_CHAT ? initialPromptKey : undefined}
            initialAttachmentIds={current.id === MAIN_CHAT ? initialAttachmentIds : undefined}
            onSender={setSender}
            onSideChat={chatsOffered ? askAside : undefined}
            onHarnessFork={chatsOffered ? async (agent) => {
              const fork = await chats.start({ from: current.id, agent });
              if (!chats.isCurrent()) return;
              const sourceKey = `ws:${chatStateKey(workspace.id, current.id)}`;
              const targetKey = `ws:${chatStateKey(workspace.id, fork.id)}`;
              DRAFTS.move(sourceKey, targetKey);
              pick(fork);
            } : undefined}
          />
        ) : restore.state === "restoring" ? (
          <div className="studio-offline">
            <div className="studio-empty-chat" role="status">
              <div className="studio-empty-icon"><Spinner /></div>
              <h3>Restoring this session</h3>
              <p>
                Bringing back its conversation, commits and changes on a cloud computer. It takes a minute or two
                when its computer has to start.
              </p>
            </div>
            <SessionComposer
              onSend={() => {}}
              canSend={false}
              disabledPlaceholder="The session picks up where it left off once it's restored"
            />
          </div>
        ) : restore.state === "failed" ? (
          <div className="studio-offline">
            <div className="studio-empty-chat" role="alert">
              <div className="studio-empty-icon"><MessageSquarePlus /></div>
              <h3>This session didn&apos;t restore</h3>
              <p>{restore.error}</p>
              <p className="flex justify-center gap-4">
                {restore.settingsHref && (
                  <Link href={restore.settingsHref} className="text-(--studio-text) underline underline-offset-4">
                    Open settings
                  </Link>
                )}
                {restore.retry && (
                  <button type="button" onClick={restore.retry} className="text-(--studio-text) underline underline-offset-4">
                    Try again
                  </button>
                )}
              </p>
            </div>
            <SessionComposer onSend={() => {}} canSend={false} disabledPlaceholder="Restore the session to continue it" />
          </div>
        ) : workspace.status === "failed" && !isLocal ? (
          <div className="studio-offline">
            <SessionDidntStart
              workspace={workspace}
              detail={workspace.errorMessage ?? "Its box couldn't be set up. Nothing was lost; try again to start a fresh one."}
            />
            <SessionComposer onSend={() => {}} canSend={false} disabledPlaceholder="Try again to start a fresh session" />
          </div>
        ) : (
          <div className="studio-offline">
            <div className="studio-empty-chat">
              <div className="studio-empty-icon"><MessageSquarePlus /></div>
              <h3>{offline.title}</h3>
              <p>{offline.detail}</p>
            </div>
            <SessionComposer onSend={() => {}} canSend={false} disabledPlaceholder={offline.placeholder} />
          </div>
        )}
      </section>

      {overlay && <div aria-hidden className="studio-inspector-backdrop" onClick={() => setRightOpen(false)} />}
      {/* Each tab's panel mounts only while it is open: the rows poll for
          changes, and the desktop is started, and its socket held, only
          while someone looks at it. */}
      <aside
        ref={inspector}
        className={cn("studio-inspector", isMission ? "studio-runners" : "studio-env", overlay && "is-overlay")}
        hidden={!rightOpen}
        role={overlay ? "dialog" : undefined}
        aria-modal={overlay || undefined}
        aria-label={isMission ? "Ships" : (tabs.find((t) => t.id === tab)?.label ?? "Environment")}
      >
        {rightOpen && isMission && <RunnersPane missionId={workspace.id} onClose={() => setRightOpen(false)} />}
        {rightOpen && tabs.length > 1 && (
          <div className="studio-tabs" role="tablist" aria-label="Session panels">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`studio-tab-${t.id}`}
                aria-selected={t.id === tab}
                aria-controls="studio-tabpanel"
                onClick={() => setChosenTab(t.id)}
                className="studio-tab"
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        {rightOpen && !isMission && (
          <div
            className="studio-tabpanel"
            {...(tabs.length > 1 && { id: "studio-tabpanel", role: "tabpanel", "aria-labelledby": `studio-tab-${tab}` })}
          >
            {tab === "desktop" ? (
              <WorkspaceDesktop workspaceId={workspace.id} isReady={isReady} onClose={() => setRightOpen(false)} />
            ) : (
              <WorkspaceEnvironment
                workspace={workspace}
                local={local}
                pullRequest={pullRequest}
                isReady={isReady}
                sender={sender}
                coAuthor={coAuthor}
                onClose={() => setRightOpen(false)}
              />
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

/** Why there is no live session, in the words the empty chat shows. */
function offlineCopy({
  workspace,
  isReady,
}: {
  workspace: Workspace;
  isReady: boolean;
}): { title: string; detail: string; placeholder: string } {
  // A cloud one gets SessionDidntStart instead; this is a local one's.
  if (workspace.status === "failed") {
    return {
      title: "This session didn't start",
      detail: workspace.errorMessage ?? "Its setup stopped before it finished. Start a new session to try again.",
      placeholder: "Start a new session to try again",
    };
  }
  if (workspace.status === "archived") {
    // Restored as it opens (useRestoreOnOpen) on a Runtime Computer; this is
    // one on a sandbox that can't.
    return {
      title: "Session archived",
      detail: "Restoring it needs a cloud computer, which this session's sandbox is not.",
      placeholder: "Archived sessions restore on a cloud computer",
    };
  }
  if (isReady) {
    return {
      title: "Live session unavailable",
      detail: "Live sessions need a cloud sandbox provider, which this server is not using.",
      placeholder: "Live sessions need a cloud sandbox provider",
    };
  }
  return {
    title: "Live session unavailable",
    detail: "The workspace session will attach when provisioning completes.",
    placeholder: "The session will attach once the workspace is ready",
  };
}
