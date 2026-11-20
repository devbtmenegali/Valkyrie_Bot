-- =============================================================================
-- VALKYRIE v2 — SUPABASE SCHEMA (Postgres + Row Level Security)
-- Cole no SQL Editor do seu projeto Supabase para criar toda a base da Valkyrie
-- =============================================================================

create extension if not exists pgcrypto;

-- 1. Kanban & Tarefas (8 Pilares)
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code text,
  pillar text not null default 'Inbox de Ideias',
  title text not null,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  priority text not null default 'media' check (priority in ('alta', 'media', 'baixa')),
  due_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_tasks_user_status on public.tasks(user_id, status);

-- 2. Habit Tracker & Day Trade Diário
create table if not exists public.habits_daily (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  workout_type text not null,
  workout_done boolean not null default false,
  reading_done boolean not null default false,
  day_trade_pnl numeric(12,2),
  day_trade_label text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, date)
);

-- 3. Histórico de Chat Sincronizado (Mac + iPhone)
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'valkyrie')),
  content text not null,
  tools_used jsonb default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_chat_user_created on public.chat_messages(user_id, created_at desc);

-- 4. Memória Executiva de Longo Prazo
create table if not exists public.memory_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pillar text not null default 'Geral',
  fact text not null,
  importance text not null default 'media' check (importance in ('alta', 'media', 'baixa')),
  created_at timestamptz not null default now()
);
create index if not exists idx_memory_user_pillar on public.memory_facts(user_id, pillar);

-- 5. Triagem WhatsApp (Evolution API -> PWA)
create table if not exists public.whatsapp_inbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sender_name text not null,
  sender_phone text not null,
  message_text text not null,
  pillar text not null default 'Geral',
  priority text not null default 'media' check (priority in ('alta', 'media', 'baixa')),
  draft_reply text,
  sent_reply text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'dismissed')),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_wa_user_status on public.whatsapp_inbox(user_id, status);

-- 6. Controle Financeiro Pessoal (Pilar 6 — Separação PF vs PJ)
create table if not exists public.finance_pf (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  description text not null,
  amount numeric(12,2) not null,
  due_date date,
  paid boolean not null default false,
  is_pj boolean not null default false,
  ir_deductible boolean not null default false,
  created_at timestamptz not null default now()
);

-- 7. Assinaturas Web Push (VAPID para iPhone e Mac)
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device_label text,
  created_at timestamptz not null default now()
);

-- =============================================================================
-- ROW LEVEL SECURITY (RLS) — Acesso estritamente privado do usuário autenticado
-- =============================================================================
alter table public.tasks enable row level security;
alter table public.habits_daily enable row level security;
alter table public.chat_messages enable row level security;
alter table public.memory_facts enable row level security;
alter table public.whatsapp_inbox enable row level security;
alter table public.finance_pf enable row level security;
alter table public.push_subscriptions enable row level security;

create policy "owner_all_tasks" on public.tasks for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner_all_habits" on public.habits_daily for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner_all_chat" on public.chat_messages for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner_all_memory" on public.memory_facts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner_all_wa" on public.whatsapp_inbox for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner_all_finance" on public.finance_pf for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner_all_push" on public.push_subscriptions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

