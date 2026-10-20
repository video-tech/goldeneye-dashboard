-- The onboarding questionnaire (phase 1 of the onboarding rebuild, built 2026-10-15).
--
-- Replaces the three GHL forms ("Tell us about your business", "Your service area and hours", "Offers and
-- preferences") with Questions steps answered in the portal. Everything here is added SWITCHED OFF
-- (active = false): no client sees any of it until the steps are switched on in Templates > Client
-- Onboarding and the old form steps switched off, which is a separate decision (a client is mid-onboarding).
--
-- What it adds:
--   1. Private answers. A question marked "private" (or "secret") never goes into onboarding_answers, which the
--      client can read back. It goes through save_private_onboarding_answers() into
--      onboarding_private_answers, readable by admins only. The client can submit and change it, but never
--      read it back; the portal only learns WHICH questions have an answer (private_onboarding_answer_keys).
--   2. Secrets. A question marked "secret" (the website password) is stored encrypted in onboarding_secrets
--      (pgcrypto, key in Supabase Vault as onboarding_secret_key, created here). Admins see it masked and
--      click Reveal (reveal_onboarding_secret), and every reveal is logged in onboarding_secret_reveals.
--   3. The questionnaire steps: About your business, Registering your texting number, Calls texts and your
--      service area, Your jobs and offers (Ads), Access to your website (SEO, existing site only), and Your new website
--      (every client whose site we build, with the style picker).
--
-- Which questions are private is decided HERE, from the step's own questions, never from what the browser
-- sends: a client can't mark a question private or public, or write a private answer for a question that
-- isn't one.
--
-- Run once in the SQL Editor, then re-run supabase/sql/rename_client.sql (it now moves these tables).
-- Re-runnable.

begin;

-- ---------------------------------------------------------------------------
-- 1. Private answers and secrets
-- ---------------------------------------------------------------------------

create table if not exists public.onboarding_private_answers (
    client_name  text not null,
    step_id      uuid not null references public.onboarding_steps(id) on delete cascade,
    answers      jsonb not null default '{}'::jsonb,   -- {question id: {label, value}}, like onboarding_answers
    updated_by   text,
    updated_at   timestamptz not null default now(),
    primary key (client_name, step_id)
);

create table if not exists public.onboarding_secrets (
    client_name  text not null,
    step_id      uuid not null references public.onboarding_steps(id) on delete cascade,
    question_id  text not null,
    label        text,
    value_enc    bytea not null,                       -- pgp_sym_encrypt(value, vault onboarding_secret_key)
    updated_by   text,
    updated_at   timestamptz not null default now(),
    primary key (client_name, step_id, question_id)
);

create table if not exists public.onboarding_secret_reveals (
    id           bigserial primary key,
    client_name  text not null,
    step_id      uuid,
    question_id  text,
    revealed_by  text,
    revealed_at  timestamptz not null default now()
);

alter table public.onboarding_private_answers enable row level security;
alter table public.onboarding_secrets enable row level security;
alter table public.onboarding_secret_reveals enable row level security;
revoke all on public.onboarding_private_answers, public.onboarding_secrets, public.onboarding_secret_reveals from public, anon;
grant select, delete on public.onboarding_private_answers, public.onboarding_secrets to authenticated;
grant select on public.onboarding_secret_reveals to authenticated;

-- Admins read and delete (delete = "remove once we have our own access"). Nobody writes directly: the
-- functions below do, after checking the caller.
drop policy if exists "Admins read private onboarding answers" on public.onboarding_private_answers;
create policy "Admins read private onboarding answers" on public.onboarding_private_answers for select using (current_user_is_admin());
drop policy if exists "Admins delete private onboarding answers" on public.onboarding_private_answers;
create policy "Admins delete private onboarding answers" on public.onboarding_private_answers for delete using (current_user_is_admin());
drop policy if exists "Admins read onboarding secrets" on public.onboarding_secrets;
create policy "Admins read onboarding secrets" on public.onboarding_secrets for select using (current_user_is_admin());
drop policy if exists "Admins delete onboarding secrets" on public.onboarding_secrets;
create policy "Admins delete onboarding secrets" on public.onboarding_secrets for delete using (current_user_is_admin());
drop policy if exists "Admins read secret reveals" on public.onboarding_secret_reveals;
create policy "Admins read secret reveals" on public.onboarding_secret_reveals for select using (current_user_is_admin());

-- The encryption key, made once and kept in Vault (never in this file or the repo).
do $$
begin
    if not exists (select 1 from vault.secrets where name = 'onboarding_secret_key') then
        perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'base64'), 'onboarding_secret_key',
            'Encrypts website logins collected in onboarding (supabase/sql/onboarding_questionnaire.sql)');
    end if;
