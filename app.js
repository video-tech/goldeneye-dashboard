        // ================= GLOBAL STATE =================
        const wrapper = document.getElementById('midas-master');
        const supabaseClient = window.supabase.createClient(wrapper.dataset.supaUrl, wrapper.dataset.supaKey);
        
        let currentUserRole = 'pending'; 
        let currentUserName = 'User';
        let clientEmail = '';
        let globalAllowedClients = [];
	let globalAuditsData = []; // Add this near line 656 with your other global variables
        
        // Core Data
        let globalClientsData = [];
        // Name/email pairs the client portal loads for itself, since it never calls
        // fetchAllGlobalData. Deliberately not the full clients row — the portal has no
        // business holding retainer or contract columns.
        let portalClientRows = [];
        // Reports the client can read. Never the admin table's dataset — nothing here
        // offers editing, drafting, deleting or generating.
        let portalReports = [];
        let globalHealthData = {};
        let globalTasksData = [];
        let globalAdsData = [];
        let globalCreativesData = [];
        let globalSeoData = [];
        let globalCheckinsData = [];
        let globalContactsData = [];
        let globalOnboardingSteps = [];
        let globalOnboardingProgress = [];
        let globalServices = [];          // add-ons on top of Base, from services
        let globalClientServices = [];    // which add-ons each client has, from client_services
        let globalOnboardingAnswers = []; // answers to built-in Questions steps, from onboarding_answers
        // Delays the manual "mark it done" fallback on form steps until the webhook has had a chance
        let obManualRevealTimer = null;
        let allRawSeo = [];
        
        // Dashboard States
        let globalLeadsData = [
            { id: '101', name: 'Acme Roofing', stage: 'Discovery', mrr: 2500, prob: 20, source: 'Facebook Ads', added: new Date().toISOString() },
            { id: '102', name: 'Apex Dental', stage: 'Proposal', mrr: 3000, prob: 60, source: 'Referral', added: new Date(Date.now() - 86400000).toISOString() }
        ];
        let activeLeadId = null;
        let salesSortableInstances = [];
        let currentTaskSort = 'score'; let taskSortDir = 'desc'; let taskPrioMode = 'total';
        let selectedTaskIds = new Set(); let activeEditId = null; let currentTaskView = 'kanban'; let sortableInstances = [];
        const masterCols = [{id:'assignee',label:'Assignee'},{id:'type',label:'Type'},{id:'stage',label:'Stage'},{id:'urgency',label:'Urgency'},{id:'effort',label:'Effort'},{id:'template',label:'Template'},{id:'updated_at',label:'Updated'},{id:'notes',label:'Notes'}];
        let activeCols = ['assignee', 'type', 'stage', 'urgency'];
        let columnSortableInstance = null;
        let cSelectedAccount = "ALL"; let cDateRange = "last7"; let cCustomStart = null; let cCustomEnd = null; let currentAdsStats = {};
        let dashMrrChartInstance = null; let dashAvgHealthInstance = null; let trendChartInstance = null; let accountChartInstance = null; let healthGaugeInstance = null; let healthLineInstance = null;
        let adminSeoChart = null; let cpSeoChart = null;
        let dbHealthSettings = null; let dbMilestones = []; let dbClientMilestones = []; let dbClientHealth = null; let dbHealthLogs = [];
        
        // Portal States
        let allRawReports = [];
        let filteredReportData = [];
        let leadChart = null, roiChart = null;
        let selectedDateRange = "last7", customStart = null, customEnd = null;
        let currentActiveClient = "";
        let finalStats = { spend: 0, leads: 0, revenue: 0, estimates: 0 };

        // New Client Pipeline States
        let clientPipelineStages = ['New Lead', 'Contacted', 'Appt Set', 'Won', 'Lost'];
        let globalClientLeadsData = [];
        let clientLeadsData = [];
        let activeCpLeadId = null;

        const normalize = (str) => {
    if (!str) return "";
    let clean = str.toLowerCase().replace(/ad account/g, '').replace(/[^a-z0-9]/g, '');
    
    // Map midas contractor directly to the stripped version of Sunset Design & Build
    if (clean.includes("midascontractor")) return "sunsetdesignbuild";

    // Keen Enterprises Inc's Meta ad account was never renamed, so it only reports as its raw numeric ID
    if (clean.includes("371628055")) return "keenenterprisesinc";

    return clean;
};
        // Escapes for a JS string literal, for values interpolated inside an inline
        // handler such as onclick="fn('...')". Only correct in that position.
        const escapeHTML = (str) => str ? String(str).replace(/'/g, "\\'").replace(/"/g, "&quot;") : "";

        // Escapes for HTML — attribute values and text alike. Use this anywhere that
        // isn't inside a JS string: escapeHTML turns an apostrophe into \' , which is a
        // literal backslash once the browser parses it. In value="..." that backslash is
        // read straight back by .value and saved, so every save added another one.
        const escapeAttr = (str) => String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        // Repairs values already corrupted by the above, so opening an editor shows the
        // real text and saving writes it back clean.
        const stripSlashEscapes = (str) => String(str ?? '').replace(/\\+(?=['"])/g, '');

        const checkTaskClientBox = (name) => {
            const want = normalize(name || '');
            document.querySelectorAll('.t-client-cb').forEach(cb => {
                if (normalize(cb.value) === want) cb.checked = true;
            });
        };

        // ================= CLIENT <-> ADS JOIN =================
        // daily_reports rows are joined to clients by Meta ad account id. Meta controls
        // account_name and can rename it at will (Keen Enterprises arrives as
        // "371628055, USD"), so names are only a fallback for rows predating the backfill.

        // Meta account ids appear as "act_123", "123", or "371628055, USD" depending on
        // origin. Reduce to bare digits so all three forms compare equal.
        const normalizeAccountId = (val) => {
            if (val === null || val === undefined) return "";
            return String(val).replace(/\D/g, '');
        };

        // Phone numbers arrive in many shapes ("+1 (555) 010-9999", "555-010-9999",
        // "15550109999"). Compare on the last 10 digits so country code and formatting
        // never cause a miss.
        const normalizePhone = (val) => {
            const digits = String(val ?? '').replace(/\D/g, '');
            return digits.length > 10 ? digits.slice(-10) : digits;
        };

        // Legacy fuzzy name match: the equality-or-substring behaviour that every call
        // site used to hand-roll. Only reached for rows with no ad_account_id.
        const legacyNameMatch = (accountName, wantNorm) => {
            if (!wantNorm) return false;
            const a = normalize(accountName);
            if (!a) return false;
            return a === wantNorm || a.includes(wantNorm) || wantNorm.includes(a);
        };

        // Resolve a client object from either a client object or a client name string.
        const resolveClient = (client) => {
            if (!client) return null;
            if (typeof client !== 'string') return client;
            const want = normalize(client);
            return globalClientsData.find(c => normalize(c.name) === want) || null;
        };

        // The daily_reports rows belonging to a client. Accepts a client object or name.
        // TODO(migration step 6): drop the legacyNameMatch fallback once every
        // daily_reports row carries an ad_account_id.
        function reportsForClient(client, rows) {
            const source = rows || globalAdsData;
            if (!client || !Array.isArray(source)) return [];

            const clientObj = resolveClient(client);
            const wantId = normalizeAccountId(clientObj?.ad_account_id);
            const wantName = normalize(clientObj?.name || (typeof client === 'string' ? client : ''));
            if (!wantId && !wantName) return [];

            return source.filter(r => {
                const rowId = normalizeAccountId(r.ad_account_id);
                if (rowId && wantId) return rowId === wantId;
                return legacyNameMatch(r.account_name, wantName);
            });
        }

        // Reverse lookup: which client does this report row belong to? Null if unmatched.
        function clientForReport(row) {
            if (!row) return null;

            const rowId = normalizeAccountId(row.ad_account_id);
            if (rowId) {
                const byId = globalClientsData.find(c => normalizeAccountId(c.ad_account_id) === rowId);
                if (byId) return byId;
            }

            const a = normalize(row.account_name);
            if (!a) return null;
            return globalClientsData.find(c => {
                const n = normalize(c.name);
                return n && (n === a || n.includes(a) || a.includes(n));
            }) || null;
        }

        // Weekly SMS check-ins for a client, newest week first. Matches on client name
        // because that's what the intake webhook resolves and writes.
        function checkinsForClient(client) {
            const name = typeof client === 'string' ? client : client?.name;
            if (!name) return [];
            const want = normalize(name);
            return globalCheckinsData
                .filter(c => normalize(c.client_name) === want)
                .sort((a, b) => String(b.week_start || '').localeCompare(String(a.week_start || '')));
        }

        // Check-ins from the last N weeks. The health score reads a rolling window rather
        // than all-time totals: scoring on lifetime figures would only ever climb, so a
        // client who closed plenty last year but nothing recently would still look healthy.
        function recentCheckins(client, weeks = 4) {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - (weeks * 7));
            const cutoffStr = cutoff.toISOString().split('T')[0];
            // week_start is YYYY-MM-DD, so a string compare orders correctly
            return checkinsForClient(client).filter(c => String(c.week_start || '') >= cutoffStr);
        }

        const sumCheckins = (rows, field) => rows.reduce((sum, r) => sum + (parseFloat(r[field]) || 0), 0);

        // A client can have several people reporting — one row per person per week — so
        // anything displaying weeks has to roll them up. Totals elsewhere already sum
        // across rows and need no change; this is for the views that list weeks.
        // Returns newest week first, each with combined totals and its contributors.
        function checkinsByWeek(client) {
            const byWeek = new Map();

            checkinsForClient(client).forEach(c => {
                const wk = c.week_start || 'Unknown';
                if (!byWeek.has(wk)) {
                    byWeek.set(wk, {
                        week_start: wk,
                        estimates_count: 0,
                        closes_count: 0,
                        revenue_total: 0,
                        // null when nobody reported a number, versus a real reported 0
                        reportedEstimates: false,
                        reportedCloses: false,
                        reportedRevenue: false,
                        // Jobs and revenue from the "google" source row (see CHECKIN_SOURCES).
                        // reportedSources is false when nobody that week split by source.
                        google_closes: 0,
                        google_revenue: 0,
                        reportedSources: false,
                        needsReview: false,
                        contributors: []
                    });
                }
                const w = byWeek.get(wk);

                const g = c.closes_by_source && typeof c.closes_by_source === 'object' ? c.closes_by_source : null;
                if (g) {
                    w.reportedSources = true;
                    w.google_closes += parseFloat(g.google?.closes) || 0;
                    w.google_revenue += parseFloat(g.google?.revenue) || 0;
                }

                if (c.estimates_count !== null && c.estimates_count !== undefined) { w.estimates_count += parseFloat(c.estimates_count) || 0; w.reportedEstimates = true; }
                if (c.closes_count    !== null && c.closes_count    !== undefined) { w.closes_count    += parseFloat(c.closes_count)    || 0; w.reportedCloses    = true; }
                if (c.revenue_total   !== null && c.revenue_total   !== undefined) { w.revenue_total   += parseFloat(c.revenue_total)   || 0; w.reportedRevenue   = true; }

                if (c.parse_confidence === 'low') w.needsReview = true;
                w.contributors.push(c);
            });

            return [...byWeek.values()].sort((a, b) => String(b.week_start).localeCompare(String(a.week_start)));
        }

        // How many people are set up to report for a client, so a week that came in short
        // can be flagged rather than read as a genuinely quiet week.
        function activeContactCount(client) {
            const name = typeof client === 'string' ? client : client?.name;
            if (!name) return 0;
            const want = normalize(name);
            return globalContactsData.filter(c => normalize(c.client_name) === want && c.active !== false).length;
        }

        // ================= CLIENT STATUS =================
        // 'active' = pulled by Make.com each morning and counted in rollups.
        // 'paused' = not pulled, not counted, but still selectable with full history.
        // 'archived' = hidden from the dashboard entirely.
        const isActiveClient = (c) => (c?.status || 'active') === 'active';
        const isSelectableClient = (c) => (c?.status || 'active') !== 'archived';

        // When true the client picker also lists archived clients, so their history
        // stays reachable after offboarding.
        let showArchivedClients = false;

        // Which metric the client leaderboard ranks by. Leads come from the ads pull,
        // revenue from what clients report by text — two different sources, one board.
        let leaderboardMetric = 'leads';

        // ================= INIT & AUTH =================
        async function initApp() {
            try {
                const { data: { session } } = await supabaseClient.auth.getSession();
                
                if (session) {
                    clientEmail = session.user.email;
                    currentUserName = session.user.user_metadata?.full_name || "User";
                    
                    const { data: profile } = await supabaseClient.from('user_profiles').select('role').eq('email', clientEmail).single();
                    currentUserRole = profile?.role || 'pending';

                    // user_client_access has a foreign key to user_profiles, so access
                    // can't be written until the person has actually signed up. That's
                    // what pre_approved_users is for — an invite made before the account
                    // exists — but nothing was applying it once they arrived, so an
                    // invited client signed in and sat on the pending screen forever.
                    const { data: preApproved } = await supabaseClient
                        .from('pre_approved_users').select('role, client_access').eq('email', clientEmail).maybeSingle();

                    if (preApproved && (currentUserRole === 'pending' || !profile)) {
                        currentUserRole = preApproved.role || currentUserRole;
                        // Their profile exists now, so the role can finally be written down
                        await supabaseClient.from('user_profiles')
                            .update({ role: currentUserRole }).eq('email', clientEmail).eq('role', 'pending');
                    }
                    
                    let allowedClients = [];
                    if (currentUserRole === 'admin') {
                        const { data: cData } = await supabaseClient.from('clients').select('name');
                        allowedClients = cData ? cData.map(d => d.name) : [];
                    } else if (currentUserRole === 'member' || currentUserRole === 'investor') {
                        const { data: accessData } = await supabaseClient.from('user_client_access').select('client_name').eq('user_email', clientEmail);
                        allowedClients = accessData ? accessData.map(a => a.client_name) : [];
                    } else {
                        const { data: accessData } = await supabaseClient.from('user_client_access').select('client_name').eq('user_email', clientEmail);
                        if (accessData) allowedClients = accessData.map(d => d.client_name);

                        // Whatever the invite promised, now that the profile exists the
                        // foreign key is satisfiable — so honour it and write it down, and
                        // the next login reads it from the normal place.
                        const promised = Array.isArray(preApproved?.client_access) ? preApproved.client_access : [];
                        const missing = promised.filter(n => n && !allowedClients.includes(n));
                        if (missing.length) {
                            allowedClients = allowedClients.concat(missing);
                            const { error: backfillErr } = await supabaseClient.from('user_client_access')
                                .insert(missing.map(n => ({ user_email: clientEmail, client_name: n })));
                            if (backfillErr) console.warn('Could not persist invited access:', backfillErr.message);
                        }

                        // daily_reports has client_email only — there is no `email` column.
                        // Referencing one made PostgREST reject the whole query, silently
                        // disabling zero-touch portal onboarding.
                        const { data: matchedReports } = await supabaseClient.from('daily_reports').select('account_name, ad_account_id').ilike('client_email', `%${clientEmail}%`);
                        if (matchedReports && matchedReports.length > 0) {
                            // Resolve ad accounts to real client names, so the portal shows
                            // "Keen Enterprises Inc" rather than whatever Meta labelled the
                            // account (e.g. "371628055, USD").
                            const { data: clientRows } = await supabaseClient.from('clients').select('name, ad_account_id');
                            const nameByAccountId = new Map((clientRows || [])
                                .filter(c => c.ad_account_id)
                                .map(c => [normalizeAccountId(c.ad_account_id), c.name]));

                            const autoMatched = matchedReports.map(r => {
                                const id = normalizeAccountId(r.ad_account_id);
                                if (id && nameByAccountId.has(id)) return nameByAccountId.get(id);

                                // Fallback for rows predating the ad_account_id backfill
                                const norm = normalize(r.account_name);
                                const byName = (clientRows || []).find(c => {
                                    const n = normalize(c.name);
                                    return n && (n === norm || n.includes(norm) || norm.includes(n));
                                });
                                return byName ? byName.name : r.account_name;
                            }).filter(Boolean);

                            allowedClients = [...new Set([...allowedClients, ...autoMatched])];
                        }
                    }

                    globalAllowedClients = allowedClients;
                    document.getElementById('auth-container').classList.add('hidden');

                    if (currentUserRole === 'admin' || currentUserRole === 'member' || currentUserRole === 'investor') {
                        document.getElementById('admin-dashboard-container').classList.remove('hidden');
                        document.getElementById('sidebar-name').innerText = currentUserName;
                        document.getElementById('sidebar-role').innerText = currentUserRole;
                        document.getElementById('sidebar-avatar').innerText = currentUserName.substring(0,2).toUpperCase();
                        if (currentUserRole === 'admin') {
                            document.getElementById('admin-only-nav').classList.remove('hidden');
                            // The phone header has its own copy of these two
                            ['m-nav-templates', 'm-nav-settings'].forEach(id => {
                                const el = document.getElementById(id);
                                if (el) el.classList.remove('hidden');
                            });
                        }
                        
                        await fetchAllGlobalData(globalAllowedClients);
                        
                        // Restore the last visited page from memory, or default to the goldeneye dashboard
                        const savedPage = localStorage.getItem('midas_current_page') || 'goldeneye';
                        switchAppPage(savedPage); 
                    } else {
                        if (globalAllowedClients.length === 0) {
                            document.getElementById('auth-pending-view').classList.remove('hidden');
                        } else {
                            document.getElementById('client-portal-container').classList.remove('hidden');
                            await initClientPortal(globalAllowedClients);
                        }
                    }
                }
            } catch(e) {
                console.error("Critical error in initApp lifecycle initialization: ", e);
            }
        }
        // The drawers sit inside client-portal-container in the markup, so on the admin
        // dashboard — where that container is hidden — they inherited display:none and
        // could never open, however correct the JS was. The modals already work around
        // this by re-parenting themselves on open; doing it once here fixes every drawer
        // rather than leaving each to remember.
        (function liftDrawersOutOfPortal() {
            const wrapper = document.getElementById('theme-wrapper');
            if (!wrapper) return;
            document.querySelectorAll('.side-drawer').forEach(el => {
                if (el.parentElement !== wrapper) wrapper.appendChild(el);
            });
        })();

        initApp();

        // ================= EMAIL CODE SIGN-IN =================
        // A 6-digit code rather than a clickable magic link: the link would open a new
        // top-level tab, and browsers partition storage for third-party iframes, so the
        // session created there wouldn't be visible to the dashboard running inside GHL.
        // Typing the code creates the session in place, wherever the app is embedded.
        let pendingAuthEmail = '';

        function showAuthError(msg) {
            const el = document.getElementById('auth-error');
            if (!el) return;
            if (!msg) { el.classList.add('hidden'); el.innerText = ''; return; }
            el.innerText = msg;
            el.classList.remove('hidden');
        }

        window.backToEmailStep = function() {
            showAuthError('');
            document.getElementById('auth-step-code').classList.add('hidden');
            document.getElementById('auth-step-email').classList.remove('hidden');
            document.getElementById('auth-code').value = '';
        };

        window.sendLoginCode = async function(isResend) {
            const emailInput = document.getElementById('auth-email');
            const email = (isResend ? pendingAuthEmail : (emailInput?.value || '')).trim().toLowerCase();

            if (!email || !email.includes('@')) { showAuthError('Enter a valid email address.'); return; }
            showAuthError('');

            const btn = document.getElementById(isResend ? 'btn-verify-code' : 'btn-send-code');
            const original = btn ? btn.innerHTML : '';
            if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending...'; btn.disabled = true; }

            try {
                const { error } = await supabaseClient.auth.signInWithOtp({
                    email,
                    options: { shouldCreateUser: true }
                });
                if (error) throw error;

                pendingAuthEmail = email;
                document.getElementById('auth-email-display').innerText = email;
                document.getElementById('auth-step-email').classList.add('hidden');
                document.getElementById('auth-step-code').classList.remove('hidden');
                document.getElementById('auth-code').focus();
            } catch (err) {
                showAuthError(err.message || 'Could not send the code. Try again.');
            } finally {
                if (btn) { btn.innerHTML = original; btn.disabled = false; }
            }
        };

        window.verifyLoginCode = async function() {
            // Strip spaces/dashes people paste along with the code
            const token = (document.getElementById('auth-code')?.value || '').replace(/[\s-]/g, '').trim();
            if (token.length < 6) { showAuthError('Enter the full code from your email.'); return; }
            showAuthError('');

            const btn = document.getElementById('btn-verify-code');
            const original = btn ? btn.innerHTML : '';
            if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Signing in...'; btn.disabled = true; }

            try {
                // Supabase types the token differently depending on the account's state --
                // 'magiclink' for an existing user, 'signup' for a first-ever code, 'email'
                // for a plain OTP -- and verifyOtp reports any mismatch as "expired or
                // invalid", identically to a genuinely bad code. Try each rather than
                // guessing which kind of user this is.
                let lastError = null;
                let verified = false;

                for (const type of ['email', 'magiclink', 'signup']) {
                    const { error } = await supabaseClient.auth.verifyOtp({
                        email: pendingAuthEmail,
                        token,
                        type
                    });
                    if (!error) { console.log('[auth] verified as type:', type); verified = true; break; }
                    console.log('[auth] type', type, 'rejected:', error.message);
                    lastError = error;
                }
                if (!verified) throw lastError;

                // Session is stored; reload so initApp runs against it from a clean state
                window.location.reload();
            } catch (err) {
                showAuthError(err.message || 'That code was not accepted. Codes expire after a few minutes.');
                if (btn) { btn.innerHTML = original; btn.disabled = false; }
            }
        };

        async function signOut() { await supabaseClient.auth.signOut(); window.location.reload(); }
        
        function toggleTheme() { 
            const wrap = document.getElementById('theme-wrapper');
            wrap.classList.toggle('light-mode'); 
            document.querySelectorAll('.theme-icon').forEach(i => { i.className = wrap.classList.contains('light-mode') ? 'theme-icon fa-solid fa-sun' : 'theme-icon fa-solid fa-moon'; });
            if(!document.getElementById('admin-dashboard-container').classList.contains('hidden')) {
                if(!document.getElementById('page-goldeneye').classList.contains('hidden')) renderGoldenEye();
                if(!document.getElementById('page-tasks').classList.contains('hidden')) renderActiveTaskView(); 
                if(!document.getElementById('page-clients').classList.contains('hidden')) filterAdsData(); 
            } else { filterPortalData(); }
        }
        
        function toggleDropdown(id) { const el = document.getElementById(id); const isOpen = el.classList.contains('show'); document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.remove('show')); if(!isOpen) el.classList.add('show'); }
        
        window.onclick = (e) => { 
            if (!e.target.closest('.dropdown-container') && !e.target.closest('.fa-caret-down') && !e.target.closest('.fa-calendar')) { document.querySelectorAll('.custom-dropdown-menu, .sort-dropdown').forEach(m => m.classList.remove('show')); }
            if (!e.target.closest('#t-client-container')) { const tcDrop = document.getElementById('t-client-dropdown'); if(tcDrop) tcDrop.classList.add('hidden'); }
            if (!e.target.closest('[id^="u-client-dropdown-"]') && !e.target.closest('[onclick*="u-client-dropdown-"]')) { document.querySelectorAll('[id^="u-client-dropdown-"]').forEach(d => d.classList.add('hidden')); }
            if (!e.target.closest('#invite-client-container')) { const iDrop = document.getElementById('invite-client-dropdown'); if (iDrop) iDrop.classList.add('hidden'); }
            if (!e.target.closest('#tpl-custom-select-container')) { const tcpDrop = document.getElementById('tpl-custom-dropdown'); if(tcpDrop) tcpDrop.classList.add('hidden'); }
        }

        function closeAllDrawers() { document.querySelectorAll('.side-drawer').forEach(d=>d.classList.remove('open')); document.getElementById('drawer-overlay').classList.remove('show'); }

        // =========================================================================================
        //                               CLIENT PORTAL LOGIC
        // =========================================================================================

        async function initClientPortal(allowedClients) {
            let clientLeadsQuery = supabaseClient.from('client_leads').select('*');
            if (currentUserRole !== 'admin') clientLeadsQuery = clientLeadsQuery.in('client_name', allowedClients);

            const results = await Promise.allSettled([
                supabaseClient.from('daily_reports').select('*'),
                supabaseClient.from('tasks').select('*').in('client', allowedClients),
                clientLeadsQuery,
                supabaseClient.from('ad_approvals').select('*').in('client_name', allowedClients),
                supabaseClient.from('seo_metrics').select('*').in('client_name', allowedClients),
                supabaseClient.from('weekly_checkins').select('*').in('client_name', allowedClients),
                supabaseClient.from('client_contacts').select('*').in('client_name', allowedClients),
                supabaseClient.from('onboarding_steps').select('*').order('sort_order'),
                supabaseClient.from('client_onboarding_progress').select('*').in('client_name', allowedClients),
                // gsc_property / seranking_site_id decide whether the Organic Search tab shows at all
                supabaseClient.from('clients').select('name, client_email, current_stage, gsc_property, seranking_site_id, website_status').in('name', allowedClients),
                supabaseClient.from('weekly_reports').select('*').order('created_at', { ascending: false }),
                // Service names head the Get Started groups
                supabaseClient.from('services').select('*').order('sort_order'),
                // Which steps apply to each of their clients (service-based onboarding)
                loadOnboardingApplicability(allowedClients),
                // Answers to built-in Questions steps, so a client can come back and edit them
                supabaseClient.from('onboarding_answers').select('*').in('client_name', allowedClients)
            ]);
            globalServices = results[11].status === 'fulfilled' ? (results[11].value.data || []) : [];
            globalOnboardingAnswers = results[13].status === 'fulfilled' ? (results[13].value.data || []) : [];

            const rResData = results[0].status === 'fulfilled' ? (results[0].value.data || []) : [];
            allRawReports = rResData.map(item => { const n = {}; for (let k in item) n[k.toLowerCase().trim()] = item[k]; return n; });

            globalTasksData = results[1].status === 'fulfilled' ? (results[1].value.data || []) : [];
            globalClientLeadsData = results[2].status === 'fulfilled' ? (results[2].value.data || []) : [];
            globalCreativesData = results[3].status === 'fulfilled' ? (results[3].value.data || []) : [];
            allRawSeo = results[4].status === 'fulfilled' ? (results[4].value.data || []) : [];
            globalCheckinsData = results[5].status === 'fulfilled' ? (results[5].value.data || []) : [];
            globalContactsData = results[6].status === 'fulfilled' ? (results[6].value.data || []) : [];
            globalOnboardingSteps = results[7].status === 'fulfilled' ? (results[7].value.data || []) : [];
            globalOnboardingProgress = results[8].status === 'fulfilled' ? (results[8].value.data || []) : [];

            // If RLS won't let a client read their own row this stays empty and the email
            // prefill falls back to the address they signed in with, as it did before.
            portalClientRows = results[9].status === 'fulfilled' ? (results[9].value.data || []) : [];

            // client_name is matched here rather than in the query: the column holds
            // free text and reports are saved with whatever name was selected, so an
            // exact .in() would quietly miss rows an admin filed under a variant.
            const allReports = results[10].status === 'fulfilled' ? (results[10].value.data || []) : [];
            const allowedKeys = new Set((allowedClients || []).map(a => normalize(a)));
            portalReports = allReports.filter(r => allowedKeys.has(normalize(r.client_name || '')));

            const switcher = document.getElementById('admin-switcher');
            const select = document.getElementById('admin-client-list');
            select.innerHTML = '';
            
            allowedClients.sort().forEach(c => { const opt = document.createElement('option'); opt.value = c; opt.innerText = currentUserRole === 'admin' ? `View as: ${c}` : c; select.appendChild(opt); });
            
            // Force the switcher to stay hidden permanently for everyone
            switcher.classList.add('hidden');
            
            setTimeout(() => {
                portalSwitchClient(allowedClients[0]);

                // Land on Get Started until the client has actually finished it. This
                // replaces a localStorage flag that fired once per browser rather than
                // per client, so a returning client on a new device saw it again and
                // someone who never finished never saw it twice.
                updateGetStartedTabVisibility();
                // Never land them on Get Started once it's hidden — a client moved on with
                // steps still outstanding would otherwise open to a tab that isn't there. A
                // client past onboarding who just added a service is onboarding again.
                const obSteps = getStartedSteps(currentActiveClient, portalClientStage());
                const done = obSteps.every(s => onboardingProgressFor(currentActiveClient, s.id)?.completed_at);
                const onboarding = portalClientStage() === 'Onboarding' || servicesOnboarding(currentActiveClient).length > 0;
                switchCpTab(!done && onboarding && obSteps.length ? 'getstarted' : 'dashboard');

                // Paint the tab's dot even when they land elsewhere, then ask. Onboarding
                // comes first — a client still working through it doesn't need a second
                // thing shouting at them.
                renderWeeklyCheckin();
                if (done || !onboarding) maybeShowWeeklyCheckin();
            }, 50);
        }

        // The date range only means something on views that actually plot one. Rather than
        // keeping a copy per view, the single control moves to where it applies — and on
        // the dashboard that's below the tasks, next to the first chart it filters.
        // Desktop leaves it in the header, where there's room for it.
        const CP_DATE_SLOTS = {
            dashboard:   'cp-date-slot-dash',
            tasks:       'cp-date-slot-top',
            seo:         'cp-date-slot-top',
            leaderboard: 'cp-date-slot-top'
        };

        window.cpCurrentTab = 'dashboard';

        window.placePortalDateControl = function(tabName) {
            const ctrl = document.getElementById('portal-date-control');
            if (!ctrl) return;

            // Same breakpoint as the mobile running order in body.html
            if (!window.matchMedia('(max-width: 1023px)').matches) {
                const home = document.getElementById('portal-date-home');
                if (home && ctrl.nextElementSibling !== home) home.parentElement.insertBefore(ctrl, home);
                ctrl.classList.remove('hidden');
                return;
            }

            const slot = document.getElementById(CP_DATE_SLOTS[tabName] || '');
            if (!slot) { ctrl.classList.add('hidden'); return; }

            if (ctrl.parentElement !== slot) slot.appendChild(ctrl);
            ctrl.classList.remove('hidden');
        };

        // Rotating the phone crosses the breakpoint, so the control has to be re-placed
        window.addEventListener('resize', () => placePortalDateControl(window.cpCurrentTab));

        function switchCpTab(tabName) {
            window.cpCurrentTab = tabName;
    ['getstarted', 'knowledge', 'dashboard', 'tasks', 'support', 'reports', 'checkin', 'pipeline', 'creatives', 'settings', 'seo', 'leaderboard', 'profile'].forEach(t => {
        const el = document.getElementById(`cp-view-${t}`);
        const btn = document.getElementById(`cp-tab-${t}`);
        if(el) el.classList.add('hidden');
        if(btn) {
            // Rewriting className wholesale dropped whatever hid the tab, so a retired tab
            // reappeared on the first switch and Get Started came back for clients long
            // past onboarding. Carry the hidden state across the reset.
            const wasHidden = btn.classList.contains('hidden');
            btn.className = 'whitespace-nowrap pb-3 text-sm font-bold text-gray-500 border-b-2 border-transparent hover:text-gray-300 transition';
            if (wasHidden) btn.classList.add('hidden');
        }
    });
    
    const activeEl = document.getElementById(`cp-view-${tabName}`);
    if(activeEl) activeEl.classList.remove('hidden');
    const activeBtn = document.getElementById(`cp-tab-${tabName}`);
    if(activeBtn) {
        activeBtn.classList.replace('text-gray-500', 'text-yellow-400');
        activeBtn.classList.replace('border-transparent', 'border-b-2');
        activeBtn.classList.add('border-yellow-400');
    }

    if(tabName === 'getstarted') { renderGetStarted(); startOnboardingPoll(); }
    else stopOnboardingPoll();
    if(tabName === 'dashboard') ensureWorkSummaryLoaded();
    if(tabName === 'checkin') renderWeeklyCheckin();
    if(tabName === 'reports') renderCpReports();
    if(tabName === 'support') renderCpSupport();
    if(tabName === 'tasks') renderCpTasks();
    if(tabName === 'pipeline') renderCpPipeline();
    if(tabName === 'creatives') renderClientCreatives();
    if(tabName === 'settings') renderCpSettings();
    if(tabName === 'seo') renderCpSeo();
    if(tabName === 'leaderboard') renderAnonymizedLeaderboard();
    if(tabName === 'knowledge') renderKnowledgeBase();
    if(tabName === 'profile') renderCpProfile();

    placePortalDateControl(tabName);
}

// ================= CLIENT ONBOARDING (Get Started) =================
// Progress lives in Supabase, not localStorage, so it survives a device change and
// the agency can see where a client actually is.

function onboardingProgressFor(clientName, stepId) {
    const want = normalize(clientName);
    return globalOnboardingProgress.find(p => normalize(p.client_name) === want && p.step_id === stepId) || null;
}

// ---- Which steps apply to which client ----
// Decided in SQL by onboarding_steps_for_client() (service_onboarding.sql), the same function
// trg_onboarding_handoff uses, so the portal and the "onboarding complete" text can't disagree.
// Loaded once per data load for every client in view. Keyed by normalized client name.
//   steps:    rows {step_id, owner, service_key, service_status, display_service_key, completed}
//   services: rows {service_key, status, complete} from service_onboarding_status(), incl. 'base'
let obApplicable = new Map();
// False until the SQL is installed and answering; everything then falls back to the old
// behavior (every active step applies to every client), so nothing breaks in between.
let obServiceMode = false;

async function loadOnboardingApplicability(clientNames) {
    const names = [...new Set((clientNames || []).filter(Boolean))];
    if (!names.length) return;
    const [stepsRes, statusRes] = await Promise.all([
        supabaseClient.rpc('onboarding_steps_for_clients', { p_clients: names }),
        supabaseClient.rpc('service_onboarding_status_for_clients', { p_clients: names })
    ]);
    if (stepsRes.error || statusRes.error) {
        console.warn('[LIFECYCLE ENGINE] Service onboarding functions unavailable, every step applies to every client:', stepsRes.error || statusRes.error);
        obServiceMode = false;
        return;
    }
    const map = new Map();
    const entry = n => {
        const k = normalize(n);
        if (!map.has(k)) map.set(k, { steps: [], services: [] });
        return map.get(k);
    };
    names.forEach(entry);
    (stepsRes.data || []).forEach(r => entry(r.client_name).steps.push(r));
    (statusRes.data || []).forEach(r => entry(r.client_name).services.push(r));
    // Merge rather than replace: the portal and the dashboard load different client sets
    map.forEach((v, k) => obApplicable.set(k, v));
    obServiceMode = true;
}

function obFor(clientName) {
    return obServiceMode ? obApplicable.get(normalize(clientName || '')) : null;
}

function allActiveStepsSorted() {
    return globalOnboardingSteps
        .filter(s => s.active !== false)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}

// Every onboarding item that applies to this client, both sides, in order. Each carries
// __service (the heading it shows under, null = Getting started). With no client, or before the
// SQL is installed, every active step, as before.
function allOnboardingItems(clientName) {
    const all = allActiveStepsSorted();
    const a = clientName ? obFor(clientName) : null;
    if (!a) return all;
    const display = new Map(a.steps.map(r => [r.step_id, r.display_service_key || null]));
    return all.filter(s => display.has(s.id)).map(s => ({ ...s, __service: display.get(s.id) }));
}

// Just the client's own steps: what the portal shows and what its progress measures.
// Agency items are tasks and don't belong in the client's checklist.
function activeOnboardingSteps(clientName = currentActiveClient) {
    return allOnboardingItems(clientName).filter(s => s.owner !== 'agency');
}

function onboardingIsComplete(clientName) {
    const steps = activeOnboardingSteps(clientName);
    if (!steps.length) return true;
    return steps.every(s => onboardingProgressFor(clientName, s.id)?.completed_at);
}

// Add-ons this client is part-way through onboarding (client_services.status = 'onboarding')
function servicesOnboarding(clientName) {
    const a = obFor(clientName);
    return a ? a.services.filter(s => s.service_key !== 'base' && s.status === 'onboarding').map(s => s.service_key) : [];
}

// The client steps Get Started shows. In the Onboarding stage, everything that applies. After it,
// only the steps of an add-on they're onboarding now: a long-running ads client who adds SEO sees
// the SEO steps, not the Base steps added after they onboarded years ago.
function getStartedSteps(clientName, stage) {
    const steps = activeOnboardingSteps(clientName);
    if ((stage || 'Onboarding') === 'Onboarding') return steps;
    const a = obFor(clientName);
    if (!a) return [];
    const live = new Set(a.steps.filter(r => r.service_status === 'onboarding').map(r => r.step_id));
    return steps.filter(s => live.has(s.id));
}

// Title of the task trg_onboarding_handoff raises when a client past onboarding finishes an
// add-on. Built the same way there; change both together.
function addonHandoffTitle(serviceKey) {
    return `${serviceName(serviceKey)} onboarding complete — ready to start`;
}

// A Loom share link can't report watch progress, so self-hosted MP4s are the norm here.
// Kept tolerant of either: anything that isn't a direct video file renders as an iframe.
const isDirectVideo = url => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url || '');

// Pre-fill the client's email into an embedded form. Three separate forms means three
// chances to type a different address — and GHL keys contacts on email, so a mismatch
// silently splits their answers across two contact records. It also keeps the webhook's
// client lookup reliable, since the address always matches the one on file.
// An onboarding step's form also gets step_id, website_status and services, so one generic Make
// scenario can tick off any form, and a form can branch on the client's record rather than a
// fresh answer. They only land in the form if it has hidden fields with those names; GHL ignores
// the rest, so they're harmless on forms without them.
function prefillFormUrl(url, step) {
    if (!url) return url;
    const withStep = u => {
        if (!step) return u;
        const want = normalize(currentActiveClient);
        const row = portalClientRows.find(c => normalize(c.name) === want) || globalClientsData.find(c => normalize(c.name) === want);
        const services = (obFor(currentActiveClient)?.services || []).filter(s => s.service_key !== 'base').map(s => s.service_key);
        // Empty values are left off rather than sent blank, which could blank a GHL field
        const extra = new URLSearchParams(Object.entries({ step_id: step.id, website_status: row?.website_status, services: services.join(',') })
            .filter(([, v]) => v));
        return `${u}${u.includes('?') ? '&' : '?'}${extra.toString()}`;
    };
    url = withStep(url);

    // globalClientsData is only filled by fetchAllGlobalData, which the client role never
    // runs — the portal loads its own name/email pairs instead. Check both so the lookup
    // works whichever side is rendering.
    const want = normalize(currentActiveClient);
    const client = globalClientsData.find(c => normalize(c.name) === want)
                || portalClientRows.find(c => normalize(c.name) === want);
    // client_email can hold several comma-separated addresses; the first is the primary
    const email = String(client?.client_email || clientEmail || '').split(/[,;\s]+/)[0].trim();
    if (!email) return url;

    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}email=${encodeURIComponent(email)}`;
}

// Which cards the client has opened or closed by hand. Without this the list only
// ever shows the next outstanding step, so a finished one can't be re-read — and the
// videos are reference material people come back to. Keyed by step id and kept across
// re-renders, since the form poll re-renders underneath them.
const obManualOpen = {};

window.obToggleStep = function(stepId, defaultExpand) {
    obManualOpen[stepId] = !(stepId in obManualOpen ? obManualOpen[stepId] : defaultExpand);
    renderGetStarted();
};

// ---- Client tasks ----
// A task belongs to the client when its assignee says so, which means you can hand
// something over from the normal task drawer without a new field. Their own requests
// live under Get in Touch, so they're left out here rather than listed twice.

const cpTaskIsClients = t => normalize(t.assignee || '') === 'client';

// Tasks hidden from the client are already withheld by RLS for a client login. This filter is what
// keeps them out when an admin previews the portal, where RLS lets everything through.
function cpTasksForClient() {
    return globalTasksData.filter(t =>
        normalize(t.client || '') === normalize(currentActiveClient || '') &&
        t.type !== 'Client Request' &&
        t.client_visible !== false);
}

// Whose it is, stated on every card. In the board the two are mixed together, so the
// colour is the only thing distinguishing what they owe us from what we owe them.
function cpOwnerBadge(t) {
    return cpTaskIsClients(t)
        ? '<span class="text-[9px] uppercase tracking-widest font-bold text-amber-400 shrink-0"><span class="inline-block w-2 h-2 rounded-full bg-amber-400 mr-1 align-middle"></span>Your to-do</span>'
        : '<span class="text-[9px] uppercase tracking-widest font-bold text-blue-400 shrink-0"><span class="inline-block w-2 h-2 rounded-full bg-blue-400 mr-1 align-middle"></span>We\'re handling it</span>';
}

function cpDueHtml(t) {
    if (!t.due) return '';
    const overdue = t.status !== 'Complete' && t.due < new Date().toISOString().split('T')[0];
    return `<span class="${overdue ? 'text-red-400' : 'text-gray-500'} text-xs whitespace-nowrap">${overdue ? 'Overdue &middot; ' : 'Due '}${t.due}</span>`;
}

function cpDoneButtonHtml(t) {
    return `<button onclick="cpCompleteTask('${escapeAttr(t.id)}')" class="shrink-0 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 px-4 rounded-lg transition">
        <i class="fa-solid fa-check mr-1"></i> Done
    </button>`;
}

function cpTaskRowHtml(t, actionable) {
    // Notes are where the internal detail lives, so only the title crosses over
    return `<div class="glass px-5 py-4 flex items-center justify-between gap-4 border-l-4 ${cpTaskIsClients(t) ? 'border-amber-400' : 'border-blue-400'}">
        <div class="min-w-0">
            <p class="text-sm font-bold ${t.status === 'Complete' ? 'text-gray-500 line-through' : 'text-white'} truncate">${escapeAttr(stripSlashEscapes(t.title))}</p>
            <div class="flex items-center gap-3 mt-1">
                ${cpOwnerBadge(t)}
                <span class="text-[10px] uppercase tracking-widest ${t.status === 'In Progress' ? 'text-blue-400' : t.status === 'Blocked' ? 'text-amber-400' : 'text-gray-500'}">${escapeAttr(t.status || 'Not Started')}</span>
                ${cpDueHtml(t)}
            </div>
        </div>
        ${actionable ? cpDoneButtonHtml(t) : ''}
    </div>`;
}

let cpTaskView = 'list';

window.switchCpTaskView = function(mode) {
    cpTaskView = mode === 'board' ? 'board' : 'list';

    const listEl = document.getElementById('cp-tasks-list-view');
    const boardEl = document.getElementById('cp-tasks-board-view');
    if (listEl) listEl.classList.toggle('hidden', cpTaskView !== 'list');
    if (boardEl) boardEl.classList.toggle('hidden', cpTaskView !== 'board');

    ['list', 'board'].forEach(m => {
        const b = document.getElementById(`cp-btn-tasks-${m}`);
        if (b) b.classList.toggle('active', m === cpTaskView);
    });

    renderCpTasks();
};

function renderCpTaskBoard(all) {
    const board = document.getElementById('cp-tasks-board-view');
    if (!board) return;

    // Same columns as the internal board, so a conversation about a task means the same
    // thing on both sides of the screen
    const columns = [
        ['Not Started', 'text-gray-400'],
        ['In Progress', 'text-blue-400'],
        ['Blocked',     'text-amber-400'],
        ['Complete',    'text-emerald-400']
    ];

    board.innerHTML = columns.map(([status, colour]) => {
        const rows = all.filter(t => (t.status || 'Not Started') === status);

        const cards = rows.length
            ? rows.map(t => `<div class="glass p-4 border-l-4 ${cpTaskIsClients(t) ? 'border-amber-400' : 'border-blue-400'}">
                   <div class="flex justify-between items-start gap-2 mb-2">${cpOwnerBadge(t)}${cpDueHtml(t)}</div>
                   <p class="font-bold text-white text-sm leading-snug ${t.status === 'Complete' ? 'line-through opacity-60' : ''}">${escapeAttr(stripSlashEscapes(t.title))}</p>
                   ${cpTaskIsClients(t) && t.status !== 'Complete' ? `<div class="mt-3">${cpDoneButtonHtml(t)}</div>` : ''}
               </div>`).join('')
            : '<p class="text-xs text-gray-600 italic px-1">Nothing here.</p>';

        return `<div class="space-y-3">
            <div class="flex items-center justify-between px-1">
                <h4 class="text-[10px] font-bold uppercase tracking-widest ${colour}">${status}</h4>
                <span class="text-[10px] text-gray-600">${rows.length}</span>
            </div>
            ${cards}
        </div>`;
    }).join('');
}

// ---- Work summary: the dashboard blurb, and the Tasks tab's default view ----
// Generated once a day per client by the client-summary edge function, which looks at
// what got completed in the trailing week and what's still open, and asks the model for
// a short plain-text recap — never a live call from here. Fetched once per portal
// session and reused everywhere it's shown, since it cannot change until tomorrow's run.
let cachedWorkSummary = null;
let workSummaryFetchStarted = false;

async function ensureWorkSummaryLoaded() {
    if (workSummaryFetchStarted) { paintWorkSummaryBoxes(); return; }
    workSummaryFetchStarted = true;
    try {
        const { data, error } = await supabaseClient
            .from('client_work_summaries')
            .select('summary')
            .eq('client_name', currentActiveClient)
            .order('range_end', { ascending: false })
            .limit(1);
        if (error) throw error;
        cachedWorkSummary = data?.[0]?.summary || null;
    } catch (e) {
        console.error('Could not load work summary:', e);
    }
    paintWorkSummaryBoxes();
}

// innerText, never innerHTML — the model is instructed to return plain prose with no
// markup, and this is the one place in the portal where text the model wrote reaches a
// client's own screen unmediated by a fixed template. Nothing it writes should ever be
// capable of being interpreted as HTML here.
function paintWorkSummaryBoxes() {
    const text = cachedWorkSummary || "We're still putting this week's update together — check back shortly.";
    const dash = document.getElementById('work-summary-dash');
    if (dash) dash.innerText = text;

    // The Tasks tab only shows this cached text while the default range is selected;
    // renderCpTasks() below decides which text belongs there for any other range.
    if (selectedDateRange === 'last7') {
        const box = document.getElementById('work-summary-tasks');
        if (box) box.innerText = text;
    }
}

// The factual counterpart for any range other than the default. No model call — this
// is a plain filter over data already sitting in globalTasksData, computed instantly.
// "Still working on" has no honest date-scoped meaning (task status has no history, only
// a current value — see CLAUDE.md), so a custom range swaps it for "due in that period",
// a fact the data actually supports.
function buildTasksRecap() {
    const { s, e } = getPortalRange();
    const all = cpTasksForClient();

    const done = all.filter(t => {
        if (t.status !== 'Complete' || !t.updated_at) return false;
        const d = new Date(t.updated_at);
        return d >= s && d <= e;
    });
    const dueInRange = all.filter(t => {
        if (t.status === 'Complete' || !t.due) return false;
        const d = new Date(t.due + 'T12:00:00');
        return d >= s && d <= e;
    });

    const list = (rows) => rows.map(t => stripSlashEscapes(t.title)).join(', ');

    return (done.length
        ? `${done.length} task${done.length > 1 ? 's' : ''} completed in this period: ${list(done)}.`
        : 'No tasks were completed in this period.')
        + ' '
        + (dueInRange.length
        ? `${dueInRange.length} due in this period: ${list(dueInRange)}.`
        : 'Nothing due in this period.');
}

window.renderCpTasks = function() {
    // Top-of-tab summary: the cached daily narrative on the default range, a plain
    // computed recap for anything the client has picked by hand.
    const summaryHeading = document.getElementById('cp-tasks-summary-heading');
    if (selectedDateRange === 'last7') {
        if (summaryHeading) summaryHeading.innerText = "What We've Done This Week";
        ensureWorkSummaryLoaded();
    } else {
        if (summaryHeading) summaryHeading.innerText = document.getElementById('selected-date-label')?.innerText || 'Selected range';
        const box = document.getElementById('work-summary-tasks');
        if (box) box.innerText = buildTasksRecap();
    }

    const all = cpTasksForClient();
    const open = all.filter(t => t.status !== 'Complete');

    const mine = open.filter(cpTaskIsClients);
    const ours = open.filter(t => !cpTaskIsClients(t));

    const done = all.filter(t => t.status === 'Complete')
        .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
        .slice(0, 5);

    const paint = (id, rows, empty, actionable) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = rows.length
            ? rows.map(t => cpTaskRowHtml(t, actionable)).join('')
            : `<p class="text-sm text-gray-500 italic px-2">${empty}</p>`;
    };

    paint('cp-tasks-mine', mine, "Nothing needs you right now.", true);
    paint('cp-tasks-ours', ours, "Nothing open at the moment.", false);
    paint('cp-tasks-done', done, "Nothing finished yet.", false);

    // The board shows the finished column in full rather than the list's recent five
    renderCpTaskBoard(all);

    const mineCount = document.getElementById('cp-tasks-mine-count');
    if (mineCount) mineCount.innerText = mine.length ? `${mine.length} waiting on you` : '';
    const oursCount = document.getElementById('cp-tasks-ours-count');
    if (oursCount) oursCount.innerText = ours.length ? `${ours.length} in progress` : '';

    // Only their own outstanding items earn the dot — ours aren't theirs to chase
    const dot = document.getElementById('cp-tasks-dot');
    if (dot) dot.classList.toggle('hidden', !mine.length);
};

window.cpCompleteTask = async function(id) {
    const t = globalTasksData.find(x => String(x.id) === String(id));
    if (!t || !cpTaskIsClients(t)) return;

    const previous = t.status;
    t.status = 'Complete';
    renderCpTasks();

    const { error } = await supabaseClient.from('tasks')
        .update({ status: 'Complete', updated_at: new Date().toISOString() }).eq('id', t.id);

    if (error) {
        // Put it back rather than leaving them believing it was saved
        t.status = previous;
        renderCpTasks();
        alert("Couldn't save that just now — please try again.");
        console.error('Client task completion failed:', error);
    }
};

// ---- Get in Touch ----
// Requests are filed as Client Request tasks, the same shape the onboarding help link
// uses, so they surface in the dashboard's inbound queue without extra plumbing.

// Paste the GHL calendar link here to turn the booking card on. Left empty the card
// explains how to reach us instead, rather than showing an empty box.
const CP_SUPPORT_CALENDAR_URL = 'https://link.midasmediafirm.com/widget/bookings/client-request-meeting';

window.renderCpSupport = function() {
    const cal = document.getElementById('cp-support-calendar');
    if (cal) {
        cal.innerHTML = CP_SUPPORT_CALENDAR_URL
            ? `<div class="w-full rounded-lg overflow-hidden border border-white/10 bg-white" style="height:60vh">
                   <iframe src="${escapeAttr(prefillFormUrl(CP_SUPPORT_CALENDAR_URL))}" class="w-full h-full" frameborder="0"></iframe>
               </div>`
            : `<p class="text-sm text-gray-500 italic">Booking isn't set up yet — send a request instead and we'll come back to you with times.</p>`;
    }

    const list = document.getElementById('cp-support-open');
    if (!list) return;

    const open = globalTasksData.filter(t =>
        normalize(t.client || '') === normalize(currentActiveClient || '') &&
        t.type === 'Client Request' &&
        t.status !== 'Complete' &&
        t.client_visible !== false);

    if (!open.length) {
        list.innerHTML = '<p class="text-sm text-gray-500 italic px-2">Nothing open. Anything you send will show here until it\'s done.</p>';
        return;
    }

    list.innerHTML = open.map(t => `
        <div class="glass px-5 py-4 flex items-center justify-between gap-4">
            <div class="min-w-0">
                <p class="text-sm font-bold text-white truncate">${escapeAttr(stripSlashEscapes(t.title))}</p>
                <p class="text-xs text-gray-500 mt-1">Sent ${t.updated_at ? new Date(t.updated_at).toLocaleDateString() : 'recently'}</p>
            </div>
            <span class="shrink-0 text-[10px] uppercase tracking-widest ${t.status === 'In Progress' ? 'text-blue-400' : 'text-gray-500'}">${escapeAttr(t.status || 'Not Started')}</span>
        </div>`).join('');
};

window.submitPortalRequest = async function() {
    const btn = document.getElementById('cp-req-submit');
    const err = document.getElementById('cp-req-error');
    const type = document.getElementById('cp-req-type').value;
    const subject = document.getElementById('cp-req-subject').value.trim();
    const details = document.getElementById('cp-req-details').value.trim();

    const show = msg => { if (err) { err.innerText = msg; err.classList.remove('hidden'); } };
    if (err) err.classList.add('hidden');

    if (!subject) { show('Give it a subject so we know what it\'s about.'); return; }

    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Sending...';
    btn.disabled = true;

    try {
        const row = {
            title: `[${type}] ${subject}`,
            client: currentActiveClient,
            type: 'Client Request',
            stage: null,
            status: 'Not Started',
            assignee: 'Unassigned',
            p: 5, u: 5, e: 3, score: 100,
            notes: details ? `Client Request Details:\n${details}` : null,
            updated_at: new Date().toISOString()
        };

        const { data, error } = await supabaseClient.from('tasks').insert([row]).select();
        if (error) throw error;
        if (data?.length) globalTasksData.push(...data);

        document.getElementById('cp-req-subject').value = '';
        document.getElementById('cp-req-details').value = '';
        renderCpSupport();
    } catch (e) {
        show("Couldn't send that — please try again, or email us.");
        console.error('Portal request failed:', e);
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
    }
};

// ---- Sales team step ----
// Writes straight into client_contacts, which is the table the weekly reminder reads —
// so adding a rep here is what puts them on the check-in texts. Collected as real
// name/phone fields rather than a free-text answer, because "Mike 801-555-0100 and
// Sarah" is exactly the sort of thing that can't be parsed reliably.

function obTeamRowHtml(stepId, contact) {
    return `<div class="ob-team-row flex flex-wrap gap-2 items-center">
        <input type="text" class="glass-input !py-2 flex-1 min-w-[140px] ob-team-name" placeholder="Name"
               value="${escapeAttr(stripSlashEscapes(contact?.contact_name))}">
        <input type="tel" class="glass-input !py-2 flex-1 min-w-[140px] ob-team-phone" placeholder="Mobile number"
               value="${escapeAttr(stripSlashEscapes(contact?.phone))}">
        <button type="button" onclick="this.closest('.ob-team-row').remove()"
                class="text-red-500/60 hover:text-red-400 px-2 py-1.5" title="Remove">
            <i class="fa-solid fa-xmark"></i>
        </button>
    </div>`;
}

function obTeamStepHtml(s, complete) {
    const mine = globalContactsData.filter(c =>
        normalize(c.client_name || '') === normalize(currentActiveClient || '') && c.active !== false);

    if (complete) {
        const names = mine.map(c => escapeAttr(stripSlashEscapes(c.contact_name || c.phone))).join(', ');
        return `<p class="text-sm text-gray-400 mb-4">${names ? `On the weekly check-in: ${names}.` : 'No sales team recorded.'}
                   Need to change this? Just let us know.</p>`;
    }

    const rows = mine.length ? mine.map(c => obTeamRowHtml(s.id, c)).join('') : obTeamRowHtml(s.id, null);

    return `
        <div class="space-y-3 mb-4">
            <div id="ob-team-rows-${s.id}" class="space-y-2">${rows}</div>
            <button type="button" onclick="obAddTeamRow('${s.id}')" class="text-xs text-blue-400 hover:text-blue-300 font-bold">
                <i class="fa-solid fa-plus mr-1"></i> Add another person
            </button>
            <p id="ob-team-error-${s.id}" class="text-sm text-red-400 hidden"></p>
        </div>
        <div class="flex flex-wrap items-center gap-3">
            <button onclick="obSaveTeam('${s.id}', false)" class="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 px-5 rounded-lg text-sm shadow-lg transition">
                <i class="fa-solid fa-check mr-2"></i>Save my team
            </button>
            <button onclick="obSaveTeam('${s.id}', true)" class="text-xs text-gray-400 hover:text-white underline underline-offset-2 transition">
                No sales team &mdash; it's just me
            </button>
        </div>`;
}

window.obAddTeamRow = function(stepId) {
    const list = document.getElementById(`ob-team-rows-${stepId}`);
    if (!list) return;
    list.insertAdjacentHTML('beforeend', obTeamRowHtml(stepId, null));
};

window.obSaveTeam = async function(stepId, justMe) {
    const err = document.getElementById(`ob-team-error-${stepId}`);
    const show = msg => { if (err) { err.innerText = msg; err.classList.remove('hidden'); } };
    if (err) err.classList.add('hidden');

    let people;

    if (justMe) {
        // The address they signed in with is the one we already reach them on
        people = [{ contact_name: currentUserName || clientEmail || 'Owner', phone: null }];
    } else {
        people = [...document.querySelectorAll(`#ob-team-rows-${stepId} .ob-team-row`)]
            .map(r => ({
                contact_name: r.querySelector('.ob-team-name').value.trim(),
                phone: r.querySelector('.ob-team-phone').value.trim()
            }))
            .filter(p => p.contact_name || p.phone);

        if (!people.length) {
            show("Add at least one person, or choose “it's just me” below.");
            return;
        }
        const incomplete = people.find(p => !p.contact_name || !p.phone);
        if (incomplete) {
            show('Every person needs both a name and a mobile number.');
            return;
        }
        // Ten digits is what a US mobile reduces to; anything shorter is a typo
        const badPhone = people.find(p => String(p.phone).replace(/\D/g, '').length < 10);
        if (badPhone) {
            show(`That number for ${badPhone.contact_name} doesn't look complete.`);
            return;
        }
    }

    try {
        const rows = people.filter(p => p.phone).map(p => ({
            client_name: currentActiveClient,
            contact_name: p.contact_name,
            phone: p.phone,
            active: true
        }));

        if (rows.length) {
            // Matches the admin editor's conflict target, so re-saving updates a person
            // rather than adding them twice
            const { data, error } = await supabaseClient.from('client_contacts')
                .upsert(rows, { onConflict: 'phone' }).select();
            if (error) throw error;
            if (data?.length) {
                const fresh = new Set(data.map(d => String(d.phone)));
                globalContactsData = globalContactsData.filter(c => !fresh.has(String(c.phone))).concat(data);
            }
        }

        await obCompleteStep(stepId);
    } catch (e) {
        show("Couldn't save that — please try again.");
        console.error('Sales team save failed:', e);
    }
};

// Everything the client can see about their own account, plus the controls that used
// to sit in the header. On a phone that header row was competing with the date control
// for space, and sign-out in particular is a thing you look for deliberately rather than
// something that needs to be one tap away on every screen.
// ================= AD APPROVALS =================
// Clients approve the finished ad, not the raw asset. Meta renders it for us: an ad's
// preview endpoint returns an iframe showing exactly what will run, per placement, so
// there is nothing to keep in sync with what is actually in the ad account.
//
// The preview URL carries a token, so Make fetches it server-side and writes the result
// here — the browser never holds Meta credentials. Those URLs also expire, which is why
// preview_fetched_at is recorded and stale rows can be re-requested.
// Make webhooks are never called from the browser directly. Their URLs would be in the page
// source, and anyone holding one can run the scenario, which is how 10 leads got an
// "onboarding complete" text (CLAUDE.md). make-relay checks the caller is an admin, adds
// the secret Make's filters require, and forwards the request.
const MAKE_RELAY_FN = 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/make-relay';
async function callMakeRelay(hook, payload) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.access_token) throw new Error('Your session has expired — sign in again.');
    const res = await fetch(MAKE_RELAY_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ hook, payload })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `the relay returned ${res.status}`);
    return data;
}

// The dashboard's model calls (the chat agent and Generate Report) go through the ai-chat edge
// function, which only answers a signed-in admin. So this sends the session token, never the
// public anon key: before 2026-09-16 the anon key was enough, and anyone who read the page source
// could run requests on our OpenAI account.
const AI_CHAT_FN = "https://hugnttsqucetldllfgoi.supabase.co/functions/v1/ai-chat";
async function callAiChat(messages) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.access_token) throw new Error('Your session has expired — sign in again.');
    const res = await fetch(AI_CHAT_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ messages })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
        const e = data.error;
        throw new Error((e && (e.message || (typeof e === 'string' ? e : ''))) || `the AI service returned ${res.status}`);
    }
    return data;
}

// Meta's placement identifiers, with names a person would use
const AD_PLACEMENT_LABELS = {
    MOBILE_FEED_STANDARD:  'Facebook feed',
    DESKTOP_FEED_STANDARD: 'Desktop feed',
    INSTAGRAM_STANDARD:    'Instagram feed',
    INSTAGRAM_STORY:       'Instagram story',
    FACEBOOK_STORY_MOBILE: 'Facebook story'
};

// Previews go stale; past this we stop trusting them and offer a refresh
const AD_PREVIEW_STALE_HOURS = 20;

function adPreviewIsStale(row) {
    if (!row?.preview_fetched_at) return true;
    const age = (Date.now() - new Date(row.preview_fetched_at).getTime()) / 36e5;
    return age > AD_PREVIEW_STALE_HOURS;
}

// Meta returns the preview inside an HTML snippet, so the URL arrives with its query
// string entity-escaped. Decoding here rather than in Make keeps the scenario to a
// plain pattern match — and a URL that still had &amp; in it would break twice over,
// since escapeAttr re-escapes the ampersand on the way into the iframe.
// Three shapes reach this: a bare URL, Meta's <iframe src="..."> snippet, or — when a
// Make mapping points at the whole HTTP response rather than data[1].body — that snippet
// JSON-encoded, where every quote arrives as \". Matching an optional backslash on both
// sides covers all three, so a mis-mapped field degrades to a working preview instead of
// handing the iframe a blob of JSON and rendering a 404.
function decodePreviewUrl(url) {
    let out = String(url || '').trim();

    const match = out.match(/src=\\?["']([^"'\\]+)/i);
    if (match) out = match[1];

    // However it arrived, the query string is entity-escaped. Left alone the &amp; breaks
    // twice, since escapeAttr re-escapes the ampersand on the way into the iframe.
    out = out
        .replace(/&amp;/g, '&')
        .replace(/&#0?39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\\\//g, '/')
        .trim();

    // Anything that isn't a URL by now is a mapping mistake, not a preview
    return /^https?:\/\//i.test(out) ? out : '';
}

// Meta sizes each placement differently — a feed preview is 335x450, a story is taller
// and narrower. The snippet carries those dimensions, so use them rather than forcing
// one size on everything: the iframe's contents don't reflow, so a wrong box either
// crops the ad or strands it in white space.
function adPreviewBox(snippet) {
    const raw = String(snippet || '');
    const width  = parseInt((raw.match(/width=\\?["'](\d+)/i)  || [])[1], 10);
    const height = parseInt((raw.match(/height=\\?["'](\d+)/i) || [])[1], 10);
    return {
        url: decodePreviewUrl(raw),
        width:  Number.isFinite(width)  ? width  : 335,
        height: Number.isFinite(height) ? height : 450
    };
}

// One column per placement rather than a JSON blob. Meta's snippet is full of double
// quotes, so building JSON for it inside a Make mapping field means hand-escaping every
// one — a plain text column takes the snippet as-is. The jsonb column is still read if
// something writes it, so nothing that already worked stops working.
const AD_PREVIEW_COLUMNS = {
    preview_facebook_feed:   'MOBILE_FEED_STANDARD',
    preview_instagram_feed:  'INSTAGRAM_STANDARD',
    preview_instagram_story: 'INSTAGRAM_STORY'
};

function adPreviewEntries(row) {
    if (!row) return [];
    const found = new Map();

    // Columns first, so the placement order matches the table above
    for (const [column, placement] of Object.entries(AD_PREVIEW_COLUMNS)) {
        if (row[column]) {
            const box = adPreviewBox(row[column]);
            if (box.url) found.set(placement, box);
        }
    }

    const previews = row.previews;
    if (previews && typeof previews === 'object') {
        for (const [placement, snippet] of Object.entries(previews)) {
            if (snippet && !found.has(placement)) {
                const box = adPreviewBox(snippet);
                if (box.url) found.set(placement, box);
            }
        }
    }

    return [...found.entries()];
}

function adStatusBadge(status) {
    if (status === 'approved')          return '<span class="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border text-emerald-400 bg-emerald-500/10 border-emerald-500/25">Approved</span>';
    if (status === 'changes_requested') return '<span class="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border text-amber-400 bg-amber-500/10 border-amber-500/25">Changes asked</span>';
    return '<span class="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border text-blue-400 bg-blue-500/10 border-blue-500/25">Awaiting client</span>';
}

// Ask Make to fetch this ad's previews. Fire-and-forget with no-cors: the scenario
// writes straight to Supabase, and a Make outage must not undo the insert that already
// succeeded — same reasoning as the Postgres webhooks.
// Make's Supabase app has no plain update — it upserts, which Postgres runs as an
// insert that falls back to update. That means the row still has to satisfy NOT NULL
// on the way in, so the payload carries the identifying fields rather than just the id.
// status is deliberately absent: re-fetching previews must never overwrite a decision
// the client has already made.
async function requestAdPreviews(approvalId, adId, row) {
    // Through make-relay, which still sends Make form-encoded fields, so the scenario's
    // mappings are unchanged
    try {
        await callMakeRelay('ad_preview', {
            approval_id: String(approvalId),
            ad_id: String(adId),
            client_name: row?.client_name || '',
            ad_name: row?.ad_name || ''
        });
    } catch (e) {
        console.error('Could not reach the preview webhook:', e);
    }
}

window.submitAdForApproval = async function(e) {
    e.preventDefault();
    if (currentUserRole !== 'admin') return;

    const btn = document.getElementById('btn-upload-creative');
    const client = document.getElementById('creative-client').value;
    const name = document.getElementById('creative-name').value.trim();
    // Meta ad ids are digits; people paste act_ prefixes and stray spaces
    const adId = document.getElementById('creative-ad-id').value.replace(/[^0-9]/g, '');

    if (!client || !name || !adId) return;

    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Sending...';
    btn.disabled = true;

    try {
        const { data, error } = await supabaseClient.from('ad_approvals').insert({
            client_name: client,
            ad_name: name,
            ad_id: adId,
            status: 'pending'
        }).select().single();
        if (error) throw error;

        await requestAdPreviews(data.id, adId, data);

        document.getElementById('creative-name').value = '';
        document.getElementById('creative-ad-id').value = '';

        await reloadAdApprovals();
        renderAdminCreatives();
    } catch (err) {
        alert('Could not send that ad for approval: ' + err.message);
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
    }
};

window.refreshAdPreviews = async function(approvalId) {
    const row = globalCreativesData.find(r => String(r.id) === String(approvalId));
    if (!row) return;
    await requestAdPreviews(row.id, row.ad_id, row);
    // Make writes asynchronously, so give it a moment before re-reading
    setTimeout(async () => { await reloadAdApprovals(); renderAdminCreatives(); }, 4000);
};

window.deleteAdApproval = async function(approvalId) {
    if (currentUserRole !== 'admin') return;
    if (!confirm('Remove this ad from the approval list? The ad itself is untouched.')) return;
    const { error } = await supabaseClient.from('ad_approvals').delete().eq('id', approvalId);
    if (error) { alert('Could not remove it: ' + error.message); return; }
    await reloadAdApprovals();
    renderAdminCreatives();
};

async function reloadAdApprovals() {
    const { data, error } = await supabaseClient.from('ad_approvals').select('*').order('created_at', { ascending: false });
    if (!error) globalCreativesData = data || [];
}

window.renderAdminCreatives = function() {
    const body = document.getElementById('admin-creatives-list');
    if (!body) return;

    const rows = [...globalCreativesData].sort((a, b) =>
        new Date(b.created_at || 0) - new Date(a.created_at || 0));

    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="6" class="p-6 text-center text-xs text-gray-500 italic">Nothing sent for approval yet.</td></tr>';
        return;
    }

    body.innerHTML = rows.map(r => {
        const count = adPreviewEntries(r).length;
        let previewCell;
        if (r.preview_error) {
            previewCell = `<span class="text-xs text-red-400" title="${escapeAttr(r.preview_error)}"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Failed</span>`;
        } else if (!count) {
            previewCell = '<span class="text-xs text-gray-500"><i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Fetching&hellip;</span>';
        } else {
            previewCell = `<span class="text-xs text-gray-300">${count} placement${count === 1 ? '' : 's'}${adPreviewIsStale(r) ? ' <span class="text-amber-400">(stale)</span>' : ''}</span>`;
        }

        return `<tr class="hover:bg-white/5 transition">
            <td class="p-2 text-xs text-gray-400">${escapeAttr(stripSlashEscapes(r.client_name || ''))}</td>
            <td class="p-2 text-xs font-bold text-white">${escapeAttr(stripSlashEscapes(r.ad_name || ''))}
                <span class="block text-[10px] text-gray-600 font-normal">${escapeAttr(r.ad_id || '')}</span></td>
            <td class="p-2">${previewCell}</td>
            <td class="p-2">${adStatusBadge(r.status)}</td>
            <td class="p-2 text-xs text-gray-400 max-w-[220px]">${escapeAttr(stripSlashEscapes(r.feedback || '—'))}</td>
            <td class="p-2 text-right whitespace-nowrap">
                <button onclick="refreshAdPreviews('${r.id}')" title="Fetch the previews again" class="glass-icon-btn !w-8 !h-8 inline-flex"><i class="fa-solid fa-rotate text-xs"></i></button>
                <button onclick="deleteAdApproval('${r.id}')" title="Remove from the list" class="glass-icon-btn !w-8 !h-8 inline-flex text-red-400"><i class="fa-solid fa-trash text-xs"></i></button>
            </td>
        </tr>`;
    }).join('');
};

// --- Client side ---

window.cpSetPlacement = function(approvalId, placement) {
    const wrap = document.getElementById('ad-preview-' + approvalId);
    if (!wrap) return;
    wrap.dataset.placement = placement;
    renderClientCreatives();
};

window.renderClientCreatives = function() {
    const grid = document.getElementById('client-creatives-grid');
    if (!grid) return;

    const want = normalize(currentActiveClient);
    const rows = globalCreativesData
        .filter(r => normalize(r.client_name) === want)
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    if (!rows.length) {
        grid.innerHTML = '<p class="text-sm text-gray-500 italic px-2">Nothing waiting on you right now. New ads appear here before they run.</p>';
        return;
    }

    grid.innerHTML = rows.map(r => {
        const entries = adPreviewEntries(r);
        const chosen = document.getElementById('ad-preview-' + r.id)?.dataset.placement;
        const active = entries.find(([k]) => k === chosen) || entries[0];

        let body;
        if (!entries.length) {
            body = `<div class="bg-black/20 border border-white/5 rounded-xl p-8 text-center text-xs text-gray-500">
                        <i class="fa-solid fa-circle-notch fa-spin mr-1"></i> Preparing this ad &mdash; check back shortly.
                    </div>`;
        } else {
            const tabs = entries.map(([k]) => {
                const on = k === active[0];
                return `<button onclick="cpSetPlacement('${r.id}', '${k}')" class="text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full border transition ${on ? 'text-white bg-white/10 border-white/20' : 'text-gray-500 border-transparent hover:text-gray-300'}">${escapeAttr(AD_PLACEMENT_LABELS[k] || k)}</button>`;
            }).join('');

            const box = active[1];
            body = `<div class="flex flex-wrap gap-1 mb-3">${tabs}</div>
                    <div class="bg-white rounded-xl overflow-hidden border border-white/10 flex justify-center p-2">
                        <iframe src="${escapeAttr(box.url)}"
                                width="${box.width}" height="${box.height}"
                                style="border:0;max-width:100%" scrolling="no" allow="autoplay"></iframe>
                    </div>`;
        }

        const decided = r.status === 'approved' || r.status === 'changes_requested';
        const actions = decided
            ? `<p class="text-xs ${r.status === 'approved' ? 'text-emerald-400' : 'text-amber-400'} mt-4">
                   <i class="fa-solid fa-circle-check mr-1"></i>
                   ${r.status === 'approved' ? 'You approved this' : 'You asked for changes'}${r.reviewed_at ? ' on ' + new Date(r.reviewed_at).toLocaleDateString() : ''}.
                   ${r.feedback ? '<span class="block text-gray-400 mt-1">&ldquo;' + escapeAttr(stripSlashEscapes(r.feedback)) + '&rdquo;</span>' : ''}
               </p>`
            : `<div class="mt-4 space-y-3">
                   <textarea id="ad-feedback-${r.id}" rows="2" class="glass-input text-xs" placeholder="Anything you would change? (optional if approving)"></textarea>
                   <div class="flex flex-wrap gap-2">
                       <button onclick="decideAd('${r.id}', 'approved')" class="bg-emerald-600 hover:bg-emerald-500 text-white btn text-xs shadow-lg transition">
                           <i class="fa-solid fa-check mr-2"></i> Approve
                       </button>
                       <button onclick="decideAd('${r.id}', 'changes_requested')" class="glass-pill text-xs !py-2 text-amber-400 !border-amber-500/30">
                           <i class="fa-solid fa-pen mr-2"></i> Request changes
                       </button>
                   </div>
               </div>`;

        return `<div id="ad-preview-${r.id}" class="glass p-5" data-placement="${escapeAttr(active ? active[0] : '')}">
                    <div class="flex items-start justify-between gap-3 mb-3">
                        <h4 class="font-bold text-white">${escapeAttr(stripSlashEscapes(r.ad_name || 'Untitled ad'))}</h4>
                        ${adStatusBadge(r.status)}
                    </div>
                    ${body}
                    ${actions}
                </div>`;
    }).join('');
};

window.decideAd = async function(approvalId, status) {
    if (previewBlocksWrite('approving an ad')) return;

    const box = document.getElementById('ad-feedback-' + approvalId);
    const feedback = box ? box.value.trim() : '';

    // An approval needs no explanation; a rejection we can't act on is worse than none
    if (status === 'changes_requested' && !feedback) {
        alert('Tell us what you would like changed so we know what to fix.');
        if (box) box.focus();
        return;
    }

    const { error } = await supabaseClient.from('ad_approvals').update({
        status,
        feedback: feedback || null,
        reviewed_by: clientEmail || null,
        reviewed_at: new Date().toISOString()
    }).eq('id', approvalId);

    if (error) { alert('Could not save that: ' + error.message); return; }

    const row = globalCreativesData.find(r => String(r.id) === String(approvalId));
    if (row) Object.assign(row, { status, feedback: feedback || null, reviewed_at: new Date().toISOString() });
    renderClientCreatives();
};

window.renderCpProfile = function() {
    const client = currentActiveClient;
    const want = normalize(client);
    const row = globalClientsData.find(c => normalize(c.name) === want)
             || portalClientRows.find(c => normalize(c.name) === want);

    const nameEl = document.getElementById('cp-profile-name');
    if (nameEl) nameEl.innerText = client || 'Your business';

    const avatar = document.getElementById('cp-profile-avatar');
    if (avatar) {
        avatar.innerText = String(client || '?')
            .split(/s+/).filter(Boolean).slice(0, 2)
            .map(w => w[0]).join('').toUpperCase() || '?';
    }

    // client_email can hold several addresses; show the one they signed in with
    const emailEl = document.getElementById('cp-profile-email');
    if (emailEl) emailEl.innerText = clientEmail || row?.client_email || '—';

    const stageEl = document.getElementById('cp-profile-stage');
    if (stageEl) stageEl.innerText = row?.current_stage || 'Active';

    const obEl = document.getElementById('cp-profile-onboarding');
    if (obEl) {
        const steps = activeOnboardingSteps(client);
        if (!steps.length) {
            obEl.innerText = 'Nothing outstanding';
        } else {
            const done = steps.filter(st => onboardingProgressFor(client, st.id)?.completed_at).length;
            obEl.innerText = done === steps.length ? 'Complete' : `${done} of ${steps.length} done`;
        }
    }

    const team = document.getElementById('cp-profile-team');
    if (!team) return;

    const mine = globalContactsData.filter(c => normalize(c.client_name) === want && c.active !== false);
    if (!mine.length) {
        team.innerHTML = '<p class="text-xs text-gray-500 italic">No one added yet. Invite a teammate so they get the weekly check-in too.</p>';
        return;
    }

    team.innerHTML = mine.map(c => {
        const d = String(c.phone || '').replace(/D/g, '');
        const phone = d.length === 10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : (c.phone || '');
        return `<div class="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-xl px-3 py-2">
                    <span class="text-sm font-bold text-white truncate">${escapeAttr(stripSlashEscapes(c.contact_name || 'Unnamed'))}</span>
                    <span class="text-xs text-gray-400 shrink-0">${escapeAttr(phone)}</span>
                </div>`;
    }).join('');
};

window.renderGetStarted = function() {
    const list = document.getElementById('ob-steps-list');
    if (!list) return;

    const client = currentActiveClient;
    const steps = getStartedSteps(client, portalClientStage());
    const done = steps.filter(s => onboardingProgressFor(client, s.id)?.completed_at).length;
    // Headings only when there's more than one group; a single list needs no "Getting started"
    const groupOf = s => s.__service || null;
    const grouped = new Set(steps.map(groupOf)).size > 1;
    let lastGroup;

    const label = document.getElementById('ob-progress-label');
    const bar = document.getElementById('ob-progress-bar');
    if (label) label.innerText = `${done} of ${steps.length} complete`;
    if (bar) bar.style.width = steps.length ? `${Math.round((done / steps.length) * 100)}%` : '0%';

    const allDone = document.getElementById('ob-all-done');
    if (allDone) allDone.classList.toggle('hidden', !(steps.length && done === steps.length));

    let firstOpen = true;
    list.innerHTML = '';

    // Headings follow services order, so steps are regrouped rather than left in raw sort order
    const groupRank = g => g === null ? -1 : (globalServices.findIndex(x => x.key === g) + 1 || 999);
    if (grouped) steps.sort((a, b) => groupRank(groupOf(a)) - groupRank(groupOf(b)));

    steps.forEach((s, i) => {
        const prog = onboardingProgressFor(client, s.id);
        const complete = !!prog?.completed_at;

        if (grouped && groupOf(s) !== lastGroup) {
            lastGroup = groupOf(s);
            const members = steps.filter(x => groupOf(x) === lastGroup);
            const doneHere = members.filter(x => onboardingProgressFor(client, x.id)?.completed_at).length;
            const heading = document.createElement('div');
            heading.className = 'flex items-baseline justify-between pt-2';
            heading.innerHTML = `<h3 class="text-xs font-bold uppercase tracking-widest text-gray-400">${escapeAttr(lastGroup ? serviceName(lastGroup) : 'Getting started')}</h3>
                <span class="text-[11px] text-gray-500">${doneHere} of ${members.length}</span>`;
            list.appendChild(heading);
        }
        // Expand the first thing they still have to do; collapse the rest. A click on
        // the header overrides that either way, so anything can be reopened later.
        const defaultExpand = !complete && firstOpen;
        if (defaultExpand) firstOpen = false;
        const expand = (s.id in obManualOpen) ? obManualOpen[s.id] : defaultExpand;

        const card = document.createElement('div');
        card.className = `glass p-6 border-l-4 ${complete ? 'border-emerald-500' : expand ? 'border-blue-500' : 'border-white/10'}`;

        let inner = `
            <div class="flex items-start justify-between gap-4 cursor-pointer select-none ${expand ? 'mb-4' : ''}"
                 onclick="obToggleStep('${s.id}', ${defaultExpand})"
                 title="${expand ? 'Hide this step' : 'Open this step'}">
                <div class="flex items-start gap-3">
                    <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${complete ? 'bg-emerald-500 text-white' : 'bg-white/10 text-gray-400'}">
                        ${complete ? '<i class="fa-solid fa-check"></i>' : i + 1}
                    </div>
                    <div>
                        <h4 class="font-bold ${complete ? 'text-gray-400 line-through' : 'text-white'}">${escapeAttr(stripSlashEscapes(s.title))}</h4>
                        ${s.description && (!complete || expand) ? `<p class="text-sm text-gray-400 mt-1">${escapeAttr(stripSlashEscapes(s.description))}</p>` : ''}
                    </div>
                </div>
                <div class="flex items-center gap-3 shrink-0">
                    ${complete ? '<span class="text-[10px] uppercase tracking-widest text-emerald-400 whitespace-nowrap">Done</span>' : ''}
                    <i class="fa-solid fa-chevron-down text-xs text-gray-500 transition-transform ${expand ? 'rotate-180' : ''}"></i>
                </div>
            </div>`;

        if (expand) {
            if (s.step_type === 'video' && s.embed_url) {
                // A step that asks them to go and *do* something stays open until they
                // say they did it — finishing the video isn't the same as granting access.
                const autoComplete = !s.requires_confirm;
                inner += isDirectVideo(s.embed_url)
                    ? `<div class="w-full aspect-video bg-black/40 rounded-lg overflow-hidden border border-white/10 mb-4">
                           <video id="ob-vid-${s.id}" controls playsinline class="w-full h-full outline-none"
                                  onloadedmetadata="obVideoReady('${s.id}')"
                                  ontimeupdate="obVideoProgress('${s.id}')"
                                  ${autoComplete && !complete ? `onended="obCompleteStep('${s.id}')"` : ''}>
                               <source src="${escapeAttr(stripSlashEscapes(s.embed_url))}">
                           </video>
                       </div>
                       <p class="text-[11px] text-gray-500 mb-3"><span id="ob-watched-${s.id}">0</span>% watched${autoComplete ? ' &mdash; this marks itself complete when you reach the end.' : ''}</p>`
                    : `<div class="w-full aspect-video bg-black/40 rounded-lg overflow-hidden border border-white/10 mb-4">
                           <iframe src="${escapeAttr(stripSlashEscapes(s.embed_url))}" class="w-full h-full" frameborder="0" allowfullscreen></iframe>
                       </div>`;
            }

            if (s.step_type === 'team') {
                inner += obTeamStepHtml(s, complete);
            }

            if (s.step_type === 'questions') {
                inner += obQuestionsFormHtml(s, complete);
            }

            if (s.step_type === 'form' && s.embed_url) {
                inner += `<div class="w-full rounded-lg overflow-hidden border border-white/10 mb-4 bg-white" style="height:70vh">
                              <iframe src="${escapeAttr(prefillFormUrl(stripSlashEscapes(s.embed_url), s))}" class="w-full h-full" frameborder="0"></iframe>
                          </div>`;

                // Only promise the automatic tick where a webhook is actually wired up.
                // An embed with no automation behind it — a booking calendar, say — asks
                // for a confirmation instead, and saying it ticks itself off would be a lie.
                if (!s.requires_confirm) {
                    inner += `<p class="text-[11px] text-gray-500 mb-3">
                                  <i class="fa-solid fa-circle-notch fa-spin mr-1 text-blue-400"></i>
                                  After you hit submit, give this a few seconds &mdash; it ticks itself off and opens the next step. Please don&rsquo;t close this tab.
                              </p>`;
                }
            }

            // Videos that can't report progress, forms, and plain actions all need a
            // manual confirm. A self-hosted video completes on its own.
            // A self-hosted video ends on its own; a form is completed by GHL's webhook.
            // Neither needs a button as the primary path.
            const selfCompleting = (s.step_type === 'video' && isDirectVideo(s.embed_url) && !s.requires_confirm)
                                || (s.step_type === 'form' && !s.requires_confirm)
                                // A team step carries its own Save and "just me" buttons
                                || s.step_type === 'team'
                                // and a Questions step its own Submit
                                || s.step_type === 'questions';

            inner += complete
                ? `<p class="text-[11px] text-emerald-400/80"><i class="fa-solid fa-circle-check mr-1"></i>Completed ${prog.completed_at ? new Date(prog.completed_at).toLocaleDateString() : ''} &mdash; here for reference.</p>`
                : '';

            inner += `<div class="flex flex-wrap items-center gap-3 ${complete ? 'hidden' : ''}">`;
            if (!selfCompleting) {
                const label = s.confirm_label || "Mark as done";
                inner += `<button onclick="obCompleteStep('${s.id}')" class="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 px-5 rounded-lg text-sm shadow-lg transition">
                              <i class="fa-solid fa-check mr-2"></i>${escapeAttr(stripSlashEscapes(label))}
                          </button>`;
            }

            // Fallback for a form, revealed only after the automatic path has had time to
            // work. Present from the start it just invites a click, which is what the
            // webhook exists to avoid — but a client whose submission didn't register
            // still needs a way forward.
            if (s.step_type === 'form' && !s.requires_confirm) {
                inner += `<button id="ob-manual-${s.id}" onclick="obCompleteStep('${s.id}')" class="hidden text-xs text-gray-400 hover:text-white underline underline-offset-2 transition">
                              Submitted it but nothing happened? Mark it done
                          </button>`;
            }

            // Escape hatch. Deliberately quieter than the primary action — the aim is that
            // most people do it themselves, not that everyone books a call.
            if (s.offer_help) {
                const asked = obHelpAlreadyRequested(s.id);
                inner += asked
                    ? `<span class="text-xs text-blue-400"><i class="fa-solid fa-circle-check mr-1"></i>We've got your request &mdash; we'll be in touch to book a time.</span>`
                    : `<button onclick="obRequestHelp('${s.id}')" class="text-xs text-gray-400 hover:text-white underline underline-offset-2 transition">
                           Rather we walked you through it? Book a call
                       </button>`;
            }
            inner += `</div>`;
        }

        card.innerHTML = inner;
        list.appendChild(card);
    });

    // Give the webhook a fair run before offering the manual way out. 25 seconds covers
    // GHL firing, Make running and a poll cycle landing.
    clearTimeout(obManualRevealTimer);
    obManualRevealTimer = setTimeout(() => {
        document.querySelectorAll('[id^="ob-manual-"]').forEach(b => b.classList.remove('hidden'));
    }, 25000);
};

// ---- Built-in Questions steps ----
// The questions live on the step (onboarding_steps.questions), answers in onboarding_answers.
// Submitting saves the answers and completes the step like any other, so the handoff trigger
// and progress bars need nothing special. See supabase/sql/onboarding_questions.sql.
function obAnswersFor(clientName, stepId) {
    const want = normalize(clientName);
    return globalOnboardingAnswers.find(a => normalize(a.client_name) === want && a.step_id === stepId) || null;
}

function obClientWebsiteStatus(clientName) {
    const want = normalize(clientName || '');
    const row = portalClientRows.find(c => normalize(c.name) === want) || globalClientsData.find(c => normalize(c.name) === want);
    return row?.website_status || null;
}

// The questions this client is asked: a question tagged with website situations only shows when
// the client's website situation is one of them (unknown means it isn't asked).
function obQuestionsFor(step, clientName) {
    const web = obClientWebsiteStatus(clientName);
    return (Array.isArray(step.questions) ? step.questions : [])
        .filter(q => q && q.id && q.label)
        .filter(q => !(q.website_statuses || []).length || (web && q.website_statuses.includes(web)));
}

function obQuestionsFormHtml(s, complete) {
    const questions = obQuestionsFor(s, currentActiveClient);
    const saved = obAnswersFor(currentActiveClient, s.id)?.answers || {};
    const valueOf = q => saved[q.id]?.value;
    const fieldId = q => `obq-${s.id}-${q.id}`;

    const field = q => {
        const v = valueOf(q);
        const req = q.required ? ' <span class="text-red-400" title="Required">*</span>' : '';
        const label = `<label class="block text-sm font-bold text-white mb-1" for="${fieldId(q)}">${escapeAttr(q.label)}${req}</label>`;
        const opts = Array.isArray(q.options) ? q.options.filter(Boolean) : [];
        if (q.type === 'long') {
            return `${label}<textarea id="${fieldId(q)}" rows="3" class="glass-input w-full" data-qid="${escapeAttr(q.id)}">${escapeAttr(typeof v === 'string' ? v : '')}</textarea>`;
        }
        if (q.type === 'choice' || q.type === 'multi') {
            const chosen = new Set(Array.isArray(v) ? v : (v ? [v] : []));
            const input = q.type === 'choice' ? 'radio' : 'checkbox';
            return `<fieldset data-qid="${escapeAttr(q.id)}" data-qtype="${q.type}">
                <legend class="block text-sm font-bold text-white mb-1">${escapeAttr(q.label)}${req}</legend>
                <div class="flex flex-wrap gap-x-4 gap-y-2">
                    ${opts.map(o => `<label class="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                        <input type="${input}" name="${fieldId(q)}" value="${escapeAttr(o)}" class="row-checkbox" ${chosen.has(o) ? 'checked' : ''}> ${escapeAttr(o)}
                    </label>`).join('')}
                </div>
            </fieldset>`;
        }
        return `${label}<input type="text" id="${fieldId(q)}" class="glass-input w-full" data-qid="${escapeAttr(q.id)}" value="${escapeAttr(typeof v === 'string' ? v : '')}">`;
    };

    if (!questions.length) {
        return `<p class="text-sm text-gray-500 mb-4">Nothing to answer here yet.</p>`;
    }
    return `<form id="obq-form-${s.id}" class="space-y-4 mb-4" onsubmit="event.preventDefault(); obSubmitAnswers('${s.id}')">
        ${questions.map(q => `<div>${field(q)}</div>`).join('')}
        <div class="flex flex-wrap items-center gap-3">
            <button type="submit" class="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 px-5 rounded-lg text-sm shadow-lg transition">
                <i class="fa-solid fa-check mr-2"></i>${complete ? 'Save changes' : 'Submit answers'}
            </button>
            <span id="obq-status-${s.id}" class="text-xs text-gray-400" role="status"></span>
        </div>
    </form>`;
}

window.obSubmitAnswers = async function(stepId) {
    if (previewBlocksWrite('submitting answers')) return;
    const step = globalOnboardingSteps.find(s => s.id === stepId);
    const form = document.getElementById(`obq-form-${stepId}`);
    const status = document.getElementById(`obq-status-${stepId}`);
    if (!step || !form) return;

    const answers = {};
    const missing = [];
    obQuestionsFor(step, currentActiveClient).forEach(q => {
        let value;
        if (q.type === 'choice') {
            value = form.querySelector(`fieldset[data-qid="${CSS.escape(q.id)}"] input:checked`)?.value || '';
        } else if (q.type === 'multi') {
            value = [...form.querySelectorAll(`fieldset[data-qid="${CSS.escape(q.id)}"] input:checked`)].map(i => i.value);
        } else {
            value = (form.querySelector(`[data-qid="${CSS.escape(q.id)}"]`)?.value || '').trim();
        }
        const empty = Array.isArray(value) ? !value.length : !value;
        if (q.required && empty) missing.push(q.label);
        if (!empty) answers[q.id] = { label: q.label, value };
    });

    if (missing.length) {
        status.className = 'text-xs text-amber-400';
        status.innerText = `Please answer: ${missing.join('; ')}`;
        return;
    }

    status.className = 'text-xs text-gray-400';
    status.innerText = 'Saving…';
    const now = new Date().toISOString();
    const row = { client_name: currentActiveClient, step_id: stepId, answers, submitted_by: clientEmail || null, updated_at: now };
    const { error } = await supabaseClient.from('onboarding_answers').upsert(row, { onConflict: 'client_name,step_id' });
    if (error) {
        console.error('Could not save answers:', error);
        status.className = 'text-xs text-red-400';
        status.innerText = "Couldn't save your answers. Please try again, or email us if it keeps happening.";
        return;
    }

    const existing = obAnswersFor(currentActiveClient, stepId);
    if (existing) Object.assign(existing, row); else globalOnboardingAnswers.push({ ...row, submitted_at: now });

    if (onboardingProgressFor(currentActiveClient, stepId)?.completed_at) {
        status.className = 'text-xs text-emerald-400';
        status.innerText = 'Saved.';
        return;
    }
    // Completing re-renders the list and moves them on to the next step
    await obCompleteStep(stepId);
};

// Restore playback position so a client returning mid-video isn't sent back to zero
// Onboarding videos start at 1.5x. Browsers preserve pitch, so it stays perfectly
// intelligible, and the native controls still let anyone slow it down. Only applies to
// self-hosted files — a Loom embed is a cross-origin iframe we can't reach into.
const OB_VIDEO_RATE = 1.5;

window.obVideoReady = function(stepId) {
    const v = document.getElementById('ob-vid-' + stepId);
    if (!v) return;

    v.playbackRate = OB_VIDEO_RATE;

    const prog = onboardingProgressFor(currentActiveClient, stepId);
    if (!prog?.watch_percent || prog.completed_at) return;
    if (v.duration && isFinite(v.duration)) v.currentTime = (prog.watch_percent / 100) * v.duration;
};

// timeupdate fires ~4x/sec; only persist when the furthest point advances by 10% or more
const obLastSaved = {};
window.obVideoProgress = function(stepId) {
    const v = document.getElementById('ob-vid-' + stepId);
    if (!v || !v.duration || !isFinite(v.duration)) return;

    const pct = Math.min(100, Math.round((v.currentTime / v.duration) * 100));
    const el = document.getElementById('ob-watched-' + stepId);
    if (el) el.innerText = pct;

    const last = obLastSaved[stepId] || 0;
    if (pct >= last + 10) {
        obLastSaved[stepId] = pct;
        saveOnboardingProgress(stepId, { watch_percent: pct });
    }
};

async function saveOnboardingProgress(stepId, fields) {
    // Silent rather than an alert — timeupdate fires this repeatedly during playback
    if (window.isClientPreview) return null;

    const row = {
        client_name: currentActiveClient,
        step_id: stepId,
        completed_by: clientEmail || null,
        ...fields
    };
    const { error } = await supabaseClient
        .from('client_onboarding_progress')
        .upsert(row, { onConflict: 'client_name,step_id' });
    if (error) { console.error('Could not save onboarding progress:', error); return null; }

    // Keep local state in step so the UI doesn't need a refetch
    const existing = onboardingProgressFor(currentActiveClient, stepId);
    if (existing) Object.assign(existing, row);
    else globalOnboardingProgress.push(row);
    return row;
}

// A help request is an open Client Request task naming this step. Tracking it that way
// means it shows on the Golden Eye dashboard's inbound requests without extra plumbing,
// and clears itself once the task is worked.
function obHelpRequestTitle(stepId) {
    const step = globalOnboardingSteps.find(s => s.id === stepId);
    return `Tech access call requested — ${step?.title || 'onboarding'}`;
}

function obHelpAlreadyRequested(stepId) {
    const title = obHelpRequestTitle(stepId).trim().toLowerCase();
    return globalTasksData.some(t =>
        normalize(t.client || '') === normalize(currentActiveClient) &&
        String(t.title || '').trim().toLowerCase() === title &&
        t.status !== 'Complete');
}

window.obRequestHelp = async function(stepId) {
    if (previewBlocksWrite('booking a call')) return;
    if (obHelpAlreadyRequested(stepId)) return;

    const due = new Date();
    due.setDate(due.getDate() + 1);   // someone stuck shouldn't wait

    const row = {
        client: currentActiveClient,
        title: obHelpRequestTitle(stepId),
        type: 'Client Request',
        stage: 'Onboarding',
        status: 'Not Started',
        assignee: 'Account Manager',
        p: 5, u: 5, e: 2, score: 96,
        due: due.toISOString().split('T')[0],
        notes: `${currentActiveClient} asked for help with this onboarding step via their portal.`,
        updated_at: new Date().toISOString()
    };

    const { error } = await supabaseClient.from('tasks').insert([row]);
    if (error) { alert("Couldn't send that request — please email us instead."); return; }

    // Keep local state in step so the confirmation shows without a refetch
    globalTasksData.push(row);
    renderGetStarted();
};

window.obCompleteStep = async function(stepId) {
    // saveOnboardingProgress already refuses in preview, but silently — this is a button,
    // so it needs to say why nothing happened rather than just not responding.
    if (previewBlocksWrite('marking a step done')) return;

    const step = globalOnboardingSteps.find(s => s.id === stepId);
    if (!step) return;
    if (onboardingProgressFor(currentActiveClient, stepId)?.completed_at) return;

    await saveOnboardingProgress(stepId, {
        completed_at: new Date().toISOString(),
        watch_percent: step.step_type === 'video' ? 100 : null
    });

    renderGetStarted();
    updateGetStartedTabVisibility();
    await obNotifyOnboardingComplete();
};

// Finishing the last step is the agency's cue to take over, but nothing on this side
// watches for it — the portal just hides the tab. Raising it as a Client Request puts
// it in the same inbound queue as help requests, so it lands where the team already
// looks rather than needing its own notification path.
const OB_COMPLETE_TASK_TITLE = 'Onboarding complete — ready for campaign build';

// Keyed by client, since an admin can switch accounts without reloading
const obCompletionRaised = new Set();

// Built in one place because two sides raise it: the portal at the moment the client
// finishes, and the dashboard catching up on anyone the portal missed.
function buildOnboardingHandoffTask(clientName) {
    const due = new Date();
    due.setDate(due.getDate() + 1);

    return {
        client: clientName,
        title: OB_COMPLETE_TASK_TITLE,
        type: 'Client Request',
        stage: 'Onboarding',
        status: 'Not Started',
        assignee: 'Account Manager',
        p: 5, u: 4, e: 1, score: 92,
        due: due.toISOString().split('T')[0],
        notes: `${clientName} finished every onboarding step in their portal.`,
        updated_at: new Date().toISOString()
    };
}

// The agency's own onboarding work, raised when the client finishes rather than when
// they're created. generateStageTasks dedupes on title against the database, so both
// the portal and the dashboard can call this and only one set is ever created.
//
// Which agency steps: in the Onboarding stage, every one that applies to the client. Past it,
// only those of an add-on whose "<add-on> onboarding complete" task exists (the trigger raises
// it when the client finishes that add-on's steps). Keying on the task rather than on
// client_services.status matters: SEO clients from before services existed are 'active' with no
// such task, and must not suddenly get SEO setup tasks.
async function raiseOnboardingAgencyTasks(clientName, stage) {
    stage = stage || globalClientsData.find(c => normalize(c.name) === normalize(clientName))?.current_stage
        || portalClientRows.find(c => normalize(c.name) === normalize(clientName))?.current_stage || 'Onboarding';
    try {
        let onlyServices = null;
        if (stage !== 'Onboarding') {
            const a = obFor(clientName);
            if (!a) return;
            const candidates = [...new Set(a.steps.filter(r => r.owner === 'agency' && r.service_key).map(r => r.service_key))];
            if (!candidates.length) return;
            const titles = candidates.map(k => addonHandoffTitle(k).toLowerCase());
            const { data } = await supabaseClient.from('tasks').select('title, client').eq('stage', 'Onboarding');
            const have = new Set((data || []).filter(t => normalize(t.client || '') === normalize(clientName))
                .map(t => String(t.title || '').trim().toLowerCase()));
            onlyServices = candidates.filter((k, i) => have.has(titles[i]));
            if (!onlyServices.length) return;
        }
        // Logged even when it creates nothing: "no agency steps configured" and "they all
        // exist already" are different problems, and silence looked the same as never running
        const configured = allOnboardingItems(clientName).filter(s => s.owner === 'agency').length;
        const made = await generateStageTasks(clientName, 'Onboarding', { onlyServices });
        console.log(`[LIFECYCLE ENGINE] ${clientName}: ${configured} agency step(s) apply${onlyServices ? ` (raising for ${onlyServices.join(', ')})` : ''}, ${made} task(s) raised.`);
    } catch (err) {
        console.error(`[LIFECYCLE ENGINE] Could not raise onboarding tasks for ${clientName}:`, err);
    }
}

function onboardingHandoffRaised(clientName) {
    const key = normalize(clientName || '');
    const title = OB_COMPLETE_TASK_TITLE.trim().toLowerCase();
    return globalTasksData.some(t =>
        normalize(t.client || '') === key &&
        String(t.title || '').trim().toLowerCase() === title);
}

async function obNotifyOnboardingComplete() {
    const client = currentActiveClient;
    const key = normalize(client || '');
    if (!key || obCompletionRaised.has(key)) return;

    // Past onboarding, finishing is an add-on's. trg_onboarding_handoff has already marked it
    // active and raised its task in the same save, so refresh what applies (the add-on's steps
    // leave Get Started) and raise our tasks for it. No text goes out for an add-on.
    if (portalClientStage() !== 'Onboarding') {
        const pending = getStartedSteps(client, portalClientStage());
        if (!pending.length || !pending.every(s => onboardingProgressFor(client, s.id)?.completed_at)) return;
        obCompletionRaised.add(key);
        await loadOnboardingApplicability([client]);
        await raiseOnboardingAgencyTasks(client, portalClientStage());
        renderGetStarted();
        updateGetStartedTabVisibility();
        return;
    }

    const steps = activeOnboardingSteps(client);
    if (!steps.length || !onboardingIsComplete(client)) return;

    // Claimed before any await so the 2s form poll can't file a second one behind this
    obCompletionRaised.add(key);

    // trg_onboarding_handoff raises this same task inside the upsert that completed the
    // last step, so it usually exists by now — in the database, not in globalTasksData.
    // Checking only the local copy filed a duplicate every time, and each duplicate is
    // one more admin alert through trg_notify_client_request.
    if (!onboardingHandoffRaised(client)) {
        const { data: existing } = await supabaseClient.from('tasks').select('*')
            .eq('client', client).eq('title', OB_COMPLETE_TASK_TITLE).limit(1);
        if (existing?.length) globalTasksData.push(...existing);
    }

    // Worked or not, an existing copy means this already announced itself — but our own
    // checklist still has to be raised, or a handoff task the trigger got to first means
    // it never is
    if (onboardingHandoffRaised(client)) {
        await raiseOnboardingAgencyTasks(client);
        return;
    }

    const row = buildOnboardingHandoffTask(client);

    const { error } = await supabaseClient.from('tasks').insert([row]);
    if (error) {
        // Let a later completion retry rather than losing the handoff silently
        obCompletionRaised.delete(key);
        console.error('Could not raise the onboarding-complete task:', error);
        return;
    }
    globalTasksData.push(row);

    // Their side is done, so ours begins
    await raiseOnboardingAgencyTasks(client);
}

// A form step is completed by a webhook after GHL tells us it was submitted, so the
// portal has no way to know it happened. Without this the client submits a form and
// watches nothing change, which reads as broken. Polls only while a form step is
// actually outstanding and the tab is open, then stops.
let obPollTimer = null;

function obHasPendingFormStep() {
    // A form step that asks for a confirmation has no webhook behind it, so polling for
    // one would never stop on its own
    return getStartedSteps(currentActiveClient, portalClientStage()).some(s =>
        s.step_type === 'form' && !s.requires_confirm &&
        !onboardingProgressFor(currentActiveClient, s.id)?.completed_at);
}

window.startOnboardingPoll = function() {
    stopOnboardingPoll();
    if (!obHasPendingFormStep()) return;

    obPollTimer = setInterval(async () => {
        // Stop if the client navigated away or finished the forms
        const onTab = !document.getElementById('cp-view-getstarted')?.classList.contains('hidden');
        if (!onTab || !obHasPendingFormStep()) { stopOnboardingPoll(); return; }

        const { data, error } = await supabaseClient
            .from('client_onboarding_progress')
            .select('*')
            .eq('client_name', currentActiveClient);
        if (error) return;

        const before = globalOnboardingProgress.filter(p => normalize(p.client_name) === normalize(currentActiveClient))
            .filter(p => p.completed_at).length;

        // Replace this client's rows with what the server has
        globalOnboardingProgress = globalOnboardingProgress
            .filter(p => normalize(p.client_name) !== normalize(currentActiveClient))
            .concat(data || []);

        const after = (data || []).filter(p => p.completed_at).length;
        if (after > before) {
            renderGetStarted();
            updateGetStartedTabVisibility();
            await obNotifyOnboardingComplete();
            if (!obHasPendingFormStep()) stopOnboardingPoll();
        }
    }, 2000);
};

window.stopOnboardingPoll = function() {
    if (obPollTimer) { clearInterval(obPollTimer); obPollTimer = null; }
};

// The tab only exists while there's something left to do
window.updateGetStartedTabVisibility = function() {
    const tab = document.getElementById('cp-tab-getstarted');
    if (!tab) return;
    const steps = getStartedSteps(currentActiveClient, portalClientStage());
    // Stays reachable after completion. The videos explain things people forget — how
    // Meta bills, what they agreed to on the forms — and hiding the tab meant the only
    // way back was asking us. First login still lands them here; a finished client just
    // isn't sent here, and sees the done panel if they come looking.
    //
    // Leaving the Onboarding stage is the exception: at that point it's history rather
    // than something they might still need, and the same videos live on in the Knowledge
    // Base anyway.
    // A client who added a service is onboarding again, whatever their stage, until its steps
    // are done and the trigger marks it active. getStartedSteps already narrows to those steps.
    const show = steps.length > 0 && (portalClientStage() === 'Onboarding'
        || servicesOnboarding(currentActiveClient).length > 0);
    tab.classList.toggle('hidden', !show);

    // Hiding the button while its content is still on screen left the client stranded on
    // a view they could no longer navigate back to.
    const view = document.getElementById('cp-view-getstarted');
    if (!show && view && !view.classList.contains('hidden')) {
        switchCpTab('dashboard');
    }
};

// Onboarding is over once the stage says so, whatever the checklist looks like. Unknown
// counts as Onboarding: if the clients row can't be read, a genuinely new client must
// still get their checklist rather than being locked out of it.
function portalClientStage() {
    const want = normalize(currentActiveClient || '');
    const row = portalClientRows.find(c => normalize(c.name) === want)
             || globalClientsData.find(c => normalize(c.name) === want);
    return row?.current_stage || 'Onboarding';
}

// The Knowledge Base is the same videos as the onboarding sequence, but as a permanent
// library: no completion state, always available to rewatch. Replaces two hardcoded
// cards whose watch status lived in localStorage under the admin's selected client.
window.renderKnowledgeBase = function() {
    const grid = document.getElementById('kb-video-grid');
    if (!grid) return;

    const videos = activeOnboardingSteps(currentActiveClient).filter(s => s.step_type === 'video' && s.embed_url);
    if (!videos.length) {
        grid.innerHTML = '<p class="text-sm text-gray-500 italic md:col-span-2">No walkthrough videos yet.</p>';
        return;
    }

    grid.innerHTML = videos.map(s => {
        const player = isDirectVideo(s.embed_url)
            ? `<video controls playsinline onloadedmetadata="this.playbackRate = OB_VIDEO_RATE" class="w-full h-full outline-none"><source src="${escapeAttr(stripSlashEscapes(s.embed_url))}"></video>`
            : `<iframe src="${escapeAttr(stripSlashEscapes(s.embed_url))}" class="w-full h-full" frameborder="0" allowfullscreen></iframe>`;

        const done = !!onboardingProgressFor(currentActiveClient, s.id)?.completed_at;

        return `<div class="glass p-6 flex flex-col">
            <div class="flex items-start justify-between gap-3 mb-4">
                <h4 class="font-bold text-white">${escapeAttr(stripSlashEscapes(s.title))}</h4>
                ${done ? '<span class="text-[10px] uppercase tracking-widest text-emerald-400 whitespace-nowrap"><i class="fa-solid fa-check mr-1"></i>Watched</span>' : ''}
            </div>
            <div class="w-full aspect-video bg-black/40 rounded-lg mb-3 border border-white/10 overflow-hidden">${player}</div>
            ${s.description ? `<p class="text-xs text-gray-400 mt-auto">${escapeAttr(stripSlashEscapes(s.description))}</p>` : ''}
        </div>`;
    }).join('');
};

// ---- Weekly check-in (client portal) ----
// Replaces the SMS reply system as the client's way in. Those rows are parsed out of a
// text and can be ambiguous, which is what parse_confidence and raw_reply exist for;
// anything typed here is exact, so it never lands in the review queue.

// Monday of the week containing `d`, matching the week_start the existing rows use.
function weekStartMonday(d = new Date()) {
    const x = new Date(d);
    // getDay() is 0 for Sunday, which belongs to the week that began six days earlier
    const shift = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - shift);
    return getLocalYYYYMMDD(x);
}

// The week being reported is the one that has finished, not the one underway — Monday
// morning you're asked how last week went. Filing it under the current Monday would
// label a completed week with dates that hadn't happened yet.
function reportingWeekStart() {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return weekStartMonday(d);
}

// "6 Jan – 12 Jan 2026". Shown wherever the client is asked for numbers, so there's no
// guessing which seven days they're totting up.
function weekRangeLabel(weekStart) {
    if (!weekStart) return '';
    const s = new Date(weekStart + 'T12:00:00');
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    const day = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `${day(s)} – ${day(e)} ${e.getFullYear()}`;
}

// One entry per person per week, keyed on who submitted it. A client with three sales
// people gets three rows, exactly as the SMS replies did, and the weekly totals sum
// them — matching on client and week alone would have each person overwrite the last.
function portalCheckinFor(client, week, who = clientEmail) {
    const key = String(who || '').trim().toLowerCase();
    return globalCheckinsData.find(c =>
        normalize(c.client_name || '') === normalize(client || '') &&
        c.week_start === week &&
        c.source === 'portal' &&
        String(c.contact_name || '').trim().toLowerCase() === key) || null;
}

function weeklyCheckinOutstanding() {
    // An admin viewing a client's portal must not file numbers as them
    if (currentUserRole === 'admin') return false;
    return !portalCheckinFor(currentActiveClient, reportingWeekStart());
}

const money0 = n => '$' + Math.round(Number(n) || 0).toLocaleString();

// Where a closed job came from. "google" is the SEO row: the SEO tab's "Jobs closed from
// Google" reads it, and only it. The keys are stored in weekly_checkins.closes_by_source, so
// don't rename them. See supabase/sql/weekly_checkins_closes_by_source.sql.
const CHECKIN_SOURCES = [
    { key: 'google',   label: 'Google search / your website', hint: 'Found you on Google, Google Maps or your website' },
    { key: 'ads',      label: 'Facebook / Instagram ads',     hint: '' },
    { key: 'referral', label: 'Referral or repeat customer',  hint: '' },
    { key: 'other',    label: 'Other / not sure',             hint: '' }
];

// Keeps the running total under the source rows in step as they're typed
window.updateCheckinSourceTotal = function(suffix) {
    const el = document.getElementById(`wc-src-total-${suffix}`);
    if (!el) return;
    let jobs = 0, rev = 0, anyJobs = false, anyRev = false;
    CHECKIN_SOURCES.forEach(s => {
        const j = document.getElementById(`wc-src-${s.key}-jobs-${suffix}`)?.value.trim();
        const r = document.getElementById(`wc-src-${s.key}-rev-${suffix}`)?.value.trim();
        if (j) { jobs += Number(j) || 0; anyJobs = true; }
        if (r) { rev += Number(r) || 0; anyRev = true; }
    });
    el.innerText = anyJobs || anyRev
        ? `Total: ${jobs} job${jobs === 1 ? '' : 's'} · ${money0(rev)}`
        : 'Leave blank if nothing closed. A zero week is fine, just enter 0.';
};

function weeklyCheckinFormHtml(suffix) {
    const existing = portalCheckinFor(currentActiveClient, reportingWeekStart());
    const v = f => existing?.[f] ?? '';

    // Prefill each source row from a saved breakdown. A check-in saved before sources existed
    // has only totals, so those go under "Other / not sure": they aren't lost, and they aren't
    // guessed into Google.
    const saved = existing?.closes_by_source && typeof existing.closes_by_source === 'object' ? existing.closes_by_source : null;
    const legacy = !saved && existing && (existing.closes_count != null || existing.revenue_total != null)
        ? { other: { closes: existing.closes_count, revenue: existing.revenue_total } } : null;
    const src = saved || legacy || {};
    const cellVal = (key, field) => src[key]?.[field] ?? '';

    const sourceRows = CHECKIN_SOURCES.map(s => `
                <div class="grid grid-cols-[minmax(0,1fr)_4.5rem_6.5rem] gap-2 items-center">
                    <div class="min-w-0">
                        <span class="text-sm text-white">${s.label}</span>
                        ${s.hint ? `<span class="block text-[11px] text-gray-500 leading-tight">${s.hint}</span>` : ''}
                    </div>
                    <input type="number" min="0" step="1" inputmode="numeric" id="wc-src-${s.key}-jobs-${suffix}" class="glass-input" placeholder="0"
                        aria-label="${s.label}: jobs closed" value="${escapeAttr(cellVal(s.key, 'closes'))}" oninput="updateCheckinSourceTotal('${suffix}')">
                    <input type="number" min="0" step="0.01" inputmode="decimal" id="wc-src-${s.key}-rev-${suffix}" class="glass-input" placeholder="$0"
                        aria-label="${s.label}: revenue" value="${escapeAttr(cellVal(s.key, 'revenue'))}" oninput="updateCheckinSourceTotal('${suffix}')">
                </div>`).join('');

    return `
        <div class="space-y-4">
            <div>
                <label class="modal-label">Estimates given</label>
                <input type="number" min="0" step="1" id="wc-estimates-${suffix}" class="glass-input" placeholder="0" value="${escapeAttr(v('estimates_count'))}">
            </div>
            <div>
                <label class="modal-label">Jobs closed and revenue, by where the customer came from</label>
                <div class="space-y-2 mt-1">
                    <div class="grid grid-cols-[minmax(0,1fr)_4.5rem_6.5rem] gap-2 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                        <span>Came from</span><span>Jobs</span><span>Revenue</span>
                    </div>
                    ${sourceRows}
                    <p id="wc-src-total-${suffix}" class="text-xs text-gray-400 pt-1"></p>
                </div>
            </div>
            <div>
                <label class="modal-label">Leads that found you through the ads but came in another way</label>
                <p class="text-[11px] text-gray-500 mb-2 -mt-1">Someone who called, walked in or used your website, but told you they'd seen the ads. We can't track these automatically, so this is the only way they get counted.</p>
                <input type="number" min="0" step="1" id="wc-indirect-${suffix}" class="glass-input" placeholder="0" value="${escapeAttr(v('indirect_leads'))}">
            </div>
            <p id="wc-error-${suffix}" class="text-sm text-red-400 hidden"></p>
            <button id="wc-submit-${suffix}" onclick="submitWeeklyCheckin('${suffix}')" class="w-full bg-yellow-500 hover:bg-yellow-400 text-slate-900 font-bold py-3 rounded-lg transition">
                ${existing ? 'Update this week' : 'Submit'}
            </button>
        </div>`;
}

// Read-only by construction: the client's list is built from its own markup with no
// draft, edit, delete or generate action anywhere in it.
//
// Reports stay locked until the week's numbers are in. That's the trade being offered —
// tell us how the week went and the report is yours — so the lock has to bite on the
// whole list, not just the newest one, or there's nothing in it for them.
window.renderCpReports = function() {
    const locked = document.getElementById('cp-reports-locked');
    const list = document.getElementById('cp-reports-list');
    if (!locked || !list) return;

    const outstanding = weeklyCheckinOutstanding();
    locked.classList.toggle('hidden', !outstanding);
    list.classList.toggle('hidden', outstanding);

    const msg = document.getElementById('cp-reports-locked-msg');
    if (msg) msg.innerText = `Send us your numbers for ${weekRangeLabel(reportingWeekStart())} and your reports unlock straight away.`;

    if (outstanding) return;

    const mine = portalReports
        .filter(r => normalize(r.client_name || '') === normalize(currentActiveClient || ''))
        .filter(r => r.html_body || r.report_body);

    if (!mine.length) {
        list.innerHTML = '<p class="text-sm text-gray-500 italic px-2">No reports yet — your first one will appear here.</p>';
        return;
    }

    list.innerHTML = mine.map(r => {
        const date = r.created_at
            ? new Date(r.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
            : '';
        const snippet = String(r.report_body || '').replace(/\s+/g, ' ').slice(0, 130);

        return `<div class="glass px-5 py-4 flex items-center justify-between gap-4">
            <div class="min-w-0">
                <p class="text-sm font-bold text-white">${escapeAttr(date)}</p>
                ${snippet ? `<p class="text-xs text-gray-400 mt-1 truncate">${escapeAttr(stripSlashEscapes(snippet))}</p>` : ''}
            </div>
            <button onclick="openCpReport('${escapeAttr(r.id)}')" class="shrink-0 text-sm bg-white/5 hover:bg-white/10 border border-white/10 text-gray-200 font-bold py-2 px-4 rounded-lg transition">
                <i class="fa-solid fa-eye mr-1"></i> View
            </button>
        </div>`;
    }).join('');
};

window.openCpReport = function(id) {
    const r = portalReports.find(x => String(x.id) === String(id));
    if (!r) return;

    const frame = document.getElementById('cp-report-viewer-frame');
    const title = document.getElementById('cp-report-viewer-title');
    const modal = document.getElementById('cp-report-viewer');
    if (!frame || !modal) return;

    if (title) {
        title.innerText = r.created_at
            ? `Report — ${new Date(r.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
            : 'Report';
    }

    // The iframe is sandboxed with no allow- flags, so the report renders but can't run
    // scripts or navigate the portal
    frame.srcdoc = r.html_body || `<pre style="font-family:system-ui;padding:2rem;white-space:pre-wrap">${escapeAttr(r.report_body || '')}</pre>`;
    modal.style.display = 'flex';
};

window.renderWeeklyCheckin = function() {
    const week = reportingWeekStart();
    const existing = portalCheckinFor(currentActiveClient, week);

    const mount = document.getElementById('cp-checkin-form-mount');
    if (mount) { mount.innerHTML = weeklyCheckinFormHtml('tab'); updateCheckinSourceTotal('tab'); }

    const head = document.getElementById('cp-checkin-heading');
    if (head) head.innerText = `Numbers for ${weekRangeLabel(week)}`;

    const sub = document.getElementById('cp-checkin-subhead');
    if (sub) {
        sub.innerText = existing
            ? "You've already sent your numbers for this week — change them below if anything's moved."
            : 'Takes about a minute, and only covers your own numbers. These build your revenue reporting and the network leaderboard.';
    }

    // A dot on the tab so a dismissed popup doesn't mean the week gets forgotten
    const dot = document.getElementById('cp-checkin-dot');
    if (dot) dot.classList.toggle('hidden', !weeklyCheckinOutstanding());

    const history = document.getElementById('cp-checkin-history');
    if (!history) return;

    const weeks = checkinsByWeek(currentActiveClient);
    if (!weeks.length) {
        history.innerHTML = '<p class="text-sm text-gray-500 italic px-2">Nothing yet — this week will be the first.</p>';
        return;
    }

    const cell = (reported, value) => reported
        ? `<span class="font-bold text-white">${value}</span>`
        : '<span class="text-gray-600">&mdash;</span>';

    const num = v => v !== null && v !== undefined;

    history.innerHTML = weeks.map(w => {
        const indirect = w.contributors.reduce((n, c) => n + (parseInt(c.indirect_leads) || 0), 0);
        const anyIndirect = w.contributors.some(c => num(c.indirect_leads));

        // Who reported what, so a week that came in low is obviously one person short
        // rather than a bad week. Only worth showing once more than one person replied.
        const breakdown = w.contributors.length < 2 ? '' : `
            <div class="w-full border-t border-white/5 mt-2 pt-2 space-y-1">
                ${w.contributors.map(c => `
                    <div class="flex flex-wrap justify-between gap-x-4 text-[11px] text-gray-500">
                        <span>${escapeAttr(stripSlashEscapes(c.contact_name || c.contact_phone || 'Unknown'))}${c.source === 'portal' ? '' : ' <span class="opacity-60">(text)</span>'}</span>
                        <span>
                            ${num(c.estimates_count) ? c.estimates_count + ' est' : ''}
                            ${num(c.closes_count) ? ' &middot; ' + c.closes_count + ' closed' : ''}
                            ${num(c.revenue_total) ? ' &middot; ' + money0(c.revenue_total) : ''}
                            ${num(c.indirect_leads) ? ' &middot; ' + c.indirect_leads + ' ad-attributed' : ''}
                        </span>
                    </div>`).join('')}
            </div>`;

        return `<div class="glass px-4 py-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm">
            <span class="text-gray-400 whitespace-nowrap">${weekRangeLabel(w.week_start)}</span>
            <div class="flex flex-wrap gap-x-6 gap-y-1">
                <span class="text-gray-500">Estimates ${cell(w.reportedEstimates, w.estimates_count)}</span>
                <span class="text-gray-500">Closed ${cell(w.reportedCloses, w.closes_count)}</span>
                <span class="text-gray-500">Revenue ${cell(w.reportedRevenue, money0(w.revenue_total))}</span>
                ${w.reportedSources ? `<span class="text-gray-500">From Google ${cell(true, `${w.google_closes} · ${money0(w.google_revenue)}`)}</span>` : ''}
                <span class="text-gray-500">Ad-attributed ${cell(anyIndirect, indirect)}</span>
            </div>
            ${breakdown}
        </div>`;
    }).join('');
};

window.submitWeeklyCheckin = async function(suffix) {
    if (previewBlocksWrite('submitting a check-in')) return;
    const btn = document.getElementById(`wc-submit-${suffix}`);
    const err = document.getElementById(`wc-error-${suffix}`);
    const num = id => {
        const raw = document.getElementById(`wc-${id}-${suffix}`).value.trim();
        return raw === '' ? null : Number(raw);
    };

    // Closes and revenue are entered per source. The totals every other view reads are those
    // rows summed, and each total stays null when no row has a value, so "not reported" still
    // differs from a reported 0.
    const bySource = {};
    let closesTotal = null, revenueTotal = null;
    CHECKIN_SOURCES.forEach(s => {
        const closes = num(`src-${s.key}-jobs`), revenue = num(`src-${s.key}-rev`);
        if (closes === null && revenue === null) return;
        bySource[s.key] = { closes, revenue };
        if (closes !== null) closesTotal = (closesTotal || 0) + closes;
        if (revenue !== null) revenueTotal = (revenueTotal || 0) + revenue;
    });

    const numbers = {
        estimates_count: num('estimates'),
        closes_count: closesTotal,
        revenue_total: revenueTotal,
        indirect_leads: num('indirect')
    };
    const row = { ...numbers, closes_by_source: Object.keys(bySource).length ? bySource : null };
    const entered = [
        numbers.estimates_count, numbers.indirect_leads,
        ...Object.values(bySource).flatMap(x => [x.closes, x.revenue])
    ].filter(v => v !== null);

    const show = msg => { if (err) { err.innerText = msg; err.classList.remove('hidden'); } };
    if (err) err.classList.add('hidden');

    if (!entered.length) {
        show('Put a number in at least one box — a zero week is fine, just enter 0.');
        return;
    }
    if (entered.some(v => !isFinite(v) || v < 0)) {
        show('Those need to be positive numbers.');
        return;
    }

    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...';
    btn.disabled = true;

    try {
        const week = reportingWeekStart();
        const existing = portalCheckinFor(currentActiveClient, week);

        // If closes_by_source isn't in the database yet (weekly_checkins_closes_by_source.sql not
        // run), save the totals without the split rather than losing the client's whole check-in.
        const missingColumn = e => /closes_by_source/.test(`${e?.message || ''} ${e?.details || ''}`);
        const save = async (values) => {
            if (existing) {
                // Matched on the columns that identify it rather than an id, so this doesn't
                // care whether the table has one. contact_name is part of that identity now:
                // without it, one person's edit would overwrite a colleague's entry.
                const { error } = await supabaseClient.from('weekly_checkins').update(values)
                    .eq('client_name', existing.client_name)
                    .eq('week_start', week)
                    .eq('source', 'portal')
                    .eq('contact_name', existing.contact_name);
                if (error) return error;
                Object.assign(existing, values);
                return null;
            }
            const payload = {
                ...values,
                client_name: currentActiveClient,
                week_start: week,
                source: 'portal',
                contact_name: clientEmail || null,
                // Typed by the client rather than parsed out of a text, so it's exact
                parse_confidence: 'high'
            };
            const { data, error } = await supabaseClient.from('weekly_checkins').insert([payload]).select();
            if (error) return error;
            if (data?.length) globalCheckinsData.push(...data);
            return null;
        };

        let saveErr = await save(row);
        if (saveErr && missingColumn(saveErr)) {
            console.warn('weekly_checkins.closes_by_source is missing; saved totals without the source split.', saveErr);
            saveErr = await save(numbers);
        }
        if (saveErr) throw saveErr;

        closeWeeklyCheckinModal();
        renderWeeklyCheckin();
        // Submitting is what unlocks the reports, so repaint them straight away
        renderCpReports();
    } catch (e) {
        show("Couldn't save that — please try again, or text us the numbers.");
        console.error('Weekly check-in save failed:', e);
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
    }
};

function closeWeeklyCheckinModal() {
    const m = document.getElementById('weekly-checkin-modal');
    if (m) m.style.display = 'none';
}

// Dismissal is remembered per client and per week, so closing it doesn't mean being
// asked again on the next page load — the tab keeps its dot either way.
window.dismissWeeklyCheckin = function() {
    try {
        localStorage.setItem(`midas_wc_dismissed_${normalize(currentActiveClient)}`, reportingWeekStart());
    } catch (e) { /* private mode, no great loss */ }
    closeWeeklyCheckinModal();
};

window.maybeShowWeeklyCheckin = function() {
    if (!weeklyCheckinOutstanding()) return;

    let dismissed = null;
    try {
        dismissed = localStorage.getItem(`midas_wc_dismissed_${normalize(currentActiveClient)}`);
    } catch (e) { /* ignore */ }
    if (dismissed === reportingWeekStart()) return;

    const range = document.getElementById('cp-checkin-modal-range');
    if (range) range.innerText = weekRangeLabel(reportingWeekStart());

    const mount = document.getElementById('cp-checkin-modal-mount');
    if (mount) { mount.innerHTML = weeklyCheckinFormHtml('modal'); updateCheckinSourceTotal('modal'); }

    const m = document.getElementById('weekly-checkin-modal');
    if (m) m.style.display = 'flex';
};

        function portalSwitchClient(accountName) {
            currentActiveClient = accountName; document.getElementById('client-name-display').innerText = accountName.split(' ')[0];
            const normTarget = normalize(accountName);
            filteredReportData = reportsForClient(accountName, allRawReports);
            clientLeadsData = globalClientLeadsData.filter(l => normalize(l.client_name) === normTarget).map(l => ({ id: l.id, name: l.lead_name, stage: l.stage || 'New Lead', email: l.lead_email || '', phone: l.lead_phone || '' }));
            // The cached work summary is per-client. Without this an admin switching
            // between clients would keep showing whichever client's summary loaded first.
            cachedWorkSummary = null;
            workSummaryFetchStarted = false;
            filterPortalData();
            if(!document.getElementById('cp-view-pipeline').classList.contains('hidden')) renderCpPipeline();
            if(!document.getElementById('cp-view-creatives').classList.contains('hidden')) renderClientCreatives();
            // Per-client state for Organic Search: hide the tab for a client without SEO, and forget
            // the other client's "show all searches" choice
            cpSeoShowAllKeywords = false;
            updateSeoTabVisibility();
            if(!document.getElementById('cp-view-seo').classList.contains('hidden')) renderCpSeo();
        }

        function getLocalYYYYMMDD(dateObj) { return dateObj.getFullYear() + '-' + String(dateObj.getMonth() + 1).padStart(2, '0') + '-' + String(dateObj.getDate()).padStart(2, '0'); }

        // Every date-range calculation in the app, in one place so the admin pages, the
        // portal and the SEO views can't drift apart.
        //
        // "Last 7/30 days" ends YESTERDAY, not today. The morning pull only ever has data
        // through yesterday, so including today added an always-empty day and put the
        // totals one day out of step with Ads Manager, which also excludes the current
        // partial day.
        function dateRangeFor(rangeKey, cStart, cEnd) {
            const now = new Date();
            let s = new Date(now);
            let e = new Date(now);

            if (rangeKey === 'today') {
                // s and e both today
            } else if (rangeKey === 'yesterday') {
                s.setDate(s.getDate() - 1);
                e.setDate(e.getDate() - 1);
            } else if (rangeKey === 'last7') {
                e.setDate(e.getDate() - 1);
                s = new Date(e); s.setDate(s.getDate() - 6);
            } else if (rangeKey === 'last30') {
                e.setDate(e.getDate() - 1);
                s = new Date(e); s.setDate(s.getDate() - 29);
            } else if ((rangeKey === 'custom' || rangeKey === 'customRange') && cStart && cEnd) {
                s = new Date(cStart + 'T00:00:00');
                e = new Date(cEnd + 'T23:59:59');
            } else {
                s = new Date(2000, 0, 1);   // max / everything
            }

            s.setHours(0, 0, 0, 0);
            e.setHours(23, 59, 59, 999);
            return { s, e };
        }

        // The portal's currently selected window. Shared so the leaderboard and the
        // network ticker report the same period as the stat tiles — they used to sum all
        // of history while being labelled "this period".
        function getPortalRange() {
            return dateRangeFor(selectedDateRange, customStart, customEnd);
        }

        // Is this report row inside the portal's selected window?
        function reportInRange(r, s, e) {
            if (!r.date) return false;
            const rd = new Date(r.date.split('T')[0] + 'T12:00:00');
            return rd >= s && rd <= e;
        }

        function filterPortalData() {
	    if(!document.getElementById('cp-view-knowledge').classList.contains('hidden')) switchCpTab('knowledge');
            const { s, e } = getPortalRange();

            let spend = 0, leads = 0; const dailySummary = {};

            filteredReportData.forEach(r => {
                if (!r.date) return; const rd = new Date(r.date.split('T')[0] + 'T12:00:00');
                if (rd >= s && rd <= e) { spend += parseFloat(r.spend || 0); leads += parseInt(r.leads || 0); const rdStr = rd.toISOString().split('T')[0]; dailySummary[rdStr] = (dailySummary[rdStr] || 0) + parseInt(r.leads || 0); }
            });

            // Outcome figures come entirely from the weekly SMS check-ins. The old portal
            // forms that wrote client_jobs/client_estimates have been removed — one
            // reporting channel instead of two competing ones.
            const rangeCheckins = checkinsForClient(currentActiveClient).filter(c => {
                if (!c.week_start) return false;
                const wd = new Date(c.week_start + 'T12:00:00');
                return wd >= s && wd <= e;
            });
            const revenue   = sumCheckins(rangeCheckins, 'revenue_total');
            const estimates = sumCheckins(rangeCheckins, 'estimates_count');
            const deals     = sumCheckins(rangeCheckins, 'closes_count');

            const estCountEl = document.getElementById('stat-est-count');
            if (estCountEl) estCountEl.innerText = estimates.toLocaleString();
            const dealsEl = document.getElementById('stat-deals-count');
            if (dealsEl) dealsEl.innerText = deals.toLocaleString();

            finalStats = { spend, leads, revenue, estimates };
            document.getElementById('stat-spend').innerText = '$' + spend.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            document.getElementById('stat-leads').innerText = leads.toLocaleString();
            document.getElementById('stat-revenue').innerText = '$' + revenue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            document.getElementById('stat-roi').innerText = (spend > 0 ? (revenue / spend).toFixed(1) : "0.0") + 'x';
            document.getElementById('stat-cpl').innerText = (leads > 0 ? '$' + (spend / leads).toFixed(0) : '$0');

            renderPortalHistory(); renderPortalTasks(); renderPortalCharts(dailySummary);
            if(!document.getElementById('cp-view-seo').classList.contains('hidden')) renderCpSeo();
            // The leaderboard is period-scoped too, so it has to redraw when the range
            // changes — previously only switchCpTab drew it, leaving it stale.
            if(!document.getElementById('cp-view-leaderboard').classList.contains('hidden')) renderAnonymizedLeaderboard();
            // Tasks is period-scoped now too: the default range shows the cached daily
            // narrative, anything else swaps to a deterministic recap of that window —
            // see renderCpTasks(). Only worth redrawing while the tab is actually open.
            if(!document.getElementById('cp-view-tasks').classList.contains('hidden')) renderCpTasks();
updateAgencyPowerTicker();
        }

        // The client's own weekly text replies, shown back to them so they can see what
        // was recorded. Replaces the old manually-logged job history.
        function renderPortalHistory() {
            const body = document.getElementById('job-history-body');
            if (!body) return;
            body.innerHTML = '';

            // Combined per week — a client with several reps reporting should see one
            // line per week, not one per person
            const weeks = checkinsByWeek(currentActiveClient).slice(0, 10);
            if (!weeks.length) {
                body.innerHTML = '<tr><td colspan="4" class="text-center py-4 opacity-50">No check-ins yet &mdash; reply to the weekly text and it will appear here.</td></tr>';
                return;
            }

            const money = v => (v === null || v === undefined || v === '') ? '&mdash;' : '$' + Number(v).toLocaleString();
            const num   = v => (v === null || v === undefined || v === '') ? '&mdash;' : v;

            weeks.forEach(w => {
                const multi = w.contributors.length > 1;

                // Week total
                const row = document.createElement('tr');
                row.className = 'border-t border-white/5';
                row.innerHTML = `<td class="text-xs font-bold">${w.week_start}${multi ? `<span class="text-[10px] opacity-50 font-normal ml-2">${w.contributors.length} people</span>` : ''}</td>`
                    + `<td class="font-bold">${w.reportedEstimates ? w.estimates_count : '&mdash;'}</td>`
                    + `<td class="font-bold text-green-400">${w.reportedCloses ? w.closes_count : '&mdash;'}</td>`
                    + `<td class="text-right text-blue-400 font-bold">${w.reportedRevenue ? '$' + w.revenue_total.toLocaleString() : '&mdash;'}</td>`;
                body.appendChild(row);

                // Who reported what. Shown for a single reporter too — the client should be
                // able to see their own name against the numbers, not just a bare week.
                w.contributors.forEach(c => {
                    const sub = document.createElement('tr');
                    sub.className = 'text-[11px] opacity-60';
                    sub.innerHTML = `<td class="pl-4 py-1">${escapeHTML(c.contact_name || c.contact_phone || 'Unknown')}</td>`
                        + `<td class="py-1">${num(c.estimates_count)}</td>`
                        + `<td class="py-1">${num(c.closes_count)}</td>`
                        + `<td class="py-1 text-right">${money(c.revenue_total)}</td>`;
                    body.appendChild(sub);
                });
            });
        }
        function renderPortalTasks() {
            const container = document.getElementById('portal-tasks-container'); container.innerHTML = '';
            const clientTasks = globalTasksData.filter(t => normalize(t.client) === normalize(currentActiveClient) && t.status !== 'Complete' && t.client_visible !== false);
            if (clientTasks.length === 0) { container.innerHTML = '<div class="glass p-6 text-center text-gray-500 italic md:col-span-2">No active tasks at the moment.</div>'; return; }
            clientTasks.sort((a,b) => b.score - a.score).forEach(t => {
                let badgeColor = t.status === 'In Progress' ? 'text-blue-400 bg-blue-500/10 border-blue-500/30' : t.status === 'Blocked' ? 'text-red-400 bg-red-500/10 border-red-500/30' : 'text-gray-400 bg-black/40 border-white/5';
                container.innerHTML += `<div class="glass p-5 border-l-4 border-l-blue-500 flex justify-between items-center gap-4"><div><span class="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border ${badgeColor}">${t.status}</span><h4 class="font-bold text-white mt-2">${t.title}</h4></div><div class="text-right shrink-0"><span class="text-[10px] text-gray-500 block uppercase">Expected</span><span class="text-sm font-bold ${t.due ? 'text-white' : 'text-gray-600'}">${t.due || 'TBD'}</span></div></div>`;
            });
        }

        function renderCpPipeline() {
            const container = document.getElementById('cp-pipeline-container'); container.innerHTML = '';
            const baseStages = clientPipelineStages.filter(s => s !== 'Won' && s !== 'Lost');
            const finalStages = [...baseStages, 'Won', 'Lost'];

            finalStages.forEach(stage => {
                const count = clientLeadsData.filter(l => l.stage === stage).length;
                let colorClass = 'text-blue-400'; let bgClass = 'bg-white/5 border border-white/5'; let headBg = 'border-b border-white/5'; let icon = 'fa-solid fa-list';
                if (stage === 'Won') { colorClass = 'text-green-400'; bgClass = 'bg-green-900/10 border border-green-500/20'; headBg = 'border-b border-green-500/20'; icon = 'fa-solid fa-sack-dollar'; }
                if (stage === 'Lost') { colorClass = 'text-red-400'; bgClass = 'bg-red-900/10 border border-red-500/20'; headBg = 'border-b border-red-500/20'; icon = 'fa-solid fa-skull-crossbones'; }
                if (stage.includes('Appt')) { colorClass = 'text-purple-400'; icon = 'fa-solid fa-calendar-check'; }

                container.innerHTML += `
                    <div class="w-72 flex flex-col rounded-xl shrink-0 ${bgClass}">
                        <div class="p-3 flex justify-between items-center ${headBg}"><h3 class="font-bold ${colorClass} text-xs"><i class="${icon} mr-2"></i>${stage}</h3><span class="text-gray-500 text-[10px] bg-black/40 px-2 py-0.5 rounded">${count}</span></div>
                        <div class="p-2 flex-1 min-h-[150px] space-y-2 cp-kanban-col" data-stage="${stage}">
                            ${clientLeadsData.filter(l => l.stage === stage).map(l => `
                                <div class="glass cp-kanban-card p-3 border border-white/10 hover:border-blue-500/50 transition cursor-pointer" data-id="${l.id}" onclick="openCpLeadDrawer('${l.id}')">
                                    <h4 class="font-bold text-white text-sm mb-1">${l.name}</h4>
                                    <div class="flex justify-between items-center mt-2"><span class="text-[10px] text-gray-400 truncate max-w-[150px]">${l.phone || l.email || 'No Contact Info'}</span></div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            });

            if(window.cpSortables) window.cpSortables.forEach(s=>s.destroy()); window.cpSortables = [];
            document.querySelectorAll('.cp-kanban-col').forEach(col => {
                window.cpSortables.push(new Sortable(col, { group: 'cp-leads', animation: 150, ghostClass: 'sortable-ghost',
                    onEnd: async (e) => {
                        const id = e.item.getAttribute('data-id'); const newStage = e.to.getAttribute('data-stage'); const lead = clientLeadsData.find(l => l.id == id);
                        if (lead && lead.stage !== newStage) {
                            lead.stage = newStage; renderCpPipeline();
                            try { await supabaseClient.from('client_leads').update({stage: newStage}).eq('id', id); } catch(err) { console.warn("Could not save to db"); }
                        }
                    }
                }));
            });
        }

        function renderCpSettings() {
            const list = document.getElementById('cp-stages-list'); list.innerHTML = '';
            const baseStages = clientPipelineStages.filter(s => s !== 'Won' && s !== 'Lost');
            baseStages.forEach(stage => { list.innerHTML += `<div class="glass p-3 flex justify-between items-center"><span class="font-medium text-white">${stage}</span><button onclick="deleteCpStage('${escapeHTML(stage)}')" class="text-red-400 hover:text-red-300 transition w-8 h-8 rounded bg-black/40 hover:bg-red-500/20"><i class="fa-solid fa-trash"></i></button></div>`; });
            list.innerHTML += `<div class="glass p-3 flex justify-between items-center opacity-50 bg-green-900/10"><span class="font-medium text-green-400">Won</span><i class="fa-solid fa-lock text-gray-500 px-2"></i></div><div class="glass p-3 flex justify-between items-center opacity-50 bg-red-900/10"><span class="font-medium text-red-400">Lost</span><i class="fa-solid fa-lock text-gray-500 px-2"></i></div>`;
        }

        function addCpStage() {
            const input = document.getElementById('cp-new-stage-name'); const name = input.value.trim();
            if(!name) return; if(clientPipelineStages.includes(name)) return alert("Stage already exists.");
            const baseStages = clientPipelineStages.filter(s => s !== 'Won' && s !== 'Lost'); baseStages.push(name); clientPipelineStages = [...baseStages, 'Won', 'Lost'];
            input.value = ''; renderCpSettings(); alert("Pipeline stages updated.");
        }

        function deleteCpStage(stageName) {
            if(confirm(`Delete stage "${stageName}"? Leads in this stage will be moved to the first column.`)) {
                clientPipelineStages = clientPipelineStages.filter(s => s !== stageName); const baseStages = clientPipelineStages.filter(s => s !== 'Won' && s !== 'Lost');
                clientLeadsData.forEach(async l => { if(l.stage === stageName) { l.stage = baseStages[0] || 'Won'; try { await supabaseClient.from('client_leads').update({stage: l.stage}).eq('id', l.id); } catch(e){} } });
                renderCpSettings();
            }
        }

        function openCpLeadDrawer(id) {
            const f = document.getElementById('cp-lead-drawer'); f.reset(); const stageDropdown = document.getElementById('cp-ld-stage');
            const finalStages = [...clientPipelineStages.filter(s => s!=='Won'&&s!=='Lost'), 'Won', 'Lost']; stageDropdown.innerHTML = finalStages.map(s => `<option value="${escapeAttr(s)}">${escapeAttr(s)}</option>`).join('');
            if (id === 'new') { activeCpLeadId = null; document.getElementById('cp-ld-stage').value = finalStages[0]; document.getElementById('cp-ld-delete-btn').classList.add('hidden'); } 
            else { const ld = clientLeadsData.find(x => x.id == id); if(!ld) return; activeCpLeadId = ld.id; document.getElementById('cp-ld-name').value = ld.name; document.getElementById('cp-ld-stage').value = ld.stage; document.getElementById('cp-ld-email').value = ld.email || ''; document.getElementById('cp-ld-phone').value = ld.phone || ''; document.getElementById('cp-ld-delete-btn').classList.remove('hidden'); }
            document.getElementById('drawer-overlay').classList.add('show'); f.classList.add('open');
        }

        async function saveCpLead(e) {
            e.preventDefault(); const payload = { lead_name: document.getElementById('cp-ld-name').value, stage: document.getElementById('cp-ld-stage').value, lead_email: document.getElementById('cp-ld-email').value, lead_phone: document.getElementById('cp-ld-phone').value, client_name: currentActiveClient };
            let isNewWon = false; const btn = document.getElementById('cp-ld-save-btn'); btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            try {
                if (activeCpLeadId) { const idx = clientLeadsData.findIndex(x => x.id == activeCpLeadId); const oldStage = clientLeadsData[idx].stage; clientLeadsData[idx] = { ...clientLeadsData[idx], name: payload.lead_name, stage: payload.stage, email: payload.lead_email, phone: payload.lead_phone }; if(oldStage !== 'Won' && payload.stage === 'Won') isNewWon = true; await supabaseClient.from('client_leads').update(payload).eq('id', activeCpLeadId); } 
                else { const { data, error } = await supabaseClient.from('client_leads').insert([payload]).select(); if(error) throw error; const newId = data ? data[0].id : 'c' + Date.now(); clientLeadsData.push({ id: newId, name: payload.lead_name, stage: payload.stage, email: payload.lead_email, phone: payload.lead_phone }); if(payload.stage === 'Won') isNewWon = true; }
            } catch (err) { console.error("Error saving lead:", err); if(!activeCpLeadId) clientLeadsData.push({ id: 'c' + Date.now(), name: payload.lead_name, stage: payload.stage, email: payload.lead_email, phone: payload.lead_phone }); }
            btn.innerHTML = 'Save Lead'; closeAllDrawers(); renderCpPipeline();
        }

        async function deleteCpLead() { if(!activeCpLeadId) return; if(confirm("Delete this lead permanently?")) { try { await supabaseClient.from('client_leads').delete().eq('id', activeCpLeadId); } catch(e) { console.warn("Failed to delete from DB"); } clientLeadsData = clientLeadsData.filter(l => l.id != activeCpLeadId); closeAllDrawers(); renderCpPipeline(); } }

        window.openClientRequestModal = function() { 
    console.log("Modal opened!"); 
    const modal = document.getElementById('client-request-modal');
    
    if (!modal) {
        return alert("CRITICAL ERROR: The HTML for the modal has been deleted from your file!");
    }

    // 1. Rip the modal out of its current container and attach it to the very top of the webpage
    document.body.appendChild(modal);
    
    // 2. Force it to be visible with maximum priority CSS
    modal.style.cssText = "display: flex !important; position: fixed !important; inset: 0px !important; z-index: 999999 !important; background: rgba(2, 6, 23, 0.85) !important; backdrop-filter: blur(8px) !important; align-items: center !important; justify-content: center !important;";
};

window.closeClientRequestModal = function() { 
    document.getElementById('client-request-modal').style.display = 'none'; 
};

window.submitClientRequest = async function() {
    try {
        console.log("Submit button clicked!"); 
        
        // 1. Grab elements securely
        const btn = document.getElementById('submit-request-btn');
        const typeEl = document.getElementById('input-request-type');
        const subjectEl = document.getElementById('input-request-subject');
        const detailsEl = document.getElementById('input-request-details');

        // 2. Failsafe check
        if (!btn || !typeEl || !subjectEl || !detailsEl) {
            console.error("DOM Error: One or more modal elements are missing.");
            return alert("System Error: Form elements not found.");
        }

        const type = typeEl.value; 
        const subject = subjectEl.value.trim(); 
        const details = detailsEl.value.trim();

        if (!subject) return alert("Please enter a subject line.");

        // 3. Trigger Loading State
        btn.disabled = true; 
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';

        // 4. Build Payload
        const payload = { 
            title: `[${type}] ${subject}`, 
            client: typeof currentActiveClient !== 'undefined' ? currentActiveClient : 'Unknown', 
            type: 'Client Request', 
            status: 'Not Started', 
            p: 5, u: 5, e: 3, score: 100, 
            notes: `Client Request Details:\n${details}`, 
            assignee: 'Unassigned', 
            updated_at: new Date().toISOString() 
        };

        // 5. Submit to Supabase
        const { data, error } = await supabaseClient.from('tasks').insert([payload]).select();
        if (error) throw error;
        
        // 6. Success Reset
        alert("Request submitted successfully! Our team will be in touch shortly."); 
        window.closeClientRequestModal(); 
        
        subjectEl.value = '';
        detailsEl.value = '';
        
        if (data && data.length > 0) {
            globalTasksData.push(data[0]);
            // renderPortalTasks() only redraws the Dashboard's small widget. The card is
            // now duplicated onto the Tasks tab too, whose own three lists are a
            // different function — refresh both, however got used, so a request sent
            // from either place shows up immediately rather than after a reload.
            if (typeof renderPortalTasks === 'function') renderPortalTasks();
            if (typeof renderCpTasks === 'function') renderCpTasks();
        }

    } catch(err) { 
        console.error("Submit Request Error:", err);
        alert("Error submitting request. Please check the console or contact support."); 
    } finally { 
        // 7. Reset Button State
        const resetBtn = document.getElementById('submit-request-btn');
        if (resetBtn) {
            resetBtn.disabled = false; 
            resetBtn.innerText = "Submit";
        }
    }
};


        function renderPortalCharts(dailyLeads) {
            const isLight = document.getElementById('theme-wrapper').classList.contains('light-mode'); Chart.defaults.color = isLight ? '#64748b' : 'rgba(255, 255, 255, 0.4)';
            if (leadChart) leadChart.destroy(); if (roiChart) roiChart.destroy();
            const labels = Object.keys(dailyLeads).sort();
            leadChart = new Chart(document.getElementById('leadsChart'), { type: 'line', data: { labels: labels, datasets: [{ data: labels.map(l => dailyLeads[l]), borderColor: '#34d399', backgroundColor: 'rgba(52, 211, 153, 0.1)', fill: true, tension: 0.4 }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } } } });
            roiChart = new Chart(document.getElementById('roiChart'), { type: 'bar', data: { labels: ['Ad Spend', 'Revenue'], datasets: [{ data: [finalStats.spend, finalStats.revenue], backgroundColor: [isLight ? '#cbd5e1' : 'rgba(255,255,255,0.1)', '#fbbf24'], borderRadius: 8 }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } } } });
        }

        // triggerPortalAI() used to live here — a manual "Run Analysis" button that sent
        // spend/leads to GPT-4o for two sentences. Replaced by the cached, always-on work
        // summary below (ensureWorkSummaryLoaded / paintWorkSummaryBoxes), which narrates
        // what got *done* rather than restating numbers already on the KPI tiles above it.

        function selectPresetDate(v, l) { selectedDateRange = v; document.getElementById('selected-date-label').innerText = l; toggleDropdown('portal-date-menu'); filterPortalData(); }
        function applyCustomRange() { customStart = document.getElementById('start-date').value; customEnd = document.getElementById('end-date').value; if(customStart && customEnd) { selectedDateRange = 'custom'; document.getElementById('selected-date-label').innerText = `${customStart} to ${customEnd}`; toggleDropdown('portal-date-menu'); filterPortalData(); } }
        
        function openInviteModal() { document.getElementById('invite-modal').style.display = 'flex'; }
        function closeInviteModal() { document.getElementById('invite-modal').style.display = 'none'; }
        // Everything needed for one address to reach one client's portal. Three tables,
        // because each answers a different question: pre_approved_users is read when the
        // account is first created, user_client_access is what the portal reads every
        // load, and user_profiles carries the role. Missing any one of them lands them on
        // the pending screen with nothing explaining why.
        window.grantPortalAccess = async function(email, clientName) {
            const addr = String(email || '').trim().toLowerCase();
            if (!addr || !clientName) return;

            const { error: preErr } = await supabaseClient.from('pre_approved_users')
                .upsert({ email: addr, role: 'client', client_access: [clientName] }, { onConflict: 'email' });
            if (preErr) throw preErr;

            // user_client_access is keyed to user_profiles, so this only works once they
            // have actually signed up. Before that the invite above is the whole grant,
            // and the portal applies it on their first login — so a foreign key complaint
            // here is the expected path for a new client, not a failure.
            await supabaseClient.from('user_client_access')
                .delete().eq('user_email', addr).eq('client_name', clientName);
            const { error: accErr } = await supabaseClient.from('user_client_access')
                .insert([{ user_email: addr, client_name: clientName }]);
            if (accErr && accErr.code !== '23503') throw accErr;

            // Only promotes someone still waiting, so an admin or member given client
            // access isn't demoted by it
            const { error: roleErr } = await supabaseClient.from('user_profiles')
                .update({ role: 'client' }).eq('email', addr).eq('role', 'pending');
            if (roleErr) throw roleErr;
        };

        // client_email can hold several comma-separated addresses, and every one of them
        // is someone who should be able to sign in
        window.grantPortalAccessToAll = async function(emails, clientName) {
            const list = String(emails || '').split(/[,;]+/).map(e => e.trim()).filter(Boolean);
            for (const addr of list) await grantPortalAccess(addr, clientName);
            return list;
        };

        async function submitClientInvite() {
            const btn = document.getElementById('submit-invite-btn');
            const email = document.getElementById('input-invite-email').value.trim().toLowerCase();
            if (!email) return alert("Please enter an email address");

            // The admin dashboard tracks its selection separately from the portal, and this
            // button now appears on both
            const inviteTarget = (typeof cSelectedAccount !== 'undefined' && cSelectedAccount && cSelectedAccount !== 'ALL')
                ? cSelectedAccount
                : currentActiveClient;
            if (!inviteTarget) return alert("Select a client first.");

            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

            try {
                await grantPortalAccess(email, inviteTarget);
                alert(`${email} can now sign in and see ${inviteTarget}.`);
                closeInviteModal();
                document.getElementById('input-invite-email').value = '';
            } catch (err) {
                alert("Error: " + err.message);
            } finally {
                btn.disabled = false;
                btn.innerText = "Send Invite";
            }
        }

        // =========================================================================================
        //                               ADMIN DASHBOARD LOGIC
        // =========================================================================================

        async function fetchAllGlobalData(allowedClients) {
    let clientsQ = supabaseClient.from('clients').select('*');
    let healthQ = supabaseClient.from('client_health').select('*');
    let tasksQ = supabaseClient.from('tasks').select('*');
    let adsQ = supabaseClient.from('daily_reports').select('*');
    let crQ = supabaseClient.from('ad_approvals').select('*').order('created_at', { ascending: false });
    let seoQ = supabaseClient.from('seo_metrics').select('*');
    
    // 👇 1. ADD THIS NEW LINE FOR THE AUDITS QUERY 👇
    let auditsQ = supabaseClient.from('morning_audits').select('*').order('created_at', { ascending: false });

    // Weekly client-reported estimates/closes/revenue, arriving by SMS
    let checkinsQ = supabaseClient.from('weekly_checkins').select('*').order('week_start', { ascending: false });

    // Who gets texted for each client — several people for clients with sales teams
    let contactsQ = supabaseClient.from('client_contacts').select('*');

    // Per-stage checklists, used when a client moves into a stage
    let stageTplQ = supabaseClient.from('stage_templates').select('*').order('sort_order');

    // Client-facing onboarding sequence and who has completed what
    let obStepsQ = supabaseClient.from('onboarding_steps').select('*').order('sort_order');
    let obProgQ  = supabaseClient.from('client_onboarding_progress').select('*');

    // Add-on services and which ones each client has (service_onboarding.sql)
    let servicesQ = supabaseClient.from('services').select('*').order('sort_order');
    let clientServicesQ = supabaseClient.from('client_services').select('*');
    let answersQ = supabaseClient.from('onboarding_answers').select('*');

    if (allowedClients && currentUserRole !== 'admin') {
        clientsQ = clientsQ.in('name', allowedClients); healthQ = healthQ.in('client_name', allowedClients); tasksQ = tasksQ.in('client', allowedClients); crQ = crQ.in('client_name', allowedClients); seoQ = seoQ.in('client_name', allowedClients);
        checkinsQ = checkinsQ.in('client_name', allowedClients);
        contactsQ = contactsQ.in('client_name', allowedClients);
        clientServicesQ = clientServicesQ.in('client_name', allowedClients);
        answersQ = answersQ.in('client_name', allowedClients);
    }

    const results = await Promise.allSettled([ clientsQ, healthQ, tasksQ, adsQ, crQ, seoQ, auditsQ, checkinsQ, contactsQ, stageTplQ, obStepsQ, obProgQ, servicesQ, clientServicesQ, answersQ ]);

    let fClients = results[0].status === 'fulfilled' ? (results[0].value.data || []) : [];
    
    // --- AUTOMATED PAYMENT POLICE ---
    const todayStr = new Date().toISOString().split('T')[0];
    fClients = fClients.map(c => {
        // If they are marked paid, but the deadline has passed...
        if (c.payment_status === 'paid' && c.payment_deadline && c.payment_deadline < todayStr) {
            c.payment_status = 'overdue'; // Instantly change it locally
            // Silently update Supabase in the background so it stays accurate
            supabaseClient.from('clients').update({ payment_status: 'overdue' }).eq('id', c.id).then();
        }
        return c;
    });
    
    let fHealth = results[1].status === 'fulfilled' ? (results[1].value.data || []) : [];
    let fTasks = results[2].status === 'fulfilled' ? (results[2].value.data || []) : [];
    let fAds = results[3].status === 'fulfilled' ? (results[3].value.data || []) : [];
    globalCreativesData = results[4].status === 'fulfilled' ? (results[4].value.data || []) : [];
    globalSeoData = results[5].status === 'fulfilled' ? (results[5].value.data || []) : [];
    globalAuditsData = results[6].status === 'fulfilled' ? (results[6].value.data || []) : [];
    globalCheckinsData = results[7].status === 'fulfilled' ? (results[7].value.data || []) : [];
    globalContactsData = results[8].status === 'fulfilled' ? (results[8].value.data || []) : [];
    globalStageTemplates = results[9].status === 'fulfilled' ? (results[9].value.data || []) : [];
    globalOnboardingSteps = results[10].status === 'fulfilled' ? (results[10].value.data || []) : [];
    globalOnboardingProgress = results[11].status === 'fulfilled' ? (results[11].value.data || []) : [];
    globalServices = results[12].status === 'fulfilled' ? (results[12].value.data || []) : [];
    globalClientServices = results[13].status === 'fulfilled' ? (results[13].value.data || []) : [];
    globalOnboardingAnswers = results[14].status === 'fulfilled' ? (results[14].value.data || []) : [];

            if (allowedClients && currentUserRole !== 'admin') {
                const normAllowed = allowedClients.map(a => normalize(a));

                // globalClientsData is not populated until further down, so resolve the
                // permitted ad account ids straight off the freshly-fetched client rows.
                // Where ids exist on both sides this decides purely on id and ignores the
                // name fallback: as a permissions boundary it must fail closed, so during
                // the migration a client missing an ad_account_id hides rows rather than
                // risking exposing another client's.
                const allowedIds = new Set(
                    fClients.filter(c => normAllowed.includes(normalize(c.name)))
                            .map(c => normalizeAccountId(c.ad_account_id))
                            .filter(Boolean)
                );

                fAds = fAds.filter(a => {
                    const rowId = normalizeAccountId(a.ad_account_id);
                    if (rowId && allowedIds.size) return allowedIds.has(rowId);
                    const normA = normalize(a.account_name);
                    return normAllowed.some(all => normA === all || normA.includes(all) || all.includes(normA));
                });
            }

            if (fHealth) { fHealth.forEach(h => { if(h.client_name) globalHealthData[normalize(h.client_name)] = h.current_score; }); }

            globalClientsData = fClients.map(c => {
                const normName = normalize(c.name); let score = globalHealthData[normName];
                if (score === undefined) { const possibleMatch = Object.keys(globalHealthData).find(k => k.includes(normName) || normName.includes(k)); if (possibleMatch) score = globalHealthData[possibleMatch]; }
                c.current_score = score || 0; return c;
            });

            globalTasksData = fTasks;
            globalTasksData.forEach(t => t.score = Math.round((((t.p||3)*0.4)+((t.u||3)*0.4)+((6-(t.e||3))*0.2))*20));
            
            globalAdsData = fAds.map(item => { const n = {}; for (let k in item) n[k.toLowerCase().trim()] = item[k]; return n; });

            populateTaskClientDropdown();
            if(typeof populateTemplateClientDropdown === 'function') populateTemplateClientDropdown();
            if(typeof populateCreativeClientDropdown === 'function') populateCreativeClientDropdown();

            // A client finishing their checklist is the cue to move them on, but that
            // write can't happen in their browser: the portal never loads the clients
            // table, and granting the client role write access to it would expose the
            // retainer and contract columns. Caught up here on load instead, the same
            // way the payment police above reconciles a missed deadline.
            // Awaited so callers rendering straight after this see the moved stage and the
            // tasks it generated. Handoff first: it's an Onboarding task itself, so raising
            // it after the advance would leave it filed against a stage they've left.
            // Which onboarding steps apply to each client, before anything below reads it
            await loadOnboardingApplicability(globalClientsData.map(c => c.name));

            if (currentUserRole === 'admin') {
                await reconcileOnboardingHandoffTasks();
                // Before the stage advance, so a task Golden Eye just ticked off can move its client on
                await runAutoChecks();
                await autoAdvanceCompletedOnboarding();
            }
        }

        function populateCreativeClientDropdown() {
            const select = document.getElementById('creative-client');
            if (!select) return;
            let html = '<option value="" disabled selected>Select a client...</option>';
            globalClientsData.forEach(c => { html += `<option value="${escapeAttr(c.name)}">${escapeAttr(c.name)}</option>`; });
            select.innerHTML = html;
        }

        function navTo(page) { switchAppPage(page); }
        function switchAppPage(page) {
            // Save the page choice to the browser's local memory
            localStorage.setItem('midas_current_page', page);
            
            document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
            const navEl = document.getElementById(`nav-${page}`); if(navEl) navEl.classList.add('active');
    
    document.getElementById('page-goldeneye').classList.add('hidden'); 
    document.getElementById('page-tasks').classList.add('hidden'); 
    document.getElementById('page-clients').classList.add('hidden');
    const setPage = document.getElementById('page-settings'); if(setPage) setPage.classList.add('hidden');
    const tplPage = document.getElementById('page-templates'); if(tplPage) tplPage.classList.add('hidden');
    const salesPage = document.getElementById('page-sales'); if(salesPage) salesPage.classList.add('hidden');
    const crPage = document.getElementById('page-creatives'); if(crPage) crPage.classList.add('hidden');
    
    // 👇 NEW LINE ADDED HERE: Make sure the audits page hides when switching tabs 👇
    const auditsPage = document.getElementById('page-audits'); if(auditsPage) auditsPage.classList.add('hidden');
    
    if (page === 'goldeneye') { 
        document.getElementById('page-goldeneye').classList.remove('hidden'); 
        setTimeout(() => renderGoldenEye(), 250); 
    }
    else if (page === 'tasks') { document.getElementById('page-tasks').classList.remove('hidden'); setTimeout(() => initTasksPage(), 50); } 
    else if (page === 'clients') { document.getElementById('page-clients').classList.remove('hidden'); setTimeout(() => initClientsPage(), 50); }
    else if (page === 'sales') { if(salesPage) salesPage.classList.remove('hidden'); setTimeout(() => { if(typeof renderSalesBoard === 'function') renderSalesBoard(); if(typeof initSalesSortable === 'function') initSalesSortable(); }, 50); }
    else if (page === 'templates') { if(tplPage) tplPage.classList.remove('hidden'); }
    else if (page === 'settings') { if(setPage) setPage.classList.remove('hidden'); setTimeout(() => { if(typeof initSettingsPage === 'function') initSettingsPage(); }, 50); }
    else if (page === 'creatives') { if(crPage) crPage.classList.remove('hidden'); setTimeout(() => { if(typeof renderAdminCreatives === 'function') renderAdminCreatives(); }, 50); } 
    
    // 👇 NEW LINES ADDED HERE: Trigger the audits page to show up 👇
    else if (page === 'audits') { 
        if(auditsPage) auditsPage.classList.remove('hidden'); 
        setTimeout(() => renderMorningAudits(), 50); 
    }
}

        function populateTemplateClientDropdown() {
            const select = document.getElementById('template-client'); 
            if (!select) return; 
            let html = '<option value="" disabled selected>Select a client...</option>';
            globalClientsData.forEach(c => { html += `<option value="${escapeAttr(c.name)}">${escapeAttr(c.name)}</option>`; });
            select.innerHTML = html;
        }
        
        function goToClient(clientName) { cSelectAccount(clientName, clientName); switchAppPage('clients'); }

        // One list for everything outstanding. Client Tasks, Alerts & Approvals and HQ
        // Tasks were three windows onto the same table — the same task could show up in
        // two of them, and because each capped its own list the highest-priority item
        // wasn't guaranteed to be on screen anywhere. Sorting the lot together fixes both.
        //
        // Contract renewal flags used to live here too and have been dropped: they fired
        // off contract_end_date, which isn't maintained, so they were noise.
        function dashFeedLabel(t) {
            if (normalize(t.client) === normalize('Midas Media'))
                return { text: 'HQ', cls: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/25' };
            if (t.type === 'Client Request')
                return { text: 'Request', cls: 'text-blue-400 bg-blue-500/10 border-blue-500/25' };
            // The assignee is what makes a task the client's own — see the task board
            if (String(t.assignee || '').trim().toLowerCase() === 'client')
                return { text: 'Client', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25' };
            return { text: 'For client', cls: 'text-gray-400 bg-white/5 border-white/10' };
        }

        // Ten is about a phone screen's worth. The rest are one tap away rather than a
        // scroll away, so the top of the list stays the thing you actually see.
        const DASH_FEED_CAP = 10;
        let dashFeedExpanded = false;

        window.toggleDashFeed = function() {
            dashFeedExpanded = !dashFeedExpanded;
            renderDashFeed();
        };

        function renderDashFeed() {
            const list = document.getElementById('dash-feed');
            const countEl = document.getElementById('dash-feed-count');
            if (!list) return;

            const open = globalTasksData.filter(t => t.status !== 'Complete');
            const today = new Date().toISOString().split('T')[0];

            // Overdue outranks score: a low-priority task that's already late is a
            // commitment we've broken, which beats a high-scoring one that isn't due yet.
            open.sort((a, b) => {
                const aLate = a.due && a.due < today ? 1 : 0;
                const bLate = b.due && b.due < today ? 1 : 0;
                if (aLate !== bLate) return bLate - aLate;
                return (b.score || 0) - (a.score || 0);
            });

            if (countEl) countEl.innerText = open.length ? String(open.length) : '';

            if (!open.length) {
                list.innerHTML = '<p class="text-center text-xs text-gray-500 italic mt-8">All clear &mdash; nothing outstanding.</p>';
                return;
            }

            const shown = dashFeedExpanded ? open : open.slice(0, DASH_FEED_CAP);
            const hidden = open.length - shown.length;

            list.innerHTML = shown.map(t => {
                const label = dashFeedLabel(t);
                const pC = t.score > 75 ? '#ef4444' : (t.score > 50 ? '#f59e0b' : '#3b82f6');

                let due = '';
                if (t.due && t.due < today) {
                    due = '<span class="text-[10px] font-bold text-red-400 whitespace-nowrap"><i class="fa-solid fa-circle-exclamation mr-1"></i>Overdue</span>';
                } else if (t.due === today) {
                    due = '<span class="text-[10px] font-bold text-yellow-400 whitespace-nowrap"><i class="fa-solid fa-bell mr-1"></i>Today</span>';
                }

                // HQ items name the person; client work names the client
                const who = label.text === 'HQ' ? (t.assignee || 'HQ Team') : t.client;

                return `<div class="bg-black/20 p-3 rounded-xl border border-white/5 cursor-pointer hover:bg-white/5 transition"
                             onclick="navTo('tasks'); setTimeout(() => openTaskDrawer(${t.id}), 100)">
                            <div class="flex justify-between items-center gap-2 mb-1.5">
                                <div class="flex items-center gap-2 min-w-0">
                                    <span class="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border shrink-0 ${label.cls}">${label.text}</span>
                                    <span class="text-[10px] text-gray-400 truncate">${escapeAttr(stripSlashEscapes(who || ''))}</span>
                                </div>
                                <div class="flex items-center gap-2 shrink-0">
                                    ${due}
                                    <div class="flex items-center gap-1 bg-black/40 px-1.5 py-0.5 rounded text-[9px] font-bold">
                                        <div class="w-1.5 h-1.5 rounded-full" style="background:${pC};"></div>${t.score ?? 0}
                                    </div>
                                </div>
                            </div>
                            <p class="text-xs font-bold text-white leading-tight">${escapeAttr(stripSlashEscapes(t.title || ''))}</p>
                        </div>`;
            }).join('');

            if (hidden > 0) {
                list.innerHTML += `<button onclick="toggleDashFeed()" class="w-full text-center text-xs text-blue-400 hover:text-blue-300 hover:underline py-2 transition">
                                       ${hidden} more <i class="fa-solid fa-chevron-down ml-1 text-[10px]"></i>
                                   </button>`;
            } else if (dashFeedExpanded && open.length > DASH_FEED_CAP) {
                list.innerHTML += `<button onclick="toggleDashFeed()" class="w-full text-center text-xs text-gray-400 hover:text-white hover:underline py-2 transition">
                                       Show less <i class="fa-solid fa-chevron-up ml-1 text-[10px]"></i>
                                   </button>`;
            }
        }

        // --- GOLDEN EYE (DASHBOARD) RENDERING ---
        function renderGoldenEye() {
            // Check for a cached audit first thing!
            checkSavedAudit();
            // Puts the count of unread changes on Settings → Updates
            if (typeof checkUpdatesBadge === 'function') checkUpdatesBadge();

            const isLight = document.getElementById('theme-wrapper').classList.contains('light-mode'); Chart.defaults.color = isLight ? '#64748b' : 'rgba(255,255,255,0.6)';

            const activeClients = globalClientsData.filter(c => isActiveClient(c) && normalize(c.name) !== normalize('Midas Media'));
            const currentTotalMRR = activeClients.reduce((sum, c) => sum + parseFloat(c.monthly_retainer || 0), 0);
            document.getElementById('dash-mrr-total').innerText = '$' + currentTotalMRR.toLocaleString();
            
            const mrrLabels = activeClients.map(c => c.name); const mrrData = activeClients.map(c => c.monthly_retainer);
            if (dashMrrChartInstance) dashMrrChartInstance.destroy();
            dashMrrChartInstance = new Chart(document.getElementById('dashMrrChart').getContext('2d'), { type: 'bar', data: { labels: mrrLabels, datasets: [{ label: 'Retainer ($)', data: mrrData, backgroundColor: 'rgba(59, 130, 246, 0.8)', borderRadius: 4, hoverBackgroundColor: '#60a5fa' }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } } });

            renderDashFeed();

            let totalScore = 0; let scoredClients = 0;
            activeClients.forEach(c => { if(c.current_score > 0) { totalScore += c.current_score; scoredClients++; } });
            const avgScore = scoredClients > 0 ? Math.round(totalScore / scoredClients) : 0;
            document.getElementById('dash-avg-health-val').innerText = avgScore || '--'; document.getElementById('dash-avg-health-lbl').innerText = avgScore > 0 ? 'Network Average' : 'No Data';
            
            let ac='#4ade80'; if(avgScore<70)ac='#facc15'; if(avgScore<40)ac='#ef4444'; if(avgScore===0)ac='#64748b';
            if (dashAvgHealthInstance) dashAvgHealthInstance.destroy();
            dashAvgHealthInstance = new Chart(document.getElementById('dashAvgHealthGauge').getContext('2d'), { type: 'doughnut', data: { datasets: [{ data: [avgScore, 100 - avgScore], backgroundColor: [ac, isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)'], borderWidth: 0 }] }, options: { maintainAspectRatio: false, cutout: '85%', rotation: 270, circumference: 180, plugins: { legend: { display: false }, tooltip: {enabled: false} } } });

            const rosterAdd = document.getElementById('btn-add-client-roster');
            if (rosterAdd) rosterAdd.classList.toggle('hidden', currentUserRole !== 'admin');

            document.getElementById('dash-client-count').innerText = `${activeClients.length} Active`; let clientListHtml = '';
            activeClients.sort((a,b) => b.monthly_retainer - a.monthly_retainer).forEach(c => {
                const score = c.current_score; 
                let sc='#4ade80'; if(score<70)sc='#facc15'; if(score<40)sc='#ef4444'; if(score===0)sc='#64748b';
                
                let payBadge = '';
                if (c.payment_status === 'paid') {
                    payBadge = `<span class="text-[10px] bg-green-500/20 text-green-400 border border-green-500/30 px-2 py-0.5 rounded-md ml-2">Paid</span>`;
                } else if (c.payment_status === 'overdue') {
                    payBadge = `<span class="text-[10px] bg-red-500/20 text-red-400 border border-red-500/30 px-2 py-0.5 rounded-md ml-2">Overdue</span>`;
                } else {
                    payBadge = `<span class="text-[10px] bg-gray-500/20 text-gray-400 border border-gray-500/30 px-2 py-0.5 rounded-md ml-2">Unpaid</span>`;
                }

                const retainer = parseFloat(c.monthly_retainer || 0).toLocaleString();
                
                clientListHtml += `<tr class="hover:bg-white/5 transition cursor-pointer" onclick="goToClient('${escapeHTML(c.name)}')">
                    <td class="py-3 font-bold text-blue-400">${c.name} ${payBadge}</td>
                    <td class="py-3 text-center"><div class="score-bar-bg" title="Health Score: ${score}"><div class="score-bar-fill" style="width: ${score}%; background: ${sc};"></div></div></td>
                    <td class="py-3 text-right font-bold text-white">$${retainer}</td>
                </tr>`;
            });
            document.getElementById('dash-client-list').innerHTML = clientListHtml;
        }

        // --- TASK MODULE ---
        function initTasksPage() { selectedTaskIds.clear(); renderTaskSummary(); renderActiveTaskView(); initColumnSortable(); }
        function switchTaskView(mode) {
            currentTaskView = mode; document.getElementById('btn-view-kanban').classList.toggle('active', mode === 'kanban'); document.getElementById('btn-view-table').classList.toggle('active', mode === 'table');
            if (mode === 'kanban') { document.getElementById('view-kanban').classList.remove('hidden'); document.getElementById('view-table').classList.add('hidden'); document.getElementById('btn-columns').classList.add('hidden'); document.getElementById('t-bulk-bar').classList.add('hidden'); } 
            else { document.getElementById('view-kanban').classList.add('hidden'); document.getElementById('view-table').classList.remove('hidden'); document.getElementById('btn-columns').classList.remove('hidden'); updateTaskBulkBar(); }
            renderActiveTaskView();
        }
        function renderActiveTaskView() { if (currentTaskView === 'kanban') renderKanban(); else renderTable(); }

        function renderTaskSummary() {
            const today = new Date().toISOString().split('T')[0]; let o=0, dt=0, ip=0, c=0;
            globalTasksData.forEach(t => { if(t.status==='In Progress') ip++; if(t.status==='Complete') c++; if(t.status!=='Complete' && t.due){ if(t.due<today) o++; if(t.due===today) dt++; } });
            document.getElementById('stat-total').innerText = globalTasksData.length; document.getElementById('stat-overdue').innerText = o; document.getElementById('stat-today').innerText = dt; document.getElementById('stat-progress').innerText = ip; document.getElementById('stat-completed').innerText = c;
        }

        // A task assigned to "Client" is theirs to do, not ours. They already appeared on
        // our board — nothing filters by assignee — but looked identical to our own work,
        // so a column full of Not Started could be mostly things we're waiting on them for.
        // Amber matches how the same tasks are marked in their portal.
        const taskIsClients = t => normalize(t.assignee || '') === 'client';

        // Which side of the board you're looking at. Kept out of the search box so the two
        // filters compose — searching a client name while showing only what they owe us.
        let taskOwnerFilter = 'all';

        const matchesTaskOwner = t =>
            taskOwnerFilter === 'all' ||
            (taskOwnerFilter === 'theirs' ? taskIsClients(t) : !taskIsClients(t));

        window.setTaskOwnerFilter = function(mode) {
            taskOwnerFilter = ['all', 'ours', 'theirs'].includes(mode) ? mode : 'all';
            ['all', 'ours', 'theirs'].forEach(m => {
                const b = document.getElementById(`btn-owner-${m}`);
                if (b) b.classList.toggle('active', m === taskOwnerFilter);
            });
            renderActiveTaskView();
        };

        const clientTaskBadge = t => (t.client_visible === false
                ? '<span class="text-[9px] font-bold uppercase tracking-widest text-gray-400 bg-white/5 border border-white/10 px-1.5 py-0.5 rounded whitespace-nowrap" title="Hidden from the client"><i class="fa-solid fa-eye-slash mr-1"></i>Hidden</span>'
                : '') + (!taskIsClients(t) ? ''
            : t.__onboardingStep
                ? '<span class="text-[9px] font-bold uppercase tracking-widest text-amber-400 bg-amber-400/10 border border-amber-400/25 px-1.5 py-0.5 rounded whitespace-nowrap">Onboarding step</span>'
                : '<span class="text-[9px] font-bold uppercase tracking-widest text-amber-400 bg-amber-400/10 border border-amber-400/25 px-1.5 py-0.5 rounded whitespace-nowrap">Client to do</span>');

        // The client's outstanding onboarding steps, mirrored onto the board so we can see
        // what we're waiting on them for. Deliberately not rows in `tasks`: the stage
        // advance needs every Onboarding task Complete, and real rows for steps only the
        // client can tick would strand everyone at Onboarding forever.
        function clientOnboardingPseudoTasks() {
            const out = [];
            globalClientsData.forEach(c => {
                if ((c.status || 'active') !== 'active') return;
                // In Onboarding, every step that applies to them. Past it, only the steps of
                // an add-on they're onboarding now (nothing for everyone else).
                const steps = getStartedSteps(c.name, c.current_stage || 'Onboarding');
                if (!steps.length) return;

                steps.forEach(s => {
                    const prog = onboardingProgressFor(c.name, s.id);
                    const done = !!prog?.completed_at;

                    out.push({
                        __onboardingStep: true,
                        client: c.name,
                        title: s.title,
                        stage: 'Onboarding',
                        type: 'Checklist',
                        // Finished steps stay on the board rather than vanishing, so the
                        // columns show progress. A part-watched video is genuinely
                        // underway, not untouched.
                        status: done ? 'Complete' : (prog?.watch_percent ? 'In Progress' : 'Not Started'),
                        assignee: 'Client',
                        p: 3, u: 3, e: 3, score: 60,
                        due: null, notes: null
                    });
                });
            });
            return out;
        }

        function renderKanban() {
            const searchEl = document.getElementById('task-search-filter'); const q = searchEl ? searchEl.value.toLowerCase() : '';
            let f = globalTasksData.filter(t => (t.title || "").toLowerCase().includes(q) || (t.client || "").toLowerCase().includes(q));
            f = f.filter(matchesTaskOwner);
            // Shown under All as well as Client — "All" meaning all but these was just
            // confusing. Hidden under Ours, which is the point of that filter. Board only:
            // the list view has checkboxes wired to real task ids, and these have none.
            if (taskOwnerFilter !== "ours") {
                f = f.concat(clientOnboardingPseudoTasks().filter(t =>
                    (t.title || "").toLowerCase().includes(q) || (t.client || "").toLowerCase().includes(q)));
            }
            const cols = { 'Not Started': document.getElementById('col-todo'), 'In Progress': document.getElementById('col-prog'), 'Blocked': document.getElementById('col-rev'), 'Complete': document.getElementById('col-done') };
            const counts = { 'Not Started': 0, 'In Progress': 0, 'Blocked': 0, 'Complete': 0 };
            Object.values(cols).forEach(el => { if(el) el.innerHTML = ''; }); f.sort((a,b) => b.score - a.score);

            f.forEach(t => {
                const s = t.status || 'Not Started'; if(!cols[s]) return; counts[s]++;
                let dI='', dCol='text-gray-500'; if(s!=='Complete'&&t.due){ const td=new Date().toISOString().split('T')[0]; if(t.due<td){ dI='<i class="fa-solid fa-circle-exclamation mr-1"></i>'; dCol='text-red-400'; } else if(t.due===td){ dI='<i class="fa-solid fa-bell mr-1"></i>'; dCol='text-yellow-400'; } }
                const cColor = t.score>75?'#ef4444':(t.score>50?'#f59e0b':'#3b82f6'); const init = t.assignee?t.assignee.substring(0,2).toUpperCase():'?';
                cols[s].innerHTML += `<div class="glass kanban-card p-4 transition border border-white/10 hover:border-blue-500/50 ${taskIsClients(t) ? 'border-l-4 border-l-amber-400' : ''} ${t.__onboardingStep ? 'border-dashed opacity-90' : ''}" data-id="${t.id}" onclick="${t.__onboardingStep ? "goToClient('" + escapeHTML(t.client) + "')" : "openTaskDrawer(" + t.id + ")"}"><div class="flex justify-between items-start gap-2 mb-2">${clientTaskBadge(t)}<span onclick="goToClient('${escapeHTML(t.client)}'); event.stopPropagation();" class="cursor-pointer hover:text-blue-300 hover:underline text-[10px] font-bold text-gray-400 uppercase tracking-widest bg-black/20 px-2 py-0.5 rounded truncate max-w-[120px] block" title="Open Dashboard">${t.client || 'Unknown'}</span><span class="${dCol} text-[10px] font-bold whitespace-nowrap">${dI} ${t.due||'-'}</span></div><h4 class="font-bold text-white text-sm mb-4 leading-snug">${t.title || 'Untitled Task'}</h4><div class="flex justify-between items-center mt-auto"><div class="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold">${init}</div><div class="flex items-center gap-2 bg-black/20 px-2 py-1 rounded-lg"><div class="w-2 h-2 rounded-full" style="background:${cColor};"></div><span class="font-bold text-white text-[10px]">${t.score}</span></div></div></div>`;
            });
            document.getElementById('count-todo').innerText = counts['Not Started']; document.getElementById('count-prog').innerText = counts['In Progress']; document.getElementById('count-rev').innerText = counts['Blocked']; document.getElementById('count-done').innerText = counts['Complete'];
            
            sortableInstances.forEach(s=>s.destroy()); sortableInstances=[];
            document.querySelectorAll('#page-tasks .kanban-col').forEach(c => {
                sortableInstances.push(new Sortable(c, { group:'kanban', animation:150, ghostClass:'sortable-ghost', delay:50, delayOnTouchOnly:true, onEnd: async(e)=>{
                    const id = e.item.getAttribute('data-id'); const nS = e.to.getAttribute('data-status'); const t = globalTasksData.find(x=>x.id==id);
                    if(t && t.status!==nS){ t.status=nS; renderTaskSummary(); const {error} = await supabaseClient.from('tasks').update({status:nS}).eq('id',id); if(error) await fetchAllGlobalData(globalAllowedClients); renderKanban(); if(await autoAdvanceCompletedOnboarding()) renderKanban(); }
                }}));
            });
        }

        function renderTable() {
            const thead = document.getElementById('t-table-head'); const getI = c => currentTaskSort===c?(taskSortDir==='asc'?'<i class="fa-solid fa-sort-up ml-1 text-blue-500"></i>':'<i class="fa-solid fa-sort-down ml-1 text-blue-500"></i>'):'<i class="fa-solid fa-sort ml-1 opacity-30"></i>'; let pLbl = taskPrioMode==='dueDate'?"Sort: Due":taskPrioMode==='et'?"Sort: Effort":taskPrioMode==='urgency'?"Sort: Urg.":"Priority Score";
            let h = `<tr><th class="p-4 w-10"><input type="checkbox" class="row-checkbox" onchange="toggleAllTasks(this)"></th><th class="p-4 sortable" onclick="setTaskSort('title')">Task ${getI('title')}</th><th class="p-4 sortable" onclick="setTaskSort('client')">Client ${getI('client')}</th><th class="p-4 relative"><div class="cursor-pointer sortable flex items-center" onclick="setTaskSort('score')">${pLbl} ${getI('score')}<i class="fa-solid fa-caret-down ml-2 opacity-50 hover:text-white" onclick="event.stopPropagation(); document.getElementById('prio-dropdown').classList.toggle('show')"></i></div><div id="prio-dropdown" class="sort-dropdown"><div class="sort-item" onclick="setTaskPrio('total')">Total Priority</div><div class="sort-item" onclick="setTaskPrio('dueDate')">Urgency</div><div class="sort-item" onclick="setTaskPrio('et')">Effort</div></div></th><th class="p-4 sortable" onclick="setTaskSort('due')">Due ${getI('due')}</th><th class="p-4 sortable" onclick="setTaskSort('status')">Status ${getI('status')}</th>`;
            activeCols.forEach(c => { const d=masterCols.find(x=>x.id===c); if(d) h+=`<th class="p-4 sortable" onclick="setTaskSort('${d.id}')">${d.label} ${getI(d.id)}</th>`; }); thead.innerHTML = h + `</tr>`;

            const searchEl = document.getElementById('task-search-filter'); const q = searchEl ? searchEl.value.toLowerCase() : '';
            let f = globalTasksData.filter(t => (t.title || "").toLowerCase().includes(q) || (t.client || "").toLowerCase().includes(q));
            f = f.filter(matchesTaskOwner);
            f.sort((a,b) => { let vA=a[currentTaskSort]||'', vB=b[currentTaskSort]||''; if(currentTaskSort==='score'){ if(taskPrioMode==='total'){vA=a.score;vB=b.score;} if(taskPrioMode==='dueDate'){vA=a.u;vB=b.u;} if(taskPrioMode==='et'){vA=a.e;vB=b.e;} } if(vA<vB) return taskSortDir==='asc'?-1:1; if(vA>vB) return taskSortDir==='asc'?1:-1; return 0; });

            const td = new Date().toISOString().split('T')[0]; let bH = ''; if(f.length===0) bH = `<tr><td colspan="10" class="p-8 text-center text-gray-500">No tasks.</td></tr>`;
            f.forEach(t => {
                let sC = "text-gray-400 border-gray-500"; if(t.status==='In Progress') sC="text-blue-400 border-blue-500 bg-blue-500/10"; if(t.status==='Complete') sC="text-green-400 border-green-500 bg-green-500/10"; if(t.status==='Blocked') sC="text-red-400 border-red-500 bg-red-500/10";
                let dI='', dC='text-gray-400'; if(t.status!=='Complete'&&t.due){ if(t.due<td){dI='<i class="fa-solid fa-circle-exclamation text-red-500 mr-1"></i>'; dC='text-red-400 font-bold';} else if(t.due===td){dI='<i class="fa-solid fa-bell text-yellow-500 mr-1"></i>'; dC='text-yellow-400 font-bold';} }
                let pC = t.score>75?'#ef4444':(t.score>50?'#f59e0b':'#3b82f6'); const chk = selectedTaskIds.has(t.id)?'checked':'';
                
                bH += `<tr class="hover:bg-white/5 transition border-b border-white/5 ${chk?'bg-blue-900/20':''}">
                    <td class="p-4"><input type="checkbox" class="row-checkbox" value="${t.id}" ${chk} onchange="toggleTaskRow(this, ${t.id})"></td>
                    <td class="p-4 font-bold text-white cursor-pointer hover:text-blue-400 transition" onclick="openTaskDrawer(${t.id})"><span class="flex items-center gap-2 flex-wrap">${t.title || 'Untitled'}${clientTaskBadge(t)}</span></td>
                    <td class="p-4 text-blue-400 hover:underline cursor-pointer" onclick="goToClient('${escapeHTML(t.client)}')">${t.client || 'Unknown'}</td>
                    <td class="p-4 cursor-pointer" onclick="openTaskDrawer(${t.id})"><div class="score-bar-bg"><div class="score-bar-fill" style="width:${t.score}%; background:${pC};"></div></div><span class="font-bold text-white text-xs">${t.score}</span></td>
                    <td class="p-4 ${dC} cursor-pointer" onclick="openTaskDrawer(${t.id})">${dI}${t.due||'-'}</td>
                    <td class="p-4 cursor-pointer" onclick="openTaskDrawer(${t.id})"><span class="px-2 py-1 rounded-full border text-[10px] font-bold ${sC}">${t.status}</span></td>`;
                activeCols.forEach(c => { let v=t[c]||'-'; if(c==='assignee'&&t.assignee) v=`<div class="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold">${t.assignee.substring(0,2).toUpperCase()}</div>`; if(c==='updated_at') v=new Date(v).toLocaleDateString(); if(c==='notes') v=`<span class="truncate block max-w-[150px] opacity-70 text-xs">${v}</span>`; bH+=`<td class="p-4 text-gray-300">${v}</td>`; }); bH += `</tr>`;
            });
            document.getElementById('t-table-body').innerHTML = bH; updateTaskBulkBar();
        }

        function setTaskSort(c){ if(currentTaskSort===c) taskSortDir=taskSortDir==='asc'?'desc':'asc'; else {currentTaskSort=c; taskSortDir=c==='score'?'desc':'asc';} renderTable(); }
        function setTaskPrio(m){ taskPrioMode=m; currentTaskSort='score'; taskSortDir='desc'; document.getElementById('prio-dropdown').classList.remove('show'); renderTable(); }
        function toggleTaskRow(cb, id){ if(cb.checked) selectedTaskIds.add(id); else selectedTaskIds.delete(id); renderTable(); }
        function toggleAllTasks(cb){ if(cb.checked) globalTasksData.forEach(t=>selectedTaskIds.add(t.id)); else selectedTaskIds.clear(); renderTable(); }
        function clearSelection(){ selectedTaskIds.clear(); renderTable(); }
        function updateTaskBulkBar(){ if(currentTaskView!=='table') return; const b=document.getElementById('t-bulk-bar'); if(selectedTaskIds.size>0){ document.getElementById('t-bulk-count').innerText=selectedTaskIds.size; b.classList.remove('hidden'); } else b.classList.add('hidden'); }
        async function deleteSelectedTasks(){ if(currentUserRole!=='admin') return alert("Admin only"); if(confirm(`Delete ${selectedTaskIds.size} task(s)?`)){ await supabaseClient.from('tasks').delete().in('id', Array.from(selectedTaskIds)); await fetchAllGlobalData(globalAllowedClients); initTasksPage(); } }
        async function updateSelectedStatus(){ const s=prompt("Update status to (Not Started, In Progress, Blocked, Complete):","Complete"); if(s){ await supabaseClient.from('tasks').update({status:s}).in('id', Array.from(selectedTaskIds)); await fetchAllGlobalData(globalAllowedClients); initTasksPage(); } }

        function openColumnDrawer() {
            const l=document.getElementById('optional-columns-list'); l.innerHTML=''; let o=[]; activeCols.forEach(id=>o.push(masterCols.find(c=>c.id===id))); masterCols.forEach(c=>{if(!activeCols.includes(c.id))o.push(c)});
            o.forEach(c=>{ const act=activeCols.includes(c.id); l.innerHTML+=`<div class="glass p-3 flex justify-between items-center" data-id="${c.id}"><div class="flex items-center gap-3"><i class="fa-solid fa-grip-vertical drag-handle text-gray-500 px-2"></i><span class="font-medium ${act?'text-white':'text-gray-500'}">${c.label}</span></div><input type="checkbox" class="row-checkbox" ${act?'checked':''}></div>`; });
            document.getElementById('drawer-overlay').classList.add('show'); document.getElementById('column-drawer').classList.add('open');
        }
        function initColumnSortable() { 
            const el = document.getElementById('optional-columns-list'); if(!el) return;
            if(columnSortableInstance) columnSortableInstance.destroy();
            columnSortableInstance = new Sortable(el, { handle: '.drag-handle', animation: 150 }); 
        }
        function applyColumns() { activeCols=[]; document.querySelectorAll('#optional-columns-list > div').forEach(i=>{if(i.querySelector('input').checked) activeCols.push(i.getAttribute('data-id'));}); closeAllDrawers(); renderActiveTaskView(); }
        function resetColumns() { activeCols=['assignee','type','stage','urgency']; openColumnDrawer(); }

        function populateTaskClientDropdown() {
            const container = document.getElementById('t-client-list-container'); if(!container) return;
            container.innerHTML = globalClientsData.map(c => `<label class="flex items-center gap-3 p-2 hover:bg-white/5 rounded cursor-pointer transition"><input type="checkbox" class="row-checkbox t-client-cb" value="${escapeAttr(c.name)}" onchange="updateTaskClientDisplay()"> <span class="text-sm font-medium text-gray-300">${c.name}</span></label>`).join('');
        }

        function toggleAllTaskClients(masterCb) { document.querySelectorAll('.t-client-cb').forEach(cb => cb.checked = masterCb.checked); updateTaskClientDisplay(); }

        function updateTaskClientDisplay() {
            const checked = Array.from(document.querySelectorAll('.t-client-cb')).filter(cb => cb.checked);
            const display = document.getElementById('t-client-text'); const allCb = document.getElementById('t-client-all');
            if (checked.length === 0) { display.innerText = "Select clients..."; display.classList.add('text-gray-300'); if(allCb) allCb.checked = false;}
            else if (checked.length === document.querySelectorAll('.t-client-cb').length) { display.innerText = "All Clients Selected"; display.classList.remove('text-gray-300'); if(allCb) allCb.checked = true;}
            else if (checked.length === 1) { display.innerText = checked[0].nextElementSibling.innerText; display.classList.remove('text-gray-300'); if(allCb) allCb.checked = false;}
            else { display.innerText = `${checked.length} Clients Selected`; display.classList.remove('text-gray-300'); if(allCb) allCb.checked = false;}
        }

       function openTaskDrawer(id, fromClientPage = false) {
    if(window.isDraggingKanban) return;
    const f=document.getElementById('task-drawer'); 
    
    // THE FIX: Pull the task drawer out of the hidden folder into the visible wrapper
    if (f.parentElement.id !== 'theme-wrapper') {
        document.getElementById('theme-wrapper').appendChild(f);
    }
    
    f.reset();
    let clientToSet = (fromClientPage && cSelectedAccount !== "ALL") ? cSelectedAccount : "";

    document.querySelectorAll('.t-client-cb').forEach(cb => cb.checked = false);
    const allCb = document.getElementById('t-client-all'); if(allCb) allCb.checked = false;

    // Matched by comparing values rather than building an attribute selector: a name
    // carrying a quote used to need escaping to survive the selector, and normalize()
    // also shrugs off the stray backslashes older rows picked up.

    if(id==='new'){ 
        activeEditId=null;
        document.getElementById('t-drawer-headline').innerText="New Task"; document.getElementById('t-p').value=3; document.getElementById('t-u').value=3; document.getElementById('t-e').value=3; document.getElementById('t-delete-btn').classList.add('hidden'); document.getElementById('t-assignee').value=currentUserName.split(' ')[0]; 
        if (clientToSet) checkTaskClientBox(clientToSet);
    } else { 
        const t=globalTasksData.find(x=>x.id===id);
        if(!t) return; activeEditId=t.id; document.getElementById('t-drawer-headline').innerText="Edit Task"; document.getElementById('t-title').value=t.title; 
        if(t.client) checkTaskClientBox(t.client);
        document.getElementById('t-stage').value=t.stage||'Onboarding'; document.getElementById('t-assignee').value=t.assignee||''; document.getElementById('t-type').value=t.type||'One-off'; document.getElementById('t-due').value=t.due||'';
        document.getElementById('t-status').value=t.status||'Not Started'; document.getElementById('t-p').value=t.p; document.getElementById('t-u').value=t.u; document.getElementById('t-e').value=t.e; document.getElementById('t-notes').value=t.notes||''; document.getElementById('t-delete-btn').classList.remove('hidden');
        document.getElementById('t-hidden').checked = t.client_visible === false;
    }
    updateTaskClientDisplay();
    updateTaskScore(); document.getElementById('drawer-overlay').classList.add('show'); f.classList.add('open');
}
        
        function updateTaskScore(){ const p=parseInt(document.getElementById('t-p').value); const u=parseInt(document.getElementById('t-u').value); const e=parseInt(document.getElementById('t-e').value); document.getElementById('val-p').innerText=p; document.getElementById('val-u').innerText=u; document.getElementById('val-e').innerText=e; const s=Math.round(((p*0.4)+(u*0.4)+((6-e)*0.2))*20); const el=document.getElementById('t-calc-score'); el.innerText=s; el.className=`text-2xl font-extrabold ${s>75?'text-red-400':(s>50?'text-yellow-400':'text-blue-400')}`; }
        
        async function saveTask(e){ 
            e.preventDefault(); 
            const selectedClients = Array.from(document.querySelectorAll('.t-client-cb')).filter(cb => cb.checked).map(cb => cb.value);
            if (selectedClients.length === 0) return alert("Please select at least one client.");

            const b=document.getElementById('t-save-btn'); b.innerText="Saving..."; b.disabled=true; 
            const p=parseInt(document.getElementById('t-p').value); const u=parseInt(document.getElementById('t-u').value); const ev=parseInt(document.getElementById('t-e').value); 
            const basePayload={ title:document.getElementById('t-title').value, stage:document.getElementById('t-stage').value, type:document.getElementById('t-type').value, assignee:document.getElementById('t-assignee').value, due:document.getElementById('t-due').value||null, status:document.getElementById('t-status').value, p:p, u:u, e:ev, score:Math.round(((p*0.4)+(u*0.4)+((6-ev)*0.2))*20), notes:document.getElementById('t-notes').value, updated_at:new Date().toISOString(),
                // Hidden from the client's portal, summary and report (task_client_visibility.sql)
                client_visible: !document.getElementById('t-hidden').checked };

            const writeTask = async (payload) => activeEditId
                ? supabaseClient.from('tasks').update({ ...payload, client: selectedClients[0] }).eq('id', activeEditId)
                : supabaseClient.from('tasks').insert(selectedClients.map(c => ({ ...payload, client: c })));
            let { error: taskErr } = await writeTask(basePayload);
            // Before the SQL has run there's no client_visible column. Never save a task the admin
            // asked to hide as visible: stop and say so. Otherwise save without it.
            if (taskErr && /client_visible/.test(`${taskErr.message || ''} ${taskErr.details || ''}`)) {
                if (!basePayload.client_visible) {
                    b.innerText="Save Task"; b.disabled=false;
                    return alert("Hiding tasks needs supabase/sql/task_client_visibility.sql to be run first. The task wasn't saved.");
                }
                const { client_visible, ...rest } = basePayload;
                ({ error: taskErr } = await writeTask(rest));
            }
            if (taskErr) { b.innerText="Save Task"; b.disabled=false; return alert("Could not save the task: " + taskErr.message); }
            
            b.innerText="Save Task"; b.disabled=false; closeAllDrawers(); 
            await fetchAllGlobalData(globalAllowedClients);
            if(!document.getElementById('page-tasks').classList.contains('hidden')) initTasksPage();
            if(!document.getElementById('page-clients').classList.contains('hidden')) renderClientTasks();
            if(!document.getElementById('page-goldeneye').classList.contains('hidden')) renderGoldenEye();
        }
        
        async function deleteTask(){ if(!activeEditId||currentUserRole!=='admin') return; if(confirm("Delete task?")){ await supabaseClient.from('tasks').delete().eq('id',activeEditId); closeAllDrawers(); await fetchAllGlobalData(globalAllowedClients); if(!document.getElementById('page-tasks').classList.contains('hidden')) initTasksPage(); if(!document.getElementById('page-clients').classList.contains('hidden')) renderClientTasks(); if(!document.getElementById('page-goldeneye').classList.contains('hidden')) renderGoldenEye();} }

        function initClientsPage() {
            // Paused clients are always listed so their history stays reachable.
            // Archived clients are hidden unless the "show archived" toggle is on.
            const visible = globalClientsData.filter(c => c.name && (showArchivedClients || isSelectableClient(c)));
            const accounts = [...new Set(visible.map(i => i.name))].sort();

            const statusByName = {};
            visible.forEach(c => { statusByName[c.name] = c.status || 'active'; });

            // A client onboarding hasn't handed over their ad account yet, so no ads data
            // will arrive for them. Worth surfacing so a blank one isn't forgotten.
            const noAdAccount = new Set(visible.filter(c => !normalizeAccountId(c.ad_account_id)).map(c => c.name));

            const selAccName = accounts.find(a => normalize(a) === normalize(cSelectedAccount)) || cSelectedAccount;
            if(cSelectedAccount !== "ALL" && selAccName !== "ALL") { cSelectedAccount = selAccName; document.getElementById('c-account-label').innerText = cSelectedAccount; }

            const m=document.getElementById('c-account-menu');
            let h=`<div class="dropdown-item" onclick="cSelectAccount('ALL', 'All Accounts')"><i class="fa-solid fa-layer-group w-4"></i> All Accounts</div>`;
            accounts.forEach(a=>{
                const st = statusByName[a];
                let icon = 'fa-briefcase', badge = '';
                if (st === 'paused') {
                    icon = 'fa-circle-pause text-amber-400';
                    badge = ` <span class="text-[9px] uppercase tracking-widest text-amber-400 ml-auto pl-2">Paused</span>`;
                } else if (st === 'archived') {
                    icon = 'fa-box-archive text-gray-500';
                    badge = ` <span class="text-[9px] uppercase tracking-widest text-gray-500 ml-auto pl-2">Archived</span>`;
                } else if (noAdAccount.has(a)) {
                    icon = 'fa-hourglass-half text-blue-400';
                    badge = ` <span class="text-[9px] uppercase tracking-widest text-blue-400 ml-auto pl-2">Onboarding</span>`;
                }
                h+=`<div class="dropdown-item" onclick="cSelectAccount('${escapeHTML(a)}', '${escapeHTML(a)}')"><i class="fa-solid ${icon} w-4"></i> ${a}${badge}</div>`;
            });

            const archivedCount = globalClientsData.filter(c => !isSelectableClient(c)).length;
            if (archivedCount > 0) {
                h += `<div class="dropdown-item border-t border-white/10 text-gray-400" onclick="event.stopPropagation(); toggleArchivedVisibility();">
                        <i class="fa-solid fa-box-archive w-4"></i> ${showArchivedClients ? 'Hide' : 'Show'} archived (${archivedCount})
                      </div>`;
            }

            m.innerHTML=h;
            filterAdsData();
        }

        // Reveal/hide archived clients in the picker without closing the menu.
        window.toggleArchivedVisibility = function() {
            showArchivedClients = !showArchivedClients;
            initClientsPage();
            const menu = document.getElementById('c-account-menu');
            if (menu) menu.classList.add('show');
        };

function switchClientView(view) {
            const views = ['ads', 'health', 'seo', 'chat', 'reports', 'payments'];
            views.forEach(v => {
                const btn = document.getElementById(`tab-btn-${v}`);
                const el = document.getElementById(`c-view-${v}`);
                if(btn) btn.className = 'whitespace-nowrap pb-3 text-sm font-bold text-gray-500 border-b-2 border-transparent hover:text-gray-300 transition';
                if(el) el.classList.add('hidden');
            });

            const activeBtn = document.getElementById(`tab-btn-${view}`);
            const activeEl = document.getElementById(`c-view-${view}`);
            if(activeBtn) {
                let color = view === 'ads' ? 'yellow' : (view === 'health' ? 'green' : (view === 'chat' ? 'purple' : (view === 'reports' ? 'blue' : (view === 'payments' ? 'emerald' : 'gray'))));
                activeBtn.className = `whitespace-nowrap pb-3 text-sm font-bold text-${color}-400 border-b-2 border-${color}-400 transition hover:text-${color}-300`;
            }
            if(activeEl) activeEl.classList.remove('hidden');

            document.getElementById('c-date-icon').className = view === 'ads' ? 'fa-regular fa-calendar-range mr-2 text-yellow-400' : 'fa-solid fa-clock-rotate-left mr-2 text-green-400';

            if (view === 'health') fetchHealthData();
            if (view === 'seo') window.renderAdminSeo();
            if (view === 'reports') window.renderClientReports();
            if (view === 'payments') window.renderClientPayments();
            
            if (view === 'chat') {
                const lbl = document.getElementById('chat-client-lbl');
                if(lbl) lbl.innerText = cSelectedAccount;
                // The API-key box that used to live here was never read by anything —
                // the key is a secret inside the ai-chat edge function. Clear any value
                // an earlier version talked someone into pasting.
                localStorage.removeItem('midas_openai_key');
            }
        }
        function cSelectAccount(val, label) { 
            cSelectedAccount = val; 
            const lbl = document.getElementById('c-account-label'); if(lbl) lbl.innerText = label; 
            const menu = document.getElementById('c-account-menu'); if(menu) menu.classList.remove('show'); 
            
            window.currentChatHistory = [];
            const msgBox = document.getElementById('chat-messages');
            if(msgBox) {
                const welcomeMsg = val === "ALL" 
                    ? "Global Agency mode activated. I have access to the entire network tracking matrix. Ask me to compare clients, find anomalies, or give strategic advice." 
                    : `Client switched to ${val}. I am ready to analyze new data.`;
                
                msgBox.innerHTML = `<div class="flex items-start gap-3"><div class="w-8 h-8 rounded-full bg-blue-600/20 text-blue-400 flex items-center justify-center shrink-0"><i class="fa-solid fa-robot"></i></div><div class="bg-black/20 p-3 rounded-2xl rounded-tl-none border border-white/5 text-sm text-gray-300 max-w-[80%]">${welcomeMsg}</div></div>`;
            }
            
            filterAdsData(); 
        }

        function cycleClient(direction) {
            if (!globalClientsData || globalClientsData.length === 0) return;
            // Mirror the picker, including archived clients only when they're shown.
            const accounts = [...new Set(globalClientsData.filter(c => c.name && (showArchivedClients || isSelectableClient(c))).map(i => i.name))].sort();
            if (accounts.length === 0) return;

            let currentIndex = -1;
            if (cSelectedAccount !== "ALL") {
                currentIndex = accounts.findIndex(a => normalize(a) === normalize(cSelectedAccount));
            }

            let nextIndex;
            if (currentIndex === -1) {
                nextIndex = direction > 0 ? 0 : accounts.length - 1;
            } else {
                nextIndex = (currentIndex + direction + accounts.length) % accounts.length;
            }

            const nextClient = accounts[nextIndex];
            if (nextClient) {
                cSelectAccount(nextClient, nextClient);
            }
        }
        
        function cSelectDate(val, label) { 
            cDateRange = val; cCustomStart = null; cCustomEnd = null; 
            const lbl = document.getElementById('c-date-label'); if(lbl) lbl.innerText = label; 
            const menu = document.getElementById('c-date-menu'); if(menu) menu.classList.remove('show'); 
            filterAdsData(); 
        }
        
        function applyDateRange() { const s=document.getElementById('c-custom-start').value; const e=document.getElementById('c-custom-end').value; if(s&&e){ cDateRange='customRange'; cCustomStart=s; cCustomEnd=e; document.getElementById('c-date-label').innerText=`${new Date(s+'T12:00').toLocaleDateString(undefined,{month:'short',day:'numeric'})} - ${new Date(e+'T12:00').toLocaleDateString(undefined,{month:'short',day:'numeric'})}`; document.getElementById('c-date-menu').classList.remove('show'); filterAdsData(); } }

window.cycleDate = function(direction) {
            // 1. Recreate the current active window
            let { s, e } = dateRangeFor(cDateRange, cCustomStart, cCustomEnd);

            // 2. Shift the dates by +1 or -1 days
            s.setDate(s.getDate() + direction);
            e.setDate(e.getDate() + direction);

            // 3. Format them for standard inputs (YYYY-MM-DD)
            const startStr = s.getFullYear() + '-' + String(s.getMonth() + 1).padStart(2, '0') + '-' + String(s.getDate()).padStart(2, '0');
            const endStr = e.getFullYear() + '-' + String(e.getMonth() + 1).padStart(2, '0') + '-' + String(e.getDate()).padStart(2, '0');

            // 4. Force the app into Custom Range mode to lock in the new shift
            cDateRange = 'customRange';
            cCustomStart = startStr;
            cCustomEnd = endStr;
            
            // 5. Update the hidden custom inputs
            const startInput = document.getElementById('c-custom-start');
            const endInput = document.getElementById('c-custom-end');
            if (startInput) startInput.value = startStr;
            if (endInput) endInput.value = endStr;

            // 6. Print a pretty label on the pill
            let label = '';
            if (startStr === endStr) {
                // If it's a single day, just print that date
                label = s.toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'});
            } else {
                // If they shifted a 7-day or 30-day window, print the new boundaries
                label = `${s.toLocaleDateString(undefined, {month:'short', day:'numeric'})} - ${e.toLocaleDateString(undefined, {month:'short', day:'numeric'})}`;
            }
            
            const labelEl = document.getElementById('c-date-label');
            if (labelEl) labelEl.innerText = label;

            // 7. Render!
            filterAdsData();
        };

function filterAdsData() {
            try {
                if(cSelectedAccount === "ALL") {
                    document.getElementById('client-specific-tasks-box').classList.add('hidden');
                    document.getElementById('ai-box-container').classList.add('hidden');
                    const allClientsTable = document.getElementById('all-clients-ads-list');
                    if (allClientsTable) allClientsTable.classList.remove('hidden');

                    // Per-client controls make no sense in the aggregate view
                    ['btn-stage-transition', 'btn-toggle-pause', 'btn-toggle-archive', 'btn-preview-client', 'btn-edit-client'].forEach(id => {
                        const el = document.getElementById(id);
                        if (el) el.classList.add('hidden');
                    });

                    // Adding a client is an action on the roster, not on whoever happens
                    // to be selected — it used to appear once you'd picked someone and
                    // then linger here, which read as "add a client to this client".
                    const addHere = document.getElementById('btn-add-client');
                    if (addHere) addHere.classList.toggle('hidden', currentUserRole !== 'admin');
                } else {
                    document.getElementById('client-specific-tasks-box').classList.remove('hidden');
                    document.getElementById('ai-box-container').classList.remove('hidden');
                    const allClientsTable = document.getElementById('all-clients-ads-list');
                    if (allClientsTable) allClientsTable.classList.add('hidden');
                    
                    const tLbl = document.getElementById('c-task-client-name'); if(tLbl) tLbl.innerText = cSelectedAccount;
                    const aiLbl = document.getElementById('ai-client-lbl'); if (aiLbl) aiLbl.innerText = cSelectedAccount;
                    
                    const addClientBtn = document.getElementById('btn-add-client');
                    if (addClientBtn) addClientBtn.classList.add('hidden');

                    // The stage is state, so it reads as a chip beside the client's name.
                    // The button is now the action ("Move Stage"), not a label of where
                    // they currently are — the two were doing each other's jobs.
                    const transitionBtn = document.getElementById('btn-stage-transition');
                    const stageChip = document.getElementById('c-stage-chip');
                    const stageClient = globalClientsData.find(c => normalize(c.name) === normalize(cSelectedAccount));
                    const currentStage = stageClient ? (stageClient.current_stage || 'Onboarding') : null;

                    if (stageChip) {
                        stageChip.innerText = currentStage || '';
                        stageChip.classList.toggle('hidden', !currentStage || cSelectedAccount === 'ALL');
                    }

                    if (transitionBtn && currentUserRole === 'admin') {
                        transitionBtn.classList.toggle('hidden', cSelectedAccount === 'ALL');
                    } else if (transitionBtn) {
                        transitionBtn.classList.add('hidden'); // Ensure Team Members don't see it
                    }

                    // Portal invite (admin only). The original lived in the client portal
                    // header, which admins never open — so the only way to grant a client
                    // access was by hand in SQL.
                    const inviteBtn = document.getElementById('btn-invite-client');
                    if (inviteBtn) inviteBtn.classList.toggle('hidden', currentUserRole !== 'admin' || cSelectedAccount === 'ALL');

                    // These now live inside the ⋯ menu, so they carry .dropdown-item and a
                    // colour class rather than a whole button style. Rewriting className
                    // wholesale (as this did) would strip the class that lays them out.
                    const pauseBtn = document.getElementById('btn-toggle-pause');
                    if (pauseBtn && currentUserRole === 'admin') {
                        const clientObj = globalClientsData.find(c => normalize(c.name) === normalize(cSelectedAccount));
                        const paused = clientObj && !isActiveClient(clientObj);
                        document.getElementById('btn-toggle-pause-label').innerText = paused ? 'Resume Client' : 'Pause Client';
                        document.getElementById('btn-toggle-pause-icon').className = paused
                            ? 'fa-solid fa-circle-play w-4 text-emerald-400'
                            : 'fa-solid fa-circle-pause w-4 text-amber-400';
                        pauseBtn.classList.toggle('hidden', cSelectedAccount === 'ALL');
                    } else if (pauseBtn) {
                        pauseBtn.classList.add('hidden');
                    }

                    // Archive / restore control (admin only)
                    const archiveBtn = document.getElementById('btn-toggle-archive');
                    if (archiveBtn && currentUserRole === 'admin') {
                        const clientObj = globalClientsData.find(c => normalize(c.name) === normalize(cSelectedAccount));
                        const archived = clientObj && !isSelectableClient(clientObj);
                        document.getElementById('btn-toggle-archive-label').innerText = archived ? 'Restore' : 'Archive';
                        document.getElementById('btn-toggle-archive-icon').className = archived ? 'fa-solid fa-rotate-left w-4' : 'fa-solid fa-box-archive w-4';
                        archiveBtn.title = archived ? 'Restore this client to paused' : 'Offboard this client';
                        archiveBtn.classList.toggle('hidden', cSelectedAccount === 'ALL');
                        // Pausing an already-archived client is meaningless
                        if (archived && pauseBtn) pauseBtn.classList.add('hidden');
                    } else if (archiveBtn) {
                        archiveBtn.classList.add('hidden');
                    }

                    // The ⋯ button itself only earns its place when something is in it
                    const moreBtn = document.getElementById('btn-client-more');
                    if (moreBtn) moreBtn.classList.toggle('hidden', currentUserRole !== 'admin' || cSelectedAccount === 'ALL');

                    const previewBtn = document.getElementById('btn-preview-client');
                    if (previewBtn) previewBtn.classList.toggle('hidden', currentUserRole !== 'admin');

                    const editBtn = document.getElementById('btn-edit-client');
                    if (editBtn) editBtn.classList.toggle('hidden', currentUserRole !== 'admin');

                    renderClientTasks();
                }

                const { s, e } = dateRangeFor(cDateRange, cCustomStart, cCustomEnd);
                
                const inRange = globalAdsData.filter(r => {
                    if (!r.date) return false;
                    const rd = new Date(r.date.split('T')[0]+'T12:00:00');
                    return rd >= s && rd <= e;
                });
                const f = cSelectedAccount === "ALL" ? inRange : reportsForClient(cSelectedAccount, inRange);

                let sp=0, l=0, imp=0, rch=0, clk=0;
                f.forEach(r=>{sp+=parseFloat(r.spend||0); l+=parseInt(r.leads||0); imp+=parseInt(r.impressions||0); rch+=parseInt(r.reach||0); clk+=parseInt(r.unique_link_clicks||0);});
                currentAdsStats = { s:sp, l:l, cpl:l>0?sp/l:0, cpc:clk>0?sp/clk:0, cpm:imp>0?(sp/imp)*1000:0, ctr:imp>0?(clk/imp)*100:0, f:rch>0?imp/rch:0 };

                document.getElementById('kpi-spend').innerText = '$'+currentAdsStats.s.toLocaleString(undefined,{maximumFractionDigits:0}); document.getElementById('kpi-leads').innerText = currentAdsStats.l.toLocaleString(); document.getElementById('kpi-cpl').innerText = '$'+currentAdsStats.cpl.toFixed(2); document.getElementById('kpi-cpc').innerText = '$'+currentAdsStats.cpc.toFixed(2); document.getElementById('kpi-cpm').innerText = '$'+currentAdsStats.cpm.toFixed(2); document.getElementById('kpi-ctr').innerText = currentAdsStats.ctr.toFixed(2)+'%'; document.getElementById('kpi-freq').innerText = currentAdsStats.f.toFixed(2);
                if(document.getElementById('h-kpi-leads')) document.getElementById('h-kpi-leads').innerText = currentAdsStats.l.toLocaleString();

                const isL = document.getElementById('theme-wrapper').classList.contains('light-mode'); Chart.defaults.color = isL?'#64748b':'rgba(255,255,255,0.6)';
                const d = {}; f.forEach(r=>{const dt=r.date.split('T')[0]; d[dt]=d[dt]||{s:0,l:0}; d[dt].s+=parseFloat(r.spend||0); d[dt].l+=parseInt(r.leads||0);}); const lbls=Object.keys(d).sort();
                
                if(trendChartInstance) trendChartInstance.destroy(); 
                trendChartInstance = new Chart(document.getElementById('trendChart'),{
                    type:'line',
                    data:{labels:lbls,datasets:[{label:'Spend ($)',data:lbls.map(x=>d[x].s),borderColor:'#fbbf24',backgroundColor:'rgba(251,191,36,0.1)',fill:true,tension:0.4,yAxisID:'y'},{label:'Leads',data:lbls.map(x=>d[x].l),borderColor:'#34d399',backgroundColor:'#34d399',tension:0.4,yAxisID:'y1'}]},
                    options:{
                        maintainAspectRatio:false, interaction:{mode:'index',intersect:false},
                        scales:{y:{type:'linear',position:'left'},y1:{type:'linear',position:'right',grid:{display:false}}},
                        plugins: { zoom: { pan: { enabled: true, mode: 'x' }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' } } }
                    }
                });

                if(accountChartInstance) accountChartInstance.destroy(); 
                accountChartInstance = new Chart(document.getElementById('accountChart'),{
                    type:'bar',
                    data:{labels:lbls,datasets:[{label:'CPL ($)',data:lbls.map(x=>d[x].l>0?(d[x].s/d[x].l).toFixed(2):0),backgroundColor:'rgba(96,165,250,0.7)',borderRadius:4}]},
                    options:{
                        maintainAspectRatio:false,
                        plugins: { legend: { display: false }, zoom: { pan: { enabled: true, mode: 'x' }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' } } }
                    }
                });

                if (cSelectedAccount === "ALL") {
                    let allHtml = '';
                    const activeClients = globalClientsData.filter(c => isActiveClient(c) && normalize(c.name) !== normalize('Midas Media'));
                    activeClients.forEach(c => {
                        const cAds = reportsForClient(c, f);
                        let cSpend = 0, cLeads = 0;
                        cAds.forEach(r => { cSpend += parseFloat(r.spend || 0); cLeads += parseInt(r.leads || 0); });
                        const cCpl = cLeads > 0 ? (cSpend / cLeads) : 0;
                        allHtml += `<tr class="hover:bg-white/5 transition cursor-pointer" onclick="goToClient('${escapeHTML(c.name)}')">
                            <td class="py-3 font-bold text-blue-400">${c.name}</td>
                            <td class="py-3 text-right font-bold text-white">$${cSpend.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                            <td class="py-3 text-right font-bold text-green-400">${cLeads.toLocaleString()}</td>
                            <td class="py-3 text-right font-bold text-gray-300">$${cCpl.toFixed(2)}</td>
                        </tr>`;
                    });
                    const tbody = document.getElementById('all-clients-ads-tbody');
                    if(tbody) tbody.innerHTML = allHtml;
                }

                if (!document.getElementById('c-view-health').classList.contains('hidden')) fetchHealthData();
                if (!document.getElementById('c-view-seo').classList.contains('hidden')) window.renderAdminSeo();
                if (!document.getElementById('c-view-reports').classList.contains('hidden')) window.renderClientReports();
                if (!document.getElementById('c-view-payments').classList.contains('hidden')) window.renderClientPayments();
            } catch (err) {
                console.error("Filter Ads Data Error: ", err);
            }
        }
function renderClientTasks() {
            if(cSelectedAccount === "ALL") return;
            const normAccount = normalize(cSelectedAccount);
            const cTasks = globalTasksData.filter(t => normalize(t.client) === normAccount && t.status !== 'Complete');
            cTasks.sort((a,b) => b.score - a.score);
            
            let html = '';
            if(cTasks.length === 0) html = '<p class="text-xs text-gray-500 italic mt-2">No pending tasks for this client.</p>';
            
            cTasks.forEach(t => {
                let pC = t.score>75?'#ef4444':(t.score>50?'#f59e0b':'#3b82f6');
                let dI='', dC='text-gray-500'; 
                if(t.due){ const td=new Date().toISOString().split('T')[0]; if(t.due<td){ dI='<i class="fa-solid fa-circle-exclamation mr-1"></i>'; dC='text-red-400'; } else if(t.due===td){ dI='<i class="fa-solid fa-bell mr-1"></i>'; dC='text-yellow-400'; } }
                html += `
                    <div class="bg-black/20 p-3 rounded-lg border border-white/5 flex justify-between items-center cursor-pointer hover:bg-white/5 transition" onclick="openTaskDrawer(${t.id})">
                        <div>
                            <p class="text-sm font-bold text-white">${t.title || 'Untitled'}</p>
                            <p class="text-[10px] mt-1 ${dC}">${dI}${t.due||'No Date'} <span class="text-gray-500 ml-2">Assigned: ${t.assignee}</span></p>
                        </div>
                        <div class="flex flex-col items-end">
                            <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest bg-black/40 px-2 py-0.5 rounded mb-1">${t.status}</span>
                            <div class="flex items-center gap-1"><div class="w-2 h-2 rounded-full" style="background:${pC};"></div><span class="font-bold text-white text-xs">${t.score}</span></div>
                        </div>
                    </div>`;
            });
            const taskListEl = document.getElementById('c-task-list');
            if(taskListEl) taskListEl.innerHTML = html;
        }
async function fetchHealthData() {
            const healthPill = document.getElementById('global-health-pill');
            
            // GLOBAL DASHBOARD LOGIC
            if(cSelectedAccount==="ALL"){ 
                document.getElementById('global-health-dashboard').classList.remove('hidden'); 
                document.getElementById('health-dashboard-content').classList.add('hidden'); 
                if(healthPill) healthPill.classList.add('hidden');
                
                const activeClients = globalClientsData.filter(c => isActiveClient(c) && normalize(c.name) !== normalize('Midas Media'));
                let tScore = 0; let sClients = 0; let atRisk = 0;
                let tAppts = 0; let tDeals = 0;

                const { data: allHealth } = await supabaseClient.from('client_health').select('*');
                
                if (allHealth) {
                    allHealth.forEach(h => {
                        const normName = normalize(h.client_name);
                        const isActive = activeClients.some(c => normalize(c.name) === normName);
                        if (isActive) {
                            if (h.current_score > 0) { tScore += h.current_score; sClients++; }
                            if (h.current_score > 0 && h.current_score < 40) atRisk++;
                        }
                    });
                }

                // Running totals across every check-in, matching the per-client tiles.
                // Counting off client_health alone showed zero until someone opened the
                // drawer and saved.
                let tRevenue = 0;
                const sumField = (rows, field) => rows.reduce((sum, r) => sum + (parseFloat(r[field]) || 0), 0);

                activeClients.forEach(c => {
                    const health = allHealth?.find(h => normalize(h.client_name) === normalize(c.name));
                    const rows = checkinsForClient(c);
                    tAppts   += Math.max(health?.appts_vol    || 0, sumField(rows, 'estimates_count'));
                    tDeals   += Math.max(health?.deals_closed || 0, sumField(rows, 'closes_count'));
                    tRevenue += sumField(rows, 'revenue_total');
                });

                const ghRevEl = document.getElementById('gh-total-revenue');
                if (ghRevEl) ghRevEl.innerText = tRevenue > 0 ? '$' + tRevenue.toLocaleString(undefined, {maximumFractionDigits:0}) : '--';

                const aScore = sClients > 0 ? Math.round(tScore / sClients) : 0;
                document.getElementById('gh-avg-score').innerText = aScore;
                let avgColor = 'text-green-400'; if(aScore < 70) avgColor = 'text-yellow-400'; if(aScore < 40) avgColor = 'text-red-400'; if(aScore === 0) avgColor = 'text-gray-400';
                document.getElementById('gh-avg-score').className = `text-xl font-bold ${avgColor}`;
                document.getElementById('gh-at-risk').innerText = atRisk;
                document.getElementById('gh-total-appts').innerText = tAppts;
                document.getElementById('gh-total-deals').innerText = tDeals;

                let rankingHtml = '';
                const rankedClients = activeClients.map(c => {
                    const healthRow = allHealth?.find(h => normalize(h.client_name) === normalize(c.name));
                    return { name: c.name, score: healthRow?.current_score || 0 };
                }).sort((a,b) => a.score - b.score);

                rankedClients.forEach(c => {
                    let sc='#4ade80'; let stat = 'Healthy'; let statColor = 'text-green-400';
                    if(c.score<70 && c.score>0) { sc='#facc15'; stat = 'Warning'; statColor = 'text-yellow-400'; }
                    if(c.score<40 && c.score>0) { sc='#ef4444'; stat = 'At Risk'; statColor = 'text-red-400'; }
                    if(c.score===0) { sc='#64748b'; stat = 'No Data'; statColor = 'text-gray-500'; }
                    
                    rankingHtml += `<tr class="hover:bg-white/5 transition cursor-pointer" onclick="goToClient('${escapeHTML(c.name)}')">
                        <td class="py-3 font-bold text-blue-400">${c.name}</td>
                        <td class="py-3 text-center"><div class="score-bar-bg" title="Health Score: ${c.score}"><div class="score-bar-fill" style="width: ${c.score}%; background: ${sc};"></div></div> <span class="text-xs font-bold ml-2" style="color:${sc}">${c.score}</span></td>
                        <td class="py-3 text-right font-bold ${statColor}">${stat}</td>
                    </tr>`;
                });
                document.getElementById('gh-client-ranking').innerHTML = rankingHtml;
                return; 
            }

            // INDIVIDUAL DASHBOARD LOGIC
            document.getElementById('global-health-dashboard').classList.add('hidden'); 
            document.getElementById('health-dashboard-content').classList.remove('hidden');
            if(healthPill) healthPill.classList.remove('hidden');
            

            const resSet = await supabaseClient.from('health_settings').select('*').single(); dbHealthSettings = resSet.data || {weight_milestone:30,weight_comm:20,weight_ghl:20,weight_leads:10,weight_appts:10,weight_deals:10};
            const resMile = await supabaseClient.from('milestone_config').select('*').order('id'); dbMilestones = resMile.data || [];
            const [resC, resCM, resL] = await Promise.all([ supabaseClient.from('client_health').select('*').eq('client_name',cSelectedAccount).single(), supabaseClient.from('client_milestones').select('*').eq('client_name',cSelectedAccount), supabaseClient.from('health_logs').select('*').eq('client_name',cSelectedAccount).order('logged_at',{ascending:true}).limit(30) ]);
            
            dbClientHealth = resC.data || {client_name:cSelectedAccount,last_comm_date:null,ghl_usage:3,leads_vol:0,appts_vol:0,deals_closed:0,current_score:0, manual_override:null, note:null}; 
            dbClientMilestones = resCM.data||[]; 
            dbHealthLogs = resL.data||[];

            document.getElementById('h-kpi-mile').innerText=`${dbClientMilestones.length}/${dbMilestones.length}`;
            let dS="--"; if(dbClientHealth.last_comm_date){ const df=Math.floor((new Date()-new Date(dbClientHealth.last_comm_date))/(1000*60*60*24)); dS=df===0?"Today":`${df} Days`; }
            document.getElementById('h-kpi-comm').innerText=dS; document.getElementById('h-kpi-ghl').innerText=`${dbClientHealth.ghl_usage}/5`; document.getElementById('h-kpi-leads').innerText=(currentAdsStats.l>0?currentAdsStats.l:(dbClientHealth.leads_vol||0)).toLocaleString();

            // Running totals across every check-in, matching the "Total" labels and the
            // all-time revenue figure beside them. Falls back to the staff-entered value
            // when it's higher, so manually tracked clients still show something.
            const clientCheckins = checkinsForClient(cSelectedAccount);
            const sumBy = (rows, field) => rows.reduce((sum, r) => sum + (parseFloat(r[field]) || 0), 0);

            const totalEstimates = sumBy(clientCheckins, 'estimates_count');
            const totalDeals     = sumBy(clientCheckins, 'closes_count');
            const reportedRevenue = sumBy(clientCheckins, 'revenue_total');

            document.getElementById('h-kpi-appts').innerText = Math.max(dbClientHealth.appts_vol || 0, totalEstimates);
            document.getElementById('h-kpi-deals').innerText = Math.max(dbClientHealth.deals_closed || 0, totalDeals);

            const revEl = document.getElementById('h-kpi-revenue');
            if (revEl) revEl.innerText = reportedRevenue > 0 ? '$' + reportedRevenue.toLocaleString(undefined, {maximumFractionDigits:0}) : '--';

            renderClientCheckins();
            renderClientOnboarding();

            const s=dbClientHealth.current_score||0;
            document.getElementById('health-gauge-number').innerText=s;
            
            let c='#4ade80'; let tc='text-green-400'; 
            if(s<70) { c='#facc15'; tc='text-yellow-400'; } 
            if(s<40) { c='#ef4444'; tc='text-red-400'; } 
            if(s===0) { c='#64748b'; tc='text-gray-400'; } 
            
            if(healthPill) {
                document.getElementById('global-health-score').innerText = `Health: ${s}`;
                document.getElementById('global-health-score').className = `font-bold ${tc}`;
                document.getElementById('global-health-icon').className = `fa-solid fa-heart-pulse mr-2 ${tc}`;
            }
            
            const isL = document.getElementById('theme-wrapper').classList.contains('light-mode');
            if(healthGaugeInstance) healthGaugeInstance.destroy(); healthGaugeInstance=new Chart(document.getElementById('healthGaugeChart').getContext('2d'),{type:'doughnut',data:{datasets:[{data:[s,100-s],backgroundColor:[c,isL?'rgba(0,0,0,0.05)':'rgba(255,255,255,0.05)'],borderWidth:0}]},options:{cutout:'80%',rotation:270,circumference:180,plugins:{tooltip:{enabled:false}}}});
            const tl=dbHealthLogs.map(l=>new Date(l.logged_at).toLocaleDateString(undefined,{month:'short',day:'numeric'})); const td=dbHealthLogs.map(l=>l.score); if(td.length===0||td[td.length-1]!==s){tl.push('Now');td.push(s);}
            if(healthLineInstance) healthLineInstance.destroy(); healthLineInstance=new Chart(document.getElementById('healthLineChart').getContext('2d'),{type:'line',data:{labels:tl,datasets:[{data:td,borderColor:c,backgroundColor:c+'20',fill:true,tension:0.3,pointRadius:4}]},options:{maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{min:0,max:100}}}});
            
            const noteEl = document.getElementById('latest-health-note-container');
            if (dbClientHealth.note) {
                noteEl.classList.remove('hidden');
                document.getElementById('h-latest-note').innerText = `"${dbClientHealth.note}"`;
            } else {
                noteEl.classList.add('hidden');
            }

            // --- SINGLE CLIENT CHURN ENFORCER (SAFE ZONE) ---
            const currentClientObj = globalClientsData.find(c => normalize(c.name) === normalize(cSelectedAccount));
            const alertBox = document.getElementById('client-health-alert-container');
            
            if (currentClientObj && alertBox) {
                const currentScore = dbClientHealth.current_score || 0;
                let isHealthRisk = currentScore > 0 && currentScore < 40;
                let isExpiring = false;
                let contractMsg = "";
                
                if (currentClientObj.contract_end_date) {
                    const diffDays = Math.ceil((new Date(currentClientObj.contract_end_date + 'T12:00:00').getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
                    if (diffDays <= 30 && diffDays >= 0) { 
                        isExpiring = true; 
                        contractMsg = `Contract ends in ${diffDays} days (${currentClientObj.contract_end_date})`; 
                    } else if (diffDays < 0) { 
                        isExpiring = true; 
                        contractMsg = `Contract has EXPIRED (${currentClientObj.contract_end_date})`; 
                    }
                }

                if (isHealthRisk || isExpiring) {
                    let reasons = [];
                    if (isHealthRisk) reasons.push(`Critical Relationship Score: ${currentScore}/100`);
                    if (isExpiring) reasons.push(contractMsg);

                    alertBox.innerHTML = `
                        <div class="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3 text-red-400 mb-4">
                            <div class="w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center text-md shrink-0 animate-pulse"><i class="fa-solid fa-triangle-exclamation"></i></div>
                            <div>
                                <h4 class="text-xs font-bold uppercase tracking-wider">CHURN WARNING ACTIVATED</h4>
                                <p class="text-xs text-gray-300 mt-0.5">${reasons.join(' | ')}</p>
                            </div>
                        </div>`;
                    alertBox.classList.remove('hidden');
                } else {
                    alertBox.classList.add('hidden');
                    alertBox.innerHTML = '';
                }
            }
        }

        // Recent weekly SMS check-ins for the selected client — now the only source of
        // client-reported estimates, closes and revenue.
        function renderClientCheckins() {
            const box = document.getElementById('c-checkins-box');
            const list = document.getElementById('c-checkins-list');
            if (!box || !list) return;

            // Lives inside #health-dashboard-content, which is already hidden in the
            // aggregate view, so no visibility toggling needed here.
            if (cSelectedAccount === "ALL") return;

            // One row per week, combining everyone who reported for this client
            const weeks = checkinsByWeek(cSelectedAccount).slice(0, 8);
            if (weeks.length === 0) {
                list.innerHTML = `<p class="text-xs text-gray-500 italic">No check-ins yet. They arrive automatically when this client replies to the weekly text.</p>`;
                return;
            }

            const expected = activeContactCount(cSelectedAccount);

            let html = `<table class="w-full text-left text-sm">
                <thead class="text-[10px] uppercase tracking-widest text-gray-500 border-b border-white/10">
                    <tr><th class="py-2">Week of</th><th>Estimates</th><th>Closed</th><th>Revenue</th><th>Reported</th><th></th></tr>
                </thead><tbody class="divide-y divide-white/5">`;

            weeks.forEach((w, i) => {
                const reporters = new Set(w.contributors.map(c => c.contact_phone || c.contact_name || 'unknown')).size;
                const short = expected > 0 && reporters < expected;
                const rowTint = w.needsReview ? 'bg-amber-500/5' : '';
                const multi = w.contributors.length > 1;

                html += `<tr class="${rowTint}">
                    <td class="py-2 font-bold">
                        ${multi ? `<button onclick="toggleCheckinWeek(${i})" class="text-gray-400 hover:text-white mr-1"><i id="cw-icon-${i}" class="fa-solid fa-chevron-right text-[9px]"></i></button>` : '<span class="inline-block w-4"></span>'}${w.week_start}
                    </td>
                    <td>${w.reportedEstimates ? w.estimates_count : '&mdash;'}</td>
                    <td class="text-green-400 font-bold">${w.reportedCloses ? w.closes_count : '&mdash;'}</td>
                    <td class="text-blue-400">${w.reportedRevenue ? '$' + w.revenue_total.toLocaleString() : '&mdash;'}</td>
                    <td class="${short ? 'text-amber-400' : 'text-gray-500'} text-[11px]">${expected > 0 ? `${reporters} of ${expected}` : reporters}</td>
                    <td class="text-right">${w.needsReview
                        ? `<span class="text-[9px] uppercase tracking-widest text-amber-400" title="A reply couldn't be read confidently — check the original text">Needs review</span>`
                        : ''}</td>
                </tr>`;

                // Per-person breakdown, hidden until the week is expanded
                if (multi) {
                    html += `<tr id="cw-detail-${i}" class="hidden"><td colspan="6" class="pb-3 pl-8">
                        <table class="w-full text-left text-[11px] text-gray-400">`;
                    w.contributors.forEach(c => {
                        html += `<tr>
                            <td class="py-1 pr-4">${escapeHTML(c.contact_name || c.contact_phone || 'Unknown')}</td>
                            <td class="pr-4">${c.estimates_count ?? '&mdash;'} est</td>
                            <td class="pr-4">${c.closes_count ?? '&mdash;'} closed</td>
                            <td class="pr-4">${c.revenue_total ? '$' + Number(c.revenue_total).toLocaleString() : '&mdash;'}</td>
                            <td class="italic opacity-70">${c.parse_confidence === 'low' && c.raw_reply ? '&ldquo;' + escapeHTML(c.raw_reply) + '&rdquo;' : ''}</td>
                        </tr>`;
                    });
                    html += `</table></td></tr>`;
                }

                // Single-reply weeks show their raw text inline when it couldn't be parsed
                if (!multi && w.needsReview) {
                    const raw = w.contributors[0]?.raw_reply;
                    if (raw) html += `<tr class="bg-amber-500/5"><td colspan="6" class="pb-2 pl-8 text-[11px] text-gray-400 italic">&ldquo;${escapeHTML(raw)}&rdquo;</td></tr>`;
                }
            });

            list.innerHTML = html + `</tbody></table>`;
        }

        window.toggleCheckinWeek = function(i) {
            const row = document.getElementById('cw-detail-' + i);
            const icon = document.getElementById('cw-icon-' + i);
            if (!row) return;
            const open = !row.classList.contains('hidden');
            row.classList.toggle('hidden', open);
            if (icon) icon.className = `fa-solid fa-chevron-${open ? 'right' : 'down'} text-[9px]`;
        };

        // The whole onboarding in one list — the client's steps and ours, in order, each
        // showing its real state. Client steps read from onboarding progress; ours read
        // from the tasks table, since an agency item *is* a task.
// For clients who onboarded before the portal existed. Without progress rows every step
// reads as outstanding, so their Get Started tab never goes away.
//
// completed_by is set to 'backfilled' deliberately: the database trigger that raises the
// handoff task skips those rows, so this can't text a long-standing client to tell them
// their onboarding is finished.
window.markOnboardingComplete = async function() {
    if (currentUserRole !== 'admin' || cSelectedAccount === 'ALL') return;

    const steps = activeOnboardingSteps(cSelectedAccount);
    const missing = steps.filter(s => !onboardingProgressFor(cSelectedAccount, s.id)?.completed_at);
    if (!missing.length) return;

    if (!confirm(`Tick off ${missing.length} client step${missing.length === 1 ? '' : 's'} for ${cSelectedAccount}?\n\nUse this for a client who onboarded before the portal existed. It hides their Get Started tab and won't notify them.`)) return;

    const btn = document.getElementById('c-onboarding-backfill');
    const original = btn ? btn.innerHTML : '';
    if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; btn.disabled = true; }

    try {
        const now = new Date().toISOString();
        const rows = missing.map(s => ({
            client_name: cSelectedAccount,
            step_id: s.id,
            completed_at: now,
            completed_by: 'backfilled'
        }));

        const { data, error } = await supabaseClient.from('client_onboarding_progress')
            .upsert(rows, { onConflict: 'client_name,step_id' }).select();
        if (error) throw error;

        if (data?.length) globalOnboardingProgress.push(...data);
        renderClientOnboarding();
    } catch (err) {
        alert("Could not mark those steps complete: " + err.message);
    } finally {
        if (btn) { btn.innerHTML = original; btn.disabled = false; }
    }
};

        function renderClientOnboarding() {
            const box = document.getElementById('c-onboarding-box');
            const list = document.getElementById('c-onboarding-list');
            if (!box || !list) return;

            const items = cSelectedAccount === "ALL" ? [] : allOnboardingItems(cSelectedAccount);
            if (cSelectedAccount === "ALL" || !items.length) { box.classList.add('hidden'); return; }
            box.classList.remove('hidden');

            const clientTasks = globalTasksData.filter(t =>
                normalize(t.client || '') === normalize(cSelectedAccount) && t.stage === 'Onboarding');
            const taskByTitle = new Map(clientTasks.map(t => [String(t.title || '').trim().toLowerCase(), t]));

            const isDone = item => item.owner === 'agency'
                ? taskByTitle.get(String(item.title || '').trim().toLowerCase())?.status === 'Complete'
                : !!onboardingProgressFor(cSelectedAccount, item.id)?.completed_at;

            const done = items.filter(isDone).length;
            const summary = document.getElementById('c-onboarding-summary');
            if (summary) summary.innerText = `${done} of ${items.length} complete`;

            // Offered only where it's the right tool: a client who joined before the
            // portal existed has no progress rows at all, so every step reads outstanding
            // and their Get Started tab won't go away on its own.
            const backfill = document.getElementById('c-onboarding-backfill');
            if (backfill) {
                const clientSteps = items.filter(i => i.owner !== 'agency');
                const outstanding = clientSteps.filter(i => !isDone(i)).length;
                backfill.classList.toggle('hidden', !(currentUserRole === 'admin' && outstanding > 0));
            }

            // The first outstanding item — whoever it's waiting on
            const blocker = items.find(i => !isDone(i));

            list.innerHTML = items.map(item => {
                const complete = isDone(item);
                const isBlocker = !complete && item.id === blocker?.id;
                const mine = item.owner === 'agency';

                let state = '', tint = '';
                if (mine) {
                    const task = taskByTitle.get(String(item.title || '').trim().toLowerCase());
                    if (complete) state = `<span class="text-emerald-400"><i class="fa-solid fa-check mr-1"></i>Done</span>`;
                    else if (!task) state = `<span class="text-gray-600">No task yet</span>`;
                    else state = `<span class="text-gray-400">${escapeHTML(task.status || 'Not Started')}${task.due ? ` &middot; due ${task.due}` : ''}</span>`;
                } else {
                    const p = onboardingProgressFor(cSelectedAccount, item.id);
                    if (complete) {
                        state = `<span class="text-emerald-400"><i class="fa-solid fa-check mr-1"></i>${new Date(p.completed_at).toLocaleDateString()}</span>`;
                    } else if (p?.watch_percent) {
                        state = `<span class="text-amber-400">${p.watch_percent}% watched, stopped</span>`;
                        tint = 'bg-amber-500/5';
                    } else {
                        state = `<span class="text-gray-500">Not started</span>`;
                    }
                }
                if (isBlocker && !tint) tint = mine ? 'bg-purple-500/5' : 'bg-blue-500/5';

                const ownerBadge = mine
                    ? '<span class="text-[9px] uppercase tracking-widest text-purple-400 shrink-0">Us</span>'
                    : '<span class="text-[9px] uppercase tracking-widest text-blue-400 shrink-0">Client</span>';

                return `<div class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-white/5 ${tint}">
                    <div class="flex items-center gap-2 min-w-0">
                        ${isBlocker ? '<i class="fa-solid fa-arrow-right text-blue-400 text-[10px] shrink-0" title="Waiting on this"></i>' : '<span class="w-3 shrink-0"></span>'}
                        ${ownerBadge}
                        <span class="text-sm truncate ${complete ? 'text-gray-500 line-through' : 'text-white'}">${escapeHTML(item.title)}</span>
                        ${mine && item.auto_check ? '<i class="fa-solid fa-bolt text-emerald-400/70 text-[10px] shrink-0" title="Golden Eye ticks this off itself when it sees it done"></i>' : ''}
                    </div>
                    <div class="text-[11px] whitespace-nowrap">${state}</div>
                </div>`;
            }).join('') + clientAnswersHtml(cSelectedAccount);
        }

        // What the client answered on built-in Questions steps, under their onboarding list.
        // Question wording comes from the answer itself, so it still reads right after the
        // question is reworded or removed. Copy puts plain text on the clipboard (for Cuppa).
        const obAnswerText = {};
        function clientAnswersHtml(clientName) {
            const mine = globalOnboardingAnswers.filter(a => normalize(a.client_name) === normalize(clientName));
            if (!mine.length) return '';
            return mine.map(a => {
                const step = globalOnboardingSteps.find(s => s.id === a.step_id);
                const title = step?.title || 'Onboarding questions';
                // In the step's question order where the question still exists, then any others
                const order = (Array.isArray(step?.questions) ? step.questions : []).map(q => q.id);
                const entries = Object.entries(a.answers || {})
                    .sort(([x], [y]) => (order.indexOf(x) + 1 || 999) - (order.indexOf(y) + 1 || 999));
                const show = v => Array.isArray(v) ? v.join(', ') : String(v ?? '');
                obAnswerText[a.step_id] = `${title} (${clientName})\n\n` + entries.map(([, e]) => `${e.label}\n${show(e.value)}`).join('\n\n');
                const when = new Date(a.updated_at || a.submitted_at).toLocaleDateString();
                return `<details class="mt-3 rounded-lg border border-white/5 bg-black/20">
                    <summary class="cursor-pointer px-3 py-2 text-sm text-white flex items-center justify-between gap-3">
                        <span><i class="fa-solid fa-clipboard-list text-blue-400 mr-2"></i>${escapeAttr(title)} &mdash; answers</span>
                        <span class="text-[11px] text-gray-500">${escapeAttr(when)}</span>
                    </summary>
                    <div class="px-3 pb-3 space-y-3">
                        ${entries.map(([, e]) => `<div>
                            <p class="text-[11px] text-gray-500">${escapeAttr(e.label)}</p>
                            <p class="text-sm text-gray-200 whitespace-pre-wrap">${escapeAttr(show(e.value))}</p>
                        </div>`).join('') || '<p class="text-sm text-gray-500">Submitted with nothing filled in.</p>'}
                        <button type="button" onclick="copyClientAnswers('${a.step_id}', this)" class="text-xs text-blue-400 hover:text-blue-300 font-bold">
                            <i class="fa-solid fa-copy mr-1"></i> Copy answers
                        </button>
                    </div>
                </details>`;
            }).join('');
        }

        window.copyClientAnswers = async function(stepId, btn) {
            try {
                await navigator.clipboard.writeText(obAnswerText[stepId] || '');
                btn.innerHTML = '<i class="fa-solid fa-check mr-1"></i> Copied';
            } catch {
                btn.innerText = "Couldn't copy. Select the text instead.";
            }
        };

        // A one-off task for this client only — something that came up for them and
        // doesn't belong in the template every future client inherits.
        window.addAdhocOnboardingTask = async function() {
            if (currentUserRole !== 'admin' || cSelectedAccount === "ALL") return;

            const title = prompt(`Add an onboarding task for ${cSelectedAccount}:`);
            if (!title || !title.trim()) return;

            const due = new Date();
            due.setDate(due.getDate() + 7);

            const { error } = await supabaseClient.from('tasks').insert([{
                client: cSelectedAccount,
                title: title.trim(),
                type: 'Checklist',
                stage: 'Onboarding',
                status: 'Not Started',
                p: 3, u: 3, e: 3, score: 60,
                due: due.toISOString().split('T')[0],
                updated_at: new Date().toISOString()
            }]);

            if (error) { alert("Could not add the task: " + error.message); return; }

            await fetchAllGlobalData(globalAllowedClients);
            renderClientOnboarding();
            if (!document.getElementById('page-tasks').classList.contains('hidden')) initTasksPage();
        };

        function openHealthDrawer() {
            document.getElementById('h-client-name').innerText = cSelectedAccount;
            
            // Prefill from a rolling 4-week window of check-ins.
            const HEALTH_WINDOW_WEEKS = 4;
            const windowCheckins = recentCheckins(cSelectedAccount, HEALTH_WINDOW_WEEKS);
            const autoAppts = sumCheckins(windowCheckins, 'estimates_count');
            const autoDeals = sumCheckins(windowCheckins, 'closes_count');
            const windowRevenue = sumCheckins(windowCheckins, 'revenue_total');

            // Math.max so a staff correction is never clobbered by a lower reported figure
            const finalAppts = Math.max(dbClientHealth.appts_vol || 0, autoAppts);
            const finalDeals = Math.max(dbClientHealth.deals_closed || 0, autoDeals);

            const checkinHint = document.getElementById('h-checkin-hint');
            if (checkinHint) {
                checkinHint.innerHTML = windowCheckins.length
                    ? `<i class="fa-solid fa-comment-sms mr-1 text-blue-400"></i> Prefilled from ${windowCheckins.length} check-in${windowCheckins.length === 1 ? '' : 's'} over the last ${HEALTH_WINDOW_WEEKS} weeks${windowRevenue ? ` &middot; $${windowRevenue.toLocaleString()} reported` : ''}`
                    : `<i class="fa-solid fa-comment-slash mr-1 text-gray-600"></i> No check-ins in the last ${HEALTH_WINDOW_WEEKS} weeks &mdash; scoring will use whatever you enter here.`;
            }

            document.getElementById('h-date').value = dbClientHealth.last_comm_date || new Date().toISOString().split('T')[0]; 
            document.getElementById('h-ghl').value = dbClientHealth.ghl_usage || 3; 
            document.getElementById('ghl-val').innerText = dbClientHealth.ghl_usage || 3; 
            document.getElementById('h-leads').value = currentAdsStats.l > 0 ? currentAdsStats.l : (dbClientHealth.leads_vol || 0); 
            document.getElementById('h-appts').value = finalAppts; 
            document.getElementById('h-deals').value = finalDeals;
            
            document.getElementById('h-manual-override').value = dbClientHealth.manual_override !== null ? dbClientHealth.manual_override : '';
            document.getElementById('h-note').value = dbClientHealth.note || '';

            const ml = document.getElementById('h-milestones'); ml.innerHTML=''; dbMilestones.forEach(m=>{ const chk=dbClientMilestones.some(c=>c.milestone_id===m.id)?'checked':''; ml.innerHTML+=`<div class="glass p-3 flex justify-between items-center"><span class="text-sm text-white">${m.name} <span class="text-[10px] text-gray-500 ml-1">(Day ${m.target_days})</span></span><input type="checkbox" class="row-checkbox m-cb" value="${m.id}" ${chk}></div>`; });
            document.getElementById('drawer-overlay').classList.add('show'); document.getElementById('health-drawer').classList.add('open');
        }
window.renderClientReports = async function() {
            // 1. Log what client the app THINKS it is searching for
            console.log("--> Searching Supabase reports for client:", cSelectedAccount);
            
            const tbody = document.getElementById('client-reports-list');
            if (cSelectedAccount === "ALL") {
                tbody.innerHTML = '<tr><td colspan="3" class="p-8 text-center text-gray-500 italic">Please select a specific client from the dropdown to view reports.</td></tr>';
                return;
            }

            tbody.innerHTML = '<tr><td colspan="3" class="p-8 text-center"><i class="fa-solid fa-spinner fa-spin text-blue-400 text-xl"></i></td></tr>';

            try {
                // 2. Make the search extremely forgiving using wildcards (%)
                const { data, error } = await supabaseClient
                    .from('weekly_reports')
                    .select('*')
                    .ilike('client_name', `%${cSelectedAccount}%`)
                    .order('created_at', { ascending: false });
                
                // 3. Log EXACTLY what Supabase sends back
                console.log("--> Supabase Response:", { data, error });

                if (error) throw error;
                
                if (!data || data.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="3" class="p-8 text-center text-gray-500 italic">No saved reports found for this client.</td></tr>';
                    return;
                }

                // The notes typed when each report was generated. Admin-only table, so an error
                // (including the table not existing yet) just means no notes are shown.
                const notesById = {};
                const { data: inputs, error: inputsErr } = await supabaseClient
                    .from('weekly_report_inputs')
                    .select('report_id, notes')
                    .in('report_id', data.map(r => r.id));
                if (inputsErr) console.warn("Couldn't load report notes:", inputsErr.message);
                (inputs || []).forEach(i => { notesById[i.report_id] = i.notes; });
                data.forEach(r => { r.typed_notes = notesById[r.id] || ''; });

                let html = '';
                data.forEach(r => {
                    const date = new Date(r.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
                    const snippet = r.report_body ? r.report_body.substring(0, 90).replace(/\n/g, ' ') + '...' : 'No text summary available';
                    const notesLine = r.typed_notes
                        ? `<div class="mt-2 text-amber-300/90 whitespace-pre-wrap"><i class="fa-solid fa-pen-to-square mr-1"></i><span class="font-bold">You typed:</span> ${escapeAttr(r.typed_notes)}</div>`
                        : '';

                    html += `<tr class="hover:bg-white/5 transition border-b border-white/5">
                        <td class="p-4 text-gray-300 font-bold whitespace-nowrap align-top">${date}</td>
                        <td class="p-4 text-gray-400 text-xs w-full">${escapeAttr(snippet)}${notesLine}</td>
                        <td class="p-4 text-right whitespace-nowrap">
                            <button onclick="sendSavedReportToMake(${r.id}, this)" class="text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 px-3 py-1.5 rounded mr-2 transition" title="Send to Drafts"><i class="fa-solid fa-paper-plane text-xs mr-1"></i> Draft</button>
                            <button onclick="openEditReportModal(${r.id})" class="text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 px-3 py-1.5 rounded mr-2 transition"><i class="fa-solid fa-pen text-xs"></i> Edit</button>
                            <button onclick="deleteSavedReport(${r.id})" class="text-red-400 bg-red-500/10 hover:bg-red-500/20 px-3 py-1.5 rounded transition"><i class="fa-solid fa-trash text-xs"></i></button>
                        </td>
                    </tr>`;
                });
                tbody.innerHTML = html;
                window.currentClientReports = data; 
            } catch(err) {
                console.error("Error fetching reports:", err);
                tbody.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-red-400">Error: ${err.message}</td></tr>`;
            }
        };

        // --- REPORTING LOGIC ---
        function openReportModal() { 
    if(cSelectedAccount === 'ALL') {
        alert("Please select a specific client from the dropdown first to create a report.");
        return;
    }

    // THE FIX: Pull the modal out of the hidden Client Portal and put it in the visible wrapper
    // This keeps your fonts/colors perfectly intact!
    const modal = document.getElementById('report-modal');
    if (modal.parentElement.id !== 'theme-wrapper') {
        document.getElementById('theme-wrapper').appendChild(modal);
    }

    // Populate the data
    document.getElementById('rpt-account-title').innerText = cSelectedAccount;
    document.getElementById('rpt-kpi-spend').innerText = '$' + (currentAdsStats.s || 0).toLocaleString(undefined, {maximumFractionDigits:0}); 
    document.getElementById('rpt-kpi-leads').innerText = currentAdsStats.l || 0; 
    document.getElementById('rpt-kpi-cpl').innerText = '$' + (currentAdsStats.cpl || 0).toFixed(2);
    document.getElementById('rpt-kpi-cpc').innerText = '$' + (currentAdsStats.cpc || 0).toFixed(2); 
    
    document.getElementById('rpt-improving').value = '';
    const nextWeekBox = document.getElementById('rpt-next-week');
    if (nextWeekBox) nextWeekBox.value = '';
    document.getElementById('rpt-results').style.display = 'none'; 
    
    // Show the modal
    modal.style.display = 'flex';
}

        async function generateReport() {
            const n = document.getElementById('rpt-improving').value.trim();
            const b = document.getElementById('rpt-gen-btn');
            b.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Generating AI Report...';
            b.disabled = true;

            const dateRangeLabel = document.getElementById('c-date-label') ? document.getElementById('c-date-label').innerText : 'Selected Range';

            // ---- Real trend, computed here — never the model's own past prose.
            // The old "memory" mechanism handed the model LAST WEEK'S GENERATED EMAIL
            // and told it to "reference the historical context to show trends." Every
            // report was written by riffing on its own prior output, which is exactly
            // the mechanism that made these converge on the same phrasing week after
            // week. A real percentage against last period's actual numbers, computed
            // in code rather than left for the model to guess at, fixes that at the
            // root — same principle as everywhere else in this app: the model narrates
            // a fact, it never calculates one.
            const { s, e } = dateRangeFor(cDateRange, cCustomStart, cCustomEnd);
            const spanDays = Math.round((e - s) / 86400000) + 1;
            const priorEnd = new Date(s); priorEnd.setDate(priorEnd.getDate() - 1);
            const priorStart = new Date(priorEnd); priorStart.setDate(priorStart.getDate() - spanDays + 1);

            const priorRows = reportsForClient(cSelectedAccount).filter(r => {
                if (!r.date) return false;
                const rd = new Date(r.date.split('T')[0] + 'T12:00:00');
                return rd >= priorStart && rd <= priorEnd;
            });
            let priorSpend = 0, priorLeads = 0, priorImp = 0, priorClk = 0;
            const priorActiveDays = new Set();
            priorRows.forEach(r => {
                const sp = parseFloat(r.spend || 0);
                priorSpend += sp; priorLeads += parseInt(r.leads || 0);
                // Same fields currentAdsStats.ctr is built from, so the two CTRs compare like for like
                priorImp += parseInt(r.impressions || 0); priorClk += parseInt(r.unique_link_clicks || 0);
                if (sp > 0) priorActiveDays.add(r.date.split('T')[0]);
            });
            const priorCtr = priorImp > 0 ? (priorClk / priorImp) * 100 : null;
            const priorCpl = priorLeads > 0 ? priorSpend / priorLeads : null;
            // The prior period only counts as a comparison if ads actually ran through most of
            // it. A week the client was paused for, or had two days of spend in, isn't "last
            // week" in any useful sense. Comparing against it prints "+400% leads" for a client
            // who simply switched back on. In that case this period is a new baseline instead:
            // numbers stated plainly, no percentages, and next week compares against this one.
            const minActiveDays = Math.ceil(spanDays * 0.7);
            const hasPriorData = priorActiveDays.size >= minActiveDays;

            const pctChange = (now, was) => (!was) ? null : ((now - was) / was) * 100;
            const fmtPct = (v) => v === null ? 'n/a' : `${v > 0 ? '+' : ''}${v.toFixed(0)}%`;
            const spendDelta = hasPriorData ? pctChange(currentAdsStats.s || 0, priorSpend) : null;
            const leadsDelta = hasPriorData ? pctChange(currentAdsStats.l || 0, priorLeads) : null;
            // A period with no leads has no CPL, not a CPL of $0, which would read as "-100%"
            const cplDelta   = (hasPriorData && priorCpl !== null && currentAdsStats.l > 0) ? pctChange(currentAdsStats.cpl || 0, priorCpl) : null;
            const ctrDelta   = (hasPriorData && priorCtr) ? pctChange(currentAdsStats.ctr || 0, priorCtr) : null;

            // The tiles' trend pills are built here, text AND color, and pasted into the template
            // below. The model used to pick them: CPL was always orange (a drop in cost per lead
            // looked like a warning), and CTR got an invented "Steady" with no comparison behind it.
            // good = which direction is good news. Spend has none: more budget isn't better or worse.
            const trendPill = (delta, good) => {
                const tone = !hasPriorData ? 'none'
                    : delta === null ? 'none'
                    : Math.abs(delta) < 3 || !good ? 'flat'
                    : (good === 'up') === (delta > 0) ? 'better' : 'worse';
                const colors = { better: ['#e8f5e9', '#1b7f3b'], worse: ['#fff3e0', '#e65100'], flat: ['#f2f2f7', '#515154'], none: ['#f2f2f7', '#515154'] }[tone];
                const text = !hasPriorData ? 'New baseline' : delta === null ? 'No comparison' : `${fmtPct(delta)} vs last period`;
                return `<div style="display: inline-block; background-color: ${colors[0]}; color: ${colors[1]}; font-size: 13px; font-weight: 600; padding: 6px 12px; border-radius: 8px;">${text}</div>`;
            };
            const pillLeads = trendPill(leadsDelta, 'up');
            const pillSpend = trendPill(spendDelta, null);
            const pillCpl   = trendPill(cplDelta, 'down');
            const pillCtr   = trendPill(ctrDelta, 'up');

            // The same change in everyday words, for the casual "Hi team," summary. The report's
            // tiles already show the exact percentages, so the summary shouldn't read them out
            // again. Worked out here, because "+100%" is double, not "a 200% increase", and the
            // model is never trusted to do that conversion itself.
            const casualChange = (now, was) => {
                if (!was || now == null) return 'no comparison';
                const r = now / was;
                const pct = Math.round(Math.abs(r - 1) * 100 / 5) * 5;
                if (r >= 3.75) return `roughly ${Math.round(r)} times as much`;
                if (r >= 2.75) return 'about triple';
                if (r >= 2.25) return 'about two and a half times as much';
                if (r >= 1.8)  return 'about double';
                if (r >= 1.4)  return `about ${pct}% more (well up)`;
                if (r >= 1.05) return `a bit more (about ${pct}% up)`;
                if (r > 0.95)  return 'about the same';
                if (r > 0.6)   return `a bit less (about ${pct}% down)`;
                if (r > 0.4)   return 'about half';
                if (r > 0.28)  return 'about a third';
                if (r > 0)     return 'a small fraction of it';
                return 'none at all';
            };

            const trendBlock = hasPriorData
                ? `PREVIOUS PERIOD (the ${spanDays} day${spanDays === 1 ? '' : 's'} immediately before this range):
- Spend: $${priorSpend.toFixed(2)} | Leads: ${priorLeads} | CPL: ${priorCpl !== null ? '$' + priorCpl.toFixed(2) : 'n/a (no leads)'}

COMPUTED CHANGE vs previous period — use these exact figures for any trend you state, never calculate your own:
- Spend: ${fmtPct(spendDelta)} | Leads: ${fmtPct(leadsDelta)} | CPL: ${fmtPct(cplDelta)}

SAME CHANGE IN EVERYDAY WORDS (this period compared with the previous one), for the casual email_summary only:
- Spend: ${casualChange(currentAdsStats.s || 0, priorSpend)} | Leads: ${casualChange(currentAdsStats.l || 0, priorLeads)} | CPL: ${priorCpl !== null && currentAdsStats.l ? casualChange(currentAdsStats.cpl || 0, priorCpl) : 'no comparison'}`
                : `NEW BASELINE: ads ran on only ${priorActiveDays.size} of the ${spanDays} days before this range (paused, not yet launched, or otherwise not running), so there is no fair previous period to compare against.
Treat this period as a fresh starting point. State every number plainly as where things stand now. Do NOT give any percentage change, and do NOT describe anything as up, down, better, worse, recovered or improved compared with before. Don't dwell on the gap or apologize for it. At most, say once in passing that this is the new baseline future weeks will be measured against.`;

            // ---- This week's work, computed directly from tasks — the same source
            // client-summary reads, not its finished paragraph. A pre-written summary
            // is one fused blob of prose and can't be selectively trimmed; the client
            // wants exact control ("if we did nothing, don't say what we did — but
            // still say what's next" / "if there's truly nothing, say nothing"), which
            // only works by deciding in code what facts the model is even given, then
            // telling it plainly what each combination means. Same principle as every
            // other AI feature in this app: never hand the model something to
            // reinterpret or negate, just withhold the fact it shouldn't mention.
            const wantClient = normalize(cSelectedAccount);
            // Hidden tasks never reach the report: it's written for the client
            const clientTasks = globalTasksData.filter(t =>
                normalize(t.client || '') === wantClient && t.type !== 'Client Request' && t.client_visible !== false);

            const completedTasks = clientTasks.filter(t => {
                if (t.status !== 'Complete' || !t.updated_at) return false;
                const d = new Date(t.updated_at);
                return d >= s && d <= e;
            });
            // ---- Next week's to-dos, typed into the report window. Each becomes a real task now,
            // before the model runs, so the report never promises work that isn't on the board.
            // Deduped on title against this client's open tasks, so regenerating a report
            // doesn't file the same to-do twice.
            const todoKey = (t) => stripSlashEscapes(String(t || '')).toLowerCase().replace(/\s+/g, ' ').trim();
            const plannedTodos = [];
            for (const line of (document.getElementById('rpt-next-week')?.value || '').split('\n')) {
                const title = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
                if (title && !plannedTodos.some(t => todoKey(t) === todoKey(title))) plannedTodos.push(title);
            }
            if (plannedTodos.length) {
                const clientRow = globalClientsData.find(c => normalize(c.name) === wantClient);
                const openKeys = new Set(globalTasksData
                    .filter(t => normalize(t.client || '') === wantClient && t.status !== 'Complete')
                    .map(t => todoKey(t.title)));
                const due = new Date(); due.setDate(due.getDate() + 7);
                const dueYmd = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
                const rows = plannedTodos.filter(t => !openKeys.has(todoKey(t))).map(title => ({
                    client: clientRow?.name || cSelectedAccount,
                    title,
                    type: 'One-off',
                    stage: clientRow?.current_stage || null,
                    status: 'Not Started',
                    assignee: 'Account Manager',
                    p: 3, u: 4, e: 3,
                    score: Math.round(((3 * 0.4) + (4 * 0.4) + ((6 - 3) * 0.2)) * 20),
                    due: dueYmd,
                    notes: `Planned in the weekly report for ${cSelectedAccount} (${dateRangeLabel}).`,
                    updated_at: new Date().toISOString()
                }));
                if (rows.length) {
                    const { data: createdTodos, error: todoErr } = await supabaseClient.from('tasks').insert(rows).select();
                    if (todoErr) {
                        // Stop here: a report listing to-dos that were never created is worse than no report
                        alert("Couldn't create next week's tasks, so the report wasn't generated: " + todoErr.message);
                        b.innerHTML = "Generate Report";
                        b.disabled = false;
                        return;
                    }
                    globalTasksData.push(...(createdTodos || []));
                }
            }
            const plannedKeys = new Set(plannedTodos.map(todoKey));

            // Planned to-dos are listed in their own block, so they aren't repeated in the open list
            const openTasks = clientTasks.filter(t => t.status !== 'Complete' && !plannedKeys.has(todoKey(t.title)));

            // Task TITLES only. Due dates, assignees, priorities and types are internal bookkeeping,
            // and the client report explains the work in plain language without them. (Due labels
            // used to be passed so the model couldn't call an overdue task "on track". Now it never
            // talks about timing at all, which removes that risk too.)
            let workBlock = '';
            if (completedTasks.length) {
                workBlock += `\n\nCOMPLETED THIS PERIOD (internal task titles):\n${completedTasks.map(t => `- ${stripSlashEscapes(t.title)}`).join('\n')}`;
            }
            if (openTasks.length) {
                workBlock += `\n\nCURRENTLY OPEN / STILL TO DO (internal task titles):\n${openTasks.map(t => `- ${stripSlashEscapes(t.title)}`).join('\n')}`;
            }
            if (plannedTodos.length) {
                workBlock += `\n\nPLANNED FOR NEXT WEEK (internal to-dos set by the media buyer; EVERY one must be covered in "working_on"):\n${plannedTodos.map(t => `- ${t}`).join('\n')}`;
            }

            // "What We're Working On" is always in the report, and it's built in code from the
            // model's "working_on" list, not written into the HTML by the model. The model rewrites
            // each task for the client and names which to-dos an item covers, so code can prove
            // every planned to-do made it in, and the wording can still be natural. With nothing
            // to list, the fixed default below is used, and the model never writes its own
            // "we're watching the account" filler.
            const WORKING_ON_DEFAULT_HEADLINE = 'Managing Your Campaigns';
            const WORKING_ON_DEFAULT_DETAILS = "We're actively monitoring and managing your ads — keeping a close eye on lead volume, cost per lead, and how each ad is performing, and making adjustments as the numbers call for them.";
            const WORKING_ON_MARKER = '{{WORKING_ON_BLOCKS}}';

            // ---- SEO, from seo_daily (Search Console via seo-sync), only for a client connected to
            // it. This used to read globalSeoData, the legacy seo_metrics table from Make #2. That
            // table is silently cut off at PostgREST's 1000-row cap and averages position
            // unweighted, and on 2026-09-14 it put "16 clicks, 943 impressions" into a PANDEN report
            // whose notes said 32 and 2.25K. No seo_daily rows means no SEO block at all, and SEO
            // then comes only from the notes.
            const seoBlock = await buildReportSeoBlock(cSelectedAccount, s, e);

            // SEO gets its own required section whenever there's anything to say, decided here
            // rather than left to the model. On 2026-09-14 a report dropped SEO entirely even
            // though the notes said "for seo, we got 32 clicks and 2.25K impressions": it filled
            // its two or three highlights with ads and moved on.
            const notesMentionSeo = /\b(seo|organic|search console|impressions?|rank(ing|ed|s)?|keywords?|google search|ai (mentions?|overviews?|search)|mentioned)\b/i.test(n);
            const includeSeoSection = !!seoBlock || notesMentionSeo;
            const seoSectionTemplate = includeSeoSection ? `
            [REQUIRED — Organic Search section. Every SEO fact from the MEDIA BUYER'S NOTES goes here, exactly as written (clicks, impressions, AI mentions, rankings, anything), plus the ORGANIC SEARCH data above for anything the notes don't cover. Lead with what it meant for their business (visits, leads, jobs), then rankings, then the work that went live and what's next. Use the words "visits from Google" rather than "clicks", and name a search in plain language rather than saying "keyword". One div block per fact or closely related group:]
            <tr><td style="height: 24px; font-size: 24px; line-height: 24px;">&nbsp;</td></tr>
            <tr><td style="background-color: #ffffff; border-radius: 18px; padding: 48px; border: 1px solid #e5e5ea;"><h2 style="font-size: 28px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 24px 0; color: #1d1d1f;">Organic Search</h2>
            <div style="padding: 20px 0; border-bottom: 1px solid #e8e8ed;"><div style="font-size: 17px; font-weight: 600; margin-bottom: 8px; color: #1d1d1f;">[SEO Headline]</div><div style="font-size: 15px; color: #515154; line-height: 1.6;">[SEO Details]</div></div>
            </td></tr>` : '';

            const p = `You are an expert, highly transparent Senior Media Buyer writing a weekly update for a client.

            CLIENT DATA:
            - Client Name: ${cSelectedAccount}
            - Date Range: ${dateRangeLabel}
            - Spend: $${(currentAdsStats.s || 0).toFixed(2)}
            - Leads: ${currentAdsStats.l || 0}
            - CPL: $${(currentAdsStats.cpl || 0).toFixed(2)}
            - CPC: $${(currentAdsStats.cpc || 0).toFixed(2)}
            - CTR: ${(currentAdsStats.ctr || 0).toFixed(2)}%

            ${trendBlock}

            ${workBlock}${seoBlock}

            MEDIA BUYER'S NOTES:
            "${n || 'No manual notes provided this week. Draw the highlights and action plan from the data above rather than waiting for more.'}"

            YOUR TASK:
            Return ONLY a JSON object with three keys: "email_summary", "html_report" and "working_on".

            RULES FOR "working_on" (this becomes the What We're Working On section; code builds it):
            - An array of items, each {"headline": "...", "details": "...", "covers": ["..."]}.
            - Rewrite the work for the CLIENT. Internal task titles are shorthand for our own team,
              so turn each into what we're doing for them and why it helps, in plain, friendly
              language. Headline: a few words. Details: one or two sentences. Example: the internal
              to-do "Launch the 3 winning ads at a higher budget" becomes headline "Scaling your best
              ads", details "Three of the new ads brought in leads well below your average cost, so
              we're putting more of your budget behind them."
            - Never mention due dates, deadlines, days of the week, assignees, who on our team is doing
              it, priority, task types, scores or internal tool names. Explain the work, not the
              bookkeeping.
            - Never invent specifics a task doesn't imply. Explaining why it helps is fine, but
              don't add numbers, results or promises that aren't in the task, the data or the notes.
            - What goes in: EVERY item from PLANNED FOR NEXT WEEK, then open tasks from CURRENTLY OPEN /
              STILL TO DO that are worth telling a client about (skip pure internal admin), then any
              specific next step from the notes. Related items can share one entry.
            - "covers": the exact text of each PLANNED FOR NEXT WEEK item the entry covers, copied
              character for character. Use an empty array for entries that cover none. Every planned
              item must appear in some entry's "covers".
            - If there is nothing specific at all (no planned items, no open tasks worth mentioning,
              no next step in the notes), return an empty array. The fixed default text is added for you.
            - In "html_report", leave the ${WORKING_ON_MARKER} marker exactly where it is in the
              template. Don't write that section's content into the HTML yourself.

            THE MEDIA BUYER'S NOTES WIN — follow this exactly:
            - The notes are written by the person running the account, and they know things the data
              above doesn't. Every specific fact or number in the notes goes into the report,
              EXACTLY as written: counts, dollar amounts, clicks, impressions, AI mentions, anything.
              Don't round it, restate it differently, or leave any of it out.
            - When the notes and the data above give different figures for the same thing (SEO
              clicks, say), use the notes' figure and don't mention the other one. They often cover a
              different period or a source the data above doesn't have.
            - The data above only fills in what the notes don't cover.

            WORK STATUS — follow this exactly, it is not optional:
            - A "COMPLETED THIS PERIOD" list above means real work was finished — name it.
            - No "COMPLETED THIS PERIOD" list above means nothing was completed. Do NOT say so.
              Never write anything like "nothing was completed" or "a quiet week on tasks" — just
              skip the topic of completed work entirely and move straight to what's still to do
              or to ad performance. Silence on a topic is not the same as bad news, so do not
              apologize for it or draw attention to its absence.
            - A "CURRENTLY OPEN / STILL TO DO" list above means work is still in motion. It goes in
              "working_on", rewritten for the client, with no dates or timing.
            - Task titles in these lists are internal shorthand. Wherever you mention work (highlights,
              email_summary), describe it in plain client language, never as a pasted task title, and
              never with due dates, assignees or priorities.
            - If NEITHER list appears above, there is nothing to report on work or tasks at all
              this period. Do not mention tasks, work, or projects anywhere in the report — go
              straight from ad performance into the notes or action plan. The one exception is
              the "What We're Working On" section, which always appears (see its rules below).

            HOW TO BE HONEST WITHOUT BEING NEGATIVE:
            State every number plainly regardless of which way it moved — never soften a decline
            into something it isn't, and never manufacture a "win" that isn't in the data above.
            If something got worse, say so plainly, then say what's being done about it — in
            that order. If a number barely moved, say it was a steady, uneventful period; that is
            a completely normal thing to report and needs no dressing up as either a triumph or a
            problem. Ground every specific claim in the numbers, the work lists, or the SEO data
            you were given above — never invent a cause you were not given.

            WHAT MAKES THIS REPORT DIFFERENT FROM LAST WEEK'S:
            Pull the SPECIFIC things that make this period what it was — a task that got
            finished, one that's overdue, a real computed percentage, an SEO number if given.
            Draw highlights from whichever of ad performance, the work lists, or SEO has the
            most concrete, specific material this period — do not default to only ad metrics
            every time. A report with nothing specific in it is a sign the data above went unused.

            NO GENERIC FILLER — this is what makes reports blur together week to week:
            Phrases like "we'll continue to analyze trends," "adjust our strategy accordingly,"
            "monitor performance closely," or any other sentence that could be pasted into any
            report regardless of what happened are banned outright. A closing priority or action
            step must name something SPECIFIC: an actual open task from the list above (explained
            for the client), an actual metric that moved and what will
            be done about it, or a specific manual note. If none of those give you something
            concrete — no open tasks, no meaningful shift in the numbers, no manual notes — do
            not manufacture a closing action step at all. A report that ends after stating the
            numbers plainly is completely fine; it is far better than a sentence that says nothing.
            (The "What We're Working On" section still appears in that case, using its fixed
            default text. That is set out in its own rules below, and it is not a closing action step
            you write yourself.)

            RULES FOR "email_summary":
            This is the short note that sits ABOVE the report in the email. The report right below
            it already shows every number and its exact percentage change on the tiles, so this
            note must not read them out again. Write it the way you'd catch a client up in person.
            - Tone: Casual, conversational, completely honest and direct, like a quick update from
              someone who knows the account. Short sentences. No corporate fluff, no stiff analyst
              language.
            - Format: Start directly with "Hi team," (Do NOT output a "Subject:" line).
            - Changes: Talking about how things moved is good, but in everyday words, never as a
              recited percentage. Use the SAME CHANGE IN EVERYDAY WORDS line above: "we got about
              double the leads", "cost per lead came down a bit", "spend was about the same". Never
              write "a 100% increase" or "+23%". Those numbers live on the tiles. It's fine to
              mention a raw count when it reads naturally ("14 leads this week").
            - When NEW BASELINE is given above, make no comparison at all, casual or otherwise.
            - Insights: This is the place for general insights, meaning the useful "here's what we're
              seeing" observations. Examples: leads came in cheaper even though spend barely moved;
              clicks are up but they aren't turning into leads yet; SEO work that went live; how the
              manual notes explain a number. Every insight must come from the data, work lists, SEO
              data or manual notes above. Never invent a cause, a seasonal trend, or a market
              condition you weren't given. One or two real insights beat several thin ones, and none
              is fine when nothing stands out.
            - If manual notes were provided, work them in naturally.
            - Close with a specific priority or action step only when the data actually supports
              one — see NO GENERIC FILLER above. Otherwise just end; do not force a closing sentence.

            RULES FOR "html_report":
            - Output a complete, copy-safe HTML string based on the data and notes.
            - The four KPI tiles, including their numbers and trend pills, are already filled in
              below. Copy them exactly as given. Never change a tile's number, pill text or colors.
            - The "What We're Working On" section is built from "working_on" (rules above). Keep the
              section and its ${WORKING_ON_MARKER} marker exactly as in the template. If the manual
              notes say what we're doing next (for example "we're testing new ads to find a winner"),
              that belongs in "working_on" as an entry too.
            - Use this EXACT structure and inline styling, but replace the placeholders, highlights, and improvements to match this week's reality:

            <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background-color: #f5f5f7;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f7; padding: 40px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;">
            <tr><td style="background-color: #ffffff; border-radius: 18px; padding: 48px; margin-bottom: 24px; border: 1px solid #e5e5ea;"><div style="font-size: 14px; font-weight: 600; color: #86868b; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px;">${cSelectedAccount}</div><h1 style="font-size: 42px; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 16px 0; color: #1d1d1f;">Weekly Performance</h1><div style="font-size: 17px; color: #86868b; font-weight: 500;">${dateRangeLabel}</div></td></tr>
            <tr><td style="height: 24px; font-size: 24px; line-height: 24px;">&nbsp;</td></tr>
            <tr><td><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td width="280" style="background-color: #ffffff; border-radius: 16px; padding: 32px; vertical-align: top; border: 1px solid #e5e5ea;"><div style="font-size: 13px; font-weight: 600; color: #86868b; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 12px;">TOTAL LEADS</div><div style="font-size: 44px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 8px; color: #1d1d1f;">${(currentAdsStats.l || 0).toLocaleString()}</div>${pillLeads}</td><td width="20" style="width: 20px;"></td>
            <td width="280" style="background-color: #ffffff; border-radius: 16px; padding: 32px; vertical-align: top; border: 1px solid #e5e5ea;"><div style="font-size: 13px; font-weight: 600; color: #86868b; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 12px;">AD SPEND</div><div style="font-size: 44px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 8px; color: #1d1d1f;">$${(currentAdsStats.s || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>${pillSpend}</td>
            </tr></table></td></tr>
            <tr><td style="height: 20px; font-size: 20px; line-height: 20px;">&nbsp;</td></tr>
            <tr><td><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td width="280" style="background-color: #ffffff; border-radius: 16px; padding: 32px; vertical-align: top; border: 1px solid #e5e5ea;"><div style="font-size: 13px; font-weight: 600; color: #86868b; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 12px;">COST PER LEAD</div><div style="font-size: 44px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 8px; color: #1d1d1f;">${currentAdsStats.l > 0 ? "$" + currentAdsStats.cpl.toFixed(2) : "No leads"}</div>${pillCpl}</td><td width="20" style="width: 20px;"></td>
            <td width="280" style="background-color: #ffffff; border-radius: 16px; padding: 32px; vertical-align: top; border: 1px solid #e5e5ea;"><div style="font-size: 13px; font-weight: 600; color: #86868b; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 12px;">CTR (LINK)</div><div style="font-size: 44px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 8px; color: #1d1d1f;">${(currentAdsStats.ctr || 0).toFixed(2)}%</div>${pillCtr}</td>
            </tr></table></td></tr>
            <tr><td style="height: 24px; font-size: 24px; line-height: 24px;">&nbsp;</td></tr>
            <tr><td style="background-color: #ffffff; border-radius: 18px; padding: 48px; border: 1px solid #e5e5ea;"><h2 style="font-size: 28px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 24px 0; color: #1d1d1f;">Highlights</h2>
            [GENERATE 2-3 DIV BLOCKS HERE. Each block format:]
            <div style="padding: 20px 0; border-bottom: 1px solid #e8e8ed;"><div style="font-size: 17px; font-weight: 600; margin-bottom: 8px; color: #1d1d1f;">[Headline]</div><div style="font-size: 15px; color: #515154; line-height: 1.6;">[Explanation]</div></div>
            </td></tr>${seoSectionTemplate}
            [REQUIRED — this block is always included; see the "What We're Working On" rules above:]
            <tr><td style="height: 24px; font-size: 24px; line-height: 24px;">&nbsp;</td></tr>
            <tr><td style="background-color: #ffffff; border-radius: 18px; padding: 48px; border: 1px solid #e5e5ea;"><h2 style="font-size: 28px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 24px 0; color: #1d1d1f;">What We're Working On</h2>
            ${WORKING_ON_MARKER}
            </td></tr>
            </table></td></tr></table></body></html>
            `;

            try {
                const askModel = async (messages) => {
                    const j = await callAiChat(messages);
                    const raw = j.choices[0].message.content;
                    return { raw, parsed: JSON.parse(raw.replace(/```json/gi, '').replace(/```/g, '').trim()) };
                };

                // Every number typed in the notes must survive into the report. Prompt rules alone
                // didn't hold (see includeSeoSection above), so this is checked, not requested: one
                // retry naming exactly what was dropped, then a visible warning if it's still missing.
                // What We're Working On, built from the model's "working_on" list. Text is escaped:
                // it's model output going into an email.
                const workingOnBlock = (headline, details, last) =>
                    `<div style="padding: 20px 0;${last ? '' : ' border-bottom: 1px solid #e8e8ed;'}"><div style="font-size: 17px; font-weight: 600; margin-bottom: 8px; color: #1d1d1f;">${escapeAttr(headline)}</div>${details ? `<div style="font-size: 15px; color: #515154; line-height: 1.6;">${escapeAttr(details)}</div>` : ''}</div>`;
                const finalizeReport = (parsed) => {
                    const items = (Array.isArray(parsed?.working_on) ? parsed.working_on : [])
                        .filter(i => i && String(i.headline || '').trim());
                    const blocks = items.length
                        ? items.map((i, k) => workingOnBlock(String(i.headline).trim(), String(i.details || '').trim(), k === items.length - 1)).join('')
                        : workingOnBlock(WORKING_ON_DEFAULT_HEADLINE, WORKING_ON_DEFAULT_DETAILS, true);
                    const html = String(parsed?.html_report || '');
                    // A planned to-do counts as covered when an entry names it. Compared loosely
                    // (case, spacing, one containing the other), since "character for character"
                    // is asked for but not always delivered.
                    const covers = items.flatMap(i => Array.isArray(i.covers) ? i.covers : []).map(todoKey).filter(Boolean);
                    const uncovered = plannedTodos.filter(t => {
                        const k = todoKey(t);
                        return !covers.some(c => c === k || c.includes(k) || k.includes(c));
                    });
                    return {
                        report: { ...parsed, html_report: html.split(WORKING_ON_MARKER).join(blocks) },
                        hasMarker: html.includes(WORKING_ON_MARKER),
                        uncovered
                    };
                };

                // Every number typed in the notes must survive into the report, and every planned
                // to-do must be covered. Prompt rules alone didn't hold (see includeSeoSection
                // above), so this is checked, not requested: one retry naming exactly what was
                // dropped, then a visible warning if it's still missing.
                const problemsWith = (parsed) => {
                    const f = finalizeReport(parsed);
                    const out = `${f.report.email_summary || ''} ${f.report.html_report}`.toLowerCase().replace(/,/g, '');
                    const facts = [...new Set((n.match(/\$?\d[\d,]*(?:\.\d+)?\s?[km]?%?/gi) || [])
                        .map(x => x.replace(/\s/g, '').replace(/,/g, '').toLowerCase()))];
                    return {
                        f,
                        missing: [
                            ...facts.filter(x => !out.includes(x)),
                            ...f.uncovered.map(t => `the to-do "${t}"`),
                            ...(f.hasMarker ? [] : ['the What We\'re Working On section'])
                        ]
                    };
                };

                const messages = [{ role: "user", content: p }];
                let { raw: rawContent, parsed } = await askModel(messages);
                let { f: finalized, missing } = problemsWith(parsed);
                if (missing.length) {
                    const retry = await askModel([...messages,
                        { role: "assistant", content: rawContent },
                        { role: "user", content: `Your answer left out: ${missing.join(', ')}. Every figure in the MEDIA BUYER'S NOTES must appear in the report exactly as written (SEO facts go in the Organic Search section). Every PLANNED FOR NEXT WEEK item must be named in some "working_on" entry's "covers", rewritten for the client in headline and details. html_report must keep the ${WORKING_ON_MARKER} marker. Return the complete JSON object again with these fixed, changing nothing else.` }
                    ]).catch(() => null);
                    if (retry) {
                        const second = problemsWith(retry.parsed);
                        if (second.missing.length < missing.length) ({ f: finalized, missing } = second);
                    }
                }
                const result = finalized.report;
                if (missing.length) {
                    alert(`Heads up: the report still leaves out these items from your notes or next week's to-dos: ${missing.join(', ')}.\n\nAdd them with Edit before sending.`);
                }

                document.getElementById('rpt-email-output').innerText = result.email_summary; 
                document.getElementById('rpt-html-src').value = result.html_report; 
                document.getElementById('rpt-html-preview').srcdoc = result.html_report;
                document.getElementById('rpt-results').style.display = 'block'; 

                try {
                    const { data: saved, error: saveErr } = await supabaseClient.from('weekly_reports').insert({
                        client_name: cSelectedAccount,
                        report_body: result.email_summary,
                        html_body: result.html_report
                    }).select('id').single();
                    if (saveErr) throw saveErr;
                    // What was typed goes into its own admin-only table, never a weekly_reports
                    // column: the client portal reads that table with select('*'). See
                    // supabase/sql/weekly_report_inputs.sql. A failure here must not lose the
                    // report itself, which is already saved.
                    const typedInput = [n, plannedTodos.length ? `Next week's to-dos:\n${plannedTodos.map(t => `- ${t}`).join('\n')}` : '']
                        .filter(Boolean).join('\n\n');
                    if (typedInput && saved?.id != null) {
                        const { error: notesErr } = await supabaseClient.from('weekly_report_inputs')
                            .insert({ report_id: saved.id, notes: typedInput });
                        if (notesErr) console.warn("Report saved, but its notes weren't:", notesErr.message);
                    }
                    if (!document.getElementById('c-view-reports').classList.contains('hidden')) {
                        window.renderClientReports();
                    }
                } catch (err) {
                    console.warn("Failed to log weekly report to DB");
                }
                
            } catch(e) { 
                alert("Error generating report: " + e.message); 
            } finally { 
                b.innerHTML = "Generate Report"; 
                b.disabled = false; 
            }
        }

        async function sendToMake() {
            const btn = document.getElementById('rpt-draft-btn');
            const originalText = btn.innerHTML;
            
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Sending to Make...';
            btn.disabled = true;

            const emailText = document.getElementById('rpt-email-output').innerText;
            const htmlCode = document.getElementById('rpt-html-src').value;
            const clientName = cSelectedAccount === "ALL" ? "General" : cSelectedAccount;

            const clientReports = reportsForClient(clientName);

            let targetEmail = "";
            const recordWithEmail = clientReports.find(r => r.client_email || r.email);
            if (recordWithEmail) {
                targetEmail = recordWithEmail.client_email || recordWithEmail.email;
            }
            if (!targetEmail) targetEmail = clientEmail || "";

            // FIX: Package multiple emails into a clean, Make-friendly Array
            let emailArray = [];
            if (targetEmail) {
                // Splits by commas, semicolons, or spaces, and removes any empty blanks
                emailArray = targetEmail.split(/[,;\s]+/).filter(e => e.trim() !== "");
            }

            const payload = {
                client: clientName,
                subject: `Weekly Update: ${clientName}`,
                full_email_html: `<div style="white-space: pre-wrap; font-family: sans-serif; font-size: 15px; color: #1d1d1f; margin-bottom: 20px;">${emailText}</div>${htmlCode}`,
                to_email: emailArray // We are now passing the clean Array here
            };

            try {
                await callMakeRelay('report_draft', payload);

                btn.innerHTML = '<i class="fa-solid fa-check mr-2"></i> Draft Created!';
                btn.classList.replace('bg-blue-600', 'bg-green-600');
                btn.classList.replace('hover:bg-blue-500', 'hover:bg-green-500');
                
                setTimeout(() => {
                    btn.innerHTML = originalText;
                    btn.classList.replace('bg-green-600', 'bg-blue-600');
                    btn.classList.replace('hover:bg-green-500', 'hover:bg-blue-500');
                    btn.disabled = false;
                }, 3000);

            } catch (error) {
                alert('Failed to send to Make.com: ' + error.message);
                btn.innerHTML = originalText;
                btn.disabled = false;
            }
        }

        // ============================================================================
        // SEO LOGIC & RENDERING
        // ============================================================================

 // ---- Admin SEO tab (rebuilt 2026-09-11) ----
 // ---- The weekly report's Organic Search facts ----
// Same figures the client's own Organic Search tab shows (seo_client_overview, seo_keyword_summary,
// seo_almost_page_one, seo_changelog), so the report and the tab can never disagree. Everything is
// computed here and handed to the model as text to quote: it never recalculates, the same rule the
// morning audit follows.
//
// Degrades in steps rather than all at once: with the RPCs missing it falls back to seo_daily
// totals, and with no SEO data at all it returns '' and the report has no Organic Search section
// unless the notes mention SEO.
async function buildReportSeoBlock(clientName, s, e) {
    const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    try {
        const { data: clientRows } = await supabaseClient.from('clients').select('name, gsc_property, seranking_site_id, seo_start_date');
        const seoClient = (clientRows || []).find(c => normalize(c.name) === normalize(clientName) && (c.gsc_property || c.seranking_site_id));
        if (!seoClient) return '';

        // floor, not round: the end date carries 23:59, so rounding counted one day too many and
        // compared against a window a day longer than the report's own
        const days = Math.floor((e - s) / 86400000) + 1;
        const priorEnd = new Date(s); priorEnd.setDate(priorEnd.getDate() - 1);
        const priorStart = new Date(priorEnd); priorStart.setDate(priorStart.getDate() - days + 1);
        const range = { p_client: seoClient.name, p_start: ymd(s), p_end: ymd(e), p_prior_start: ymd(priorStart), p_prior_end: ymd(priorEnd) };

        const [ovRes, kwRes, almostRes, logRes, dailyRes] = await Promise.all([
            supabaseClient.rpc('seo_client_overview', range),
            supabaseClient.rpc('seo_keyword_summary', range),
            supabaseClient.rpc('seo_almost_page_one', { ...range, p_min_impressions: Math.max(10, days), p_limit: 5 }),
            supabaseClient.from('seo_changelog').select('live_date, kind, title, url, notes')
                .eq('client_name', seoClient.name).gte('live_date', range.p_start).lte('live_date', range.p_end)
                .order('live_date', { ascending: false }),
            supabaseClient.from('seo_daily').select('date, clicks, impressions, position')
                .eq('client_name', seoClient.name).gte('date', range.p_start).lte('date', range.p_end).order('date')
        ]);

        const daily = dailyRes.data || [];
        const ov = ovRes.data?.[0];
        const num = v => v == null ? null : Number(v);
        const lines = [];

        // Fallback: the client tab's RPCs aren't installed, so report what seo_daily alone knows
        if (!ov) {
            if (!daily.length) return '';
            const t = seoWindowTotals(daily, s, e);
            lines.push(`- Visits from Google (clicks): ${t.clicks.toLocaleString()} | Times shown in search (impressions): ${t.impressions.toLocaleString()} | Average position: ${t.position != null ? t.position.toFixed(1) : 'n/a'}`);
        } else {
            const delta = (cur, prior, noun) => {
                const c = num(cur) || 0, p = num(prior);
                if (p == null) return `${c.toLocaleString()} ${noun}`;
                const diff = c - p;
                // Same noise guard as the client tab: small counts are stated, never turned into a %
                const small = c < 50 || p < 50;
                if (!p) return `${c.toLocaleString()} ${noun} (none the period before)`;
                if (small || !diff) return `${c.toLocaleString()} ${noun} (${p.toLocaleString()} the period before)`;
                return `${c.toLocaleString()} ${noun} (${diff > 0 ? 'up' : 'down'} ${Math.abs(Math.round(diff / p * 100))}% from ${p.toLocaleString()})`;
            };
            lines.push(`- Visits from Google: ${delta(ov.clicks, ov.prior_clicks, 'visits')}`);
            lines.push(`- Times shown in Google: ${delta(ov.impressions, ov.prior_impressions, 'times')}`);
            // Impression-weighted, from seo_daily — the overview doesn't return a GSC position
            if (daily.length) {
                const t = seoWindowTotals(daily, s, e);
                if (t.position != null) lines.push(`- Average position in Google: ${t.position.toFixed(1)}`);
            }

            // Leads only count once lead tracking was live for the whole comparison
            if (range.p_prior_end >= LEAD_TRACKING_START) {
                lines.push(`- Leads from Google (tracked on their website): ${delta(ov.organic_leads, ov.prior_organic_leads, 'leads')}`);
            } else if (range.p_end >= LEAD_TRACKING_START) {
                lines.push(`- Leads from Google (tracked on their website): ${(num(ov.organic_leads) || 0).toLocaleString()} — tracking started ${LEAD_TRACKING_START}, so there is nothing to compare with yet`);
            }
            if (num(ov.google_closes)) lines.push(`- Jobs they told us they closed from Google: ${num(ov.google_closes)}${num(ov.google_revenue) ? ` worth $${Math.round(num(ov.google_revenue)).toLocaleString()}` : ''} (from their own check-ins)`);
            // Only when it's genuinely positive, the same rule as their SEO tab
            if (num(ov.roi_multiple) > 1) lines.push(`- Return on their SEO fee for this period: ${num(ov.roi_multiple).toFixed(1)}x`);
            if (num(ov.keywords_tracked)) {
                lines.push(`- Target searches on page 1 of Google: ${num(ov.keywords_page1) || 0} of ${num(ov.keywords_tracked)} tracked${num(ov.prior_keywords_page1) != null ? ` (was ${num(ov.prior_keywords_page1)})` : ''}`);
            }
            if (num(ov.seo_potential_traffic)) lines.push(`- Room to grow: reaching the top 3 for their targets would be worth about ${Math.round(num(ov.seo_potential_traffic)).toLocaleString()} more visits a month${num(ov.seo_potential_value) ? ` (about $${Math.round(num(ov.seo_potential_value)).toLocaleString()} a month if bought as ads)` : ''}`);
            if (ov.gsc_last_date && String(ov.gsc_last_date).slice(0, 10) < range.p_end) {
                lines.push(`- NOTE: Google reports search data 2–3 days late. Visits are complete through ${String(ov.gsc_last_date).slice(0, 10)} only.`);
            }
        }

        // Ranking movements worth naming, biggest first. A map pack spot counts as ranking.
        const kws = (kwRes.data || []).map(k => ({
            keyword: k.keyword,
            rank: num(k.rank) ?? num(k.map_rank),
            prior: num(k.prior_rank) ?? num(k.prior_map_rank),
            map: num(k.map_rank)
        })).filter(k => k.rank != null);
        const moved = kws.filter(k => k.prior != null && k.prior !== k.rank)
            .sort((a, b) => Math.abs(b.prior - b.rank) - Math.abs(a.prior - a.rank)).slice(0, 5);
        if (moved.length) {
            lines.push(`- Ranking changes this period: ${moved.map(k => `"${k.keyword}" ${k.prior} → ${k.rank}${k.map != null ? ' (in the map pack)' : ''}`).join('; ')}`);
        }
        const top = kws.filter(k => k.rank <= 3).slice(0, 5);
        if (top.length) lines.push(`- Sitting in the top 3 for: ${top.map(k => `"${k.keyword}" (#${k.rank})`).join(', ')}`);

        const almost = (almostRes.data || []).slice(0, 3);
        if (almost.length) {
            lines.push(`- Just off page 1 (page 2, so close to real traffic): ${almost.map(a => `"${a.query}" at position ${Number(a.weighted_position).toFixed(0)}`).join(', ')}`);
        }

        const log = logRes.data || [];
        if (log.length) {
            lines.push(`- SEO WORK THAT WENT LIVE IN THIS PERIOD (say what went live, in their language):`);
            log.slice(0, 12).forEach(x => lines.push(`  • ${x.live_date}: ${x.title}${x.notes ? ` — ${String(x.notes).slice(0, 200)}` : ''}`));
            if (log.length > 12) lines.push(`  • …and ${log.length - 12} more`);
        }

        if (!lines.length) return '';
        return `\n\nORGANIC SEARCH (SEO) — ${range.p_start} to ${range.p_end}, compared with the ${days} days before. Use these figures exactly as given; do not recalculate or round them differently:\n${lines.join('\n')}`;
    } catch (err) {
        console.warn('Report: Organic Search data unavailable, SEO will come from the notes only.', err);
        return '';
    }
}

// ---- The chat agent's SEO briefing ----
// What the Client Intelligence Agent knows about a client's organic search. Until 2026-09-16 it was
// fed seo_metrics, the table Make scenario #2 filled before it was switched off, so every SEO answer
// was built on stale or empty numbers with an unweighted position.
//
// Same principle as the report: code computes, the model quotes. It starts from buildReportSeoBlock
// for the last 28 days (so the chat and a report can't disagree), then adds what an account manager
// asks about and a client report leaves out: a weekly trend long enough to see a change, the work
// logged on dated lines so the model can line work up with the trend, top pages, what moved, wrong
// pages ranking, competitors, the latest site audit and where leads came from.
//
// Each part degrades on its own: a missing function or table drops that section, never the briefing.
// Cached per client for 5 minutes, because the chat rebuilds its system prompt on every message and
// this is about ten queries.
const CHAT_SEO_CACHE_MS = 5 * 60 * 1000;
const chatSeoCache = new Map();

async function buildChatSeoBriefing(clientName) {
    const key = normalize(clientName);
    const hit = chatSeoCache.get(key);
    if (hit && Date.now() - hit.at < CHAT_SEO_CACHE_MS) return hit.text;

    const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const num = v => v == null ? null : Number(v);
    try {
        const { data: clientRows } = await supabaseClient.from('clients').select('name, gsc_property, seranking_site_id, seo_start_date');
        const c = (clientRows || []).find(r => normalize(r.name) === key && (r.gsc_property || r.seranking_site_id));
        if (!c) {
            const none = 'This client has no Search Console property or SE Ranking project connected, so there is no SEO data. Say so if asked about SEO.';
            chatSeoCache.set(key, { at: Date.now(), text: none });
            return none;
        }

        // The last 28 whole days (whole weeks, so weekdays match the 28 before), ending yesterday
        const e = new Date(); e.setHours(23, 59, 59, 999); e.setDate(e.getDate() - 1);
        const s = new Date(e); s.setHours(0, 0, 0, 0); s.setDate(s.getDate() - 27);
        const priorEnd = new Date(s); priorEnd.setDate(priorEnd.getDate() - 1);
        const priorStart = new Date(priorEnd); priorStart.setDate(priorStart.getDate() - 27);
        const trendStart = new Date(s); trendStart.setDate(trendStart.getDate() - 7 * 12);   // 16 weeks in all
        const logStart = new Date(s); logStart.setDate(logStart.getDate() - 7 * 12);
        const range = { p_client: c.name, p_start: ymd(s), p_end: ymd(e), p_prior_start: ymd(priorStart), p_prior_end: ymd(priorEnd) };
        const safe = p => p.then(r => r, err => ({ error: err }));

        const [base, dailyRes, pagesRes, moversRes, kwRes, compRes, auditRes, leadsRes, logRes] = await Promise.all([
            buildReportSeoBlock(c.name, s, e),
            safe(supabaseClient.from('seo_daily').select('date, clicks, impressions, position')
                .eq('client_name', c.name).gte('date', ymd(trendStart)).lte('date', range.p_end).order('date')),
            safe(supabaseClient.rpc('seo_page_summary', { ...range, p_limit: 8 })),
            safe(supabaseClient.rpc('seo_movers', { ...range, p_limit: 5 })),
            safe(supabaseClient.rpc('seo_keyword_summary', range)),
            safe(supabaseClient.rpc('seo_competitor_overview', { p_client: c.name, p_start: range.p_start, p_end: range.p_end })),
            safe(supabaseClient.from('seo_site_audits').select('audit_time, score, pages_crawled, errors, warnings, notices, issues')
                .eq('client_name', c.name).order('audit_time', { ascending: false }).limit(2)),
            safe(supabaseClient.from('lead_sources').select('created_at, source')
                .eq('client_name', c.name).gte('created_at', ymd(priorStart)).lte('created_at', `${range.p_end}T23:59:59`)),
            safe(supabaseClient.from('seo_changelog').select('live_date, kind, title')
                .eq('client_name', c.name).gte('live_date', ymd(logStart)).lte('live_date', range.p_end)
                .order('live_date', { ascending: true }).limit(60))
        ]);

        const parts = [];
        if (c.seo_start_date) parts.push(`SEO work for this client started ${String(c.seo_start_date).slice(0, 10)}.`);
        if (base) parts.push(base.trim());

        // Weekly trend: impression-weighted position per week, never a flat average of daily positions
        const daily = dailyRes.data || [];
        if (daily.length) {
            const weeks = new Map();
            for (const d of daily) {
                const day = new Date(`${String(d.date).slice(0, 10)}T00:00:00`);
                const offset = Math.floor((day - trendStart) / (7 * 86400000));
                if (offset < 0) continue;
                const wk = new Date(trendStart); wk.setDate(wk.getDate() + offset * 7);
                const w = weeks.get(offset) || { start: ymd(wk), clicks: 0, impressions: 0, posWeight: 0, days: 0 };
                const imp = Number(d.impressions) || 0;
                w.clicks += Number(d.clicks) || 0;
                w.impressions += imp;
                if (d.position != null && imp > 0) w.posWeight += Number(d.position) * imp;
                w.days += 1;
                weeks.set(offset, w);
            }
            const rows = [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) =>
                `  ${w.start}: ${w.clicks} visits, ${w.impressions} times shown, position ${w.impressions ? (w.posWeight / w.impressions).toFixed(1) : 'n/a'}${w.days < 7 ? ` (${w.days} days of data)` : ''}`);
            parts.push(`WEEKLY SEARCH CONSOLE TREND (weeks starting on the date shown; Google reports 2–3 days late, so the last week may be incomplete):\n${rows.join('\n')}`);
        }

        const log = logRes.data || [];
        if (log.length) {
            parts.push(`SEO WORK LOGGED, OLDEST FIRST (use these dates to line work up with the weekly trend; SEO effects usually take weeks, so don't claim a same-week cause):\n${log.map(x => `  ${x.live_date} [${x.kind}] ${x.title}`).join('\n')}`);
        }

        const pages = pagesRes.data || [];
        if (pages.length) {
            parts.push(`TOP PAGES, last 28 days (clicks, previous 28 days in brackets):\n${pages.map(p =>
                `  ${seoPagePath(p.page)}: ${num(p.clicks)} clicks (${num(p.prior_clicks) ?? 0}), ${num(p.impressions)} shown, position ${num(p.weighted_position) != null ? num(p.weighted_position).toFixed(1) : 'n/a'}`).join('\n')}`);
        }

        const movers = moversRes.data || [];
        if (movers.length) {
            parts.push(`BIGGEST CLICK CHANGES vs the previous 28 days (only pages/searches with 50+ impressions):\n${movers.map(m =>
                `  ${m.kind === 'page' ? 'Page' : 'Search'} ${m.kind === 'page' ? seoPagePath(m.name) : `"${m.name}"`}: ${num(m.prior_clicks)} → ${num(m.clicks)} clicks`).join('\n')}`);
        }

        const wrong = (kwRes.data || []).filter(r => seoWrongPage(r));
        if (wrong.length) {
            parts.push(`WRONG PAGE RANKING (Google shows a different page than the one we target — a sign of competing pages):\n${wrong.slice(0, 8).map(r =>
                `  "${r.keyword}": ranking ${seoPagePath(r.ranking_url)} instead of ${seoPagePath(r.target_page)}`).join('\n')}`);
        }

        const comps = (compRes.data || []).filter(r => Number(r.keywords_compared) > 0);
        if (comps.length) {
            parts.push(`COMPETITORS (organic rank only — SE Ranking gives no competitor map-pack position, so never say we beat someone in Google Maps; "ahead/behind" counts only searches where both rank):\n${comps.map(r =>
                `  ${r.competitor_name || r.domain}: ${num(r.their_page1)} on page 1, avg rank ${r.their_avg_rank != null ? Number(r.their_avg_rank).toFixed(1) : 'n/a'}, domain trust ${r.domain_trust ?? 'n/a'}; we're ahead on ${num(r.ahead_of_them)}, behind on ${num(r.behind_them)}, and rank alone on ${num(r.not_ranking_them)}`).join('\n')}`);
        }

        const [audit, prevAudit] = auditRes.data || [];
        if (audit) {
            const issues = (Array.isArray(audit.issues) ? audit.issues : []).filter(i => i.severity !== 'notice').slice(0, 6);
            const change = prevAudit?.score != null && audit.score != null ? ` (was ${prevAudit.score} on ${String(prevAudit.audit_time).slice(0, 10)})` : '';
            parts.push(`LATEST SITE AUDIT, ${String(audit.audit_time).slice(0, 10)}: health score ${audit.score}/100${change}, ${audit.errors} errors, ${audit.warnings} warnings, ${audit.pages_crawled} pages crawled.${issues.length ? `\n${issues.map(i => `  ${i.severity}: ${i.name} (${i.count})`).join('\n')}` : ''}`);
        }

        const leads = leadsRes.data || [];
        if (!leadsRes.error && range.p_end >= LEAD_TRACKING_START) {
            const count = (from, to) => {
                const out = {};
                for (const l of leads) {
                    const d = String(l.created_at).slice(0, 10);
                    if (d >= from && d <= to) out[l.source || 'unknown'] = (out[l.source || 'unknown'] || 0) + 1;
                }
                return out;
            };
            const fmt = o => Object.keys(o).length ? Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') : 'none';
            parts.push(`WEBSITE LEADS BY SOURCE (lead tracking began ${LEAD_TRACKING_START}; nothing before that was measured, so never compare with earlier periods): last 28 days: ${fmt(count(range.p_start, range.p_end))}${range.p_prior_end >= LEAD_TRACKING_START ? `; previous 28 days: ${fmt(count(range.p_prior_start, range.p_prior_end))}` : ''}`);
        }

        const text = parts.length ? parts.join('\n\n') : 'SEO is connected for this client, but no data has synced yet.';
        chatSeoCache.set(key, { at: Date.now(), text });
        return text;
    } catch (err) {
        console.warn('Chat: SEO briefing unavailable', err);
        return 'SEO data could not be loaded right now. If asked about SEO, say the numbers are unavailable rather than guessing.';
    }
}

// Reads seo_daily / seo_pages_daily / seo_queries_daily (Search Console, via seo-sync),
 // seo_keywords / seo_rank_checks (SE Ranking, via seranking-sync), and lead_sources
 // (organic leads, via ghl-lead-webhook) together for one client at a time. This is
 // deliberately admin-first: the portal tab still reads the legacy seo_metrics table
 // until this is checked out and the client-facing version is built on top of it.
 //
 // No client-side caching, unlike the work-summary/audit patterns elsewhere — seo_daily
 // is at most ~490 rows for a client's full 16-month history (see CLAUDE.md, the
 // 1000-row cap), and the four aggregate calls below already return a handful of rows
 // each, so refetching on every account or date-range change costs nothing worth
 // avoiding, and it means there's no cache-invalidation bug to have.
 //
 // Position is always impression-weighted — sum(position*impressions)/sum(impressions) —
 // never the flat average the old version of this tab computed. seo_daily.position is
 // already Google's own weighted figure for that day, so combining days just needs the
 // same weighting applied again across days.

 function seoIso(d) { return d.toISOString().split('T')[0]; }

 // A day with spend-equivalent zero impressions has no position, not a position of zero
 // — same trap CLAUDE.md documents for the morning audit's CPL math. Carrying a null
 // through here rather than treating it as 0 is what keeps a quiet day from reading as a
 // page-one ranking.
 function seoWindowTotals(daily, s, e) {
     let clicks = 0, impressions = 0, posWeighted = 0;
     daily.forEach(r => {
         const rd = new Date(r.date + 'T12:00:00');
         if (rd < s || rd > e) return;
         clicks += r.clicks || 0;
         impressions += r.impressions || 0;
         if (r.position != null) posWeighted += r.position * (r.impressions || 0);
     });
     return {
         clicks, impressions,
         ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
         position: impressions > 0 ? posWeighted / impressions : null
     };
 }

 function seoLeadsInWindow(leads, s, e) {
     return leads.filter(l => { const d = new Date(l.created_at); return d >= s && d <= e; }).length;
 }

 // opts.invert: true means a DECREASE is the improvement — position, where a smaller
 // number is better, is the one metric on this tab that needs it.
 function seoDeltaPill(cur, prior, opts) {
     opts = opts || {};
     if (prior === null || prior === undefined || prior === 0 || cur === null) {
         return '<span class="text-gray-500 text-[10px] font-bold">—</span>';
     }
     const delta = ((cur - prior) / prior) * 100;
     if (!isFinite(delta)) return '<span class="text-gray-500 text-[10px] font-bold">—</span>';
     const improved = opts.invert ? delta < 0 : delta > 0;
     const worsened = opts.invert ? delta > 0 : delta < 0;
     const color = Math.abs(delta) < 0.5 ? 'text-gray-500' : (improved ? 'text-emerald-400' : (worsened ? 'text-red-400' : 'text-gray-500'));
     const arrow = delta > 0 ? '▲' : (delta < 0 ? '▼' : '—');
     return `<span class="${color} text-[10px] font-bold">${arrow} ${Math.abs(delta).toFixed(0)}%</span>`;
 }

 async function loadSeoAdminData(clientName) {
     const [dailyRes, leadsRes] = await Promise.all([
         supabaseClient.from('seo_daily').select('date, clicks, impressions, position').eq('client_name', clientName).order('date'),
         supabaseClient.from('lead_sources').select('created_at, source').eq('client_name', clientName)
     ]);
     if (dailyRes.error) console.error('seo_daily load failed:', dailyRes.error);
     if (leadsRes.error) console.error('lead_sources load failed:', leadsRes.error);
     return { daily: dailyRes.data || [], leads: leadsRes.data || [] };
 }

 // Long lists on the admin SEO tab show their first few rows, with a button to see the rest.
 // Open/closed is remembered per list for the session, so changing the date range doesn't keep
 // collapsing a list someone just opened.
 const SEO_LIST_PREVIEW = 3;
 const seoListOpen = {};
 function seoShowMore(host, items, key, noun) {
     if (!host) return;
     const btnId = `seo-more-${key}`;
     let btn = document.getElementById(btnId);
     if (items.length <= SEO_LIST_PREVIEW) {
         items.forEach(el => el.classList.remove('hidden'));
         if (btn) btn.remove();
         return;
     }
     const open = !!seoListOpen[key];
     items.forEach((el, i) => el.classList.toggle('hidden', !open && i >= SEO_LIST_PREVIEW));
     if (!btn) {
         btn = document.createElement('button');
         btn.id = btnId;
         btn.type = 'button';
         btn.className = 'mt-3 text-xs font-bold text-blue-400 hover:text-blue-300 transition';
         host.after(btn);
     }
     btn.innerHTML = open
         ? '<i class="fa-solid fa-chevron-up mr-1"></i>Show fewer'
         : `<i class="fa-solid fa-chevron-down mr-1"></i>View all ${items.length} ${noun}`;
     btn.setAttribute('aria-expanded', String(open));
     btn.onclick = () => { seoListOpen[key] = !open; seoShowMore(host, items, key, noun); };
 }

 function renderSeoPagesTable(rows) {
     const tbody = document.getElementById('seo-pages-tbody');
     if (!tbody) return;
     if (!rows.length) {
         tbody.innerHTML = '<tr><td colspan="4" class="py-4 text-center text-gray-500">No page data for this range.</td></tr>';
         seoShowMore(tbody.closest('table'), [], 'pages', 'pages');
         return;
     }
     tbody.innerHTML = rows.map(r => `
         <tr class="hover:bg-white/5 transition">
             <td class="py-2 pr-2 text-gray-300 truncate max-w-[220px]" title="${escapeAttr(r.page)}">${escapeAttr(r.page)}</td>
             <td class="py-2 text-right font-bold text-white">${Number(r.clicks).toLocaleString()}</td>
             <td class="py-2 text-right text-gray-400">${Number(r.impressions).toLocaleString()}</td>
             <td class="py-2 text-right text-yellow-400">${r.weighted_position != null ? Number(r.weighted_position).toFixed(1) : '—'}</td>
         </tr>`).join('');
     seoShowMore(tbody.closest('table'), [...tbody.rows], 'pages', 'pages');
 }

 // ---- Wrong-page alerts ----
 // A keyword has a target page set in SE Ranking (the page we want ranking) and a ranking_url (the
 // page Google actually shows). When a keyword is ranking and the two differ, Google prefers a
 // different page: usually a blog or list page outranking the service or city page built for it.
 // Same comparison as samePage() in seranking-sync/parse.ts: protocol, www, trailing slash, query and
 // case don't make a different page.
 function seoSamePage(a, b) {
     const norm = u => {
         if (!u) return '';
         let s = String(u).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
         s = s.split('#')[0].split('?')[0];
         return s.replace(/\/+$/, '');
     };
     const x = norm(a), y = norm(b);
     return !!x && x === y;
 }

 function seoWrongPage(r) {
     if (!r.target_page || !r.ranking_url) return false;
     if (r.rank == null && r.map_rank == null) return false;   // not ranking: nothing ranks, so nothing is wrong
     return !seoSamePage(r.target_page, r.ranking_url);
 }

 // Just the path, for reading at a glance: "/services/pergola-builds", "/" for the home page
 function seoPagePath(u) {
     try { const p = new URL(u).pathname.replace(/\/+$/, ''); return p || '/'; }
     catch (_) { return String(u || ''); }
 }

 // rows: keyword rows, each optionally carrying `city` (per-city mode). A keyword ranking the wrong
 // page in several cities is listed once per city, so the city tells you where to look.
 function renderSeoWrongPageAlerts(rows) {
     const box = document.getElementById('seo-wrong-page-alerts');
     if (!box) return;
     const wrong = rows.filter(seoWrongPage);
     box.classList.toggle('hidden', !wrong.length);
     if (!wrong.length) { box.innerHTML = ''; return; }
     const keywordCount = new Set(wrong.map(r => r.keyword)).size;
     box.innerHTML = `
         <div class="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3">
             <p class="text-xs font-bold text-amber-300 mb-1"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Wrong page ranking for ${keywordCount} keyword${keywordCount === 1 ? '' : 's'}</p>
             <p class="text-[11px] text-gray-400 mb-2">Google is showing a different page than the target set in SE Ranking. Usually the fix is to strengthen the target page for that search, or link to it from the page that's ranking.</p>
             <ul class="space-y-1.5">
                 ${wrong.map(r => `<li class="text-xs text-gray-300">
                     <span class="font-bold text-white">${escapeAttr(r.keyword)}</span>${r.city ? ` <span class="text-gray-400">(${escapeAttr(seoCityShort(r.city))})</span>` : ''}
                     <span class="text-gray-500">— ranking</span> <span class="text-amber-300" title="${escapeAttr(r.ranking_url)}">${escapeAttr(seoPagePath(r.ranking_url))}</span>
                     <span class="text-gray-500">instead of</span> <span class="text-emerald-300" title="${escapeAttr(r.target_page)}">${escapeAttr(seoPagePath(r.target_page))}</span>
                 </li>`).join('')}
             </ul>
         </div>`;
 }

 // ---- Per-city rankings ----
 // SE Ranking checks a keyword from each city it's assigned to. seo_keyword_summary gives the best
 // city; seo_keyword_city_ranks gives every city, which the picker and the breakdown read.
 let seoKeywordRowsCache = [];
 let seoCityRowsCache = [];
 let seoCityFilter = 'all';          // 'all' or a site_engine_id, as a string
 const seoCityOpen = new Set();      // keywords whose city breakdown is expanded

 // "Lehi, Utah, United States" → "Lehi". A location without a city is a national check.
 function seoCityShort(label) {
     return String(label || '').split(',')[0].trim() || 'Nationwide';
 }

 window.setSeoCityFilter = function(value) {
     seoCityFilter = value || 'all';
     renderSeoKeywordsTable(seoKeywordRowsCache, seoCityRowsCache);
 };

 window.toggleSeoCityDetail = function(keyword) {
     if (seoCityOpen.has(keyword)) seoCityOpen.delete(keyword); else seoCityOpen.add(keyword);
     renderSeoKeywordsTable(seoKeywordRowsCache, seoCityRowsCache);
 };

 function seoRankLabel(rank, mapRank) {
     if (rank == null && mapRank == null) return '<span class="text-gray-500">not ranking</span>';
     return [rank != null ? `<span class="text-yellow-400">#${rank}</span>` : '',
             mapRank != null ? `<span class="text-purple-400" title="Map pack">map #${mapRank}</span>` : ''].filter(Boolean).join(' ');
 }

 function renderSeoKeywordsTable(rows, cityRows = []) {
     const tbody = document.getElementById('seo-keywords-tbody');
     if (!tbody) return;
     seoKeywordRowsCache = rows;
     seoCityRowsCache = cityRows || [];

     // The picker only appears when the project checks from more than one place
     const cities = [...new Map(seoCityRowsCache.map(c => [String(c.site_engine_id), c.city])).entries()]
         .sort((a, b) => seoCityShort(a[1]).localeCompare(seoCityShort(b[1])));
     const wrap = document.getElementById('seo-city-filter-wrap');
     const select = document.getElementById('seo-city-filter');
     // The picker hides below 2 cities, so a leftover pick must not keep filtering unseen.
    if (seoCityFilter !== 'all' && (cities.length < 2 || !cities.some(([id]) => id === seoCityFilter))) seoCityFilter = 'all';
     if (wrap) wrap.classList.toggle('hidden', cities.length < 2);
     if (select) {
         select.innerHTML = `<option value="all">All cities (best)</option>` +
             cities.map(([id, label]) => `<option value="${escapeAttr(id)}">${escapeAttr(seoCityShort(label))}</option>`).join('');
         select.value = seoCityFilter;
     }

     const cityByKeyword = new Map();
     seoCityRowsCache.forEach(c => {
         if (!cityByKeyword.has(c.keyword)) cityByKeyword.set(c.keyword, []);
         cityByKeyword.get(c.keyword).push(c);
     });

     // One city picked: show that city's own rank for every keyword checked there
     if (seoCityFilter !== 'all') {
         rows = rows.map(r => {
             const c = (cityByKeyword.get(r.keyword) || []).find(x => String(x.site_engine_id) === seoCityFilter);
             return c ? { ...r, rank: c.rank, map_rank: c.map_rank, ranking_url: c.ranking_url, prior_rank: c.prior_rank, prior_map_rank: c.prior_map_rank } : null;
         }).filter(Boolean)
           .sort((a, b) => ((a.rank == null && a.map_rank == null) - (b.rank == null && b.map_rank == null))
               || ((a.rank ?? 999) - (b.rank ?? 999)) || ((a.map_rank ?? 999) - (b.map_rank ?? 999)));
     }

     // Alerts check every city, not just the best one: Lehi can rank the right page while Draper
     // ranks a blog post. Without city data (SQL not installed yet) they fall back to the summary.
     const alertRows = seoCityRowsCache.length
         ? seoCityRowsCache.filter(c => seoCityFilter === 'all' || String(c.site_engine_id) === seoCityFilter)
             .map(c => ({ ...c, city: cities.length > 1 ? c.city : null }))
         : rows;
     renderSeoWrongPageAlerts(alertRows);

     if (!rows.length) {
         tbody.innerHTML = '<tr><td colspan="5" class="py-4 text-center text-gray-500">No keywords tracked yet — add some in SE Ranking, they show up here on the next sync.</td></tr>';
         seoShowMore(tbody.closest('table'), [], 'keywords', 'keywords');
         return;
     }
     tbody.innerHTML = rows.map(r => {
         // Organic and map pack are separate columns, each with its own change pill. A keyword
         // in the map pack with no organic listing is ranking, not "not ranking".
         const dash = '<span class="text-gray-600">—</span>';
         const organicCell = r.rank != null
             ? `${r.rank} ${r.prior_rank != null ? seoDeltaPill(r.rank, r.prior_rank, { invert: true }) : ''}`
             : dash;
         const mapCell = r.map_rank != null
             ? `#${r.map_rank} ${r.prior_map_rank != null ? seoDeltaPill(r.map_rank, r.prior_map_rank, { invert: true }) : ''}`
             : dash;
         const perCity = cityByKeyword.get(r.keyword) || [];
         // In "all cities" mode the row shows the best city, so flag it if ANY city ranks the wrong page
         const wrong = seoCityFilter === 'all' && perCity.length ? perCity.some(seoWrongPage) : seoWrongPage(r);
         const keywordTitle = [r.keyword,
             r.ranking_url ? `Ranking page: ${r.ranking_url}` : '',
             r.target_page ? `Target page: ${r.target_page}` : ''].filter(Boolean).join('\n');
         const notRanking = r.rank == null && r.map_rank == null;
         const showCities = seoCityFilter === 'all' && perCity.length > 1;
         const open = showCities && seoCityOpen.has(r.keyword);
         const cityToggle = showCities
             ? ` <button type="button" onclick="toggleSeoCityDetail('${escapeHTML(r.keyword)}')" class="seo-city-toggle text-[10px] text-blue-400 hover:text-blue-300 whitespace-nowrap" aria-expanded="${open}">${perCity.length} cities <i class="fa-solid fa-chevron-${open ? 'up' : 'down'} text-[8px]"></i></button>`
             : '';
         const cityDetail = open
             ? `<div class="seo-city-detail mt-1 flex flex-wrap gap-1.5 whitespace-normal">${perCity
                 .slice().sort((a, b) => seoCityShort(a.city).localeCompare(seoCityShort(b.city)))
                 .map(c => `<span class="text-[10px] bg-black/30 border ${seoWrongPage(c) ? 'border-amber-400/40' : 'border-white/10'} rounded px-1.5 py-0.5" title="${escapeAttr(c.ranking_url ? `Ranking page: ${c.ranking_url}` : 'Not ranking')}">
                     <span class="text-gray-400">${escapeAttr(seoCityShort(c.city))}</span> ${seoRankLabel(c.rank, c.map_rank)}${seoWrongPage(c) ? ' <i class="fa-solid fa-triangle-exclamation text-amber-400" aria-label="Wrong page ranking"></i>' : ''}
                 </span>`).join('')}</div>`
             : '';
         return `
         <tr class="hover:bg-white/5 transition">
             <td class="py-2 pr-2 text-gray-300 max-w-[260px]" title="${escapeAttr(keywordTitle)}"><div class="truncate">${wrong ? '<i class="fa-solid fa-triangle-exclamation text-amber-400 text-[10px] mr-1" aria-label="Wrong page ranking"></i>' : ''}${escapeAttr(r.keyword)}${cityToggle}</div>${cityDetail}</td>
             ${notRanking
                 ? '<td colspan="2" class="py-2 text-right text-gray-500">not ranking</td>'
                 : `<td class="py-2 text-right text-yellow-400">${organicCell}</td><td class="py-2 text-right text-purple-400">${mapCell}</td>`}
             <td class="py-2 text-right text-white">${Number(r.gsc_clicks || 0).toLocaleString()}</td>
             <td class="py-2 text-right text-gray-400">${Number(r.gsc_impressions || 0).toLocaleString()}</td>
         </tr>`;
     }).join('');
     seoShowMore(tbody.closest('table'), [...tbody.rows], 'keywords', 'keywords');
 }

 function renderSeoMoversPanel(rows) {
     const el = document.getElementById('seo-movers-list');
     if (!el) return;
     if (!rows.length) {
         el.innerHTML = '<p class="text-sm text-gray-500">Nothing moved enough this period to call out — every page and query stayed within a normal range.</p>';
         return;
     }
     el.innerHTML = rows.map(r => {
         const up = r.click_delta > 0;
         const icon = up ? 'fa-arrow-trend-up text-emerald-400' : (r.click_delta < 0 ? 'fa-arrow-trend-down text-red-400' : 'fa-minus text-gray-500');
         const kindLabel = r.kind === 'page' ? 'Page' : 'Query';
         return `<div class="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
             <div class="flex items-center gap-2 min-w-0">
                 <i class="fa-solid ${icon} shrink-0"></i>
                 <span class="text-[10px] uppercase tracking-widest text-gray-500 shrink-0">${kindLabel}</span>
                 <span class="text-sm text-gray-300 truncate" title="${escapeAttr(r.name)}">${escapeAttr(r.name)}</span>
             </div>
             <span class="text-sm font-bold shrink-0 ${up ? 'text-emerald-400' : (r.click_delta < 0 ? 'text-red-400' : 'text-gray-400')}">
                 ${r.prior_clicks} → ${r.clicks} clicks
             </span>
         </div>`;
     }).join('');
 }

 // ---- Competitors (admin) ----
 // Three panels from supabase/sql/seo_competitors.sql: one line per tracked competitor, a
 // search-by-search grid, and "who owns this market" from the daily top-10 snapshot.
 //
 // Everything here is ORGANIC rank. SE Ranking's competitor endpoint returns no map-pack
 // position, so a competitor sitting in the local pack looks like "not ranking" — which is why
 // the panel says so in its header and a blank cell reads "not in the top 100", never "we win".
 function seoCompetitorRankCell(rank) {
     if (rank == null) return '<span class="text-gray-600">—</span>';
     const n = Number(rank);
     const color = n <= 3 ? 'text-emerald-400' : n <= 10 ? 'text-yellow-400' : 'text-gray-400';
     return `<span class="${color} font-bold">#${n}</span>`;
 }

 function renderSeoCompetitors(compRes, vsRes, marketRes) {
     const panel = document.getElementById('seo-competitors-panel');
     const empty = document.getElementById('seo-competitors-empty');
     const body = document.getElementById('seo-competitors-body');
     if (!panel || !empty || !body) return;
     panel.classList.remove('hidden');

     const failed = compRes?.error || vsRes?.error;
     const rows = compRes?.data || [];
     const show = (isEmpty, html) => {
         empty.classList.toggle('hidden', !isEmpty);
         body.classList.toggle('hidden', isEmpty);
         if (isEmpty) empty.innerHTML = html;
     };
     if (failed) {
         // The tab predates this feature, so a missing function is a setup step, not a bug.
         show(true, '<span class="text-amber-400">Competitor tracking needs its tables. Run supabase/sql/seo_competitors.sql, then deploy seranking-sync.</span>');
         return;
     }
     if (!rows.length) {
         show(true, 'No competitors tracked for this client yet. Add 3–5 in SE Ranking (Competitors), then they appear here after the next daily check. Pick them from "who owns this market" below once a snapshot exists.');
         renderSeoMarketLeaders(marketRes);
         empty.classList.remove('hidden');
         body.classList.remove('hidden');
         document.getElementById('seo-competitors-tbody').innerHTML = '';
         document.getElementById('seo-vs-head').innerHTML = '';
         document.getElementById('seo-vs-tbody').innerHTML = '';
         return;
     }
     show(false, '');

     document.getElementById('seo-competitors-tbody').innerHTML = rows.map(r => {
         const name = r.competitor_name || r.domain || '';
         const trust = r.domain_trust == null ? '—' : Number(r.domain_trust).toFixed(0);
         const avg = r.their_avg_rank == null ? '—' : Number(r.their_avg_rank).toFixed(1);
         return `<tr class="hover:bg-white/5 transition">
             <td class="py-2 pr-2 text-gray-300 max-w-[220px]"><div class="truncate" title="${escapeAttr(r.domain || name)}">${escapeAttr(name)}</div></td>
             <td class="py-2 text-right text-gray-400">${trust}</td>
             <td class="py-2 text-right text-white font-bold">${Number(r.their_page1 || 0)}</td>
             <td class="py-2 text-right text-gray-400">${avg}</td>
             <td class="py-2 text-right text-emerald-400 font-bold">${Number(r.ahead_of_them || 0)}</td>
             <td class="py-2 text-right text-red-400 font-bold">${Number(r.behind_them || 0)}</td>
             <td class="py-2 text-right text-gray-400">${Number(r.not_ranking_them || 0)}</td>
         </tr>`;
     }).join('');

     // Search by search: one column per competitor, ours first. Sorted by search volume so the
     // keywords worth money sit at the top, not whatever sorts first alphabetically.
     const matrix = vsRes?.data || [];
     const byKeyword = new Map();
     for (const m of matrix) {
         if (!byKeyword.has(m.keyword)) byKeyword.set(m.keyword, { keyword: m.keyword, volume: m.search_volume, client_rank: m.client_rank, them: new Map() });
         byKeyword.get(m.keyword).them.set(String(m.seranking_competitor_id), m.competitor_rank);
     }
     const order = rows.map(r => ({ id: String(r.seranking_competitor_id), name: r.competitor_name || r.domain || '' }));
     document.getElementById('seo-vs-head').innerHTML =
         '<th class="text-left pb-2">Search</th><th class="text-right pb-2">Us</th>' +
         order.map(c => `<th class="text-right pb-2 max-w-[120px]"><span class="truncate inline-block max-w-[110px] align-bottom" title="${escapeAttr(c.name)}">${escapeAttr(c.name)}</span></th>`).join('');

     const list = [...byKeyword.values()].sort((a, b) => (Number(b.volume || 0) - Number(a.volume || 0)) || a.keyword.localeCompare(b.keyword));
     const tbody = document.getElementById('seo-vs-tbody');
     tbody.innerHTML = list.map(k => {
         // Beating every competitor that ranks at all is worth seeing at a glance
         const theirRanks = order.map(c => k.them.get(c.id)).filter(v => v != null).map(Number);
         const leading = k.client_rank != null && theirRanks.length > 0 && theirRanks.every(v => Number(k.client_rank) < v);
         return `<tr class="hover:bg-white/5 transition">
             <td class="py-2 pr-2 text-gray-300 max-w-[240px]"><div class="truncate" title="${escapeAttr(k.keyword)}">${leading ? '<i class="fa-solid fa-crown text-yellow-400 mr-1" title="Ahead of every competitor that ranks"></i>' : ''}${escapeAttr(k.keyword)}</div></td>
             <td class="py-2 text-right ${k.client_rank != null ? 'text-white font-bold' : ''}">${seoCompetitorRankCell(k.client_rank)}</td>
             ${order.map(c => `<td class="py-2 text-right">${seoCompetitorRankCell(k.them.get(c.id))}</td>`).join('')}
         </tr>`;
     }).join('') || `<tr><td colspan="${order.length + 2}" class="py-4 text-center text-gray-500">No comparable ranks yet. Competitor positions start at SE Ranking's next daily check after they're added.</td></tr>`;
     seoShowMore(tbody, [...tbody.rows], 'vs', 'searches');

     renderSeoMarketLeaders(marketRes);
 }

 // Directories (Yelp, Houzz, Trex, booking widgets…) are flagged by seo_market_leaders and hidden
 // by default: they own page 1 but aren't who a contractor loses the job to. One click shows them.
 let seoMarketShowDirectories = false;
 let seoMarketLastRes = null;
 window.toggleSeoMarketDirectories = function() {
     seoMarketShowDirectories = !seoMarketShowDirectories;
     renderSeoMarketLeaders(seoMarketLastRes);
 };

 function renderSeoMarketLeaders(marketRes) {
     const host = document.getElementById('seo-market-leaders');
     if (!host) return;
     seoMarketLastRes = marketRes;
     const toggleId = 'seo-market-dir-toggle';
     document.getElementById(toggleId)?.remove();
     if (marketRes?.error) {
         host.innerHTML = '<p class="text-sm text-gray-500">Run supabase/sql/seo_competitors.sql to collect this.</p>';
         seoShowMore(host, [], 'market', 'sites');
         return;
     }
     const all = marketRes?.data || [];
     if (!all.length) {
         host.innerHTML = '<p class="text-sm text-gray-500">No top-10 snapshot in this range yet. The next sync stores one, and SE Ranking only keeps about 14 days of its own, so this list starts from today.</p>';
         seoShowMore(host, [], 'market', 'sites');
         return;
     }
     const dirCount = all.filter(r => r.is_directory).length;
     const rows = seoMarketShowDirectories ? all : all.filter(r => !r.is_directory);
     if (dirCount) {
         const btn = document.createElement('button');
         btn.id = toggleId;
         btn.type = 'button';
         btn.className = 'mb-2 text-[10px] font-bold uppercase tracking-widest text-gray-500 hover:text-gray-300 transition';
         btn.textContent = seoMarketShowDirectories
             ? `Hide ${dirCount} ${dirCount === 1 ? 'directory' : 'directories'}`
             : `Show ${dirCount} ${dirCount === 1 ? 'directory' : 'directories'} (Yelp, Houzz, manufacturers…)`;
         btn.onclick = window.toggleSeoMarketDirectories;
         host.before(btn);
     }
     if (!rows.length) {
         host.innerHTML = '<p class="text-sm text-gray-500">Only directories are in the top 10 right now — no local business to pick yet.</p>';
         seoShowMore(host, [], 'market', 'sites');
         return;
     }
     host.innerHTML = rows.map(r => {
         const cities = Number(r.cities || 0);
         const badge = r.is_client
             ? '<span class="text-[9px] uppercase tracking-widest text-yellow-400 border border-yellow-400/30 rounded px-1">this client</span>'
             : r.tracked
                 ? '<span class="text-[9px] uppercase tracking-widest text-purple-400 border border-purple-400/30 rounded px-1">tracked</span>'
                 : r.is_directory
                     ? '<span class="text-[9px] uppercase tracking-widest text-gray-500 border border-white/10 rounded px-1">directory</span>'
                     : '';
         return `<div class="flex items-center justify-between gap-3 py-1.5 border-b border-white/5 last:border-0">
             <div class="flex items-center gap-2 min-w-0">
                 <span class="text-sm ${r.is_client ? 'text-yellow-400 font-bold' : 'text-gray-300'} truncate" title="${escapeAttr(r.domain)}">${escapeAttr(r.domain)}</span>
                 ${badge}
             </div>
             <span class="text-xs text-gray-400 shrink-0 whitespace-nowrap">${cities} ${cities === 1 ? 'city' : 'cities'} · ${Number(r.avg_visibility || 0).toFixed(1)}% avg</span>
         </div>`;
     }).join('');
     seoShowMore(host, [...host.children], 'market', 'sites');
 }

 // ---- Site audit (admin) ----
 // SE Ranking's monthly crawl, stored by seranking-sync in seo_site_audits (newest two rows read).
 // Errors lead, then warnings; notices sit behind View all, since most are housekeeping (unminified
 // JavaScript) rather than anything costing rankings. Comparing with the previous run is the point
 // of a monthly audit: a new issue usually means a site change broke something, and a fixed one is
 // work worth logging.
 const SEO_AUDIT_SEVERITY = {
     error: { label: 'Error', dot: 'bg-red-400', text: 'text-red-400' },
     warning: { label: 'Warning', dot: 'bg-yellow-400', text: 'text-yellow-400' },
     notice: { label: 'Notice', dot: 'bg-gray-500', text: 'text-gray-400' },
 };

 function renderSeoSiteAudit(auditRes) {
     const panel = document.getElementById('seo-audit-panel');
     const empty = document.getElementById('seo-audit-empty');
     const body = document.getElementById('seo-audit-body');
     if (!panel || !empty || !body) return;
     panel.classList.remove('hidden');
     const when = document.getElementById('seo-audit-when');
     const show = (isEmpty, html) => {
         empty.classList.toggle('hidden', !isEmpty);
         body.classList.toggle('hidden', isEmpty);
         if (isEmpty) { empty.innerHTML = html; when.textContent = ''; }
     };
     if (auditRes?.error) {
         show(true, '<span class="text-amber-400">Site audits need their table. Run supabase/sql/seo_site_audits.sql, then deploy seranking-sync.</span>');
         return;
     }
     const [latest, previous] = auditRes?.data || [];
     if (!latest) {
         show(true, 'No site audit synced for this client yet. In SE Ranking, open the project\'s Website Audit, run it once and set its schedule to monthly. It appears here after the next daily sync.');
         return;
     }
     show(false, '');

     const date = d => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
     when.textContent = `Checked ${date(latest.audit_time)} · ${Number(latest.pages_crawled || 0)} pages`;

     // Score, with the change since the last run. Higher is better.
     const score = latest.score == null ? null : Number(latest.score);
     const scoreColor = score == null ? 'text-gray-400' : score >= 80 ? 'text-emerald-400' : score >= 60 ? 'text-yellow-400' : 'text-red-400';
     const delta = (cur, prev, higherIsBetter) => {
         if (previous == null || cur == null || prev == null) return '';
         const d = Number(cur) - Number(prev);
         if (d === 0) return '<span class="text-xs text-gray-500 ml-1">no change</span>';
         const good = higherIsBetter ? d > 0 : d < 0;
         return `<span class="text-xs font-bold ml-1 ${good ? 'text-emerald-400' : 'text-red-400'}">${d > 0 ? '+' : ''}${d}</span>`;
     };
     document.getElementById('seo-audit-score').innerHTML =
         `<span class="text-2xl font-extrabold ${scoreColor}">${score == null ? '—' : score}</span><span class="text-sm text-gray-500">/100</span>${delta(latest.score, previous?.score, true)}`;
     for (const [id, key] of [['seo-audit-errors', 'errors'], ['seo-audit-warnings', 'warnings'], ['seo-audit-notices', 'notices']]) {
         document.getElementById(id).innerHTML =
             `<span class="text-2xl font-extrabold text-white">${Number(latest[key] || 0).toLocaleString()}</span>${delta(latest[key], previous?.[key], false)}`;
     }

     const issues = Array.isArray(latest.issues) ? latest.issues : [];
     const before = new Map((Array.isArray(previous?.issues) ? previous.issues : []).map(i => [i.code, i]));
     const nowCodes = new Set(issues.map(i => i.code));

     // Fixed since last audit: only errors and warnings are worth calling out
     const fixedBox = document.getElementById('seo-audit-fixed');
     const fixed = previous ? [...before.values()].filter(i => !nowCodes.has(i.code) && i.severity !== 'notice') : [];
     fixedBox.classList.toggle('hidden', !fixed.length);
     fixedBox.innerHTML = fixed.length
         ? `<i class="fa-solid fa-circle-check text-emerald-400 mr-1"></i><span class="text-emerald-400 font-bold">Fixed since ${date(previous.audit_time)}:</span> <span class="text-gray-300">${fixed.map(i => escapeAttr(i.name)).join(', ')}</span>`
         : '';

     const tbody = document.getElementById('seo-audit-tbody');
     if (!issues.length) {
         tbody.innerHTML = '<tr><td colspan="3" class="py-4 text-center text-emerald-400">No issues found in this audit.</td></tr>';
         document.getElementById('seo-more-audit')?.remove();
         return;
     }
     tbody.innerHTML = issues.map(i => {
         const sev = SEO_AUDIT_SEVERITY[i.severity] || SEO_AUDIT_SEVERITY.notice;
         const prev = before.get(i.code);
         // "New" needs a previous run to be new against; on the first audit everything is simply there
         const tag = !previous ? ''
             : !prev ? '<span class="text-[9px] uppercase tracking-widest text-red-400 border border-red-400/30 rounded px-1 ml-2">new</span>'
             : Number(i.count) > Number(prev.count) ? `<span class="text-[10px] text-red-400 ml-2">up from ${Number(prev.count)}</span>`
             : Number(i.count) < Number(prev.count) ? `<span class="text-[10px] text-emerald-400 ml-2">down from ${Number(prev.count)}</span>`
             : '';
         return `<tr class="hover:bg-white/5 transition">
             <td class="py-2 pr-2 text-gray-300"><span class="inline-block w-2 h-2 rounded-full ${sev.dot} mr-2" title="${sev.label}"></span>${escapeAttr(i.name)}${tag}</td>
             <td class="py-2 pr-2 text-gray-500 whitespace-nowrap">${escapeAttr(i.section)}</td>
             <td class="py-2 text-right font-bold ${sev.text}">${Number(i.count).toLocaleString()}</td>
         </tr>`;
     }).join('');
     // Show every error and warning up front; notices wait behind View all
     const rows = [...tbody.rows];
     const important = issues.filter(i => i.severity !== 'notice').length;
     if (important > 0 && important < rows.length) {
         const open = !!seoListOpen['audit'];
         rows.forEach((r, n) => r.classList.toggle('hidden', !open && n >= important));
         let btn = document.getElementById('seo-more-audit');
         if (!btn) {
             btn = document.createElement('button');
             btn.id = 'seo-more-audit';
             btn.type = 'button';
             btn.className = 'mt-3 text-xs font-bold text-blue-400 hover:text-blue-300 transition';
             tbody.closest('.overflow-x-auto').after(btn);
         }
         const hidden = rows.length - important;
         btn.innerHTML = open
             ? '<i class="fa-solid fa-chevron-up mr-1"></i>Hide notices'
             : `<i class="fa-solid fa-chevron-down mr-1"></i>Show ${hidden} ${hidden === 1 ? 'notice' : 'notices'}`;
         btn.onclick = () => { seoListOpen['audit'] = !open; renderSeoSiteAudit(auditRes); };
     } else {
         // All one kind: nothing to fold away
         document.getElementById('seo-more-audit')?.remove();
         rows.forEach(r => r.classList.remove('hidden'));
     }
 }

 function renderSeoAlmostPageOne(rows, minImpressions, failed) {
     const tbody = document.getElementById('seo-almost-p1-tbody');
     if (!tbody) return;
     if (failed) {
         tbody.innerHTML = '<tr><td colspan="4" class="py-4 text-center text-amber-400">Couldn\'t load this list. Run the latest supabase/sql/seo_admin_rpcs.sql.</td></tr>';
         return;
     }
     if (!rows.length) {
         tbody.innerHTML = `<tr><td colspan="4" class="py-4 text-center text-gray-500">No searches sitting just off page 1 with at least ${minImpressions} impressions in this range.</td></tr>`;
         return;
     }
     tbody.innerHTML = rows.map(r => {
         // Lower is better, so a move from 18 to 13 reads green
         const move = r.prior_position != null ? seoDeltaPill(Number(r.weighted_position), Number(r.prior_position), { invert: true }) : '';
         const tracked = r.tracked ? ' <span class="text-[9px] uppercase tracking-widest text-purple-400 border border-purple-400/30 rounded px-1 ml-1" title="Tracked in SE Ranking">tracked</span>' : '';
         return `
         <tr class="hover:bg-white/5 transition">
             <td class="py-2 pr-2 text-gray-300 max-w-[260px]"><span class="truncate inline-block max-w-[200px] align-bottom" title="${escapeAttr(r.query)}">${escapeAttr(r.query)}</span>${tracked}</td>
             <td class="py-2 text-right text-white font-bold">${Number(r.impressions).toLocaleString()}</td>
             <td class="py-2 text-right text-gray-400">${Number(r.clicks).toLocaleString()}</td>
             <td class="py-2 text-right text-yellow-400 whitespace-nowrap">${Number(r.weighted_position).toFixed(1)} ${move}</td>
         </tr>`;
     }).join('');
 }

 // ---- SEO changelog: what work went live, and when. seo_changelog, admin-written. ----
 // A trend line can always be redrawn from history, but why it moved can't be reconstructed
 // later if nobody wrote down when a page went live. Entries inside the selected range are
 // numbered oldest-first, and the same numbers mark the chart.
 let seoChangelogEntries = [];
 let seoChangelogClient = null;
 const SEO_CHANGELOG_KINDS = {
     content:   { label: 'Content',   color: '#60a5fa' },
     onpage:    { label: 'On-page',   color: '#34d399' },
     technical: { label: 'Technical', color: '#fb923c' },
     gbp:       { label: 'GBP',       color: '#f87171' },
     migration: { label: 'Migration', color: '#c084fc' },
     other:     { label: 'Other',     color: '#9ca3af' }
 };
 const seoLocalYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

 // In-range entries, oldest first, each with its marker number
 function seoChangelogMarkers(entries, s, e) {
     const from = seoLocalYmd(s), to = seoLocalYmd(e);
     return entries
         .filter(x => x.live_date >= from && x.live_date <= to)
         .sort((a, b) => a.live_date.localeCompare(b.live_date) || Number(a.id) - Number(b.id))
         .map((x, i) => ({ ...x, n: i + 1 }));
 }

 function renderSeoChangelogList(entries, markers, loadFailed) {
     const el = document.getElementById('seo-changelog-list');
     if (!el) return;
     if (loadFailed) {
         el.innerHTML = '<p class="text-sm text-amber-400">Couldn\'t load the changelog. Check that supabase/functions/seranking-sync/schema.sql has been run.</p>';
         seoShowMore(el, [], 'changelog', 'entries');
         return;
     }
     if (!entries.length) {
         el.innerHTML = '<p class="text-sm text-gray-500">Nothing logged yet. Next time a page goes live or a fix ships, log it here to see its effect on the chart.</p>';
         seoShowMore(el, [], 'changelog', 'entries');
         return;
     }
     const numberById = new Map(markers.map(m => [String(m.id), m.n]));
     el.innerHTML = [...entries].sort((a, b) => b.live_date.localeCompare(a.live_date)).map(x => {
         const kind = SEO_CHANGELOG_KINDS[x.kind] || SEO_CHANGELOG_KINDS.other;
         const n = numberById.get(String(x.id));
         const badge = n
             ? `<span class="shrink-0 w-6 h-6 rounded-full text-[11px] font-bold flex items-center justify-center text-black" style="background:${kind.color}" title="Marker ${n} on the chart">${n}</span>`
             : '<span class="shrink-0 w-6 h-6 rounded-full border border-white/10 flex items-center justify-center text-[9px] text-gray-600" title="Outside the selected date range">·</span>';
         const date = new Date(x.live_date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
         let safeUrl = '';
         try { const u = new URL(x.url); if (u.protocol === 'https:' || u.protocol === 'http:') safeUrl = u.href; } catch (_) {}
         return `<div class="flex items-start gap-3 py-3 border-b border-white/5 last:border-0">
             ${badge}
             <div class="min-w-0 flex-1">
                 <div class="flex flex-wrap items-center gap-2">
                     <span class="text-[10px] font-bold uppercase tracking-widest" style="color:${kind.color}">${kind.label}</span>
                     <span class="text-[11px] text-gray-500">${escapeAttr(date)}</span>
                     ${SEO_PLATFORM_LABEL[x.created_by] ? `<span class="text-[9px] uppercase tracking-widest text-gray-400 border border-white/15 rounded px-1" title="Logged automatically when the article was published">auto · ${SEO_PLATFORM_LABEL[x.created_by]}</span>` : ''}
                 </div>
                 <div class="text-sm text-white font-semibold break-words">${escapeAttr(x.title)}</div>
                 ${safeUrl ? `<a href="${escapeAttr(safeUrl)}" target="_blank" rel="noopener" class="text-xs text-blue-400 hover:underline break-all">${escapeAttr(safeUrl)}</a>` : ''}
                 ${x.notes ? `<div class="text-xs text-gray-400 mt-1 whitespace-pre-wrap break-words">${escapeAttr(x.notes)}</div>` : ''}
             </div>
             <div class="shrink-0 flex gap-1">
                 <button type="button" onclick="openSeoChangelogForm('${escapeAttr(String(x.id))}')" class="text-gray-500 hover:text-blue-400 px-2 py-1 transition" title="Edit"><i class="fa-solid fa-pen text-xs"></i></button>
                 <button type="button" onclick="deleteSeoChangelogEntry('${escapeAttr(String(x.id))}')" class="text-gray-500 hover:text-red-400 px-2 py-1 transition" title="Delete"><i class="fa-solid fa-trash text-xs"></i></button>
             </div>
         </div>`;
     }).join('');
     // Newest first, so the three shown are the latest work
     seoShowMore(el, [...el.children], 'changelog', 'entries');
 }

 window.openSeoChangelogForm = function(id) {
     if (currentUserRole !== 'admin') return;
     const form = document.getElementById('seo-changelog-form');
     if (!form) return;
     const entry = id ? seoChangelogEntries.find(x => String(x.id) === String(id)) : null;
     document.getElementById('seo-cl-id').value = entry ? String(entry.id) : '';
     document.getElementById('seo-cl-date').value = entry ? entry.live_date : seoLocalYmd(new Date());
     document.getElementById('seo-cl-kind').value = entry ? entry.kind : 'content';
     document.getElementById('seo-cl-title').value = entry ? entry.title : '';
     document.getElementById('seo-cl-url').value = entry?.url || '';
     document.getElementById('seo-cl-notes').value = entry?.notes || '';
     document.getElementById('seo-cl-error').classList.add('hidden');
     form.classList.remove('hidden');
     document.getElementById('seo-cl-title').focus();
 };

 window.closeSeoChangelogForm = function() {
     document.getElementById('seo-changelog-form')?.classList.add('hidden');
 };

 window.saveSeoChangelogEntry = async function(ev) {
     ev.preventDefault();
     if (currentUserRole !== 'admin' || !seoChangelogClient) return;
     const btn = document.getElementById('seo-cl-save');
     const errEl = document.getElementById('seo-cl-error');
     const id = document.getElementById('seo-cl-id').value;
     const row = {
         client_name: seoChangelogClient,
         live_date: document.getElementById('seo-cl-date').value,
         kind: document.getElementById('seo-cl-kind').value,
         title: document.getElementById('seo-cl-title').value.trim(),
         url: document.getElementById('seo-cl-url').value.trim() || null,
         notes: document.getElementById('seo-cl-notes').value.trim() || null
     };
     if (!row.live_date || !row.title) return;
     btn.disabled = true; btn.innerText = 'Saving...';
     try {
         let error;
         if (id) {
             ({ error } = await supabaseClient.from('seo_changelog').update(row).eq('id', id));
         } else {
             const { data: { session } } = await supabaseClient.auth.getSession();
             ({ error } = await supabaseClient.from('seo_changelog').insert({ ...row, created_by: session?.user?.email || null }));
         }
         if (error) throw error;
         closeSeoChangelogForm();
         await window.renderAdminSeo();
     } catch (err) {
         errEl.innerText = 'Could not save: ' + (err.message || err);
         errEl.classList.remove('hidden');
     } finally {
         btn.disabled = false; btn.innerText = 'Save';
     }
 };

 window.deleteSeoChangelogEntry = async function(id) {
     if (currentUserRole !== 'admin') return;
     const entry = seoChangelogEntries.find(x => String(x.id) === String(id));
     if (!entry || !confirm(`Delete "${entry.title}" from the changelog?`)) return;
     const { error } = await supabaseClient.from('seo_changelog').delete().eq('id', id);
     if (error) { alert('Could not delete: ' + error.message); return; }
     await window.renderAdminSeo();
 };

 // ---- Auto-log articles: per-client setup for supabase/functions/seo-changelog-webhook ----
 // Each client gets a token in seo_webhook_configs, and the webhook link is just ?t=<token>.
 // Platform, blog path and blog collection are edited here, so the webhook pasted into
 // Webflow (which can't edit webhooks) or Wix never has to change.
 const SEO_WEBHOOK_FN = 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/seo-changelog-webhook';
 let seoAutologConfig = null;
 let seoAutologClientObj = null;

 // "sc-domain:example.com" / "https://www.example.com/" -> "example.com". Same as the webhook's domainOf.
 function seoDomainOf(gscProperty) {
     const p = String(gscProperty || '').trim();
     if (!p) return null;
     if (p.toLowerCase().startsWith('sc-domain:')) return p.slice(10).toLowerCase().replace(/^www\./, '') || null;
     try { return new URL(p).hostname.toLowerCase().replace(/^www\./, '') || null; } catch (_) { return null; }
 }
 const seoCleanPath = (p) => { const t = String(p || '').trim().replace(/^https?:\/\/[^/]+/i, '').replace(/\/+$/, ''); return t ? '/' + t.replace(/^\/+/, '') : ''; };
 const seoDenverDate = (iso) => {
     const d = iso ? new Date(iso) : new Date();
     return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(isNaN(d.getTime()) ? new Date() : d);
 };

 async function refreshSeoAutologStatus(clientObj) {
     seoAutologClientObj = clientObj;
     const status = document.getElementById('seo-al-status');
     const { data, error } = await supabaseClient.from('seo_webhook_configs').select('*').eq('client_name', clientObj.name).maybeSingle();
     seoAutologConfig = error ? null : data;
     if (status) {
         status.innerText = !seoAutologConfig ? 'Auto-log articles'
             : seoAutologConfig.platform === 'webflow' && !seoAutologConfig.collection_id ? 'Auto-log: pick blog collection'
             : `Auto-log: on (${SEO_PLATFORM_LABEL[seoAutologConfig.platform] || seoAutologConfig.platform})`;
     }
     // Keep an open panel in step when switching clients
     if (!document.getElementById('seo-autolog-panel')?.classList.contains('hidden')) await fillSeoAutologPanel();
 }

 window.toggleSeoAutologPanel = async function() {
     if (currentUserRole !== 'admin') return;
     const panel = document.getElementById('seo-autolog-panel');
     if (!panel) return;
     if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
     panel.classList.remove('hidden');
     await fillSeoAutologPanel();
 };

 window.seoAutologPlatformChanged = function() {
     const platform = document.getElementById('seo-al-platform').value;
     // Webflow and Git both build post URLs from a blog path. Only Git has a repo folder.
     document.querySelectorAll('.seo-al-webflow').forEach(el => el.classList.toggle('hidden', platform === 'wix'));
     document.querySelectorAll('.seo-al-git').forEach(el => el.classList.toggle('hidden', platform !== 'git'));
 };
 const SEO_PLATFORM_LABEL = { webflow: 'Webflow', wix: 'Wix', git: 'Git', sanity: 'Sanity' };

 async function fillSeoAutologPanel() {
     const cfg = seoAutologConfig;
     const client = seoAutologClientObj;
     if (!client) return;
     document.getElementById('seo-al-error').classList.add('hidden');
     document.getElementById('seo-al-platform').value = cfg?.platform || 'webflow';
     document.getElementById('seo-al-path').value = cfg?.blog_path || '';
     document.getElementById('seo-al-content').value = cfg?.content_path || '';
     document.getElementById('seo-al-off').classList.toggle('hidden', !cfg);
     seoAutologPlatformChanged();
     renderSeoAutologLink();
     suggestSeoBlogPath(client);
     await renderSeoAutologCollection();
 }

 // Suggest the blog prefix from pages Search Console already knows: the most common first path
 // segment among pages at least two levels deep, like /blog-posts/some-article
 async function suggestSeoBlogPath(client) {
     const hint = document.getElementById('seo-al-path-hint');
     if (!hint) return;
     hint.innerHTML = '';
     const end = new Date(); const start = new Date(); start.setDate(start.getDate() - 90);
     const { data } = await supabaseClient.rpc('seo_page_summary', { p_client: client.name, p_start: seoIso(start), p_end: seoIso(end), p_prior_start: seoIso(start), p_prior_end: seoIso(start), p_limit: 500 });
     const counts = {};
     (data || []).forEach(r => {
         try {
             const parts = new URL(r.page).pathname.split('/').filter(Boolean);
             if (parts.length >= 2) counts[parts[0]] = (counts[parts[0]] || 0) + 1;
         } catch (_) {}
     });
     const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
     if (!best || best[1] < 2) { hint.innerText = 'The part of a post\'s address before its name, e.g. /blog'; return; }
     hint.innerHTML = `Most articles on this site look like <span class="font-mono">/${escapeAttr(best[0])}/…</span> (${best[1]} pages). <button type="button" class="text-blue-400 hover:underline" onclick="document.getElementById('seo-al-path').value='/${escapeAttr(best[0])}'">Use it</button>`;
 }

 function renderSeoAutologLink() {
     const cfg = seoAutologConfig;
     const box = document.getElementById('seo-al-link-box');
     if (!box) return;
     box.classList.toggle('hidden', !cfg);
     if (!cfg) return;
     document.getElementById('seo-al-url').value = `${SEO_WEBHOOK_FN}?t=${cfg.token}`;
     const steps = cfg.platform === 'sanity'
         ? ['Copy the link above.',
            'Open <b>sanity.io/manage</b>, pick the project the articles are written into, then <b>API → Webhooks → Create webhook</b>.',
            'URL: paste the link. Dataset: <b>production</b>. Trigger on: <b>Create</b> only. HTTP method: <b>POST</b>. Leave drafts and versions off.',
            'Filter: <code class="font-mono text-gray-300">_type == "post"</code>',
            'Projection: <code class="font-mono text-gray-300">{_id, title, "slug": coalesce(slug.current, slug), "publishedAt": coalesce(publishedAt, _createdAt)}</code>',
            'Save. The next article published into Sanity appears here with an "auto · Sanity" badge.']
         : cfg.platform === 'git'
         ? ['Copy the link above.',
            'In the site\'s GitHub repo, open Settings → <b>Webhooks</b> → <b>Add webhook</b>.',
            'Payload URL: paste the link. Content type: <b>application/json</b>. Events: <b>Just the push event</b>. Save.',
            'GitHub sends a test ping right away, and that\'s fine. From then on, a new article file pushed to the main branch appears here with an "auto · Git" badge, titled from the file\'s own title.',
            'Private repo? Add a GITHUB_TOKEN secret in Supabase (read-only access to the repo) so titles come from the file instead of the file name.']
         : cfg.platform === 'wix'
         ? ['Copy the link above.',
            'In the Wix dashboard, open Automations and create a new automation.',
            'Trigger: <b>Blog post published</b>. Action: <b>Send HTTP request</b> (POST). Paste the link. If Wix asks what to send, include the post title, link and published date.',
            'Turn it on, then publish a post. It appears in the changelog with an "auto · Wix" badge.']
         : ['Copy the link above.',
            'In Webflow, open Site settings → <b>Webhooks</b> and add a webhook.',
            'Trigger type: <b>Collection Item Published</b>. Paste the link and save.',
            cfg.collection_id
                ? 'Done. Publish a blog post and it appears in the changelog with an "auto · Webflow" badge.'
                : 'Publish (or republish) one blog post, then pick the blog collection below. That post gets logged too.'];
     document.getElementById('seo-al-steps').innerHTML = steps.map(s => `<li>${s}</li>`).join('');
 }

 // Publishes held back because no blog collection was picked, grouped by collection, so the blog
 // can be picked by recognising its post titles instead of hunting for an id.
 async function renderSeoAutologCollection() {
     const cfg = seoAutologConfig;
     const box = document.getElementById('seo-al-collection-box');
     const el = document.getElementById('seo-al-collection');
     if (!box || !el) return;
     const show = cfg && cfg.platform === 'webflow';
     box.classList.toggle('hidden', !show);
     if (!show) return;
     if (cfg.collection_id) {
         el.innerHTML = `<p class="text-xs text-emerald-400"><i class="fa-solid fa-circle-check mr-1"></i>Picked (<span class="font-mono">${escapeAttr(cfg.collection_id)}</span>). <button type="button" class="text-gray-400 hover:underline" onclick="pickSeoBlogCollection(null)">Change</button></p>`;
         return;
     }
     const { data } = await supabaseClient.from('seo_changelog_webhook_events')
         .select('received_at, results').eq('client_name', cfg.client_name).eq('outcome', 'needs_collection')
         .order('received_at', { ascending: false }).limit(50);
     const groups = new Map();
     (data || []).forEach(ev => (Array.isArray(ev.results) ? ev.results : []).forEach(it => {
         if (!it?.collection_id) return;
         const g = groups.get(it.collection_id) || { id: it.collection_id, items: new Map() };
         g.items.set(it.ref, it);
         groups.set(it.collection_id, g);
     }));
     if (!groups.size) {
         el.innerHTML = '<p class="text-xs text-amber-400">Waiting for a publish. Once the webhook is added in Webflow, publish or republish one blog post, then reopen this panel.</p>';
         return;
     }
     el.innerHTML = [...groups.values()].map(g => {
         const titles = [...g.items.values()].slice(0, 3).map(i => `"${escapeAttr(i.title)}"`).join(', ');
         return `<div class="flex items-center justify-between gap-3 py-2 border-b border-white/5 last:border-0">
             <div class="min-w-0 text-xs text-gray-300">${titles}${g.items.size > 3 ? ` and ${g.items.size - 3} more` : ''}</div>
             <button type="button" onclick="pickSeoBlogCollection('${escapeAttr(g.id)}')" class="shrink-0 text-xs font-bold text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 px-3 py-1.5 rounded-lg transition">These are blog posts</button>
         </div>`;
     }).join('');
 }

 window.saveSeoAutolog = async function() {
     if (currentUserRole !== 'admin' || !seoAutologClientObj) return;
     const btn = document.getElementById('seo-al-save');
     const errEl = document.getElementById('seo-al-error');
     errEl.classList.add('hidden');
     const platform = document.getElementById('seo-al-platform').value;
     const rawPath = document.getElementById('seo-al-path').value.trim();
     // "/" is a real answer for Git sites that serve articles at the root, e.g. example.com/my-article
     const blog_path = platform === 'wix' ? null : (rawPath === '/' ? '/' : (seoCleanPath(rawPath) || null));
     const content_path = platform === 'git'
         ? (document.getElementById('seo-al-content').value.trim().replace(/^\/+/, '').replace(/\/*$/, '/') || null)
         : null;
     if (platform === 'git' && (!content_path || content_path === '/')) {
         errEl.innerText = 'Add the repo folder the articles live in, e.g. src/content/blog/';
         errEl.classList.remove('hidden');
         return;
     }
     if (!seoDomainOf(seoAutologClientObj.gsc_property)) {
         errEl.innerText = 'Add this client\'s Search Console property under Edit first. That\'s how their site is confirmed.';
         errEl.classList.remove('hidden');
         return;
     }
     if (platform !== 'wix' && !blog_path) {
         errEl.innerText = 'Add the blog address prefix (e.g. /blog, or / if articles sit at the root), so logged posts link to the right page.';
         errEl.classList.remove('hidden');
         return;
     }
     btn.disabled = true; btn.innerText = 'Saving...';
     try {
         const row = { client_name: seoAutologClientObj.name, platform, blog_path, content_path, updated_at: new Date().toISOString() };
         // Switching platform clears a Webflow collection that no longer applies
         if (platform !== 'webflow') row.collection_id = null;
         const { error } = await supabaseClient.from('seo_webhook_configs').upsert(row, { onConflict: 'client_name' });
         if (error) throw error;
         await refreshSeoAutologStatus(seoAutologClientObj);
         await fillSeoAutologPanel();
     } catch (err) {
         errEl.innerText = /seo_webhook_configs/.test(err.message || '')
             ? 'Setup table missing: run supabase/functions/seo-changelog-webhook/schema.sql first.'
             : 'Could not save: ' + (err.message || err);
         errEl.classList.remove('hidden');
     } finally {
         btn.disabled = false; btn.innerText = 'Save & get link';
     }
 };

 window.copySeoAutologUrl = async function() {
     const input = document.getElementById('seo-al-url');
     const btn = document.getElementById('seo-al-copy');
     try { await navigator.clipboard.writeText(input.value); }
     catch (_) { input.select(); document.execCommand('copy'); }   // the GHL iframe can block the clipboard API
     btn.innerText = 'Copied'; setTimeout(() => { btn.innerText = 'Copy'; }, 2000);
 };

 window.pickSeoBlogCollection = async function(collectionId) {
     if (currentUserRole !== 'admin' || !seoAutologConfig || !seoAutologClientObj) return;
     const { error } = await supabaseClient.from('seo_webhook_configs')
         .update({ collection_id: collectionId, updated_at: new Date().toISOString() })
         .eq('client_name', seoAutologConfig.client_name);
     if (error) { alert('Could not save: ' + error.message); return; }

     // Log the posts that were held back from this collection, same shape the webhook writes.
     // Upserted on (client_name, source_ref), first write wins, so nothing can be logged twice.
     if (collectionId) {
         const { data } = await supabaseClient.from('seo_changelog_webhook_events')
             .select('results').eq('client_name', seoAutologConfig.client_name).eq('outcome', 'needs_collection').limit(200);
         const domain = seoDomainOf(seoAutologClientObj.gsc_property);
         const path = seoAutologConfig.blog_path || '';
         const held = new Map();
         (data || []).forEach(ev => (Array.isArray(ev.results) ? ev.results : []).forEach(it => {
             if (it?.collection_id === collectionId && it.ref && it.title) held.set(it.ref, it);
         }));
         const rows = [...held.values()].map(it => ({
             client_name: seoAutologConfig.client_name,
             live_date: seoDenverDate(it.published_at),
             kind: 'content',
             title: String(it.title).slice(0, 200),
             url: domain && path && it.slug ? `https://${domain}${path}/${it.slug}` : null,
             notes: null,
             created_by: 'webflow',
             source_ref: it.ref
         }));
         if (rows.length) {
             const { error: logErr } = await supabaseClient.from('seo_changelog').upsert(rows, { onConflict: 'client_name,source_ref', ignoreDuplicates: true });
             if (logErr) alert('Blog collection saved, but the held posts could not be logged: ' + logErr.message);
         }
     }
     await window.renderAdminSeo();
 };

 window.turnOffSeoAutolog = async function() {
     if (currentUserRole !== 'admin' || !seoAutologConfig) return;
     if (!confirm('Turn off auto-logging for this client? Their webhook link stops working immediately. Entries already logged stay. Remember to remove the webhook from their site.')) return;
     const { error } = await supabaseClient.from('seo_webhook_configs').delete().eq('client_name', seoAutologConfig.client_name);
     if (error) { alert('Could not turn off: ' + error.message); return; }
     await refreshSeoAutologStatus(seoAutologClientObj);
     await fillSeoAutologPanel();
 };

 // Draws a dashed line and numbered dot per changelog entry. Kept inline rather than adding
 // chartjs-plugin-annotation: a new CDN script means re-pasting goldeneye.html into GHL.
 const seoChangelogChartPlugin = {
     id: 'seoChangelogMarkers',
     afterDatasetsDraw(chart, _args, opts) {
         const markers = opts?.markers || [];
         const labels = chart.data.labels || [];
         const xScale = chart.scales.x;
         const area = chart.chartArea;
         if (!markers.length || !labels.length || !xScale) return;
         const g = chart.ctx;
         // Entries sharing a plotted day stack their dots instead of overlapping
         const stackAt = {};
         markers.forEach(m => {
             // seo_daily can skip a day, so a marker lands on the first plotted day on or after it
             const idx = labels.findIndex(l => l >= m.live_date);
             if (idx < 0) return;
             const x = xScale.getPixelForValue(idx);
             if (x < area.left || x > area.right) return;   // panned or zoomed out of view
             const color = (SEO_CHANGELOG_KINDS[m.kind] || SEO_CHANGELOG_KINDS.other).color;
             const slot = stackAt[idx] = (stackAt[idx] || 0) + 1;
             const y = area.top + 10 + (slot - 1) * 20;
             g.save();
             g.strokeStyle = color; g.globalAlpha = 0.55; g.lineWidth = 1.5; g.setLineDash([4, 4]);
             g.beginPath(); g.moveTo(x, area.top); g.lineTo(x, area.bottom); g.stroke();
             g.globalAlpha = 1; g.setLineDash([]);
             g.fillStyle = color; g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
             g.fillStyle = '#000'; g.font = 'bold 10px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
             g.fillText(String(m.n), x, y + 0.5);
             g.restore();
         });
     }
 };

 function renderSeoChart(daily, s, e, markers = []) {
     const inRange = daily.filter(r => { const rd = new Date(r.date + 'T12:00:00'); return rd >= s && rd <= e; });
     const labels = inRange.map(r => r.date);
     if (adminSeoChart) adminSeoChart.destroy();
     const ctx = document.getElementById('adminSeoChart');
     if (!ctx) return;
     adminSeoChart = new Chart(ctx.getContext('2d'), {
         type: 'line',
         plugins: [seoChangelogChartPlugin],
         data: {
             labels,
             datasets: [
                 { label: 'Clicks', data: inRange.map(r => r.clicks || 0), borderColor: '#60a5fa', tension: 0.3, fill: true, backgroundColor: 'rgba(96,165,250,0.1)', yAxisID: 'y' },
                 { label: 'Impressions', data: inRange.map(r => r.impressions || 0), borderColor: '#c084fc', tension: 0.3, yAxisID: 'y1' }
             ]
         },
         options: {
             maintainAspectRatio: false,
             scales: { y: { position: 'left' }, y1: { position: 'right', grid: { display: false } } },
             plugins: {
                 zoom: { pan: { enabled: true, mode: 'x' }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' } },
                 seoChangelogMarkers: { markers }
             }
         }
     });
 }

 // ---- Site Analytics (GA4, built 2026-09-16) ----
 // One call, seo_ga4_report, returns everything for the range and the period before. Every number is
 // worked out in SQL or here; nothing on this panel is estimated by a model.
 let seoGa4Chart = null;
 let seoGa4Data = null;
 let seoGa4FlowPage = null;

 const SEO_AI_SOURCES = [
     [/chatgpt|openai/, 'ChatGPT'], [/perplexity/, 'Perplexity'], [/gemini|bard/, 'Gemini'],
     [/copilot/, 'Copilot'], [/claude/, 'Claude'], [/deepseek/, 'DeepSeek'], [/meta\.ai/, 'Meta AI'],
     [/grok/, 'Grok'], [/you\.com/, 'You.com'], [/poe\.com/, 'Poe']
 ];
 function seoAiLabel(source) {
     const s = String(source || '').toLowerCase();
     const hit = SEO_AI_SOURCES.find(([re]) => re.test(s));
     return hit ? hit[1] : s;
 }

 function seoFmtDuration(sec) {
     const n = Math.round(Number(sec) || 0);
     if (n < 60) return `${n}s`;
     const m = Math.floor(n / 60), s = n % 60;
     return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${String(s).padStart(2, '0')}s`;
 }
 const seoRatio = (a, b) => (Number(b) > 0 ? Number(a) / Number(b) : null);
 const seoPct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
 const seoNum = (v) => Math.round(Number(v) || 0).toLocaleString();

 // Tile values and their change from the period before, all from the two totals objects.
 function seoGa4Kpis(cur, pri) {
     const c = cur || {}, p = pri || {};
     return {
         sessions: [Number(c.sessions) || 0, Number(p.sessions) || 0],
         views: [Number(c.page_views) || 0, Number(p.page_views) || 0],
         duration: [seoRatio(c.session_duration_sec, c.sessions), seoRatio(p.session_duration_sec, p.sessions)],
         pps: [seoRatio(c.page_views, c.sessions), seoRatio(p.page_views, p.sessions)],
         engaged: [seoRatio(c.engaged_sessions, c.sessions), seoRatio(p.engaged_sessions, p.sessions)],
         key: [Number(c.key_events) || 0, Number(p.key_events) || 0]
     };
 }

 function renderSeoGa4(res, clientObj, s, e) {
     const panel = document.getElementById('seo-ga4-panel');
     const empty = document.getElementById('seo-ga4-empty');
     const body = document.getElementById('seo-ga4-body');
     const when = document.getElementById('seo-ga4-when');
     if (!panel || !empty || !body) return;
     panel.classList.remove('hidden');
     const showEmpty = (html) => {
         empty.innerHTML = html; empty.classList.remove('hidden'); body.classList.add('hidden');
         if (when) when.textContent = '';
         if (seoGa4Chart) { seoGa4Chart.destroy(); seoGa4Chart = null; }
     };

     if (!clientObj.ga4_property_id) {
         showEmpty(`No GA4 property set for ${escapeAttr(clientObj.name)}. Add the property ID under Edit, after adding our service account as a Viewer in GA4.`);
         return;
     }
     if (res?.error) {
         const missing = /function|does not exist|schema cache/i.test(res.error.message || '');
         showEmpty(missing
             ? '<span class="text-amber-400">Site Analytics needs its tables. Run supabase/sql/ga4_analytics.sql, then deploy seo-sync.</span>'
             : `<span class="text-red-400">Couldn't load site analytics: ${escapeAttr(res.error.message)}</span>`);
         return;
     }
     const d = res?.data;
     if (!d || !d.last_date) {
         showEmpty('GA4 is connected but nothing has synced yet. The backfill runs every 15 minutes and fills 16 months within about an hour. If this stays empty, use Test GA4 under Edit.');
         return;
     }

     seoGa4Data = d;
     empty.classList.add('hidden');
     body.classList.remove('hidden');
     if (when) {
         const lag = d.last_date < seoIso(e) ? ` · data through ${d.last_date} (GA4 takes a day or two to finish counting)` : '';
         when.textContent = `Since ${d.first_date}${lag}`;
     }

     const k = seoGa4Kpis(d.current, d.prior);
     const tile = (id, val, pill) => { const el = document.getElementById(id); if (el) el.innerHTML = `${val} ${pill}`; };
     tile('seo-ga4-sessions', seoNum(k.sessions[0]), seoDeltaPill(k.sessions[0], k.sessions[1]));
     tile('seo-ga4-views', seoNum(k.views[0]), seoDeltaPill(k.views[0], k.views[1]));
     tile('seo-ga4-duration', k.duration[0] == null ? '—' : seoFmtDuration(k.duration[0]), seoDeltaPill(k.duration[0], k.duration[1]));
     tile('seo-ga4-pps', k.pps[0] == null ? '—' : k.pps[0].toFixed(1), seoDeltaPill(k.pps[0], k.pps[1]));
     tile('seo-ga4-engaged', seoPct(k.engaged[0]), seoDeltaPill(k.engaged[0], k.engaged[1]));
     tile('seo-ga4-key', seoNum(k.key[0]), seoDeltaPill(k.key[0], k.key[1]));
     const postsTile = document.getElementById('seo-ga4-posts-tile');
     if (postsTile) postsTile.classList.toggle('hidden', !d.blog_path);
     if (d.blog_path) tile('seo-ga4-posts', seoNum(d.post_views), seoDeltaPill(Number(d.post_views), Number(d.prior_post_views)));

     renderSeoGa4Chart(d, s, e);
     renderSeoGa4Sources(d);
     renderSeoGa4Ai(d);
     renderSeoGa4Pages(d);
     renderSeoGa4Flow(d);
     renderSeoGa4Events(d);
 }

 // Sessions per day for the range, with the period before laid over it day-for-day (dashed).
 // One axis: both lines are sessions.
 function renderSeoGa4Chart(d, s, e) {
     const canvas = document.getElementById('seoGa4Chart');
     if (!canvas) return;
     if (seoGa4Chart) seoGa4Chart.destroy();
     const byDate = Object.fromEntries((d.series || []).map(r => [r.date, r.sessions]));
     const labels = [];
     for (let t = new Date(s); t <= e; t.setDate(t.getDate() + 1)) labels.push(seoIso(t));
     const priorByDate = Object.fromEntries((d.prior_series || []).map(r => [r.date, r.sessions]));
     // The day the same distance into the period before; a gap (null) before GA4 history starts
     const priorAt = (i) => {
         const t = new Date(labels[0] + 'T12:00:00'); t.setDate(t.getDate() - labels.length + i);
         const iso = seoIso(t);
         return iso < d.first_date ? null : (priorByDate[iso] ?? 0);
     };
     const last = d.last_date;
     const isLight = document.getElementById('theme-wrapper')?.classList.contains('light-mode');
     const grid = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
     const tick = isLight ? '#64748b' : '#9ca3af';
     seoGa4Chart = new Chart(canvas.getContext('2d'), {
         type: 'line',
         data: {
             labels,
             datasets: [
                 // Days GA4 hasn't delivered yet are gaps, not zeros
                 { label: 'Sessions', data: labels.map(l => (l > last ? null : (byDate[l] ?? 0))), borderColor: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.12)', fill: true, borderWidth: 2, cubicInterpolationMode: 'monotone', pointRadius: 0, pointHoverRadius: 4 },
                 { label: 'Period before', data: labels.map((_, i) => priorAt(i)), borderColor: isLight ? '#94a3b8' : '#6b7280', borderDash: [5, 4], borderWidth: 2, cubicInterpolationMode: 'monotone', pointRadius: 0, pointHoverRadius: 4, fill: false }
             ]
         },
         options: {
             maintainAspectRatio: false,
             interaction: { mode: 'index', intersect: false },
             scales: {
                 x: { grid: { display: false }, ticks: { color: tick, maxTicksLimit: 8 } },
                 y: { beginAtZero: true, grid: { color: grid }, ticks: { color: tick, precision: 0 } }
             },
             plugins: { legend: { display: false } }
         }
     });
 }

 function renderSeoGa4Sources(d) {
     const host = document.getElementById('seo-ga4-channels');
     const tbody = document.getElementById('seo-ga4-sources-tbody');
     const channels = d.channels || [];
     const total = channels.reduce((a, c) => a + Number(c.sessions), 0);
     if (host) {
         host.innerHTML = channels.length ? channels.map(c => {
             const share = total ? Number(c.sessions) / total : 0;
             return `<div>
                 <div class="flex justify-between gap-3 text-xs mb-1">
                     <span class="text-gray-300">${escapeAttr(c.channel)}</span>
                     <span class="tabular-nums text-gray-400"><span class="text-white font-bold">${seoNum(c.sessions)}</span> · ${seoPct(share)} ${seoDeltaPill(Number(c.sessions), Number(c.prior_sessions))}</span>
                 </div>
                 <div class="h-1.5 rounded-full bg-white/5 overflow-hidden"><div class="h-full rounded-full bg-blue-400" style="width:${(share * 100).toFixed(1)}%"></div></div>
             </div>`;
         }).join('') : '<p class="text-sm text-gray-500">No sessions in this range.</p>';
         seoShowMore(host, [...host.children], 'ga4-channels', 'channels');
     }
     if (tbody) {
         const rows = d.sources || [];
         tbody.innerHTML = rows.map(r => `<tr class="hover:bg-white/5 transition">
             <td class="py-2 pr-2 text-gray-300 truncate max-w-[220px]" title="${escapeAttr(r.channel)}">${escapeAttr(r.source)} / ${escapeAttr(r.medium)}</td>
             <td class="py-2 text-right font-bold text-white tabular-nums">${seoNum(r.sessions)}</td>
             <td class="py-2 text-right text-gray-400 tabular-nums">${seoPct(seoRatio(r.engaged_sessions, r.sessions))}</td>
             <td class="py-2 text-right text-gray-400 tabular-nums">${seoNum(r.key_events)}</td>
         </tr>`).join('');
         seoShowMore(tbody.closest('table'), [...tbody.rows], 'ga4-sources', 'sources');
     }
 }

 function renderSeoGa4Ai(d) {
     const host = document.getElementById('seo-ga4-ai');
     if (!host) return;
     const rows = d.ai || [];
     const cur = rows.reduce((a, r) => a + Number(r.sessions), 0);
     const prior = Number(d.ai_prior_sessions) || 0;
     if (!rows.length) {
         host.innerHTML = `<p class="text-sm text-gray-500">No visits from AI assistants in this range${prior ? ` (${seoNum(prior)} the period before)` : ''}.</p>`;
         return;
     }
     const byAssistant = {};
     rows.forEach(r => { const k = seoAiLabel(r.source); byAssistant[k] = (byAssistant[k] || 0) + Number(r.sessions); });
     host.innerHTML = `
         <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-3">
             <span class="text-2xl font-bold text-white tabular-nums">${seoNum(cur)}</span>
             <span class="text-xs text-gray-400">sessions (${seoNum(prior)} the period before)</span>
         </div>
         <div class="flex flex-wrap gap-2 mb-3">${Object.entries(byAssistant).sort((a, b) => b[1] - a[1]).map(([name, n]) =>
             `<span class="text-[11px] px-2 py-1 rounded-full bg-white/5 text-gray-300">${escapeAttr(name)} <span class="font-bold text-white tabular-nums">${seoNum(n)}</span></span>`).join('')}</div>
         <table class="w-full text-sm"><thead><tr class="text-[10px] uppercase tracking-widest text-gray-500 border-b border-white/10">
             <th class="text-left pb-2">Landed on</th><th class="text-left pb-2">From</th><th class="text-right pb-2">Sessions</th><th class="text-right pb-2">Key events</th>
         </tr></thead><tbody id="seo-ga4-ai-tbody">${rows.map(r => `<tr class="hover:bg-white/5 transition">
             <td class="py-2 pr-2 text-gray-300 truncate max-w-[200px]" title="${escapeAttr(r.landing_page)}">${escapeAttr(r.landing_page)}</td>
             <td class="py-2 pr-2 text-gray-400">${escapeAttr(seoAiLabel(r.source))}</td>
             <td class="py-2 text-right font-bold text-white tabular-nums">${seoNum(r.sessions)}</td>
             <td class="py-2 text-right text-gray-400 tabular-nums">${seoNum(r.key_events)}</td>
         </tr>`).join('')}</tbody></table>`;
     const tbody = document.getElementById('seo-ga4-ai-tbody');
     seoShowMore(tbody.closest('table'), [...tbody.rows], 'ga4-ai', 'pages');
 }

 function renderSeoGa4Pages(d) {
     const pagesBody = document.getElementById('seo-ga4-pages-tbody');
     if (pagesBody) {
         const rows = d.pages || [];
         pagesBody.innerHTML = rows.length ? rows.map(r => `<tr class="hover:bg-white/5 transition">
             <td class="py-2 pr-2 text-gray-300 truncate max-w-[280px]" title="${escapeAttr(r.page_path)}">${escapeAttr(r.page_path)}</td>
             <td class="py-2 text-right font-bold text-white tabular-nums">${seoNum(r.page_views)} ${seoDeltaPill(Number(r.page_views), Number(r.prior_page_views))}</td>
             <td class="py-2 text-right text-gray-400 tabular-nums">${seoFmtDuration(seoRatio(r.engagement_sec, r.page_views) || 0)}</td>
             <td class="py-2 text-right text-gray-400 tabular-nums">${seoNum(r.entrances)}</td>
             <td class="py-2 text-right text-gray-400 tabular-nums">${seoPct(seoRatio(r.exits, r.page_views))}</td>
         </tr>`).join('') : '<tr><td colspan="5" class="py-4 text-center text-gray-500">No page views in this range.</td></tr>';
         seoShowMore(pagesBody.closest('table'), rows.length ? [...pagesBody.rows] : [], 'ga4-pages', 'pages');
     }
     const landBody = document.getElementById('seo-ga4-landing-tbody');
     if (landBody) {
         const rows = d.landing || [];
         landBody.innerHTML = rows.length ? rows.map(r => `<tr class="hover:bg-white/5 transition">
             <td class="py-2 pr-2 text-gray-300 truncate max-w-[200px]" title="${escapeAttr(r.page_path)}">${escapeAttr(r.page_path)}</td>
             <td class="py-2 text-right font-bold text-white tabular-nums">${seoNum(r.entrances)}</td>
             <td class="py-2 text-right text-gray-400 tabular-nums">${seoPct(seoRatio(r.engaged_sessions, r.entrances))}</td>
             <td class="py-2 text-right text-gray-400 tabular-nums">${seoFmtDuration(seoRatio(r.duration_sec, r.entrances) || 0)}</td>
             <td class="py-2 text-right text-gray-400 tabular-nums">${seoNum(r.key_events)}</td>
         </tr>`).join('') : '<tr><td colspan="5" class="py-4 text-center text-gray-500">No sessions in this range.</td></tr>';
         seoShowMore(landBody.closest('table'), rows.length ? [...landBody.rows] : [], 'ga4-landing', 'pages');
     }
     const postsBody = document.getElementById('seo-ga4-posts-tbody');
     const bp = document.getElementById('seo-ga4-blog-path');
     if (bp) bp.textContent = d.blog_path ? `(under ${d.blog_path}/)` : '';
     if (postsBody) {
         const rows = d.top_posts || [];
         postsBody.innerHTML = !d.blog_path
             ? '<tr><td colspan="3" class="py-4 text-center text-gray-500">No blog address set. Set it in the changelog\'s Auto-log articles settings.</td></tr>'
             : rows.length ? rows.map(r => `<tr class="hover:bg-white/5 transition">
                 <td class="py-2 pr-2 text-gray-300 truncate max-w-[240px]" title="${escapeAttr(r.page_path)}">${escapeAttr(r.page_path.slice(d.blog_path.length) || r.page_path)}</td>
                 <td class="py-2 text-right font-bold text-white tabular-nums">${seoNum(r.page_views)}</td>
                 <td class="py-2 text-right text-gray-400 tabular-nums">${seoFmtDuration(seoRatio(r.engagement_sec, r.page_views) || 0)}</td>
             </tr>`).join('') : '<tr><td colspan="3" class="py-4 text-center text-gray-500">No post views in this range.</td></tr>';
         seoShowMore(postsBody.closest('table'), rows.length && d.blog_path ? [...postsBody.rows] : [], 'ga4-posts', 'posts');
     }
 }

 // For one page: where its views came from (a visit starting here, or another page) and where
 // visitors went next (another page, or out of the site).
 function seoGa4FlowFor(d, path) {
     const page = (d.pages || []).find(p => p.page_path === path) || (d.landing || []).find(p => p.page_path === path) || {};
     const views = Number(page.page_views) || 0;
     const flows = d.flows || [];
     const cameFrom = flows.filter(f => f.to_path === path).map(f => ({ label: f.from_path, n: Number(f.views), page: true }));
     const entrances = Number(page.entrances) || 0;
     if (entrances) cameFrom.push({ label: 'Started the visit here', n: entrances, page: false });
     const wentTo = flows.filter(f => f.from_path === path).map(f => ({ label: f.to_path, n: Number(f.views), page: true }));
     const exits = Number(page.exits) || 0;
     if (exits) wentTo.push({ label: 'Left the site', n: exits, page: false });
     const byN = (a, b) => b.n - a.n;
     return { views, cameFrom: cameFrom.sort(byN).slice(0, 8), wentTo: wentTo.sort(byN).slice(0, 8) };
 }

 function renderSeoGa4Flow(d) {
     const select = document.getElementById('seo-ga4-flow-page');
     const host = document.getElementById('seo-ga4-flow');
     if (!select || !host) return;
     const pages = (d.pages || []).map(p => p.page_path);
     if (!pages.length) { select.innerHTML = ''; host.innerHTML = '<p class="text-sm text-gray-500">No page views in this range.</p>'; return; }
     if (!pages.includes(seoGa4FlowPage)) seoGa4FlowPage = pages[0];
     select.innerHTML = pages.map(p => `<option value="${escapeAttr(p)}"${p === seoGa4FlowPage ? ' selected' : ''}>${escapeAttr(p)}</option>`).join('');
     const f = seoGa4FlowFor(d, seoGa4FlowPage);
     const col = (title, items, total) => `<div>
         <p class="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">${title}</p>
         ${items.length ? items.map(it => {
             const share = total ? it.n / total : 0;
             const click = it.page && pages.includes(it.label) ? ` role="button" tabindex="0" onclick="setSeoGa4FlowPage(this.dataset.path)" onkeydown="if(event.key==='Enter')setSeoGa4FlowPage(this.dataset.path)" data-path="${escapeAttr(it.label)}"` : '';
             return `<div class="mb-2 ${click ? 'cursor-pointer hover:bg-white/5 rounded-lg' : ''} px-1 py-0.5"${click}>
                 <div class="flex justify-between gap-3 text-xs"><span class="${it.page ? 'text-gray-300' : 'text-gray-400 italic'} truncate" title="${escapeAttr(it.label)}">${escapeAttr(it.label)}</span><span class="tabular-nums text-gray-400 shrink-0">${seoNum(it.n)} · ${seoPct(share)}</span></div>
                 <div class="h-1 mt-1 rounded-full bg-white/5 overflow-hidden"><div class="h-full rounded-full ${it.page ? 'bg-blue-400' : 'bg-gray-500'}" style="width:${Math.min(100, share * 100).toFixed(1)}%"></div></div>
             </div>`;
         }).join('') : '<p class="text-xs text-gray-500">Nothing recorded.</p>'}
     </div>`;
     host.innerHTML = `${col('Came from', f.cameFrom, f.views)}
         <div class="self-center text-center px-4 py-3 rounded-xl border border-white/10 min-w-[140px]">
             <p class="text-xs text-gray-300 break-all">${escapeAttr(seoGa4FlowPage)}</p>
             <p class="text-lg font-bold text-white tabular-nums mt-1">${seoNum(f.views)}</p><p class="text-[10px] text-gray-500">views</p>
         </div>
         ${col('Went to', f.wentTo, f.views)}`;
 }

 window.setSeoGa4FlowPage = function(path) {
     seoGa4FlowPage = path;
     if (seoGa4Data) renderSeoGa4Flow(seoGa4Data);
 };

 function renderSeoGa4Events(d) {
     const tbody = document.getElementById('seo-ga4-events-tbody');
     const note = document.getElementById('seo-ga4-key-note');
     if (!tbody) return;
     const rows = d.events || [];
     const anyKey = rows.some(r => Number(r.key_events) > 0 || Number(r.prior_key_events) > 0);
     if (note) {
         note.classList.toggle('hidden', anyKey || !rows.length);
         note.textContent = 'No key events in GA4 for this range. Form submissions only count here once GA4 records them as an event (for example form_submit or generate_lead) and it is marked as a key event in GA4 → Admin → Events.';
     }
     tbody.innerHTML = rows.length ? rows.map(r => `<tr class="hover:bg-white/5 transition">
         <td class="py-2 pr-2 ${Number(r.key_events) > 0 ? 'text-white font-bold' : 'text-gray-300'}">${escapeAttr(r.event_name)}</td>
         <td class="py-2 text-right tabular-nums ${Number(r.key_events) > 0 ? 'text-emerald-400 font-bold' : 'text-gray-500'}">${Number(r.key_events) > 0 ? seoNum(r.key_events) : '—'}</td>
         <td class="py-2 text-right text-gray-400 tabular-nums">${seoNum(r.event_count)}</td>
         <td class="py-2 text-right text-gray-500 tabular-nums">${seoNum(r.prior_event_count)}</td>
     </tr>`).join('') : '<tr><td colspan="4" class="py-4 text-center text-gray-500">No events in this range.</td></tr>';
     seoShowMore(tbody.closest('table'), rows.length ? [...tbody.rows] : [], 'ga4-events', 'events');
 }

 // ---- Map Pack (built 2026-09-16) ----
 // seo_keyword_summary/seo_keyword_city_ranks both collapse to the latest day in range, so there
 // was no way to see the pack forming or slipping over the week — only a snapshot. This adds the
 // trend, sourced from the same seo_rank_checks rows seranking-sync already syncs daily.
 let seoMapPackChart = null;

 function renderSeoMapPack(res, clientObj) {
     const panel = document.getElementById('seo-mappack-panel');
     const empty = document.getElementById('seo-mappack-empty');
     const body = document.getElementById('seo-mappack-body');
     if (!panel || !empty || !body) return;
     panel.classList.remove('hidden');
     const showEmpty = (html) => {
         empty.innerHTML = html; empty.classList.remove('hidden'); body.classList.add('hidden');
         if (seoMapPackChart) { seoMapPackChart.destroy(); seoMapPackChart = null; }
     };
     if (!clientObj.seranking_site_id) {
         showEmpty(`No SE Ranking project set for ${escapeAttr(clientObj.name)}, so there's no tracked rank to show a map pack from.`);
         return;
     }
     if (res?.error) {
         const missing = /function|does not exist|schema cache/i.test(res.error.message || '');
         showEmpty(missing
             ? '<span class="text-amber-400">Map Pack needs its function. Run supabase/sql/seo_map_pack.sql.</span>'
             : `<span class="text-red-400">Couldn't load Map Pack data: ${escapeAttr(res.error.message)}</span>`);
         return;
     }
     const d = res?.data;
     if (!d || !d.current || !Number(d.current.keywords_in_pack)) {
         empty.classList.remove('hidden');
         body.classList.add('hidden');
         empty.innerHTML = Number(d?.cities_tracked)
             ? 'No tracked keyword is holding a map pack spot in this range. That\'s common for a new local push — keep an eye on it as rankings climb.'
             : 'Nothing tracked yet — the next daily sync (19:00 UTC) will pick this up once keywords have rank history.';
         if (seoMapPackChart) { seoMapPackChart.destroy(); seoMapPackChart = null; }
         return;
     }
     empty.classList.add('hidden');
     body.classList.remove('hidden');

     const c = d.current;
     document.getElementById('seo-mp-count').textContent = seoNum(c.keywords_in_pack);
     document.getElementById('seo-mp-top').textContent = seoNum(c.top3_count);
     document.getElementById('seo-mp-avg').innerHTML = `${c.avg_position != null ? Number(c.avg_position).toFixed(1) : '—'} ${seoDeltaPill(Number(c.avg_position), Number(d.prior?.avg_position), { invert: true })}`;
     const viewsTile = document.getElementById('seo-mp-views-tile');
     const hasGbp = !!clientObj.seranking_local_id;
     if (viewsTile) viewsTile.classList.toggle('hidden', !hasGbp);
     if (hasGbp) document.getElementById('seo-mp-views').innerHTML = `${seoNum(c.maps_views)} ${seoDeltaPill(Number(c.maps_views), Number(d.prior?.maps_views))}`;

     const canvas = document.getElementById('seoMapPackChart');
     if (canvas) {
         if (seoMapPackChart) seoMapPackChart.destroy();
         const trend = d.trend || [];
         const isLight = document.getElementById('theme-wrapper')?.classList.contains('light-mode');
         const tick = isLight ? '#64748b' : '#9ca3af';
         seoMapPackChart = new Chart(canvas.getContext('2d'), {
             type: 'line',
             data: {
                 labels: trend.map(p => p.date),
                 datasets: [{ label: 'Keywords in the pack', data: trend.map(p => p.count), borderColor: '#fbbf24', backgroundColor: 'rgba(251,191,36,0.12)', fill: true, borderWidth: 2, cubicInterpolationMode: 'monotone', pointRadius: 0, pointHoverRadius: 4, stepped: false }]
             },
             options: {
                 maintainAspectRatio: false,
                 interaction: { mode: 'index', intersect: false },
                 scales: {
                     x: { grid: { display: false }, ticks: { color: tick, maxTicksLimit: 8 } },
                     y: { beginAtZero: true, grid: { color: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)' }, ticks: { color: tick, precision: 0 } }
                 },
                 plugins: { legend: { display: false } }
             }
         });
     }

     const tbody = document.getElementById('seo-mp-keywords-tbody');
     if (tbody) {
         const rows = d.keywords || [];
         tbody.innerHTML = rows.length ? rows.map(r => {
             const cities = (r.cities || []).length > 1
                 ? `<div class="text-[10px] text-gray-500 mt-0.5">${r.cities.map(c => `${escapeAttr(seoCityShort(c.city))} #${c.map_rank}`).join(' · ')}</div>` : '';
             return `<tr class="hover:bg-white/5 transition">
                 <td class="py-2 pr-2 text-gray-300 truncate max-w-[280px]" title="${escapeAttr(r.keyword)}">${escapeAttr(r.keyword)}${cities}</td>
                 <td class="py-2 text-right font-bold ${r.map_rank === 1 ? 'text-amber-400' : 'text-white'} tabular-nums">#${r.map_rank} ${r.prior_map_rank != null ? seoDeltaPill(r.map_rank, r.prior_map_rank, { invert: true }) : ''}</td>
                 <td class="py-2 text-right text-gray-400 tabular-nums">${r.organic_rank != null ? '#' + r.organic_rank : '—'}</td>
             </tr>`;
         }).join('') : '<tr><td colspan="3" class="py-4 text-center text-gray-500">No keywords in the pack in this range.</td></tr>';
         seoShowMore(tbody.closest('table'), rows.length ? [...tbody.rows] : [], 'mappack-keywords', 'keywords');
     }
 }

 // ---- Case studies (built 2026-09-16) ----
 // A printable "before SEO / now / a year ago" story, built from seo_case_study_report (SQL
 // computes every number and every availability flag; this only lays it out and writes the
 // English, same "code computes, the model quotes" discipline as the report and chat briefing —
 // except there's no model here at all, since every fact is already settled by the database.
 const seoCaseStudyFmtDate = (iso) => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
 const seoCaseStudyFmtRange = (start, end) => (start && end) ? `${seoCaseStudyFmtDate(start)} – ${seoCaseStudyFmtDate(end)}` : 'Not enough history yet';

 // A plain multiplier ("2.4x") is only meaningful above the same noise floor used elsewhere on
 // this tab (50 visits / 5 leads) — below that, two small counts either way, so the honest
 // statement is the two numbers themselves, not a percentage built on almost nothing.
 function seoCaseStudyMultiplier(base, now, floor) {
     if (base == null || now == null || base < floor) return null;
     if (base === 0) return null;
     return now / base;
 }

 function seoCaseStudyHero(label, base, now, floor, opts) {
     opts = opts || {};
     const fmt = opts.fmt || seoNum;
     const mult = seoCaseStudyMultiplier(base, now, floor);
     const badge = mult == null
         ? '<span class="hero-badge muted">Early data</span>'
         : `<span class="hero-badge">${mult >= 1 ? mult.toFixed(1) + '×' : Math.round(mult * 100) + '%'}</span>`;
     return `<div class="hero-card">
         <p class="hero-label">${escapeAttr(label)}</p>
         <div class="hero-nums"><span class="hero-now">${base == null ? '—' : fmt(now ?? 0)}</span>${badge}</div>
         <p class="hero-was">was ${base == null ? 'not measured yet' : fmt(base)}</p>
     </div>`;
 }

 // One row of the full comparison table. `avail` per column decides "—" (not measured) vs a real 0.
 function seoCaseStudyRow(label, cols, fmt) {
     fmt = fmt || seoNum;
     const cells = cols.map(c => `<td>${(c.avail === false || c.value == null) ? '<span class="muted">—</span>' : fmt(c.value)}</td>`);
     return `<tr><th>${escapeAttr(label)}</th>${cells.join('')}</tr>`;
 }

 function buildSeoCaseStudyHtml(clientObj, report, changelog) {
     const b = report.baseline || {}, n = report.now || {}, y = report.yoy || {};
     const hasYoy = !!y.available;
     const periods = [{ w: b, title: 'Before SEO' }, { w: n, title: 'Now' }];
     if (hasYoy) periods.push({ w: y, title: 'A year ago' });

     const posCols = periods.map(p => ({ value: p.w.position != null ? Number(p.w.position).toFixed(1) : null, avail: p.w.available !== false && p.w.position != null }));
     const leadCols = periods.map(p => ({ value: p.w.leads, avail: p.w.leads_available !== false }));
     const ga4Cols = periods.map(p => ({ value: p.w.ga4_sessions, avail: !!p.w.ga4_available }));
     const kwCols = periods.map(p => ({ value: p.w.keywords_page1, avail: !!p.w.rank_available }));
     const mapCols = periods.map(p => ({ value: p.w.map_pack_count, avail: !!p.w.rank_available }));
     const anyGa4 = ga4Cols.some(c => c.avail);
     const anyRank = kwCols.some(c => c.avail);
     const revCols = periods.map(p => ({ value: p.w.google_revenue, avail: Number(p.w.revenue_weeks_reported) > 0 }));
     const jobCols = periods.map(p => ({ value: p.w.jobs_closed, avail: Number(p.w.revenue_weeks_reported) > 0 }));
     const anyRev = revCols.some(c => c.avail);

     const feeTotal = clientObj.seo_monthly_fee ? Number(clientObj.seo_monthly_fee) * (n.days ? n.days / 30 : 3) : null;
     const nowRevenue = revCols[1]?.avail ? Number(revCols[1].value || 0) : null;
     let roiLine = '';
     if (feeTotal != null && nowRevenue != null) {
         roiLine = nowRevenue > feeTotal
             ? `<p class="roi-line">Over this period, revenue from Google (${seoNum(nowRevenue)}, as dollars) came in above what was spent on SEO (about ${seoNum(feeTotal)}).</p>`
             : `<p class="roi-line muted">SEO builds over time — revenue from Google hasn't yet passed the period's SEO fee. Rankings, visits and leads are already moving; return usually follows.</p>`;
     }

     const timeline = [...changelog].sort((a, b2) => (a.live_date || '').localeCompare(b2.live_date || ''));
     const timelineHtml = timeline.length
         ? timeline.map(c => {
             const kind = SEO_CHANGELOG_KINDS[c.kind] || SEO_CHANGELOG_KINDS.other;
             return `<li><span class="dot" style="background:${kind.color}"></span><div>
                 <p class="tl-date">${seoCaseStudyFmtDate(c.live_date)} · ${escapeAttr(kind.label)}</p>
                 <p class="tl-title">${escapeAttr(c.title)}</p>
                 ${c.notes ? `<p class="tl-notes">${escapeAttr(c.notes)}</p>` : ''}
             </div></li>`;
         }).join('')
         : '<p class="muted">No work has been logged yet.</p>';

     const rankNote = report.rank_tracking_started
         ? `Tracked rank began ${seoCaseStudyFmtDate(report.rank_tracking_started)} — a period entirely before that date can't show a rank comparison.`
         : 'No keywords are tracked in SE Ranking yet.';

     return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeAttr(clientObj.name)} — SEO Case Study</title><style>
         * { box-sizing: border-box; }
         body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #1e293b; margin: 0; padding: 40px 48px; background: #fff; }
         h1 { font-size: 26px; margin: 0 0 2px; }
         .sub { color: #64748b; font-size: 13px; margin: 0 0 28px; }
         .hero-row { display: flex; gap: 16px; margin-bottom: 28px; flex-wrap: wrap; }
         .hero-card { flex: 1; min-width: 150px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; padding: 16px 18px; }
         .hero-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; font-weight: 700; margin: 0 0 8px; }
         .hero-nums { display: flex; align-items: baseline; gap: 10px; }
         .hero-now { font-size: 28px; font-weight: 800; color: #0f172a; }
         .hero-badge { font-size: 12px; font-weight: 700; color: #059669; background: #d1fae5; padding: 2px 8px; border-radius: 999px; }
         .hero-badge.muted { color: #64748b; background: #e2e8f0; }
         .hero-was { font-size: 12px; color: #94a3b8; margin: 6px 0 0; }
         h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; margin: 28px 0 10px; }
         table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 4px; }
         th, td { text-align: right; padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
         th:first-child, td:first-child { text-align: left; font-weight: 600; color: #334155; }
         thead th { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 700; border-bottom: 2px solid #cbd5e1; }
         .muted { color: #94a3b8; }
         .note { font-size: 11px; color: #94a3b8; margin: 4px 0 0; }
         .roi-line { font-size: 13px; margin: 10px 0 0; padding: 10px 14px; background: #f0fdf4; border-radius: 10px; color: #166534; }
         .roi-line.muted { background: #f8fafc; color: #64748b; }
         ul.timeline { list-style: none; margin: 0; padding: 0; }
         ul.timeline li { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid #f1f5f9; }
         .dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 4px; flex-shrink: 0; }
         .tl-date { font-size: 11px; color: #94a3b8; margin: 0; }
         .tl-title { font-size: 13px; font-weight: 600; margin: 2px 0 0; color: #1e293b; }
         .tl-notes { font-size: 12px; color: #64748b; margin: 2px 0 0; }
         footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; }
         @media print { body { padding: 20px 28px; } }
     </style></head><body>
         <h1>${escapeAttr(clientObj.name)}</h1>
         <p class="sub">SEO results · ${escapeAttr(seoCaseStudyFmtRange(b.start, b.end))} vs. ${escapeAttr(seoCaseStudyFmtRange(n.start, n.end))}</p>

         <div class="hero-row">
             ${seoCaseStudyHero('Visits from Google', b.available !== false ? b.clicks : null, n.clicks, 50)}
             ${seoCaseStudyHero('Organic leads', b.leads_available !== false ? b.leads : null, n.leads, 5)}
             ${anyRank ? seoCaseStudyHero('Keywords on page 1', b.rank_available ? b.keywords_page1 : null, n.keywords_page1, 0) : ''}
         </div>

         <h2>Full comparison</h2>
         <table>
             <thead><tr><th></th>${periods.map(p => `<th>${escapeAttr(p.title)}<br><span style="font-weight:400">${escapeAttr(seoCaseStudyFmtRange(p.w.start, p.w.end))}</span></th>`).join('')}</tr></thead>
             <tbody>
                 ${seoCaseStudyRow('Visits from Google', periods.map(p => ({ value: p.w.clicks, avail: p.w.available !== false })))}
                 ${seoCaseStudyRow('Times shown in search', periods.map(p => ({ value: p.w.impressions, avail: p.w.available !== false })))}
                 ${seoCaseStudyRow('Average position', posCols, v => v)}
                 ${seoCaseStudyRow('Organic leads', leadCols)}
                 ${anyGa4 ? seoCaseStudyRow('Website sessions (all sources)', ga4Cols) : ''}
                 ${anyRank ? seoCaseStudyRow('Keywords on page 1', kwCols) : ''}
                 ${anyRank ? seoCaseStudyRow('Keywords in the map pack', mapCols) : ''}
                 ${anyRev ? seoCaseStudyRow('Jobs closed from Google', jobCols) : ''}
                 ${anyRev ? seoCaseStudyRow('Revenue from Google', revCols, v => '$' + seoNum(v)) : ''}
             </tbody>
         </table>
         ${anyRank ? `<p class="note">${escapeAttr(rankNote)}</p>` : ''}
         ${b.leads_available === false ? `<p class="note">Website leads have been tracked since ${escapeAttr(seoCaseStudyFmtDate(report.lead_tracking_start))}; a period before that shows as not measured, never zero.</p>` : ''}
         ${roiLine}

         <h2>Work completed</h2>
         <ul class="timeline">${timelineHtml}</ul>

         <footer>Generated ${escapeAttr(new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))} by Golden Eye.
         Search Console figures may still be settling for the most recent day or two. Figures shown as "—" mean the metric wasn't tracked yet for that period, not that it measured zero.</footer>
     </body></html>`;
 }

 window.openSeoCaseStudy = async function() {
     const clientObj = globalClientsData.find(c => normalize(c.name) === normalize(cSelectedAccount));
     const errBox = document.getElementById('seo-case-study-error');
     const modal = document.getElementById('seo-case-study-modal');
     const frame = document.getElementById('seo-case-study-frame');
     if (!clientObj || !modal || !frame) return;
     if (errBox) errBox.classList.add('hidden');
     document.getElementById('seo-case-study-title').textContent = `${clientObj.name} — SEO Results`;
     frame.srcdoc = '<body style="font-family:sans-serif;color:#64748b;padding:40px;">Loading…</body>';
     modal.style.display = 'flex';
     try {
         const { data, error } = await supabaseClient.rpc('seo_case_study_report', { p_client: clientObj.name });
         if (error) throw error;
         // The changelog for this exact client is already loaded by renderAdminSeo, in display
         // (newest-first) order; reused rather than re-fetched.
         const changelog = (seoChangelogClient === clientObj.name) ? seoChangelogEntries : [];
         frame.srcdoc = buildSeoCaseStudyHtml(clientObj, data, changelog);
     } catch (err) {
         const missing = /function|does not exist|schema cache/i.test(err.message || '');
         if (errBox) {
             errBox.classList.remove('hidden');
             errBox.textContent = missing
                 ? 'Case studies need their function. Run supabase/sql/seo_case_study.sql.'
                 : `Couldn't build the case study: ${err.message}`;
         }
         frame.srcdoc = '<body></body>';
     }
 };

 window.printSeoCaseStudy = function() {
     const frame = document.getElementById('seo-case-study-frame');
     try { frame.contentWindow.focus(); frame.contentWindow.print(); }
     catch (err) { console.error('print failed:', err); }
 };

 // ---- Google Business Profile (via SE Ranking Local Marketing, built 2026-09-16) ----
 let seoGbpChart = null;

 function renderSeoGbp(res, clientObj, s, e) {
     const panel = document.getElementById('seo-gbp-panel');
     const empty = document.getElementById('seo-gbp-empty');
     const body = document.getElementById('seo-gbp-body');
     const when = document.getElementById('seo-gbp-when');
     if (!panel || !empty || !body) return;
     panel.classList.remove('hidden');
     const showEmpty = (html) => {
         empty.innerHTML = html; empty.classList.remove('hidden'); body.classList.add('hidden');
         if (when) when.textContent = '';
         if (seoGbpChart) { seoGbpChart.destroy(); seoGbpChart = null; }
     };
     if (!clientObj.seranking_local_id) {
         showEmpty(`No Business Profile connected for ${escapeAttr(clientObj.name)}. Add their profile in SE Ranking → Local Marketing, connect Google, then paste the location ID under Edit.`);
         return;
     }
     if (res?.error) {
         const missing = /function|does not exist|schema cache/i.test(res.error.message || '');
         showEmpty(missing
             ? '<span class="text-amber-400">Business Profile needs its tables. Run supabase/sql/gbp.sql, then deploy seranking-sync.</span>'
             : `<span class="text-red-400">Couldn't load Business Profile data: ${escapeAttr(res.error.message)}</span>`);
         return;
     }
     const d = res?.data;
     if (!d || !d.last_date) {
         showEmpty('Connected, but nothing has synced yet. SE Ranking data arrives with the daily sync at 19:00 UTC, including about 18 months of history.');
         return;
     }
     empty.classList.add('hidden');
     body.classList.remove('hidden');
     if (when) when.textContent = `Since ${d.first_date} · Google reports this a few days late${d.last_date < seoIso(e) ? `, data through ${d.last_date}` : ''}`;

     const c = d.current || {}, p = d.prior || {};
     const tile = (id, val, pill) => { const el = document.getElementById(id); if (el) el.innerHTML = `${val} ${pill || ''}`; };
     tile('seo-gbp-calls', seoNum(c.calls), seoDeltaPill(Number(c.calls), Number(p.calls)));
     tile('seo-gbp-web', seoNum(c.website_clicks), seoDeltaPill(Number(c.website_clicks), Number(p.website_clicks)));
     tile('seo-gbp-dirs', seoNum(c.direction_requests), seoDeltaPill(Number(c.direction_requests), Number(p.direction_requests)));
     tile('seo-gbp-msgs', seoNum(c.conversations), seoDeltaPill(Number(c.conversations), Number(p.conversations)));
     const views = Number(c.views_search) + Number(c.views_maps), priorViews = Number(p.views_search) + Number(p.views_maps);
     tile('seo-gbp-views', seoNum(views), seoDeltaPill(views, priorViews));
     const rv = d.reviews;
     const newCount = Number(d.new_reviews?.count) || 0;
     tile('seo-gbp-reviews', rv
         ? `${rv.average_rating != null ? Number(rv.average_rating).toFixed(1) + '<span class="text-amber-400 text-base">★</span>' : '—'} <span class="text-xs font-normal text-gray-400">${seoNum(rv.total_reviews)} total</span>`
         : '—',
         `<span class="block text-[10px] font-bold ${newCount ? 'text-emerald-400' : 'text-gray-500'}">${newCount ? `+${newCount} new` : 'none new'} (${seoNum(d.prior_new_reviews)} the period before)</span>`);

     renderSeoGbpChart(d, s, e);

     const where = document.getElementById('seo-gbp-where');
     if (where) {
         const bar = (label, n, total, color) => `<div>
             <div class="flex justify-between gap-3 text-xs mb-1"><span class="text-gray-300">${label}</span><span class="tabular-nums text-gray-400"><span class="text-white font-bold">${seoNum(n)}</span> · ${seoPct(seoRatio(n, total))}</span></div>
             <div class="h-1.5 rounded-full bg-white/5 overflow-hidden"><div class="h-full rounded-full ${color}" style="width:${((seoRatio(n, total) || 0) * 100).toFixed(1)}%"></div></div>
         </div>`;
         where.innerHTML = views
             ? bar('Google Search', c.views_search, views, 'bg-blue-400') + bar('Google Maps', c.views_maps, views, 'bg-blue-400')
               + `<p class="text-[10px] text-gray-500 pt-1">${seoPct(seoRatio(c.views_mobile, views))} on phones</p>`
             : '<p class="text-sm text-gray-500">The profile wasn\'t shown in this range.</p>';
     }

     const fmtMonth = (m) => new Date(m + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
     const cell = (v) => (v == null ? '<span class="text-gray-600">—</span>' : seoNum(v));
     const sBody = document.getElementById('seo-gbp-searches-tbody');
     if (sBody) {
         const rows = [...(d.searches || [])].reverse();
         sBody.innerHTML = rows.length ? rows.map(r => `<tr class="hover:bg-white/5 transition">
             <td class="py-2 pr-2 text-gray-300">${fmtMonth(r.month)}</td>
             <td class="py-2 text-right text-gray-400 tabular-nums">${cell(r.direct)}</td>
             <td class="py-2 text-right font-bold text-white tabular-nums">${cell(r.discovery)}</td>
         </tr>`).join('') : '<tr><td colspan="3" class="py-4 text-center text-gray-500">No monthly search data yet.</td></tr>';
         seoShowMore(sBody.closest('table'), rows.length ? [...sBody.rows] : [], 'gbp-searches', 'months');
     }

     const kMonths = document.getElementById('seo-gbp-kw-months');
     const months = d.keyword_months || [];
     if (kMonths) kMonths.textContent = months.length
         ? `Google reports these by month: ${months.map(fmtMonth).join(', ')}. Terms under Google's minimum show —.`
         : 'Google reports these by finished month, so a range inside the current month has none yet.';
     const kBody = document.getElementById('seo-gbp-keywords-tbody');
     if (kBody) {
         const rows = d.keywords || [];
         kBody.innerHTML = rows.length ? rows.map(r => `<tr class="hover:bg-white/5 transition">
             <td class="py-2 pr-2 text-gray-300 truncate max-w-[240px]" title="${escapeAttr(r.keyword)}">${escapeAttr(r.keyword)}</td>
             <td class="py-2 text-right font-bold text-white tabular-nums">${cell(r.impressions)}</td>
         </tr>`).join('') : '<tr><td colspan="2" class="py-4 text-center text-gray-500">No search terms for these months.</td></tr>';
         seoShowMore(kBody.closest('table'), rows.length ? [...kBody.rows] : [], 'gbp-keywords', 'terms');
     }

     const un = document.getElementById('seo-gbp-unanswered');
     if (un) {
         const rows = d.unanswered || [];
         const stars = (n) => n == null ? '' : `<span class="text-amber-400">${'★'.repeat(Math.max(0, Math.min(5, n)))}</span><span class="text-gray-600">${'★'.repeat(5 - Math.max(0, Math.min(5, n)))}</span>`;
         un.innerHTML = rows.length ? rows.map(r => `<div class="p-3 rounded-xl border border-white/10">
             <div class="flex flex-wrap justify-between gap-2 text-xs mb-1">
                 <span>${stars(r.rating)} <span class="text-gray-300 ml-1">${escapeAttr(r.reviewer_name || 'Anonymous')}</span></span>
                 <span class="text-gray-500">${escapeAttr(String(r.created_at || '').slice(0, 10))}${/^https?:\/\//i.test(r.review_url || '') ? ` · <a href="${escapeAttr(r.review_url)}" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:text-blue-300">Reply on Google</a>` : ''}</span>
             </div>
             <p class="text-sm text-gray-400">${r.review_text ? escapeAttr(r.review_text) : '<span class="italic text-gray-600">Rating only, no text</span>'}</p>
         </div>`).join('') : '<p class="text-sm text-gray-500">Every review has a reply.</p>';
         seoShowMore(un, rows.length ? [...un.children] : [], 'gbp-unanswered', 'reviews');
     }
 }

 function renderSeoGbpChart(d, s, e) {
     const canvas = document.getElementById('seoGbpChart');
     if (!canvas) return;
     if (seoGbpChart) seoGbpChart.destroy();
     const byDate = Object.fromEntries((d.series || []).map(r => [r.date, r]));
     const labels = [];
     for (let t = new Date(s); t <= e; t.setDate(t.getDate() + 1)) labels.push(seoIso(t));
     // Days Google hasn't reported yet are left empty rather than drawn as zero
     const val = (l, k) => (l > d.last_date ? null : Number(byDate[l]?.[k] ?? 0));
     const isLight = document.getElementById('theme-wrapper')?.classList.contains('light-mode');
     const surface = isLight ? '#ffffff' : '#111827';
     const bar = (label, key, color) => ({ label, data: labels.map(l => val(l, key)), backgroundColor: color, borderColor: surface, borderWidth: { top: 2 }, borderRadius: 2, maxBarThickness: 18 });
     seoGbpChart = new Chart(canvas.getContext('2d'), {
         type: 'bar',
         data: { labels, datasets: [bar('Calls', 'calls', '#60a5fa'), bar('Website clicks', 'website_clicks', '#34d399'), bar('Directions', 'direction_requests', '#fbbf24')] },
         options: {
             maintainAspectRatio: false,
             interaction: { mode: 'index', intersect: false },
             scales: {
                 x: { stacked: true, grid: { display: false }, ticks: { color: isLight ? '#64748b' : '#9ca3af', maxTicksLimit: 8 } },
                 y: { stacked: true, beginAtZero: true, grid: { color: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)' }, ticks: { color: isLight ? '#64748b' : '#9ca3af', precision: 0 } }
             },
             plugins: { legend: { display: false } }
         }
     });
 }

 window.renderAdminSeo = async function() {
     const notice = document.getElementById('seo-select-client-notice');
     const content = document.getElementById('seo-client-content');
     if (!notice || !content) return;

     // An "ALL" rollup can't average position across accounts meaningfully — the old tab
     // only produced one because normalize().includes() happened to let every row through.
     if (cSelectedAccount === 'ALL') {
         notice.classList.remove('hidden');
         content.classList.add('hidden');
         return;
     }
     notice.classList.add('hidden');
     content.classList.remove('hidden');

     const clientObj = globalClientsData.find(c => normalize(c.name) === normalize(cSelectedAccount));
     if (!clientObj) return;
     const clientName = clientObj.name; // exact stored name — every new SEO table keys on this, not the fuzzy match

     const { s, e } = dateRangeFor(cDateRange, cCustomStart, cCustomEnd);
     const spanDays = Math.round((e - s) / 86400000) + 1;
     const priorEnd = new Date(s); priorEnd.setDate(priorEnd.getDate() - 1);
     const priorStart = new Date(priorEnd); priorStart.setDate(priorStart.getDate() - spanDays + 1);

     // Two inner states inside `content` itself, rather than replacing content.innerHTML
     // wholesale — overwriting it would permanently destroy the KPI/chart/table markup
     // for the rest of the session, breaking every later client who DOES have data.
     const noDataNotice = document.getElementById('seo-no-data-notice');
     const dataBody = document.getElementById('seo-data-body');
     if (!clientObj.gsc_property && !clientObj.seranking_site_id && !clientObj.ga4_property_id && !clientObj.seranking_local_id) {
         if (noDataNotice) { noDataNotice.classList.remove('hidden'); noDataNotice.innerText = `No Search Console property, GA4 property or SE Ranking project set for ${clientName} yet — add one under Edit.`; }
         if (dataBody) dataBody.classList.add('hidden');
         return;
     }
     if (noDataNotice) noDataNotice.classList.add('hidden');
     if (dataBody) dataBody.classList.remove('hidden');

     try {
         const { daily, leads } = await loadSeoAdminData(clientName);

         const cur = seoWindowTotals(daily, s, e);
         const pri = seoWindowTotals(daily, priorStart, priorEnd);
         const curLeads = seoLeadsInWindow(leads, s, e);
         const priLeads = seoLeadsInWindow(leads, priorStart, priorEnd);

         const setTile = (id, val, deltaHtml) => {
             const el = document.getElementById(id);
             if (el) el.innerHTML = `${val} ${deltaHtml || ''}`;
         };
         setTile('seo-kpi-clicks', cur.clicks.toLocaleString(), seoDeltaPill(cur.clicks, pri.clicks));
         setTile('seo-kpi-imp', cur.impressions.toLocaleString(), seoDeltaPill(cur.impressions, pri.impressions));
         setTile('seo-kpi-ctr', cur.ctr.toFixed(2) + '%', seoDeltaPill(cur.ctr, pri.ctr));
         setTile('seo-kpi-pos', cur.position != null ? cur.position.toFixed(1) : '—', seoDeltaPill(cur.position, pri.position, { invert: true }));
         setTile('seo-kpi-leads', curLeads.toLocaleString(), seoDeltaPill(curLeads, priLeads));

         // Changelog first, so the chart can draw its markers. A client's entries number in the
         // dozens, not the thousands, so they're read whole.
         const { data: changelog, error: changelogErr } = await supabaseClient
             .from('seo_changelog').select('*').eq('client_name', clientName)
             .order('live_date', { ascending: false });
         if (changelogErr) console.error('seo_changelog failed:', changelogErr);
         seoChangelogEntries = changelog || [];
         seoChangelogClient = clientName;
         const markers = seoChangelogMarkers(seoChangelogEntries, s, e);
         renderSeoChangelogList(seoChangelogEntries, markers, !!changelogErr);
         refreshSeoAutologStatus(clientObj).catch(err => console.error('seo auto-log status failed:', err));

         renderSeoChart(daily, s, e, markers);

         const iso = seoIso;
         // At least ~1 impression a day, never under 10: enough to be a real search, without a
         // 90-day view filling up with queries seen twice
         const almostMinImpr = Math.max(10, spanDays);
         const [pagesRes, keywordsRes, moversRes, almostRes, cityRes] = await Promise.all([
             supabaseClient.rpc('seo_page_summary', { p_client: clientName, p_start: iso(s), p_end: iso(e), p_prior_start: iso(priorStart), p_prior_end: iso(priorEnd) }),
             supabaseClient.rpc('seo_keyword_summary', { p_client: clientName, p_start: iso(s), p_end: iso(e), p_prior_start: iso(priorStart), p_prior_end: iso(priorEnd) }),
             supabaseClient.rpc('seo_movers', { p_client: clientName, p_start: iso(s), p_end: iso(e), p_prior_start: iso(priorStart), p_prior_end: iso(priorEnd) }),
             supabaseClient.rpc('seo_almost_page_one', { p_client: clientName, p_start: iso(s), p_end: iso(e), p_prior_start: iso(priorStart), p_prior_end: iso(priorEnd), p_min_impressions: almostMinImpr }),
             // Per-city rankings; missing until seo_admin_rpcs.sql is re-run, and the table then
             // simply shows the best city as before
             supabaseClient.rpc('seo_keyword_city_ranks', { p_client: clientName, p_start: iso(s), p_end: iso(e), p_prior_start: iso(priorStart), p_prior_end: iso(priorEnd) })
         ]);
         if (cityRes.error) console.warn('seo_keyword_city_ranks unavailable (re-run supabase/sql/seo_admin_rpcs.sql):', cityRes.error);
         if (pagesRes.error) console.error('seo_page_summary failed:', pagesRes.error);
         if (keywordsRes.error) console.error('seo_keyword_summary failed:', keywordsRes.error);
         if (moversRes.error) console.error('seo_movers failed:', moversRes.error);
         if (almostRes.error) console.error('seo_almost_page_one failed:', almostRes.error);

         renderSeoPagesTable(pagesRes.data || []);
         renderSeoKeywordsTable(keywordsRes.data || [], cityRes.error ? [] : (cityRes.data || []));
         renderSeoMoversPanel(moversRes.data || []);
         renderSeoAlmostPageOne(almostRes.data || [], almostMinImpr, !!almostRes.error);

         // Competitors are their own three RPCs, fetched after the rest so a database that hasn't
         // run seo_competitors.sql yet still renders the whole tab.
         const [compRes, vsRes, marketRes] = await Promise.all([
             supabaseClient.rpc('seo_competitor_overview', { p_client: clientName, p_start: iso(s), p_end: iso(e) }),
             supabaseClient.rpc('seo_competitor_keyword_matrix', { p_client: clientName, p_start: iso(s), p_end: iso(e) }),
             supabaseClient.rpc('seo_market_leaders', { p_client: clientName, p_start: iso(s), p_end: iso(e), p_limit: 25 })
         ]);
         renderSeoCompetitors(compRes, vsRes, marketRes);

         // Map Pack: same seo_rank_checks rows the keyword table reads, just aggregated as a trend.
         const mapPackRes = clientObj.seranking_site_id
             ? await supabaseClient.rpc('seo_map_pack_report', { p_client: clientName, p_start: iso(s), p_end: iso(e), p_prior_start: iso(priorStart), p_prior_end: iso(priorEnd) })
             : null;
         renderSeoMapPack(mapPackRes, clientObj);

         // The latest site audit and the one before it, for "what changed". Not tied to the date
         // range: an audit is a monthly snapshot, and the newest one is always the one to act on.
         const auditRes = await supabaseClient.from('seo_site_audits')
             .select('seranking_audit_id, audit_time, score, pages_crawled, errors, warnings, notices, issues')
             .eq('client_name', clientName).order('audit_time', { ascending: false }).limit(2);
         renderSeoSiteAudit(auditRes);

         // Site Analytics last: GA4 covers every visit, not only search. Missing until ga4_analytics.sql runs.
         const ga4Res = clientObj.ga4_property_id
             ? await supabaseClient.rpc('seo_ga4_report', { p_client: clientName, p_start: iso(s), p_end: iso(e), p_prior_start: iso(priorStart), p_prior_end: iso(priorEnd) })
             : null;
         renderSeoGa4(ga4Res, clientObj, s, e);

         const gbpRes = clientObj.seranking_local_id
             ? await supabaseClient.rpc('seo_gbp_report', { p_client: clientName, p_start: iso(s), p_end: iso(e), p_prior_start: iso(priorStart), p_prior_end: iso(priorEnd) })
             : null;
         renderSeoGbp(gbpRes, clientObj, s, e);
     } catch (err) {
         console.error('renderAdminSeo failed:', err);
     }
 };

 // ---- Client portal: Organic Search (rebuilt 2026-09-14) ----
 // For clients who know little about SEO. Outcomes first (leads, jobs, visits), then progress
 // (since SEO started), then cause and effect (the chart with work markers), then rankings and
 // what's next. Every figure comes from SECURITY INVOKER functions in supabase/sql/seo_client_tab.sql,
 // so the client's own RLS decides what they can read. Nothing is bulk-loaded (see the 1000-row cap
 // in CLAUDE.md).
 //
 // Two honesty rules decide what's shown:
 // - Noise guard: under 5 leads or 50 visits, a change is stated as the plain earlier number,
 //   never as a percentage swing.
 // - The return-per-dollar line appears only when revenue from Google beats the SEO fee for the
 //   period. Before that, "SEO builds over time" shows progress instead. SEO takes months, and a
 //   sub-1× ratio shouldn't be the first thing a client sees.
 let cpSeoShowAllKeywords = false;
 let cpSeoRenderToken = 0;
 let cpSeoLastKeywords = [];
 // lead_sources only exists from this date. Any earlier "leads from Google" figure would read as 0
 // when it was really never measured.
 const LEAD_TRACKING_START = '2026-09-11';

 function cpSeoClientRow() {
     return (portalClientRows || []).find(r => normalize(r.name) === normalize(currentActiveClient)) || null;
 }

 // The tab exists only for clients with SEO connected. If RLS hides the client row, the answer is
 // unknown, so the tab stays and renderCpSeo shows its empty state if there's nothing to show.
 function updateSeoTabVisibility() {
     const btn = document.getElementById('cp-tab-seo');
     if (!btn) return;
     const row = cpSeoClientRow();
     const off = !!row && !row.gsc_property && !row.seranking_site_id;
     btn.classList.toggle('hidden', off);
     if (off && window.cpCurrentTab === 'seo') switchCpTab('dashboard');
 }

 // Position buckets, with the validated ordinal ramp for each theme
 function cpSeoRamp() {
     const light = document.getElementById('theme-wrapper')?.classList.contains('light-mode');
     return light
         ? { t3: '#7C3A0A', p1: '#9A4F0C', p2: '#B8680F', b50: '#CF8A2E', b100: '#DDA85C', none: '#E2E8F0', ink: '#FFFFFF', noneInk: '#475569' }
         : { t3: '#FBBF24', p1: '#D69A22', p2: '#A27A2C', b50: '#74613A', b100: '#524C40', none: 'rgba(255,255,255,0.08)', ink: '#1A1204', noneInk: '#9CA3AF' };
 }
 const CP_SEO_BUCKET_NAMES = { t3: 'Top 3', p1: 'Page 1', p2: 'Page 2', b50: '#21–50', b100: '#51–100', none: 'Not ranking yet' };
 function cpSeoBucket(best) {
     if (best == null) return 'none';
     if (best <= 3) return 't3';
     if (best <= 10) return 'p1';
     if (best <= 20) return 'p2';
     return best <= 50 ? 'b50' : 'b100';
 }
 // Best of organic and map pack, the same rule seo_keyword_distribution uses
 const cpSeoBest = (organic, map) => {
     const o = organic == null ? null : Number(organic), m = map == null ? null : Number(map);
     return o == null ? m : m == null ? o : Math.min(o, m);
 };

 function cpSeoDelta(el, cur, prior, smallBelow, noun) {
     if (!el) return;
     cur = Number(cur) || 0; prior = Number(prior) || 0;
     if (cur === 0 && prior === 0) { el.className = 'text-xs font-bold text-gray-500'; el.innerText = 'None in the period before either'; return; }
     if (cur < smallBelow || prior < smallBelow) {
         el.className = 'text-xs font-bold text-gray-400';
         el.innerText = `${prior.toLocaleString()} ${noun} the period before`;
         return;
     }
     const pct = Math.round(((cur - prior) / prior) * 100);
     if (Math.abs(pct) < 3) { el.className = 'text-xs font-bold text-gray-400'; el.innerText = 'About the same as the period before'; return; }
     el.className = `text-xs font-bold ${pct > 0 ? 'text-emerald-400' : 'text-orange-400'}`;
     el.innerText = `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs the period before`;
 }

 const cpSeoDate = (ymd, withYear = true) => ymd
     ? new Date(String(ymd).slice(0, 10) + 'T12:00:00').toLocaleDateString(undefined, withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' })
     : '';
 const cpSeoSafeUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : ''; } catch (_) { return ''; } };

 window.toggleCpSeoKeywords = function() {
     cpSeoShowAllKeywords = !cpSeoShowAllKeywords;
     renderCpSeoKeywords(cpSeoLastKeywords);
 };

 // ---- "How you compare" (client portal) ----
 // Deliberately plainer than the admin grid: a client wants "am I ahead of these people", not a
 // rank matrix. Counts, never percentages, and the section hides itself entirely rather than
 // showing an empty or one-sided comparison.
 //
 // Two honesty rules, both the same kind as the rest of this tab:
 // - Only searches where BOTH sides rank are called ahead/behind. A competitor who isn't in the
 //   top 100 for a search isn't someone we "beat" there; that's the separate "only you" count.
 // - The heading says Google Maps isn't included, because SE Ranking gives us no competitor map
 //   rank. Without that line a client could read this as their whole local picture.
 function renderCpSeoCompetitors(vsRes) {
     const wrap = document.getElementById('cp-seo-vs-wrap');
     const host = document.getElementById('cp-seo-vs-list');
     if (!wrap || !host) return;
     const rows = (vsRes?.error ? [] : (vsRes?.data || []))
         .filter(r => Number(r.ahead_of_them || 0) + Number(r.behind_them || 0) > 0);
     wrap.classList.toggle('hidden', !rows.length);
     if (!rows.length) return;

     host.innerHTML = rows.map(r => {
         const ahead = Number(r.ahead_of_them || 0);
         const behind = Number(r.behind_them || 0);
         const only = Number(r.not_ranking_them || 0);
         const compared = ahead + behind;
         const pct = Math.round((ahead / compared) * 100);
         const name = r.competitor_name || r.domain || 'A competitor';
         const winning = ahead > behind;
         return `<div class="border-b border-white/5 last:border-0 pb-4 last:pb-0">
             <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-2">
                 <p class="font-bold text-white">${escapeAttr(name)}</p>
                 <p class="text-sm ${winning ? 'text-emerald-400' : 'text-gray-400'}">
                     You're ahead on <span class="font-bold">${ahead}</span> of ${compared} shared ${compared === 1 ? 'search' : 'searches'}
                 </p>
             </div>
             <div class="flex h-2.5 gap-[2px] rounded-full overflow-hidden" role="img" aria-label="Ahead on ${ahead} of ${compared} searches">
                 <div class="bg-emerald-500/80" style="width:${pct}%"></div>
                 <div class="bg-white/10 flex-1"></div>
             </div>
             ${only ? `<p class="text-xs text-gray-500 mt-1.5">Plus ${only} ${only === 1 ? 'search' : 'searches'} where you show up and they don't.</p>` : ''}
         </div>`;
     }).join('');
 }

 function renderCpSeoKeywords(rows) {
     const wrap = document.getElementById('cp-seo-kw-wrap');
     if (!wrap) return;
     cpSeoLastKeywords = rows;
     wrap.classList.toggle('hidden', !rows.length);
     if (!rows.length) return;

     const ramp = cpSeoRamp();
     const order = ['t3', 'p1', 'p2', 'b50', 'b100', 'none'];
     const counts = Object.fromEntries(order.map(k => [k, 0]));
     const items = rows.map(r => {
         const best = cpSeoBest(r.rank, r.map_rank);
         const prior = cpSeoBest(r.prior_rank, r.prior_map_rank);
         const bucket = cpSeoBucket(best);
         counts[bucket]++;
         return { r, best, prior, bucket, viaMap: r.map_rank != null && (r.rank == null || Number(r.map_rank) < Number(r.rank)) };
     });
     const onPage1 = counts.t3 + counts.p1;

     const dist = document.getElementById('cp-seo-dist');
     dist.setAttribute('aria-label', `${onPage1} of ${rows.length} target searches on page 1`);
     const present = order.filter(k => counts[k]);
     dist.innerHTML = present.map((k, i) =>
         `<div title="${CP_SEO_BUCKET_NAMES[k]}: ${counts[k]}" style="flex:${counts[k]};background:${ramp[k]};border-radius:${i === 0 ? '4px 0 0 4px' : '0'}${i === present.length - 1 ? ';border-top-right-radius:4px;border-bottom-right-radius:4px' : ''}"></div>`).join('');
     document.getElementById('cp-seo-dist-legend').innerHTML =
         `<span class="font-bold text-white">${onPage1} of ${rows.length} on page 1</span>` +
         order.map(k => `<span class="inline-flex items-center gap-1.5"><i style="width:10px;height:10px;border-radius:3px;display:inline-block;background:${ramp[k]}"></i>${CP_SEO_BUCKET_NAMES[k]} <b class="text-white">${counts[k]}</b></span>`).join('');

     items.sort((a, b) => (a.best ?? 9999) - (b.best ?? 9999) || String(a.r.keyword).localeCompare(String(b.r.keyword)));
     const shown = cpSeoShowAllKeywords ? items : items.slice(0, 8);
     document.getElementById('cp-seo-kw-list').innerHTML = shown.map(({ r, best, prior, bucket, viaMap }) => {
         const label = best == null ? 'Not ranking yet'
             : viaMap ? `Map pack #${best}`
             : bucket === 't3' || bucket === 'p1' || bucket === 'p2' ? `${CP_SEO_BUCKET_NAMES[bucket]} · #${best}` : `#${best}`;
         const chipStyle = bucket === 'none'
             ? `background:transparent;color:${ramp.noneInk};border:1px solid ${ramp.none}`
             : bucket === 't3' || bucket === 'p1' ? `background:${ramp[bucket]};color:${ramp.ink}`
             : `background:${ramp[bucket]};color:${bucket === 'p2' ? '#FFFFFF' : ramp.ink}`;
         let move = '<span class="text-gray-500">–</span>';
         if (best != null && prior == null) move = '<span class="text-gray-400">New</span>';
         else if (best != null && prior != null && best !== prior) {
             move = best < prior ? `<span class="text-emerald-400">▲ ${prior - best}</span>` : `<span class="text-orange-400">▼ ${best - prior}</span>`;
         }
         const volume = r.search_volume ? `${Number(r.search_volume).toLocaleString()} searches a month` : 'Local search, low volume';
         return `<div class="grid grid-cols-[minmax(0,1fr)_auto_3.5rem] items-center gap-3 py-2.5 border-b border-white/5 last:border-0">
             <div class="min-w-0"><p class="text-sm font-bold text-white break-words">${escapeAttr(r.keyword)}</p><p class="text-xs text-gray-500">${volume}</p></div>
             <span class="text-xs font-bold px-2.5 py-1 rounded-full whitespace-nowrap" style="${chipStyle}">${label}</span>
             <span class="text-xs font-bold text-right tabular-nums">${move}</span>
         </div>`;
     }).join('');

     const toggle = document.getElementById('cp-seo-kw-toggle');
     toggle.classList.toggle('hidden', items.length <= 8);
     toggle.innerText = cpSeoShowAllKeywords ? 'Show fewer' : `Show all ${items.length} searches`;
 }

 window.renderCpSeo = async function() {
     const token = ++cpSeoRenderToken;
     const $ = (id) => document.getElementById(id);
     const body = $('cp-seo-body'), empty = $('cp-seo-empty'), loading = $('cp-seo-loading');
     if (!body || !empty || !loading) return;

     const row = cpSeoClientRow();
     const client = row?.name || currentActiveClient;
     const showEmpty = () => { loading.classList.add('hidden'); body.classList.add('hidden'); empty.classList.remove('hidden'); };
     if (!client || (row && !row.gsc_property && !row.seranking_site_id)) { showEmpty(); return; }

     // "All time" starts in the year 2000. Search Console keeps 16 months, so clamp to that, which
     // also keeps the period-before comparison meaningful.
     let { s, e } = getPortalRange();
     const earliest = new Date(); earliest.setMonth(earliest.getMonth() - 16); earliest.setHours(0, 0, 0, 0);
     if (s < earliest) s = earliest;
     // floor, not round: e is the end of its day (23:59), so rounding made the comparison window
     // one day longer than the range being reported
     const days = Math.floor((e - s) / 86400000) + 1;
     const priorEnd = new Date(s); priorEnd.setDate(priorEnd.getDate() - 1);
     const priorStart = new Date(priorEnd); priorStart.setDate(priorStart.getDate() - days + 1);
     const ymd = seoLocalYmd;
     const range = { p_client: client, p_start: ymd(s), p_end: ymd(e), p_prior_start: ymd(priorStart), p_prior_end: ymd(priorEnd) };

     // Hold the previous render while refetching (no flash). Show the spinner only the first time.
     if (body.classList.contains('hidden')) { empty.classList.add('hidden'); loading.classList.remove('hidden'); }

     const [ovRes, sinceRes, kwRes, almostRes, dailyRes, logRes, vsRes] = await Promise.all([
         supabaseClient.rpc('seo_client_overview', range),
         supabaseClient.rpc('seo_since_start', { p_client: client }),
         supabaseClient.rpc('seo_keyword_summary', range),
         supabaseClient.rpc('seo_almost_page_one', { ...range, p_min_impressions: Math.max(10, days) }),
         supabaseClient.from('seo_daily').select('date, clicks').eq('client_name', client).gte('date', range.p_start).lte('date', range.p_end).order('date'),
         supabaseClient.from('seo_changelog').select('id, live_date, kind, title, url, notes').eq('client_name', client).order('live_date', { ascending: false }).limit(200),
         // Competitors: the section hides itself when the SQL isn't there or nobody is tracked
         supabaseClient.rpc('seo_competitor_overview', { p_client: client, p_start: range.p_start, p_end: range.p_end })
     ]);
     if (token !== cpSeoRenderToken) return;   // a newer render (client or range change) owns the tab

     [['seo_client_overview', ovRes], ['seo_since_start', sinceRes], ['seo_keyword_summary', kwRes], ['seo_almost_page_one', almostRes], ['seo_daily', dailyRes], ['seo_changelog', logRes]]
         .forEach(([name, res]) => { if (res.error) console.error(`Organic Search: ${name} failed`, res.error); });

     const ov = ovRes.data?.[0];
     const keywords = kwRes.data || [];
     const daily = dailyRes.data || [];
     const changelog = logRes.data || [];
     const hasAnything = ov && (Number(ov.clicks) > 0 || Number(ov.prior_clicks) > 0 || Number(ov.keywords_tracked) > 0 || changelog.length || daily.length);
     if (!hasAnything) { showEmpty(); return; }

     loading.classList.add('hidden'); empty.classList.add('hidden'); body.classList.remove('hidden');
     const n = (v) => v == null ? null : Number(v);

     // ---- 1. What SEO did for you
     const lagNote = ov.gsc_last_date && String(ov.gsc_last_date).slice(0, 10) < range.p_end
         ? ` Google's search data runs 2–3 days behind, so visits are complete through ${cpSeoDate(ov.gsc_last_date, false)}.` : '';
     $('cp-seo-range-label').innerText = `${cpSeoDate(range.p_start)} – ${cpSeoDate(range.p_end)}, compared with the ${days} days before.${lagNote}`;

     $('cp-seo-leads').innerText = (n(ov.organic_leads) || 0).toLocaleString();
     if (range.p_prior_end < LEAD_TRACKING_START) {
         const d = $('cp-seo-leads-delta'); d.className = 'text-xs font-bold text-gray-500'; d.innerText = `Tracking began ${cpSeoDate(LEAD_TRACKING_START)}`;
     } else {
         cpSeoDelta($('cp-seo-leads-delta'), ov.organic_leads, ov.prior_organic_leads, 5, n(ov.prior_organic_leads) === 1 ? 'lead' : 'leads');
     }
     $('cp-seo-visits').innerText = (n(ov.clicks) || 0).toLocaleString();
     cpSeoDelta($('cp-seo-visits-delta'), ov.clicks, ov.prior_clicks, 50, 'visits');

     $('cp-seo-jobs').innerHTML = n(ov.checkins_with_sources) > 0
         ? `<p class="text-[11px] font-bold text-gray-500 uppercase tracking-widest">Jobs closed from Google</p>
            <p class="text-4xl md:text-5xl font-bold text-white tracking-tight">${(n(ov.google_closes) || 0).toLocaleString()}<span class="text-lg font-bold text-gray-400 ml-2">${money0(ov.google_revenue || 0)}</span></p>
            <p class="text-xs font-bold text-gray-400">From your weekly check-ins</p>
            <p class="text-xs text-gray-500">Jobs you told us came from Google search or your website</p>`
         : `<p class="text-[11px] font-bold text-gray-500 uppercase tracking-widest">Jobs closed from Google</p>
            <p class="text-base font-bold text-gray-300 pt-2">None reported yet</p>
            <p class="text-xs text-gray-500">When a lead from Google becomes a job, add it to your weekly check-in under "Google search / your website".</p>`;

     // Return per dollar, only when positive
     const roi = n(ov.roi_multiple);
     const since = sinceRes.data?.[0] || null;
     if (roi != null && roi > 1) {
         const perDollar = roi >= 2 ? `$${Math.floor(roi)}` : `$${roi.toFixed(2)}`;
         $('cp-seo-roi').innerHTML = `<div class="rounded-2xl p-5 border border-yellow-400/30 bg-yellow-400/10 flex flex-wrap items-center gap-x-6 gap-y-2">
             <p class="text-2xl md:text-3xl font-extrabold text-white tracking-tight">About ${perDollar} back for every $1</p>
             <p class="text-sm text-gray-300">${money0(ov.google_revenue)} in jobs from Google this period, against ${money0(ov.seo_fee_for_period)} for SEO.</p>
         </div>`;
     } else {
         const start = ov.seo_start_date ? String(ov.seo_start_date).slice(0, 10) : null;
         const monthIn = start ? Math.max(1, Math.floor((Date.now() - new Date(start + 'T12:00:00')) / (30.44 * 86400000)) + 1) : null;
         const workSinceStart = start ? changelog.filter(c => c.live_date >= start).length : changelog.length;
         const steps = [];
         if (n(ov.keywords_tracked) > 0) {
             const was = since && since.rank_baseline_date ? ` (was ${n(since.page1_before)})` : '';
             steps.push([`${n(ov.keywords_page1)}`, `target searches on page 1${was}`]);
             steps.push([`${n(ov.keywords_ranking)} of ${n(ov.keywords_tracked)}`, 'target searches now show up on Google']);
         }
         if (workSinceStart) steps.push([`${workSinceStart}`, start ? `pieces of SEO work live since we started` : 'pieces of SEO work live']);
         const bars = monthIn ? Array.from({ length: 6 }, (_, i) => `<i class="flex-1 h-1.5 rounded ${i < Math.min(monthIn, 6) ? 'bg-yellow-400' : 'bg-white/10'}"></i>`).join('') : '';
         $('cp-seo-roi').innerHTML = `<div class="rounded-2xl p-5 border border-white/10 bg-white/[0.03] grid grid-cols-1 lg:grid-cols-[minmax(220px,1fr)_2fr] gap-5">
             <div>
                 <p class="text-base font-bold text-white">SEO builds over time</p>
                 <p class="text-sm text-gray-400 mt-1">Google takes months to trust a site, so leads usually follow rankings. Here's the groundwork so far.</p>
                 ${monthIn ? `<div class="flex gap-1.5 mt-3" aria-label="Month ${monthIn} of SEO">${bars}</div>
                 <div class="flex justify-between text-[11px] text-gray-500 mt-1.5"><span>Month ${monthIn}</span><span>${monthIn < 6 ? 'Leads usually build by month 3–6' : ''}</span></div>` : ''}
             </div>
             <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">${steps.map(([big, small]) =>
                 `<div class="rounded-xl border border-white/10 p-3"><p class="text-xl font-bold text-white">${escapeAttr(big)}</p><p class="text-xs text-gray-400">${escapeAttr(small)}</p></div>`).join('')}</div>
         </div>`;
     }

     // ---- 2. Since SEO started
     $('cp-seo-since-wrap').classList.toggle('hidden', !since);
     if (since) {
         const items = [];
         const partial = n(since.days_with_data_before) > 0 && n(since.days_with_data_before) < 25 ? ` <span class="text-[11px] text-gray-500">(${n(since.days_with_data_before)} days of data)</span>` : '';
         items.push(['Visits from Google a month', n(since.days_with_data_before) > 0 ? n(since.clicks_before).toLocaleString() + partial : '—', n(since.clicks_after).toLocaleString()]);
         if (since.rank_baseline_date) items.push(['Target searches on page 1', `${n(since.page1_before)}`, `${n(since.page1_after)}`]);
         const leadsMeasuredBefore = String(since.before_start).slice(0, 10) >= LEAD_TRACKING_START;
         items.push(['Leads from Google a month', leadsMeasuredBefore ? `${n(since.leads_before)}` : '—', `${n(since.leads_after)}`]);
         $('cp-seo-since-sub').innerText = `SEO work began ${cpSeoDate(since.start_date)}. Comparing the month before that with your latest month (${cpSeoDate(since.after_start, false)} – ${cpSeoDate(since.after_end, false)}).`;
         $('cp-seo-since').innerHTML = items.map(([label, was, now]) => `<div class="rounded-2xl border border-white/10 p-4">
             <p class="text-[11px] font-bold text-gray-500 uppercase tracking-widest">${label}</p>
             <p class="mt-2 flex items-baseline flex-wrap gap-2"><span class="text-lg font-bold text-gray-400">${was}</span><span class="text-gray-500" aria-hidden="true">→</span><span class="text-3xl font-bold text-white">${now}</span></p>
         </div>`).join('');
     }

     // ---- 3. Chart with work markers
     const markers = seoChangelogMarkers(changelog, s, e);
     if (cpSeoChart) cpSeoChart.destroy();
     const canvas = $('cpSeoChart');
     if (canvas) {
         const light = document.getElementById('theme-wrapper')?.classList.contains('light-mode');
         cpSeoChart = new Chart(canvas.getContext('2d'), {
             type: 'line',
             plugins: [seoChangelogChartPlugin],
             data: {
                 labels: daily.map(d => d.date),
                 datasets: [{ label: 'Visits from Google', data: daily.map(d => d.clicks || 0), borderColor: light ? '#2563EB' : '#60A5FA', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.3, fill: true, backgroundColor: light ? 'rgba(37,99,235,0.10)' : 'rgba(96,165,250,0.12)' }]
             },
             options: {
                 maintainAspectRatio: false,
                 interaction: { mode: 'index', intersect: false },
                 layout: { padding: { top: markers.length ? 14 : 0 } },
                 scales: {
                     x: { grid: { display: false }, ticks: { maxTicksLimit: 7, callback: function(v) { return cpSeoDate(this.getLabelForValue(v), false); } } },
                     y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: light ? 'rgba(15,23,42,0.06)' : 'rgba(255,255,255,0.06)' } }
                 },
                 plugins: {
                     legend: { display: false },
                     tooltip: { callbacks: { title: (items) => cpSeoDate(items[0].label), label: (item) => `${item.parsed.y} visits` } },
                     seoChangelogMarkers: { markers }
                 }
             }
         });
     }
     $('cp-seo-markers').innerHTML = !daily.length
         ? '<li class="text-gray-500">No visits from Google recorded in this range yet.</li>'
         : markers.map(m => `<li class="flex items-center gap-2"><span class="w-5 h-5 rounded-full text-[10px] font-extrabold flex items-center justify-center text-black shrink-0" style="background:${(SEO_CHANGELOG_KINDS[m.kind] || SEO_CHANGELOG_KINDS.other).color}">${m.n}</span>${escapeAttr(m.title)}</li>`).join('');

     // ---- 4. Target searches
     renderCpSeoKeywords(keywords);

     // ---- 4b. How you compare
     renderCpSeoCompetitors(vsRes);

     // ---- 5. Work we did + up next
     const numberById = new Map(markers.map(m => [String(m.id), m.n]));
     const recentWork = changelog.slice(0, 6);
     $('cp-seo-work-wrap').classList.toggle('hidden', !recentWork.length);
     $('cp-seo-work').innerHTML = recentWork.map(c => {
         const kind = SEO_CHANGELOG_KINDS[c.kind] || SEO_CHANGELOG_KINDS.other;
         const num = numberById.get(String(c.id));
         const url = cpSeoSafeUrl(c.url);
         return `<li class="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 py-3 border-b border-white/5 last:border-0">
             ${num ? `<span class="w-5 h-5 mt-0.5 rounded-full text-[10px] font-extrabold flex items-center justify-center text-black" style="background:${kind.color}">${num}</span>` : '<span class="w-5 h-5 mt-0.5 rounded-full border border-white/10"></span>'}
             <div class="min-w-0">
                 <p class="text-xs text-gray-500">${cpSeoDate(c.live_date)} · <span class="font-bold uppercase tracking-wider text-gray-400">${kind.label}</span></p>
                 <p class="text-sm font-bold text-white break-words">${url ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener" class="hover:underline">${escapeAttr(c.title)}</a>` : escapeAttr(c.title)}</p>
                 ${c.notes ? `<p class="text-xs text-gray-400 mt-0.5 whitespace-pre-wrap break-words">${escapeAttr(c.notes)}</p>` : ''}
             </div>
         </li>`;
     }).join('');

     const almost = (almostRes.data || []).slice(0, 5);
     const potValue = n(ov.seo_potential_value), potTraffic = n(ov.seo_potential_traffic);
     const hasGrow = potValue != null && potValue > 0;
     $('cp-seo-next-wrap').classList.toggle('hidden', !almost.length && !hasGrow);
     $('cp-seo-next').innerHTML = almost.map(a => {
         const pos = Number(a.weighted_position);
         const prior = a.prior_position == null ? null : Number(a.prior_position);
         const note = pos < 13 ? 'One or two spots from page 1' : 'On page 2, close to page 1';
         const trend = prior != null && Math.round(prior) > Math.round(pos) ? ` · up ${Math.round(prior) - Math.round(pos)} this period` : '';
         return `<li class="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
             <div class="min-w-0"><p class="text-sm font-bold text-white break-words">${escapeAttr(a.query)}</p><p class="text-xs text-gray-500">${note}${trend} · ${Number(a.impressions).toLocaleString()} people saw you</p></div>
             <span class="text-xs font-bold px-2.5 py-1 rounded-full whitespace-nowrap" style="background:${cpSeoRamp().p2};color:#FFFFFF">#${Math.round(pos)}</span>
         </li>`;
     }).join('');
     $('cp-seo-grow').innerHTML = hasGrow
         ? `<div class="rounded-2xl p-4 bg-yellow-400/10 border border-yellow-400/20">
             <p class="text-[11px] font-bold text-gray-500 uppercase tracking-widest">Room to grow</p>
             <p class="text-2xl font-extrabold text-white mt-1">+${(potTraffic || 0).toLocaleString()} visits a month</p>
             <p class="text-sm text-gray-300">worth about ${money0(potValue)} a month in Google Ads, if your target searches reach the top 3</p>
           </div>` : '';
     // One card in the row fills the row rather than leaving an empty half
     const row5 = $('cp-seo-work-wrap').parentElement;
     const bothVisible = !$('cp-seo-work-wrap').classList.contains('hidden') && !$('cp-seo-next-wrap').classList.contains('hidden');
     row5.classList.toggle('lg:grid-cols-2', bothVisible);

     // ---- 6. Visibility and authority
     const vis = n(ov.visibility_percent), trust = n(ov.domain_trust);
     $('cp-seo-health-wrap').classList.toggle('hidden', vis == null && trust == null);
     const gauge = (pct) => `<div class="h-2.5 rounded-full bg-white/10 overflow-hidden my-3"><div class="h-full rounded-full bg-yellow-400" style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>`;
     $('cp-seo-visibility').innerHTML = vis == null ? '<p class="text-sm text-gray-500">Measured daily from your target searches. Check back tomorrow.</p>'
         : `<p class="text-4xl font-bold text-white">${vis % 1 ? vis.toFixed(1) : vis}<span class="text-lg text-gray-400 font-bold"> / 100</span></p>${gauge(vis)}
            <p class="text-xs text-gray-500">${vis < 5 ? 'Early days: most target searches are still below the top 10, where visibility starts to count.' : 'Rises as more target searches reach the top of Google.'}</p>`;
     $('cp-seo-authority').innerHTML = trust == null ? '<p class="text-sm text-gray-500">Measured daily. Check back tomorrow.</p>'
         : `<p class="text-4xl font-bold text-white">${trust}<span class="text-lg text-gray-400 font-bold"> / 100</span></p>${gauge(trust)}
            <p class="text-xs text-gray-500">${n(ov.pages_indexed) != null ? `Google has ${n(ov.pages_indexed).toLocaleString()} of your pages in its index. ` : ''}${trust < 15 ? 'Newer local sites usually start here. Each article and quality link nudges it up.' : 'Keeps growing as trusted sites link to you.'}</p>`;
 };

        // ============================================================================
        // GPT-4o RAG CHAT AGENT (MINIFIED FOR TOKEN SAVINGS)
        // ============================================================================
        
        window.currentChatHistory = [];

        // The model's reply, made safe to put on the page. Everything is escaped FIRST, then only
        // **bold** and line breaks are turned back into markup. The reply can repeat anything in its
        // briefing, including task titles a client typed into a request, so treating it as HTML let
        // a title like <img onerror=…> run in the admin's session.
        function formatChatReply(text) {
            return escapeAttr(String(text ?? ''))
                .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
                .replace(/\n/g, '<br>');
        }

        window.sendChatMessage = async function() {
            const inputEl = document.getElementById('chat-input');
            const msg = inputEl.value.trim();
            if(!msg) return;
            
            inputEl.value = '';
            
            // 1. Render User Message (escapeAttr: escapeHTML is a JS-string escaper and doesn't stop markup)
            const msgBox = document.getElementById('chat-messages');
            msgBox.innerHTML += `
                <div class="flex items-start gap-3 justify-end">
                    <div class="bg-blue-600 p-3 rounded-2xl rounded-tr-none shadow-lg text-sm text-white max-w-[80%]">${escapeAttr(msg)}</div>
                    <div class="w-8 h-8 rounded-full bg-white/10 text-white flex items-center justify-center shrink-0"><i class="fa-solid fa-user"></i></div>
                </div>`;
            msgBox.scrollTop = msgBox.scrollHeight;
            
            const btn = document.getElementById('btn-send-chat');
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            btn.disabled = true;
            
            let systemPrompt = "";

            // 2. Determine Context Based on Selection
            if (cSelectedAccount === "ALL") {
                // GLOBAL AGENCY MODE
                const globalMatrix = await window.prepareAIBrainContext();
                systemPrompt = `You are an elite Agency Data Scientist and AI Agent for Midas Media.
                You are currently in GLOBAL AGENCY MODE. The user may ask questions about any client, compare performance across the network, or ask for high-level strategic advice.
                
                Here is the current performance matrix for all active clients:
                ${globalMatrix}
                
                Rules:
                1. Answer the user's question based strictly on this matrix.
                2. Be concise, highly analytical, and provide actionable media buying advice.
                3. Use basic markdown to format your response cleanly.`;
            } else {
                // SINGLE CLIENT MODE
                const normC = normalize(cSelectedAccount);
                
                const clientAds = reportsForClient(cSelectedAccount)
                    .slice(-90)
                    .map(r => ({ date: r.date ? r.date.split('T')[0] : 'Unknown', spend: r.spend, leads: r.leads }));
                    
                // Real SEO data: Search Console, SE Ranking, competitors, audit and leads, computed
                // here and handed over as text (buildChatSeoBriefing). Replaced the dead seo_metrics feed.
                const clientSeo = await buildChatSeoBriefing(cSelectedAccount);

                const clientTasks = globalTasksData
                    .filter(t => normalize(t.client || '').includes(normC))
                    .slice(-50)
                    .map(t => ({ title: t.title, status: t.status }));
                    
                // Rolled up per week so the model sees a trend, not one entry per rep
                const clientOutcomes = checkinsByWeek(cSelectedAccount)
                    .slice(0, 26)
                    .map(w => ({
                        week: w.week_start,
                        estimates: w.reportedEstimates ? w.estimates_count : null,
                        closed: w.reportedCloses ? w.closes_count : null,
                        revenue: w.reportedRevenue ? w.revenue_total : null,
                        reporters: w.contributors.length
                    }));

                const clientHealth = globalHealthData[normC] || 'Unknown';
                
                systemPrompt = `You are an elite, highly analytical Agency Data Scientist and AI Agent. You are advising the account manager regarding the client: ${cSelectedAccount}.
                
                Use the following raw database context to answer the user's questions and find hidden patterns:
                - Current Relationship Health Score: ${clientHealth}/100
                - All Tasks: ${JSON.stringify(clientTasks)}
                - Ad Performance: ${JSON.stringify(clientAds)}
                - Weekly outcomes reported by the client (estimates sent, jobs closed, revenue): ${JSON.stringify(clientOutcomes)}

                ORGANIC SEARCH (SEO) — every figure below was computed by Golden Eye from Search Console, SE Ranking and the client's website leads:
                ${clientSeo}

                Rules:
                1. Base your answers strictly on the data provided. If something isn't in it, say you don't have that data.
                2. Quote SEO figures exactly as given; don't recalculate, re-average or round them differently.
                3. Look for deep cross-channel correlations, but treat small numbers (under 50 visits or 5 leads) as noise, not trends.
                4. Be concise, direct, and highly analytical. Provide insights humans might miss. Give no generic advice.
                5. Use basic markdown to format your response cleanly.`;
            }

            // Setup or update system instructions
            if(window.currentChatHistory.length === 0 || window.currentChatHistory[0].role !== 'system') {
                window.currentChatHistory.unshift({ role: 'system', content: systemPrompt });
            } else {
                window.currentChatHistory[0] = { role: 'system', content: systemPrompt }; // Keep data fresh
            }
            
            window.currentChatHistory.push({ role: 'user', content: msg });
            
            // 3. Ask the model, as the signed-in admin (see callAiChat)
            try {
                const data = await callAiChat(window.currentChatHistory);

                const aiResponse = data.choices[0].message.content;
                window.currentChatHistory.push({ role: 'assistant', content: aiResponse });

                const formattedHtml = formatChatReply(aiResponse);
                
                msgBox.innerHTML += `
                    <div class="flex items-start gap-3">
                        <div class="w-8 h-8 rounded-full bg-purple-600/20 text-purple-400 flex items-center justify-center shrink-0"><i class="fa-solid fa-robot"></i></div>
                        <div class="bg-black/20 p-3 rounded-2xl rounded-tl-none border border-white/5 text-sm text-gray-300 max-w-[80%] leading-relaxed">${formattedHtml}</div>
                    </div>`;
                msgBox.scrollTop = msgBox.scrollHeight;
                
            } catch(e) {
                msgBox.innerHTML += `
                    <div class="flex items-start gap-3">
                        <div class="w-8 h-8 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center shrink-0"><i class="fa-solid fa-triangle-exclamation"></i></div>
                        <div class="bg-red-500/10 p-3 rounded-2xl rounded-tl-none border border-red-500/20 text-sm text-red-400 max-w-[80%]">API Error: ${escapeAttr(e.message)}</div>
                    </div>`;
                msgBox.scrollTop = msgBox.scrollHeight;
                window.currentChatHistory.pop(); // Remove failed user message
            } finally {
                btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
                btn.disabled = false;
            }
        };

        // ============================================================================
        // TEMPLATES TAB LOGIC
        // ============================================================================

        window.switchTemplateView = function(view) {
            // Hide both views initially
            ['recurring', 'services', 'stage', 'onboarding'].forEach(v => {
                const el = document.getElementById(`t-view-${v}`);
                const btn = document.getElementById(`tab-btn-tpl-${v}`);
                if (el) el.classList.add('hidden');
                if (btn) btn.className = 'whitespace-nowrap pb-3 text-sm font-bold text-gray-500 border-b-2 border-transparent hover:text-gray-300 transition';
            });

            // Show selected view and highlight active tab
            document.getElementById(`t-view-${view}`).classList.remove('hidden');
            if (view === 'stage') initStageTemplateEditor();
            if (view === 'onboarding') { renderOnboardingSteps(); renderOnboardingPreviewControls(); }
            if (view === 'services') renderServices();
            const activeBtn = document.getElementById(`tab-btn-tpl-${view}`);
            
            if(activeBtn) {
                activeBtn.className = 'whitespace-nowrap pb-3 text-sm font-bold text-blue-400 border-b-2 border-blue-400 transition';
            }
        };

        // ============================================================================
// TEMPLATE SOP BUILDER & MILESTONE ASSIGNMENT
// ============================================================================
window.openTemplateDrawer = function(type, id) {
    const drawer = document.getElementById('template-drawer');
    const overlay = document.getElementById('drawer-overlay');
    const title = document.getElementById('tpl-drawer-title');
    const subtitle = document.getElementById('tpl-drawer-subtitle');
    const content = document.getElementById('tpl-drawer-content');
    
    document.getElementById('tpl-active-type').value = type;
    document.getElementById('tpl-active-id').value = id;

    // Load available milestones for the dropdowns dynamically
    const milestoneOptions = dbMilestones.map(m => `<option value="${m.id}">${m.name} (Target: ${m.target_days} Days)</option>`).join('');

    if (type === 'recurring') {
        subtitle.innerText = "Recurring Template Editor";
        title.innerText = id === 'new' ? "New Template" : "Edit Template";
        
        content.innerHTML = `
            <div>
                <label class="modal-label">Template Name</label>
                <input type="text" id="tpl-rec-name" class="glass-input" placeholder="e.g. Weekly SEO Audit" ${id !== 'new' ? 'value="Weekly Sync Prep"' : ''} required>
            </div>
            <div class="mt-4">
                <label class="modal-label">Frequency</label>
                <select id="tpl-rec-freq" class="glass-input">
                    <option value="daily">Daily</option>
                    <option value="weekly" selected>Weekly</option>
                    <option value="monthly">Monthly</option>
                </select>
            </div>
            <div class="mt-4">
                <label class="modal-label">Standard Tasks (One per line)</label>
                <textarea id="tpl-rec-tasks" class="glass-input min-h-[150px]" placeholder="- Check GSC errors\n- Update negative keywords\n- Send summary to Slack" required></textarea>
            </div>
        `;
    } else if (type === 'stage') {
        subtitle.innerText = "Stage Checklist Editor";
        title.innerText = id.charAt(0).toUpperCase() + id.slice(1) + " Phase";
        
        content.innerHTML = `
            <div class="p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg mb-4 text-sm text-blue-200">
                These tasks will automatically generate when a lead enters the <strong>${id}</strong> stage. 
                <br><br><strong class="text-white">Pro Tip:</strong> Link critical operational tasks to Milestones to automate the Relationship Health Tracker.
            </div>
            <div>
                <label class="modal-label">Default Assignee</label>
                <input type="text" id="tpl-stage-assignee" class="glass-input" placeholder="e.g. Account Manager" required>
            </div>
            
            <div class="mt-6">
                <div class="flex justify-between items-center mb-2">
                    <label class="modal-label !mb-0">Task Definitions</label>
                    <button type="button" onclick="addStageTaskRow()" class="text-[10px] bg-white/10 hover:bg-white/20 text-white font-bold py-1 px-2 rounded transition shadow">+ Add Task</button>
                </div>
                <div id="tpl-stage-tasks-container" class="space-y-3">
                    </div>
            </div>
        `;
        
        // Populate default rows to start
        setTimeout(() => { addStageTaskRow(); addStageTaskRow(); }, 50);
    }

    overlay.classList.add('show');
    drawer.classList.add('open');
};

window.addStageTaskRow = function() {
    const container = document.getElementById('tpl-stage-tasks-container');
    const milestoneOptions = dbMilestones.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    
    const row = document.createElement('div');
    row.className = "flex gap-2 items-start bg-black/20 p-2 rounded border border-white/5 tpl-task-row";
    row.innerHTML = `
        <div class="flex-1 space-y-2">
            <input type="text" class="glass-input tpl-task-title !py-1.5" placeholder="Task Title (e.g. Meta Ads Setup)" required>
            <div class="flex gap-2">
                <select class="glass-input tpl-task-type !py-1 !text-xs !bg-white/5" onchange="toggleMilestoneSelect(this)">
                    <option value="standard">Standard Task</option>
                    <option value="milestone">Health Milestone</option>
                </select>
                <select class="glass-input tpl-task-milestone !py-1 !text-xs !bg-yellow-500/10 !text-yellow-400 !border-yellow-500/30 hidden">
                    <option value="" disabled selected>Link to Benchmark...</option>
                    ${milestoneOptions}
                </select>
            </div>
        </div>
        <button type="button" onclick="this.parentElement.remove()" class="text-red-400 hover:text-red-300 transition w-8 h-8 rounded shrink-0 flex items-center justify-center bg-red-500/10 hover:bg-red-500/20"><i class="fa-solid fa-trash"></i></button>
    `;
    container.appendChild(row);
};

window.toggleMilestoneSelect = function(selectEl) {
    const msDropdown = selectEl.nextElementSibling;
    if (selectEl.value === 'milestone') {
        msDropdown.classList.remove('hidden');
        msDropdown.setAttribute('required', 'true');
    } else {
        msDropdown.classList.add('hidden');
        msDropdown.removeAttribute('required');
    }
};

window.triggerTemplateSave = async function(e) {
    e.preventDefault();
    const btn = document.getElementById('tpl-save-btn');
    const originalText = btn.innerText;
    
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving Template...';
    btn.disabled = true;

    const type = document.getElementById('tpl-active-type').value;
    const stageId = document.getElementById('tpl-active-id').value;
    
    try {
        let tasksPayload = [];

        if (type === 'stage') {
            const rows = document.querySelectorAll('.tpl-task-row');
            rows.forEach(row => {
                const title = row.querySelector('.tpl-task-title').value;
                const taskType = row.querySelector('.tpl-task-type').value;
                const milestoneId = row.querySelector('.tpl-task-milestone').value;
                
                tasksPayload.push({
                    title: title,
                    is_milestone: taskType === 'milestone',
                    milestone_id: taskType === 'milestone' ? parseInt(milestoneId) : null
                });
            });
            
            // Console log to verify extraction works flawlessly before hooking it to Supabase
            console.log(`[TEMPLATE ENGINE] Saved SOPs for Stage: ${stageId}`, tasksPayload);
        } else {
            const lines = document.getElementById('tpl-rec-tasks').value.split('\n').filter(l => l.trim() !== '');
            console.log(`[TEMPLATE ENGINE] Saved Recurring Template:`, lines);
        }

        // Simulate DB execution time for visual UX
        await new Promise(resolve => setTimeout(resolve, 800));

        btn.innerHTML = '<i class="fa-solid fa-check mr-2"></i> Configuration Saved';
        btn.classList.replace('bg-blue-600', 'bg-green-600');
        btn.classList.replace('hover:bg-blue-500', 'hover:bg-green-500');
        
        setTimeout(() => {
            closeAllDrawers();
            btn.innerText = originalText;
            btn.classList.replace('bg-green-600', 'bg-blue-600');
            btn.classList.replace('hover:bg-green-500', 'hover:bg-blue-500');
            btn.disabled = false;
        }, 700);

    } catch (err) {
        alert("Error saving template: " + err.message);
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
};
window.renderClientPayments = function() {
            const globalDashEl = document.getElementById('payments-all-dashboard');
            const contentEl = document.getElementById('payments-client-content');
            
            // 1. GLOBAL DASHBOARD LOGIC ("All Accounts")
            if (cSelectedAccount === "ALL") {
                if (globalDashEl) globalDashEl.classList.remove('hidden');
                if (contentEl) contentEl.classList.add('hidden');

                let totalMrr = 0, totalPaid = 0, totalOverdue = 0, totalUnpaid = 0;
                let listHtml = '';
                
                // Exclude "Midas Media" internal HQ from billing
                const activeClients = globalClientsData.filter(c => normalize(c.name) !== normalize('Midas Media') && isActiveClient(c));
                
                // Sort clients: Overdue first, then Paid, then Unpaid, then by MRR size
                const sortedClients = [...activeClients].sort((a, b) => {
                    const weight = { 'overdue': 3, 'paid': 2, 'unpaid': 1 };
                    const aW = weight[a.payment_status || 'unpaid'] || 1;
                    const bW = weight[b.payment_status || 'unpaid'] || 1;
                    if (aW !== bW) return bW - aW; 
                    return (parseFloat(b.monthly_retainer) || 0) - (parseFloat(a.monthly_retainer) || 0);
                });

                sortedClients.forEach(c => {
                    const retainer = parseFloat(c.monthly_retainer || 0);
                    totalMrr += retainer;
                    
                    let statusBadge = '';
                    if (c.payment_status === 'paid') {
                        totalPaid += retainer;
                        statusBadge = `<span class="text-[10px] bg-green-500/20 text-green-400 border border-green-500/30 px-2 py-0.5 rounded-md">Paid</span>`;
                    } else if (c.payment_status === 'overdue') {
                        totalOverdue += retainer;
                        statusBadge = `<span class="text-[10px] bg-red-500/20 text-red-400 border border-red-500/30 px-2 py-0.5 rounded-md">Overdue</span>`;
                    } else {
                        totalUnpaid += retainer;
                        statusBadge = `<span class="text-[10px] bg-gray-500/20 text-gray-400 border border-gray-500/30 px-2 py-0.5 rounded-md">Unpaid</span>`;
                    }

                    const deadline = c.payment_deadline ? new Date(c.payment_deadline).toLocaleDateString() : '--';
                    
                    listHtml += `<tr class="hover:bg-white/5 transition cursor-pointer" onclick="goToClient('${escapeHTML(c.name)}'); setTimeout(() => switchClientView('payments'), 50);">
                        <td class="py-3 font-bold text-blue-400">${c.name}</td>
                        <td class="py-3 text-center">${statusBadge}</td>
                        <td class="py-3 text-right font-bold text-white">$${retainer.toLocaleString(undefined, {minimumFractionDigits: 0})}</td>
                        <td class="py-3 text-right text-gray-400">${deadline}</td>
                    </tr>`;
                });

                document.getElementById('pay-all-mrr').innerText = '$' + totalMrr.toLocaleString(undefined, {minimumFractionDigits: 0});
                document.getElementById('pay-all-paid').innerText = '$' + totalPaid.toLocaleString(undefined, {minimumFractionDigits: 0});
                document.getElementById('pay-all-overdue').innerText = '$' + totalOverdue.toLocaleString(undefined, {minimumFractionDigits: 0});
                document.getElementById('pay-all-unpaid').innerText = '$' + totalUnpaid.toLocaleString(undefined, {minimumFractionDigits: 0});
                document.getElementById('pay-all-client-list').innerHTML = listHtml;

                return;
            }

            // 2. INDIVIDUAL CLIENT LOGIC
            if (globalDashEl) globalDashEl.classList.add('hidden');
            if (contentEl) contentEl.classList.remove('hidden');

            const normAccount = normalize(cSelectedAccount);
            const clientData = globalClientsData.find(c => normalize(c.name) === normAccount) || {};

            // Update top KPIs
            const statusEl = document.getElementById('pay-kpi-status');
            if(clientData.payment_status === 'paid') {
                statusEl.innerHTML = '<span class="text-green-400">Paid</span>';
            } else if (clientData.payment_status === 'overdue') {
                statusEl.innerHTML = '<span class="text-red-400">Overdue</span>';
            } else {
                statusEl.innerHTML = '<span class="text-gray-400">Unpaid</span>';
            }

            document.getElementById('pay-kpi-last').innerText = clientData.last_payment_date ? new Date(clientData.last_payment_date).toLocaleDateString() : '--';
            document.getElementById('pay-kpi-deadline').innerText = clientData.payment_deadline ? new Date(clientData.payment_deadline).toLocaleDateString() : '--';
            
            if(clientData.client_since) {
                const diffTime = Math.abs(new Date() - new Date(clientData.client_since));
                const diffMonths = Math.ceil(diffTime / (1000 * 60 * 60 * 24 * 30));
                document.getElementById('pay-kpi-tenure').innerText = `${diffMonths} Months`;
            } else {
                document.getElementById('pay-kpi-tenure').innerText = '--';
            }

            // Fill Form Fields
            document.getElementById('edit-pay-status').value = clientData.payment_status || 'unpaid';
            document.getElementById('edit-pay-since').value = clientData.client_since || '';
            document.getElementById('edit-pay-last').value = clientData.last_payment_date || '';
            document.getElementById('edit-pay-deadline').value = clientData.payment_deadline || '';
        };

        window.saveClientPayments = async function() {
            if (cSelectedAccount === "ALL") return;

            const btn = document.getElementById('btn-save-payments');
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
            btn.disabled = true;

            const payload = {
                payment_status: document.getElementById('edit-pay-status').value,
                client_since: document.getElementById('edit-pay-since').value || null,
                last_payment_date: document.getElementById('edit-pay-last').value || null,
                payment_deadline: document.getElementById('edit-pay-deadline').value || null
            };

            try {
                // Update Supabase
                const { error } = await supabaseClient.from('clients')
                    .update(payload)
                    .ilike('name', `%${cSelectedAccount}%`);
                if (error) throw error;

                // Update local data cache
                const normAccount = normalize(cSelectedAccount);
                const cIndex = globalClientsData.findIndex(c => normalize(c.name) === normAccount);
                if(cIndex > -1) {
                    globalClientsData[cIndex] = { ...globalClientsData[cIndex], ...payload };
                }

                // Re-render UI
                window.renderClientPayments();
		
		if (typeof renderGoldenEye === 'function') renderGoldenEye();
                
                btn.innerHTML = '<i class="fa-solid fa-check mr-2"></i> Saved!';
                btn.classList.replace('bg-blue-600', 'bg-green-600');
                setTimeout(() => {
                    btn.innerHTML = 'Save Payment Details';
                    btn.classList.replace('bg-green-600', 'bg-blue-600');
                }, 2000);

            } catch (error) {
                alert("Error saving payment details: " + error.message);
                btn.innerHTML = 'Save Payment Details';
            } finally {
                btn.disabled = false;
            }
        };

        // Fallback stubs for unimplemented UI features
        // ---- Text alert recipients ----
        // Who the client-request trigger texts. Kept in the database rather than in the
        // Make scenario so switching someone off is a toggle here, not an edit there.
        let alertRecipients = [];

        window.loadAlertRecipients = async function() {
            if (currentUserRole !== 'admin') return;
            const { data, error } = await supabaseClient
                .from('admin_alert_recipients').select('*').order('name');
            if (error) { console.error('Could not load alert recipients:', error); return; }
            alertRecipients = data || [];
            renderAlertRecipients();
        };

        function renderAlertRecipients() {
            const el = document.getElementById('alert-recipients-list');
            if (!el) return;

            if (!alertRecipients.length) {
                el.innerHTML = '<p class="text-sm text-gray-500 italic">Nobody yet — add someone below or these alerts go nowhere.</p>';
                return;
            }

            el.innerHTML = alertRecipients.map(r => `
                <div class="flex items-center justify-between gap-3 p-3 bg-black/20 border border-white/5 rounded-xl">
                    <div class="min-w-0">
                        <p class="font-medium text-sm ${r.active ? 'text-white' : 'text-gray-500'}">${escapeAttr(stripSlashEscapes(r.name || 'Unnamed'))}</p>
                        <p class="text-xs text-gray-500">${escapeAttr(stripSlashEscapes(r.phone))}${r.active ? '' : ' &middot; muted'}</p>
                    </div>
                    <div class="flex items-center gap-3 shrink-0">
                        <button onclick="toggleAlertRecipient('${escapeAttr(r.id)}')" class="text-xs font-bold px-3 py-1.5 rounded-md transition ${r.active ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20' : 'bg-white/5 text-gray-400 hover:bg-white/10'}">
                            ${r.active ? 'On' : 'Off'}
                        </button>
                        <button onclick="deleteAlertRecipient('${escapeAttr(r.id)}')" class="text-red-500/60 hover:text-red-400 px-1" title="Remove">
                            <i class="fa-solid fa-trash text-xs"></i>
                        </button>
                    </div>
                </div>`).join('');
        }

        window.toggleAlertRecipient = async function(id) {
            const r = alertRecipients.find(x => String(x.id) === String(id));
            if (!r) return;

            const next = !r.active;
            r.active = next;
            renderAlertRecipients();

            const { error } = await supabaseClient
                .from('admin_alert_recipients').update({ active: next }).eq('id', r.id);
            if (error) {
                r.active = !next;
                renderAlertRecipients();
                alert('Could not change that: ' + error.message);
            }
        };

        window.addAlertRecipient = async function() {
            const nameEl = document.getElementById('new-alert-name');
            const phoneEl = document.getElementById('new-alert-phone');
            const name = nameEl.value.trim();
            const phone = phoneEl.value.trim();

            if (!name || phone.replace(/\D/g, '').length < 10) {
                alert('Needs a name and a full mobile number.');
                return;
            }

            const { data, error } = await supabaseClient
                .from('admin_alert_recipients').insert([{ name, phone, active: true }]).select();
            if (error) { alert('Could not add them: ' + error.message); return; }

            if (data?.length) alertRecipients.push(...data);
            nameEl.value = ''; phoneEl.value = '';
            renderAlertRecipients();
        };

        window.deleteAlertRecipient = async function(id) {
            const r = alertRecipients.find(x => String(x.id) === String(id));
            if (!r) return;
            if (!confirm(`Remove ${r.name || r.phone} from text alerts?`)) return;

            const { error } = await supabaseClient
                .from('admin_alert_recipients').delete().eq('id', r.id);
            if (error) { alert('Could not remove them: ' + error.message); return; }

            alertRecipients = alertRecipients.filter(x => String(x.id) !== String(id));
            renderAlertRecipients();
        };

        window.switchSettingsView = window.switchSettingsView || function(view) {
            const views = ['users', 'scoring', 'milestones', 'health', 'notifications', 'updates', 'data'];
            views.forEach(v => {
                const el = document.getElementById(`s-view-${v}`);
                const btn = document.getElementById(`tab-btn-set-${v}`);
                if (el) el.classList.add('hidden');
                if (btn) btn.className = 'whitespace-nowrap pb-3 text-sm font-bold text-gray-500 border-b-2 border-transparent hover:text-gray-300 transition';
            });
            
            const activeEl = document.getElementById(`s-view-${view}`);
            const activeBtn = document.getElementById(`tab-btn-set-${view}`);
            if (activeEl) activeEl.classList.remove('hidden');
            if (activeBtn) activeBtn.className = 'whitespace-nowrap pb-3 text-sm font-bold text-blue-400 border-b-2 border-blue-400 transition';
            
            if (view === 'milestones') renderMilestonesSettings();
            if (view === 'users') { renderUsersTable(); populateInviteClientList(); }
            // Fetched on demand — nobody needs this on every dashboard load
            if (view === 'notifications') loadAlertRecipients();
            if (view === 'updates') renderUpdates();
        };

        // ---- Settings → Updates ----
        // Reads updates.json, which ships next to app.js and body.html on GitHub Pages, so an
        // entry goes live with the change it describes and there's nothing to keep in the database.
        // Same cache-buster the loader uses: Pages caches for ten minutes otherwise.
        const GE_BASE = 'https://video-tech.github.io/goldeneye-dashboard';
        const UPDATES_SEEN_KEY = 'ge-updates-seen';
        let updatesCache = null;
        let updatesFilter = 'all';

        const UPDATE_AREA_COLOR = {
            SEO: 'text-emerald-300 border-emerald-400/30 bg-emerald-500/10',
            Reports: 'text-blue-300 border-blue-400/30 bg-blue-500/10',
            Onboarding: 'text-purple-300 border-purple-400/30 bg-purple-500/10',
            Tasks: 'text-amber-300 border-amber-400/30 bg-amber-500/10',
            Security: 'text-red-300 border-red-400/30 bg-red-500/10',
            Data: 'text-cyan-300 border-cyan-400/30 bg-cyan-500/10'
        };

        async function loadUpdates() {
            if (updatesCache) return updatesCache;
            const res = await fetch(`${GE_BASE}/updates.json?v=${Date.now()}`);
            if (!res.ok) throw new Error(`updates.json returned ${res.status}`);
            const json = await res.json();
            updatesCache = (json.updates || []).filter(u => u && u.title);
            return updatesCache;
        }

        // A dot on the tab for anything dated after the last visit to this screen. Per browser,
        // like every other localStorage flag here — it's a nudge, not a record.
        window.checkUpdatesBadge = async function() {
            const badge = document.getElementById('updates-new-badge');
            if (!badge || currentUserRole !== 'admin') return;
            try {
                const updates = await loadUpdates();
                const seen = localStorage.getItem(UPDATES_SEEN_KEY) || '';
                const fresh = updates.filter(u => String(u.date || '') > seen).length;
                badge.innerText = fresh > 9 ? '9+' : String(fresh);
                badge.classList.toggle('hidden', !fresh);
            } catch (err) {
                console.warn('Updates: could not load updates.json', err);
            }
        };

        window.setUpdatesFilter = function(area) {
            updatesFilter = area;
            renderUpdates();
        };

        window.renderUpdates = async function() {
            const list = document.getElementById('updates-list');
            const filterBar = document.getElementById('updates-filter');
            if (!list) return;
            list.innerHTML = '<p class="text-xs text-gray-500"><i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Loading…</p>';

            let updates;
            try {
                updates = await loadUpdates();
            } catch (err) {
                list.innerHTML = `<p class="text-xs text-red-400">Couldn't load the update list (${escapeAttr(err.message)}). It's served from GitHub Pages, so a failed deploy or being offline would do it.</p>`;
                return;
            }

            const seen = localStorage.getItem(UPDATES_SEEN_KEY) || '';
            const areas = [...new Set(updates.map(u => u.area).filter(Boolean))];
            if (filterBar) {
                filterBar.innerHTML = ['all', ...areas].map(a => `
                    <button type="button" onclick="setUpdatesFilter('${escapeAttr(a)}')"
                        class="ob-chip" aria-pressed="${updatesFilter === a}">${a === 'all' ? 'Everything' : escapeAttr(a)}</button>`).join('');
            }

            const shown = updates.filter(u => updatesFilter === 'all' || u.area === updatesFilter);
            list.innerHTML = shown.length ? shown.map(u => {
                const isNew = String(u.date || '') > seen;
                const areaClass = UPDATE_AREA_COLOR[u.area] || 'text-gray-300 border-white/15 bg-white/5';
                return `<div class="bg-black/20 border ${isNew ? 'border-blue-400/30' : 'border-white/5'} rounded-xl p-4">
                    <div class="flex flex-wrap items-center gap-2 mb-2">
                        ${u.area ? `<span class="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full border ${areaClass}">${escapeAttr(u.area)}</span>` : ''}
                        <span class="text-sm font-bold text-white">${escapeAttr(u.title)}</span>
                        ${isNew ? '<span class="text-[10px] font-bold uppercase tracking-widest text-blue-300">New</span>' : ''}
                        <span class="text-[11px] text-gray-500 ml-auto">${escapeAttr(updateDateLabel(u.date))}</span>
                    </div>
                    <p class="text-sm text-gray-300 leading-relaxed">${escapeAttr(u.what || '')}</p>
                    ${u.note ? `<p class="text-xs text-gray-500 mt-2 leading-relaxed">${escapeAttr(u.note)}</p>` : ''}
                    ${u.action ? `<p class="text-xs text-amber-400 mt-2"><i class="fa-solid fa-triangle-exclamation mr-1"></i><span class="font-bold">Action needed:</span> ${escapeAttr(u.action)}</p>` : ''}
                </div>`;
            }).join('') : '<p class="text-xs text-gray-500">Nothing in this area yet.</p>';

            // Mark everything seen once it's on screen, so the badge clears
            const newest = updates.map(u => String(u.date || '')).sort().pop();
            if (newest) localStorage.setItem(UPDATES_SEEN_KEY, newest);
            const badge = document.getElementById('updates-new-badge');
            if (badge) badge.classList.add('hidden');
        };

        function updateDateLabel(date) {
            if (!date) return '';
            // Parsed as local, not UTC: new Date('2026-09-15') is midnight UTC and can read as the 14th
            const [y, m, d] = String(date).split('-').map(Number);
            if (!y || !m || !d) return String(date);
            return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        }

        // Checkbox list of clients for the invite form
        window.populateInviteClientList = function() {
            const list = document.getElementById('invite-client-list');
            if (!list) return;
            const names = globalClientsData.filter(c => isSelectableClient(c) && c.name).map(c => c.name).sort();
            list.innerHTML = names.map(n =>
                `<label class="flex items-center gap-2 px-2 py-1 rounded hover:bg-white/5 cursor-pointer">
                    <input type="checkbox" value="${escapeAttr(n)}" onchange="updateInviteClientLabel()" class="row-checkbox">
                    <span class="text-xs text-gray-300">${escapeHTML(n)}</span>
                </label>`).join('') || '<p class="text-xs text-gray-500 italic px-2">No clients yet.</p>';
        };

        window.updateInviteClientLabel = function() {
            const chosen = [...document.querySelectorAll('#invite-client-list input[type=checkbox]:checked')];
            const lbl = document.getElementById('invite-client-text');
            if (!lbl) return;
            lbl.innerText = chosen.length === 0 ? 'Select clients...'
                : chosen.length === 1 ? chosen[0].value
                : `${chosen.length} clients selected`;
        };

        window.exportDataJson = window.exportDataJson || function() { console.log("Export data stub"); };

// ============================================================================
// MILESTONE CONFIG ENGINE
// ============================================================================
window.renderMilestonesSettings = function() {
    const listEl = document.getElementById('ms-list');
    if (!listEl) return;
    
    if (!dbMilestones || dbMilestones.length === 0) {
        listEl.innerHTML = '<p class="text-xs text-gray-500 italic">No milestones configured yet.</p>';
        return;
    }
    
    let html = '';
    dbMilestones.forEach(m => {
        html += `
        <div class="glass p-3 flex justify-between items-center bg-black/20 border border-white/5 rounded-lg">
            <div>
                <span class="font-bold text-white text-sm">${m.name}</span>
                <span class="text-[10px] text-gray-400 bg-white/10 px-2 py-0.5 rounded ml-2">Target: ${m.target_days} Days</span>
            </div>
            <button onclick="deleteMilestoneSetting(${m.id})" class="text-red-400 hover:text-red-300 transition w-8 h-8 rounded bg-black/40 hover:bg-red-500/20"><i class="fa-solid fa-trash"></i></button>
        </div>`;
    });
    listEl.innerHTML = html;
};

window.addMilestoneSetting = async function() {
    const btn = document.querySelector('button[onclick="addMilestoneSetting()"]');
    const nameEl = document.getElementById('ms-name');
    const daysEl = document.getElementById('ms-days');
    
    const name = nameEl.value.trim();
    const days = parseInt(daysEl.value);
    
    if (!name || isNaN(days)) return alert("Please provide both a name and a valid number of target days.");
    
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btn.disabled = true;
    
    try {
        const { data, error } = await supabaseClient.from('milestone_config').insert([{
            name: name,
            target_days: days
        }]).select();
        
        if (error) throw error;
        
        if (data && data.length > 0) {
            dbMilestones.push(data[0]);
            renderMilestonesSettings();
            nameEl.value = '';
            daysEl.value = '';
        }
    } catch (err) {
        alert("Error adding milestone: " + err.message);
    } finally {
        btn.innerHTML = '<i class="fa-solid fa-plus mr-1"></i> Add';
        btn.disabled = false;
    }
};

window.deleteMilestoneSetting = async function(id) {
    if (!confirm("Are you sure you want to delete this milestone? It may affect existing client health scores.")) return;
    
    try {
        const { error } = await supabaseClient.from('milestone_config').delete().eq('id', id);
        if (error) throw error;
        
        dbMilestones = dbMilestones.filter(m => m.id !== id);
        renderMilestonesSettings();
    } catch (err) {
        alert("Error deleting milestone: " + err.message);
    }
};
        window.checkHealthWeights = window.checkHealthWeights || function() { console.log("Check health weights stub"); };
        window.saveHealthWeights = window.saveHealthWeights || function() { console.log("Save health weights stub"); };
        // ================= USERS & ROLES =================
        // Access comes from two tables: user_profiles (people who have signed in) and
        // pre_approved_users (invited, not yet registered). user_client_access scopes
        // which clients a member or investor can see.
        window.renderUsersTable = async function() {
            const el = document.getElementById('st-users');
            if (!el) return;
            el.innerHTML = '<p class="text-sm text-gray-500 italic">Loading users&hellip;</p>';

            const [profRes, preRes, accRes] = await Promise.allSettled([
                supabaseClient.from('user_profiles').select('*'),
                supabaseClient.from('pre_approved_users').select('*'),
                supabaseClient.from('user_client_access').select('*')
            ]);

            const profiles = profRes.status === 'fulfilled' ? (profRes.value.data || []) : [];
            const invites  = preRes.status  === 'fulfilled' ? (preRes.value.data  || []) : [];
            const access   = accRes.status  === 'fulfilled' ? (accRes.value.data  || []) : [];

            const key = e => String(e || '').toLowerCase().trim();

            // Merge both sources on email; a registered profile wins over its invite
            const byEmail = new Map();
            invites.forEach(i => {
                if (!i.email) return;
                byEmail.set(key(i.email), {
                    email: i.email, name: '', role: i.role || 'pending',
                    registered: false,
                    clients: Array.isArray(i.client_access) ? i.client_access : []
                });
            });
            profiles.forEach(p => {
                if (!p.email) return;
                const existing = byEmail.get(key(p.email));
                byEmail.set(key(p.email), {
                    email: p.email,
                    name: p.full_name || '',
                    role: p.role || 'pending',
                    registered: true,
                    clients: existing ? existing.clients : []
                });
            });
            // user_client_access is the live source once someone has registered
            access.forEach(a => {
                const u = byEmail.get(key(a.user_email));
                if (u && a.client_name && !u.clients.includes(a.client_name)) u.clients.push(a.client_name);
            });

            const users = [...byEmail.values()].sort((a, b) =>
                (a.role || '').localeCompare(b.role || '') || a.email.localeCompare(b.email));

            if (!users.length) {
                el.innerHTML = '<p class="text-sm text-gray-500 italic">No users yet. Invite someone above.</p>';
                return;
            }

            const roleOpts = ['admin', 'member', 'investor', 'client', 'pending'];
            let html = `<div class="overflow-x-auto"><table class="w-full text-left text-sm">
                <thead class="text-[10px] uppercase tracking-widest text-gray-500 border-b border-white/10">
                    <tr><th class="py-2">User</th><th>Role</th><th>Client Access</th><th>Status</th><th></th></tr>
                </thead><tbody class="divide-y divide-white/5">`;

            users.forEach(u => {
                const opts = roleOpts.map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('');
                const clientList = u.clients.length
                    ? u.clients.map(c => `<span class="text-[10px] bg-white/5 border border-white/10 rounded px-1.5 py-0.5 mr-1 inline-block mb-1">${escapeHTML(c)}</span>`).join('')
                    : (u.role === 'admin' ? '<span class="text-[10px] text-gray-500">All clients</span>' : '<span class="text-[10px] text-amber-400">None &mdash; cannot see any data</span>');

                html += `<tr>
                    <td class="py-3 pr-4">
                        <div class="font-bold text-white">${escapeHTML(u.name || u.email)}</div>
                        ${u.name ? `<div class="text-[11px] text-gray-500">${escapeHTML(u.email)}</div>` : ''}
                    </td>
                    <td class="pr-4">
                        <select onchange="updateUserRole('${escapeHTML(u.email)}', this.value, this)" class="glass-input !py-1 !text-xs !w-28">${opts}</select>
                    </td>
                    <td class="pr-4 max-w-[280px]">${clientList}</td>
                    <td class="pr-4">${u.registered
                        ? '<span class="text-[10px] uppercase tracking-widest text-green-400">Registered</span>'
                        : '<span class="text-[10px] uppercase tracking-widest text-gray-500">Invited</span>'}</td>
                    <td class="text-right">
                        <button onclick="revokeUser('${escapeHTML(u.email)}')" class="text-red-500/60 hover:text-red-400 text-xs" title="Revoke all access">
                            <i class="fa-solid fa-user-slash"></i>
                        </button>
                    </td>
                </tr>`;
            });

            el.innerHTML = html + '</tbody></table></div>';
        };

        window.updateUserRole = async function(email, role, selectEl) {
            if (currentUserRole !== 'admin') return;

            const original = selectEl ? selectEl.value : role;
            try {
                // Update whichever table holds them — a user may be registered, invited, or both
                const [{ error: pErr }, { error: iErr }] = await Promise.all([
                    supabaseClient.from('user_profiles').update({ role }).eq('email', email),
                    supabaseClient.from('pre_approved_users').update({ role }).eq('email', email)
                ]);
                if (pErr && iErr) throw pErr;
                if (selectEl) {
                    selectEl.classList.add('!border-green-500');
                    setTimeout(() => selectEl.classList.remove('!border-green-500'), 1500);
                }
            } catch (err) {
                alert("Could not change role: " + err.message);
                if (selectEl) selectEl.value = original;
            }
        };

        window.revokeUser = async function(email) {
            if (currentUserRole !== 'admin') return;
            if (email && email.toLowerCase() === String(clientEmail).toLowerCase()) {
                alert("You can't revoke your own access.");
                return;
            }
            if (!confirm(`Revoke all access for ${email}?\n\nThey'll be removed from the invite list and their client access, and their role set to pending. Their Supabase login itself isn't deleted.`)) return;

            try {
                await Promise.all([
                    supabaseClient.from('user_profiles').update({ role: 'pending' }).eq('email', email),
                    supabaseClient.from('pre_approved_users').delete().eq('email', email),
                    supabaseClient.from('user_client_access').delete().eq('user_email', email)
                ]);
                renderUsersTable();
            } catch (err) {
                alert("Could not revoke access: " + err.message);
            }
        };

        // Admin invite. Writes the pre-approval and, for scoped roles, the per-client rows
        // that actually drive what they can see.
        window.inviteUser = async function(e) {
            if (e && e.preventDefault) e.preventDefault();
            if (currentUserRole !== 'admin') return;

            const emailEl = document.getElementById('invite-email');
            const roleEl  = document.getElementById('invite-role');
            const btn     = document.getElementById('btn-send-invite');

            const email = (emailEl?.value || '').trim().toLowerCase();
            const role  = (roleEl?.value  || 'member').trim().toLowerCase();
            if (!email) { alert("Enter an email address."); return; }

            const chosen = [...document.querySelectorAll('#invite-client-list input[type=checkbox]:checked')].map(c => c.value);
            if (role !== 'admin' && chosen.length === 0) {
                if (!confirm(`No clients selected. ${email} will be able to sign in but won't see any data until you grant access. Continue?`)) return;
            }

            const originalHTML = btn ? btn.innerHTML : '';
            if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Inviting...'; btn.disabled = true; }

            try {
                const { error } = await supabaseClient.from('pre_approved_users')
                    .upsert({ email, role, client_access: chosen }, { onConflict: 'email' });
                if (error) throw error;

                // user_client_access is what the app actually reads for scoping
                if (chosen.length) {
                    await supabaseClient.from('user_client_access').delete().eq('user_email', email);
                    const rows = chosen.map(c => ({ user_email: email, client_name: c }));
                    const { error: accErr } = await supabaseClient.from('user_client_access').insert(rows);
                    if (accErr) throw accErr;
                }

                if (emailEl) emailEl.value = '';
                document.querySelectorAll('#invite-client-list input[type=checkbox]:checked').forEach(c => c.checked = false);
                const lbl = document.getElementById('invite-client-text');
                if (lbl) lbl.innerText = 'Select clients...';

                renderUsersTable();
                alert(`${email} can now sign in as ${role}.`);
            } catch (err) {
                alert("Could not send invite: " + err.message);
            } finally {
                if (btn) { btn.innerHTML = originalHTML; btn.disabled = false; }
            }
        };
        window.previewScoreWeighting = window.previewScoreWeighting || function() { console.log("Preview score stub"); };
        window.saveScoringWeights = window.saveScoringWeights || function() { console.log("Save scoring weights stub"); };


window.openEditReportModal = function(id) {
    // Find the correct report from the table data
    const report = window.currentClientReports.find(r => r.id === id);
    if (!report) return;
    
    // THE FIX: Pull the edit modal out of the hidden folder into the visible wrapper
    const modal = document.getElementById('edit-report-modal');
    if (modal.parentElement.id !== 'theme-wrapper') {
        document.getElementById('theme-wrapper').appendChild(modal);
    }
    
    // Populate the text boxes with the saved data
    document.getElementById('edit-rpt-email').value = report.report_body || '';
    document.getElementById('edit-rpt-html').value = report.html_body || '';
    // Read-only: what was typed in when this report was generated. Changing it now wouldn't
    // change the report, so it isn't editable here.
    const notesWrap = document.getElementById('edit-rpt-notes-wrap');
    if (notesWrap) {
        notesWrap.hidden = !report.typed_notes;
        document.getElementById('edit-rpt-notes').innerText = report.typed_notes || '';
    }
    
    // Tell the save button which ID to update
    document.getElementById('btn-save-edit-report').onclick = () => saveEditedReport(id);
    
    // Show the modal
    modal.style.display = 'flex';
};
        window.saveEditedReport = async function(id) {
            const btn = document.getElementById('btn-save-edit-report');
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...';
            btn.disabled = true;
            
            const newEmail = document.getElementById('edit-rpt-email').value;
            const newHtml = document.getElementById('edit-rpt-html').value;
            
            try {
                const { error } = await supabaseClient.from('weekly_reports')
                    .update({ report_body: newEmail, html_body: newHtml })
                    .eq('id', id);
                    
                if (error) throw error;
                
                document.getElementById('edit-report-modal').style.display = 'none';
                
                // Refresh the table so the UI updates instantly
                window.renderClientReports(); 
            } catch (err) {
                alert("Error updating report: " + err.message);
            } finally {
                btn.innerHTML = 'Save Changes';
                btn.disabled = false;
            }
        };

        window.deleteSavedReport = async function(id) {
            if (!confirm("Are you sure you want to permanently delete this report?")) return;
            
            try {
                const { error } = await supabaseClient.from('weekly_reports').delete().eq('id', id);
                if (error) throw error;
                
                // Refresh the table so it disappears instantly
                window.renderClientReports();
            } catch(err) {
                alert("Error deleting report: " + err.message);
            }
        };

	window.sendSavedReportToMake = async function(id, btn) {
            const originalHTML = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            btn.disabled = true;

            try { // Move the safety net to the VERY top!
                
                // Find the report data we already loaded in the table
                const report = window.currentClientReports.find(r => r.id === id);
                if (!report) throw new Error("Report not found in local cache.");

                const emailText = report.report_body || "";
                const htmlCode = report.html_body || "";
                const clientName = report.client_name || cSelectedAccount;

                // Fetch the client's email address using our normal routing logic
                const clientReports = reportsForClient(clientName);

                let targetEmail = "";
                const recordWithEmail = clientReports.find(r => r.client_email || r.email);
                if (recordWithEmail) targetEmail = recordWithEmail.client_email || recordWithEmail.email;
                if (!targetEmail) targetEmail = clientEmail || "";

                // Safely convert to a string and split into an array (matching your Make.com setup)
                let emailArray = [];
                if (targetEmail) {
                    emailArray = String(targetEmail).split(/[,;\s]+/).filter(e => e.trim() !== "");
                }

                const payload = {
                    client: clientName,
                    subject: `Weekly Update: ${clientName}`,
                    full_email_html: `<div style="white-space: pre-wrap; font-family: sans-serif; font-size: 15px; color: #1d1d1f; margin-bottom: 20px;">${emailText}</div>${htmlCode}`,
                    to_email: emailArray // Using the Array format that works perfectly with your scenario
                };

                await callMakeRelay('report_draft', payload);

                // Success visual feedback on the button
                btn.innerHTML = '<i class="fa-solid fa-check"></i> Sent';
                btn.classList.replace('text-emerald-400', 'text-white');
                btn.classList.replace('bg-emerald-500/10', 'bg-emerald-600');
                
                setTimeout(() => {
                    btn.innerHTML = originalHTML;
                    btn.classList.replace('text-white', 'text-emerald-400');
                    btn.classList.replace('bg-emerald-600', 'bg-emerald-500/10');
                    btn.disabled = false;
                }, 3000);

            } catch (error) {
                // If ANYTHING fails, alert the user and stop the spinner
                alert('Failed to send to Make.com: ' + error.message);
                btn.innerHTML = originalHTML;
                btn.disabled = false;
            }
        };
function updateAgencyPowerTicker() {
    let totalNetworkLeads = 0;
    let totalNetworkRev = 0;

    // Across every client (no client filter — this is a whole-network total) but scoped
    // to the selected period, since the ticker text says "this period".
    const { s, e } = getPortalRange();
    globalAdsData.forEach(r => { if (reportInRange(r, s, e)) totalNetworkLeads += parseInt(r.leads || 0); });
    globalCheckinsData.forEach(c => {
        if (!c.week_start) return;
        const wd = new Date(c.week_start + 'T12:00:00');
        if (wd >= s && wd <= e) totalNetworkRev += parseFloat(c.revenue_total || 0);
    });

    const tickerEl = document.getElementById('global-power-ticker-text');
    if(tickerEl) {
        // Formats large numbers into "2.4M" or "45k" dynamically
        const revFormatted = totalNetworkRev > 1000000 
            ? (totalNetworkRev / 1000000).toFixed(1) + 'M' 
            : (totalNetworkRev / 1000).toFixed(0) + 'k';
            
        tickerEl.innerText = `The Midas network has generated ${totalNetworkLeads.toLocaleString()} leads and $${revFormatted} in closed revenue this period.`;
    }
}
function renderAnonymizedLeaderboard() {
    const listEl = document.getElementById('anonymized-leaderboard-list');
    if (!listEl) return;

    // 1. Group leads by resolved client for the selected period, hiding Midas Media.
    // Group on the client's own name rather than account_name so every ad account
    // rolls up under one entry regardless of what Meta calls it.
    const { s, e } = getPortalRange();
    const clientStats = {};

    const excluded = name => !name || normalize(name) === normalize('Midas Media');

    if (leaderboardMetric === 'revenue') {
        // Revenue is client-reported via the weekly check-ins, so it groups on
        // client_name directly rather than resolving an ad account.
        globalCheckinsData.forEach(c => {
            if (!c.week_start) return;
            const wd = new Date(c.week_start + 'T12:00:00');
            if (wd < s || wd > e) return;

            const client = globalClientsData.find(x => normalize(x.name) === normalize(c.client_name));
            if (client && !isSelectableClient(client)) return;

            const cName = client?.name || c.client_name;
            if (excluded(cName)) return;
            if (!clientStats[cName]) clientStats[cName] = { value: 0, industry: client?.industry || '' };
            clientStats[cName].value += parseFloat(c.revenue_total || 0);
        });
    } else {
        globalAdsData.forEach(r => {
            if (!reportInRange(r, s, e)) return;

            const client = clientForReport(r);
            // Offboarded clients don't belong on a board current clients can see
            if (client && !isSelectableClient(client)) return;

            const cName = client?.name || r.account_name;
            if (excluded(cName)) return;
            if (!clientStats[cName]) clientStats[cName] = { value: 0, industry: client?.industry || '' };
            clientStats[cName].value += parseInt(r.leads || 0);
        });
    }

    // 2. Sort by the selected metric, highest first
    const sortedClients = Object.entries(clientStats)
        .sort((a, b) => b[1].value - a[1].value);

    let html = '';

    sortedClients.forEach((entry, index) => {
        const actualName = entry[0];
        const value = entry[1].value;
        const displayValue = leaderboardMetric === 'revenue'
            ? '$' + value.toLocaleString(undefined, { maximumFractionDigits: 0 })
            : value.toLocaleString();
        const metricLabel = leaderboardMetric === 'revenue' ? 'Revenue' : 'Leads';
        // Real industry from the client record, not the invented one this used to show.
        // Blank for any client whose industry hasn't been filled in yet.
        const industry = entry[1].industry || '';

        // Anonymised by position only.
        let maskedName = `Client #${index + 1}`;

        // Highlight the user's actual row so they know where they are
        const isMe = normalize(actualName) === normalize(currentActiveClient);
        if (isMe) maskedName = "You";

        // Medals for top 3
        let rankBadge = `<span class="text-gray-500 font-bold w-6 text-center">${index + 1}</span>`;
        if (index === 0) rankBadge = `🥇`;
        if (index === 1) rankBadge = `🥈`;
        if (index === 2) rankBadge = `🥉`;

        const rowStyle = isMe 
            ? "bg-blue-500/20 border-blue-500/50" 
            : "bg-black/20 border-white/5 hover:bg-white/5";

        html += `
            <div class="p-4 rounded-xl border ${rowStyle} flex justify-between items-center transition">
                <div class="flex items-center gap-4">
                    <div class="text-xl w-8 text-center">${rankBadge}</div>
                    <div>
                        <div class="font-bold ${isMe ? 'text-blue-400' : 'text-gray-300'}">${maskedName}</div>
                        ${industry ? `<div class="text-[10px] uppercase tracking-widest text-gray-500 mt-0.5">${escapeHTML(industry)}</div>` : ''}
                    </div>
                </div>
                <div class="text-right">
                    <span class="text-lg font-bold text-white">${displayValue}</span>
                    <span class="text-[10px] text-gray-500 uppercase tracking-widest ml-1">${metricLabel}</span>
                </div>
            </div>
        `;
    });

    listEl.innerHTML = html || (leaderboardMetric === 'revenue'
        ? '<p class="text-gray-500 italic text-center">No revenue reported for this period yet. Revenue appears here as clients reply to the weekly check-in text.</p>'
        : '<p class="text-gray-500 italic text-center">No data for this period.</p>');
}

window.setLeaderboardMetric = function(metric) {
    leaderboardMetric = metric;
    ['leads', 'revenue'].forEach(m => {
        const btn = document.getElementById('lb-metric-' + m);
        if (!btn) return;
        btn.className = m === metric
            ? 'px-4 py-1.5 rounded-md text-xs font-bold bg-white/10 text-white transition'
            : 'px-4 py-1.5 rounded-md text-xs font-bold text-gray-400 hover:text-white transition';
    });
    renderAnonymizedLeaderboard();
};

window.logQuickPayment = async function() {
            if (cSelectedAccount === "ALL") return;
            const btn = document.getElementById('btn-quick-pay');
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
            btn.disabled = true;

            // Do the Date Math
            const today = new Date();
            const nextMonth = new Date(today);
            nextMonth.setMonth(nextMonth.getMonth() + 1); // Adds exactly 1 month!
            
            const todayStr = today.toISOString().split('T')[0];
            const nextMonthStr = nextMonth.toISOString().split('T')[0];

            const payload = {
                payment_status: 'paid',
                last_payment_date: todayStr,
                payment_deadline: nextMonthStr
            };

            try {
                // Update Supabase
                const { error } = await supabaseClient.from('clients').update(payload).ilike('name', `%${cSelectedAccount}%`);
                if (error) throw error;

                // Update the form fields visually
                document.getElementById('edit-pay-status').value = 'paid';
                document.getElementById('edit-pay-last').value = todayStr;
                document.getElementById('edit-pay-deadline').value = nextMonthStr;

                // Update local arrays so the dashboard reflects it instantly
                const normAccount = normalize(cSelectedAccount);
                const cIndex = globalClientsData.findIndex(c => normalize(c.name) === normAccount);
                if(cIndex > -1) globalClientsData[cIndex] = { ...globalClientsData[cIndex], ...payload };

                window.renderClientPayments();
                if (typeof renderGoldenEye === 'function') renderGoldenEye();

                btn.innerHTML = '<i class="fa-solid fa-check mr-2"></i> Payment Logged!';
                btn.classList.replace('bg-green-600', 'bg-emerald-500');
                
                setTimeout(() => {
                    btn.innerHTML = '<i class="fa-solid fa-bolt mr-2"></i> Log Payment (+1 Month)';
                    btn.classList.replace('bg-emerald-500', 'bg-green-600');
                    btn.disabled = false;
                }, 2000);

            } catch (err) {
                alert("Error logging payment: " + err.message);
                btn.innerHTML = '<i class="fa-solid fa-bolt mr-2"></i> Log Payment (+1 Month)';
                btn.disabled = false;
            }
        };
// ============================================================================
        // AI BRAIN: PHASE 1 - SIGNAL CONTEXT
        // ============================================================================
        // The signal engine used to live here. It now lives once, server-side, in
        // supabase/functions/morning-audit/engine.js — the same code the 16:00 UTC cron
        // run uses, so the card the dashboard shows and the card that arrives on its own
        // can never disagree. Two copies could drift without crashing, which would have
        // meant the button quietly reporting a different verdict from the schedule.
        //
        // 'mode: context' returns the computed matrix without spending a model call, so
        // the chat agent below costs nothing extra to keep supplied.

        const AUDIT_FN = 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/morning-audit';

        async function callAuditFunction(payload) {
            // The session token, not the public anon key, so the function can check for an admin.
            // The version deployed on 2026-09-16 doesn't check yet and accepts either.
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (!session?.access_token) throw new Error('Your session has expired — sign in again.');
            const res = await fetch(AUDIT_FN, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify(payload || {})
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) throw new Error(data.error || `audit service returned ${res.status}`);
            return data;
        }

        // Degrades rather than throws: a chat that answers "I can't see the numbers" is
        // more use than one that dies on send. The system prompt already tells the model
        // to answer strictly from this matrix, so it will say so rather than invent.
        window.prepareAIBrainContext = async function() {
            try {
                const data = await callAuditFunction({ mode: 'context' });
                return data.context || '[MATRIX UNAVAILABLE: the audit service returned nothing.]';
            } catch (e) {
                console.error('Could not fetch the performance matrix:', e);
                return `[MATRIX UNAVAILABLE: ${e.message}. Tell the user you cannot see performance data right now, and do not guess at any numbers.]`;
            }
        };
// ============================================================================
        // AI BRAIN: PHASE 2 & 3 - API GATEWAY & UI INJECTION
        // ============================================================================

        window.runGlobalAIAudit = async function() {
            const btn = document.getElementById('btn-run-global-ai');
            const outputBox = document.getElementById('global-ai-output');

            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Analyzing Network...';
            btn.disabled = true;
            outputBox.classList.remove('hidden');
            outputBox.innerHTML = '<p class="text-yellow-400 animate-pulse text-center py-4"><i class="fa-solid fa-satellite-dish mr-2"></i> Crunching high-density matrix...</p>';

            try {
                // Everything happens server-side now: the rows are read, the verdicts
                // computed, the model called and the row saved in one request. force
                // because a person pressing this button after the 16:00 cron run has
                // already filed today's card is asking for a fresh one.
                const data = await callAuditFunction({ force: true });

                outputBox.innerHTML = data.html;

                // Keep the Audits tab and checkSavedAudit() in step without a reload.
                if (data.id) {
                    globalAuditsData.unshift({
                        id: data.id,
                        created_at: data.created_at || new Date().toISOString(),
                        html_body: data.html
                    });
                    const auditsPage = document.getElementById('page-audits');
                    if (auditsPage && !auditsPage.classList.contains('hidden')) renderMorningAudits();
                }
            } catch (e) {
                outputBox.innerHTML = `<div class="bg-red-500/10 p-4 rounded-xl border border-red-500/20 text-red-400 text-center"><i class="fa-solid fa-triangle-exclamation mr-2"></i> ${escapeAttr(e.message)}</div>`;
            } finally {
                btn.innerHTML = '<i class="fa-solid fa-bolt mr-2"></i> Run Morning Audit';
                btn.disabled = false;
            }
        };

        // --- NEW FUNCTION: LOADS SAVED AUDIT AUTOMATICALLY ON PAGE LOAD ---
        window.checkSavedAudit = function() {
            // Check if we have any audits stored in the database
            if (globalAuditsData && globalAuditsData.length > 0) {
                const latestAudit = globalAuditsData[0]; // Gets the newest one
                
                // Compare local date strings to avoid timezone glitches
                const todayStr = new Date().toLocaleDateString();
                const auditDate = new Date(latestAudit.created_at).toLocaleDateString();

                // If the most recent database audit was created today, show it!
                if (auditDate === todayStr) {
                    const outputBox = document.getElementById('global-ai-output');
                    if (outputBox) {
                        outputBox.classList.remove('hidden');
                        outputBox.innerHTML = latestAudit.html_body;
                    }
                }
            }
        };
window.saveHealthData = async function() {
            const btn = document.getElementById('h-save-btn');
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
            btn.disabled = true;

            // Gather values securely
            const overrideVal = document.getElementById('h-manual-override').value;
            const payload = {
                client_name: cSelectedAccount,
                last_comm_date: document.getElementById('h-date').value || null,
                ghl_usage: parseInt(document.getElementById('h-ghl').value),
                leads_vol: parseInt(document.getElementById('h-leads').value) || 0,
                appts_vol: parseInt(document.getElementById('h-appts').value) || 0,
                deals_closed: parseInt(document.getElementById('h-deals').value) || 0,
                manual_override: overrideVal ? parseInt(overrideVal) : null,
                note: document.getElementById('h-note').value || null
            };

            try {
                // Calculate custom weighted system score if no manual override is active
                const hasOverride = payload.manual_override !== null && !isNaN(payload.manual_override);
                let finalScore = hasOverride ? payload.manual_override : null;

                if (!hasOverride) {
                    const w = dbHealthSettings || {};

                    // Each term is scaled to 0-100, then weighted. weight_milestone is
                    // deliberately absent: the milestone checkboxes are rendered but never
                    // persisted, so there is no data to score. Normalizing by the weights
                    // actually applied keeps the ceiling at 100 — without it, excluding
                    // milestone's 30% would cap every client at 70.
                    const terms = [];
                    const addTerm = (weight, value) => {
                        const wNum = Number(weight);
                        if (!wNum || !isFinite(value)) return;
                        terms.push({ w: wNum, v: Math.min(100, Math.max(0, value)) });
                    };

                    let commScore = 0;
                    if (payload.last_comm_date) {
                        const days = Math.floor((new Date() - new Date(payload.last_comm_date)) / 86400000);
                        if (isFinite(days)) commScore = Math.max(0, 100 - (days * 5));
                    }

                    addTerm(w.weight_ghl,   (payload.ghl_usage || 0) * 20);
                    addTerm(w.weight_comm,  commScore);
                    addTerm(w.weight_leads, payload.leads_vol * 2);
                    addTerm(w.weight_appts, payload.appts_vol * 10);
                    addTerm(w.weight_deals, payload.deals_closed * 20);

                    const totalWeight = terms.reduce((sum, t) => sum + t.w, 0);
                    finalScore = totalWeight > 0
                        ? Math.round(terms.reduce((sum, t) => sum + (t.v * t.w), 0) / totalWeight)
                        : null;
                }

                // ?? rather than || so a legitimately calculated 0 isn't rewritten to 70
                payload.current_score = Math.min(100, Math.max(0, finalScore ?? 70));

                // Upsert structural logic directly into Supabase
                const { error: healthErr } = await supabaseClient.from('client_health').upsert([payload], { onConflict: 'client_name' });
                if (healthErr) throw healthErr;

                // Record the score so the trend chart has real history to plot.
                // Non-fatal: a logging failure must not look like a failed save.
                const { error: logErr } = await supabaseClient.from('health_logs').insert([{
                    client_name: payload.client_name,
                    score: payload.current_score,
                    logged_at: new Date().toISOString()
                }]);
                if (logErr) console.error("Health score saved, but logging the trend point failed:", logErr);

                // Refresh local caching matrices instantly
                closeAllDrawers();
                await fetchAllGlobalData(globalAllowedClients);
                if (typeof fetchHealthData === 'function') fetchHealthData();
                if (typeof renderGoldenEye === 'function') renderGoldenEye();

            } catch (err) {
                alert("Error saving metrics: " + err.message);
            } finally {
                btn.innerHTML = 'Save Account Health';
                btn.disabled = false;
            }
        };
window.renderMorningAudits = function() {
    const tbody = document.getElementById('audits-list-body');
    if (!globalAuditsData || globalAuditsData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="p-8 text-center text-gray-500 italic">No morning audits found.</td></tr>';
        return;
    }
    
    let html = '';
    globalAuditsData.forEach(audit => {
        const date = new Date(audit.created_at).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
        // Strip HTML tags just for the table preview snippet
        const rawText = audit.html_body.replace(/<[^>]*>?/gm, ' ');
        const snippet = rawText.substring(0, 100) + '...';
        
        html += `<tr class="hover:bg-white/5 transition border-b border-white/5">
            <td class="p-4 text-gray-300 font-bold whitespace-nowrap">${date}</td>
            <td class="p-4 text-gray-400 text-xs w-full">${escapeHTML(snippet)}</td>
            <td class="p-4 text-right whitespace-nowrap">
                <button onclick="openEditAuditModal(${audit.id})" class="text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 px-3 py-1.5 rounded mr-2 transition"><i class="fa-solid fa-pen text-xs"></i> Edit</button>
                <button onclick="deleteMorningAudit(${audit.id})" class="text-red-400 bg-red-500/10 hover:bg-red-500/20 px-3 py-1.5 rounded transition"><i class="fa-solid fa-trash text-xs"></i></button>
            </td>
        </tr>`;
    });
    tbody.innerHTML = html;
};

window.openEditAuditModal = function(id) {
    const audit = globalAuditsData.find(a => a.id === id);
    if (!audit) return;
    
    document.getElementById('edit-audit-html').value = audit.html_body || '';
    document.getElementById('btn-save-edit-audit').onclick = () => saveEditedAudit(id);
    document.getElementById('edit-audit-modal').style.display = 'flex';
};

window.saveEditedAudit = async function(id) {
    const btn = document.getElementById('btn-save-edit-audit');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...';
    btn.disabled = true;
    
    const newHtml = document.getElementById('edit-audit-html').value;
    
    try {
        const { error } = await supabaseClient.from('morning_audits').update({ html_body: newHtml }).eq('id', id);
        if (error) throw error;
        
        // Update local state and UI
        const index = globalAuditsData.findIndex(a => a.id === id);
        if (index > -1) globalAuditsData[index].html_body = newHtml;
        
        document.getElementById('edit-audit-modal').style.display = 'none';
        renderMorningAudits(); 
        
        // If the dashboard is open, update the displayed audit there too
        const outputBox = document.getElementById('global-ai-output');
        if (outputBox && !document.getElementById('page-goldeneye').classList.contains('hidden')) {
             outputBox.innerHTML = newHtml;
        }
    } catch (err) {
        alert("Error updating audit: " + err.message);
    } finally {
        btn.innerHTML = 'Save Changes';
        btn.disabled = false;
    }
};

window.deleteMorningAudit = async function(id) {
    if (!confirm("Are you sure you want to permanently delete this audit?")) return;
    
    try {
        const { error } = await supabaseClient.from('morning_audits').delete().eq('id', id);
        if (error) throw error;
        
        globalAuditsData = globalAuditsData.filter(a => a.id !== id);
        renderMorningAudits();
        
        // Clear the dashboard view if we deleted the most recent one
        const outputBox = document.getElementById('global-ai-output');
        if (outputBox && globalAuditsData.length === 0) {
            outputBox.innerHTML = '';
            outputBox.classList.add('hidden');
        } else if (outputBox && globalAuditsData.length > 0) {
             outputBox.innerHTML = globalAuditsData[0].html_body;
        }
    } catch(err) {
        alert("Error deleting audit: " + err.message);
    }
};

// ============================================================================
// LIFECYCLE & STAGE TRANSITION ENGINE
// ============================================================================
const lifecycleStages = ['Onboarding', 'Campaign Building', 'Campaign Learning', 'Optimizing', 'Offboarding'];

// Checklist templates per stage, loaded from stage_templates. Previously a hardcoded
// map of invented counts that promised tasks no code ever created.
let globalStageTemplates = [];

function templatesForStage(stage) {
    return globalStageTemplates
        .filter(t => t.stage === stage)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}

window.updateTransitionTaskCount = function() {
    const targetStage = document.getElementById('trans-target-stage').value;
    const clientObj = globalClientsData.find(c => normalize(c.name) === normalize(cSelectedAccount));

    // Only count what would actually be created — tasks the client already has for
    // this stage are skipped, so re-entering a stage doesn't duplicate the checklist.
    const templates = templatesForStage(targetStage);
    const existing = new Set(
        globalTasksData
            .filter(t => normalize(t.client || '') === normalize(clientObj?.name || '') && t.stage === targetStage)
            .map(t => String(t.title || '').trim().toLowerCase())
    );
    const toCreate = templates.filter(t => !existing.has(String(t.task_title || '').trim().toLowerCase()));

    document.getElementById('trans-task-count').innerText = toCreate.length;

    const notice = document.getElementById('trans-auto-gen-notice');
    if (notice && templates.length === 0) {
        notice.classList.add('hidden');
    }
};

// ---- Service tags on steps and checklist items ----
// Which clients a step applies to is decided in SQL (onboarding_condition_matches in
// service_onboarding.sql) and nowhere else. This editor only reads and writes the tags; it
// never works out applicability itself, so the preview can't disagree with the portal.
const WEBSITE_STATUS_LABELS = {
    new_build: "We're building it",
    existing: 'They have one',
    none: 'No website'
};

function serviceName(key) {
    return globalServices.find(s => s.key === key)?.name || key;
}

// Every check onboarding_auto_checks() knows, for the picker. Fetched once; the keys and
// labels live only in that SQL function.
let autoCheckCatalog = null;
let autoCheckCatalogPromise = null;
function loadAutoCheckCatalog() {
    if (!autoCheckCatalogPromise) {
        autoCheckCatalogPromise = supabaseClient.rpc('onboarding_auto_checks', { p_client: null })
            .then(({ data, error }) => {
                if (error) { console.warn('Could not load the automatic check list:', error); autoCheckCatalogPromise = null; return []; }
                autoCheckCatalog = (data || []).map(r => ({ key: r.check_key, label: r.label }));
                return autoCheckCatalog;
            });
    }
    return autoCheckCatalogPromise;
}

function autoCheckOptions(selected) {
    const list = autoCheckCatalog || [];
    // Keep a saved value selectable even before the list loads, or if the check was removed
    // from SQL, so re-saving the editor never silently drops it.
    const known = list.some(c => c.key === selected);
    return `<option value="">A person ticks it off</option>`
        + list.map(c => `<option value="${escapeAttr(c.key)}" ${c.key === selected ? 'selected' : ''}>Done when: ${escapeAttr(c.label)}</option>`).join('')
        + (selected && !known ? `<option value="${escapeAttr(selected)}" selected>Done when: ${escapeAttr(selected)}</option>` : '');
}

function refreshAutoCheckSelects() {
    document.querySelectorAll('select.ob-autocheck').forEach(sel => {
        sel.innerHTML = autoCheckOptions(sel.value || sel.dataset.saved || '');
    });
}

// The tag line under a step or checklist item. Nothing ticked = everyone.
function conditionEditorHtml(item) {
    const services = item?.service_keys || [];
    const websites = item?.website_statuses || [];
    // Offered services, plus any retired one this item is still tagged with, so the tag
    // stays visible and removable rather than hidden but still in force
    const shown = globalServices.filter(s => s.active !== false || services.includes(s.key));
    const serviceChips = shown.map(s => `
        <button type="button" class="ob-chip ob-chip-svc ${s.active === false ? 'ob-chip-off' : ''}" data-key="${escapeAttr(s.key)}"
            aria-pressed="${services.includes(s.key)}" onclick="toggleConditionChip(this)"
            title="${s.active === false ? 'Not offered any more' : 'Applies to clients with ' + escapeAttr(s.name)}">${escapeAttr(s.name)}</button>`).join('');
    const webChips = Object.entries(WEBSITE_STATUS_LABELS).map(([k, label]) => `
        <button type="button" class="ob-chip ob-chip-web" data-key="${k}" aria-pressed="${websites.includes(k)}" onclick="toggleConditionChip(this)">${label}</button>`).join('');

    return `
        <div class="ob-conditions flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
            <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-[10px] uppercase tracking-widest text-gray-500 mr-1">For</span>
                ${serviceChips}
                <span class="ob-svc-summary text-[10px] text-gray-500"></span>
            </div>
            <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-[10px] uppercase tracking-widest text-gray-500 mr-1">Website</span>
                ${webChips}
                <span class="ob-web-summary text-[10px] text-gray-500"></span>
            </div>
            <select class="glass-input !py-1 !text-xs !w-auto max-w-xs ob-autocheck" data-saved="${escapeAttr(item?.auto_check || '')}">${autoCheckOptions(item?.auto_check || '')}</select>
        </div>`;
}

window.toggleConditionChip = function(btn) {
    btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    updateConditionSummary(btn.closest('.ob-conditions'));
};

function updateConditionSummary(wrap) {
    if (!wrap) return;
    const anySvc = wrap.querySelector('.ob-chip-svc[aria-pressed="true"]');
    const anyWeb = wrap.querySelector('.ob-chip-web[aria-pressed="true"]');
    wrap.querySelector('.ob-svc-summary').innerText = anySvc ? '' : 'Everyone (Base)';
    wrap.querySelector('.ob-web-summary').innerText = anyWeb ? '' : 'Any';
}

function readConditions(row) {
    // Only the step's own tag line: a Questions step's per-question website pills share the look
    const scope = row.querySelector('.ob-conditions') || row;
    const pressed = sel => [...scope.querySelectorAll(`${sel}[aria-pressed="true"]`)].map(b => b.dataset.key);
    return {
        service_keys: pressed('.ob-chip-svc'),
        website_statuses: pressed('.ob-chip-web'),
        auto_check: row.querySelector('.ob-autocheck')?.value || null
    };
}

// ---- Services editor (Templates → Services) ----
window.renderServices = function() {
    const container = document.getElementById('services-container');
    if (!container) return;
    container.innerHTML = '';
    [...globalServices].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).forEach(s => addServiceRow(s));
    if (typeof Sortable !== 'undefined') {
        if (container._sortable) container._sortable.destroy();
        container._sortable = new Sortable(container, { handle: '.svc-drag-handle', animation: 150, ghostClass: 'sortable-ghost' });
    }
};

window.addServiceRow = function(svc) {
    const container = document.getElementById('services-container');
    if (!container) return;
    const saved = !!svc?.key;
    const row = document.createElement('div');
    row.className = 'svc-row grid grid-cols-12 gap-2 items-center';
    row.dataset.saved = saved ? 'true' : 'false';
    row.innerHTML = `
        <span class="svc-drag-handle col-span-1 cursor-grab active:cursor-grabbing text-gray-600 hover:text-gray-300 px-1" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
        <input type="text" class="glass-input !py-1.5 col-span-3 svc-name" placeholder="e.g. Video" value="${escapeAttr(svc?.name || '')}" ${saved ? '' : 'oninput="suggestServiceKey(this)"'}>
        <input type="text" class="glass-input !py-1.5 col-span-2 svc-key font-mono !text-xs" placeholder="video" value="${escapeAttr(svc?.key || '')}" ${saved ? 'readonly title="Steps are tagged with this key, so it can\'t change"' : ''}>
        <input type="text" class="glass-input !py-1.5 col-span-4 svc-desc" placeholder="What's included" value="${escapeAttr(svc?.description || '')}">
        <label class="col-span-2 flex items-center justify-center gap-2 text-[11px] text-gray-400 cursor-pointer">
            <input type="checkbox" class="row-checkbox svc-active" ${svc?.active === false ? '' : 'checked'}> Offered
        </label>`;
    container.appendChild(row);
    if (!saved) row.querySelector('.svc-name').focus();
};

window.suggestServiceKey = function(input) {
    const keyInput = input.closest('.svc-row').querySelector('.svc-key');
    if (keyInput.dataset.touched) return;
    keyInput.value = input.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    keyInput.oninput = () => { keyInput.dataset.touched = '1'; };
};

window.saveServices = async function() {
    if (currentUserRole !== 'admin') return;
    const btn = document.getElementById('btn-save-services');
    const rows = [...document.querySelectorAll('#services-container .svc-row')];
    const entered = rows.map((r, i) => ({
        key: r.querySelector('.svc-key').value.trim(),
        name: r.querySelector('.svc-name').value.trim(),
        description: r.querySelector('.svc-desc').value.trim() || null,
        active: r.querySelector('.svc-active').checked,
        sort_order: i + 1
    })).filter(s => s.key || s.name);

    const bad = entered.find(s => !s.name || !/^[a-z0-9_]+$/.test(s.key));
    if (bad) { alert(`"${bad.name || bad.key}" needs a name and a key made of lowercase letters, numbers or underscores.`); return; }
    const keys = entered.map(s => s.key);
    const dupe = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dupe) { alert(`Two services use the key "${dupe}".`); return; }

    // Services are never deleted from here: client_services and step tags point at the key.
    // A row an admin removes from view is simply left as it is.
    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...';
    btn.disabled = true;
    try {
        const { error } = await supabaseClient.from('services').upsert(entered, { onConflict: 'key' });
        if (error) throw error;
        const { data, error: loadErr } = await supabaseClient.from('services').select('*').order('sort_order');
        if (loadErr) throw loadErr;
        globalServices = data || [];
        renderServices();
    } catch (err) {
        alert('Could not save services: ' + err.message);
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
    }
};

// ---- Preview (Templates → Client Onboarding) ----
window.renderOnboardingPreviewControls = function() {
    const wrap = document.getElementById('ob-preview-services');
    if (!wrap) return;
    const checked = new Set([...wrap.querySelectorAll('.ob-chip[aria-pressed="true"]')].map(b => b.dataset.key));
    // First visit: preview the most common client, ads only
    if (!wrap.dataset.ready && globalServices.some(s => s.key === 'ads')) checked.add('ads');
    wrap.dataset.ready = '1';
    wrap.innerHTML = globalServices.filter(s => s.active !== false).map(s => `
        <button type="button" class="ob-chip" data-key="${escapeAttr(s.key)}" aria-pressed="${checked.has(s.key)}"
            onclick="this.setAttribute('aria-pressed', this.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); runOnboardingPreview();">${escapeAttr(s.name)}</button>`).join('');
    runOnboardingPreview();
};

let obPreviewSeq = 0;
window.runOnboardingPreview = async function() {
    const out = document.getElementById('ob-preview-result');
    if (!out) return;
    const services = [...document.querySelectorAll('#ob-preview-services .ob-chip[aria-pressed="true"]')].map(b => b.dataset.key);
    const website = document.getElementById('ob-preview-website').value || null;
    const seq = ++obPreviewSeq;
    out.innerHTML = '<span class="text-gray-500"><i class="fa-solid fa-spinner fa-spin mr-1"></i> Loading…</span>';

    const [{ data, error }] = await Promise.all([
        supabaseClient.rpc('onboarding_preview', { p_services: services, p_website: website }),
        loadAutoCheckCatalog()
    ]);
    if (seq !== obPreviewSeq) return;   // a newer click already asked
    if (error) {
        out.innerHTML = `<span class="text-red-400">Couldn't load the preview: ${escapeAttr(error.message)}. Has supabase/sql/service_onboarding.sql been run?</span>`;
        return;
    }

    const checkLabel = key => autoCheckCatalog?.find(c => c.key === key)?.label || key;
    const item = r => `
        <li class="flex items-start gap-2 py-1">
            <i class="fa-solid ${r.owner === 'agency' ? 'fa-list-check text-gray-500' : 'fa-circle-user text-blue-400/70'} mt-1 text-xs"></i>
            <span class="text-gray-200">${escapeAttr(r.title)}</span>
            ${r.auto_check ? `<span class="text-[10px] text-emerald-400/90 whitespace-nowrap mt-0.5" title="Golden Eye ticks this off itself"><i class="fa-solid fa-bolt mr-0.5"></i>${escapeAttr(checkLabel(r.auto_check))}</span>` : ''}
        </li>`;
    const group = (title, rows, note) => rows.length ? `
        <div class="min-w-0">
            <h4 class="text-[10px] uppercase tracking-widest text-gray-400 font-bold mb-1">${title} <span class="text-gray-600 font-normal normal-case tracking-normal">${rows.length}</span></h4>
            ${note ? `<p class="text-[10px] text-gray-500 mb-1">${note}</p>` : ''}
            <ul>${rows.map(item).join('')}</ul>
        </div>` : '';

    const rows = data || [];
    const steps = rows.filter(r => r.source === 'step');
    const clientSteps = steps.filter(r => r.owner !== 'agency');
    // Headings the portal will use: shared steps first, then one per service in services order
    const headings = [null, ...globalServices.map(s => s.key)];
    const clientGroups = headings.map(k => group(
        k ? escapeAttr(serviceName(k)) : 'Getting started',
        clientSteps.filter(r => (r.display_service_key || null) === k)
    )).join('');
    const stages = [...new Set(rows.filter(r => r.source === 'checklist').map(r => r.stage))];

    out.innerHTML = rows.length ? `
        <div class="grid gap-6 md:grid-cols-2">
            <div class="space-y-4">
                <h3 class="text-xs font-bold text-white">They see on Get Started</h3>
                ${clientGroups || '<p class="text-gray-500 text-xs">Nothing.</p>'}
            </div>
            <div class="space-y-4">
                <h3 class="text-xs font-bold text-white">We get as tasks</h3>
                ${group('When they finish onboarding', steps.filter(r => r.owner === 'agency'))}
                ${stages.map(st => group(escapeAttr(st), rows.filter(r => r.source === 'checklist' && r.stage === st))).join('')}
            </div>
        </div>
        ${!website ? '<p class="text-[11px] text-amber-400/80 mt-4"><i class="fa-solid fa-circle-info mr-1"></i>With the website not set, steps tagged for a website situation are left out.</p>' : ''}`
        : '<p class="text-gray-500 text-xs">No steps or checklist items apply.</p>';
};

// ---- Add-ons on Add / Edit Client ----
function renderClientServicePicker(containerId, clientName) {
    const wrap = document.getElementById(containerId);
    if (!wrap) return;
    const mine = clientName ? globalClientServices.filter(cs => cs.client_name === clientName) : [];
    const statusOf = key => mine.find(cs => cs.service_key === key)?.status;
    const STATUS_NOTE = { onboarding: 'onboarding', paused: 'paused' };
    // Offered services, plus any retired one this client still has
    const shown = globalServices.filter(s => s.active !== false || ['onboarding', 'active', 'paused'].includes(statusOf(s.key)));
    wrap.innerHTML = shown.length ? shown.map(s => {
        const st = statusOf(s.key);
        const has = ['onboarding', 'active', 'paused'].includes(st);
        return `
            <label class="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input type="checkbox" class="row-checkbox client-service-box" value="${escapeAttr(s.key)}" ${has ? 'checked' : ''}>
                ${escapeAttr(s.name)}
                ${STATUS_NOTE[st] ? `<span class="text-[10px] text-gray-500">(${STATUS_NOTE[st]})</span>` : ''}
            </label>`;
    }).join('') : '<span class="text-[11px] text-gray-500">No services set up yet. Add them in Templates → Services.</span>';
}

// Newly ticked → onboarding (or back to onboarding if it had ended). Unticked → ended.
// Paused stays paused while ticked. Rows are never deleted, so history survives.
// cachedName is the name the rows are filed under in globalClientServices (the name before
// any rename in this save); plan it before writing anything, so the "end it?" question can
// be asked before other edits are saved.
function planClientServiceChanges(cachedName, containerId) {
    const wrap = document.getElementById(containerId);
    const plan = { add: [], restart: [], end: [] };
    if (!wrap) return plan;
    const ticked = new Set([...wrap.querySelectorAll('.client-service-box:checked')].map(b => b.value));
    const existing = cachedName ? globalClientServices.filter(cs => cs.client_name === cachedName) : [];
    const live = cs => ['onboarding', 'active', 'paused'].includes(cs.status);
    ticked.forEach(key => {
        const row = existing.find(cs => cs.service_key === key);
        if (!row) plan.add.push(key);
        else if (!live(row)) plan.restart.push(key);
    });
    existing.filter(cs => live(cs) && !ticked.has(cs.service_key)).forEach(cs => plan.end.push(cs.service_key));
    return plan;
}

async function applyClientServiceChanges(clientName, plan) {
    const { add: addKeys, restart, end } = plan;
    const inserts = addKeys.map(key => ({ client_name: clientName, service_key: key, status: 'onboarding' }));
    if (inserts.length) {
        const { error } = await supabaseClient.from('client_services').insert(inserts);
        if (error) throw error;
    }
    if (restart.length) {
        const { error } = await supabaseClient.from('client_services')
            .update({ status: 'onboarding', started_at: new Date().toISOString(), onboarded_at: null })
            .eq('client_name', clientName).in('service_key', restart);
        if (error) throw error;
    }
    if (end.length) {
        const { error } = await supabaseClient.from('client_services')
            .update({ status: 'ended' })
            .eq('client_name', clientName).in('service_key', end);
        if (error) throw error;
    }
}

// ---- Stage checklist editor (Templates → Stage Checklists) ----
window.initStageTemplateEditor = function() {
    const picker = document.getElementById('tpl-stage-picker');
    if (!picker) return;
    if (!picker.options.length) {
        // Onboarding lives in its own editor — it's the only stage the client takes part
        // in, so its list mixes their steps with ours and can't be edited here.
        picker.innerHTML = lifecycleStages
            .filter(s => s !== 'Onboarding')
            .map(s => `<option value="${s}">${s}</option>`).join('');
    }
    renderStageTemplates();
};

window.renderStageTemplates = function() {
    const container = document.getElementById('tpl-stage-tasks-container');
    const picker = document.getElementById('tpl-stage-picker');
    if (!container || !picker) return;

    const rows = templatesForStage(picker.value);
    container.innerHTML = '';
    rows.forEach(r => addStageTemplateRow(r));

    const status = document.getElementById('tpl-stage-status');
    if (status) {
        status.innerText = rows.length
            ? `${rows.length} task${rows.length === 1 ? '' : 's'} created when a client enters ${picker.value}.`
            : `No checklist yet — moving a client into ${picker.value} won't create any tasks.`;
    }
};

window.addStageTemplateRow = function(tpl) {
    const container = document.getElementById('tpl-stage-tasks-container');
    if (!container) return;

    const types = ['Checklist', 'Milestone', 'One-off', 'Recurring'];
    const row = document.createElement('div');
    row.className = 'tpl-stage-row bg-black/20 border border-white/5 rounded-xl p-2 space-y-1';
    row.dataset.tplId = tpl?.id || '';
    row.innerHTML = `
        <div class="grid grid-cols-12 gap-2 items-center">
        <input type="text" class="glass-input !py-1.5 col-span-4 tpl-title" placeholder="e.g. Build campaign structure" value="${escapeAttr(stripSlashEscapes(tpl?.task_title))}">
        <input type="text" class="glass-input !py-1.5 col-span-2 tpl-assignee" placeholder="Assignee" value="${escapeAttr(stripSlashEscapes(tpl?.assignee))}">
        <input type="text" class="glass-input !py-1.5 col-span-2 tpl-group" placeholder="Optional" value="${escapeAttr(stripSlashEscapes(tpl?.checklist_group))}">
        <input type="number" class="glass-input !py-1.5 col-span-1 !text-center tpl-days" placeholder="0" value="${tpl?.due_days ?? 0}">
        <select class="glass-input !py-1.5 col-span-2 tpl-type">
            ${types.map(t => `<option value="${t}" ${tpl?.task_type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <button type="button" onclick="this.closest('.tpl-stage-row').remove()" class="col-span-1 text-red-500/60 hover:text-red-400" title="Remove">
            <i class="fa-solid fa-xmark"></i>
        </button>
        </div>
        ${conditionEditorHtml(tpl)}`;
    container.appendChild(row);
    updateConditionSummary(row.querySelector('.ob-conditions'));
    if (!autoCheckCatalog) loadAutoCheckCatalog().then(refreshAutoCheckSelects);
};

// Given an array whose rows have differing keys, PostgREST builds a single INSERT from
// the union of those keys and writes null for whichever a row is missing — so a brand
// new row sent alongside saved ones arrives with an explicit null id and never reaches
// the column's gen_random_uuid() default. Splitting by whether the id is present keeps
// each request's key set uniform.
async function saveRowsByIdPresence(table, rows, upsertOpts) {
    const existing = rows.filter(r => r.id);
    const fresh = rows.filter(r => !r.id);
    if (existing.length) {
        const { error } = await supabaseClient.from(table).upsert(existing, upsertOpts);
        if (error) throw error;
    }
    if (fresh.length) {
        const { error } = await supabaseClient.from(table).insert(fresh);
        if (error) throw error;
    }
}

window.saveStageTemplates = async function() {
    if (currentUserRole !== 'admin') return;
    const picker = document.getElementById('tpl-stage-picker');
    const btn = document.getElementById('btn-save-stage-tpl');
    const stage = picker.value;

    const rows = [...document.querySelectorAll('#tpl-stage-tasks-container .tpl-stage-row')];
    const entered = rows.map((r, i) => ({
        id: r.dataset.tplId || null,
        stage,
        task_title: r.querySelector('.tpl-title').value.trim(),
        assignee: r.querySelector('.tpl-assignee').value.trim() || null,
        checklist_group: r.querySelector('.tpl-group').value.trim() || null,
        due_days: parseInt(r.querySelector('.tpl-days').value) || 0,
        task_type: r.querySelector('.tpl-type').value,
        sort_order: i + 1,
        ...readConditions(r)
    })).filter(t => t.task_title);

    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...';
    btn.disabled = true;

    try {
        // Delete the rows the admin removed, then upsert the rest
        const keptIds = new Set(entered.map(t => t.id).filter(Boolean));
        const removed = templatesForStage(stage).filter(t => !keptIds.has(t.id));
        if (removed.length) {
            const { error } = await supabaseClient.from('stage_templates').delete().in('id', removed.map(t => t.id));
            if (error) throw error;
        }

        if (entered.length) {
            // Omit id entirely on new rows so Postgres generates one
            const payload = entered.map(t => {
                const row = {
                    stage: t.stage,
                    task_title: t.task_title,
                    assignee: t.assignee,
                    checklist_group: t.checklist_group,
                    due_days: t.due_days,
                    task_type: t.task_type,
                    sort_order: t.sort_order,
                    service_keys: t.service_keys,
                    website_statuses: t.website_statuses,
                    auto_check: t.auto_check
                };
                if (t.id) row.id = t.id;
                return row;
            });
            await saveRowsByIdPresence('stage_templates', payload);
        }

        await loadStageTemplates();
        renderStageTemplates();
    } catch (err) {
        alert("Could not save the checklist: " + err.message);
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
    }
};

// ---- Client onboarding steps (Templates → Client Onboarding) ----
// Configurable rather than hardcoded, for the same reason the stage checklists are:
// the process belongs to the agency, not to app.js.
window.renderOnboardingSteps = function() {
    const container = document.getElementById('onboarding-steps-container');
    if (!container) return;

    const steps = [...globalOnboardingSteps].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    container.innerHTML = '';
    steps.forEach(s => addOnboardingStepRow(s));
    initOnboardingSortable();

    const status = document.getElementById('onboarding-steps-status');
    if (status) {
        // The editor lists every row, but only active client-owned ones reach the portal
        const shown = steps.filter(s => s.active !== false && s.owner !== 'agency').length;
        const agency = steps.filter(s => s.owner === 'agency').length;
        const agencyNote = agency ? ` ${agency} agency step${agency === 1 ? '' : 's'} become tasks instead.` : '';
        status.innerText = steps.length
            ? `${shown} step${shown === 1 ? '' : 's'} shown to clients under Get Started.${agencyNote}`
            : 'No steps yet — clients won\'t see a Get Started tab until you add some.';
    }
};


// Order is stored as sort_order but derived from row position on save, so reordering
// has to be possible in the editor. Handle-only, so dragging never starts from an input.
let onboardingSortable = null;
function initOnboardingSortable() {
    const container = document.getElementById('onboarding-steps-container');
    if (!container || typeof Sortable === 'undefined') return;
    if (onboardingSortable) onboardingSortable.destroy();
    onboardingSortable = new Sortable(container, {
        handle: '.ob-drag-handle',
        animation: 150,
        ghostClass: 'sortable-ghost'
    });
}
window.addOnboardingStepRow = function(step) {
    const container = document.getElementById('onboarding-steps-container');
    if (!container) return;

    const types = [
        ['video',  'Video (Loom)'],
        ['form',   'Form (embedded)'],
        ['team',   'Sales team (names & numbers)'],
        ['action', 'Action (no embed)'],
        ['questions', 'Questions (built in)']
    ];

    const owner = step?.owner === 'agency' ? 'agency' : 'client';

    const row = document.createElement('div');
    row.className = 'ob-step-row bg-black/20 border border-white/5 rounded-xl p-3 space-y-2';
    row.dataset.stepId = step?.id || '';

    // Retired steps stay editable but are hidden from clients, and nothing on the row
    // said so — an admin could reasonably think they were live.
    const retired = step?.active === false;
    row.dataset.stepActive = retired ? 'false' : 'true';

    row.innerHTML = `
        <p class="ob-hidden-note text-[10px] uppercase tracking-widest text-amber-400/80 ${retired ? '' : 'hidden'}"><i class="fa-solid fa-eye-slash mr-1"></i>Hidden from clients &mdash; nothing about it is shown or created until it's switched on</p>
        <div class="flex gap-2 items-start">
            <span class="ob-drag-handle cursor-grab active:cursor-grabbing text-gray-600 hover:text-gray-300 px-1 pt-2" title="Drag to reorder">
                <i class="fa-solid fa-grip-vertical"></i>
            </span>
            <select class="glass-input !py-1.5 !w-36 ob-owner" onchange="toggleOnboardingOwnerFields(this)">
                <option value="client" ${owner === 'client' ? 'selected' : ''}>Client does</option>
                <option value="agency" ${owner === 'agency' ? 'selected' : ''}>We do</option>
            </select>
            <input type="text" class="glass-input !py-1.5 flex-1 ob-title" placeholder="Step title" value="${escapeAttr(stripSlashEscapes(step?.title))}">
            <select class="glass-input !py-1.5 !w-40 ob-type" onchange="toggleOnboardingOwnerFields(this)">
                ${types.map(([v, l]) => `<option value="${v}" ${step?.step_type === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <button type="button" onclick="toggleOnboardingStepLive(this)" class="ob-live-toggle text-gray-500 hover:text-white px-2 py-1.5" title="${retired ? 'Hidden. Click to switch it on for clients' : 'Live. Click to hide it'}">
                <i class="fa-solid ${retired ? 'fa-eye-slash text-amber-400/80' : 'fa-eye'}"></i>
            </button>
            <button type="button" onclick="this.closest('.ob-step-row').remove()" class="text-red-500/60 hover:text-red-400 px-2 py-1.5" title="Remove step">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <input type="text" class="glass-input !py-1.5 ob-desc" placeholder="Short instruction" value="${escapeAttr(stripSlashEscapes(step?.description))}">
        <div class="flex gap-2">
            <input type="text" class="glass-input !py-1.5 flex-1 ob-embed" placeholder="Video URL or form embed URL" value="${escapeAttr(stripSlashEscapes(step?.embed_url))}">
            <input type="text" class="glass-input !py-1.5 !w-44 ob-assignee" placeholder="Assignee" value="${escapeAttr(stripSlashEscapes(step?.assignee))}">
            <input type="number" class="glass-input !py-1.5 !w-24 !text-center ob-days" placeholder="Days" value="${step?.due_days ?? 0}">
        </div>
        <div class="ob-client-opts space-y-2">
            <div class="flex gap-2 items-center">
                <label class="flex items-center gap-2 text-[11px] text-gray-400 cursor-pointer whitespace-nowrap">
                    <input type="checkbox" class="row-checkbox ob-confirm" ${step?.requires_confirm ? 'checked' : ''} onchange="toggleOnboardingOwnerFields(this)">
                    Needs them to confirm they did it
                </label>
                <input type="text" class="glass-input !py-1.5 flex-1 ob-confirm-label" placeholder="Button wording, e.g. I've given you access" value="${escapeAttr(stripSlashEscapes(step?.confirm_label))}">
            </div>
            <label class="flex items-center gap-2 text-[11px] text-gray-400 cursor-pointer">
                <input type="checkbox" class="row-checkbox ob-help" ${step?.offer_help ? 'checked' : ''}>
                Offer a "book a call with us" option on this step
            </label>
        </div>
        <div class="ob-questions space-y-2 border-l-2 border-blue-500/30 pl-3">
            <p class="text-[10px] uppercase tracking-widest text-gray-500">Questions &mdash; answers are saved in Golden Eye and shown on the client's page</p>
            <div class="ob-q-list space-y-2">
                ${(Array.isArray(step?.questions) ? step.questions : []).map(obQuestionRowHtml).join('')}
            </div>
            <button type="button" onclick="addObQuestion(this)" class="text-xs text-blue-400 hover:text-blue-300 font-bold">
                <i class="fa-solid fa-plus mr-1"></i> Add question
            </button>
        </div>
        ${conditionEditorHtml(step)}`;
    container.appendChild(row);
    updateConditionSummary(row.querySelector('.ob-conditions'));
    toggleOnboardingOwnerFields(row.querySelector('.ob-owner'));
    if (!autoCheckCatalog) loadAutoCheckCatalog().then(refreshAutoCheckSelects);
};

// One question in a Questions step. Its id is kept across edits, so rewording a question keeps the
// answers already given to it. Website pills use their own class so readConditions() (the step's
// own tags) never picks them up.
const OB_QUESTION_TYPES = [['short', 'Short answer'], ['long', 'Long answer'], ['choice', 'Pick one'], ['multi', 'Pick any']];

function obQuestionRowHtml(q) {
    q = q || {};
    const id = q.id || `q_${Math.random().toString(36).slice(2, 8)}`;
    const webs = q.website_statuses || [];
    return `
        <div class="ob-q-row bg-black/20 border border-white/5 rounded-lg p-2 space-y-2" data-qid="${escapeAttr(id)}">
            <div class="flex gap-2 items-center">
                <input type="text" class="glass-input !py-1.5 flex-1 ob-q-label" placeholder="Question" value="${escapeAttr(q.label || '')}">
                <select class="glass-input !py-1.5 !w-36 ob-q-type" onchange="this.closest('.ob-q-row').querySelector('.ob-q-options').style.display = ['choice','multi'].includes(this.value) ? '' : 'none'">
                    ${OB_QUESTION_TYPES.map(([v, l]) => `<option value="${v}" ${(q.type || 'short') === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
                <label class="flex items-center gap-1 text-[11px] text-gray-400 cursor-pointer whitespace-nowrap">
                    <input type="checkbox" class="row-checkbox ob-q-required" ${q.required ? 'checked' : ''}> Required
                </label>
                <button type="button" onclick="moveObQuestion(this, -1)" class="text-gray-500 hover:text-white px-1" title="Move up"><i class="fa-solid fa-arrow-up"></i></button>
                <button type="button" onclick="moveObQuestion(this, 1)" class="text-gray-500 hover:text-white px-1" title="Move down"><i class="fa-solid fa-arrow-down"></i></button>
                <button type="button" onclick="this.closest('.ob-q-row').remove()" class="text-red-500/60 hover:text-red-400 px-1" title="Remove question"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <input type="text" class="glass-input !py-1.5 w-full ob-q-options" placeholder="Choices, separated by commas"
                   value="${escapeAttr((q.options || []).join(', '))}" style="display:${['choice', 'multi'].includes(q.type) ? '' : 'none'}">
            <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-[10px] uppercase tracking-widest text-gray-500 mr-1">Only ask if website</span>
                ${Object.entries(WEBSITE_STATUS_LABELS).map(([k, label]) => `
                    <button type="button" class="ob-chip ob-chip-web ob-q-web" data-key="${k}" aria-pressed="${webs.includes(k)}"
                        onclick="this.setAttribute('aria-pressed', this.getAttribute('aria-pressed') === 'true' ? 'false' : 'true')">${label}</button>`).join('')}
                <span class="text-[10px] text-gray-500">(none picked = always ask)</span>
            </div>
        </div>`;
}

window.addObQuestion = function(btn) {
    const list = btn.closest('.ob-questions').querySelector('.ob-q-list');
    list.insertAdjacentHTML('beforeend', obQuestionRowHtml());
    list.lastElementChild.querySelector('.ob-q-label').focus();
};

window.moveObQuestion = function(btn, dir) {
    const row = btn.closest('.ob-q-row');
    const sibling = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling) return;
    if (dir < 0) sibling.before(row); else sibling.after(row);
};

function readObQuestions(stepRow) {
    return [...stepRow.querySelectorAll('.ob-q-row')].map(r => ({
        id: r.dataset.qid,
        label: r.querySelector('.ob-q-label').value.trim(),
        type: r.querySelector('.ob-q-type').value,
        required: r.querySelector('.ob-q-required').checked,
        options: ['choice', 'multi'].includes(r.querySelector('.ob-q-type').value)
            ? r.querySelector('.ob-q-options').value.split(',').map(o => o.trim()).filter(Boolean)
            : [],
        website_statuses: [...r.querySelectorAll('.ob-q-web[aria-pressed="true"]')].map(b => b.dataset.key)
    })).filter(q => q.label);
}

// Hide a step without deleting it (its progress and tags stay), or switch a hidden one on.
// Takes effect on Save, like every other edit in this list.
window.toggleOnboardingStepLive = function(btn) {
    const row = btn.closest('.ob-step-row');
    const live = row.dataset.stepActive === 'false';
    row.dataset.stepActive = live ? 'true' : 'false';
    row.querySelector('.ob-hidden-note').classList.toggle('hidden', live);
    btn.title = live ? 'Live. Click to hide it' : 'Hidden. Click to switch it on for clients';
    btn.querySelector('i').className = `fa-solid ${live ? 'fa-eye' : 'fa-eye-slash text-amber-400/80'}`;
};

// Show only the fields that mean something for this row. A client step has no assignee
// or due date; an agency step has nothing to embed. Hiding them beats offering inputs
// whose values would be silently ignored.
window.toggleOnboardingOwnerFields = function(el) {
    const row = el.closest('.ob-step-row');
    const isAgency = row.querySelector('.ob-owner').value === 'agency';
    const type = row.querySelector('.ob-type');
    const embed = row.querySelector('.ob-embed');

    type.style.display = isAgency ? 'none' : '';
    row.querySelector('.ob-assignee').style.display = isAgency ? '' : 'none';
    row.querySelector('.ob-days').style.display = isAgency ? '' : 'none';
    // These only mean anything for a step the client performs
    row.querySelector('.ob-client-opts').style.display = isAgency ? 'none' : '';
    // Only our own tasks can tick themselves off; a client step is done when they do it
    const autoCheck = row.querySelector('.ob-autocheck');
    if (autoCheck) autoCheck.style.display = isAgency ? '' : 'none';
    // The label field is pointless unless a confirmation is being asked for
    row.querySelector('.ob-confirm-label').style.display = row.querySelector('.ob-confirm').checked ? '' : 'none';

    // Hidden, not cleared — toggling owner or type to compare options and back used to
    // wipe a pasted URL. The save decides what actually gets stored.
    const needsEmbed = !isAgency && !['action', 'team', 'questions'].includes(type.value);
    embed.style.display = needsEmbed ? '' : 'none';
    const questions = row.querySelector('.ob-questions');
    if (questions) questions.style.display = !isAgency && type.value === 'questions' ? '' : 'none';
};

window.saveOnboardingSteps = async function() {
    if (currentUserRole !== 'admin') return;
    const btn = document.getElementById('btn-save-onboarding');
    const rows = [...document.querySelectorAll('#onboarding-steps-container .ob-step-row')];

    const entered = rows.map((r, i) => {
        const owner = r.querySelector('.ob-owner').value;
        const isAgency = owner === 'agency';
        // An agency item is a task, not something rendered to the client
        const stepType = isAgency ? 'action' : r.querySelector('.ob-type').value;
        // The field is only hidden when it doesn't apply, so ignore whatever it still holds
        const keepsEmbed = !isAgency && !['action', 'team', 'questions'].includes(stepType);

        return {
            id: r.dataset.stepId || null,
            owner,
            title: r.querySelector('.ob-title').value.trim(),
            description: r.querySelector('.ob-desc').value.trim() || null,
            step_type: stepType,
            embed_url: keepsEmbed ? (r.querySelector('.ob-embed').value.trim() || null) : null,
            assignee: isAgency ? (r.querySelector('.ob-assignee').value.trim() || null) : null,
            due_days: isAgency ? (parseInt(r.querySelector('.ob-days').value) || 0) : 0,
            offer_help: !isAgency && r.querySelector('.ob-help').checked,
            requires_confirm: !isAgency && r.querySelector('.ob-confirm').checked,
            confirm_label: !isAgency ? (r.querySelector('.ob-confirm-label').value.trim() || null) : null,
            sort_order: i + 1,
            // Carried from the row rather than forced true, so saving the editor can't
            // silently republish a step that was retired
            active: r.dataset.stepActive !== 'false',
            ...readConditions(r),
            auto_check: isAgency ? readConditions(r).auto_check : null,
            // Kept only on a Questions step; switching a step to another type drops them on save
            questions: !isAgency && stepType === 'questions' ? readObQuestions(r) : null
        };
    }).filter(s => s.title);

    // action, team and questions steps render their own UI, so none needs a URL. A hidden step can
    // wait for its URL: that's how a step gets drafted before its video or form exists.
    const missingEmbed = entered.find(s => s.owner === 'client' && s.active
        && !['action', 'team', 'questions'].includes(s.step_type) && !s.embed_url);
    if (missingEmbed) {
        alert(`"${missingEmbed.title}" is a ${missingEmbed.step_type} step but has no URL — clients would see an empty box.`);
        return;
    }
    const emptyQuestions = entered.find(s => s.active && s.step_type === 'questions' && !s.questions.length);
    if (emptyQuestions) {
        alert(`"${emptyQuestions.title}" is a Questions step with no questions. Add some, or hide the step with the eye button.`);
        return;
    }
    for (const s of entered.filter(x => x.step_type === 'questions')) {
        const noChoices = s.questions.find(q => ['choice', 'multi'].includes(q.type) && !q.options.length);
        if (noChoices) {
            alert(`In "${s.title}", the question "${noChoices.label}" needs its choices, separated by commas.`);
            return;
        }
    }

    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...';
    btn.disabled = true;

    try {
        const keptIds = new Set(entered.map(s => s.id).filter(Boolean));
        const removed = globalOnboardingSteps.filter(s => !keptIds.has(s.id));
        if (removed.length) {
            // Progress rows cascade-delete with the step
            const { error } = await supabaseClient.from('onboarding_steps').delete().in('id', removed.map(s => s.id));
            if (error) throw error;
        }

        if (entered.length) {
            const payload = entered.map(s => {
                const row = {
                    owner: s.owner, title: s.title, description: s.description,
                    step_type: s.step_type, embed_url: s.embed_url,
                    assignee: s.assignee, due_days: s.due_days, offer_help: s.offer_help,
                    requires_confirm: s.requires_confirm, confirm_label: s.confirm_label,
                    sort_order: s.sort_order, active: s.active,
                    service_keys: s.service_keys, website_statuses: s.website_statuses, auto_check: s.auto_check,
                    questions: s.questions
                };
                if (s.id) row.id = s.id;
                return row;
            });

            try {
                await saveRowsByIdPresence('onboarding_steps', payload);
            } catch (err) {
                // Before onboarding_questions.sql has run there's no questions column. Save the rest
                // rather than block every edit, unless a Questions step is being saved.
                const noColumn = /questions/.test(`${err.message || ''} ${err.details || ''}`);
                if (!noColumn || entered.some(s => s.step_type === 'questions')) {
                    throw noColumn ? new Error('Questions steps need supabase/sql/onboarding_questions.sql to be run first.') : err;
                }
                await saveRowsByIdPresence('onboarding_steps', payload.map(({ questions, ...rest }) => rest));
            }
        }

        await loadOnboardingData();
        renderOnboardingSteps();
    } catch (err) {
        alert("Could not save the onboarding steps: " + err.message);
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
    }
};

async function loadOnboardingData() {
    const [stepsRes, progRes] = await Promise.allSettled([
        supabaseClient.from('onboarding_steps').select('*').order('sort_order'),
        supabaseClient.from('client_onboarding_progress').select('*')
    ]);
    globalOnboardingSteps = stepsRes.status === 'fulfilled' ? (stepsRes.value.data || []) : [];
    globalOnboardingProgress = progRes.status === 'fulfilled' ? (progRes.value.data || []) : [];
}

async function loadStageTemplates() {
    const { data, error } = await supabaseClient.from('stage_templates').select('*').order('sort_order');
    if (error) { console.error("Could not load stage templates:", error); return; }
    globalStageTemplates = data || [];
}

window.toggleAutoGenerationNotice = function() {
    const isGenerating = document.getElementById('trans-generate-tasks').checked;
    const noticeEl = document.getElementById('trans-auto-gen-notice');
    if (isGenerating) {
        noticeEl.classList.remove('hidden');
    } else {
        noticeEl.classList.add('hidden');
    }
};

// Create a stage's checklist tasks for a client. Returns how many were created.
// Skips any the client already has for that stage, so moving back into a stage
// doesn't duplicate the list or reopen work that's already done.
// opts.onlyServices: for a client past onboarding, raise only agency steps tagged with these
// add-ons (see raiseOnboardingAgencyTasks).
async function generateStageTasks(clientName, stage, opts = {}) {
    // Only the steps and checklist items that apply to this client's add-ons and website.
    // Later stages ask stage_templates_for_client(); before that SQL exists, every item applies.
    let stageItems = null;
    if (stage !== 'Onboarding') {
        const { data, error } = await supabaseClient.rpc('stage_templates_for_client', { p_client: clientName, p_stage: stage });
        stageItems = error ? templatesForStage(stage) : (data || []);
    }
    let agencySteps = stage === 'Onboarding' ? allOnboardingItems(clientName).filter(s => s.owner === 'agency') : [];
    if (opts.onlyServices) {
        const want = new Set(opts.onlyServices);
        const tagged = new Set((obFor(clientName)?.steps || []).filter(r => want.has(r.service_key)).map(r => r.step_id));
        agencySteps = agencySteps.filter(s => tagged.has(s.id));
    }

    // Onboarding is the one stage the client participates in, so its list lives in
    // onboarding_steps alongside their steps. Only the agency-owned rows become tasks.
    const templates = stage === 'Onboarding'
        ? agencySteps
            .map(s => ({
                task_title: s.title,
                assignee: s.assignee,
                due_days: s.due_days,
                task_type: 'Checklist',
                default_notes: s.description,
                checklist_group: null,
                priority: 3, urgency: 3, effort: 3
            }))
        : stageItems;

    if (!templates.length) return 0;

    // Matched on the normalized name rather than an exact one: everything else in the
    // app compares clients that way, and a rename would otherwise slip the dedupe and
    // regenerate the whole checklist.
    const { data: existingRows } = await supabaseClient
        .from('tasks').select('title, client').eq('stage', stage);

    const want = normalize(clientName);
    const existing = new Set((existingRows || [])
        .filter(t => normalize(t.client || '') === want)
        .map(t => String(t.title || '').trim().toLowerCase()));
    const toCreate = templates.filter(t => !existing.has(String(t.task_title || '').trim().toLowerCase()));
    if (!toCreate.length) return 0;

    const now = new Date().toISOString();
    const dueFrom = days => {
        const d = new Date();
        d.setDate(d.getDate() + (parseInt(days) || 0));
        return d.toISOString().split('T')[0];
    };

    // stage_templates uses its own column names (task_title / priority / urgency /
    // effort / default_notes); the tasks table uses title / p / u / e / notes.
    const rows = toCreate.map(t => {
        const p = t.priority ?? 3, u = t.urgency ?? 3, e = t.effort ?? 3;
        return {
            client: clientName,
            title: t.task_title,
            type: t.task_type || 'Checklist',
            stage,
            status: 'Not Started',
            assignee: t.assignee || null,
            checklist_group: t.checklist_group || null,
            p, u, e,
            score: Math.round(((p * 0.4) + (u * 0.4) + ((6 - e) * 0.2)) * 20),
            due: dueFrom(t.due_days),
            notes: t.default_notes || null,
            updated_at: now
        };
    });

    const { data: created, error } = await supabaseClient.from('tasks').insert(rows).select();
    if (error) throw error;

    // Callers that don't refetch still need these on screen, and the dedupe above reads
    // the database, so a stale local copy can't cause duplicates either way.
    if (created?.length) globalTasksData.push(...created);
    return created?.length ?? rows.length;
}

// The portal raises the handoff task the moment the client finishes, but only while the
// Get Started tab is open — the form poll stops the instant they navigate away. A client
// who submits and closes the tab has their progress written by the webhook with nobody
// there to notice, and once onboarding reads as complete the tab never comes back to try
// again. Caught up here, where the dashboard can see every client's progress.
async function reconcileOnboardingHandoffTasks() {
    if (currentUserRole !== 'admin') return;

    for (const c of globalClientsData) {
        if ((c.status || 'active') !== 'active') continue;

        if ((c.current_stage || 'Onboarding') !== 'Onboarding') {
            await reconcileAddonOnboarding(c);
            continue;
        }
        if (!activeOnboardingSteps(c.name).length) continue;
        if (!onboardingIsComplete(c.name)) continue;

        // Only a backstop now: the database trigger raises this the instant the last step
        // lands, so usually it already exists by the time anyone opens the dashboard.
        if (!onboardingHandoffRaised(c.name)) {
            const { data, error } = await supabaseClient
                .from('tasks').insert([buildOnboardingHandoffTask(c.name)]).select();
            if (error) {
                console.error(`[LIFECYCLE ENGINE] No handoff task for ${c.name}:`, error);
            } else {
                if (data?.length) globalTasksData.push(...data);
                console.log(`[LIFECYCLE ENGINE] ${c.name} finished onboarding — handoff task raised.`);
            }
        }

        // Deliberately outside that check. This used to sit behind it, so when the trigger
        // won the race — which it always does — the agency checklist was never raised at
        // all and the only task to show for a finished onboarding was the handoff.
        // generateStageTasks dedupes against the database, so running every load is safe.
        await raiseOnboardingAgencyTasks(c.name, 'Onboarding');
    }
}

// Ticks off our own tasks whose "done when" check now passes (supabase/sql/auto_check_reconcile.sql).
// The decision is made in that SQL function, which the daily schedule also runs; this just asks
// it on load and mirrors what it closed into the board.
async function runAutoChecks() {
    if (currentUserRole !== 'admin') return 0;
    const { data, error } = await supabaseClient.rpc('reconcile_auto_checks');
    if (error) {
        // Not installed yet is expected until the SQL has run; anything else is worth seeing
        if (!/reconcile_auto_checks/.test(error.message || '')) console.error('[LIFECYCLE ENGINE] Automatic checks failed:', error);
        return 0;
    }
    (data || []).forEach(r => {
        const task = globalTasksData.find(t => String(t.id) === String(r.task_id));
        if (task) task.status = 'Complete';
        console.log(`[LIFECYCLE ENGINE] ${r.client}: "${r.title}" ticked off automatically (${r.check_key}).`);
    });
    return data?.length || 0;
}

// The same backstop for a client past onboarding who was given an add-on. The trigger normally
// does this inside the save that completed the last step; this catches the rare miss (two steps
// completing in concurrent saves). No text, same as the trigger.
async function reconcileAddonOnboarding(c) {
    const a = obFor(c.name);
    if (!a) return;
    const finished = a.services.filter(s => s.service_key !== 'base' && s.status === 'onboarding' && s.complete);
    for (const s of finished) {
        const title = addonHandoffTitle(s.service_key);
        const exists = globalTasksData.some(t => normalize(t.client || '') === normalize(c.name)
            && String(t.title || '').trim().toLowerCase() === title.toLowerCase());
        if (!exists) {
            const row = { ...buildOnboardingHandoffTask(c.name), title,
                notes: `${c.name} finished their ${serviceName(s.service_key)} onboarding steps in their portal.` };
            const { data, error } = await supabaseClient.from('tasks').insert([row]).select();
            if (error) { console.error(`[LIFECYCLE ENGINE] No ${s.service_key} handoff task for ${c.name}:`, error); continue; }
            if (data?.length) globalTasksData.push(...data);
        }
        const { error } = await supabaseClient.from('client_services')
            .update({ status: 'active', onboarded_at: new Date().toISOString() })
            .eq('client_name', c.name).eq('service_key', s.service_key).eq('status', 'onboarding');
        if (error) console.error(`[LIFECYCLE ENGINE] Could not mark ${s.service_key} onboarded for ${c.name}:`, error);
        else s.status = 'active';
        console.log(`[LIFECYCLE ENGINE] ${c.name} finished ${s.service_key} onboarding — caught up on load.`);
    }
    // Only clients with an add-on handoff task get anything; dedupes, so safe every load
    if (globalTasksData.some(t => normalize(t.client || '') === normalize(c.name) && / onboarding complete — ready to start$/i.test(String(t.title || '').trim()))) {
        await raiseOnboardingAgencyTasks(c.name, c.current_stage);
    }
}

// Moves clients out of Onboarding once the agency's own onboarding work is done. The
// client's portal steps feed those tasks but don't decide the stage themselves — the
// team can still owe work after the client has finished everything on their side.
// A client with no Onboarding tasks at all hasn't finished, they haven't started, so
// an empty list advances nobody. Paused and archived accounts sit still: advancing them
// would generate work for a client nobody is servicing.
// Returns how many clients moved, so a caller that has already painted the screen knows
// whether it needs to paint it again.
async function autoAdvanceCompletedOnboarding() {
    // Only admins can write the clients table; anyone else would just log an RLS failure
    if (currentUserRole !== 'admin') return 0;

    const nextStage = lifecycleStages[lifecycleStages.indexOf('Onboarding') + 1];
    if (!nextStage) return 0;

    const ready = globalClientsData.filter(c => {
        if ((c.current_stage || 'Onboarding') !== 'Onboarding') return false;
        if ((c.status || 'active') !== 'active') return false;

        const obTasks = globalTasksData.filter(t =>
            normalize(t.client || '') === normalize(c.name) && t.stage === 'Onboarding');

        return obTasks.length > 0 && obTasks.every(t => t.status === 'Complete');
    });

    let advanced = 0;

    for (const c of ready) {
        const { error } = await supabaseClient
            .from('clients').update({ current_stage: nextStage }).eq('id', c.id);
        if (error) { console.error(`[LIFECYCLE ENGINE] Could not advance ${c.name}:`, error); continue; }

        c.current_stage = nextStage;
        advanced++;

        // The stage moved regardless; a checklist that fails shouldn't strand the rest
        try {
            const created = await generateStageTasks(c.name, nextStage);
            console.log(`[LIFECYCLE ENGINE] ${c.name} finished onboarding → ${nextStage}: created ${created} task(s).`);
        } catch (err) {
            console.error(`[LIFECYCLE ENGINE] ${c.name} advanced but ${nextStage} tasks failed:`, err);
        }
    }

    return advanced;
}

window.openStageTransitionModal = function() {
    if (cSelectedAccount === "ALL") return;
    
    const clientObj = globalClientsData.find(c => normalize(c.name) === normalize(cSelectedAccount));
    if (!clientObj) return;

    const currentStage = clientObj.current_stage || 'Onboarding';
    const currentIndex = lifecycleStages.indexOf(currentStage);    
    // Set Current Stage Text
    document.getElementById('trans-current-stage').innerText = currentStage;
    
    // Populate Target Stage Dropdown
    const selectEl = document.getElementById('trans-target-stage');
    selectEl.innerHTML = lifecycleStages.map(stage => 
        `<option value="${stage}">${stage}</option>`
    ).join('');
    
    // Default to the next logical stage, or the current one if at the end
    const defaultTarget = currentIndex < lifecycleStages.length - 1 ? lifecycleStages[currentIndex + 1] : currentStage;
    selectEl.value = defaultTarget;
    
    // Reset Checkbox and update UI dynamically
    document.getElementById('trans-generate-tasks').checked = true;
    window.toggleAutoGenerationNotice();
    window.updateTransitionTaskCount();

    document.getElementById('stage-transition-modal').style.display = 'flex';
};

// ================= EDIT CLIENT =================
window.openEditClientModal = function() {
    if (currentUserRole !== 'admin') return;
    const c = globalClientsData.find(x => normalize(x.name) === normalize(cSelectedAccount));
    if (!c) { alert("Could not find that client record."); return; }

    const modal = document.getElementById('edit-client-modal');
    // Same trick the add modal uses: hoist it out of any hidden ancestor
    if (modal.parentElement.id !== 'theme-wrapper') {
        document.getElementById('theme-wrapper').appendChild(modal);
    }

    document.getElementById('edit-client-id').value            = c.id;
    document.getElementById('edit-client-original-name').value = c.name || '';
    document.getElementById('edit-client-current-name').innerText = c.name || 'this client';

    document.getElementById('edit-client-name').value         = c.name || '';
    document.getElementById('edit-client-contact-name').value = c.contact_name || '';
    document.getElementById('edit-client-industry').value     = c.industry || '';
    document.getElementById('edit-client-email').value        = c.client_email || '';
    renderClientServicePicker('edit-client-services', c.name);
    document.getElementById('edit-client-website-status').value = c.website_status || '';
    renderContactRows(c.name);
    document.getElementById('edit-client-ad-account').value   = c.ad_account_id || '';
    document.getElementById('edit-client-business-id').value  = c.business_id || '';

    document.getElementById('edit-client-gsc-property').value = c.gsc_property || '';
    document.getElementById('edit-client-ga4-property').value = c.ga4_property_id || '';
    document.getElementById('edit-client-gbp-location').value = c.gbp_location_id || '';
    document.getElementById('edit-client-ghl-location').value = c.ghl_location_id || '';
    document.getElementById('edit-client-seranking-site').value = c.seranking_site_id || '';
    document.getElementById('edit-client-seo-start').value = c.seo_start_date || '';
    document.getElementById('edit-client-seo-fee').value = c.seo_monthly_fee ?? '';
    // Cleared on open, not left showing the previous client's verdict — a stale green
    // "Connected" against a different client is worse than no answer at all.
    document.getElementById('seo-connection-result').innerHTML = '';
    document.getElementById('seranking-connection-result').innerHTML = '';
    document.getElementById('ga4-connection-result').innerHTML = '';
    document.getElementById('edit-client-seranking-local').value = c.seranking_local_id || '';
    document.getElementById('gbp-connection-result').innerHTML = '';

    document.getElementById('edit-client-retainer').value     = c.monthly_retainer || '';
    if (c.contract_type) document.getElementById('edit-client-contract').value = c.contract_type;

    modal.style.display = 'flex';
};

// ---- Search Console connection test ----
// Answers "is this wired up?" at the moment the property is typed, rather than three
// days later when the chart is still empty and nobody can tell whether that means no
// traffic, a typo, or a permission that was never granted. Those three look identical
// from the outside and are the reason SEO integrations rot quietly.
//
// It deliberately tests the string currently IN the box, not the one already saved —
// otherwise a correct old value would pass while the new typo sat there unsaved.
const SEO_FN = 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/seo-sync';

// Tests the SE Ranking Local location ID typed in the box: does it exist, and is its Google profile connected?
window.testGbpConnection = async function() {
    const out = document.getElementById('gbp-connection-result');
    const btn = document.getElementById('btn-test-gbp-connection');
    if (!out || !btn) return;
    const localId = document.getElementById('edit-client-seranking-local').value.replace(/\D/g, '');
    if (!localId) { out.innerHTML = '<span class="text-gray-500">Enter the SE Ranking Local location ID first.</span>'; return; }
    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Checking...';
    btn.disabled = true;
    out.innerHTML = '';
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (!session?.access_token) throw new Error('Your session has expired — sign in again.');
        const res = await fetch(SERANKING_FN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
            body: JSON.stringify({ mode: 'check', client: document.getElementById('edit-client-original-name').value, local_id: localId })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || `the sync service returned ${res.status}`);
        // An older seranking-sync ignores local_id and answers about the rank project instead
        if (/Connected — project \d|seranking_site_id set/.test(data.message || '')) throw new Error('Deploy the latest seranking-sync first.');
        out.innerHTML = data.ok
            ? `<span class="text-emerald-400 font-bold"><i class="fa-solid fa-circle-check mr-1"></i>${escapeAttr(data.message)}</span>`
            : `<span class="text-amber-400 font-bold"><i class="fa-solid fa-triangle-exclamation mr-1"></i>${escapeAttr(data.message)}</span>`;
    } catch (err) {
        out.innerHTML = `<span class="text-red-400">${escapeAttr(err.message)}</span>`;
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
    }
};

// Tests the GA4 property ID typed in the box (not the saved one), like Test Search Console.
window.testGa4Connection = async function() {
    const out = document.getElementById('ga4-connection-result');
    const btn = document.getElementById('btn-test-ga4-connection');
    if (!out || !btn) return;
    const property = document.getElementById('edit-client-ga4-property').value.replace(/\D/g, '');
    if (!property) { out.innerHTML = '<span class="text-gray-500">Enter the GA4 property ID first.</span>'; return; }
    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Checking...';
    btn.disabled = true;
    out.innerHTML = '';
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (!session?.access_token) throw new Error('Your session has expired — sign in again.');
        const res = await fetch(SEO_FN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
            body: JSON.stringify({ mode: 'check_ga4', property })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
            throw new Error(/unknown mode/.test(data.error || '') ? 'Deploy the latest seo-sync first.' : (data.error || `the sync service returned ${res.status}`));
        }
        out.innerHTML = (data.ok
            ? `<span class="text-emerald-400 font-bold"><i class="fa-solid fa-circle-check mr-1"></i>${escapeAttr(data.message)}</span>`
            : `<span class="text-amber-400 font-bold"><i class="fa-solid fa-triangle-exclamation mr-1"></i>${escapeAttr(data.message)}</span>`)
            + (data.service_account ? `<br><span class="text-gray-500">Service account: ${escapeAttr(data.service_account)}</span>` : '');
    } catch (err) {
        out.innerHTML = `<span class="text-red-400">${escapeAttr(err.message)}</span>`;
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
    }
};

window.testSeoConnection = async function() {
    const out = document.getElementById('seo-connection-result');
    const btn = document.getElementById('btn-test-seo-connection');
    if (!out || !btn) return;

    // The saved name, not the typed one: the lookup is by exact clients.name, and a
    // rename that hasn't been saved yet doesn't exist in the database to be found.
    const clientName = document.getElementById('edit-client-original-name').value;
    const property = document.getElementById('edit-client-gsc-property').value.trim();

    if (!property) {
        out.innerHTML = '<span class="text-gray-500">Enter a Search Console property first.</span>';
        return;
    }

    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Checking...';
    btn.disabled = true;
    out.innerHTML = '';

    try {
        // The user's own session token, not the anon key: this mode spends Google quota
        // and reveals which properties our service account can read, so the function
        // requires a real signed-in admin rather than anyone holding the public key.
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (!session?.access_token) throw new Error('Your session has expired — sign in again.');

        const res = await fetch(SEO_FN, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ mode: 'check', client: clientName, property })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || `the sync service returned ${res.status}`);

        let html = data.ok
            ? `<span class="text-emerald-400 font-bold"><i class="fa-solid fa-circle-check mr-1"></i>${escapeAttr(data.message)}</span>`
            : `<span class="text-amber-400 font-bold"><i class="fa-solid fa-triangle-exclamation mr-1"></i>${escapeAttr(data.message)}</span>`;

        // A near-miss is the common case — trailing slash, http vs https, or a
        // URL-prefix property typed where the account holds a domain one. Offering the
        // exact string as a button beats asking someone to spot the difference by eye.
        if (data.suggestion) {
            // escapeHTML, not escapeAttr, and only here: this value lands inside a JS
            // string literal within an onclick, which is the one place escapeHTML is
            // the correct escaper. escapeAttr's &#39; would be read back literally.
            html += `<br><button type="button" class="mt-1 text-blue-400 hover:text-blue-300 font-bold" onclick="document.getElementById('edit-client-gsc-property').value='${escapeHTML(data.suggestion)}'; testSeoConnection();">Use &quot;${escapeAttr(data.suggestion)}&quot;</button>`;
        }
        if (data.service_account) {
            html += `<br><span class="text-gray-500">Service account: ${escapeAttr(data.service_account)}</span>`;
        }
        if (Array.isArray(data.available) && data.available.length) {
            html += `<br><span class="text-gray-500">Readable properties: ${data.available.map(s => escapeAttr(s)).join(', ')}</span>`;
        }
        out.innerHTML = html;
    } catch (err) {
        out.innerHTML = `<span class="text-red-400">${escapeAttr(err.message)}</span>`;
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
    }
};

// Same shape as testSeoConnection above, against the SE Ranking sync instead. Reads the
// project id currently in the box, not the saved one, for the same reason: a correct old
// value would pass while a freshly-typed typo sat there unsaved.
const SERANKING_FN = 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/seranking-sync';

window.testSeRankingConnection = async function() {
    const out = document.getElementById('seranking-connection-result');
    const btn = document.getElementById('btn-test-seranking-connection');
    if (!out || !btn) return;

    const clientName = document.getElementById('edit-client-original-name').value;
    const siteId = parseInt(document.getElementById('edit-client-seranking-site').value, 10);

    if (!siteId) {
        out.innerHTML = '<span class="text-gray-500">Enter an SE Ranking project id first.</span>';
        return;
    }

    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Checking...';
    btn.disabled = true;
    out.innerHTML = '';

    try {
        // This mode spends an SE Ranking API call and reveals the project's own search
        // engine list, so it requires a real signed-in admin, same rule as Test Search
        // Console — the anon key alone doesn't get to trigger this.
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (!session?.access_token) throw new Error('Your session has expired — sign in again.');

        // The check reads the client's SAVED seranking_site_id, unlike Test Search
        // Console — SE Ranking has no near-miss string to correct, just a numeric id
        // that either belongs to a real project or doesn't, so there's nothing gained by
        // testing an unsaved value the way a typo-prone property string benefits from.
        // Save first if the field doesn't match what's on record yet.
        const res = await fetch(SERANKING_FN, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ mode: 'check', client: clientName })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || `the sync service returned ${res.status}`);

        out.innerHTML = data.ok
            ? `<span class="text-emerald-400 font-bold"><i class="fa-solid fa-circle-check mr-1"></i>${escapeAttr(data.message)}</span>`
            : `<span class="text-amber-400 font-bold"><i class="fa-solid fa-triangle-exclamation mr-1"></i>${escapeAttr(data.message)}</span>`;
    } catch (err) {
        out.innerHTML = `<span class="text-red-400">${escapeAttr(err.message)}</span>`;
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
    }
};

// ---- Check-in contacts editor ----
// One row per person who should receive the weekly text. Stored in client_contacts
// rather than on the client, since several reps can report for one business.
window.renderContactRows = function(clientName) {
    const list = document.getElementById('edit-client-contacts-list');
    if (!list) return;
    const want = normalize(clientName);
    const rows = globalContactsData.filter(c => normalize(c.client_name) === want);
    list.innerHTML = '';
    if (rows.length === 0) { addContactRow(); return; }
    rows.forEach(r => addContactRow(r));
};

window.addContactRow = function(contact) {
    const list = document.getElementById('edit-client-contacts-list');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'contact-row flex gap-2 items-start';
    row.dataset.contactId = contact?.id || '';
    row.innerHTML = `
        <input type="text" class="glass-input !py-1.5 contact-name" placeholder="Name" value="${escapeAttr(stripSlashEscapes(contact?.contact_name))}">
        <input type="text" class="glass-input !py-1.5 contact-phone" placeholder="(555) 010-9999" value="${escapeAttr(stripSlashEscapes(contact?.phone))}">
        <input type="text" class="glass-input !py-1.5 !w-28 contact-title" placeholder="Role" value="${escapeAttr(stripSlashEscapes(contact?.title))}">
        <button type="button" onclick="this.closest('.contact-row').remove()" class="text-red-500/60 hover:text-red-400 px-2 py-1.5" title="Remove">
            <i class="fa-solid fa-xmark"></i>
        </button>`;
    list.appendChild(row);
};

// Reconcile the edited list against what's stored: delete rows the admin removed,
// upsert the rest. Keyed on phone, which is also what the inbound webhook matches on.
async function saveClientContacts(clientName) {
    const rows = [...document.querySelectorAll('#edit-client-contacts-list .contact-row')];

    const entered = rows.map(r => ({
        id: r.dataset.contactId || null,
        contact_name: r.querySelector('.contact-name').value.trim() || null,
        phone: normalizePhone(r.querySelector('.contact-phone').value),
        title: r.querySelector('.contact-title').value.trim() || null
    })).filter(c => c.phone);

    const phones = entered.map(c => c.phone);
    const dupes = phones.filter((p, i) => phones.indexOf(p) !== i);
    if (dupes.length) throw new Error(`The same number is listed twice: ${dupes[0]}`);

    const want = normalize(clientName);
    const existing = globalContactsData.filter(c => normalize(c.client_name) === want);

    const keptIds = new Set(entered.map(c => c.id).filter(Boolean));
    const removed = existing.filter(c => !keptIds.has(c.id));
    if (removed.length) {
        const { error } = await supabaseClient.from('client_contacts').delete().in('id', removed.map(c => c.id));
        if (error) throw error;
    }

    if (entered.length) {
        const payload = entered.map(c => ({
            ...(c.id ? { id: c.id } : {}),
            client_name: clientName,
            contact_name: c.contact_name,
            phone: c.phone,
            title: c.title,
            active: true
        }));
        const { error } = await supabaseClient.from('client_contacts').upsert(payload, { onConflict: 'phone' });
        if (error) throw error;
    }
}

window.saveClientEdits = async function(e) {
    e.preventDefault();
    if (currentUserRole !== 'admin') return;

    const btn = document.getElementById('btn-save-client-edits');
    const id = document.getElementById('edit-client-id').value;
    const originalName = document.getElementById('edit-client-original-name').value;
    const newName = document.getElementById('edit-client-name').value.trim();

    // Optional: the id usually arrives during onboarding, after the client grants access
    const adAccountId = normalizeAccountId(document.getElementById('edit-client-ad-account').value);
    if (!newName) { alert("Business name can't be empty."); return; }

    const renaming = normalize(newName) !== normalize(originalName) || newName !== originalName;
    if (renaming && !confirm(`Rename "${originalName}" to "${newName}"?\n\nTheir tasks, health record, check-ins, reports and team access will all be moved across.`)) return;

    const servicePlan = planClientServiceChanges(originalName, 'edit-client-services');
    if (servicePlan.end.length && !confirm(`End ${servicePlan.end.map(serviceName).join(', ')} for ${newName}?\n\nIts onboarding steps stop applying. Their history and completed steps are kept.`)) return;

    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...';
    btn.disabled = true;

    try {
        // The rename runs first and atomically: clients.name is the join key for about
        // ten other tables, so doing it as separate browser updates risks a half-applied
        // rename that orphans a client's history with no way to tell what moved.
        if (renaming) {
            const { error: rpcErr } = await supabaseClient.rpc('rename_client', {
                old_name: originalName,
                new_name: newName
            });
            if (rpcErr) {
                throw new Error(
                    rpcErr.message.includes('function')
                        ? "Renaming needs the rename_client database function, which isn't installed yet. Other edits weren't saved — change the name back and save again, or install the function first."
                        : rpcErr.message
                );
            }
        }

        const payload = {
            name: newName,
            contact_name: document.getElementById('edit-client-contact-name').value.trim() || null,
            industry: document.getElementById('edit-client-industry').value.trim() || null,
            client_email: document.getElementById('edit-client-email').value.trim() || null,
            website_status: document.getElementById('edit-client-website-status').value || null,
            ad_account_id: adAccountId || null,
            business_id: document.getElementById('edit-client-business-id').value.trim() || null,
            contract_type: document.getElementById('edit-client-contract').value,
            monthly_retainer: document.getElementById('edit-client-retainer').value || null,

            // Stored verbatim, deliberately not normalized: Search Console treats
            // 'https://example.com/' and 'https://example.com' as different properties
            // and a domain property is 'sc-domain:example.com'. "Helpfully" tidying a
            // trailing slash away here would silently break the pull. Test connection
            // is what catches a wrong one, and it names the close match.
            gsc_property: document.getElementById('edit-client-gsc-property').value.trim() || null,
            // These two are numeric ids that get pasted out of URLs, so strip anything
            // that isn't a digit — same treatment the Meta ad account id gets.
            ga4_property_id: document.getElementById('edit-client-ga4-property').value.replace(/\D/g, '') || null,
            gbp_location_id: document.getElementById('edit-client-gbp-location').value.replace(/\D/g, '') || null,
            // GHL ids are alphanumeric, so this one is trimmed only.
            ghl_location_id: document.getElementById('edit-client-ghl-location').value.trim() || null,
            // SE Ranking's project id is purely numeric — parseInt over Number so a stray
            // trailing character (a pasted URL fragment) doesn't turn the whole value NaN.
            seranking_site_id: parseInt(document.getElementById('edit-client-seranking-site').value, 10) || null,
            // SE Ranking Local Marketing location (Business Profile data); column from supabase/sql/gbp.sql
            seranking_local_id: parseInt(document.getElementById('edit-client-seranking-local').value.replace(/\D/g, ''), 10) || null,
            seo_start_date: document.getElementById('edit-client-seo-start').value || null,
            // Blank means no fee on record, which hides the return-per-dollar figure. 0 is a real value.
            seo_monthly_fee: (() => { const v = document.getElementById('edit-client-seo-fee').value.trim(); return v === '' || !isFinite(Number(v)) || Number(v) < 0 ? null : Number(v); })()
        };

        let { error } = await supabaseClient.from('clients').update(payload).eq('id', id);
        if (error && /seranking_local_id/.test(`${error.message || ''} ${error.details || ''}`)) {
            console.warn('clients.seranking_local_id missing: run supabase/sql/gbp.sql. Saved without it.', error);
            delete payload.seranking_local_id;
            ({ error } = await supabaseClient.from('clients').update(payload).eq('id', id));
        }
        // Before supabase/sql/seo_client_tab.sql has run, the two SEO columns don't exist, and
        // PostgREST rejects the whole update. Save everything else rather than block every client edit.
        if (error && /seo_start_date|seo_monthly_fee/.test(`${error.message || ''} ${error.details || ''}`)) {
            console.warn('clients.seo_start_date / seo_monthly_fee missing: run seo_client_tab.sql. Saved without them.', error);
            const { seo_start_date, seo_monthly_fee, ...rest } = payload;
            ({ error } = await supabaseClient.from('clients').update(rest).eq('id', id));
        }
        if (error) throw error;

        // After the rename, so contacts and add-ons are filed under the client's current name.
        // rename_client() has already moved client_services, so the old rows sit under newName.
        await saveClientContacts(newName);
        await applyClientServiceChanges(newName, servicePlan);

        document.getElementById('edit-client-modal').style.display = 'none';

        // Follow the client if they were renamed, so the page doesn't go blank
        if (renaming) cSelectedAccount = newName;

        await fetchAllGlobalData(globalAllowedClients);
        initClientsPage();
        if (!document.getElementById('page-goldeneye').classList.contains('hidden')) renderGoldenEye();
    } catch (err) {
        alert("Could not save changes: " + err.message);
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
    }
};

// ================= CLIENT PORTAL PREVIEW =================
// Lets an admin see a client's portal exactly as that client does, without logging
// out or opening an incognito window. Read-only in spirit: it reuses the real portal
// code path, so anything submitted here would save for real — it's for looking, not
// for entering data on a client's behalf.
// Preview mode was only ever inferred from the banner's display style, so nothing that
// writes could tell it was looking at someone else's portal. Watching an onboarding video
// while previewing recorded watch progress against the client, and an auto-completing
// step would have ticked itself off on their behalf.
window.isClientPreview = false;

// Guards any write that would be attributed to the client. Returns true when blocked.
window.previewBlocksWrite = function(what) {
    if (!window.isClientPreview) return false;
    alert("You're previewing this client's portal, so " + what + " is disabled — it would be recorded as though they did it.");
    return true;
};

window.previewAsClient = async function() {
    if (currentUserRole !== 'admin') return;
    if (cSelectedAccount === "ALL") { alert("Pick a specific client first."); return; }
    window.isClientPreview = true;

    const btn = document.getElementById('btn-preview-client');
    const originalHTML = btn ? btn.innerHTML : '';
    if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Loading...'; btn.disabled = true; }

    try {
        document.getElementById('admin-dashboard-container').classList.add('hidden');
        document.getElementById('client-portal-container').classList.remove('hidden');

        // Toggled via style.display, not the `hidden` class — the banner carries inline
        // styles and an inline display would override the class either way.
        document.getElementById('client-preview-name').innerText = cSelectedAccount;
        document.getElementById('client-preview-banner').style.display = 'flex';
        // Push the portal clear of the fixed banner
        document.getElementById('client-portal-container').style.paddingTop = '64px';

        await initClientPortal([cSelectedAccount]);
        window.scrollTo(0, 0);
    } catch (err) {
        alert("Could not open client preview: " + err.message);
        exitClientPreview();
    } finally {
        if (btn) { btn.innerHTML = originalHTML; btn.disabled = false; }
    }
};

window.exitClientPreview = async function() {
    window.isClientPreview = false;
    // Leaving the portal doesn't go through switchCpTab, so stop the poll explicitly
    if (typeof stopOnboardingPoll === 'function') stopOnboardingPoll();
    document.getElementById('client-preview-banner').style.display = 'none';
    document.getElementById('client-portal-container').classList.add('hidden');
    document.getElementById('client-portal-container').style.paddingTop = '';
    document.getElementById('admin-dashboard-container').classList.remove('hidden');

    // initClientPortal overwrites shared globals (globalTasksData, globalSeoData and
    // friends) with client-scoped data, so the admin view has to be rehydrated rather
    // than just revealed again.
    await fetchAllGlobalData(globalAllowedClients);
    if (typeof initClientsPage === 'function') initClientsPage();
    if (!document.getElementById('page-goldeneye').classList.contains('hidden') && typeof renderGoldenEye === 'function') renderGoldenEye();
    window.scrollTo(0, 0);
};

// Pause / resume a client. Paused clients are skipped by the Make.com morning pull
// (it filters on status = 'active') and drop out of MRR, health and AI rollups, but
// stay selectable so their history remains viewable.
window.toggleClientPause = async function() {
    if (currentUserRole !== 'admin') return;

    const btn = document.getElementById('btn-toggle-pause');
    const clientObj = globalClientsData.find(c => normalize(c.name) === normalize(cSelectedAccount));
    if (!clientObj) { alert("Could not find that client record."); return; }

    const paused = !isActiveClient(clientObj);
    const nextStatus = paused ? 'active' : 'paused';

    const msg = paused
        ? `Resume ${clientObj.name}? Their ad data will start pulling again tomorrow morning and they will count toward MRR and health scores.`
        : `Pause ${clientObj.name}? The morning data pull will skip them and they will drop out of MRR and health totals. Existing history stays viewable.`;
    if (!confirm(msg)) return;

    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...';
    btn.disabled = true;

    try {
        const { error } = await supabaseClient
            .from('clients')
            .update({ status: nextStatus })
            .eq('id', clientObj.id);

        if (error) throw error;

        clientObj.status = nextStatus;
        initClientsPage();   // refresh picker badges
        filterAdsData();     // refresh rollups and the button's own label
        if (!document.getElementById('page-goldeneye').classList.contains('hidden')) renderGoldenEye();
    } catch (err) {
        alert("Error updating client status: " + err.message);
        btn.innerHTML = originalHTML;
    } finally {
        btn.disabled = false;
    }
};

// Archive (offboard) or restore a client. Archived clients are hidden from the
// picker unless "show archived" is on, excluded from every rollup and from the
// anonymized leaderboard, and skipped by the Make.com morning pull. Their history
// is never deleted — restoring brings it straight back.
window.toggleClientArchive = async function() {
    if (currentUserRole !== 'admin') return;

    const btn = document.getElementById('btn-toggle-archive');
    const clientObj = globalClientsData.find(c => normalize(c.name) === normalize(cSelectedAccount));
    if (!clientObj) { alert("Could not find that client record."); return; }

    const archived = !isSelectableClient(clientObj);
    // Restore lands on 'paused' rather than 'active' so a returning client doesn't
    // silently start pulling ad spend again before you've checked their setup.
    const nextStatus = archived ? 'paused' : 'archived';

    const msg = archived
        ? `Restore ${clientObj.name}? They'll come back as Paused, so you can review their setup before resuming the data pull.`
        : `Archive ${clientObj.name}? They'll be hidden from the client list, removed from all totals and the client leaderboard, and skipped by the morning pull.\n\nNothing is deleted — you can restore them anytime via "Show archived" in the client dropdown.`;
    if (!confirm(msg)) return;

    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...';
    btn.disabled = true;

    try {
        const { error } = await supabaseClient
            .from('clients')
            .update({ status: nextStatus })
            .eq('id', clientObj.id);

        if (error) throw error;

        clientObj.status = nextStatus;

        // Jump back to the aggregate view when archiving, since the client just
        // left the picker and would otherwise stay selected but hidden.
        if (nextStatus === 'archived' && !showArchivedClients) {
            cSelectedAccount = "ALL";
            document.getElementById('c-account-label').innerText = "All Accounts";
        }

        initClientsPage();
        if (!document.getElementById('page-goldeneye').classList.contains('hidden')) renderGoldenEye();
    } catch (err) {
        alert("Error updating client status: " + err.message);
        btn.innerHTML = originalHTML;
    } finally {
        btn.disabled = false;
    }
};

window.executeStageTransition = async function() {
    const btn = document.getElementById('btn-confirm-transition');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Executing...';
    btn.disabled = true;

    const clientObj = globalClientsData.find(c => normalize(c.name) === normalize(cSelectedAccount));
    const targetStage = document.getElementById('trans-target-stage').value;
    const generateTasks = document.getElementById('trans-generate-tasks').checked;

    try {
        // 1. Update the client's current_stage in Supabase
        const { error } = await supabaseClient
            .from('clients')
            .update({ current_stage: targetStage })
            .eq('id', clientObj.id);

        if (error) throw error;

        // 2. Update local memory
        clientObj.current_stage = targetStage;

        // 3. Trigger UI Refresh
        const transitionBtn = document.getElementById('btn-stage-transition');
        const chip = document.getElementById("c-stage-chip"); if(chip) chip.innerText = targetStage;
        
        // 4. Conditional Generation — from the stage's checklist template
        if (generateTasks) {
            const created = await generateStageTasks(clientObj.name, targetStage);
            console.log(`[LIFECYCLE ENGINE] ${clientObj.name} → ${targetStage}: created ${created} task(s).`);
        } else {
            console.log(`[LIFECYCLE ENGINE] Client moved to ${targetStage}. Skipping checklist generation.`);
        }

        // Close modal
        document.getElementById('stage-transition-modal').style.display = 'none';

    } catch (err) {
        alert("Error transitioning stage: " + err.message);
    } finally {
        btn.innerHTML = 'Confirm Move';
        btn.disabled = false;
    }
};

// ============================================================================
// CLIENT CREATION ENGINE
// ============================================================================
window.openAddClientModal = function() {
    const modal = document.getElementById('add-client-modal');
    
    // THE FIX: Pull the add client modal out of the hidden folder into the visible wrapper
    if (modal.parentElement.id !== 'theme-wrapper') {
        document.getElementById('theme-wrapper').appendChild(modal);
    }

    document.getElementById('add-client-form').reset();
    renderClientServicePicker('new-client-services', null);
    modal.style.display = 'flex';
};

window.saveNewClient = async function(e) {
    e.preventDefault();
    const btn = document.getElementById('btn-save-new-client');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Creating...';
    btn.disabled = true;

    // Store the bare digits: Ads Manager shows ids as "act_123" or "123" and the
    // morning pull matches on the numeric form. Optional at creation — you normally
    // don't have it until the client grants access partway through onboarding.
    const adAccountId = normalizeAccountId(document.getElementById('new-client-ad-account').value);
    const businessId = document.getElementById('new-client-business-id').value.trim();

    // Check-in contacts live in client_contacts and are added via Edit after creation,
    // since a client can have several people reporting.
    const payload = {
        name: document.getElementById('new-client-name').value.trim(),
        contact_name: document.getElementById('new-client-contact-name').value.trim() || null,
        industry: document.getElementById('new-client-industry').value.trim() || null,
        client_email: document.getElementById('new-client-email').value.trim(),
        ad_account_id: adAccountId || null,
        business_id: businessId || null,
        contract_type: document.getElementById('new-client-contract').value,
        monthly_retainer: document.getElementById('new-client-retainer').value,
        contract_start_date: new Date().toISOString().split('T')[0],
        website_status: document.getElementById('new-client-website-status').value || null,
        current_stage: 'Onboarding',
        status: 'active'
    };

    try {
        const { data, error } = await supabaseClient.from('clients').insert([payload]).select();
        if (error) throw error;

        // Add to local cache and refresh UI
        if(data && data.length > 0) globalClientsData.push(data[0]);

        // The client exists either way; a failure here is reported, not thrown, so it
        // can't read as "client not created" and invite a duplicate.
        let servicesNote = '';
        try {
            await applyClientServiceChanges(payload.name, planClientServiceChanges(null, 'new-client-services'));
        } catch (err) {
            console.error('Could not save add-ons:', err);
            servicesNote = `\n\nTheir add-ons didn't save (${err.message}). Tick them again under Edit.`;
        }

        document.getElementById('add-client-modal').style.display = 'none';
        
        // Auto-switch to the new client
        if(typeof cSelectAccount === 'function') cSelectAccount(payload.name, payload.name);
        
        // The agency checklist is deliberately not generated here. Our work starts when
        // the client has finished theirs, so it's raised on completion instead — see
        // raiseOnboardingAgencyTasks. Creating it now would fill the board with tasks
        // nobody can action for a client who may not log in for a week.
        // Granted here rather than left to the Invite button. A client you've just created
        // and whose email you've just typed always needs portal access — making that a
        // separate step only creates a way to forget it.
        let invited = [];
        try {
            invited = await grantPortalAccessToAll(payload.client_email, payload.name);
        } catch (err) {
            console.error('Could not grant portal access:', err);
        }

        alert((invited.length
            ? `Client created. ${invited.join(', ')} can sign in now — your onboarding tasks appear once they've finished their steps.`
            : "Client created, but portal access couldn't be granted — use Invite to Portal on their page.") + servicesNote);
        
        // Force refresh internal dataset so the tasks render cleanly without reloading
        await fetchAllGlobalData(globalAllowedClients);
        if(!document.getElementById('page-tasks').classList.contains('hidden')) initTasksPage();
        if(!document.getElementById('page-clients').classList.contains('hidden')) filterAdsData();

    } catch (err) {
        alert("Error creating client: " + err.message);
    } finally {
        btn.innerHTML = 'Create Client Profile';
        btn.disabled = false;
    }
};


