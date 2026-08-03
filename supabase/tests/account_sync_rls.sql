begin;

create extension if not exists pgtap with schema extensions;
select plan(6);

select has_table('public', 'conversations', 'conversations table exists');
select has_table('public', 'messages', 'messages table exists');
select has_table('public', 'user_settings', 'user settings table exists');

insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'one@example.com', '', now(), now()),
  ('22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'two@example.com', '', now(), now());

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

insert into public.conversations (id, user_id, title, created_at, updated_at)
values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '11111111-1111-1111-1111-111111111111',
  'Owned conversation',
  1,
  1
);

select is(
  (select count(*) from public.conversations),
  1::bigint,
  'an authenticated user can read their own row'
);

select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select is(
  (select count(*) from public.conversations),
  0::bigint,
  'a different authenticated user cannot read the row'
);

select throws_ok(
  $$
    insert into public.conversations (id, user_id, title, created_at, updated_at)
    values (
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      '11111111-1111-1111-1111-111111111111',
      'Cross-user write',
      2,
      2
    )
  $$,
  '42501',
  null,
  'a user cannot insert a row owned by another user'
);

select * from finish();
rollback;
