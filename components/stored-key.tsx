"use client";

/** A field for a key or a token's part, hidden unless `reveal` (a token id,
 *  which isn't secret). */
export function KeyInput({
  value,
  onChange,
  onKeyDown,
  placeholder,
  label,
  reveal,
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  placeholder: string;
  label: string;
  reveal?: boolean;
}) {
  return (
    <input
      type={reveal ? "text" : "password"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      aria-label={label}
      // "off" doesn't stop browsers or password managers filling a password
      // field with a saved login; a key is never one.
      autoComplete={reveal ? "off" : "new-password"}
      data-1p-ignore
      data-lpignore="true"
      data-bwignore
      spellCheck={false}
      className="border-border bg-transparent h-9 min-w-48 flex-1 rounded-md border px-3 text-sm"
    />
  );
}
