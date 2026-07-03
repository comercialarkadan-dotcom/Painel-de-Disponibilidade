create extension if not exists pgcrypto;

create table if not exists public.fleet_status_overrides (
  id uuid primary key default gen_random_uuid(),
  base_date date not null,
  placa text not null,
  status text not null,
  os_number text,
  no_os_observation text,
  updated_by text,
  updated_at timestamptz not null default now(),
  unique (base_date, placa)
);

alter table public.fleet_status_overrides
  add column if not exists os_number text,
  add column if not exists no_os_observation text,
  add column if not exists updated_by text;

alter table public.fleet_status_overrides
  drop constraint if exists fleet_status_overrides_status_check;

alter table public.fleet_status_overrides
  add constraint fleet_status_overrides_status_check
  check (status in ('Disponível', 'Parado', 'Indisponível', 'Em manutenção', 'Desmobilizada'));

create table if not exists public.fleet_maintenance_notices (
  id uuid primary key default gen_random_uuid(),
  base_date date not null,
  placa text not null,
  text text not null,
  updated_by text,
  created_at timestamptz not null default now()
);

alter table public.fleet_maintenance_notices
  add column if not exists updated_by text;

create table if not exists public.fleet_daily_history (
  base_date date primary key,
  rows jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

create index if not exists idx_fleet_status_overrides_base_date
  on public.fleet_status_overrides (base_date);

create index if not exists idx_fleet_maintenance_notices_base_date
  on public.fleet_maintenance_notices (base_date, created_at desc);

create index if not exists idx_fleet_daily_history_base_date
  on public.fleet_daily_history (base_date);

alter table public.fleet_status_overrides enable row level security;
alter table public.fleet_maintenance_notices enable row level security;
alter table public.fleet_daily_history enable row level security;

-- O app no Render deve usar SUPABASE_SECRET_KEY.
-- Essa chave fica somente no servidor. Nao coloque essa chave no navegador.
