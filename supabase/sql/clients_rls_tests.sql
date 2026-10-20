-- =============================================================================
-- Tests for clients_rls.sql. Run this FIRST, before clients_rls.sql itself.
-- =============================================================================
-- Paste the whole file and run it once. It:
--   1. applies exactly the policy change clients_rls.sql makes, inside its own transaction;
--   2. signs in as eight people in turn (set local role + request.jwt.claims), and for each
--      one reads clients, then tries to update another client, update the rows it can see,
--      delete a row, and insert a client;
--   3. ends in a deliberate error. The red error box IS the result: one line per person,
--      PASS or FAIL. Raising it is also what guarantees the rollback, because an aborted
--      transaction can't commit. Nothing here survives, not even the policy change.
--
-- Nothing can reach anyone: the only insert trigger on clients is the welcome email, and
-- every client this inserts has no client_email, so the trigger returns before calling
-- pg_net. (pg_net only sends committed requests anyway.)
--
-- The people, using real accounts so the real user_client_access and client_email data is
-- what gets tested:
--   client, access row only     djbask.tv@gmail.com          -> PANDEN Construction only
--   client, email fallback only nick@altavistaconstruction.co -> Alta Vista Construction only
--   client, both paths          office@altavistaconstruction.co -> Alta Vista Construction only
--   member                      tennyvid@gmail.com, made a member of KLH Exteriors and
--                               SimpliBlinds for this test only -> exactly those two
--   signed in, no access        video@modasmediafirm.com (pending) -> nothing
--   anon (no sign-in)           -> nothing
--   investor                    alpha@pandenconstruction.com -> every row, writes nothing
--   admin                       video@midasmediafirm.com -> everything, writes work
-- Every non-admin must get 0 rows from each update and the delete, and have the insert
-- refused.

begin;

-- 1. The change under test, copied from clients_rls.sql (keep the two in step)
drop policy if exists "Enable read access for authenticated users"   on public.clients;
drop policy if exists "Enable insert access for authenticated users" on public.clients;
drop policy if exists "Enable insert for authenticated users only"   on public.clients;
drop policy if exists "Enable update access for authenticated users" on public.clients;
drop policy if exists "Enable delete access for authenticated users" on public.clients;
drop policy if exists "Admins manage all clients"        on public.clients;
drop policy if exists "Clients read their own client row" on public.clients;
alter table public.clients enable row level security;
create policy "Admins manage all clients" on public.clients for all to authenticated
    using (current_user_is_admin()) with check (current_user_is_admin());
create policy "Clients read their own client row" on public.clients for select to authenticated
    using (client_row_visible(name));

do $$
declare
    p            record;
    v_out        text := '';
    v_fail       int  := 0;
    v_total      int;
    v_other_id   clients.id%type;
    v_victim_id  clients.id%type;
    v_seen       text[];
    n_upd_other  int;
    n_upd_own    int;
    n_del        int;
    v_ins        text;
    v_ok         boolean;
begin
    -- Test-only setup, as the editor's own role (rolled back with everything else)
    update user_profiles set role = 'member' where email = 'tennyvid@gmail.com';
    insert into user_client_access (user_email, client_name)
    values ('tennyvid@gmail.com', 'KLH Exteriors'), ('tennyvid@gmail.com', 'SimpliBlinds')
    on conflict do nothing;

    -- A row for everyone to try deleting. Only the admin, who goes last, should manage it.
    insert into clients (name, status, current_stage)
    values ('zz RLS test: delete me', 'archived', 'Onboarding')
    returning id into v_victim_id;

    -- "Another client" for the update test: one none of the scoped people can see
    select id into v_other_id from clients where name = '3Sixty Industries' limit 1;
    select count(*) into v_total from clients;

    for p in
        select * from (values
            (1, 'client, access row only',      'djbask.tv@gmail.com',             'authenticated', array['PANDEN Construction'],              false, false),
            (2, 'client, email fallback only',  'nick@altavistaconstruction.co',   'authenticated', array['Alta Vista Construction'],          false, false),
            (3, 'client, both paths',           'office@altavistaconstruction.co', 'authenticated', array['Alta Vista Construction'],          false, false),
            (4, 'member (KLH + SimpliBlinds)',  'tennyvid@gmail.com',              'authenticated', array['KLH Exteriors', 'SimpliBlinds'],    false, false),
            (5, 'signed in, no access',         'video@modasmediafirm.com',        'authenticated', array[]::text[],                           false, false),
            (6, 'anon (not signed in)',         null,                              'anon',          array[]::text[],                           false, false),
            (7, 'investor',                     'alpha@pandenconstruction.com',    'authenticated', null::text[],                              true,  false),
            (8, 'admin',                        'video@midasmediafirm.com',        'authenticated', null::text[],                              true,  true)
        ) as v(n, label, email, pg_role, expect, sees_all, is_admin)
        order by n
    loop
        perform set_config('request.jwt.claims',
            json_build_object('email', p.email, 'role', p.pg_role,
                              'sub', '00000000-0000-0000-0000-000000000000')::text, true);
        execute format('set local role %I', p.pg_role);

        select coalesce(array_agg(name::text order by name), array[]::text[]) into v_seen from clients;

        update clients set status = status where id = v_other_id;
        get diagnostics n_upd_other = row_count;

        update clients set status = status where name = any(v_seen);
        get diagnostics n_upd_own = row_count;

        delete from clients where id = v_victim_id;
        get diagnostics n_del = row_count;

        begin
            insert into clients (name, status, current_stage)
            values ('zz RLS test: insert by ' || p.label, 'archived', 'Onboarding');
            v_ins := 'allowed';
        exception when insufficient_privilege then
            v_ins := 'refused';
        end;

        reset role;

        if p.is_admin then
            v_ok := cardinality(v_seen) = v_total and n_upd_other = 1 and n_del = 1 and v_ins = 'allowed';
        elsif p.sees_all then
            v_ok := cardinality(v_seen) = v_total and n_upd_other = 0 and n_upd_own = 0 and n_del = 0 and v_ins = 'refused';
        else
            v_ok := v_seen = p.expect and n_upd_other = 0 and n_upd_own = 0 and n_del = 0 and v_ins = 'refused';
        end if;
        if not v_ok then v_fail := v_fail + 1; end if;

        v_out := v_out || format(E'%s  %s | sees %s | update other=%s, update own=%s, delete=%s, insert %s\n',
            case when v_ok then 'PASS' else 'FAIL' end, p.label,
            case when p.sees_all then cardinality(v_seen) || ' of ' || v_total || ' rows'
                 when cardinality(v_seen) = 0 then 'nothing'
                 else array_to_string(v_seen, ', ') end,
            n_upd_other, n_upd_own, n_del, v_ins);
    end loop;

    raise exception E'CLIENTS RLS TEST RESULTS (rolled back)\n%\n%',
        v_out,
        case when v_fail = 0 then 'ALL 8 PASSED — safe to run clients_rls.sql'
             else v_fail || ' FAILED — do not run clients_rls.sql; send these results to Claude' end;
end $$;

rollback;
