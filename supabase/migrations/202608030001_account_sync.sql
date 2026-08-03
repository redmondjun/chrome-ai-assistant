create table public.conversations (
  id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  created_at bigint not null,
  updated_at bigint not null,
  primary key (user_id, id)
);

create table public.messages (
  id uuid not null,
  user_id uuid not null,
  conversation_id uuid not null,
  payload jsonb not null,
  created_at bigint not null,
  updated_at bigint not null,
  primary key (user_id, id),
  foreign key (user_id, conversation_id)
    references public.conversations(user_id, id) on delete cascade
);

create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null,
  updated_at bigint not null
);

create index conversations_owner_updated_idx
  on public.conversations(user_id, updated_at desc);
create index messages_conversation_created_idx
  on public.messages(user_id, conversation_id, created_at);

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.user_settings enable row level security;

create policy "owners manage conversations" on public.conversations
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "owners manage messages" on public.messages
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "owners manage settings" on public.user_settings
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.conversations, public.messages, public.user_settings from anon;
grant select, insert, update, delete on public.conversations, public.messages, public.user_settings
  to authenticated;

create or replace function public.prune_conversation_messages()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  delete from public.messages
  where user_id = new.user_id
    and conversation_id = new.conversation_id
    and id in (
      select id from public.messages
      where user_id = new.user_id and conversation_id = new.conversation_id
      order by created_at desc
      offset 100
    );
  return new;
end;
$$;

create trigger prune_messages_after_insert
after insert or update on public.messages
for each row execute function public.prune_conversation_messages();
