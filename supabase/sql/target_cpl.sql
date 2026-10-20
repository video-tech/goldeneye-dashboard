-- clients.target_cpl: the cost per lead we expect from a client's ads.
--
-- The morning audit (supabase/functions/morning-audit/engine.js) judges a client against this
-- when it is set, and against their own last 28 days when it is not. It also anchors the
-- "spend rule": CPL at double the target on $200+ a week is CRITICAL.
--
-- Edited in Edit Client -> Target CPL. The column already exists in production, so this is
-- for a fresh database and is safe to re-run.

alter table clients add column if not exists target_cpl numeric;

notify pgrst, 'reload schema';
