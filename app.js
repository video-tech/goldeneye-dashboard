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
                        needsReview: false,
                        contributors: []
                    });
                }
                const w = byWeek.get(wk);

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
                        if (currentUserRole === 'admin') document.getElementById('admin-only-nav').classList.remove('hidden');
                        
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
                supabaseClient.from('clients').select('name, client_email').in('name', allowedClients),
                supabaseClient.from('weekly_reports').select('*').order('created_at', { ascending: false })
            ]);

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
                const done = onboardingIsComplete(currentActiveClient);
                switchCpTab(done ? 'dashboard' : 'getstarted');

                // Paint the tab's dot even when they land elsewhere, then ask. Onboarding
                // comes first — a client still working through it doesn't need a second
                // thing shouting at them.
                renderWeeklyCheckin();
                if (done) maybeShowWeeklyCheckin();
            }, 50);
        }

        function switchCpTab(tabName) {
    ['getstarted', 'knowledge', 'dashboard', 'reports', 'checkin', 'pipeline', 'creatives', 'settings', 'seo', 'leaderboard'].forEach(t => {
        const el = document.getElementById(`cp-view-${t}`);
        const btn = document.getElementById(`cp-tab-${t}`);
        if(el) el.classList.add('hidden');
        if(btn) btn.className = 'pb-3 text-sm font-bold text-gray-500 border-b-2 border-transparent hover:text-gray-300 transition';
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
    if(tabName === 'checkin') renderWeeklyCheckin();
    if(tabName === 'reports') renderCpReports();
    if(tabName === 'pipeline') renderCpPipeline();
    if(tabName === 'creatives') renderClientCreatives();
    if(tabName === 'settings') renderCpSettings();
    if(tabName === 'seo') renderCpSeo();
    if(tabName === 'leaderboard') renderAnonymizedLeaderboard();
    if(tabName === 'knowledge') renderKnowledgeBase();
}

// ================= CLIENT ONBOARDING (Get Started) =================
// Progress lives in Supabase, not localStorage, so it survives a device change and
// the agency can see where a client actually is.

function onboardingProgressFor(clientName, stepId) {
    const want = normalize(clientName);
    return globalOnboardingProgress.find(p => normalize(p.client_name) === want && p.step_id === stepId) || null;
}

// Every onboarding item, both sides, in order — for the admin's unified view.
function allOnboardingItems() {
    return globalOnboardingSteps
        .filter(s => s.active !== false)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}

// Just the client's own steps — what the portal shows and what its progress measures.
// Agency items are tasks and don't belong in the client's checklist.
function activeOnboardingSteps() {
    return allOnboardingItems().filter(s => s.owner !== 'agency');
}

function onboardingIsComplete(clientName) {
    const steps = activeOnboardingSteps();
    if (!steps.length) return true;
    return steps.every(s => onboardingProgressFor(clientName, s.id)?.completed_at);
}

// A Loom share link can't report watch progress, so self-hosted MP4s are the norm here.
// Kept tolerant of either: anything that isn't a direct video file renders as an iframe.
const isDirectVideo = url => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url || '');

// Pre-fill the client's email into an embedded form. Three separate forms means three
// chances to type a different address — and GHL keys contacts on email, so a mismatch
// silently splits their answers across two contact records. It also keeps the webhook's
// client lookup reliable, since the address always matches the one on file.
function prefillFormUrl(url) {
    if (!url) return url;

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

window.renderGetStarted = function() {
    const list = document.getElementById('ob-steps-list');
    if (!list) return;

    const steps = activeOnboardingSteps();
    const client = currentActiveClient;
    const done = steps.filter(s => onboardingProgressFor(client, s.id)?.completed_at).length;

    const label = document.getElementById('ob-progress-label');
    const bar = document.getElementById('ob-progress-bar');
    if (label) label.innerText = `${done} of ${steps.length} complete`;
    if (bar) bar.style.width = steps.length ? `${Math.round((done / steps.length) * 100)}%` : '0%';

    const allDone = document.getElementById('ob-all-done');
    if (allDone) allDone.classList.toggle('hidden', !(steps.length && done === steps.length));

    let firstOpen = true;
    list.innerHTML = '';

    steps.forEach((s, i) => {
        const prog = onboardingProgressFor(client, s.id);
        const complete = !!prog?.completed_at;
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

            if (s.step_type === 'form' && s.embed_url) {
                inner += `<div class="w-full rounded-lg overflow-hidden border border-white/10 mb-4 bg-white" style="height:70vh">
                              <iframe src="${escapeAttr(prefillFormUrl(stripSlashEscapes(s.embed_url)))}" class="w-full h-full" frameborder="0"></iframe>
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
                                || (s.step_type === 'form' && !s.requires_confirm);

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

// Restore playback position so a client returning mid-video isn't sent back to zero
window.obVideoReady = function(stepId) {
    const v = document.getElementById('ob-vid-' + stepId);
    const prog = onboardingProgressFor(currentActiveClient, stepId);
    if (!v || !prog?.watch_percent || prog.completed_at) return;
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
async function raiseOnboardingAgencyTasks(clientName) {
    try {
        const made = await generateStageTasks(clientName, 'Onboarding');
        if (made) console.log(`[LIFECYCLE ENGINE] ${clientName}: ${made} onboarding task(s) raised.`);
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

    const steps = activeOnboardingSteps();
    if (!steps.length || !onboardingIsComplete(client)) return;

    // Worked or not, an existing copy means this already announced itself
    if (onboardingHandoffRaised(client)) { obCompletionRaised.add(key); return; }

    // Claimed before the await so the 2s form poll can't file a second one behind this
    obCompletionRaised.add(key);

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
    return activeOnboardingSteps().some(s =>
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
    const steps = activeOnboardingSteps();
    // Stays reachable after completion. The videos explain things people forget — how
    // Meta bills, what they agreed to on the forms — and hiding the tab meant the only
    // way back was asking us. First login still lands them here; a finished client just
    // isn't sent here, and sees the done panel if they come looking.
    const show = steps.length > 0;
    tab.classList.toggle('hidden', !show);

    // Hiding the button while its content is still on screen left the client stranded on
    // a view they could no longer navigate back to. They keep the finished panel — with
    // its own way out — and only get moved on once they've reloaded or moved off it.
    const view = document.getElementById('cp-view-getstarted');
    if (!show && view && !view.classList.contains('hidden') && !steps.length) {
        switchCpTab('dashboard');
    }
};

// The Knowledge Base is the same videos as the onboarding sequence, but as a permanent
// library: no completion state, always available to rewatch. Replaces two hardcoded
// cards whose watch status lived in localStorage under the admin's selected client.
window.renderKnowledgeBase = function() {
    const grid = document.getElementById('kb-video-grid');
    if (!grid) return;

    const videos = activeOnboardingSteps().filter(s => s.step_type === 'video' && s.embed_url);
    if (!videos.length) {
        grid.innerHTML = '<p class="text-sm text-gray-500 italic md:col-span-2">No walkthrough videos yet.</p>';
        return;
    }

    grid.innerHTML = videos.map(s => {
        const player = isDirectVideo(s.embed_url)
            ? `<video controls playsinline class="w-full h-full outline-none"><source src="${escapeAttr(stripSlashEscapes(s.embed_url))}"></video>`
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

function weeklyCheckinFormHtml(suffix) {
    const existing = portalCheckinFor(currentActiveClient, reportingWeekStart());
    const v = f => existing?.[f] ?? '';

    return `
        <div class="space-y-4">
            <div>
                <label class="modal-label">Estimates given</label>
                <input type="number" min="0" step="1" id="wc-estimates-${suffix}" class="glass-input" placeholder="0" value="${escapeAttr(v('estimates_count'))}">
            </div>
            <div>
                <label class="modal-label">Jobs closed</label>
                <input type="number" min="0" step="1" id="wc-closes-${suffix}" class="glass-input" placeholder="0" value="${escapeAttr(v('closes_count'))}">
            </div>
            <div>
                <label class="modal-label">Revenue closed</label>
                <input type="number" min="0" step="0.01" id="wc-revenue-${suffix}" class="glass-input" placeholder="0" value="${escapeAttr(v('revenue_total'))}">
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
    if (mount) mount.innerHTML = weeklyCheckinFormHtml('tab');

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
                <span class="text-gray-500">Ad-attributed ${cell(anyIndirect, indirect)}</span>
            </div>
            ${breakdown}
        </div>`;
    }).join('');
};

window.submitWeeklyCheckin = async function(suffix) {
    const btn = document.getElementById(`wc-submit-${suffix}`);
    const err = document.getElementById(`wc-error-${suffix}`);
    const num = id => {
        const raw = document.getElementById(`wc-${id}-${suffix}`).value.trim();
        return raw === '' ? null : Number(raw);
    };

    const row = {
        estimates_count: num('estimates'),
        closes_count: num('closes'),
        revenue_total: num('revenue'),
        indirect_leads: num('indirect')
    };

    const show = msg => { if (err) { err.innerText = msg; err.classList.remove('hidden'); } };
    if (err) err.classList.add('hidden');

    if (Object.values(row).every(v => v === null)) {
        show('Put a number in at least one box — a zero week is fine, just enter 0.');
        return;
    }
    if (Object.values(row).some(v => v !== null && (!isFinite(v) || v < 0))) {
        show('Those need to be positive numbers.');
        return;
    }

    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...';
    btn.disabled = true;

    try {
        const week = reportingWeekStart();
        const existing = portalCheckinFor(currentActiveClient, week);

        if (existing) {
            // Matched on the columns that identify it rather than an id, so this doesn't
            // care whether the table has one. contact_name is part of that identity now:
            // without it, one person's edit would overwrite a colleague's entry.
            const { error } = await supabaseClient.from('weekly_checkins').update(row)
                .eq('client_name', existing.client_name)
                .eq('week_start', week)
                .eq('source', 'portal')
                .eq('contact_name', existing.contact_name);
            if (error) throw error;
            Object.assign(existing, row);
        } else {
            const payload = {
                ...row,
                client_name: currentActiveClient,
                week_start: week,
                source: 'portal',
                contact_name: clientEmail || null,
                // Typed by the client rather than parsed out of a text, so it's exact
                parse_confidence: 'high'
            };
            const { data, error } = await supabaseClient.from('weekly_checkins').insert([payload]).select();
            if (error) throw error;
            if (data?.length) globalCheckinsData.push(...data);
        }

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
    if (mount) mount.innerHTML = weeklyCheckinFormHtml('modal');

    const m = document.getElementById('weekly-checkin-modal');
    if (m) m.style.display = 'flex';
};

        function portalSwitchClient(accountName) {
            currentActiveClient = accountName; document.getElementById('client-name-display').innerText = accountName.split(' ')[0];
            const normTarget = normalize(accountName);
            filteredReportData = reportsForClient(accountName, allRawReports);
            clientLeadsData = globalClientLeadsData.filter(l => normalize(l.client_name) === normTarget).map(l => ({ id: l.id, name: l.lead_name, stage: l.stage || 'New Lead', email: l.lead_email || '', phone: l.lead_phone || '' }));
            filterPortalData();
            if(!document.getElementById('cp-view-pipeline').classList.contains('hidden')) renderCpPipeline();
            if(!document.getElementById('cp-view-creatives').classList.contains('hidden')) renderClientCreatives();
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
            document.getElementById('ai-summary').innerText = "Click \"Run Analysis\" to generate an AI overview of this timeframe.";
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
            const clientTasks = globalTasksData.filter(t => normalize(t.client) === normalize(currentActiveClient) && t.status !== 'Complete');
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
            if (typeof renderPortalTasks === 'function') renderPortalTasks();
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

        async function triggerPortalAI() {
    const btn = document.getElementById('portal-run-ai-btn'); 
    const box = document.getElementById('ai-summary'); 
    const rangeText = document.getElementById('selected-date-label').innerText;
    
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...`; 
    btn.disabled = true; 
    box.innerText = "Generating insights...";
    
    const prompt = `Client: ${document.getElementById('client-name-display').innerText}. Range: ${rangeText}. Data: $${finalStats.spend.toFixed(2)} spent, ${finalStats.leads} leads. 2 sentences. No fluff. Reassuring growth context. No advice.`;
    
    try {
        const res = await fetch("https://hugnttsqucetldllfgoi.supabase.co/functions/v1/ai-chat", { 
            method: 'POST', 
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${wrapper.dataset.supaKey}` 
            }, 
            body: JSON.stringify({ 
                messages: [{ role: "user", content: prompt }] 
            }) 
        });
        
        const json = await res.json(); 
        if(json.error) throw new Error(json.error);
        
        box.innerText = json.choices[0].message.content;
        
    } catch(e) { 
        box.innerText = "Summary unavailable at this time."; 
        console.error("Secure API Error:", e.message);
    } finally { 
        btn.innerHTML = `<i class="fa-solid fa-bolt"></i> Run Analysis`; 
        btn.disabled = false; 
    }
} // <--- THIS IS THE BRACKET THAT WAS MISSING!

        function selectPresetDate(v, l) { selectedDateRange = v; document.getElementById('selected-date-label').innerText = l; toggleDropdown('portal-date-menu'); filterPortalData(); }
        function applyCustomRange() { customStart = document.getElementById('start-date').value; customEnd = document.getElementById('end-date').value; if(customStart && customEnd) { selectedDateRange = 'custom'; document.getElementById('selected-date-label').innerText = `${customStart} to ${customEnd}`; toggleDropdown('portal-date-menu'); filterPortalData(); } }
        
        function openInviteModal() { document.getElementById('invite-modal').style.display = 'flex'; }
        function closeInviteModal() { document.getElementById('invite-modal').style.display = 'none'; }
        async function submitClientInvite() {
            const btn = document.getElementById('submit-invite-btn'); const email = document.getElementById('input-invite-email').value.trim();
            if(!email) return alert("Please enter an email address"); btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            const { error } = await supabaseClient.from('pre_approved_users').upsert({ email: email, role: 'client', client_access: [currentActiveClient] });
            if (error) { alert("Error: " + error.message); } else { alert("Invite sent! They can now sign in with their email to view this dashboard."); closeInviteModal(); document.getElementById('input-invite-email').value = ''; }
            btn.disabled = false; btn.innerText = "Send Invite";
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

    if (allowedClients && currentUserRole !== 'admin') {
        clientsQ = clientsQ.in('name', allowedClients); healthQ = healthQ.in('client_name', allowedClients); tasksQ = tasksQ.in('client', allowedClients); crQ = crQ.in('client_name', allowedClients); seoQ = seoQ.in('client_name', allowedClients);
        checkinsQ = checkinsQ.in('client_name', allowedClients);
        contactsQ = contactsQ.in('client_name', allowedClients);
    }

    // 👇 2. ADD auditsQ TO THE END OF THIS ARRAY 👇
    const results = await Promise.allSettled([ clientsQ, healthQ, tasksQ, adsQ, crQ, seoQ, auditsQ, checkinsQ, contactsQ, stageTplQ, obStepsQ, obProgQ ]);

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

    // ... the rest of the function continues as normal ...

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
            if (currentUserRole === 'admin') {
                await reconcileOnboardingHandoffTasks();
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

        // --- GOLDEN EYE (DASHBOARD) RENDERING ---
        function renderGoldenEye() {
            // Check for a cached audit first thing!
            checkSavedAudit(); 

            const isLight = document.getElementById('theme-wrapper').classList.contains('light-mode'); Chart.defaults.color = isLight ? '#64748b' : 'rgba(255,255,255,0.6)';

            const activeClients = globalClientsData.filter(c => isActiveClient(c) && normalize(c.name) !== normalize('Midas Media'));
            const currentTotalMRR = activeClients.reduce((sum, c) => sum + parseFloat(c.monthly_retainer || 0), 0);
            document.getElementById('dash-mrr-total').innerText = '$' + currentTotalMRR.toLocaleString();
            
            const mrrLabels = activeClients.map(c => c.name); const mrrData = activeClients.map(c => c.monthly_retainer);
            if (dashMrrChartInstance) dashMrrChartInstance.destroy();
            dashMrrChartInstance = new Chart(document.getElementById('dashMrrChart').getContext('2d'), { type: 'bar', data: { labels: mrrLabels, datasets: [{ label: 'Retainer ($)', data: mrrData, backgroundColor: 'rgba(59, 130, 246, 0.8)', borderRadius: 4, hoverBackgroundColor: '#60a5fa' }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } } });

            const requestTasks = globalTasksData.filter(t => t.type === 'Client Request' && t.status !== 'Complete');
            const reqContainer = document.getElementById('dash-client-requests-container');
            if (requestTasks.length > 0) {
                let reqHtml = '';
                requestTasks.sort((a,b) => b.score - a.score).forEach(t => {
                    reqHtml += `<div class="bg-blue-500/10 border border-blue-500/20 px-3 py-2 rounded-lg flex justify-between items-center cursor-pointer hover:bg-blue-500/20 transition" onclick="navTo('tasks'); setTimeout(() => openTaskDrawer(${t.id}), 100)"><div class="truncate pr-2"><span class="text-xs font-bold text-white block truncate">${t.title}</span><span class="text-[10px] text-blue-300">${t.client}</span></div><span class="text-[10px] font-bold text-blue-400 uppercase bg-blue-500/10 px-2 py-0.5 rounded shrink-0">New Request</span></div>`;
                });
                document.getElementById('dash-client-requests').innerHTML = reqHtml;
                reqContainer.classList.remove('hidden');
            } else {
                reqContainer.classList.add('hidden');
                document.getElementById('dash-client-requests').innerHTML = '';
            }

            const todayDate = new Date(); const thirtyDaysFromNow = new Date(); thirtyDaysFromNow.setDate(todayDate.getDate() + 30);
            let churnHtml = ''; let churnCount = 0;
            
            activeClients.forEach(c => {
                let isHealthRisk = c.current_score > 0 && c.current_score < 40; let isExpiring = false; let daysLeft = null;
                if (c.contract_end_date) {
                    const diffDays = Math.ceil((new Date(c.contract_end_date + 'T12:00:00').getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24));
                    if (diffDays <= 30 && diffDays >= 0) { isExpiring = true; daysLeft = `${diffDays}d`; } else if (diffDays < 0) { isExpiring = true; daysLeft = `Expired`; }
                }
                if (isHealthRisk || isExpiring) {
                    churnCount++; let reason = [];
                    if (isHealthRisk) reason.push(`Health: ${c.current_score}`); if (isExpiring) reason.push(`Renews: ${daysLeft}`);
                    churnHtml += `<div class="bg-red-500/10 border border-red-500/20 px-3 py-2 rounded-lg flex justify-between items-center cursor-pointer hover:bg-red-500/20 transition" onclick="goToClient('${escapeHTML(c.name)}')"><span class="text-xs font-bold text-white truncate max-w-[120px]">${c.name}</span><span class="text-[10px] font-bold text-red-400 uppercase bg-red-500/10 px-2 py-0.5 rounded">${reason.join(' | ')}</span></div>`;
                }
            });

            const churnContainer = document.getElementById('dash-churn-flags-container');
            if (churnCount > 0) { document.getElementById('dash-churn-flags').innerHTML = churnHtml; churnContainer.classList.remove('hidden'); } else { churnContainer.classList.add('hidden'); document.getElementById('dash-churn-flags').innerHTML = ''; }

            const incompleteTasks = globalTasksData.filter(t => t.status !== 'Complete'); incompleteTasks.sort((a,b) => b.score - a.score);
            const topTasks = incompleteTasks.slice(0, 5); let tasksHtml = '';
            if(topTasks.length === 0) tasksHtml = '<p class="text-xs text-gray-500">No pending tasks.</p>';
            topTasks.forEach(t => {
                let pC = t.score>75?'#ef4444':(t.score>50?'#f59e0b':'#3b82f6');
                let dI='', dC='text-gray-500'; if(t.due){ const td=new Date().toISOString().split('T')[0]; if(t.due<td){ dI='<i class="fa-solid fa-circle-exclamation mr-1"></i>'; dC='text-red-400'; } else if(t.due===td){ dI='<i class="fa-solid fa-bell mr-1"></i>'; dC='text-yellow-400'; } }
                tasksHtml += `<div class="bg-black/20 p-3 rounded-xl border border-white/5 cursor-pointer hover:bg-white/5 transition" onclick="navTo('tasks')"><div class="flex justify-between items-start mb-1"><span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest bg-black/40 px-2 py-0.5 rounded truncate max-w-[120px] block" title="Open Dashboard">${t.client}</span><div class="flex items-center gap-1 bg-black/40 px-1.5 py-0.5 rounded text-[9px] font-bold"><div class="w-1.5 h-1.5 rounded-full" style="background:${pC};"></div>${t.score}</div></div><p class="text-xs font-bold text-white leading-tight">${t.title}</p></div>`;
            });
            document.getElementById('dash-urgent-tasks').innerHTML = tasksHtml;

	    // --- POPULATE HQ TASKS ---
            const hqTasks = globalTasksData.filter(t => normalize(t.client) === normalize('Midas Media') && t.status !== 'Complete');
            hqTasks.sort((a,b) => b.score - a.score);
            let hqHtml = '';
            if(hqTasks.length === 0) hqHtml = '<p class="text-xs text-gray-500 italic mt-2 text-center">All caught up!</p>';
            hqTasks.forEach(t => {
                let pC = t.score>75?'#ef4444':(t.score>50?'#f59e0b':'#3b82f6');
                let dI='', dC='text-gray-500'; if(t.due){ const td=new Date().toISOString().split('T')[0]; if(t.due<td){ dI='<i class="fa-solid fa-circle-exclamation mr-1"></i>'; dC='text-red-400'; } else if(t.due===td){ dI='<i class="fa-solid fa-bell mr-1"></i>'; dC='text-yellow-400'; } }
                hqHtml += `<div class="bg-black/20 p-3 rounded-xl border border-white/5 cursor-pointer hover:bg-white/5 transition" onclick="navTo('tasks'); setTimeout(() => openTaskDrawer(${t.id}), 100)"><div class="flex justify-between items-start mb-1"><span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest bg-black/40 px-2 py-0.5 rounded truncate block">${t.assignee || 'HQ Team'}</span><div class="flex items-center gap-1 bg-black/40 px-1.5 py-0.5 rounded text-[9px] font-bold"><div class="w-1.5 h-1.5 rounded-full" style="background:${pC};"></div>${t.score}</div></div><p class="text-xs font-bold text-white leading-tight">${t.title}</p></div>`;
            });
            document.getElementById('dash-internal-tasks').innerHTML = hqHtml;

            let totalScore = 0; let scoredClients = 0;
            activeClients.forEach(c => { if(c.current_score > 0) { totalScore += c.current_score; scoredClients++; } });
            const avgScore = scoredClients > 0 ? Math.round(totalScore / scoredClients) : 0;
            document.getElementById('dash-avg-health-val').innerText = avgScore || '--'; document.getElementById('dash-avg-health-lbl').innerText = avgScore > 0 ? 'Network Average' : 'No Data';
            
            let ac='#4ade80'; if(avgScore<70)ac='#facc15'; if(avgScore<40)ac='#ef4444'; if(avgScore===0)ac='#64748b';
            if (dashAvgHealthInstance) dashAvgHealthInstance.destroy();
            dashAvgHealthInstance = new Chart(document.getElementById('dashAvgHealthGauge').getContext('2d'), { type: 'doughnut', data: { datasets: [{ data: [avgScore, 100 - avgScore], backgroundColor: [ac, isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)'], borderWidth: 0 }] }, options: { cutout: '85%', rotation: 270, circumference: 180, plugins: { legend: { display: false }, tooltip: {enabled: false} } } });

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

        function renderKanban() {
            const searchEl = document.getElementById('task-search-filter'); const q = searchEl ? searchEl.value.toLowerCase() : '';
            let f = globalTasksData.filter(t => (t.title || "").toLowerCase().includes(q) || (t.client || "").toLowerCase().includes(q));
            const cols = { 'Not Started': document.getElementById('col-todo'), 'In Progress': document.getElementById('col-prog'), 'Blocked': document.getElementById('col-rev'), 'Complete': document.getElementById('col-done') };
            const counts = { 'Not Started': 0, 'In Progress': 0, 'Blocked': 0, 'Complete': 0 };
            Object.values(cols).forEach(el => { if(el) el.innerHTML = ''; }); f.sort((a,b) => b.score - a.score);

            f.forEach(t => {
                const s = t.status || 'Not Started'; if(!cols[s]) return; counts[s]++;
                let dI='', dCol='text-gray-500'; if(s!=='Complete'&&t.due){ const td=new Date().toISOString().split('T')[0]; if(t.due<td){ dI='<i class="fa-solid fa-circle-exclamation mr-1"></i>'; dCol='text-red-400'; } else if(t.due===td){ dI='<i class="fa-solid fa-bell mr-1"></i>'; dCol='text-yellow-400'; } }
                const cColor = t.score>75?'#ef4444':(t.score>50?'#f59e0b':'#3b82f6'); const init = t.assignee?t.assignee.substring(0,2).toUpperCase():'?';
                cols[s].innerHTML += `<div class="glass kanban-card p-4 transition border border-white/10 hover:border-blue-500/50" data-id="${t.id}" onclick="openTaskDrawer(${t.id})"><div class="flex justify-between items-start mb-2"><span onclick="goToClient('${escapeHTML(t.client)}'); event.stopPropagation();" class="cursor-pointer hover:text-blue-300 hover:underline text-[10px] font-bold text-gray-400 uppercase tracking-widest bg-black/20 px-2 py-0.5 rounded truncate max-w-[120px] block" title="Open Dashboard">${t.client || 'Unknown'}</span><span class="${dCol} text-[10px] font-bold whitespace-nowrap">${dI} ${t.due||'-'}</span></div><h4 class="font-bold text-white text-sm mb-4 leading-snug">${t.title || 'Untitled Task'}</h4><div class="flex justify-between items-center mt-auto"><div class="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold">${init}</div><div class="flex items-center gap-2 bg-black/20 px-2 py-1 rounded-lg"><div class="w-2 h-2 rounded-full" style="background:${cColor};"></div><span class="font-bold text-white text-[10px]">${t.score}</span></div></div></div>`;
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
            f.sort((a,b) => { let vA=a[currentTaskSort]||'', vB=b[currentTaskSort]||''; if(currentTaskSort==='score'){ if(taskPrioMode==='total'){vA=a.score;vB=b.score;} if(taskPrioMode==='dueDate'){vA=a.u;vB=b.u;} if(taskPrioMode==='et'){vA=a.e;vB=b.e;} } if(vA<vB) return taskSortDir==='asc'?-1:1; if(vA>vB) return taskSortDir==='asc'?1:-1; return 0; });

            const td = new Date().toISOString().split('T')[0]; let bH = ''; if(f.length===0) bH = `<tr><td colspan="10" class="p-8 text-center text-gray-500">No tasks.</td></tr>`;
            f.forEach(t => {
                let sC = "text-gray-400 border-gray-500"; if(t.status==='In Progress') sC="text-blue-400 border-blue-500 bg-blue-500/10"; if(t.status==='Complete') sC="text-green-400 border-green-500 bg-green-500/10"; if(t.status==='Blocked') sC="text-red-400 border-red-500 bg-red-500/10";
                let dI='', dC='text-gray-400'; if(t.status!=='Complete'&&t.due){ if(t.due<td){dI='<i class="fa-solid fa-circle-exclamation text-red-500 mr-1"></i>'; dC='text-red-400 font-bold';} else if(t.due===td){dI='<i class="fa-solid fa-bell text-yellow-500 mr-1"></i>'; dC='text-yellow-400 font-bold';} }
                let pC = t.score>75?'#ef4444':(t.score>50?'#f59e0b':'#3b82f6'); const chk = selectedTaskIds.has(t.id)?'checked':'';
                
                bH += `<tr class="hover:bg-white/5 transition border-b border-white/5 ${chk?'bg-blue-900/20':''}">
                    <td class="p-4"><input type="checkbox" class="row-checkbox" value="${t.id}" ${chk} onchange="toggleTaskRow(this, ${t.id})"></td>
                    <td class="p-4 font-bold text-white cursor-pointer hover:text-blue-400 transition" onclick="openTaskDrawer(${t.id})">${t.title || 'Untitled'}</td>
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
            const basePayload={ title:document.getElementById('t-title').value, stage:document.getElementById('t-stage').value, type:document.getElementById('t-type').value, assignee:document.getElementById('t-assignee').value, due:document.getElementById('t-due').value||null, status:document.getElementById('t-status').value, p:p, u:u, e:ev, score:Math.round(((p*0.4)+(u*0.4)+((6-ev)*0.2))*20), notes:document.getElementById('t-notes').value, updated_at:new Date().toISOString() }; 
            
            if(activeEditId) { basePayload.client = selectedClients[0]; await supabaseClient.from('tasks').update(basePayload).eq('id',activeEditId); } 
            else { const payloads = selectedClients.map(c => ({ ...basePayload, client: c })); await supabaseClient.from('tasks').insert(payloads); }
            
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
                if(btn) btn.className = 'pb-3 text-sm font-bold text-gray-500 border-b-2 border-transparent hover:text-gray-300 transition';
                if(el) el.classList.add('hidden');
            });

            const activeBtn = document.getElementById(`tab-btn-${view}`);
            const activeEl = document.getElementById(`c-view-${view}`);
            if(activeBtn) {
                let color = view === 'ads' ? 'yellow' : (view === 'health' ? 'green' : (view === 'chat' ? 'purple' : (view === 'reports' ? 'blue' : (view === 'payments' ? 'emerald' : 'gray'))));
                activeBtn.className = `pb-3 text-sm font-bold text-${color}-400 border-b-2 border-${color}-400 transition hover:text-${color}-300`;
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
                const savedKey = localStorage.getItem('midas_openai_key');
                if(savedKey) document.getElementById('openai-api-key').value = savedKey;
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
                } else {
                    document.getElementById('client-specific-tasks-box').classList.remove('hidden');
                    document.getElementById('ai-box-container').classList.remove('hidden');
                    const allClientsTable = document.getElementById('all-clients-ads-list');
                    if (allClientsTable) allClientsTable.classList.add('hidden');
                    
                    const tLbl = document.getElementById('c-task-client-name'); if(tLbl) tLbl.innerText = cSelectedAccount;
                    const aiLbl = document.getElementById('ai-client-lbl'); if (aiLbl) aiLbl.innerText = cSelectedAccount;
                    
                    // Update and unhide Admin Controls
                    const addClientBtn = document.getElementById('btn-add-client');
                    if (addClientBtn && currentUserRole === 'admin') addClientBtn.classList.remove('hidden');

                    // Update and unhide Stage Transition button
                    const transitionBtn = document.getElementById('btn-stage-transition');
                    if (transitionBtn && currentUserRole === 'admin') {
                        const clientObj = globalClientsData.find(c => normalize(c.name) === normalize(cSelectedAccount));
                        const currentStage = clientObj ? (clientObj.current_stage || 'Onboarding') : 'Onboarding';
                        transitionBtn.innerHTML = `<i class="fa-solid fa-arrow-right-arrow-left mr-2"></i> ${currentStage}`;
                        transitionBtn.classList.remove('hidden');
                    } else if (transitionBtn) {
                        transitionBtn.classList.add('hidden'); // Ensure Team Members don't see it
                    }

                    // Pause / resume control (admin only) — reflects the client's current state
                    const pauseBtn = document.getElementById('btn-toggle-pause');
                    if (pauseBtn && currentUserRole === 'admin') {
                        const clientObj = globalClientsData.find(c => normalize(c.name) === normalize(cSelectedAccount));
                        const paused = clientObj && !isActiveClient(clientObj);
                        document.getElementById('btn-toggle-pause-label').innerText = paused ? 'Resume Client' : 'Pause Client';
                        document.getElementById('btn-toggle-pause-icon').className = paused ? 'fa-solid fa-circle-play mr-2' : 'fa-solid fa-circle-pause mr-2';
                        pauseBtn.className = paused
                            ? 'bg-green-600 hover:bg-green-500 text-white font-bold py-1.5 px-4 rounded-full text-xs shadow-lg transition'
                            : 'bg-amber-600 hover:bg-amber-500 text-white font-bold py-1.5 px-4 rounded-full text-xs shadow-lg transition';
                    } else if (pauseBtn) {
                        pauseBtn.classList.add('hidden');
                    }

                    // Archive / restore control (admin only)
                    const archiveBtn = document.getElementById('btn-toggle-archive');
                    if (archiveBtn && currentUserRole === 'admin') {
                        const clientObj = globalClientsData.find(c => normalize(c.name) === normalize(cSelectedAccount));
                        const archived = clientObj && !isSelectableClient(clientObj);
                        document.getElementById('btn-toggle-archive-label').innerText = archived ? 'Restore' : 'Archive';
                        document.getElementById('btn-toggle-archive-icon').className = archived ? 'fa-solid fa-rotate-left mr-2' : 'fa-solid fa-box-archive mr-2';
                        archiveBtn.title = archived ? 'Restore this client to paused' : 'Offboard this client';
                        archiveBtn.className = 'bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 font-bold py-1.5 px-4 rounded-full text-xs transition';
                        // Pausing an already-archived client is meaningless
                        if (archived && pauseBtn) pauseBtn.classList.add('hidden');
                    } else if (archiveBtn) {
                        archiveBtn.classList.add('hidden');
                    }

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

    const steps = activeOnboardingSteps();
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

            const items = allOnboardingItems();
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
                    </div>
                    <div class="text-[11px] whitespace-nowrap">${state}</div>
                </div>`;
            }).join('');
        }

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
                
                let html = '';
                data.forEach(r => {
                    const date = new Date(r.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
                    const snippet = r.report_body ? r.report_body.substring(0, 90).replace(/\n/g, ' ') + '...' : 'No text summary available';
                    
                    html += `<tr class="hover:bg-white/5 transition border-b border-white/5">
                        <td class="p-4 text-gray-300 font-bold whitespace-nowrap">${date}</td>
                        <td class="p-4 text-gray-400 text-xs w-full">${escapeHTML(snippet)}</td>
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

            let memory = "No previous report history found.";
            try {
                const { data: previousReports, error } = await supabaseClient
                    .from('weekly_reports')
                    .select('report_body')
                    .eq('client_name', cSelectedAccount)
                    .order('created_at', { ascending: false })
                    .limit(1);
                
                if (previousReports && previousReports.length > 0) {
                    memory = previousReports[0].report_body;
                }
            } catch(err) {
                console.warn("Could not fetch memory:", err);
            }

            const p = `You are an expert, highly transparent Senior Media Buyer writing a weekly update for a client. 
            
            CLIENT DATA:
            - Client Name: ${cSelectedAccount}
            - Date Range: ${dateRangeLabel}
            - Spend: $${(currentAdsStats.s || 0).toFixed(2)}
            - Leads: ${currentAdsStats.l || 0}
            - CPL: $${(currentAdsStats.cpl || 0).toFixed(2)}
            - CPC: $${(currentAdsStats.cpc || 0).toFixed(2)}
            - CTR: ${(currentAdsStats.ctr || 0).toFixed(2)}%

            HISTORICAL CONTEXT (LAST WEEK'S EMAIL):
            "${memory}"
            
            MEDIA BUYER'S NOTES: 
            "${n || 'No manual notes provided this week. Please analyze the raw data above and compare it to the historical context to write the highlights and action plan automatically.'}"

            YOUR TASK:
            Return ONLY a JSON object with two keys: "email_summary" and "html_report".

            RULES FOR "email_summary":
            - Tone: Casual, completely honest, analytical, and direct. Do not use corporate fluff.
            - Format: Start directly with "Hi team," (Do NOT output a "Subject:" line).
            - Content: State the spend and leads upfront. Explain the "why" behind the numbers (good or bad). Reference the historical context to show trends (e.g., "we recovered from last week's CPM spike"). If manual notes were provided, use them. State the immediate priority/action step.

            RULES FOR "html_report":
            - Output a complete, copy-safe HTML string based on the data and notes.
            - Use this EXACT structure and inline styling, but replace the placeholders, highlights, and improvements to match this week's reality:
            
            <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background-color: #f5f5f7;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f7; padding: 40px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;">
            <tr><td style="background-color: #ffffff; border-radius: 18px; padding: 48px; margin-bottom: 24px; border: 1px solid #e5e5ea;"><div style="font-size: 14px; font-weight: 600; color: #86868b; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px;">${cSelectedAccount}</div><h1 style="font-size: 42px; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 16px 0; color: #1d1d1f;">Weekly Performance</h1><div style="font-size: 17px; color: #86868b; font-weight: 500;">${dateRangeLabel}</div></td></tr>
            <tr><td style="height: 24px; font-size: 24px; line-height: 24px;">&nbsp;</td></tr>
            <tr><td><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td width="280" style="background-color: #ffffff; border-radius: 16px; padding: 32px; vertical-align: top; border: 1px solid #e5e5ea;"><div style="font-size: 13px; font-weight: 600; color: #86868b; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 12px;">TOTAL LEADS</div><div style="font-size: 44px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 8px; color: #1d1d1f;">[LEADS]</div><div style="display: inline-block; background-color: #f2f2f7; color: #515154; font-size: 13px; font-weight: 600; padding: 6px 12px; border-radius: 8px;">[Short trend e.g. Severe Drop]</div></td><td width="20" style="width: 20px;"></td>
            <td width="280" style="background-color: #ffffff; border-radius: 16px; padding: 32px; vertical-align: top; border: 1px solid #e5e5ea;"><div style="font-size: 13px; font-weight: 600; color: #86868b; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 12px;">AD SPEND</div><div style="font-size: 44px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 8px; color: #1d1d1f;">$[SPEND]</div><div style="display: inline-block; background-color: #f2f2f7; color: #515154; font-size: 13px; font-weight: 600; padding: 6px 12px; border-radius: 8px;">[Short trend]</div></td>
            </tr></table></td></tr>
            <tr><td style="height: 20px; font-size: 20px; line-height: 20px;">&nbsp;</td></tr>
            <tr><td><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td width="280" style="background-color: #ffffff; border-radius: 16px; padding: 32px; vertical-align: top; border: 1px solid #e5e5ea;"><div style="font-size: 13px; font-weight: 600; color: #86868b; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 12px;">COST PER LEAD</div><div style="font-size: 44px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 8px; color: #1d1d1f;">$[CPL]</div><div style="display: inline-block; background-color: #fff3e0; color: #e65100; font-size: 13px; font-weight: 600; padding: 6px 12px; border-radius: 8px;">[Short trend]</div></td><td width="20" style="width: 20px;"></td>
            <td width="280" style="background-color: #ffffff; border-radius: 16px; padding: 32px; vertical-align: top; border: 1px solid #e5e5ea;"><div style="font-size: 13px; font-weight: 600; color: #86868b; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 12px;">CTR (LINK)</div><div style="font-size: 44px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 8px; color: #1d1d1f;">[CTR]%</div><div style="display: inline-block; background-color: #f2f2f7; color: #515154; font-size: 13px; font-weight: 600; padding: 6px 12px; border-radius: 8px;">[Short trend]</div></td>
            </tr></table></td></tr>
            <tr><td style="height: 24px; font-size: 24px; line-height: 24px;">&nbsp;</td></tr>
            <tr><td style="background-color: #ffffff; border-radius: 18px; padding: 48px; border: 1px solid #e5e5ea;"><h2 style="font-size: 28px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 24px 0; color: #1d1d1f;">Highlights</h2>
            [GENERATE 2-3 DIV BLOCKS HERE. Each block format:]
            <div style="padding: 20px 0; border-bottom: 1px solid #e8e8ed;"><div style="font-size: 17px; font-weight: 600; margin-bottom: 8px; color: #1d1d1f;">[Headline]</div><div style="font-size: 15px; color: #515154; line-height: 1.6;">[Explanation]</div></div>
            </td></tr>
            <tr><td style="height: 24px; font-size: 24px; line-height: 24px;">&nbsp;</td></tr>
            <tr><td style="background-color: #ffffff; border-radius: 18px; padding: 48px; border: 1px solid #e5e5ea;"><h2 style="font-size: 28px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 24px 0; color: #1d1d1f;">What We're Improving</h2>
            <div style="padding: 20px 0;"><div style="font-size: 17px; font-weight: 600; margin-bottom: 8px; color: #1d1d1f;">[Action Plan Headline]</div><div style="font-size: 15px; color: #515154; line-height: 1.6;">[Action Plan Details]</div></div>
            </td></tr></table></td></tr></table></body></html>
            `;

            try { 
                const res = await fetch("https://hugnttsqucetldllfgoi.supabase.co/functions/v1/ai-chat", {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json', 
                        'Authorization': `Bearer ${wrapper.dataset.supaKey}` 
                    },
                    body: JSON.stringify({ 
    messages: [{ role: "user", content: p }]
})
                }); 
                
                const j = await res.json(); 
                if(j.error) throw new Error(j.error.message); 
                
                let rawContent = j.choices[0].message.content;
const result = JSON.parse(rawContent.replace(/```json/gi, '').replace(/```/g, '').trim()); 
                
                document.getElementById('rpt-email-output').innerText = result.email_summary; 
                document.getElementById('rpt-html-src').value = result.html_report; 
                document.getElementById('rpt-html-preview').srcdoc = result.html_report;
                document.getElementById('rpt-results').style.display = 'block'; 

                try {
                    await supabaseClient.from('weekly_reports').insert({
                        client_name: cSelectedAccount,
                        report_body: result.email_summary,
                        html_body: result.html_report
                    });
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
                const webhookUrl = 'https://hook.us2.make.com/apq7ghcun1hza8h5ayw1xysy81nddh8v';
                
                const response = await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) throw new Error("Webhook failed");

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

 window.renderAdminSeo = function() {
            const { s, e } = dateRangeFor(cDateRange, cCustomStart, cCustomEnd);

            const f = globalSeoData.filter(r => {
                if (!r.date) return false;
                const dateStr = r.date.includes('T') ? r.date.split('T')[0] : r.date;
                const rd = new Date(dateStr + 'T12:00:00');
                if (rd < s || rd > e) return false;
                
                if (cSelectedAccount === "ALL") return true;
                return normalize(r.client_name).includes(normalize(cSelectedAccount));
            });

            let clk=0, imp=0, sumPos=0;
            f.forEach(r => { clk += parseInt(r.clicks)||0; imp += parseInt(r.impressions)||0; sumPos += parseFloat(r.avg_position||0); });
            
            const avgCtr = imp > 0 ? (clk / imp) * 100 : 0;
            const avgPos = f.length > 0 ? (sumPos / f.length) : 0;

            document.getElementById('seo-kpi-clicks').innerText = clk.toLocaleString();
            document.getElementById('seo-kpi-imp').innerText = imp.toLocaleString();
            document.getElementById('seo-kpi-ctr').innerText = avgCtr.toFixed(2) + '%';
            document.getElementById('seo-kpi-pos').innerText = avgPos.toFixed(1);

            const dailyMap = {}; 
            f.forEach(r => { 
                const dt = r.date.includes('T') ? r.date.split('T')[0] : r.date; 
                dailyMap[dt] = dailyMap[dt] || {c:0, i:0}; 
                dailyMap[dt].c += parseInt(r.clicks)||0; 
                dailyMap[dt].i += parseInt(r.impressions)||0; 
            });
            const labels = Object.keys(dailyMap).sort();

            if(adminSeoChart) adminSeoChart.destroy();
            const ctx = document.getElementById('adminSeoChart');
            if(ctx) {
                adminSeoChart = new Chart(ctx.getContext('2d'), { 
                    type: 'line', 
                    data: { 
                        labels: labels, 
                        datasets: [ 
                            { label: 'Clicks', data: labels.map(x=>dailyMap[x].c), borderColor: '#60a5fa', tension: 0.3, fill: true, backgroundColor: 'rgba(96,165,250,0.1)', yAxisID: 'y' }, 
                            { label: 'Impressions', data: labels.map(x=>dailyMap[x].i), borderColor: '#c084fc', tension: 0.3, yAxisID: 'y1' } 
                        ] 
                    }, 
                    options: { 
                        maintainAspectRatio: false, 
                        scales: { y: { position: 'left' }, y1: { position: 'right', grid: { display: false } } },
                        plugins: { zoom: { pan: { enabled: true, mode: 'x' }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' } } }
                    } 
                });
            }
        };

 window.renderCpSeo = function() {
            const { s, e } = getPortalRange();

            const f = allRawSeo.filter(r => {
                if (!r.date) return false;
                const dateStr = r.date.includes('T') ? r.date.split('T')[0] : r.date;
                const rd = new Date(dateStr + 'T12:00:00');
                if (rd < s || rd > e) return false;
                return normalize(r.client_name).includes(normalize(currentActiveClient));
            });

            let clk=0, imp=0, sumPos=0;
            f.forEach(r => { clk += parseInt(r.clicks)||0; imp += parseInt(r.impressions)||0; sumPos += parseFloat(r.avg_position||0); });
            const avgCtr = imp > 0 ? (clk / imp) * 100 : 0;
            const avgPos = f.length > 0 ? (sumPos / f.length) : 0;

            document.getElementById('cp-seo-clicks').innerText = clk.toLocaleString();
            document.getElementById('cp-seo-imp').innerText = imp.toLocaleString();
            document.getElementById('cp-seo-ctr').innerText = avgCtr.toFixed(2) + '%';
            document.getElementById('cp-seo-pos').innerText = avgPos.toFixed(1);

            const dailyMap = {}; 
            f.forEach(r => { 
                const dt = r.date.includes('T') ? r.date.split('T')[0] : r.date; 
                dailyMap[dt] = dailyMap[dt] || {c:0, i:0}; 
                dailyMap[dt].c += parseInt(r.clicks)||0; 
                dailyMap[dt].i += parseInt(r.impressions)||0; 
            });
            const labels = Object.keys(dailyMap).sort();

            if(cpSeoChart) cpSeoChart.destroy();
            const ctx = document.getElementById('cpSeoChart');
            if(ctx) {
                cpSeoChart = new Chart(ctx.getContext('2d'), { 
                    type: 'line', 
                    data: { 
                        labels: labels, 
                        datasets: [ 
                            { label: 'Organic Clicks', data: labels.map(x=>dailyMap[x].c), borderColor: '#fbbf24', tension: 0.3, fill: true, backgroundColor: 'rgba(251,191,36,0.1)', yAxisID: 'y' }, 
                            { label: 'Impressions', data: labels.map(x=>dailyMap[x].i), borderColor: '#c084fc', tension: 0.3, yAxisID: 'y1' } 
                        ] 
                    }, 
                    options: { 
                        maintainAspectRatio: false, 
                        scales: { y: { position: 'left' }, y1: { position: 'right', grid: { display: false } } },
                        plugins: { zoom: { pan: { enabled: true, mode: 'x' }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' } } }
                    } 
                });
            }
        };

        // ============================================================================
        // GPT-4o RAG CHAT AGENT (MINIFIED FOR TOKEN SAVINGS)
        // ============================================================================
        
        window.currentChatHistory = [];

        window.sendChatMessage = async function() {
            const inputEl = document.getElementById('chat-input');
            const msg = inputEl.value.trim();
            if(!msg) return;
            
            inputEl.value = '';
            
            // 1. Render User Message
            const msgBox = document.getElementById('chat-messages');
            msgBox.innerHTML += `
                <div class="flex items-start gap-3 justify-end">
                    <div class="bg-blue-600 p-3 rounded-2xl rounded-tr-none shadow-lg text-sm text-white max-w-[80%]">${escapeHTML(msg)}</div>
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
                const globalMatrix = window.prepareAIBrainContext();
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
                    
                const clientSeo = globalSeoData
                    .filter(r => normalize(r.client_name).includes(normC))
                    .slice(-90)
                    .map(r => ({ date: r.date ? r.date.split('T')[0] : 'Unknown', clicks: r.clicks, imp: r.impressions, pos: r.avg_position }));
                    
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
                - Organic SEO Performance: ${JSON.stringify(clientSeo)}
                - Weekly outcomes reported by the client (estimates sent, jobs closed, revenue): ${JSON.stringify(clientOutcomes)}
                
                Rules:
                1. Base your answers strictly on the provided JSON data.
                2. Look for deep cross-channel correlations.
                3. Be concise, direct, and highly analytical. Provide insights humans might miss. Give no generic advice.
                4. Use basic markdown to format your response cleanly.`;
            }

            // Setup or update system instructions
            if(window.currentChatHistory.length === 0 || window.currentChatHistory[0].role !== 'system') {
                window.currentChatHistory.unshift({ role: 'system', content: systemPrompt });
            } else {
                window.currentChatHistory[0] = { role: 'system', content: systemPrompt }; // Keep data fresh
            }
            
            window.currentChatHistory.push({ role: 'user', content: msg });
            
            // 3. Make the Secure API Call through Supabase (Bypasses CORS completely)
            try {
                const res = await fetch("https://hugnttsqucetldllfgoi.supabase.co/functions/v1/ai-chat", {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${wrapper.dataset.supaKey}`
                    },
                    body: JSON.stringify({
                        messages: window.currentChatHistory
                    })
                });
                
                const data = await res.json();
                if(data.error) throw new Error(data.error.message || JSON.stringify(data.error));
                
                const aiResponse = data.choices[0].message.content;
                window.currentChatHistory.push({ role: 'assistant', content: aiResponse });
                
                // Format markdown to HTML
                const formattedHtml = aiResponse
                    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                    .replace(/\n/g, '<br>');
                
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
                        <div class="bg-red-500/10 p-3 rounded-2xl rounded-tl-none border border-red-500/20 text-sm text-red-400 max-w-[80%]">API Error: ${e.message}</div>
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
            ['recurring', 'stage', 'onboarding'].forEach(v => {
                const el = document.getElementById(`t-view-${v}`);
                const btn = document.getElementById(`tab-btn-tpl-${v}`);
                if (el) el.classList.add('hidden');
                if (btn) btn.className = 'whitespace-nowrap pb-3 text-sm font-bold text-gray-500 border-b-2 border-transparent hover:text-gray-300 transition';
            });

            // Show selected view and highlight active tab
            document.getElementById(`t-view-${view}`).classList.remove('hidden');
            if (view === 'stage') initStageTemplateEditor();
            if (view === 'onboarding') renderOnboardingSteps();
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
        window.switchSettingsView = window.switchSettingsView || function(view) {
            const views = ['users', 'scoring', 'milestones', 'health', 'notifications', 'data'];
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
        };

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
        window.uploadCreative = window.uploadCreative || function(e) { e.preventDefault(); console.log("Upload creative stub"); };

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

                const webhookUrl = 'https://hook.us2.make.com/apq7ghcun1hza8h5ayw1xysy81nddh8v';
                const response = await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) throw new Error("Make.com rejected the webhook. Check your scenario history.");

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
        // AI BRAIN: PHASE 1 - LOCAL DATA COMPRESSOR
        // ============================================================================

        window.prepareAIBrainContext = function() {
            const today = new Date();
            const date7DaysAgo = new Date(today);
            date7DaysAgo.setDate(today.getDate() - 7);
            const date30DaysAgo = new Date(today);
            date30DaysAgo.setDate(today.getDate() - 30);

            let md = `[CONTEXT TIME: ${today.toISOString().split('T')[0]}]\n\n`;
            md += `## SYSTEM MANIFESTO\n`;
            md += `You are the Midas Media AI Brain. Analyze the tracking matrix. Identify anomalies, creative fatigue, budget pacing errors, and horizontal wins across accounts. Keep insights brief, punchy, and highly actionable for media buyers. Do NOT hallucinate data.\n\n`;
            
            md += `## ACTIVE ACCOUNTS MATRIX\n`;
            md += `Client | 7D Spend | 7D Leads | 7D CPL | 30D CPL (Baseline) | Trend | Health Score\n`;
            md += `---|---|---|---|---|---|---\n`;

            const activeClients = globalClientsData.filter(c => isActiveClient(c) && normalize(c.name) !== normalize('Midas Media'));

            activeClients.forEach(client => {
                // 1. Isolate Ads Data for this client
                const clientAds = reportsForClient(client);

                // 2. Tally up 7-Day and 30-Day Windows
                let spend7d = 0, leads7d = 0;
                let spend30d = 0, leads30d = 0;

                clientAds.forEach(r => {
                    if (!r.date) return;
                    const rd = new Date(r.date.split('T')[0] + 'T12:00:00');
                    const spend = parseFloat(r.spend || 0);
                    const leads = parseInt(r.leads || 0);

                    if (rd >= date30DaysAgo && rd <= today) {
                        spend30d += spend;
                        leads30d += leads;
                        if (rd >= date7DaysAgo) {
                            spend7d += spend;
                            leads7d += leads;
                        }
                    }
                });

                const cpl7d = leads7d > 0 ? (spend7d / leads7d) : 0;
                const cpl30d = leads30d > 0 ? (spend30d / leads30d) : 0;

                // 3. JAVASCRIPT MATH (Foolproof Trend Labeling)
                let trend = "STABLE";
                // Only flag critical if 7D CPL is strictly higher than 30D CPL (with a 5% tolerance so minor bumps don't trigger it)
                if (cpl30d > 0 && cpl7d > (cpl30d * 1.05)) trend = "CRITICAL (Spiking)"; 
                else if (cpl30d > 0 && cpl7d < cpl30d) trend = "HEALTHY (Improving)";

                // 4. Health Score Failsafe 
                let healthDisplay = client.current_score > 0 ? `${client.current_score}/100` : "STALE / UNKNOWN";

                // 5. Build the Highly Compressed Markdown Row
                md += `${client.name} | $${spend7d.toFixed(0)} | ${leads7d} | $${cpl7d.toFixed(0)} | $${cpl30d.toFixed(0)} | ${trend} | ${healthDisplay}\n`;
            });

            return md;
        };
// ============================================================================
        // AI BRAIN: PHASE 2 & 3 - API GATEWAY & UI INJECTION
        // ============================================================================

        window.runGlobalAIAudit = async function() {
            const btn = document.getElementById('btn-run-global-ai');
            const outputBox = document.getElementById('global-ai-output');
            const todayStr = new Date().toISOString().split('T')[0];
            
            // UI Loading State
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Analyzing Network...';
            btn.disabled = true;
            outputBox.classList.remove('hidden');
            outputBox.innerHTML = '<p class="text-yellow-400 animate-pulse text-center py-4"><i class="fa-solid fa-satellite-dish mr-2"></i> Crunching high-density matrix...</p>';

            const payloadContext = window.prepareAIBrainContext();
            
            const prompt = `
            ${payloadContext}
            
            INSTRUCTIONS:
            You are looking at a snapshot of our entire agency ad performance. 
            Format your response entirely in ready-to-render HTML. Do NOT use markdown code blocks like \`\`\`html. Just return the raw HTML string.
            
            Use this exact styling format for your insights:
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
               <div class="bg-red-500/10 p-4 rounded-xl border border-red-500/20">
                  <h4 class="text-red-400 font-bold mb-2 uppercase text-[10px] tracking-widest"><i class="fa-solid fa-fire mr-1"></i> Critical Alerts</h4>
                  [CRITICAL RULE: Look at the 'Trend' column in the matrix. ONLY list clients whose Trend explicitly says "CRITICAL (Spiking)". DO NOT guess or do math. Keep it to 1 concise sentence per client.]
               </div>
               <div class="bg-green-500/10 p-4 rounded-xl border border-green-500/20">
                  <h4 class="text-green-400 font-bold mb-2 uppercase text-[10px] tracking-widest"><i class="fa-solid fa-arrow-trend-up mr-1"></i> Scale Opportunities</h4>
                  [CRITICAL RULE: Look at the 'Trend' column in the matrix. ONLY list clients whose Trend explicitly says "HEALTHY (Improving)". Suggest scaling.]
               </div>
               <div class="bg-purple-500/10 p-4 rounded-xl border border-purple-500/20">
                  <h4 class="text-purple-400 font-bold mb-2 uppercase text-[10px] tracking-widest"><i class="fa-solid fa-eye mr-1"></i> Account Watchlist</h4>
                  [Call out clients with $0 spend, zero leads, or STALE health scores. Tell the team to check on them.]
               </div>
            </div>
            
            Keep the actual text extremely concise, direct, and aggressive. You are a senior media buyer diagnosing problems.`;

            try {
                const res = await fetch("https://hugnttsqucetldllfgoi.supabase.co/functions/v1/ai-chat", {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json', 
                        'Authorization': `Bearer ${wrapper.dataset.supaKey}` 
                    },
                    body: JSON.stringify({ 
                        messages: [{ role: "user", content: prompt }]
                    })
                });
                
                const data = await res.json();
                if(data.error) throw new Error(data.error.message);
                
                const aiHTML = data.choices[0].message.content;
                outputBox.innerHTML = aiHTML;

                // SAVE TO STORAGE FOR THE REST OF THE DAY
                try {
    const { data, error } = await supabaseClient.from('morning_audits').insert([{ html_body: aiHTML }]).select();
    if (error) throw error;
    
    // Add it to our local array so it shows up instantly in the new tab
    if (data && data.length > 0) {
        globalAuditsData.unshift(data[0]);
        if (!document.getElementById('page-audits').classList.contains('hidden')) {
            renderMorningAudits();
        }
    }
} catch (err) {
    console.error("Failed to save audit to database:", err);
}
                
            } catch(e) {
                outputBox.innerHTML = `<div class="bg-red-500/10 p-4 rounded-xl border border-red-500/20 text-red-400 text-center"><i class="fa-solid fa-triangle-exclamation mr-2"></i> Connection Error: ${e.message}</div>`;
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
    row.className = 'tpl-stage-row grid grid-cols-12 gap-2 items-center';
    row.dataset.tplId = tpl?.id || '';
    row.innerHTML = `
        <input type="text" class="glass-input !py-1.5 col-span-4 tpl-title" placeholder="e.g. Build campaign structure" value="${escapeAttr(stripSlashEscapes(tpl?.task_title))}">
        <input type="text" class="glass-input !py-1.5 col-span-2 tpl-assignee" placeholder="Assignee" value="${escapeAttr(stripSlashEscapes(tpl?.assignee))}">
        <input type="text" class="glass-input !py-1.5 col-span-2 tpl-group" placeholder="Optional" value="${escapeAttr(stripSlashEscapes(tpl?.checklist_group))}">
        <input type="number" class="glass-input !py-1.5 col-span-1 !text-center tpl-days" placeholder="0" value="${tpl?.due_days ?? 0}">
        <select class="glass-input !py-1.5 col-span-2 tpl-type">
            ${types.map(t => `<option value="${t}" ${tpl?.task_type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <button type="button" onclick="this.closest('.tpl-stage-row').remove()" class="col-span-1 text-red-500/60 hover:text-red-400" title="Remove">
            <i class="fa-solid fa-xmark"></i>
        </button>`;
    container.appendChild(row);
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
        sort_order: i + 1
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
                    sort_order: t.sort_order
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
        ['action', 'Action (no embed)']
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
        ${retired ? `<p class="text-[10px] uppercase tracking-widest text-amber-400/80"><i class="fa-solid fa-eye-slash mr-1"></i>Hidden from clients</p>` : ''}
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
        </div>`;
    container.appendChild(row);
    toggleOnboardingOwnerFields(row.querySelector('.ob-owner'));
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
    // The label field is pointless unless a confirmation is being asked for
    row.querySelector('.ob-confirm-label').style.display = row.querySelector('.ob-confirm').checked ? '' : 'none';

    // Hidden, not cleared — toggling owner or type to compare options and back used to
    // wipe a pasted URL. The save decides what actually gets stored.
    const needsEmbed = !isAgency && type.value !== 'action';
    embed.style.display = needsEmbed ? '' : 'none';
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
        const keepsEmbed = !isAgency && stepType !== 'action';

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
            active: r.dataset.stepActive !== 'false'
        };
    }).filter(s => s.title);

    const missingEmbed = entered.find(s => s.owner === 'client' && s.step_type !== 'action' && !s.embed_url);
    if (missingEmbed) {
        alert(`"${missingEmbed.title}" is a ${missingEmbed.step_type} step but has no URL — clients would see an empty box.`);
        return;
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
                    sort_order: s.sort_order, active: s.active
                };
                if (s.id) row.id = s.id;
                return row;
            });

            await saveRowsByIdPresence('onboarding_steps', payload);
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
async function generateStageTasks(clientName, stage) {
    // Onboarding is the one stage the client participates in, so its list lives in
    // onboarding_steps alongside their steps. Only the agency-owned rows become tasks.
    const templates = stage === 'Onboarding'
        ? allOnboardingItems()
            .filter(s => s.owner === 'agency')
            .map(s => ({
                task_title: s.title,
                assignee: s.assignee,
                due_days: s.due_days,
                task_type: 'Checklist',
                default_notes: s.description,
                checklist_group: null,
                priority: 3, urgency: 3, effort: 3
            }))
        : templatesForStage(stage);

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
    if (!activeOnboardingSteps().length) return;

    for (const c of globalClientsData) {
        if ((c.current_stage || 'Onboarding') !== 'Onboarding') continue;
        if ((c.status || 'active') !== 'active') continue;
        if (!onboardingIsComplete(c.name)) continue;
        if (onboardingHandoffRaised(c.name)) continue;

        const { data, error } = await supabaseClient
            .from('tasks').insert([buildOnboardingHandoffTask(c.name)]).select();
        if (error) { console.error(`[LIFECYCLE ENGINE] No handoff task for ${c.name}:`, error); continue; }

        if (data?.length) globalTasksData.push(...data);
        console.log(`[LIFECYCLE ENGINE] ${c.name} finished onboarding — handoff task raised.`);

        // Catches anyone whose completion happened with the portal closed, so their
        // tasks aren't waiting on a client who has already finished and moved on
        await raiseOnboardingAgencyTasks(c.name);
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
    renderContactRows(c.name);
    document.getElementById('edit-client-ad-account').value   = c.ad_account_id || '';
    document.getElementById('edit-client-business-id').value  = c.business_id || '';
    document.getElementById('edit-client-retainer').value     = c.monthly_retainer || '';
    if (c.contract_type) document.getElementById('edit-client-contract').value = c.contract_type;

    modal.style.display = 'flex';
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
            ad_account_id: adAccountId || null,
            business_id: document.getElementById('edit-client-business-id').value.trim() || null,
            contract_type: document.getElementById('edit-client-contract').value,
            monthly_retainer: document.getElementById('edit-client-retainer').value || null
        };

        const { error } = await supabaseClient.from('clients').update(payload).eq('id', id);
        if (error) throw error;

        // After the rename, so contacts are filed under the client's current name
        await saveClientContacts(newName);

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
window.previewAsClient = async function() {
    if (currentUserRole !== 'admin') return;
    if (cSelectedAccount === "ALL") { alert("Pick a specific client first."); return; }

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
        if(transitionBtn) transitionBtn.innerHTML = `<i class="fa-solid fa-arrow-right-arrow-left mr-2"></i> ${targetStage}`;
        
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
        current_stage: 'Onboarding',
        status: 'active'
    };

    try {
        const { data, error } = await supabaseClient.from('clients').insert([payload]).select();
        if (error) throw error;

        // Add to local cache and refresh UI
        if(data && data.length > 0) globalClientsData.push(data[0]);
        
        document.getElementById('add-client-modal').style.display = 'none';
        
        // Auto-switch to the new client
        if(typeof cSelectAccount === 'function') cSelectAccount(payload.name, payload.name);
        
        // The agency checklist is deliberately not generated here. Our work starts when
        // the client has finished theirs, so it's raised on completion instead — see
        // raiseOnboardingAgencyTasks. Creating it now would fill the board with tasks
        // nobody can action for a client who may not log in for a week.
        alert("Client created. Your onboarding tasks will appear once they've finished their steps.");
        
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


