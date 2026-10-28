-- A session's first prompt goes to Claude once, however often the browser
-- sends it (a reload mid-send, Send it again, a tab without sessionStorage):
-- each send names the idempotency key the new-session screen made with it,
-- and the message route claims the session's first prompt for that key
-- before sending (lib/db/repositories.ts, claimFirstPrompt), then marks it
-- sent once the box has it. A repeat of the key answers as sent, without
-- sending; one while the claim's send is still going is told to try again.
-- Released when the send fails, so a retry still goes; a claim whose send
-- never finished (its server stopped) is taken over by a repeat after a
-- while. first_prompt_claimed_at is the claim's token too: renewed as the
-- prompt goes to the box, and matched by its request's renew, mark and
-- release, so a request whose claim was taken over can't touch the new one.
-- Null until a first prompt is claimed, and for every session from before
-- this.
--
-- One per session, so on the row itself, under its owner's policy
-- (workspaces_owner_all), as its title is.
-- ---------------------------------------------------------------------------

alter table workspaces
  add column if not exists first_prompt_key text
    check (first_prompt_key is null or length(first_prompt_key) between 1 and 100),
  add column if not exists first_prompt_claimed_at timestamptz,
  add column if not exists first_prompt_sent_at timestamptz;
