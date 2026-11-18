/**
 * Save `blob` as a file named `name`, as a link with `download` does: the
 * browser's downloads, or in the Mac app the Downloads folder (its shell
 * takes a `download` link's blob there and shows it in Finder). The blob's
 * URL is let go a minute later, not at once: Safari reads it after the
 * click returns.
 */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
