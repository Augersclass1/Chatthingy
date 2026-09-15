-- Chatthingy Supabase setup
-- Run this entire file in Supabase Dashboard -> SQL Editor.
-- Then put the Project URL + PUBLIC anon/publishable key in app.js.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-zA-Z0-9_]{3,24}$'),
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  name text,
  is_group boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id,user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);

-- Admin/moderation flags. Only @felix is made admin below.
alter table public.profiles add column if not exists is_admin boolean not null default false;
alter table public.profiles add column if not exists is_blocked boolean not null default false;
alter table public.profiles add column if not exists is_banned boolean not null default false;

create index if not exists posts_created_at_idx on public.posts(created_at desc);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id,created_at);
create index if not exists members_user_idx on public.conversation_members(user_id);

-- Automatically make a profile when someone signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  requested_username text;
begin
  requested_username := lower(coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1)));
  requested_username := regexp_replace(requested_username, '[^a-z0-9_]', '_', 'g');
  requested_username := left(requested_username,24);
  if length(requested_username) < 3 then
    requested_username := 'user_' || substr(new.id::text,1,8);
  end if;
  if exists(select 1 from public.profiles where username=requested_username) then
    requested_username := left(requested_username,15) || '_' || substr(new.id::text,1,8);
  end if;
  insert into public.profiles(id,username,display_name,is_admin)
  values(new.id,requested_username,coalesce(new.raw_user_meta_data->>'display_name',requested_username),requested_username='felix');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Admin helper. SECURITY DEFINER avoids recursive RLS checks on profiles.
create or replace function public.is_admin(uid uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id=uid),false);
$$;

grant execute on function public.is_admin(uuid) to authenticated;

