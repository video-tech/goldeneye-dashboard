-- Tasks hidden from the client (2026-09-15).
--
-- tasks.client_visible = false keeps a task on our board but out of the client's portal, their
-- daily work summary and the weekly report. Set with "Hide from client" in the task drawer.
-- Default true, so every existing task stays exactly as visible as it is today.
--
-- Hidden has to mean hidden in the DATABASE, not just in app.js: a client's browser reads tasks
-- straight from Supabase, so a flag only the page respected would still be readable in DevTools.
-- So the client read policy below requires client_visible. Admins still see everything.
--
-- Not affected: the "Admin and Investor Task Access" policy (full access for two Midas addresses
-- and the one client contact treated as an investor, see CLAUDE.md). That contact can still read
-- hidden tasks. That's deliberate and unchanged.

alter table tasks add column if not exists client_visible boolean not null default true;

-- Same policy as CLAUDE.md's tasks fix (2026-09-10), plus "and client_visible" on the two client
-- branches. Drop and create in one transaction so there's never a moment with no policy.
begin;
drop policy if exists "Clients read their own client's tasks" on tasks;
create policy "Clients read their own client's tasks"
on tasks for select
using (
    current_user_is_admin()
    or (
        client_visible
        and (
            user_has_client_access(client)
            or exists (
                select 1 from clients c
                where c.client_email is not null and c.client_email <> ''
                  and lower(regexp_replace(c.name, '[^a-zA-Z0-9]', '', 'g'))
                    = lower(regexp_replace(coalesce(tasks.client, ''), '[^a-zA-Z0-9]', '', 'g'))
                  and lower(auth.email()) = any (string_to_array(lower(regexp_replace(c.client_email, '\s', '', 'g')), ','))
            )
        )
    )
);
commit;

notify pgrst, 'reload schema';

-- Checking on it:
--   select client, title, client_visible from tasks where not client_visible order by updated_at desc;
-- Confirm no OTHER select policy lets clients read tasks (any extra USING (true) one would undo this):
--   select policyname, cmd, qual from pg_policies where tablename = 'tasks';
