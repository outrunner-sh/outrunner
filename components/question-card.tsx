"use client";

import { ArrowUp, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isImeKeydown } from "@/lib/session/composing";
import { type AskAnswer, isAnswered, type PendingQuestion } from "@/lib/runtime/pending-question";
import { cn } from "@/lib/utils";

/**
 * The questions the session's agent is waiting on, in place of the composer:
 * one at a time, each a numbered list of its options and an "Other" to type
 * into. Keys work as soon as it shows: 1–4 pick an option, 0 goes to Other,
 * ←/→ move between questions, Enter sends and Escape dismisses (from Other,
 * it steps back to the options first).
 *
 * Mount it keyed by the call's id: its answers are that call's. They go to
 * that call alone: sent with its transcript id (question.toolUseId), which
 * an agent that names its calls resolves to the exact call it holds
 * (lib/runtime/answer-question.ts), refusing the answer if that call is over
 * rather than giving it to a later one asking the same.
 */
export function QuestionCard({
  question,
  agentLabel,
  hidden = false,
  onAnswer,
  onDismiss,
}: {
  question: PendingQuestion;
  /** Who asks: "Claude". */
  agentLabel: string;
  /** Kept mounted, hidden, while its answer is on the way, so a failed send
   *  offers it again with the answers as they were. */
  hidden?: boolean;
  onAnswer: (answers: AskAnswer[]) => void;
  onDismiss: () => void;
}) {
  const { questions } = question;
  const [page, setPage] = useState(0);
  const [answers, setAnswers] = useState<AskAnswer[]>(() => questions.map(() => ({ selected: [], other: "" })));
  const cardRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);

  // Focused when it shows, so the keys answer at once: unless the user is
  // typing elsewhere (the terminal), where a digit would pick an option. The
  // composer it replaces has gone, leaving the focus on the page.
  useEffect(() => {
    const active = document.activeElement;
    if (!hidden && (active === null || active === document.body)) cardRef.current?.focus();
  }, [hidden]);

  const current = questions[page];
  const answer = answers[page];
  const complete = questions.every((q, i) => isAnswered(q, answers[i]));
  const last = page === questions.length - 1;

  const update = (next: AskAnswer) => setAnswers((prev) => prev.map((a, i) => (i === page ? next : a)));

  const pick = (label: string) => {
    if (current.multiSelect) {
      const selected = answer.selected.includes(label)
        ? answer.selected.filter((l) => l !== label)
        : [...answer.selected, label];
      update({ ...answer, selected });
      return;
    }
    // One answer: a pick replaces what was typed, and moves on.
    update({ selected: [label], other: "" });
    if (!last) setPage(page + 1);
  };

  const type = (other: string) =>
    update(current.multiSelect || other.trim() === "" ? { ...answer, other } : { selected: [], other });

  const submit = () => {
    if (complete) onAnswer(answers);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isImeKeydown(event.nativeEvent)) return;
    const typing = event.target === otherRef.current;
    if (event.key === "Escape") {
      event.preventDefault();
      // From Other, back to the card: dismissing takes a second Escape.
      if (typing) cardRef.current?.focus();
      else onDismiss();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (complete) submit();
      else if (isAnswered(current, answer) && !last) setPage(page + 1);
    } else if (!typing && event.key === "ArrowLeft" && page > 0) {
      setPage(page - 1);
    } else if (!typing && event.key === "ArrowRight" && !last) {
      setPage(page + 1);
    } else if (!typing && event.key === "0") {
      event.preventDefault();
      otherRef.current?.focus();
    } else if (!typing && /^[1-9]$/.test(event.key)) {
      const option = current.options[Number(event.key) - 1];
      if (option) {
        event.preventDefault();
        pick(option.label);
      }
    }
  };

  return (
    <div
      ref={cardRef}
      className="studio-question"
      role="group"
      aria-label={`${agentLabel} is asking`}
      tabIndex={-1}
      hidden={hidden}
      onKeyDown={onKeyDown}
    >
      <div className="studio-question-head">
        <span>
          {page + 1}. {current.header?.trim() || "Question"}
        </span>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" title="Dismiss (Esc)">
          <X />
        </button>
      </div>
      <p className="studio-question-text">{current.question}</p>
      <ol className="studio-question-options">
        {current.options.map((option, i) => {
          const selected = answer.selected.includes(option.label);
          return (
            <li key={`${i}-${option.label}`}>
              <button
                type="button"
                className={cn(selected && "is-selected")}
                aria-pressed={selected}
                onClick={() => pick(option.label)}
              >
                <span className="studio-question-key">{i + 1}</span>
                <span className="studio-question-choice">
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </span>
              </button>
            </li>
          );
        })}
        <li className={cn("studio-question-other", answer.other.trim() !== "" && "is-selected")}>
          <span className="studio-question-key">0</span>
          <input
            ref={otherRef}
            value={answer.other}
            placeholder="Other…"
            aria-label="Other answer"
            spellCheck={false}
            onChange={(event) => type(event.target.value)}
          />
        </li>
      </ol>
      <div className="studio-question-foot">
        {questions.length > 1 ? (
          <span className="studio-question-pager">
            <button type="button" aria-label="Previous question" disabled={page === 0} onClick={() => setPage(page - 1)}>
              <ChevronLeft />
            </button>
            {questions.map((q, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Question ${i + 1}`}
                aria-current={i === page ? "step" : undefined}
                className={cn("studio-question-dot", isAnswered(q, answers[i]) && "is-answered")}
                onClick={() => setPage(i)}
              />
            ))}
            <button type="button" aria-label="Next question" disabled={last} onClick={() => setPage(page + 1)}>
              <ChevronRight />
            </button>
          </span>
        ) : (
          <span />
        )}
        <button
          type="button"
          className="studio-question-send"
          aria-label={questions.length > 1 ? "Send answers" : "Send answer"}
          title="Send (Enter)"
          disabled={!complete}
          onClick={submit}
        >
          <ArrowUp />
        </button>
      </div>
    </div>
  );
}
