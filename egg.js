// Golden Eye easter egg. Seven quick clicks on the logo (admins only) load this file,
// which asks for a code and then runs one small first-person level.
//
// Everything here is original: the pixel art is drawn from strings and canvas shapes,
// the sounds are synthesized with WebAudio, and nothing is copied from any film or game.
// app.js fetches this only when the egg is found, so it costs the dashboard nothing.
(function () {
'use strict';
if (window.GEEgg) return;

const W = 320, H = 200;

// The code: SEVERNAYA, every letter moved 7 (007) places forward
const ANSWER = 'SEVERNAYA';
const SHIFT = 7;
const caesar = (s, k) => String(s).toUpperCase().replace(/[A-Z]/g,
    ch => String.fromCharCode((ch.charCodeAt(0) - 65 + k + 260) % 26 + 65));
const CIPHER = caesar(ANSWER, SHIFT);

const NEED_CHECKINS = 3, NEED_KILLS = 8;

// % concrete, # gold panelling, = server racks, X the exit. P start, e enemy,
// c check-in, h coffee (health).
const MAP = [
    '%%%%%%%%%%%%%%%%%%%%%%%%',
    '%P...#........#....c...%',
    '%....#..e.....#........%',
    '%....#.......e#...e....%',
    '%..h.......#.......#...%',
    '%....#.....#..#....#...%',
    '%#####.#####..#######.#%',
    '%c.....#........=......%',
    '%......#...e....=..e...%',
    '%..e...=........=......%',
    '%......=...##...=......%',
    '%......=...##...#...h..%',
    '%###.###........###.###%',
    '%.......#......#.......%',
    '%...e...#..c...#....e..%',
    '%.......#......#.......%',
    '%.......####.###.......%',
    '%h.....................%',
    '%.......#.......#..e...%',
    '%####.###..e....####.##%',
    '%.......#.......#......%',
    '%...e...#.......#......%',
    '%.......#..............%',
    '%%%%%%%%%%%%%%%%%%%%X%%%',
];

function parseMap(rows) {
    const grid = rows.map(r => r.split(''));
    const ents = [];
    let start = null;
    grid.forEach((row, y) => row.forEach((ch, x) => {
        if (ch === 'P') { start = { x: x + 0.5, y: y + 0.5 }; row[x] = '.'; }
        else if (ch === 'e' || ch === 'c' || ch === 'h') {
            ents.push({ kind: { e: 'enemy', c: 'checkin', h: 'coffee' }[ch], x: x + 0.5, y: y + 0.5 });
            row[x] = '.';
        }
    }));
    let exit = null;
    grid.forEach((row, y) => row.forEach((ch, x) => { if (ch === 'X') exit = { x: x + 0.5, y: y + 0.5 }; }));
    return { grid, ents, start, exit };
}

// Open cells reachable from a point (for the tests: every pickup and the exit must be)
function reachable(grid, from) {
    const seen = new Set();
    const q = [[from.x | 0, from.y | 0]];
    while (q.length) {
        const [x, y] = q.pop();
        const k = x + ',' + y;
        if (seen.has(k) || grid[y]?.[x] !== '.') continue;
        seen.add(k);
        q.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    return seen;
}

const isWall = (grid, x, y) => grid[y | 0]?.[x | 0] !== '.';

// ---- colours and art ----
const rgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return (0xff000000 | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | (n >> 16)) >>> 0;
};
function shade(c, f) {
    let r = (c & 255) * f, g = ((c >>> 8) & 255) * f, b = ((c >>> 16) & 255) * f;
    if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
    return (0xff000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0)) >>> 0;
}
const fog = (d) => Math.max(0.05, Math.exp(-d * 0.14));

const PAL = {
    h: '#2b1f14', s: '#c8946a', S: '#7a5236', k: '#2a2620', K: '#16130f', w: '#e9e3d6',
    r: '#c8342a', b: '#0b0a08', g: '#6d6a63', G: '#d9b463', y: '#ffd25a', Y: '#fff6c8', q: '#9a948a',
};

const GUARD = [
    '......hhhh......',
    '.....hhhhhh.....',
    '.....hssssh.....',
    '.....ssssss.....',
    '.....sSssSs.....',
    '......ssss......',
    '.......ss.......',
    '....kkkwwkkk....',
    '...kkkkwrkkkk...',
    '..kkkkkwrkkkkk..',
    '..kkkkkwrkkkkk..',
    '..kkk.kwrk.kkk..',
    '..kkk.kkkk.kkk..',
    '..ss..kkkk..ss..',
    '..ss..kkkk..ss..',
    '......kkkk......',
    '.....kkkkkk.....',
    '.....kkKKkk.....',
    '.....kk..kk.....',
    '.....kk..kk.....',
    '.....kk..kk.....',
    '.....kk..kk.....',
    '.....KK..KK.....',
    '....bbb..bbb....',
];
const GUARD_FIRE = GUARD.slice();
GUARD_FIRE[11] = '..kkkkkkkkkkkk..';
GUARD_FIRE[12] = '...kkksssskkk...';
GUARD_FIRE[13] = '....kkggggkk....';
GUARD_FIRE[14] = '.....YyyyyY.....';
GUARD_FIRE[15] = '......yYYy......';
const CORPSE = [
    '................',
    '.hh.............',
    'hssKkkkkkkkkkbb.',
    'hSSkkwrrkkkkKbb.',
    '.ss.kkkkkkkkKK..',
];
const CHECKIN = [
    '...GGGG...',
    '.wwGGGGww.',
    '.wwwwwwww.',
    '.wkkkkkkw.',
    '.wwwwwwww.',
    '.wkkkkkww.',
    '.wwwwwwww.',
    '.wkkkkkkw.',
    '.wwwwwwww.',
    '.wkkkwwww.',
    '.wwwwwwww.',
];
const COFFEE = [
    '..q..q....',
    '...q..q...',
    '.GGGGGGG..',
    '.wwwwwwwGG',
    '.wwwwwww.G',
    '.wwwwwwwGG',
    '.wwwwwww..',
    '..wwwww...',
];

function spriteFrom(rows) {
    const h = rows.length, w = Math.max(...rows.map(r => r.length));
    const pix = new Uint32Array(w * h);
    rows.forEach((r, y) => { for (let x = 0; x < w; x++) { const ch = r[x] || '.'; pix[y * w + x] = ch === '.' ? 0 : rgb(PAL[ch]); } });
    return { pix, w, h };
}

function seeded(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function makeTex(draw) {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const x = c.getContext('2d');
    draw(x);
    return new Uint32Array(x.getImageData(0, 0, 64, 64).data.buffer.slice(0));
}

function buildTextures() {
    const grit = (x, rnd, n, dark, light) => { for (let i = 0; i < n; i++) { x.fillStyle = rnd() < 0.55 ? dark : light; x.fillRect(rnd() * 64 | 0, rnd() * 64 | 0, 1, 1); } };
    const gold = makeTex(x => {
        const rnd = seeded(7);
        x.fillStyle = '#4a3b22'; x.fillRect(0, 0, 64, 64);
        for (const py of [0, 32]) {
            x.fillStyle = '#7d6437'; x.fillRect(2, py + 2, 60, 28);
            x.fillStyle = '#b8944f'; x.fillRect(2, py + 2, 60, 2); x.fillRect(2, py + 2, 2, 28);
            x.fillStyle = '#33281a'; x.fillRect(2, py + 28, 60, 2); x.fillRect(60, py + 2, 2, 28);
            x.fillStyle = '#d9b463'; [[6, py + 6], [56, py + 6], [6, py + 24], [56, py + 24]].forEach(([a, b]) => x.fillRect(a, b, 2, 2));
            x.fillStyle = '#6a5430'; x.fillRect(14, py + 14, 36, 2);
        }
        grit(x, rnd, 260, 'rgba(0,0,0,0.2)', 'rgba(255,230,170,0.08)');
    });
    const server = makeTex(x => {
        const rnd = seeded(13);
        x.fillStyle = '#14171d'; x.fillRect(0, 0, 64, 64);
        x.fillStyle = '#2b3039'; x.fillRect(0, 0, 64, 3); x.fillRect(0, 61, 64, 3); x.fillRect(0, 0, 3, 64); x.fillRect(61, 0, 3, 64);
        for (let y = 6; y < 58; y += 7) {
            x.fillStyle = '#1f232b'; x.fillRect(5, y, 54, 5);
            x.fillStyle = '#0b0d11'; x.fillRect(5, y + 5, 54, 1);
            x.fillStyle = '#3a404b'; x.fillRect(46, y + 1, 10, 3);
            for (let i = 0; i < 4; i++) { x.fillStyle = ['#7fd17f', '#d9b463', '#c8342a', '#7fd17f'][rnd() * 4 | 0]; x.fillRect(8 + rnd() * 34 | 0, y + 2, 2, 1); }
        }
    });
    const concrete = makeTex(x => {
        const rnd = seeded(29);
        x.fillStyle = '#4b453c'; x.fillRect(0, 0, 64, 64);
        x.fillStyle = '#2f2b25';
        for (let y = 0; y < 64; y += 16) {
            x.fillRect(0, y, 64, 2);
            for (let xx = (y / 16) % 2 ? 16 : 0; xx < 64; xx += 32) x.fillRect(xx, y, 2, 16);
        }
        grit(x, rnd, 420, 'rgba(0,0,0,0.22)', 'rgba(255,240,210,0.07)');
        x.fillStyle = '#2a2620'; x.fillRect(0, 58, 64, 6);
    });
    const exit = makeTex(x => {
        x.fillStyle = '#2b0d0a'; x.fillRect(0, 0, 64, 64);
        for (let y = 0; y < 64; y++) {
            if (y > 9 && y < 54) continue;
            for (let xx = 0; xx < 64; xx++) { x.fillStyle = ((xx + y) >> 2) & 1 ? '#d9b463' : '#1a1410'; x.fillRect(xx, y, 1, 1); }
        }
        x.fillStyle = '#14100c'; x.fillRect(31, 12, 2, 40);
        x.fillStyle = '#f3dc9a'; x.font = 'bold 13px monospace'; x.textAlign = 'center'; x.fillText('EXIT', 32, 37);
    });
    return { '#': gold, '=': server, '%': concrete, 'X': exit };
}

function buildGun() {
    const c = document.createElement('canvas'); c.width = 64; c.height = 72;
    const x = c.getContext('2d');
    x.fillStyle = '#1d1a15'; x.fillRect(14, 62, 44, 10);              // sleeve
    x.fillStyle = '#c8946a'; x.fillRect(20, 44, 32, 20); x.fillRect(24, 38, 8, 10); // hand + thumb
    x.fillStyle = '#9a6c4a'; x.fillRect(20, 52, 32, 1); x.fillRect(20, 57, 32, 1); x.fillRect(31, 38, 1, 10);
    x.fillStyle = '#5a4526'; x.fillRect(30, 40, 14, 6);              // grip top
    x.fillStyle = '#d9b463'; x.fillRect(29, 6, 16, 36);              // slide
    x.fillStyle = '#9c7b3c'; x.fillRect(41, 6, 4, 36);
    x.fillStyle = '#f3dc9a'; x.fillRect(29, 6, 2, 36);
    x.fillStyle = '#7a5f2e'; for (let y = 26; y < 38; y += 3) x.fillRect(31, y, 10, 1);
    x.fillStyle = '#2a2116'; x.fillRect(35, 3, 4, 3); x.fillRect(29, 38, 5, 4); x.fillRect(40, 38, 5, 4);
    return c;
}

// ---- sound: tiny synthesized blips ----
let ac = null;
function audio() { if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; } } return ac; }
function tone(freq, dur, type = 'square', vol = 0.06, slide = 0, delay = 0) {
    const a = audio(); if (!a) return;
    const t = a.currentTime + delay;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.linearRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol, cutoff) {
    const a = audio(); if (!a) return;
    const n = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    s.buffer = buf; f.type = 'lowpass'; f.frequency.value = cutoff; g.gain.value = vol;
    s.connect(f).connect(g).connect(a.destination); s.start();
}
const sfx = {
    shoot() { noise(0.12, 0.35, 2600); tone(170, 0.07, 'square', 0.05, -90); },
    enemyShot() { noise(0.1, 0.16, 900); },
    hit() { tone(110, 0.1, 'sawtooth', 0.06, -50); },
    kill() { tone(240, 0.18, 'square', 0.06, -170); },
    hurt() { tone(130, 0.2, 'sawtooth', 0.09, -70); },
    pickup() { tone(660, 0.07); tone(990, 0.1, 'square', 0.06, 0, 0.07); },
    deny() { tone(150, 0.3, 'square', 0.07); },
    grant() { [440, 660, 880].forEach((f, i) => tone(f, 0.12, 'square', 0.05, 0, i * 0.09)); },
    win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.2, 'square', 0.06, 0, i * 0.14)); },
    lose() { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.25, 'triangle', 0.08, 0, i * 0.18)); },
};