end $$;

-- Only the functions below use the key; nobody may call this directly.
create or replace function public.onboarding_secret_key()
returns text language sql stable security definer set search_path = public as $$
    select decrypted_secret from vault.decrypted_secrets where name = 'onboarding_secret_key' limit 1
$$;
revoke all on function public.onboarding_secret_key() from public, anon, authenticated;

-- Is this question one whose answer must stay private? Read from the step itself.
create or replace function public.onboarding_question_privacy(p_step_id uuid, p_question_id text)
returns text language sql stable security definer set search_path = public as $$
    select case
        when coalesce((q->>'secret')::boolean, false) then 'secret'
        when coalesce((q->>'private')::boolean, false) then 'private'
        else 'public' end
    from public.onboarding_steps s, jsonb_array_elements(coalesce(s.questions, '[]'::jsonb)) q
    where s.id = p_step_id and q->>'id' = p_question_id
    limit 1
$$;
revoke all on function public.onboarding_question_privacy(uuid, text) from public, anon, authenticated;

-- Save a client's private (and secret) answers for one step. p_answers is {question id: {value}} (a bare
-- value is accepted too). Answers to questions that aren't private or secret on this step are ignored, and a
-- blank answer never overwrites a saved one. Returns the question ids it saved.
create or replace function public.save_private_onboarding_answers(p_client text, p_step_id uuid, p_answers jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
    v_step   record;
    v_q      jsonb;
    v_key    text;
    v_val    jsonb;
    v_text   text;
    v_kind   text;
    v_saved  text[] := '{}';
    v_merge  jsonb := '{}'::jsonb;
    v_who    text := coalesce(auth.email(), current_user);
begin
    if p_client is null or not client_row_visible(p_client) then
        raise exception 'Not allowed to save answers for that client.' using errcode = '42501';
    end if;
    select id, questions into v_step from public.onboarding_steps where id = p_step_id;
    if v_step.id is null then
        raise exception 'That onboarding step does not exist.';
    end if;
    if jsonb_typeof(coalesce(p_answers, '{}'::jsonb)) <> 'object' then
        raise exception 'Answers must be an object of question id to answer.';
    end if;

    for v_key, v_val in select key, value from jsonb_each(coalesce(p_answers, '{}'::jsonb)) loop
        select q into v_q from jsonb_array_elements(coalesce(v_step.questions, '[]'::jsonb)) q where q->>'id' = v_key limit 1;
        if v_q is null then continue; end if;
        v_kind := case when coalesce((v_q->>'secret')::boolean, false) then 'secret'
                       when coalesce((v_q->>'private')::boolean, false) then 'private' end;
        if v_kind is null then continue; end if;

        if jsonb_typeof(v_val) = 'object' then v_val := v_val->'value'; end if;
        if v_val is null or jsonb_typeof(v_val) = 'null' then continue; end if;

        if jsonb_typeof(v_val) = 'array' then
            -- Pick-any answers: private only (a secret is always one value)
            if v_kind = 'secret' or jsonb_array_length(v_val) = 0 then continue; end if;
            if length(v_val::text) > 2000 then raise exception 'An answer is too long.'; end if;
            v_merge := v_merge || jsonb_build_object(v_key, jsonb_build_object('label', v_q->>'label', 'value', v_val));
            v_saved := v_saved || v_key;
            continue;
        end if;

        v_text := btrim(v_val #>> '{}');
        if v_text = '' then continue; end if;
        if length(v_text) > 2000 then raise exception 'An answer is too long.'; end if;

        if v_kind = 'secret' then
            insert into public.onboarding_secrets (client_name, step_id, question_id, label, value_enc, updated_by, updated_at)
            values (p_client, p_step_id, v_key, v_q->>'label', pgp_sym_encrypt(v_text, public.onboarding_secret_key()), v_who, now())
            on conflict (client_name, step_id, question_id) do update
                set label = excluded.label, value_enc = excluded.value_enc, updated_by = excluded.updated_by, updated_at = now();
        else
            v_merge := v_merge || jsonb_build_object(v_key, jsonb_build_object('label', v_q->>'label', 'value', v_text));
        end if;
        v_saved := v_saved || v_key;
    end loop;

    if v_merge <> '{}'::jsonb then
        insert into public.onboarding_private_answers (client_name, step_id, answers, updated_by, updated_at)
        values (p_client, p_step_id, v_merge, v_who, now())
        on conflict (client_name, step_id) do update
            set answers = public.onboarding_private_answers.answers || excluded.answers, updated_by = excluded.updated_by, updated_at = now();
    end if;

    return to_jsonb(v_saved);
end $$;
revoke all on function public.save_private_onboarding_answers(text, uuid, jsonb) from public, anon;
grant execute on function public.save_private_onboarding_answers(text, uuid, jsonb) to authenticated;

-- Which private and secret questions a client has answered (ids only, never a value), so the portal can say
-- "saved" and count a required question as answered.
create or replace function public.private_onboarding_answer_keys(p_client text)
returns table (step_id uuid, question_id text)
language plpgsql stable security definer set search_path = public as $$
begin
    if p_client is null or not client_row_visible(p_client) then
        raise exception 'Not allowed to read that client''s answers.' using errcode = '42501';
    end if;
    return query
        select pa.step_id, k.key::text
          from public.onboarding_private_answers pa, jsonb_object_keys(pa.answers) k(key)
         where pa.client_name = p_client
        union
        select s.step_id, s.question_id from public.onboarding_secrets s where s.client_name = p_client;
end $$;
revoke all on function public.private_onboarding_answer_keys(text) from public, anon;
grant execute on function public.private_onboarding_answer_keys(text) to authenticated;

-- Show one secret to an admin, and log that they looked.
create or replace function public.reveal_onboarding_secret(p_client text, p_step_id uuid, p_question_id text)
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
    v_enc bytea;
begin
    if not current_user_is_admin() then
        raise exception 'Only an admin can reveal this.' using errcode = '42501';
    end if;
    select value_enc into v_enc from public.onboarding_secrets
     where client_name = p_client and step_id = p_step_id and question_id = p_question_id;
    if v_enc is null then return null; end if;
    insert into public.onboarding_secret_reveals (client_name, step_id, question_id, revealed_by)
    values (p_client, p_step_id, p_question_id, coalesce(auth.email(), current_user));
    return pgp_sym_decrypt(v_enc, public.onboarding_secret_key());
end $$;
revoke all on function public.reveal_onboarding_secret(text, uuid, text) from public, anon;
grant execute on function public.reveal_onboarding_secret(text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The questionnaire steps (all switched off)
-- ---------------------------------------------------------------------------
-- "dest" records where each answer goes: ghl:<location field> (set when the account is created),
-- custom_value:<key> (Master's own keys), a2p:<field> (the texting registration, entered in GHL's Business
-- Profile), admin:<field> (our records only), and ad_brief / task notes. Phase 3 reads it.
-- Choices must not contain commas (the Templates editor splits choices on commas).

insert into public.onboarding_steps (title, description, step_type, owner, active, sort_order, questions)
select 'About your business',
       'The basics we use to set up your account. You only type these once.',
       'questions', 'client', false, 4,
       '[
         {"id": "a_name", "label": "Business name, as your customers know it", "type": "short", "required": true, "options": [], "website_statuses": [], "dest": "ghl:name; custom_value:business_name"},
         {"id": "a_phone", "label": "Business phone", "type": "phone", "required": true, "options": [], "website_statuses": [], "dest": "ghl:phone; custom_value:business_phone"},
         {"id": "a_email", "label": "Business email", "type": "email", "required": true, "options": [], "website_statuses": [], "dest": "ghl:email; custom_value:business_email"},
         {"id": "a_street", "label": "Street address", "type": "short", "required": true, "options": [], "website_statuses": [], "dest": "ghl:address; custom_value:physical_address"},
         {"id": "a_city", "label": "City", "type": "short", "required": true, "options": [], "website_statuses": [], "dest": "ghl:city"},
         {"id": "a_state", "label": "State", "type": "short", "required": true, "options": [], "website_statuses": [], "dest": "ghl:state"},
         {"id": "a_zip", "label": "Zip code", "type": "short", "required": true, "options": [], "website_statuses": [], "dest": "ghl:postalCode"},
         {"id": "a_website", "label": "Your website (leave blank if you do not have one yet)", "type": "link", "required": false, "options": [], "website_statuses": [], "dest": "ghl:website; custom_value:business_website"},
         {"id": "a_services", "label": "Which services do you want more calls for?", "type": "long", "required": true, "options": [], "website_statuses": [], "dest": "custom_value:services_list"},
         {"id": "a_owner", "label": "Your name", "type": "short", "required": true, "options": [], "website_statuses": [], "dest": "custom_value:owner_name; a2p:representative_name"},
         {"id": "a_title", "label": "Your title (for example Owner)", "type": "short", "required": true, "options": [], "website_statuses": [], "dest": "a2p:representative_title"},
         {"id": "a_mobile", "label": "Your mobile number (we only use it if something is urgent)", "type": "phone", "required": true, "private": true, "options": [], "website_statuses": [], "dest": "admin:owner_mobile; a2p:representative_phone"},
         {"id": "a_instagram", "label": "Your Instagram (optional)", "type": "short", "required": false, "options": [], "website_statuses": [], "dest": "custom_value:instagram_handle"},
         {"id": "a_awards", "label": "Awards or certifications (optional)", "type": "long", "required": false, "options": [], "website_statuses": [], "dest": "custom_value:awards"},
         {"id": "a_assets", "label": "A Google Drive or Dropbox link to your logo and photos (optional)", "type": "link", "required": false, "options": [], "website_statuses": [], "dest": "custom_value:asset_link"}
       ]'::jsonb
where not exists (select 1 from public.onboarding_steps where title = 'About your business');

insert into public.onboarding_steps (title, description, step_type, owner, active, sort_order, questions)
select 'Registering your texting number',
       'Phone carriers require every business that texts its customers to register. We do the registration for you, and need these details exactly as they appear on your tax paperwork. Only our team can see them.',
       'questions', 'client', false, 5,
       '[
         {"id": "b_legal", "label": "Legal business name, exactly as on your EIN paperwork", "type": "short", "required": true, "private": true, "options": [], "website_statuses": [], "dest": "a2p:legal_name"},
         {"id": "b_type", "label": "Business type", "type": "choice", "required": true, "private": true, "options": ["LLC", "Corporation", "Sole proprietor", "Partnership", "Non-profit"], "website_statuses": [], "dest": "a2p:business_type"},
         {"id": "b_ein", "label": "EIN (9 digits; sole proprietors without one can leave this blank)", "type": "ein", "required": false, "private": true, "options": [], "website_statuses": [], "dest": "a2p:ein"}
       ]'::jsonb
where not exists (select 1 from public.onboarding_steps where title = 'Registering your texting number');

insert into public.onboarding_steps (title, description, step_type, owner, active, sort_order, questions)
select 'Texting and your service area',
       'How you want leads handled, and where you work.',
       'questions', 'client', false, 5,
       '[
         {"id": "c_text_ok", "label": "We text new leads between 8am and 8pm, weekends included. Is that OK?", "type": "choice", "required": true, "options": ["Yes", "No (I would like different hours)"], "website_statuses": [], "dest": "custom_value:text_window"},
         {"id": "c_text_hours", "label": "What hours should we text your leads?", "type": "short", "required": true, "options": [], "website_statuses": [], "show_if": {"q": "c_text_ok", "any": ["No (I would like different hours)"]}, "dest": "custom_value:text_window"},
         {"id": "c_area", "label": "Main cities you serve", "type": "short", "required": true, "options": [], "website_statuses": [], "dest": "custom_value:service_area"},
         {"id": "c_radius", "label": "How far will you travel for a job?", "type": "short", "required": true, "options": [], "website_statuses": [], "dest": "custom_value:service_radius"},
         {"id": "c_exclude", "label": "Areas you will not serve (optional)", "type": "long", "required": false, "options": [], "website_statuses": [], "dest": "custom_value:excluded_areas"}
       ]'::jsonb
