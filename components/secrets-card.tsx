"use client";

import { ArrowUp, ClipboardPaste, Eye, EyeOff, KeyRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { parseDotenv } from "@/lib/environments/rules";
import { isImeKeydown } from "@/lib/session/composing";
import { type PendingSecretRequest, providedValues } from "@/lib/runtime/pending-secrets";

/**
 * The secrets the session's agent asked for (request_secrets), in place of
 * the composer: a password field per variable, a box to paste a whole .env
 * into (it fills the fields it names), and, where the session has a project,
 * they are saved there for its next sessions. Enter sends once every
 * required variable has a value; Escape skips.
 *
 * The values never touch the conversation: they go to the session's agent,
 * and the agent is told only their names. Mount it keyed by the call's id.
 */
export function SecretsCard({
  request,
  agentLabel,
  canSave,
  hidden = false,
  onProvide,
  onSkip,
}: {
  request: PendingSecretRequest;
  /** Who asks: "Claude". */
  agentLabel: string;
  /** Cloud sessions save supplied values to their project automatically. */
  canSave: boolean;
  /** Kept mounted, hidden, while the answer is on the way, so a failed send
   *  offers it again with the values as they were. */
  hidden?: boolean;
  onProvide: (values: Record<string, string>) => void;
  onSkip: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const active = document.activeElement;
    if (!hidden && (active === null || active === document.body)) firstRef.current?.focus();
  }, [hidden]);

  const ready = providedValues(request, values);
  const submit = () => {
    if (ready) onProvide(ready);
  };

  // A pasted .env fills the fields it names; the rest of it is dropped.
  const fillFrom = (text: string) => {
    setPasted(text);
    const { env } = parseDotenv(text);
    const names = new Set(request.keys.map((k) => k.name));
    const found = Object.fromEntries(Object.entries(env).filter(([name, value]) => names.has(name) && value !== ""));
    if (Object.keys(found).length > 0) setValues((prev) => ({ ...prev, ...found }));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isImeKeydown(event.nativeEvent)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onSkip();
    } else if (event.key === "Enter" && !event.shiftKey && (event.target as HTMLElement).tagName !== "TEXTAREA") {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div
      className="studio-question"
      role="group"
      aria-label={`${agentLabel} is asking for secrets`}
      hidden={hidden}
      onKeyDown={onKeyDown}
    >
      <div className="studio-question-head">
        <span className="inline-flex items-center gap-1.5">
          <KeyRound className="size-3.5" /> {agentLabel} needs {request.keys.length === 1 ? "a secret" : "secrets"}
        </span>
        <button type="button" onClick={onSkip} aria-label="Skip" title="Skip (Esc)">
          <X />
        </button>
      </div>
      <p className="studio-question-text">{request.reason}</p>
      <ul className="studio-secrets-fields">
        {request.keys.map((key, i) => {
          const visible = shown.has(key.name);
          return (
            <li key={key.name} className="studio-secrets-field">
              <label htmlFor={`secret-${key.name}`}>
                {key.name}
                {key.optional && <small>optional</small>}
                {key.description && <small>{key.description}</small>}
              </label>
              <div className="studio-secrets-input">
                <input
                  ref={i === 0 ? firstRef : undefined}
                  id={`secret-${key.name}`}
                  type={visible ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore
                  value={values[key.name] ?? ""}
                  placeholder={key.optional ? "Leave blank to skip" : "Paste the value"}
                  onChange={(event) => setValues((prev) => ({ ...prev, [key.name]: event.target.value }))}
                />
                <button
                  type="button"
                  aria-label={visible ? `Hide ${key.name}` : `Show ${key.name}`}
                  onClick={() =>
                    setShown((prev) => {
                      const next = new Set(prev);
                      if (next.has(key.name)) next.delete(key.name);
                      else next.add(key.name);
                      return next;
                    })
                  }
                >
                  {visible ? <EyeOff /> : <Eye />}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {pasting ? (
        <textarea
          className="studio-secrets-dotenv"
          aria-label="Paste a .env"
          placeholder="Paste a .env: the variables asked for are filled in"
          spellCheck={false}
          autoComplete="off"
          value={pasted}
          onChange={(event) => fillFrom(event.target.value)}
        />
      ) : null}
      <p className="studio-secrets-note">
        Sent straight to this session, never into the chat. {agentLabel} only learns which ones you gave.
        {canSave && " Saved to this project for future sessions."}
      </p>
      <div className="studio-question-foot">
        <span className="inline-flex items-center gap-3">
          {!pasting && (
            <button type="button" className="studio-secrets-paste" onClick={() => setPasting(true)}>
              <ClipboardPaste /> Paste a .env
            </button>
          )}
        </span>
        <span className="studio-secrets-actions">
          <button type="button" className="studio-secrets-skip" onClick={onSkip}>
            Skip
          </button>
          <button
            type="button"
            className="studio-question-send"
            aria-label="Provide"
            title="Provide (Enter)"
            disabled={!ready}
            onClick={submit}
          >
            <ArrowUp />
          </button>
        </span>
      </div>
    </div>
  );
}
