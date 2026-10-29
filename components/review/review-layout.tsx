"use client";

import { useEffect, useState } from "react";

import { ReviewPanelVisibility } from "@/components/review/panel-visibility";
import { usePickedQuote } from "@/components/review/quote-store";
import { SettingsTabs } from "@/components/settings-tabs";

type ContentTab = "description" | "files";
type SideTab = "info" | "chat";

/** Presentation around server-owned PR data; no extra data reads on a tab switch. */
export function ReviewLayout({
  prKey,
  toolbar,
  heading,
  description,
  files,
  info,
  chat,
}: {
  prKey: string;
  toolbar: React.ReactNode;
  heading: React.ReactNode;
  description: React.ReactNode;
  files: React.ReactNode;
  info: React.ReactNode;
  chat: React.ReactNode;
}) {
  const [content, setContent] = useState<ContentTab>("description");
  const [side, setSide] = useState<SideTab>("info");
  const [filesOpened, setFilesOpened] = useState(false);
  const picked = usePickedQuote(prKey);
  useEffect(() => {
    // A pick is an event from the diff, which must reveal its chat destination.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (picked) setSide("chat");
  }, [picked]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3 sm:px-6">
        {toolbar}
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_340px] lg:overflow-hidden">
        <div className="min-w-0 lg:overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl space-y-6 px-4 pb-8 pt-8 sm:px-8">
            {heading}
            <SettingsTabs
              ids={["description", "files"]}
              active={content}
              onOpen={(tab) => {
                setContent(tab);
                if (tab === "files") setFilesOpened(true);
              }}
              label="Pull request content"
              idPrefix="pull-content"
              tabLabel={(tab) =>
                tab === "description" ? "Description" : "Files"
              }
            />
            <div
              role="tabpanel"
              id="pull-content-panel-description"
              aria-labelledby="pull-content-tab-description"
              hidden={content !== "description"}
            >
              {description}
            </div>
            <ReviewPanelVisibility value={content === "files"}>
              <div
                role="tabpanel"
                id="pull-content-panel-files"
                aria-labelledby="pull-content-tab-files"
                hidden={content !== "files"}
              >
                {filesOpened && files}
              </div>
            </ReviewPanelVisibility>
          </div>
        </div>
        <aside className="flex min-h-[420px] min-w-0 flex-col border-t border-border/60 lg:min-h-0 lg:border-l lg:border-t-0">
          <SettingsTabs
            ids={["info", "chat"]}
            active={side}
            onOpen={setSide}
            label="Pull request sidebar"
            idPrefix="pull-sidebar"
            tabLabel={(tab) => (tab === "info" ? "Info" : "Chat")}
            className="shrink-0 px-4 pt-3"
          />
          <div
            role="tabpanel"
            id="pull-sidebar-panel-info"
            aria-labelledby="pull-sidebar-tab-info"
            hidden={side !== "info"}
            className={
              side === "info" ? "min-h-0 flex-1 overflow-y-auto px-5" : "hidden"
            }
          >
            {info}
          </div>
          <ReviewPanelVisibility value={side === "chat"}>
            <div
              role="tabpanel"
              id="pull-sidebar-panel-chat"
              aria-labelledby="pull-sidebar-tab-chat"
              hidden={side !== "chat"}
              className={
                side === "chat"
                  ? "h-[420px] min-h-0 lg:h-auto lg:flex-1"
                  : "hidden"
              }
            >
              {chat}
            </div>
          </ReviewPanelVisibility>
        </aside>
      </div>
    </div>
  );
}