where not exists (select 1 from public.onboarding_steps where title = 'Texting and your service area');

insert into public.onboarding_steps (title, description, step_type, owner, active, sort_order, service_keys, questions)
select 'Your jobs and offers',
       'What you want more of, so your ads and follow-up say the right things.',
       'questions', 'client', false, 6, '{ads}',
       '[
         {"id": "d_job_value", "label": "Your average job value for each of your main services", "type": "long", "required": true, "private": true, "options": [], "website_statuses": [], "dest": "admin:job_values"},
         {"id": "d_close", "label": "Roughly what share of your estimates do you close?", "type": "short", "required": true, "private": true, "options": [], "website_statuses": [], "dest": "admin:close_rate"},
         {"id": "d_fin", "label": "Do you offer financing?", "type": "choice", "required": true, "options": ["Yes", "No"], "website_statuses": [], "dest": "custom_value:financing_offer"},
         {"id": "d_fin_details", "label": "Who is the financing through, and what are the terms?", "type": "short", "required": false, "options": [], "website_statuses": [], "show_if": {"q": "d_fin", "any": ["Yes"]}, "dest": "custom_value:financing_offer"},
         {"id": "d_design", "label": "Do you offer 3D design or renderings?", "type": "choice", "required": true, "options": ["Yes", "No"], "website_statuses": [], "dest": "custom_value:design_offer"},
         {"id": "d_design_bill", "label": "How do you bill for design?", "type": "choice", "required": true, "options": ["Included free with estimates", "A set fee", "Credited back if they hire you", "Other"], "website_statuses": [], "show_if": {"q": "d_design", "any": ["Yes"]}, "dest": "custom_value:design_offer"},
         {"id": "d_promo", "label": "Any current promotion or offer for new leads? (optional)", "type": "long", "required": false, "options": [], "website_statuses": [], "dest": "custom_value:current_offer"},
         {"id": "d_ad_cities", "label": "Which cities should we name in your ads? (for example Lehi and American Fork)", "type": "short", "required": true, "options": [], "website_statuses": [], "dest": "ad_brief:cities"},
         {"id": "d_calc", "label": "Would you like an instant price calculator on your website?", "type": "choice", "required": false, "options": ["Yes", "Maybe later", "No"], "website_statuses": [], "dest": "task:instant_calculator"},
         {"id": "d_render", "label": "Would you like instant AI renderings for your leads?", "type": "choice", "required": false, "options": ["Yes", "Maybe later", "No"], "website_statuses": [], "dest": "task:instant_rendering"}
       ]'::jsonb
