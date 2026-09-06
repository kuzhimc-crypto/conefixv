-- CONEFIX authentication table for Supabase/Postgres
-- Run this once in Supabase SQL Editor.
create table if not exists public.conefix_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- The Express server uses the Supabase service-role key, so browser users
-- never receive direct database access. Do not expose the service-role key.
alter table public.conefix_users enable row level security;