// ---- styles for the overlay ----
function injectStyles() {
    if (document.getElementById('ge-egg-style')) return;
    const st = document.createElement('style');
    st.id = 'ge-egg-style';
    st.textContent = `
#ge-egg { position: fixed; inset: 0; z-index: 2147483000; background: #050403; display: flex; align-items: center; justify-content: center; font-family: 'JetBrains Mono', ui-monospace, monospace; color: #e9dcc0; }
#ge-egg .ge-egg-stage { position: relative; background: #000; box-shadow: 0 0 0 1px #3a2e1b, 0 20px 80px rgba(0,0,0,.6); }
#ge-egg canvas { display: block; width: 100%; height: 100%; image-rendering: pixelated; image-rendering: crisp-edges; cursor: crosshair; }
#ge-egg .ge-egg-close { position: absolute; top: 14px; right: 16px; background: none; border: 1px solid #3a2e1b; color: #b8a682; width: 32px; height: 32px; border-radius: 3px; cursor: pointer; font: inherit; font-size: 14px; }
#ge-egg .ge-egg-close:hover { color: #f3dc9a; border-color: #d9b463; }
#ge-egg .ge-egg-panel { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 4%; background: rgba(8,6,4,.78); }
#ge-egg .ge-egg-panel.hidden { display: none; }
#ge-egg .ge-egg-card { width: min(560px, 100%); max-height: 100%; overflow: auto; border: 1px solid #5c4a2c; background: rgba(14,11,8,.94); padding: 22px 24px; border-radius: 3px; }
#ge-egg .lbl { font-size: 11px; letter-spacing: .18em; color: #b8944f; text-transform: uppercase; }
#ge-egg h2 { font-size: 22px; letter-spacing: .06em; margin: 8px 0 12px; color: #f3dc9a; font-weight: 700; }
#ge-egg p { font-size: 13px; line-height: 1.55; color: #cbbd9f; margin: 0 0 12px; }
#ge-egg .code { font-size: clamp(22px, 5vw, 38px); letter-spacing: .32em; color: #f3dc9a; margin: 10px 0 14px; text-shadow: 0 0 18px rgba(217,180,99,.35); }
#ge-egg form { display: flex; gap: 8px; margin-top: 6px; }
#ge-egg input { flex: 1; min-width: 0; background: #0b0907; border: 1px solid #5c4a2c; color: #f3dc9a; font: inherit; font-size: 15px; letter-spacing: .2em; padding: 9px 12px; text-transform: uppercase; border-radius: 2px; outline: none; }
#ge-egg input:focus { border-color: #d9b463; }
#ge-egg .btn { background: #d9b463; color: #1a1209; border: 0; font: inherit; font-weight: 700; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; padding: 10px 16px; cursor: pointer; border-radius: 2px; }
#ge-egg .btn.ghost { background: transparent; color: #d9b463; border: 1px solid #5c4a2c; }
#ge-egg .btn:focus-visible, #ge-egg .ge-egg-close:focus-visible { outline: 2px solid #f3dc9a; outline-offset: 2px; }
#ge-egg .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
#ge-egg .msg { min-height: 18px; font-size: 12px; margin-top: 10px; letter-spacing: .08em; }
#ge-egg .msg.bad { color: #e07a62; }
#ge-egg .msg.good { color: #9fd49a; }
#ge-egg .obj { list-style: none; padding: 0; margin: 0 0 12px; font-size: 13px; }
#ge-egg .obj li { padding: 5px 0; border-top: 1px solid #2c2318; display: flex; gap: 10px; }
#ge-egg .obj b { color: #d9b463; width: 14px; }
#ge-egg .obj .done { color: #9fd49a; margin-left: auto; }
#ge-egg table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
#ge-egg td, #ge-egg th { padding: 5px 4px; border-top: 1px solid #2c2318; text-align: left; }
#ge-egg th { color: #8f7d5c; font-weight: 400; letter-spacing: .1em; font-size: 10px; text-transform: uppercase; }
#ge-egg td.r, #ge-egg th.r { text-align: right; }
#ge-egg tr.me td { color: #f3dc9a; }
#ge-egg .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 6px 0 16px; }
#ge-egg .stats div { border: 1px solid #2c2318; padding: 10px; }
#ge-egg .stats span { display: block; font-size: 10px; letter-spacing: .14em; color: #8f7d5c; text-transform: uppercase; }
#ge-egg .stats strong { font-size: 20px; color: #f3dc9a; font-variant-numeric: tabular-nums; }
@keyframes ge-egg-shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
#ge-egg .shake { animation: ge-egg-shake .25s 2; }
@media (prefers-reduced-motion: reduce) { #ge-egg .shake { animation: none; } }
`;
    document.head.appendChild(st);
}

