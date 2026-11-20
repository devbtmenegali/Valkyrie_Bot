-- =============================================================================
-- VALKYRIE v2 — SUPABASE SCHEMA (Prefixo valkyrie_* para não conflitar com tabelas existentes)
-- Cole e execute no SQL Editor do Supabase: https://supabase.com/dashboard/project/otemuqoisjdslsivfymo/sql
-- =============================================================================

create extension if not exists pgcrypto;

-- 1. Estado chave-valor da Valkyrie (Kanban markdown, hábitos, preferências)
create table if not exists public.valkyrie_kv (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 2. Histórico de Chat Sincronizado (Mac + iPhone + Railway)
create table if not exists public.valkyrie_messages (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('user', 'valkyrie')),
  content text not null,
  time_label text,
  tools_used jsonb default '[]'::jsonb,
  provider_used text,
  created_at timestamptz not null default now()
);
create index if not exists idx_valkyrie_msg_created on public.valkyrie_messages(created_at desc);

-- 3. Memória Executiva de Longo Prazo
create table if not exists public.valkyrie_memory (
  id uuid primary key default gen_random_uuid(),
  pillar text not null default 'Geral',
  fact text not null,
  created_at timestamptz not null default now()
);

-- 4. Triagem WhatsApp (Evolution API -> PWA)
create table if not exists public.valkyrie_whatsapp_inbox (
  id uuid primary key default gen_random_uuid(),
  sender_name text not null,
  sender_phone text not null,
  message_text text not null,
  pillar text not null default 'Geral',
  priority text not null default 'media',
  draft_reply text,
  sent_reply text,
  delivery_note text,
  status text not null default 'pending',
  simulated boolean not null default false,
  time_label text,
  sent_at text,
  created_at timestamptz not null default now()
);

-- 5. Habit Tracker & Day Trade Diário
create table if not exists public.valkyrie_habits (
  date date primary key,
  day_label text,
  workout_name text,
  workout_done boolean not null default false,
  reading_done boolean not null default false,
  trade_text text default '⬜',
  notes text default '',
  updated_at timestamptz not null default now()
);

-- Bloqueia acesso anônimo público (apenas o servidor Valkyrie com sb_secret acessa)
alter table public.valkyrie_kv enable row level security;
alter table public.valkyrie_messages enable row level security;
alter table public.valkyrie_memory enable row level security;
alter table public.valkyrie_whatsapp_inbox enable row level security;
alter table public.valkyrie_habits enable row level security;