-- Helper avoids recursive RLS policies on conversation_members.
create or replace function public.is_conversation_member(cid uuid, uid uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists(select 1 from public.conversation_members where conversation_id=cid and user_id=uid);
$$;

grant execute on function public.is_conversation_member(uuid,uuid) to authenticated;

-- Create a private conversation atomically.
create or replace function public.create_private_conversation(other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_id uuid;
  new_id uuid;
begin
  if auth.uid() is null or other_user_id = auth.uid() then
    raise exception 'Invalid user';
  end if;
  if not exists(select 1 from public.profiles where id=other_user_id and not is_banned) then
    raise exception 'User not found';
  end if;
  if exists(select 1 from public.profiles where id=auth.uid() and (is_banned or is_blocked)) then
    raise exception 'Your account is restricted';
  end if;
  select c.id into existing_id
  from public.conversations c
  where c.is_group=false
    and exists(select 1 from public.conversation_members m where m.conversation_id=c.id and m.user_id=auth.uid())
    and exists(select 1 from public.conversation_members m where m.conversation_id=c.id and m.user_id=other_user_id)
    and (select count(*) from public.conversation_members m where m.conversation_id=c.id)=2
  limit 1;
  if existing_id is not null then return existing_id; end if;
  insert into public.conversations(is_group) values(false) returning id into new_id;
  insert into public.conversation_members(conversation_id,user_id) values(new_id,auth.uid()),(new_id,other_user_id);
  return new_id;
end;
$$;

grant execute on function public.create_private_conversation(uuid) to authenticated;

-- Admin-only moderation action.
create or replace function public.admin_set_user_status(target_user_id uuid, blocked boolean, banned boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin(auth.uid()) or target_user_id=auth.uid() then
    raise exception 'Not authorized';
  end if;
  update public.profiles set is_blocked=blocked,is_banned=banned where id=target_user_id;
  if not found then raise exception 'User not found'; end if;
  return true;
end;
$$;

grant execute on function public.admin_set_user_status(uuid,boolean,boolean) to authenticated;

alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;

-- Profiles are searchable by signed-in users so private/group chat creation works.
drop policy if exists "profiles readable by signed in users" on public.profiles;
create policy "profiles readable by signed in users" on public.profiles for select to authenticated using (true);
drop policy if exists "users can update own profile" on public.profiles;
create policy "users can update own profile" on public.profiles for update to authenticated using (id=auth.uid()) with check (id=auth.uid());
drop policy if exists "admins can update profiles" on public.profiles;
create policy "admins can update profiles" on public.profiles for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- Public posts: admins can moderate everything; restricted users cannot create posts.
drop policy if exists "signed in users can read posts" on public.posts;
create policy "signed in users can read posts" on public.posts for select to authenticated using ((select public.is_admin()) or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_banned));
drop policy if exists "users can create own posts" on public.posts;
create policy "users can create own posts" on public.posts for insert to authenticated with check (author_id=auth.uid() and not exists(select 1 from public.profiles p where p.id=auth.uid() and (p.is_banned or p.is_blocked)));
drop policy if exists "users can delete own posts" on public.posts;
create policy "users can delete own posts" on public.posts for delete to authenticated using (author_id=auth.uid());
drop policy if exists "admins can delete any posts" on public.posts;
create policy "admins can delete any posts" on public.posts for delete to authenticated using ((select public.is_admin()));
drop policy if exists "users can update own posts" on public.posts;
create policy "users can update own posts" on public.posts for update to authenticated using (author_id=auth.uid()) with check (author_id=auth.uid());

-- Conversations: normal users see only their chats; admins see every chat.
drop policy if exists "members can read conversations" on public.conversations;
create policy "members can read conversations" on public.conversations for select to authenticated using ((select public.is_admin()) or (public.is_conversation_member(id) and not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_banned)));
drop policy if exists "signed in users can create conversations" on public.conversations;
create policy "signed in users can create conversations" on public.conversations for insert to authenticated with check (not exists(select 1 from public.profiles p where p.id=auth.uid() and (p.is_banned or p.is_blocked)));
drop policy if exists "members can update group conversations" on public.conversations;
create policy "members can update group conversations" on public.conversations for update to authenticated using ((select public.is_admin()) or public.is_conversation_member(id)) with check ((select public.is_admin()) or public.is_conversation_member(id));

-- Membership records: admins can inspect all; normal users stay within their own chats.
drop policy if exists "members can read memberships" on public.conversation_members;
create policy "members can read memberships" on public.conversation_members for select to authenticated using ((select public.is_admin()) or public.is_conversation_member(conversation_id));
drop policy if exists "users can join conversations" on public.conversation_members;
create policy "users can join conversations" on public.conversation_members for insert to authenticated with check ((select public.is_admin()) or ((user_id=auth.uid() or public.is_conversation_member(conversation_id)) and not exists(select 1 from public.profiles p where p.id=auth.uid() and (p.is_banned or p.is_blocked))));
drop policy if exists "users can leave conversations" on public.conversation_members;
create policy "users can leave conversations" on public.conversation_members for delete to authenticated using ((select public.is_admin()) or user_id=auth.uid() or public.is_conversation_member(conversation_id));

-- Messages: admins can inspect/delete everything; normal users see only their conversations.
drop policy if exists "members can read messages" on public.messages;
create policy "members can read messages" on public.messages for select to authenticated using ((select public.is_admin()) or (public.is_conversation_member(conversation_id) and not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_banned)));
drop policy if exists "members can send messages" on public.messages;
create policy "members can send messages" on public.messages for insert to authenticated with check (user_id=auth.uid() and public.is_conversation_member(conversation_id) and not exists(select 1 from public.profiles p where p.id=auth.uid() and (p.is_banned or p.is_blocked)));
drop policy if exists "users can delete own messages" on public.messages;
create policy "users can delete own messages" on public.messages for delete to authenticated using (user_id=auth.uid());
drop policy if exists "admins can delete any messages" on public.messages;
create policy "admins can delete any messages" on public.messages for delete to authenticated using ((select public.is_admin()));

-- Enable realtime for posts and messages. Safe to run repeatedly.
do $$
begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='posts') then
    alter publication supabase_realtime add table public.posts;
  end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

-- Make the existing @felix account the admin now. If @felix does not exist yet,
-- the signup trigger above will automatically make a future @felix account admin.
update public.profiles set is_admin=true where lower(username)='felix';

-- Browser grants.
grant select on public.profiles,public.posts,public.conversations,public.conversation_members,public.messages to authenticated;
grant insert,update,delete on public.posts to authenticated;
grant insert,update on public.conversations to authenticated;
grant insert,delete on public.conversation_members to authenticated;
grant insert,delete on public.messages to authenticated;
