// Golden Eye easter egg #2: Speed to Lead. Type 5min anywhere (admins only, not inside a text box)
// and this file loads. Leads arrive; type a friendly reply before they go cold; press Tab to
// dismiss spam. 60 seconds, a streak multiplier, and a leaderboard (speed_lead_runs).
//
// Everything is original: drawn with HTML and CSS, sounds synthesized with WebAudio, no outside
// assets. app.js fetches this only when the egg is found. The rules live in plain functions
// (newState, tick, typeKey, dismiss) that take the clock as an argument, so they run under node
// for tests; the overlay below only draws them.
(function () {
'use strict';
if (window.GESpeedLead) return;

const RUN_MS = 60000;

// ---------------------------------------------------------------------------------------------
// The rules

function seeded(seed) {
    return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

const NAMES = ['Maria', 'Jake', 'Priya', 'Tom', 'Sofia', 'Dave', 'Lena', 'Marcus', 'Ana', 'Chris', 'Hannah', 'Omar', 'Beth', 'Luis', 'Nora', 'Sam'];
const SERVICES = ['basement finish', 'deck build', 'kitchen remodel', 'new cabinets', 'roof repair', 'bathroom remodel', 'pergola', 'new windows', 'custom closet', 'fence install'];
const CITIES = ['Lehi', 'Eagle Mountain', 'Draper', 'Lindon', 'American Fork', 'Saratoga Springs', 'Sandy', 'Provo', 'Orem', 'Highland'];

const MESSAGES = [
    (s, c) => `Hi, I'd like a quote on a ${s} in ${c}.`,
    (s, c) => `Looking for someone to do a ${s}. Can you help?`,
    (s, c) => `Need an estimate for a ${s} ASAP, ${c}.`,
    (s, c) => `How much for a ${s}? We're in ${c}.`,
    (s, c) => `Saw your ad. Can you do a ${s} in ${c}?`,
];
// Short on purpose: about 30 characters is 6 to 9 seconds of typing
const REPLIES = [
    (n) => `Hi ${n}! 4pm or 6pm today?`,
    (n) => `Hey ${n}, free quote Thu 10 or 2?`,
    (n) => `Hi ${n}, can we call at 3 or 5?`,
    (n) => `Thanks ${n}! Tomorrow 9 or 1?`,
    (n) => `Hi ${n}! Free estimate Fri at 10?`,
];
const JUNK = [
    { from: 'Unknown number', text: "Congrats! You've won a $500 gift card. Click here to claim." },
    { from: 'Unknown number', text: 'Sorry, wrong number!' },
    { from: 'Unknown number', text: "Is this Dave's pizza? Where is my order?" },
    { from: 'SEO Genius', text: 'Guaranteed #1 Google ranking in 24 hours. Reply YES.' },
    { from: 'Unknown number', text: 'Hey stranger, it has been a while. Call me back.' },
    { from: 'Prize Desk', text: 'Your car warranty is about to expire. Press 1.' },
];

// How hard it is, by how far into the run: spawns get faster and patience shorter
const lerp = (a, b, f) => a + (b - a) * Math.max(0, Math.min(1, f));
function difficulty(elapsed) {
    const f = elapsed / RUN_MS;
    return { spawnEvery: lerp(5200, 2800, f), patience: lerp(17000, 10000, f), junkChance: 0.2, maxQueue: 4 };
}

function newLead(state) {
    const rng = state.rng, d = difficulty(state.t);
    const junk = state.nextId > 1 && rng() < d.junkChance;
    const name = NAMES[rng() * NAMES.length | 0];
    const base = { id: state.nextId++, born: state.t, patience: d.patience, junk, name };
    if (junk) {
        const j = JUNK[rng() * JUNK.length | 0];
        return { ...base, from: j.from, text: j.text, reply: REPLIES[rng() * REPLIES.length | 0]('there') };
    }
    const service = SERVICES[rng() * SERVICES.length | 0], city = CITIES[rng() * CITIES.length | 0];
    return { ...base, from: name, service, text: MESSAGES[rng() * MESSAGES.length | 0](service, city), reply: REPLIES[rng() * REPLIES.length | 0](name) };
}

const isTyped = (ch) => /[a-z0-9 ]/i.test(ch);
// Punctuation fills itself in: only letters, digits and spaces are typed
function skipPunct(target, pos) { while (pos < target.length && !isTyped(target[pos])) pos++; return pos; }

function newState(seed) {
    const s = {
        rng: seeded(seed == null ? (Date.now() & 0x7fffffff) : seed), t: 0, nextId: 1, nextSpawn: 0,
        leads: [], pos: 0, score: 0, streak: 0, bestStreak: 0, replied: 0, lost: 0, spamCleared: 0, penalties: 0,
        replyMs: [], keysOk: 0, keysBad: 0, over: false, events: [],
    };
    return s;
}
const multiplier = (streak) => Math.min(5, 1 + Math.floor(streak / 3));
const front = (s) => s.leads[0] || null;
function resetFront(s) { const f = front(s); s.pos = f ? skipPunct(f.reply, 0) : 0; }
function emit(s, name, extra) { s.events.push({ name, ...(extra || {}) }); }

function tick(s, dt) {
    if (s.over) return s;
    s.t += dt;
    // Spawns: the first lead comes straight away, and never more than the queue allows
    if (s.t >= s.nextSpawn) {
        const d = difficulty(s.t);
        if (s.leads.length < d.maxQueue) {
            const hadFront = !!front(s);
            s.leads.push(newLead(s));
            if (!hadFront) resetFront(s);
            s.nextSpawn = s.t + d.spawnEvery;
            emit(s, 'spawn');
        } else s.nextSpawn = s.t + 600;   // the queue is full: look again shortly
    }
    // Expiry: a real lead going cold costs points and the streak; spam just goes away
    const gone = [];
    for (const l of s.leads) if (s.t - l.born >= l.patience) gone.push(l);
    if (gone.length) {
        const wasFront = front(s);
        s.leads = s.leads.filter((l) => !gone.includes(l));
        for (const l of gone) {
            if (l.junk) { emit(s, 'spam-gone'); continue; }
            s.lost++; s.streak = 0; s.score = Math.max(0, s.score - 50); s.penalties++;
            emit(s, 'lost', { lead: l });
        }
        if (front(s) !== wasFront) resetFront(s);
    }
    if (s.t >= RUN_MS) { s.over = true; emit(s, 'end'); }
    return s;
}

// A key press: advances the reply only when it is the next required character
function typeKey(s, key) {
    if (s.over) return s;
    const f = front(s);
    if (!f || typeof key !== 'string' || key.length !== 1) return s;
    const want = f.reply[s.pos];
    if (want === undefined) return s;
    if (key.toLowerCase() !== want.toLowerCase()) { s.keysBad++; emit(s, 'reject'); return s; }
    s.keysOk++;
    s.pos = skipPunct(f.reply, s.pos + 1);
    emit(s, 'key');
    if (s.pos >= f.reply.length) send(s, f);
    return s;
}

function send(s, lead) {
    s.leads = s.leads.filter((l) => l !== lead);
    if (lead.junk) {
        // Replying to spam: a penalty, and it breaks the streak
        s.score = Math.max(0, s.score - 100); s.streak = 0; s.penalties++;
        emit(s, 'spam-replied', { lead });
    } else {
        const remaining = 1 - (s.t - lead.born) / lead.patience;
        s.streak++; s.bestStreak = Math.max(s.bestStreak, s.streak);
        const gained = Math.round((100 + 100 * Math.max(0, remaining)) * multiplier(s.streak));
        s.score += gained; s.replied++; s.replyMs.push(Math.round(s.t - lead.born));
        emit(s, 'sent', { lead, gained });
    }
    resetFront(s);
}

// Tab: throw away the oldest lead. Right for spam, a mistake for a real lead
function dismiss(s) {
    if (s.over) return s;
    const f = front(s);
    if (!f) return s;
    s.leads.shift();
    if (f.junk) {
        s.spamCleared++; s.streak++; s.bestStreak = Math.max(s.bestStreak, s.streak);
        const gained = 40 * multiplier(s.streak);
        s.score += gained;
        emit(s, 'spam-cleared', { lead: f, gained });
    } else {
        s.score = Math.max(0, s.score - 100); s.streak = 0; s.lost++; s.penalties++;
        emit(s, 'wrong-dismiss', { lead: f });
    }
    resetFront(s);
    return s;
}

function summary(s) {
    const avg = s.replyMs.length ? Math.round(s.replyMs.reduce((n, x) => n + x, 0) / s.replyMs.length) : 0;
    const keys = s.keysOk + s.keysBad;
    return { score: s.score, replies: s.replied, best_streak: s.bestStreak, avg_reply_ms: avg, accuracy: keys ? Math.round(s.keysOk / keys * 1000) / 10 : 100 };
}

// ---------------------------------------------------------------------------------------------
// Sound: tiny synthesized blips

let ac = null;
function audio() { if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; } } return ac; }
function tone(freq, dur, type = 'square', vol = 0.05, slide = 0, delay = 0) {
    const a = audio(); if (!a) return;
    const t = a.currentTime + delay;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.linearRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
}
const sfx = {
    spawn() { tone(880, 0.06, 'triangle', 0.04); },
    key() { tone(520, 0.03, 'square', 0.025); },
    reject() { tone(130, 0.08, 'sawtooth', 0.05); },
    sent() { tone(660, 0.07); tone(990, 0.1, 'square', 0.05, 0, 0.07); },
    cleared() { tone(400, 0.08, 'triangle', 0.05, 200); },
    lost() { tone(180, 0.25, 'sawtooth', 0.07, -100); },
    penalty() { tone(150, 0.3, 'square', 0.06); },
    end() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.18, 'square', 0.05, 0, i * 0.12)); },
};

