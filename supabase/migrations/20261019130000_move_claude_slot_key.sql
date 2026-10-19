-- Move an Anthropic API key out of the Claude slot (user_credentials) to the
-- Anthropic provider (user_provider_keys), atomically: the slot is cleared
-- only if it still holds `sealed`, and the key is copied only if this call
-- cleared it. Two requests that read the same key can't both move it, so a
-- slow one can't copy back a key the user removed after the first one moved
-- it. An Anthropic key already saved with the provider is newer, and kept.
-- True when this call moved it. Only the service role may run it; see
-- lib/providers/claude-slot.ts.
create or replace function move_claude_slot_key(mover uuid, sealed text, hint text)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- Locks the row: a second call waits here, then finds the slot changed.
  update user_credentials
    set anthropic_key_ciphertext = null, anthropic_key_hint = null, anthropic_key_updated_at = null
    where user_id = mover and anthropic_key_ciphertext = sealed;
  if not found then
    return false;
  end if;
  insert into user_provider_keys (user_id, provider, key_ciphertext, key_hint)
    values (mover, 'anthropic', sealed, hint)
    on conflict (user_id, provider) do nothing;
  return true;
end;
$$;

revoke all on function move_claude_slot_key(uuid, text, text) from public, anon, authenticated;
grant execute on function move_claude_slot_key(uuid, text, text) to service_role;
