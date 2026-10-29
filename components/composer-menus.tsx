"use client";

import { FileText, History } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isImeKeydown } from "@/lib/session/composing";
import { searchHistory } from "@/lib/session/prompt-history";
import { cn } from "@/lib/utils";

/**
 * The files an @ mention offers, above the composer's text: the best match
 * picked, ↑/↓ to move, Enter or Tab to put it in (the composer's keys, which
 * it hands to `active`). A click picks one too.
 */
export function MentionMenu({
  matches,
  active,
  changed,
  status,
  onPick,
  onHover,
}: {
  matches: string[];
  active: number;
  /** The changed files among them, marked as such. */
  changed: ReadonlySet<string>;
  /** Still listing the files, or couldn't. */
  status: "ready" | "loading" | "error";
  onPick: (path: string) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div className="studio-composer-menu" role="listbox" aria-label="Files to mention">
      {status === "loading" && matches.length === 0 && <p>Listing files…</p>}
      {status === "error" && matches.length === 0 && <p>Couldn&apos;t list this session&apos;s files.</p>}
      {status === "ready" && matches.length === 0 && <p>No file matches.</p>}
      {matches.map((path, i) => {
        const slash = path.lastIndexOf("/");
        return (
          <button
            key={path}
            type="button"
            role="option"
            aria-selected={i === active}
            className={cn(i === active && "is-active")}
            // Before the textarea loses focus, so the caret stays where it is.
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(path);
            }}
            onMouseEnter={() => onHover(i)}
          >
            <FileText aria-hidden />
            <span className="truncate">{path.slice(slash + 1)}</span>
            <span className="studio-composer-menu-dir truncate">{slash > 0 ? path.slice(0, slash) : ""}</span>
            {changed.has(path) && <span className="studio-composer-menu-tag">changed</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Ctrl+R: the user's past prompts, searched as they type, newest first, as a
 * shell's reverse search is. Enter puts the one picked in the composer (to
 * edit before sending), ↑/↓ or Ctrl+R again move through the matches, Escape
 * goes back to the composer as it was.
 */
export function HistorySearch({
  history,
  onPick,
  onClose,
}: {
  history: string[];
  onPick: (prompt: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const matches = searchHistory(history, query).slice(0, 8);
  const shown = Math.min(active, Math.max(0, matches.length - 1));

  return (
    <div className="studio-composer-menu" role="dialog" aria-label="Search your prompts">
      <label className="studio-composer-menu-search">
        <History aria-hidden />
        <input
          ref={inputRef}
          value={query}
          placeholder="Search your prompts…"
          aria-label="Search your prompts"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onBlur={onClose}
          onKeyDown={(event) => {
            if (isImeKeydown(event.nativeEvent)) return;
            const move = (by: number) => {
              event.preventDefault();
              if (matches.length > 0) setActive((shown + by + matches.length) % matches.length);
            };
            if (event.key === "Escape") {
              // Back to the composer, not on to stop the turn.
              event.preventDefault();
              event.stopPropagation();
              onClose();
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (matches[shown] !== undefined) onPick(matches[shown]);
            } else if (event.key === "ArrowDown" || (event.ctrlKey && event.key.toLowerCase() === "r")) {
              move(1);
            } else if (event.key === "ArrowUp") {
              move(-1);
            }
          }}
        />
      </label>
      {matches.length === 0 ? (
        <p>{history.length === 0 ? "Prompts you send show here." : "No prompt matches."}</p>
      ) : (
        matches.map((prompt, i) => (
          <button
            key={`${i}-${prompt}`}
            type="button"
            className={cn("is-prompt", i === shown && "is-active")}
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(prompt);
            }}
            onMouseEnter={() => setActive(i)}
          >
            {prompt}
          </button>
        ))
      )}
    </div>
  );
}