// ---------------------------------------------------------------------------------------------
// The overlay

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function injectStyles() {
    if (document.getElementById('ge-sl-style')) return;
    const st = document.createElement('style');
    st.id = 'ge-sl-style';
    st.textContent = `
#ge-sl { position: fixed; inset: 0; z-index: 2147483000; background: #050403; display: flex; align-items: center; justify-content: center; font-family: 'JetBrains Mono', ui-monospace, monospace; color: #e9dcc0; }
#ge-sl .sl-stage { position: relative; width: min(760px, 96vw); height: min(620px, 94vh); display: flex; flex-direction: column; gap: 14px; padding: 18px 20px; border: 1px solid #3a2e1b; background: #0b0907; box-shadow: 0 20px 80px rgba(0,0,0,.6); }
#ge-sl .sl-close { position: absolute; top: 12px; right: 14px; background: none; border: 1px solid #3a2e1b; color: #b8a682; width: 30px; height: 30px; border-radius: 3px; cursor: pointer; font: inherit; }
#ge-sl .sl-close:hover { color: #f3dc9a; border-color: #d9b463; }
#ge-sl .sl-top { display: flex; gap: 22px; align-items: baseline; padding-right: 40px; }
#ge-sl .sl-top span { display: block; font-size: 10px; letter-spacing: .16em; color: #8f7d5c; text-transform: uppercase; }
#ge-sl .sl-top b { font-size: 24px; color: #f3dc9a; font-variant-numeric: tabular-nums; }
#ge-sl .sl-top .sl-time b.low { color: #e07a62; }
#ge-sl .sl-queue { flex: 1; display: flex; flex-direction: column; gap: 8px; overflow: hidden; }
#ge-sl .sl-card { border: 1px solid #2c2318; padding: 10px 12px; background: #100d0a; }
#ge-sl .sl-card.front { border-color: #d9b463; background: #17120c; }
#ge-sl .sl-from { font-size: 11px; letter-spacing: .1em; color: #b8944f; text-transform: uppercase; }
#ge-sl .sl-text { font-size: 14px; line-height: 1.4; margin: 3px 0 8px; color: #e9dcc0; }
#ge-sl .sl-bar { height: 5px; background: #221b12; border-radius: 3px; overflow: hidden; }
#ge-sl .sl-bar i { display: block; height: 100%; background: #d9b463; }
#ge-sl .sl-bar i.warn { background: #e0a14a; }
#ge-sl .sl-bar i.bad { background: #e07a62; }
#ge-sl .sl-empty { color: #6f634d; font-size: 13px; margin: auto; }
#ge-sl .sl-reply { border: 1px solid #5c4a2c; background: #0e0b08; padding: 14px 16px; font-size: 20px; letter-spacing: .02em; min-height: 54px; white-space: pre-wrap; }
#ge-sl .sl-reply .ok { color: #9fd49a; }
#ge-sl .sl-reply .nx { color: #1a1209; background: #d9b463; }
#ge-sl .sl-reply .rest { color: #7d6f55; }
#ge-sl .sl-reply.bad { border-color: #e07a62; }
#ge-sl .sl-hint { font-size: 11px; color: #8f7d5c; letter-spacing: .08em; }
#ge-sl .sl-flash { position: absolute; left: 20px; right: 20px; bottom: 84px; text-align: center; font-size: 15px; letter-spacing: .12em; pointer-events: none; opacity: 0; transition: opacity .2s; }
#ge-sl .sl-flash.on { opacity: 1; }
#ge-sl .sl-panel { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 4%; background: rgba(8,6,4,.9); }
#ge-sl .sl-panel.hidden { display: none; }
#ge-sl .sl-modal { width: min(520px, 100%); max-height: 100%; overflow: auto; border: 1px solid #5c4a2c; background: rgba(14,11,8,.96); padding: 22px 24px; border-radius: 3px; }
#ge-sl .lbl { font-size: 11px; letter-spacing: .18em; color: #b8944f; text-transform: uppercase; }
#ge-sl h2 { font-size: 22px; letter-spacing: .06em; margin: 8px 0 12px; color: #f3dc9a; }
#ge-sl p { font-size: 13px; line-height: 1.55; color: #cbbd9f; margin: 0 0 12px; }
#ge-sl ul { margin: 0 0 12px; padding-left: 18px; font-size: 13px; color: #cbbd9f; line-height: 1.7; }
#ge-sl .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
#ge-sl .btn { background: #d9b463; color: #1a1209; border: 0; font: inherit; font-weight: 700; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; padding: 10px 16px; cursor: pointer; border-radius: 2px; }
#ge-sl .btn.ghost { background: transparent; color: #d9b463; border: 1px solid #5c4a2c; }
#ge-sl .btn:focus-visible, #ge-sl .sl-close:focus-visible { outline: 2px solid #f3dc9a; outline-offset: 2px; }
#ge-sl table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
#ge-sl td, #ge-sl th { padding: 5px 4px; border-top: 1px solid #2c2318; text-align: left; }
#ge-sl th { color: #8f7d5c; font-weight: 400; letter-spacing: .1em; font-size: 10px; text-transform: uppercase; }
#ge-sl td.r, #ge-sl th.r { text-align: right; }
#ge-sl tr.me td { color: #f3dc9a; }
#ge-sl .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 6px 0 16px; }
#ge-sl .stats div { border: 1px solid #2c2318; padding: 10px; }
#ge-sl .stats span { display: block; font-size: 10px; letter-spacing: .14em; color: #8f7d5c; text-transform: uppercase; }
#ge-sl .stats strong { font-size: 19px; color: #f3dc9a; }
#ge-sl .msg.bad { color: #e07a62; font-size: 12px; }
@keyframes ge-sl-shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-5px); } 75% { transform: translateX(5px); } }
#ge-sl .sl-reply.shake { animation: ge-sl-shake .18s 1; }
@media (prefers-reduced-motion: reduce) { #ge-sl .sl-reply.shake { animation: none; } }
@media (max-width: 560px) { #ge-sl .stats { grid-template-columns: repeat(2, 1fr); } }
`;
    document.head.appendChild(st);
}