where not exists (select 1 from public.onboarding_steps where title = 'Your jobs and offers');

insert into public.onboarding_steps (title, description, step_type, owner, active, sort_order, service_keys, website_statuses, questions)
select 'Access to your website',
       'Send us your login, or add us as a collaborator on your website. A login is only seen by our team, is stored encrypted, and is deleted once we have our own access. For a collaborator invite, we will tell you which email to invite.',
       'questions', 'client', false, 18, '{seo}', '{existing}',
       '[
         {"id": "e_host", "label": "Who hosts your website?", "type": "choice", "required": true, "options": ["Wix", "Squarespace", "WordPress", "GoDaddy", "Webflow", "Other"], "website_statuses": [], "dest": "access:host"},
         {"id": "e_host_other", "label": "Which one?", "type": "short", "required": true, "options": [], "website_statuses": [], "show_if": {"q": "e_host", "any": ["Other"]}, "dest": "access:host"},
         {"id": "e_access", "label": "How would you like to give us access?", "type": "choice", "required": true, "options": ["I will add you as a collaborator", "I will send my login (easier)"], "website_statuses": [], "dest": "access:method"},
         {"id": "e_login_url", "label": "Your website login page", "type": "link", "required": true, "private": true, "options": [], "website_statuses": [], "show_if": {"q": "e_access", "any": ["I will send my login (easier)"]}, "dest": "access:login_url"},
         {"id": "e_username", "label": "The username or email you log in with", "type": "short", "required": true, "private": true, "options": [], "website_statuses": [], "show_if": {"q": "e_access", "any": ["I will send my login (easier)"]}, "dest": "access:username"},
         {"id": "e_password", "label": "Password", "type": "short", "required": true, "secret": true, "options": [], "website_statuses": [], "show_if": {"q": "e_access", "any": ["I will send my login (easier)"]}, "dest": "access:password"},
         {"id": "e_2fa", "label": "Does it ask for a code from your phone or email when you log in?", "type": "choice", "required": true, "options": ["No", "Yes"], "website_statuses": [], "show_if": {"q": "e_access", "any": ["I will send my login (easier)"]}, "dest": "access:two_step"},
         {"id": "e_2fa_who", "label": "Who receives the code?", "type": "short", "required": true, "private": true, "options": [], "website_statuses": [], "show_if": {"q": "e_2fa", "any": ["Yes"]}, "dest": "access:two_step_contact"}
       ]'::jsonb
