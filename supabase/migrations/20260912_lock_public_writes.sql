-- Run only after the Netlify admin functions have been deployed and tested.
-- This leaves all league data publicly readable while making every write server-only.

begin;

delete from public.admin_config where key = 'admin_password';

do $$
declare
  policy_row record;
begin
  for policy_row in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = any(array[
        'series', 'drivers', 'seasons', 'events', 'sessions', 'results',
        'scoring_config', 'classification_config', 'career_stats', 'admin_config',
        'circuits', 'circuit_layouts', 'season_drivers', 'cars', 'event_groups'
      ])
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policy_row.policyname,
      policy_row.schemaname,
      policy_row.tablename
    );
  end loop;
end $$;

alter table public.series enable row level security;
alter table public.drivers enable row level security;
alter table public.seasons enable row level security;
alter table public.events enable row level security;
alter table public.sessions enable row level security;
alter table public.results enable row level security;
alter table public.scoring_config enable row level security;
alter table public.classification_config enable row level security;
alter table public.career_stats enable row level security;
alter table public.admin_config enable row level security;
alter table public.circuits enable row level security;
alter table public.circuit_layouts enable row level security;
alter table public.season_drivers enable row level security;
alter table public.cars enable row level security;
alter table public.event_groups enable row level security;

revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
grant select on all tables in schema public to anon, authenticated;

create policy public_read_series on public.series for select to anon, authenticated using (true);
create policy public_read_drivers on public.drivers for select to anon, authenticated using (true);
create policy public_read_seasons on public.seasons for select to anon, authenticated using (true);
create policy public_read_events on public.events for select to anon, authenticated using (true);
create policy public_read_sessions on public.sessions for select to anon, authenticated using (true);
create policy public_read_results on public.results for select to anon, authenticated using (true);
create policy public_read_scoring_config on public.scoring_config for select to anon, authenticated using (true);
create policy public_read_classification_config on public.classification_config for select to anon, authenticated using (true);
create policy public_read_career_stats on public.career_stats for select to anon, authenticated using (true);
create policy public_read_admin_config on public.admin_config for select to anon, authenticated using (true);
create policy public_read_circuits on public.circuits for select to anon, authenticated using (true);
create policy public_read_circuit_layouts on public.circuit_layouts for select to anon, authenticated using (true);
create policy public_read_season_drivers on public.season_drivers for select to anon, authenticated using (true);
create policy public_read_cars on public.cars for select to anon, authenticated using (true);
create policy public_read_event_groups on public.event_groups for select to anon, authenticated using (true);

commit;
