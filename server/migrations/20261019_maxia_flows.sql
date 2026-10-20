-- MaxIA 4.6: flujos = la IA configura una herramienta procedural (Construir / Distribuir) a precio fijo.
create table if not exists public.maxia_flows (
  id          text primary key,              -- igual al campo "flujo" del JSON de la herramienta
  nombre      text not null,
  credits     numeric not null default 30,   -- precio fijo por uso (1 credito = $0.01)
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);
alter table public.maxia_flows enable row level security;   -- solo service role (edge functions)

insert into public.maxia_flows (id, nombre, credits) values
  ('construir.lamas', 'Lamas / parteluces', 30)
on conflict (id) do nothing;
