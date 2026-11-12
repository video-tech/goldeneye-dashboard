-- The Conversions API action reads two custom values (2026-11-12). In Master, "Lead to Golden Eye and Meta"'s Conversions API
-- action uses {{custom_values.meta_dataset_id}} and {{custom_values.meta_capi_token}}, so the workflow is never edited per
-- client: each account's two custom values are filled instead (Settings > Custom Values, account-wide, not contact fields).
-- Rewrites the steps that said to paste the pixel and token into the workflow, in the templates and in existing step tasks.
-- Plain ASCII: "~" stands for the long dash, chr(8212). Safe to re-run.

begin;

create temporary table cv_rewrite (old_title text, new_title text, notes text) on commit drop;
insert into cv_rewrite values
  ('Funnel ~ Paste their pixel and token into Lead to Golden Eye and Meta',
   'Funnel ~ Fill the Meta Dataset ID and Meta CAPI Token custom values',
   'In their GHL: Settings > Custom Values (not custom fields). Meta Dataset ID = their dataset (pixel) ID from Events Manager. '
   || 'Meta CAPI Token = the Conversions API token generated in their Events Manager for that dataset. The Conversions API action in '
   || 'Lead to Golden Eye and Meta already reads both ({{custom_values.meta_dataset_id}} and {{custom_values.meta_capi_token}}), so the '
   || 'workflow is not edited. If they have more than one dataset, use the one their ads optimize on. Never paste one client''s token '
   || 'into another account.'),
  ('Switch ~ Copy the pixel ID, token and field mapping from the old Conversions API workflow',
   'Switch ~ Fill the Meta Dataset ID and Meta CAPI Token custom values',
   'Copy the dataset (pixel) ID and access token from their old Conversions API workflow (or Events Manager) into Settings > Custom '
   || 'Values: Meta Dataset ID and Meta CAPI Token. Create the two values if the account does not have them yet (keys meta_dataset_id '
   || 'and meta_capi_token). Also note what the old action mapped (email, phone, name, event source URL) to check against the new one.'),
  ('Switch ~ Build Lead to Golden Eye and Meta, in draft',
   'Switch ~ Build Lead to Golden Eye and Meta, in draft',
   'Trigger Contact Tag Added = ge lead, re-entry OFF. Golden Eye webhook (copy the URL and header from their old leads to Golden Eye '
   || 'workflow), then If/Else: contact has "quiz ads ge" -> Conversions API Lead, with Pixel ID {{custom_values.meta_dataset_id}} and '
   || 'Access Token {{custom_values.meta_capi_token}}. Create the tags ge lead, quiz ads ge, meta form ge and website lead if they '
   || 'don''t exist. Copied from Master, it is already set up this way.');

update cv_rewrite set old_title = replace(old_title, '~', chr(8212)), new_title = replace(new_title, '~', chr(8212));

update public.stage_templates t set task_title = r.new_title, default_notes = r.notes
  from cv_rewrite r where t.task_title = r.old_title;
update public.tasks t set title = r.new_title, notes = r.notes, updated_at = now()
  from cv_rewrite r where t.title = r.old_title and t.type = 'Setup step' and t.archived_at is null;

commit;
