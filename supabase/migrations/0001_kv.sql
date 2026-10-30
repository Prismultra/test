-- Tavernkeep storage: a versioned key-value table.
-- Only the service role (used by the bot server) can read or write it.

create table if not exists public.kv (
  key text primary key,
  value jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.kv enable row level security;
-- No policies: anon and authenticated roles get no access. The service role bypasses RLS.
revoke all on table public.kv from anon, authenticated;
grant select, insert, update, delete on table public.kv to service_role;

-- Conditional write. p_mode is 'any' (upsert), 'create' (insert only) or 'cas'
-- (update only when version = p_expected). Returns the new version, or null
-- when the condition failed.
create or replace function public.kv_put(
  p_key text,
  p_value jsonb,
  p_mode text default 'any',
  p_expected integer default null
)
returns integer
language plpgsql
set search_path = public
as $$
declare
  new_version integer;
begin
  if p_mode = 'create' then
    insert into kv (key, value, version) values (p_key, p_value, 1)
    on conflict (key) do nothing
    returning version into new_version;
  elsif p_mode = 'cas' then
    update kv set value = p_value, version = version + 1, updated_at = now()
    where key = p_key and version = p_expected
    returning version into new_version;
  elsif p_mode = 'any' then
    insert into kv (key, value, version) values (p_key, p_value, 1)
    on conflict (key) do update set value = excluded.value, version = kv.version + 1, updated_at = now()
    returning version into new_version;
  else
    raise exception 'unknown mode %', p_mode;
  end if;
  return new_version;
end;
$$;

revoke all on function public.kv_put(text, jsonb, text, integer) from public, anon, authenticated;
grant execute on function public.kv_put(text, jsonb, text, integer) to service_role;
