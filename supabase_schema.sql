create extension if not exists pgcrypto;

create table if not exists public.fleet_status_overrides (
  id uuid primary key default gen_random_uuid(),
  base_date date not null,
  placa text not null,
  status text not null check (status in ('Disponível', 'Parado', 'Indisponível', 'Em manutenção')),
  updated_at timestamptz not null default now(),
  unique (base_date, placa)
);

create table if not exists public.fleet_maintenance_notices (
  id uuid primary key default gen_random_uuid(),
  base_date date not null,
  placa text not null,
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_fleet_status_overrides_base_date
  on public.fleet_status_overrides (base_date);

create index if not exists idx_fleet_maintenance_notices_base_date
  on public.fleet_maintenance_notices (base_date, created_at desc);

alter table public.fleet_status_overrides enable row level security;
alter table public.fleet_maintenance_notices enable row level security;

-- O app no Render deve usar SUPABASE_SERVICE_ROLE_KEY.
-- A service_role bypassa RLS, entao nao exponha essa chave no navegador.
