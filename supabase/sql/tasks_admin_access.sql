-- Every admin can manage tasks (2026-10-06).
--
-- The only rule letting anyone change tasks was "Admin and Investor Task Access", which names
-- three emails (video@, info@ and the PANDEN investor contact). Any other admin login, such as
-- support@midasmediafirm.com or a VA's, could read tasks but every update and delete matched no
-- rows. RLS refuses that silently, so archiving, dragging between columns, editing and deleting
-- all looked like they worked and then didn't stick.
--
-- This adds a role-based rule beside the named one. The named rule stays untouched, because
-- it's also what gives the investor contact access (a deliberate exception, see CLAUDE.md).
--
-- Run once in the SQL Editor. Safe to re-run.

begin;

drop policy if exists "Admins manage all tasks" on public.tasks;

create policy "Admins manage all tasks" on public.tasks
    for all
    using (current_user_is_admin())
    with check (current_user_is_admin());

commit;

notify pgrst, 'reload schema';

-- Check afterwards:
--   select policyname, cmd from pg_policies where tablename = 'tasks' order by 1;
