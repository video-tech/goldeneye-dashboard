-- One-off (2026-10-16): two archived placeholder clients from August are stored twice under the same name, which broke
-- onboarding_client_facts() for every client (fixed separately in onboarding_client_facts_fix.sql). This deletes the
-- OLDER copy of each, by its exact id. Both copies are empty placeholders; the older ones even hold the placeholder ad
-- account "THEIR_AD_ACCOUNT_ID". The newer copy of each stays, still archived, so nothing filed under the name is orphaned.

begin;

delete from public.clients
 where id in ('f5206275-a716-4e5b-b3ff-91af5e5b4ee4',   -- Custom Professional Renovations, 2026-08-11
              '7aaa14b0-1832-4423-9b14-a60880e2d3cc')   -- SUNDARA Medical, 2026-08-11
   and status = 'archived'
   and ad_account_id = 'THEIR_AD_ACCOUNT_ID';

-- Stop here if anything else would be hit: exactly one row of each name must remain
do $$ begin
    if (select count(*) from public.clients where name in ('Custom Professional Renovations', 'SUNDARA Medical')) <> 2 then
        raise exception 'Expected one row of each name to remain; nothing was deleted.';
    end if;
end $$;

commit;

-- Check: no name stored twice
--   select name, count(*) from clients group by 1 having count(*) > 1;
