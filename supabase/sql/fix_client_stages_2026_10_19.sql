-- Correct client stages (2026-10-19), as confirmed by the team.
--
-- Sets current_stage only. Nothing fires:
--   * clients has one trigger, trg_new_client_welcome, and it runs on INSERT only.
--   * Stage checklist tasks are raised by app.js only on Move Stage or the automatic move out of Onboarding,
--     neither of which this touches.
--   * No onboarding progress is written, so trg_onboarding_handoff (the onboarding-complete text) can't run.
--   * ghl-account only acts on clients in Onboarding, so moving Midas Media out of it can only stop it acting.
--
-- Alta Vista stays in Campaign Building; 3Sixty, Caliber, PANDEN, Sunset and Ironshell are already right.
-- Safe to re-run.

update public.clients set current_stage = 'Optimizing'
where name in ('Anxiety Solutions', 'Astra Real Estate', 'KLH Exteriors', 'Midas Media')
  and coalesce(current_stage, '') <> 'Optimizing';

-- Check (expect Optimizing for those four, Campaign Building for Alta Vista):
--   select name, status, current_stage from clients where status <> 'archived' order by current_stage, name;
