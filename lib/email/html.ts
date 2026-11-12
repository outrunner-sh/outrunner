/**
 * The HTML an email is sent with, next to its plain text (lib/email/send.ts).
 * No dependencies and no remote images: one table layout with inline styles,
 * which Gmail and Outlook both render, dark text on white, the Outrunner
 * wordmark set as text, and one button to act on.
 *
 * Every value is escaped here, so callers pass user-supplied text (an org's
 * name, an inviter's, an email address) as it is.
 */

export type EmailLayout = {
  /** Shown by inboxes after the subject, hidden in the email itself. */
  preheader?: string;
  heading: string;
  /** Paragraphs before the button, each plain text. */
  body: readonly string[];
  /** The button: what it says, and the http(s) link it opens. */
  action: { label: string; url: string };
  /** Small print under the button, each plain text. */
  footer?: readonly string[];
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const TEXT = "#18181b";
const MUTED = "#52525b";
const BORDER = "#e4e4e7";

/** `value` safe as HTML text or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A link a button may open: an absolute http(s) URL, so nothing like
 *  `javascript:`; null for anything else. */
function safeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
  } catch {
    // Not an absolute URL: a path, with no origin to put before it.
  }
  return null;
}

/** The whole HTML document for an email laid out as `layout`. Without an
 *  absolute http(s) link there's no button: the text says where to go. */
export function emailHtml(layout: EmailLayout): string {
  const url = safeUrl(layout.action.url);
  const label = escapeHtml(layout.action.label);
  const preheader = layout.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;opacity:0;">${escapeHtml(layout.preheader)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(layout.heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:#ffffff;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
<tr><td style="padding:0 0 24px;font-family:${FONT};font-size:18px;font-weight:700;letter-spacing:-0.02em;color:${TEXT};">Outrunner</td></tr>
<tr><td style="border:1px solid ${BORDER};border-radius:8px;padding:32px;background-color:#ffffff;">
<h1 style="margin:0 0 16px;font-family:${FONT};font-size:20px;line-height:28px;font-weight:600;color:${TEXT};">${escapeHtml(layout.heading)}</h1>
${layout.body.map(paragraph).join("\n")}
${url ? button(escapeHtml(url), label) : ""}
${(layout.footer ?? []).map(small).join("\n")}
</td></tr>
<tr><td style="padding:16px 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">Sent by Outrunner.</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:24px;color:${TEXT};">${escapeHtml(text)}</p>`;
}

function small(text: string): string {
  return `<p style="margin:0 0 8px;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};">${escapeHtml(text)}</p>`;
}

/** The button, and the link spelled out under it for clients that drop it.
 *  Outlook on Windows draws the VML; everything else the styled link. */
function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
<tr><td align="center" bgcolor="${TEXT}" style="border-radius:6px;background-color:${TEXT};">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${href}" style="height:44px;v-text-anchor:middle;width:220px;" arcsize="14%" stroke="f" fillcolor="${TEXT}"><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${label}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${href}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:6px;">${label}</a><!--<![endif]-->
</td></tr>
</table>
${small("If the button doesn't work, copy this link into your browser:")}
<p style="margin:0 0 16px;font-family:${FONT};font-size:13px;line-height:20px;word-break:break-all;"><a href="${href}" target="_blank" style="color:${TEXT};text-decoration:underline;">${href}</a></p>`;
}
