-- A session's first prompt goes to Claude once, however often the browser
-- sends it (a reload mid-send, Send it again, a tab without sessionStorage):
-- each send names the idempotency key the new-session screen made with it,
-- and the message route claims the session's first prompt for that key
-- before sending (lib/db/repositories.ts, claimFirstPrompt). A repeat of the
-- key finds it claimed and answers as sent, without sending. Released when
-- the send fails, so a retry still goes. Null until a first prompt is sent,
-- and for every session from before this.
--
-- One per session, so on the row itself, under its owner's policy
-- (workspaces_owner_all), as its title is.
-- ---------------------------------------------------------------------------

alter table workspaces
  add column if not exists first_prompt_key text
    check (first_prompt_key is null or length(first_prompt_key) between 1 and 100);