where not exists (select 1 from public.onboarding_steps where title = 'Access to your website');

-- The new-website questions: every client whose site we build (website situation "We're building it"; the site comes
-- with Base). The style picker's looks are data on the question (styles: name, note, colors, image, link), edited in
-- Templates. The example sites and pictures don't exist yet, so image and link start empty: paste them in Templates.
insert into public.onboarding_steps (title, description, step_type, owner, active, sort_order, website_statuses, questions)
select 'Your new website',
       'Help us design a site that feels like you. Open the example sites, pick your favorites, and tell us what you like.',
       'questions', 'client', false, 7, '{new_build}',
       '[
         {"id": "w_style", "label": "Pick the look closest to what you want, then a second choice", "type": "style", "required": true, "options": [], "website_statuses": [], "dest": "design:style",
          "styles": [
            {"name": "Bold and local", "note": "Heavy lettering, warm earthy colors and square edges. Hands-on and local, not corporate.", "colors": ["#A63D22", "#F1EBDF", "#1B1915", "#6A5B4B"], "image": "", "link": "https://claude.ai/artifact/3QmahedVMqA4pd7tBxmEPB"},
            {"name": "Sharp and modern", "note": "Near-black with one strong accent color, big project photos and a clean grid.", "colors": ["#1E1F25", "#C0432F", "#FFFFFF", "#8A8D96"], "image": "", "link": "https://claude.ai/artifact/4XofsfBmYf1pWWss64KzGJ"},
            {"name": "Warm and friendly", "note": "Soft warm tones and friendly lettering, with your team and reviews up front.", "colors": ["#9B3222", "#F1ECE6", "#57504C", "#C98B5A"], "image": "", "link": "https://claude.ai/artifact/LQkogU3C1CnLtQa3jpmUsJ"},
            {"name": "Refined and premium", "note": "An elegant serif headline, magazine-style project pages and plenty of space.", "colors": ["#8E3F2E", "#F6EEE8", "#3A2824", "#B8A89E"], "image": "", "link": "https://claude.ai/artifact/EFjnTxRLcVggXMG13LZTrm"}
          ]},
         {"id": "w_style_why", "label": "What do you like or dislike about the looks you picked? (optional)", "type": "long", "required": false, "options": [], "website_statuses": [], "dest": "design:notes"},
         {"id": "w_sites_like", "label": "Websites you like the look of, and what you like about each (optional)", "type": "long", "required": false, "options": [], "website_statuses": [], "dest": "design:sites_liked"},
         {"id": "w_sites_dislike", "label": "Websites you do not like, and why (optional)", "type": "long", "required": false, "options": [], "website_statuses": [], "dest": "design:sites_disliked"},
         {"id": "w_colors_have", "label": "Do you have brand colors?", "type": "choice", "required": true, "options": ["Yes", "No", "Not sure"], "website_statuses": [], "dest": "design:brand_colors"},
         {"id": "w_colors", "label": "What are they? (color names or codes)", "type": "short", "required": true, "options": [], "website_statuses": [], "show_if": {"q": "w_colors_have", "any": ["Yes"]}, "dest": "design:brand_colors"},
         {"id": "w_colors_pref", "label": "Colors you love or want to avoid (optional)", "type": "short", "required": false, "options": [], "website_statuses": [], "dest": "design:color_preferences"},
         {"id": "w_logo", "label": "Do you have a logo?", "type": "choice", "required": true, "options": ["Yes (it is in the link I gave you)", "Yes (I will send it)", "No (I need one)"], "website_statuses": [], "dest": "design:logo; task:logo_design if no"},
         {"id": "w_fonts", "label": "What style of lettering do you like?", "type": "choice", "required": false, "options": ["Modern and clean", "Classic", "Bold", "Friendly", "I have specific fonts", "No preference"], "website_statuses": [], "dest": "design:fonts"},
         {"id": "w_fonts_which", "label": "Which fonts? (names, or a link to them)", "type": "short", "required": true, "options": [], "website_statuses": [], "show_if": {"q": "w_fonts", "any": ["I have specific fonts"]}, "dest": "design:fonts"},
         {"id": "w_feel", "label": "How should visitors feel?", "type": "multi", "required": false, "options": ["Trustworthy", "Premium", "Friendly", "Bold", "Local and down to earth"], "website_statuses": [], "dest": "design:feel"},
         {"id": "w_pages", "label": "Which pages do you need?", "type": "multi", "required": true, "options": ["Home", "Services", "Our work", "About", "Reviews", "Financing", "Service areas", "Blog", "Contact"], "website_statuses": [], "dest": "design:pages"},
         {"id": "w_features", "label": "Which features do you want?", "type": "multi", "required": false, "options": ["Online booking", "Instant price calculator", "Review wall", "Before and after photos", "Financing application", "Live chat"], "website_statuses": [], "dest": "design:features"},
         {"id": "w_domain", "label": "Do you own a domain (a web address)?", "type": "choice", "required": true, "options": ["Yes", "No", "Not sure"], "website_statuses": [], "dest": "design:domain"},
         {"id": "w_domain_which", "label": "What is it, and where did you buy it? (for example GoDaddy)", "type": "short", "required": true, "options": [], "website_statuses": [], "show_if": {"q": "w_domain", "any": ["Yes"]}, "dest": "design:domain"},
         {"id": "w_domain_ideas", "label": "Any names you would like? (optional)", "type": "short", "required": false, "options": [], "website_statuses": [], "show_if": {"q": "w_domain", "any": ["No"]}, "dest": "design:domain_ideas"},
         {"id": "w_content", "label": "Do you have photos of your work and written content ready?", "type": "choice", "required": true, "options": ["Both", "Photos only", "Text only", "Neither yet"], "website_statuses": [], "dest": "design:content_ready"},
         {"id": "w_must", "label": "Anything we must include or avoid? (optional)", "type": "long", "required": false, "options": [], "website_statuses": [], "dest": "design:must"}
       ]'::jsonb
where not exists (select 1 from public.onboarding_steps where title = 'Your new website');

commit;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- GO LIVE (not run by this file; a decision for when the rebuild is done):
--   supabase/sql/onboarding_questionnaire_go_live.sql switches the six steps on and the three GHL form steps off,
--   and takes the two questions now asked here out of the SEO questions step.
--
-- Checking on it (admins):
--   select title, active, sort_order, jsonb_array_length(questions) from onboarding_steps where step_type = 'questions' order by sort_order;
--   select client_name, step_id, jsonb_object_keys(answers) from onboarding_private_answers;
--   select client_name, question_id, updated_at from onboarding_secrets;          -- values stay encrypted
--   select * from onboarding_secret_reveals order by revealed_at desc limit 20;
-- ---------------------------------------------------------------------------
