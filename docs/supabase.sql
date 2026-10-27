-- Banco do Estúdio (cw-rodrigo.github.io) no Supabase.
-- Cole tudo no SQL Editor do projeto e rode uma vez.
-- Cada usuário tem um documento JSON por app (cifras, timbres, pocketmaster),
-- e as regras (RLS) garantem que ninguém lê nem altera os dados de outra pessoa.

create table if not exists public.user_data (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  app        text        not null check (app in ('cifras', 'timbres', 'pocketmaster')),
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, app),
  constraint user_data_tamanho check (pg_column_size(data) < 5000000)
);

alter table public.user_data enable row level security;

drop policy if exists "ler os próprios dados" on public.user_data;
drop policy if exists "criar os próprios dados" on public.user_data;
drop policy if exists "alterar os próprios dados" on public.user_data;
drop policy if exists "apagar os próprios dados" on public.user_data;

create policy "ler os próprios dados" on public.user_data
  for select to authenticated using (auth.uid() = user_id);
create policy "criar os próprios dados" on public.user_data
  for insert to authenticated with check (auth.uid() = user_id);
create policy "alterar os próprios dados" on public.user_data
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "apagar os próprios dados" on public.user_data
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.user_data from anon;
grant select, insert, update, delete on public.user_data to authenticated;
