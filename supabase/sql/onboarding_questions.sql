-- Built-in onboarding questions (2026-09-15): a "Questions" step type answered inside Golden Eye,
-- instead of an embedded GHL form. For forms nothing in GHL uses, like the SEO intake.
-- Run after service_onboarding.sql and seo_onboarding_steps.sql, then re-run
-- supabase/sql/rename_client.sql (it now moves onboarding_answers).
--
-- The questions are data on the step, edited in Templates → Client Onboarding:
--   onboarding_steps.questions = [{id, label, type, options, required, website_statuses}]
--     id                a stable key ("q_ab12cd"), so rewording a question keeps its answers
--     type              short | long | choice (pick one) | multi (pick any)
--     options           for choice and multi
--     website_statuses  empty = always asked; otherwise only for clients with that website situation
--
-- Answers: one row per client per step in onboarding_answers.
--   answers = {"<question id>": {"label": "<question as it was worded>", "value": "text" or ["a","b"]}}
-- The label is stored with the answer, so an answer still reads correctly after its question is
-- reworded or deleted.
-- Submitting also completes the step through client_onboarding_progress, the same row every other
-- step uses, so the handoff trigger and the auto-checks treat it like any other step.

alter table onboarding_steps add column if not exists questions jsonb;

-- If step_type is limited by a check constraint, allow 'questions' too. The table predates this
-- repo, so any such constraint is found by what it checks rather than by name. NOT VALID: existing
-- rows aren't re-checked, so an old step with some other type can't make this fail.
do $$
declare c record;
begin
    for c in
        select conname from pg_constraint
        where conrelid = 'onboarding_steps'::regclass and contype = 'c'
          and pg_get_constraintdef(oid) ilike '%step_type%'
    loop
        execute format('alter table onboarding_steps drop constraint %I', c.conname);
        execute format('alter table onboarding_steps add constraint %I check (step_type in (''video'', ''form'', ''action'', ''team'', ''questions'')) not valid', c.conname);
    end loop;
end $$;

create table if not exists onboarding_answers (
    client_name  text not null,
    step_id      uuid not null references onboarding_steps (id) on delete cascade,
    answers      jsonb not null default '{}'::jsonb,
    submitted_by text,
    submitted_at timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    primary key (client_name, step_id)
);

alter table onboarding_answers enable row level security;
-- A client reads and writes only their own client's answers (client_row_visible includes the
-- client_email fallback and admins). No delete for clients: answers are edited, never removed.
drop policy if exists "Clients and admins read answers" on onboarding_answers;
create policy "Clients and admins read answers" on onboarding_answers
    for select using (client_row_visible(client_name));
drop policy if exists "Clients and admins save answers" on onboarding_answers;
create policy "Clients and admins save answers" on onboarding_answers
    for insert with check (client_row_visible(client_name));
drop policy if exists "Clients and admins edit answers" on onboarding_answers;
create policy "Clients and admins edit answers" on onboarding_answers
    for update using (client_row_visible(client_name)) with check (client_row_visible(client_name));
drop policy if exists "Admins delete answers" on onboarding_answers;
create policy "Admins delete answers" on onboarding_answers
    for delete using (current_user_is_admin());

-- The SEO intake becomes a Questions step. Only if it's still an unlinked form, so running this
-- after someone has set it up differently changes nothing. It stays hidden: switch it on with the
-- eye button in Templates → Client Onboarding once the questions look right.
update onboarding_steps
set step_type = 'questions',
    embed_url = null,
    description = 'A few quick questions so every page and article we write sounds like you and goes after the right searches.',
    questions = '[
      {"id": "q_services",    "label": "Which services do you want more calls for?", "type": "long", "required": true, "options": [], "website_statuses": []},
      {"id": "q_competitors", "label": "Any competitors you want to beat in Google?", "type": "short", "required": false, "options": [], "website_statuses": []},
      {"id": "q_voice",       "label": "How should your brand sound?", "type": "multi", "required": false, "options": ["Friendly", "Professional", "Straight-talking", "Premium", "Local and personal"], "website_statuses": []},
      {"id": "q_avoid",       "label": "Any words or claims we should never use?", "type": "long", "required": false, "options": [], "website_statuses": []},
      {"id": "q_next_step",   "label": "What should readers do after reading?", "type": "choice", "required": false, "options": ["Call us", "Book online", "Request a quote", "Fill out a form"], "website_statuses": []},
      {"id": "q_keep_pages",  "label": "Any pages or content on your site we should not change?", "type": "long", "required": false, "options": [], "website_statuses": ["existing"]},
      {"id": "q_liked_sites", "label": "Any websites you like the look of?", "type": "short", "required": false, "options": [], "website_statuses": ["new_build"]}
    ]'::jsonb
where title = 'Tell us about your business for SEO'
  and step_type = 'form'
  and coalesce(embed_url, '') = '';

notify pgrst, 'reload schema';

-- Checking on it:
--   select title, step_type, active, jsonb_array_length(questions) from onboarding_steps where questions is not null;
--   select client_name, submitted_at, answers from onboarding_answers order by submitted_at desc;
