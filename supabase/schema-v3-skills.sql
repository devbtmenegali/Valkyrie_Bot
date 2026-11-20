-- =============================================================================
-- VALKYRIE v3 — SKILLS SCHEMA (Contatos/Família/Fornecedores, Finanças/Cobranças, Idiomas)
-- Execute no SQL Editor do Supabase: https://supabase.com/dashboard/project/otemuqoisjdslsivfymo/sql
-- =============================================================================

-- 1. CRM Pessoal: Família (Val, Lucca, Caio), Fornecedores (Nossa Casa), Sócios e Clientes
create table if not exists public.valkyrie_contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'familia' check (category in ('familia', 'fornecedor', 'socio', 'cliente', 'outro')),
  relation text default '',
  phone text default '',
  email text default '',
  birthday text default '', -- formato MM-DD (ex: 05-14)
  gift_preferences text default '',
  company text default '',
  notes text default '',
  allow_auto_message boolean not null default false,
  created_at timestamptz not null default now()
);

-- 2. Finanças PF/PJ & Contas a Pagar / Receber + Cobranças
create table if not exists public.valkyrie_finance (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('pagar', 'receber')),
  scope text not null default 'PF', -- PF | GluN | Nossa Casa | ProntoMed | CliniMind
  counterparty text not null,
  contact_phone text default '',
  description text not null,
  amount numeric(12,2) not null default 0,
  due_date date not null,
  status text not null default 'pendente' check (status in ('pendente', 'pago', 'atrasado')),
  ir_deductible boolean not null default false,
  last_collection_at timestamptz,
  notes text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_valkyrie_fin_due on public.valkyrie_finance(due_date, status);

-- 3. Registro de Treinos de Idiomas (10 min Inglês + 10 min Espanhol/dia)
create table if not exists public.valkyrie_language_sessions (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  language text not null check (language in ('en', 'es')),
  duration_sec integer not null default 600,
  topic text default 'Conversação Livre',
  feedback text default '',
  created_at timestamptz not null default now()
);

alter table public.valkyrie_contacts enable row level security;
alter table public.valkyrie_finance enable row level security;
alter table public.valkyrie_language_sessions enable row level security;

-- Seed inicial da família (sem duplicar se já existir)
insert into public.valkyrie_contacts (name, category, relation, notes)
select v.name, 'familia', v.relation, 'Completar WhatsApp, aniversário (MM-DD) e preferências de presente'
from (values
  ('Val', 'Família'),
  ('Lucca', 'Família'),
  ('Caio', 'Família')
) as v(name, relation)
where not exists (select 1 from public.valkyrie_contacts c where lower(c.name) = lower(v.name));