const fmtTime = (ms) => { const s = ms / 1000; return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`; };

// ---- the game ----
function start(opts = {}) {
    if (document.getElementById('ge-egg')) return;
    injectStyles();
    const TEX = buildTextures();
    const SPR = { guard: spriteFrom(GUARD), fire: spriteFrom(GUARD_FIRE), corpse: spriteFrom(CORPSE), checkin: spriteFrom(CHECKIN), coffee: spriteFrom(COFFEE) };
    const GUN = buildGun();

    const root = document.createElement('div');
    root.id = 'ge-egg';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Golden Eye mission');
    root.innerHTML = `<div class="ge-egg-stage"><canvas width="${W}" height="${H}" tabindex="0"></canvas><div class="ge-egg-panel"></div></div>
        <button class="ge-egg-close" type="button" title="Close (Esc)" aria-label="Close">✕</button>`;
    document.body.appendChild(root);
    const stage = root.querySelector('.ge-egg-stage');
    const canvas = root.querySelector('canvas');
    const panel = root.querySelector('.ge-egg-panel');
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const img = ctx.createImageData(W, H);
    const buf = new Uint32Array(img.data.buffer);
    const zbuf = new Float32Array(W);

    const fit = () => {
        const w = Math.min(window.innerWidth * 0.96, window.innerHeight * 0.92 * (W / H));
        stage.style.width = w + 'px'; stage.style.height = (w * H / W) + 'px';
    };
    fit();

    let mode = 'cipher';      // cipher | brief | play | pause | end
    let G = null, raf = 0, last = performance.now(), mouseDown = false, attempts = 0, clock = 0;
    const keys = {};
    const touchOnly = window.matchMedia && !window.matchMedia('(pointer: fine)').matches;

    function newGame() {
        const m = parseMap(MAP);
        G = {
            grid: m.grid, exit: m.exit, px: m.start.x, py: m.start.y, dx: 1, dy: 0, plx: 0, ply: 0.66, hp: 100,
            enemies: m.ents.filter(e => e.kind === 'enemy').map((e, i) => ({ ...e, hp: 2, alive: true, alert: false, cd: 1 + (i % 3) * 0.4, flash: 0, hurt: 0, walk: i })),
            items: m.ents.filter(e => e.kind !== 'enemy').map(e => ({ ...e, taken: false })),
            checkins: 0, kills: 0, shots: 0, hits: 0, time: 0, fireCd: 0, recoil: 0, gunFlash: 0,
            dmgFlash: 0, pickFlash: 0, msgs: [], bob: 0, exitWarn: 0,
        };
    }
    const objA = () => G.checkins >= NEED_CHECKINS;
    const objB = () => G.kills >= NEED_KILLS;
    const say = (t) => { G.msgs.push({ t, until: clock + 2.6 }); if (G.msgs.length > 3) G.msgs.shift(); };

    function rotate(a) {
        const c = Math.cos(a), s = Math.sin(a);
        [G.dx, G.dy] = [G.dx * c - G.dy * s, G.dx * s + G.dy * c];
        [G.plx, G.ply] = [G.plx * c - G.ply * s, G.plx * s + G.ply * c];
    }
    const blocked = (x, y, r) => isWall(G.grid, x - r, y - r) || isWall(G.grid, x + r, y - r) || isWall(G.grid, x - r, y + r) || isWall(G.grid, x + r, y + r);
    function sight(ax, ay, bx, by) {
        const d = Math.hypot(bx - ax, by - ay), n = Math.ceil(d / 0.15);
        for (let i = 1; i < n; i++) { const t = i / n; if (isWall(G.grid, ax + (bx - ax) * t, ay + (by - ay) * t)) return false; }
        return true;
    }

    function fire() {
        G.fireCd = 0.28; G.shots++; G.recoil = 1; G.gunFlash = 0.06;
        sfx.shoot();
        G.enemies.forEach(e => { if (e.alive && Math.hypot(e.x - G.px, e.y - G.py) < 7) e.alert = true; });
        const invDet = 1 / (G.plx * G.dy - G.dx * G.ply);
        let best = null, bestDepth = zbuf[W >> 1];
        for (const e of G.enemies) {
            if (!e.alive) continue;
            const sx = e.x - G.px, sy = e.y - G.py;
            const tx = invDet * (G.dy * sx - G.dx * sy), ty = invDet * (-G.ply * sx + G.plx * sy);
            if (ty <= 0.1 || ty >= bestDepth) continue;
            const screenX = (W / 2) * (1 + tx / ty);
            const halfW = (H / ty) * 0.78 * (16 / 24) * 0.4;
            if (Math.abs(screenX - W / 2) < halfW) { best = e; bestDepth = ty; }
        }
        if (!best) return;
        G.hits++; best.hp--; best.hurt = 0.15; best.alert = true;
        if (best.hp <= 0) {
            best.alive = false; G.kills++; sfx.kill();
            say(`CPL spike neutralized (${Math.min(G.kills, NEED_KILLS)}/${NEED_KILLS})`);
            if (G.kills === NEED_KILLS) say(objA() ? 'Objective B complete. Get to the EXIT.' : 'Objective B complete');
        } else sfx.hit();
    }

    function damage(n) {
        G.hp -= n; G.dmgFlash = 0.35; sfx.hurt();
        if (G.hp <= 0) { G.hp = 0; endGame(false); }
    }

    function update(dt) {
        clock += dt;
        G.time += dt;
        const sp = 3 * dt;
        let mx = 0, my = 0;
        if (keys.KeyW || keys.ArrowUp) { mx += G.dx; my += G.dy; }
        if (keys.KeyS || keys.ArrowDown) { mx -= G.dx; my -= G.dy; }
        if (keys.KeyA) { mx += G.dy; my -= G.dx; }
        if (keys.KeyD) { mx -= G.dy; my += G.dx; }
        if (keys.ArrowLeft || keys.KeyQ) rotate(-2.4 * dt);
        if (keys.ArrowRight || keys.KeyE) rotate(2.4 * dt);
        const len = Math.hypot(mx, my);
        if (len > 0) {
            mx /= len; my /= len;
            const nx = G.px + mx * sp, ny = G.py + my * sp;
            if (!blocked(nx, G.py, 0.22)) G.px = nx;
            if (!blocked(G.px, ny, 0.22)) G.py = ny;
            G.bob += dt * 9;
        }
        G.fireCd -= dt; G.recoil = Math.max(0, G.recoil - dt * 6); G.gunFlash -= dt;
        G.dmgFlash = Math.max(0, G.dmgFlash - dt); G.pickFlash = Math.max(0, G.pickFlash - dt);
        if ((keys.Space || mouseDown) && G.fireCd <= 0) fire();

        for (const e of G.enemies) {
            if (!e.alive) continue;
            e.flash -= dt; e.hurt -= dt;
            const d = Math.hypot(G.px - e.x, G.py - e.y);
            const los = d < 11 && sight(e.x, e.y, G.px, G.py);
            if (los && d < 9 && !e.alert) { e.alert = true; e.cd = Math.max(e.cd, 0.7); }
            if (!e.alert) continue;
            if (d > 2.2) {
                const s = 1.3 * dt, ux = (G.px - e.x) / d, uy = (G.py - e.y) / d;
                if (!blocked(e.x + ux * s, e.y, 0.25)) e.x += ux * s;
                if (!blocked(e.x, e.y + uy * s, 0.25)) e.y += uy * s;
                e.walk += dt * 8;
            }
            e.cd -= dt;
            if (los && e.cd <= 0) {
                e.cd = 1.3 + Math.random() * 1.1; e.flash = 0.14; sfx.enemyShot();
                if (Math.random() < Math.min(0.65, Math.max(0.2, 0.7 - d * 0.05))) damage(7 + (Math.random() * 6 | 0));
                if (mode !== 'play') return;
            }
        }

        for (const it of G.items) {
            if (it.taken || Math.hypot(it.x - G.px, it.y - G.py) > 0.6) continue;
            if (it.kind === 'checkin') {
                it.taken = true; G.checkins++; G.pickFlash = 0.3; sfx.pickup();
                say(`Check-in recovered (${G.checkins}/${NEED_CHECKINS})`);
                if (G.checkins === NEED_CHECKINS) say(objB() ? 'Objective A complete. Get to the EXIT.' : 'Objective A complete');
            } else if (G.hp < 100) {
                it.taken = true; G.hp = Math.min(100, G.hp + 30); G.pickFlash = 0.3; sfx.pickup();
                say('Cold brew. +30 health');
            }
        }

        if (Math.hypot(G.exit.x - G.px, G.exit.y - G.py) < 1.3) {
            if (objA() && objB()) endGame(true);
            else if (clock > G.exitWarn) { G.exitWarn = clock + 3; sfx.deny(); say('Exit locked. Finish objectives A and B.'); }
        }
    }

    // Floor and ceiling (cast per row), walls (one ray per column), then billboards.
    const FA = rgb('#4a3e2e'), FB = rgb('#3e3427'), GR = rgb('#1e1913'), CE = rgb('#28221b'), CL = rgb('#1c1712'), LI = rgb('#ffecbe');
    function render(dim) {
        const { px, py, dx, dy, plx, ply, grid } = G;
        const r0x = dx - plx, r0y = dy - ply, r1x = dx + plx, r1y = dy + ply, half = H / 2;
        for (let y = half; y < H; y++) {
            const rowDist = half / (y - half + 1), f = fog(rowDist);
            const sx = rowDist * (r1x - r0x) / W, sy = rowDist * (r1y - r0y) / W;
            let fx = px + rowDist * r0x, fy = py + rowDist * r0y;
            const a = shade(FA, f), b = shade(FB, f), g = shade(GR, f), c = shade(CE, f), cl = shade(CL, f), li = shade(LI, Math.min(1, f * 1.4));
            const fo = y * W, co = (H - y - 1) * W;
            for (let x = 0; x < W; x++) {
                const cx = Math.floor(fx), cy = Math.floor(fy), tx = fx - cx, ty = fy - cy;
                buf[fo + x] = (tx < 0.05 || ty < 0.05) ? g : ((cx + cy) & 1 ? a : b);
                buf[co + x] = (cx % 3 === 1 && cy % 3 === 1 && tx > 0.25 && tx < 0.75 && ty > 0.25 && ty < 0.75) ? li : (tx < 0.03 || ty < 0.03) ? cl : c;
                fx += sx; fy += sy;
            }
        }
        for (let x = 0; x < W; x++) {
            const cam = 2 * x / W - 1, rx = dx + plx * cam, ry = dy + ply * cam;
            let mx = px | 0, my = py | 0;
            const ddx = Math.abs(1 / rx), ddy = Math.abs(1 / ry);
            const stx = rx < 0 ? -1 : 1, sty = ry < 0 ? -1 : 1;
            let sdx = rx < 0 ? (px - mx) * ddx : (mx + 1 - px) * ddx;
            let sdy = ry < 0 ? (py - my) * ddy : (my + 1 - py) * ddy;
            let side = 0, ch = '%';
            for (let i = 0; i < 64; i++) {
                if (sdx < sdy) { sdx += ddx; mx += stx; side = 0; } else { sdy += ddy; my += sty; side = 1; }
                const c = grid[my]?.[mx];
                if (c !== '.') { ch = c || '%'; break; }
            }
            const perp = Math.max(0.05, side === 0 ? sdx - ddx : sdy - ddy);
            const lh = H / perp, ds = half - lh / 2;
            let wx = side === 0 ? py + perp * ry : px + perp * rx; wx -= Math.floor(wx);
            let tx = (wx * 64) | 0;
            if ((side === 0 && rx > 0) || (side === 1 && ry < 0)) tx = 63 - tx;
            const tex = TEX[ch] || TEX['%'], f = fog(perp) * (side ? 0.72 : 1);
            const y0 = Math.max(0, Math.ceil(ds)), y1 = Math.min(H, Math.ceil(ds + lh));
            const step = 64 / lh;
            let tp = (y0 - ds) * step;
            for (let y = y0; y < y1; y++) { buf[y * W + x] = shade(tex[((tp | 0) & 63) * 64 + tx], f); tp += step; }
            zbuf[x] = perp;
        }

        const sprites = [];
        for (const e of G.enemies) {
            if (e.alive) sprites.push({ x: e.x, y: e.y, s: e.flash > 0 ? SPR.fire : SPR.guard, hs: 0.78, lift: Math.abs(Math.sin(e.walk)) * 0.02, bright: e.hurt > 0 ? 1.8 : 1 });
            else sprites.push({ x: e.x, y: e.y, s: SPR.corpse, hs: 0.16, lift: 0, bright: 1 });
        }
        for (const it of G.items) {
            if (it.taken) continue;
            if (it.kind === 'checkin') sprites.push({ x: it.x, y: it.y, s: SPR.checkin, hs: 0.3, lift: 0.18 + Math.sin(clock * 3 + it.x) * 0.04, bright: 1.15 });
            else sprites.push({ x: it.x, y: it.y, s: SPR.coffee, hs: 0.22, lift: 0, bright: 1 });
        }
        sprites.forEach(s => { s.d = (s.x - px) ** 2 + (s.y - py) ** 2; });
        sprites.sort((a, b) => b.d - a.d);
        const invDet = 1 / (plx * dy - dx * ply);
        for (const sp of sprites) {
            const sx = sp.x - px, sy = sp.y - py;
            const tX = invDet * (dy * sx - dx * sy), tY = invDet * (-ply * sx + plx * sy);
            if (tY <= 0.1) continue;
            const scr = (W / 2) * (1 + tX / tY), lh = H / tY;
            const sh = lh * sp.hs, sw = sh * sp.s.w / sp.s.h;
            const top = half + lh / 2 - sh - sp.lift * lh, left = scr - sw / 2;
            const x0 = Math.max(0, Math.ceil(left)), x1 = Math.min(W, Math.ceil(left + sw));
            const y0 = Math.max(0, Math.ceil(top)), y1 = Math.min(H, Math.ceil(top + sh));
            const f = fog(tY) * sp.bright, { pix, w, h } = sp.s;
            for (let x = x0; x < x1; x++) {
                if (tY >= zbuf[x]) continue;
                const tx = ((x - left) * w / sw) | 0;
                for (let y = y0; y < y1; y++) {
                    const c = pix[(((y - top) * h / sh) | 0) * w + tx];
                    if (c) buf[y * W + x] = shade(c, f);
                }
            }
        }
        if (dim) for (let i = 0; i < buf.length; i++) buf[i] = shade(buf[i], 0.45);
        ctx.putImageData(img, 0, 0);
        if (dim) return;

        // Gun, crosshair, HUD
        const gx = W / 2 + 30 + Math.sin(G.bob) * 3, gy = H - 64 + Math.abs(Math.cos(G.bob)) * 3 + G.recoil * 9;
        if (G.gunFlash > 0) {
            ctx.fillStyle = '#fff6c8'; ctx.beginPath(); ctx.moveTo(gx + 37, gy - 14); ctx.lineTo(gx + 43, gy - 2); ctx.lineTo(gx + 31, gy - 2); ctx.fill();
            ctx.fillStyle = '#ffd25a'; ctx.fillRect(gx + 30, gy - 4, 14, 5);
        }
        ctx.drawImage(GUN, Math.round(gx), Math.round(gy));
        ctx.fillStyle = '#f3dc9a';
        ctx.fillRect(W / 2 - 5, H / 2, 3, 1); ctx.fillRect(W / 2 + 3, H / 2, 3, 1); ctx.fillRect(W / 2, H / 2 - 5, 1, 3); ctx.fillRect(W / 2, H / 2 + 3, 1, 3);

        if (G.dmgFlash > 0) { ctx.fillStyle = `rgba(200,40,30,${G.dmgFlash * 0.7})`; ctx.fillRect(0, 0, W, H); }
        if (G.pickFlash > 0) { ctx.fillStyle = `rgba(217,180,99,${G.pickFlash * 0.5})`; ctx.fillRect(0, 0, W, H); }

        ctx.font = '8px "JetBrains Mono", monospace';
        ctx.textBaseline = 'top';
        const label = (t, x, y, col = '#f3dc9a', align = 'left') => { ctx.textAlign = align; ctx.fillStyle = '#000'; ctx.fillText(t, x + 1, y + 1); ctx.fillStyle = col; ctx.fillText(t, x, y); };
        label(fmtTime(G.time * 1000), W - 6, 37, '#b8a682', 'right');
        label(`A ${objA() ? '✓' : G.checkins + '/' + NEED_CHECKINS} check-ins`, W - 6, 5, objA() ? '#9fd49a' : '#f3dc9a', 'right');
        label(`B ${objB() ? '✓' : G.kills + '/' + NEED_KILLS} CPL spikes`, W - 6, 15, objB() ? '#9fd49a' : '#f3dc9a', 'right');
        label(`C ${objA() && objB() ? 'get to EXIT' : 'locked'}`, W - 6, 25, objA() && objB() ? '#f3dc9a' : '#8f7d5c', 'right');
        G.msgs = G.msgs.filter(m => m.until > clock);
        G.msgs.forEach((m, i) => label(m.t, 6, 5 + i * 10));
        ctx.fillStyle = '#000'; ctx.fillRect(6, H - 13, 62, 8);
        ctx.fillStyle = G.hp > 35 ? '#d9b463' : '#e07a62'; ctx.fillRect(7, H - 12, 60 * G.hp / 100, 6);
        label(`${Math.ceil(G.hp)}`, 72, H - 14, G.hp > 35 ? '#f3dc9a' : '#e07a62');
    }

    function loop(t) {
        raf = requestAnimationFrame(loop);
        const dt = Math.min(0.05, (t - last) / 1000); last = t;
        if (mode === 'play') update(dt);
        else if (mode === 'cipher' || mode === 'brief') { clock += dt; rotate(dt * 0.25); }
        if (G) render(mode === 'cipher' || mode === 'brief');
    }

    // ---- panels ----
    const card = (html) => { panel.innerHTML = `<div class="ge-egg-card">${html}</div>`; panel.classList.remove('hidden'); return panel.firstElementChild; };
    const hidePanel = () => panel.classList.add('hidden');
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function showCipher() {
        mode = 'cipher';
        const el = card(`
            <div class="lbl">Incoming transmission · classified</div>
            <div class="code" aria-label="Encrypted word">${CIPHER.split('').join(' ')}</div>
            <p>Every letter has been moved <b>007</b> places forward.<br>Where did GoldenEye strike first?</p>
            <form><input aria-label="Decrypted word" maxlength="20" autocomplete="off" spellcheck="false" placeholder="Decrypted word"><button class="btn" type="submit">Decrypt</button></form>
            <div class="msg" aria-live="polite"></div>`);
        const input = el.querySelector('input'), msg = el.querySelector('.msg');
        setTimeout(() => input.focus(), 30);
        el.querySelector('form').addEventListener('submit', (ev) => {
            ev.preventDefault();
            const guess = input.value.toUpperCase().replace(/[^A-Z]/g, '');
            if (!guess) return;
            if (guess === ANSWER) { sfx.grant(); showBrief(); return; }
            attempts++; sfx.deny();
            msg.className = 'msg bad';
            msg.textContent = attempts >= 4 ? 'Access denied. Hint: a Siberian site. Starts with S, ends with A.'
                : attempts >= 2 ? 'Access denied. Hint: move each letter back 7. Z becomes S.'
                : 'Access denied.';
            el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
            input.select();
        });
    }

    function objectivesHtml() {
        const done = (b) => b ? '<span class="done">done</span>' : '';
        return `<ul class="obj">
            <li><b>A</b> Recover ${NEED_CHECKINS} missing weekly check-ins ${G && G.time ? done(objA()) : ''}</li>
            <li><b>B</b> Neutralize ${NEED_KILLS} CPL spikes ${G && G.time ? done(objB()) : ''}</li>
            <li><b>C</b> Get to the exit</li></ul>`;
    }

    function showBrief() {
        mode = 'brief';
        const el = card(`
            <div class="lbl" style="color:#9fd49a;">Access granted</div>
            <h2>Mission: Facility</h2>
            <p>The weekly check-ins have gone missing somewhere in the facility, and the cost-per-lead spikes guarding them shoot on sight.</p>
            ${objectivesHtml()}
            <p style="font-size:12px; color:#8f7d5c;">W A S D to move · mouse or ← → to turn · click or Space to fire · Esc to pause</p>
            ${touchOnly ? '<p class="msg bad">This mission needs a keyboard and mouse. Try it on a computer.</p>' : ''}
            <div class="row"><button class="btn" type="button" data-act="go"${touchOnly ? ' disabled' : ''}>Start mission</button>
            <button class="btn ghost" type="button" data-act="board">Leaderboard</button></div>
            <div class="board"></div>`);
        el.querySelector('[data-act="go"]').addEventListener('click', begin);
        el.querySelector('[data-act="board"]').addEventListener('click', () => loadBoard(el.querySelector('.board')));
        setTimeout(() => el.querySelector('[data-act="go"]')?.focus(), 30);
    }

    function lock() {
        try { const p = canvas.requestPointerLock && canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* keyboard turning still works */ }
    }

    function begin() {
        newGame();
        clock = 0;
        mode = 'play'; hidePanel(); canvas.focus(); lock();
        say('Find the check-ins. Mind the spikes.');
    }

    function pause() {
        if (mode !== 'play') return;
        mode = 'pause'; mouseDown = false;
        Object.keys(keys).forEach(k => { keys[k] = false; });
        const el = card(`
            <div class="lbl">Mission paused · ${fmtTime(G.time * 1000)}</div>
            <h2>Watch</h2>
            ${objectivesHtml()}
            <div class="row"><button class="btn" type="button" data-act="resume">Resume</button>
            <button class="btn ghost" type="button" data-act="abort">Abort mission</button></div>`);
        el.querySelector('[data-act="resume"]').addEventListener('click', () => { mode = 'play'; hidePanel(); canvas.focus(); lock(); });
        el.querySelector('[data-act="abort"]').addEventListener('click', close);
        setTimeout(() => el.querySelector('[data-act="resume"]')?.focus(), 30);
    }

    function endGame(won) {
        mode = 'end'; mouseDown = false;
        Object.keys(keys).forEach(k => { keys[k] = false; });
        try { document.exitPointerLock && document.exitPointerLock(); } catch (e) { /* ignore */ }
        const ms = Math.round(G.time * 1000);
        const acc = G.shots ? Math.round(G.hits / G.shots * 1000) / 10 : 0;
        (won ? sfx.win : sfx.lose)();
        const el = card(`
            <div class="lbl" style="color:${won ? '#9fd49a' : '#e07a62'};">${won ? 'Mission complete' : 'Mission failed'}</div>
            <h2>${won ? 'The check-ins are home.' : 'The spikes got you.'}</h2>
            <div class="stats"><div><span>Time</span><strong>${fmtTime(ms)}</strong></div>
            <div><span>Spikes</span><strong>${G.kills}</strong></div><div><span>Accuracy</span><strong>${acc}%</strong></div></div>
            <div class="board">${won ? '<p>Saving your time…</p>' : ''}</div>
            <div class="row"><button class="btn" type="button" data-act="again">${won ? 'Play again' : 'Retry'}</button>
            <button class="btn ghost" type="button" data-act="close">Close</button></div>`);
        el.querySelector('[data-act="again"]').addEventListener('click', begin);
        el.querySelector('[data-act="close"]').addEventListener('click', close);
        setTimeout(() => el.querySelector('[data-act="again"]')?.focus(), 30);
        const board = el.querySelector('.board');
        if (!won) return;
        Promise.resolve(opts.saveScore ? opts.saveScore({ time_ms: ms, kills: G.kills, accuracy: acc }) : null)
            .then(res => loadBoard(board, res && res.error ? res.error : null))
            .catch(err => loadBoard(board, err));
    }

    const setupMsg = (err) => /egg_runs|42P01|PGRST20/.test(`${err?.code || ''} ${err?.message || ''}`)
        ? 'The leaderboard isn\'t set up yet: run supabase/sql/egg_runs.sql.' : 'Couldn\'t reach the leaderboard.';

    function loadBoard(box, saveErr) {
        if (!box) return;
        box.innerHTML = '<p>Loading leaderboard…</p>';
        if (!opts.loadScores) { box.innerHTML = ''; return; }
        Promise.resolve(opts.loadScores()).then(({ data, error } = {}) => {
            if (error) { box.innerHTML = `<p class="msg bad">${esc(setupMsg(error))}</p>`; return; }
            const best = new Map();
            (data || []).forEach(r => { const k = String(r.player_email || '').toLowerCase(); if (!best.has(k) || r.time_ms < best.get(k).time_ms) best.set(k, r); });
            const rows = [...best.values()].sort((a, b) => a.time_ms - b.time_ms).slice(0, 10);
            const me = String(opts.playerEmail || '').toLowerCase();
            const warn = saveErr ? `<p class="msg bad">${esc(setupMsg(saveErr))}</p>` : '';
            box.innerHTML = warn + (rows.length ? `<table><thead><tr><th>#</th><th>Agent</th><th class="r">Time</th><th class="r">Accuracy</th></tr></thead><tbody>${rows.map((r, i) =>
                `<tr${String(r.player_email || '').toLowerCase() === me ? ' class="me"' : ''}><td>${i + 1}</td><td>${esc(r.player_name || String(r.player_email || '').split('@')[0])}</td><td class="r">${fmtTime(r.time_ms)}</td><td class="r">${r.accuracy ?? '—'}%</td></tr>`).join('')}</tbody></table>`
                : '<p>No times yet. Be the first.</p>');
        }).catch(err => { box.innerHTML = `<p class="msg bad">${esc(setupMsg(err))}</p>`; });
    }

    // ---- input ----
    const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
    function onKeyDown(e) {
        e.stopPropagation();   // keep the dashboard's own shortcuts out of it
        if (e.key === 'Escape') {
            e.preventDefault();
            if (mode === 'play') pause();
            else if (mode !== 'pause') close();
            return;
        }
        if (mode === 'play') {
            if (GAME_KEYS.has(e.code)) { e.preventDefault(); keys[e.code] = true; }
            if (e.code === 'KeyP') pause();
        }
    }
    function onKeyUp(e) { e.stopPropagation(); if (GAME_KEYS.has(e.code)) keys[e.code] = false; }
    function onMouseMove(e) { if (mode === 'play' && document.pointerLockElement === canvas) rotate((e.movementX || 0) * 0.0032); }
    function onLockChange() { if (document.pointerLockElement !== canvas && mode === 'play') pause(); }
    function onBlur() { Object.keys(keys).forEach(k => { keys[k] = false; }); mouseDown = false; if (mode === 'play') pause(); }
    canvas.addEventListener('mousedown', (e) => {
        if (mode !== 'play') return;
        e.preventDefault();
        if (document.pointerLockElement !== canvas) lock();
        mouseDown = true;
    });
    window.addEventListener('mouseup', () => { mouseDown = false; });
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('resize', fit);
    window.addEventListener('blur', onBlur);
    document.addEventListener('pointerlockchange', onLockChange);
    root.querySelector('.ge-egg-close').addEventListener('click', close);

    function close() {
        cancelAnimationFrame(raf);
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keyup', onKeyUp, true);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('resize', fit);
        window.removeEventListener('blur', onBlur);
        document.removeEventListener('pointerlockchange', onLockChange);
        try { if (document.pointerLockElement === canvas) document.exitPointerLock(); } catch (e) { /* ignore */ }
        root.remove();
        if (opts.onClose) opts.onClose();
    }

    newGame();
    showCipher();
    raf = requestAnimationFrame(loop);
    // Local preview only: lets a test drive the game state
    if (location.hostname === 'localhost') window.__geEggDebug = { get G() { return G; }, endGame, fire, rotate, get mode() { return mode; } };
}

window.GEEgg = { start, _test: { caesar, parseMap, reachable, MAP, CIPHER, ANSWER, SHIFT, NEED_CHECKINS, NEED_KILLS } };
})();