const fmtSecs = (ms) => (ms / 1000).toFixed(1) + 's';

function start(opts = {}) {
    if (document.getElementById('ge-sl')) return;
    injectStyles();
    const root = document.createElement('div');
    root.id = 'ge-sl';
    root.innerHTML = `<div class="sl-stage" role="dialog" aria-label="Speed to Lead">
        <button class="sl-close" type="button" aria-label="Close">&times;</button>
        <div class="sl-top">
            <div><span>Score</span><b id="sl-score">0</b></div>
            <div><span>Multiplier</span><b id="sl-mult">x1</b></div>
            <div class="sl-time"><span>Time</span><b id="sl-time">60.0</b></div>
        </div>
        <div class="sl-queue" id="sl-queue"></div>
        <div class="sl-reply" id="sl-reply"></div>
        <div class="sl-hint">Type the reply to the oldest lead. Tab throws away spam. Esc pauses.</div>
        <div class="sl-flash" id="sl-flash"></div>
        <div class="sl-panel" id="sl-panel"></div>
    </div>`;
    document.body.appendChild(root);
    const $ = (id) => root.querySelector('#' + id);
    const panel = $('sl-panel');

    let S = newState();
    let mode = 'intro', raf = 0, last = 0, lastDraw = 0, flashTimer = 0;

    function flash(text, color) {
        const f = $('sl-flash'); f.textContent = text; f.style.color = color; f.classList.add('on');
        clearTimeout(flashTimer); flashTimer = setTimeout(() => f.classList.remove('on'), 650);
    }

    function draw() {
        $('sl-score').textContent = S.score.toLocaleString();
        $('sl-mult').textContent = 'x' + multiplier(S.streak);
        const left = Math.max(0, RUN_MS - S.t);
        const tEl = $('sl-time'); tEl.textContent = (left / 1000).toFixed(1); tEl.classList.toggle('low', left < 10000);
        const q = $('sl-queue');
        if (!S.leads.length) q.innerHTML = '<div class="sl-empty">No leads waiting. Stay ready.</div>';
        else q.innerHTML = S.leads.map((l, i) => {
            const frac = Math.max(0, 1 - (S.t - l.born) / l.patience);
            return `<div class="sl-card${i === 0 ? ' front' : ''}"><div class="sl-from">${esc(l.from)}</div><div class="sl-text">${esc(l.text)}</div>
                <div class="sl-bar"><i class="${frac < 0.25 ? 'bad' : frac < 0.5 ? 'warn' : ''}" style="width:${(frac * 100).toFixed(1)}%"></i></div></div>`;
        }).join('');
        const f = front(S), r = $('sl-reply');
        if (!f) { r.innerHTML = '<span class="rest">Waiting for the next lead&hellip;</span>'; return; }
        const t = f.reply;
        r.innerHTML = `<span class="ok">${esc(t.slice(0, S.pos))}</span><span class="nx">${esc(t[S.pos] === ' ' ? ' ' : (t[S.pos] || ''))}</span><span class="rest">${esc(t.slice(S.pos + 1))}</span>`;
    }

    function handleEvents() {
        for (const e of S.events.splice(0)) {
            if (e.name === 'spawn') sfx.spawn();
            else if (e.name === 'key') sfx.key();
            else if (e.name === 'reject') { sfx.reject(); const r = $('sl-reply'); r.classList.remove('shake'); void r.offsetWidth; r.classList.add('shake'); }
            else if (e.name === 'sent') { sfx.sent(); flash('+' + e.gained, '#9fd49a'); }
            else if (e.name === 'spam-cleared') { sfx.cleared(); flash('spam cleared +' + e.gained, '#9fd49a'); }
            else if (e.name === 'lost') { sfx.lost(); flash('lead went cold -50', '#e07a62'); }
            else if (e.name === 'spam-replied') { sfx.penalty(); flash('that was spam -100', '#e07a62'); }
            else if (e.name === 'wrong-dismiss') { sfx.penalty(); flash('that was a real lead -100', '#e07a62'); }
        }
    }

    function loop(now) {
        raf = requestAnimationFrame(loop);
        if (mode !== 'play') { last = now; return; }
        const dt = Math.min(250, now - last); last = now;
        tick(S, dt);
        handleEvents();
        if (S.over) { finish(); return; }
        if (now - lastDraw > 40) { draw(); lastDraw = now; }
    }

    const card = (html) => { panel.classList.remove('hidden'); panel.innerHTML = `<div class="sl-modal">${html}</div>`; return panel.firstChild; };

    function showIntro() {
        mode = 'intro';
        const el = card(`
            <div class="lbl">Speed to lead</div>
            <h2>Five minutes is too slow.</h2>
            <p>Leads text in. Reply before they go cold.</p>
            <ul><li>Type the reply to the <b>oldest</b> lead. Wrong keys do not count, punctuation fills itself in.</li>
            <li>Faster replies score more, and every three in a row raises your multiplier.</li>
            <li>Some texts are spam. Press <b>Tab</b> to throw them away. Replying to spam, or dropping a real lead, costs you.</li>
            <li>You have 60 seconds.</li></ul>
            <div class="board"><p>Loading leaderboard&hellip;</p></div>
            <div class="row"><button class="btn" type="button" data-act="go">Start</button><button class="btn ghost" type="button" data-act="close">Close</button></div>`);
        const touchOnly = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
        if (touchOnly) { el.querySelector('[data-act="go"]').remove(); el.querySelector('.board').innerHTML = '<p>This one needs a keyboard.</p>'; }
        el.querySelector('[data-act="go"]')?.addEventListener('click', begin);
        el.querySelector('[data-act="close"]').addEventListener('click', close);
        setTimeout(() => el.querySelector('[data-act="go"]')?.focus(), 30);
        loadBoard(el.querySelector('.board'), null);
    }

    function begin() {
        S = newState();
        panel.classList.add('hidden'); panel.innerHTML = '';
        mode = 'play'; last = performance.now(); lastDraw = 0;
        tick(S, 0);   // the first lead arrives at once
        handleEvents(); draw();
    }

    function pause() {
        if (mode !== 'play') return;
        mode = 'pause';
        const el = card(`<div class="lbl">Paused</div><h2>Take a breath.</h2><div class="row"><button class="btn" type="button" data-act="resume">Resume</button><button class="btn ghost" type="button" data-act="close">Close</button></div>`);
        el.querySelector('[data-act="resume"]').addEventListener('click', () => { panel.classList.add('hidden'); mode = 'play'; last = performance.now(); });
        el.querySelector('[data-act="close"]').addEventListener('click', close);
        setTimeout(() => el.querySelector('[data-act="resume"]')?.focus(), 30);
    }

    function finish() {
        mode = 'over'; sfx.end(); draw();
        const sum = summary(S);
        const el = card(`
            <div class="lbl">Time</div>
            <h2>${sum.score >= 1500 ? 'Fast hands.' : sum.score >= 600 ? 'Not bad.' : 'The leads went cold.'}</h2>
            <div class="stats"><div><span>Score</span><strong>${sum.score.toLocaleString()}</strong></div>
            <div><span>Replies</span><strong>${sum.replies}</strong></div>
            <div><span>Avg reply</span><strong>${sum.replies ? fmtSecs(sum.avg_reply_ms) : '-'}</strong></div>
            <div><span>Best streak</span><strong>${sum.best_streak}</strong></div></div>
            <div class="board"><p>Saving your score&hellip;</p></div>
            <div class="row"><button class="btn" type="button" data-act="again">Play again</button><button class="btn ghost" type="button" data-act="close">Close</button></div>`);
        el.querySelector('[data-act="again"]').addEventListener('click', begin);
        el.querySelector('[data-act="close"]').addEventListener('click', close);
        setTimeout(() => el.querySelector('[data-act="again"]')?.focus(), 30);
        const board = el.querySelector('.board');
        if (!sum.score) { loadBoard(board, null); return; }
        Promise.resolve(opts.saveScore ? opts.saveScore(sum) : null)
            .then((res) => loadBoard(board, res && res.error ? res.error : null))
            .catch((err) => loadBoard(board, err));
    }

    const setupMsg = (err) => /speed_lead_runs|42P01|PGRST20/.test(`${err?.code || ''} ${err?.message || ''}`)
        ? "The leaderboard isn't set up yet: run supabase/sql/speed_lead_runs.sql." : "Couldn't reach the leaderboard.";

    function loadBoard(box, saveErr) {
        if (!box) return;
        if (!opts.loadScores) { box.innerHTML = ''; return; }
        Promise.resolve(opts.loadScores()).then(({ data, error } = {}) => {
            if (error) { box.innerHTML = `<p class="msg bad">${esc(setupMsg(error))}</p>`; return; }
            const best = new Map();
            (data || []).forEach((r) => { const k = String(r.player_email || '').toLowerCase(); if (!best.has(k) || r.score > best.get(k).score) best.set(k, r); });
            const rows = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 10);
            const me = String(opts.playerEmail || '').toLowerCase();
            const warn = saveErr ? `<p class="msg bad">${esc(setupMsg(saveErr))}</p>` : '';
            box.innerHTML = warn + (rows.length
                ? `<table><thead><tr><th>#</th><th>Agent</th><th class="r">Score</th><th class="r">Avg reply</th></tr></thead><tbody>${rows.map((r, i) =>
                    `<tr${String(r.player_email || '').toLowerCase() === me ? ' class="me"' : ''}><td>${i + 1}</td><td>${esc(r.player_name || String(r.player_email || '').split('@')[0])}</td><td class="r">${Number(r.score).toLocaleString()}</td><td class="r">${r.avg_reply_ms ? fmtSecs(r.avg_reply_ms) : '-'}</td></tr>`).join('')}</tbody></table>`
                : '<p>No scores yet. Be the first.</p>');
        }).catch((err) => { box.innerHTML = `<p class="msg bad">${esc(setupMsg(err))}</p>`; });
    }

    // ---- input ----
    function onKeyDown(e) {
        e.stopPropagation();   // keep the dashboard's own shortcuts out of it
        if (e.key === 'Escape') { e.preventDefault(); if (mode === 'play') pause(); else if (mode !== 'pause') close(); return; }
        if (mode !== 'play') return;
        if (e.key === 'Tab') { e.preventDefault(); dismiss(S); handleEvents(); draw(); return; }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key.length === 1) { e.preventDefault(); typeKey(S, e.key); handleEvents(); draw(); }
    }
    function onKeyUp(e) { e.stopPropagation(); }
    function onBlur() { if (mode === 'play') pause(); }
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    root.querySelector('.sl-close').addEventListener('click', close);

    function close() {
        cancelAnimationFrame(raf);
        clearTimeout(flashTimer);
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keyup', onKeyUp, true);
        window.removeEventListener('blur', onBlur);
        root.remove();
        if (opts.onClose) opts.onClose();
    }

    draw();
    showIntro();
    raf = requestAnimationFrame(loop);
    // Local preview only: lets a test drive the game
    if (location.hostname === 'localhost') window.__geSpeedLeadDebug = { get S() { return S; }, typeKey: (k) => { typeKey(S, k); handleEvents(); draw(); }, advance: (ms) => { tick(S, ms); handleEvents(); draw(); }, dismiss: () => { dismiss(S); handleEvents(); draw(); }, get mode() { return mode; } };
}

window.GESpeedLead = { start, _test: { newState, tick, typeKey, dismiss, summary, difficulty, multiplier, skipPunct, seeded, RUN_MS, NAMES, SERVICES, REPLIES, JUNK } };
})();
