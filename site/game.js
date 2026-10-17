(() => {
  'use strict';

  const RIVER = window.RIVER;
  const $ = (id) => document.getElementById(id);
  const cv = $('game'), ctx = cv.getContext('2d');
  const mm = $('minimap'), mctx = mm.getContext('2d');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // halfSpan = boat centreline to oar blade tip (m); yaw = max turn rate (rad/s)
  const BOATS = {
    '1x': { seats: 1, sweep: false, len: 8.2, halfSpan: 3.1, speedK: 1.0, yaw: 0.16 },
    '2x': { seats: 2, sweep: false, len: 9.9, halfSpan: 3.1, speedK: 1.08, yaw: 0.13 },
    '4x': { seats: 4, sweep: false, len: 13.4, halfSpan: 3.1, speedK: 1.17, yaw: 0.10 },
    '8+': { seats: 8, sweep: true, len: 17.5, halfSpan: 3.3, speedK: 1.25, yaw: 0.08 },
  };

  // Lanes are fixed in the high-water river; offsets as a fraction of total high-water width
  const LANE_OFFSET = 0.22;
  const INSHORE = 0.25; // Inshore Zones = outer quarter of the river on each side; Fairway = middle half
  const CODE_GRACE = 4; // seconds out of position before a Tideway Code penalty
  const CODE_PENALTY = 5;
  const DOCK_RADIUS = 45; // metres from the pontoon within which you can get off the boat
  const LOW_WATER = { straight: 0.68, insideBend: 0.33, outsideBend: 0.17 };

  // ---------- Route ----------
  function smooth(arr, k) {
    const n = arr.length;
    return arr.map((_, i) => {
      let a = 0, c = 0;
      for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) { a += arr[j]; c++; }
      return a / c;
    });
  }

  function buildRoute(dir) {
    const step = RIVER.step;
    let raw = RIVER.points.map((p) => ({ x: p[0], y: p[1], hwL: p[2], hwR: p[3], oL: p[4], oR: p[5] }));
    const total = (raw.length - 1) * step;
    let bridges = RIVER.bridges.map((b) => ({ name: b.name, s: b.s, poly: b.poly }));
    if (dir === 'down') {
      raw = raw.reverse().map((p) => ({ x: p.x, y: p.y, hwL: p.hwR, hwR: p.hwL, oL: p.oR, oR: p.oL }));
      bridges = bridges.map((b) => ({ ...b, s: total - b.s })).reverse();
    }
    const n = raw.length;
    const hwL = smooth(raw.map((p) => p.hwL), 2);
    const hwR = smooth(raw.map((p) => p.hwR), 2);
    const oL = smooth(raw.map((p) => p.oL), 2);
    const oR = smooth(raw.map((p) => p.oR), 2);
    const laneL = smooth(hwL, 10), laneR = smooth(hwR, 10);

    const th = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
      th[i] = Math.atan2(raw[b].y - raw[a].y, raw[b].x - raw[a].x);
      if (i > 0) {
        while (th[i] - th[i - 1] > Math.PI) th[i] -= 2 * Math.PI;
        while (th[i] - th[i - 1] < -Math.PI) th[i] += 2 * Math.PI;
      }
    }
    const k0 = th.map((_, i) => {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      return (th[b] - th[a]) / ((b - a) * step);
    });
    const kap = smooth(k0, 8); // >0 = turning left

    const pts = raw.map((p, i) => {
      const bend = clamp(Math.abs(kap[i]) * 900, 0, 1);
      const fin = LOW_WATER.straight - LOW_WATER.insideBend * bend;
      const fout = LOW_WATER.straight + LOW_WATER.outsideBend * bend;
      const leftInside = kap[i] > 0;
      return {
        x: p.x, y: p.y, th: th[i], k: kap[i], hwL: hwL[i], hwR: hwR[i], oL: oL[i], oR: oR[i], laneL: laneL[i], laneR: laneR[i],
        lwL: hwL[i] * (leftInside ? fin : fout),
        lwR: hwR[i] * (leftInside ? fout : fin),
      };
    });

    const leftBank = dir === 'up' ? 'Surrey' : 'Middlesex';
    const rightBank = dir === 'up' ? 'Middlesex' : 'Surrey';

    // Turns: continuous runs of significant curvature with a meaningful total heading change
    const bends = [];
    const TH = 1 / 1400;
    for (let i = 0; i < n;) {
      if (Math.abs(kap[i]) > TH) {
        const sg = Math.sign(kap[i]);
        let j = i, kmax = 0, apex = i;
        while (j < n && Math.sign(kap[j]) === sg && Math.abs(kap[j]) > TH * 0.6) {
          if (Math.abs(kap[j]) > kmax) { kmax = Math.abs(kap[j]); apex = j; }
          j++;
        }
        const turn = th[j - 1] - th[i];
        if (Math.abs(turn) > 0.2) {
          bends.push({
            s0: i * step, s1: (j - 1) * step, apex: apex * step,
            dir: sg > 0 ? 'left' : 'right',
            angle: Math.round(Math.abs(turn) * 180 / Math.PI),
            radius: Math.round(1 / kmax / 10) * 10,
            inside: sg > 0 ? leftBank : rightBank,
          });
        }
        i = j;
      } else i++;
    }
    bends.forEach((b, i) => { b.id = i + 1; });

    const route = {
      dir, step, n, pts, total, bridges, bends, leftBank, rightBank,
    };
    addCodeFeatures(route);
    return route;
  }

  // Nearest point on the centreline: returns {s, d} (d > 0 = left of travel direction)
  function project(route, x, y) {
    let best = Infinity, bs = 0, bd = 0;
    for (let i = 1; i < route.n; i++) {
      const a = route.pts[i - 1], b = route.pts[i];
      const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
      const t = clamp(((x - a.x) * dx + (y - a.y) * dy) / L2, 0, 1);
      const qx = a.x + t * dx - x, qy = a.y + t * dy - y, dd = qx * qx + qy * qy;
      if (dd < best) {
        best = dd; bs = (i - 1 + t) * route.step;
        bd = ((x - a.x) * -dy + (y - a.y) * dx) / Math.sqrt(L2);
      }
    }
    return { s: bs, d: bd };
  }

  function rectPoly(route, s, d, len, w) {
    return [[-len / 2, -w / 2], [len / 2, -w / 2], [len / 2, w / 2], [-len / 2, w / 2]].map(([ds, dd]) => {
      const p = sample(route, s + ds), q = worldPos(p, d + dd);
      return [q.x, q.y];
    });
  }

  // Bridge pier layout (estimated – piers are not mapped in OSM). Arches are numbered from the Middlesex bank (#1).
  const BRIDGE_SPECS = {
    'Hammersmith Bridge': { mode: 'centre', half: 64, w: 7, len: 14 },  // 128.6 m main span between the towers
    'Barnes Bridge': { mode: 'thirds', w: 4, len: 10 },                // three equal bowstring spans
    'Chiswick Bridge': { mode: 'centre', half: 26, w: 8, len: 16 },     // ~46 m central concrete arch
  };

  // Tideway Code geography, Upper Tideway Code Area (PLA Tideway Code, Chiswick Bridge to Putney section)
  function addCodeFeatures(route) {
    const up = route.dir === 'up';
    const middlesexIsLeft = !up;

    route.buoys = RIVER.buoys.map((b) => ({ ...b, ...project(route, b.x, b.y) }));
    route.landmarks = RIVER.landmarks.map((l) => ({ ...l, ...project(route, l.x, l.y) }));
    const byName = (n) => route.buoys.find((b) => b.name === n).s;
    const steps = [byName('Chiswick Steps Buoy'), byName('LEP Buoy')];
    const brS = (name) => route.bridges.find((b) => b.name === name).s;
    route.crossings = [
      { name: 'Hammersmith local crossing', s0: brS('Hammersmith Bridge') - 180, s1: brS('Hammersmith Bridge') + 180 },
      { name: 'Chiswick Steps Crossing Zone', s0: Math.min(...steps) - 80, s1: Math.max(...steps) + 80 },
      { name: 'Chiswick Bridge Crossing Zone', s0: brS('Chiswick Bridge') - 150, s1: brS('Chiswick Bridge') + 150 },
    ];
    // Slack (inside-of-bend) bank when rowing against the stream: Surrey below Chiswick Steps, Middlesex above
    const stepsUp = up ? Math.max(...steps) : route.total - Math.min(...steps);
    route.slackSideAt = (s) => {
      const sUp = up ? s : route.total - s;
      const bank = sUp < stepsUp ? 'Surrey' : 'Middlesex';
      return { bank, side: (bank === 'Middlesex') === middlesexIsLeft ? 'left' : 'right' };
    };

    route.obstacles = [];
    route.arches = [];
    route.bridges.forEach((b) => {
      const spec = BRIDGE_SPECS[b.name];
      if (!spec) return;
      const p = sample(route, b.s);
      const W = p.hwL + p.hwR, c = (p.hwL - p.hwR) / 2;
      const ds = spec.mode === 'thirds' ? [-p.hwR + W / 3, -p.hwR + 2 * W / 3] : [c - spec.half, c + spec.half];
      const edges = [-p.hwR, ...ds, p.hwL];
      ds.forEach((d) => route.obstacles.push({ name: `${b.name} pier`, poly: rectPoly(route, b.s, d, spec.len, spec.w), bridge: true }));
      b.archCentres = [];
      for (let i = 0; i < 3; i++) {
        const mid = (edges[i] + edges[i + 1]) / 2;
        // Number from the Middlesex bank
        const num = middlesexIsLeft ? 3 - i : i + 1;
        b.archCentres.push({ d: mid, lo: edges[i], hi: edges[i + 1], num });
        route.arches.push({ s: b.s, d: mid, label: `#${num}` });
      }
    });
    RIVER.piers.forEach((pr) => route.obstacles.push({ name: pr.name || 'pontoon', poly: pr.poly, dock: pr.name === 'Furnivall Sculling Club' }));
    route.obstacles.forEach((o) => {
      const xs = o.poly.map((p) => p[0]), ys = o.poly.map((p) => p[1]);
      o.bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      // Extent in the river frame, used by the auto-steer to dodge fixed obstacles
      const ps = o.poly.map(([x, y]) => project(route, x, y));
      o.s0 = Math.min(...ps.map((p) => p.s)); o.s1 = Math.max(...ps.map((p) => p.s));
      o.d0 = Math.min(...ps.map((p) => p.d)); o.d1 = Math.max(...ps.map((p) => p.d));
    });

    // Furnivall pontoon (start and landing) and the UL Boat House (turning point). Chainage = distance upstream of the route origin.
    route.chain = (s) => (up ? s : route.total - s);
    route.ul = route.landmarks.find((l) => l.name === 'UL Boat House');
    const dk = route.obstacles.find((o) => o.dock);
    const dx = dk.poly.reduce((a, p) => a + p[0], 0) / dk.poly.length;
    const dy = dk.poly.reduce((a, p) => a + p[1], 0) / dk.poly.length;
    const dp = project(route, dx, dy);
    const tips = dk.poly.map(([x, y]) => project(route, x, y).d);
    // The pontoon sits on the Middlesex bank; its tip is the point furthest out into the river
    route.dock = { x: dx, y: dy, s: dp.s, d: dp.d, tipD: up ? Math.max(...tips) : Math.min(...tips) };
    route.ulC = route.chain(route.ul.s);
    route.dockC = route.chain(route.dock.s);
    route.crossings.push({ name: 'Furnivall landing', s0: route.dock.s - 120, s1: route.dock.s + 120 });
  }

  function inPoly(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function sample(route, s) {
    const f = clamp(s / route.step, 0, route.n - 1.0001);
    const i = Math.floor(f), t = f - i;
    const a = route.pts[i], b = route.pts[i + 1];
    const o = {};
    for (const key of ['x', 'y', 'th', 'k', 'hwL', 'hwR', 'lwL', 'lwR', 'laneL', 'laneR']) o[key] = lerp(a[key], b[key], t);
    return o;
  }
  const navL = (p, F) => p.lwL + (p.hwL - p.lwL) * F;
  const navR = (p, F) => p.lwR + (p.hwR - p.lwR) * F;
  // With F (tide fraction) given, the lane is kept in the water: when an Inshore Zone dries the crew follows the water's edge
  function laneTarget(p, lane, F, hs = boat.halfSpan) {
    const W = p.laneL + p.laneR;
    let d;
    if (lane === 'left') d = p.laneL - W * LANE_OFFSET;
    else if (lane === 'right') d = -p.laneR + W * LANE_OFFSET;
    // Middle = starboard (right-hand) half of the Fairway
    else d = (p.laneL - p.laneR) / 2 - W * 0.1;
    if (F === undefined) return d;
    const m = hs + 8;
    return clamp(d, -navR(p, F) + m, navL(p, F) - m);
  }
  function worldPos(p, d) { return { x: p.x - Math.sin(p.th) * d, y: p.y + Math.cos(p.th) * d }; }

  // Near a bridge, aim for the middle of the arch the lane runs through (or the nearest clear one)
  function archAdjusted(route, s, d) {
    for (const b of route.bridges) {
      if (!b.archCentres || s < b.s - 90 || s > b.s + 20) continue;
      const clear = boat.halfSpan + 6;
      const arch = b.archCentres.find((a) => d > a.lo + clear && d < a.hi - clear);
      if (arch) return d;
      return b.archCentres.reduce((best, a) => (Math.abs(a.d - d) < Math.abs(best.d - d) ? a : best)).d;
    }
    return d;
  }

  // Auto-steer dodges fixed pontoons and rafts within 70 m ahead (bridge piers are handled by archAdjusted)
  function avoidObstacles(route, s, d, target, hs = boat.halfSpan, len = boat.len, dir = 1) {
    const clear = hs + 5;
    let dodging = false;
    for (let pass = 0; pass < 3; pass++) {
      const lo = Math.min(d, target) - clear, hi = Math.max(d, target) + clear, mid = (lo + hi) / 2;
      // Window of river in front of the boat (in its direction of travel)
      const w0 = dir > 0 ? s - len : s - 70, w1 = dir > 0 ? s + 70 : s + len;
      let changed = false;
      for (const o of route.obstacles) {
        if (o.dock || o.bridge || o.s1 < w0 || o.s0 > w1 || hi < o.d0 || lo > o.d1) continue;
        // Only ever move away from the obstacle, so a later obstacle cannot undo an earlier dodge
        const t = (o.d0 + o.d1) / 2 < mid ? Math.max(target, o.d1 + clear) : Math.min(target, o.d0 - clear);
        if (t !== target) { target = t; changed = true; }
        dodging = true;
      }
      if (!changed) break;
    }
    return { target, dodging };
  }

  // Tideway Code (Upper Tideway Code Area): against the stream work the slacks in the Inshore Zone,
  // crossing only at Crossing Zones; with the stream (or slack) keep to the starboard side of the Fairway.
  function codeStatus(route, s, d, F) {
    // Launching from / landing at the Furnivall pontoon: the crew has to cross to or from the bank
    const landing = route.crossings.find((z) => z.name === 'Furnivall landing' && s >= z.s0 && s <= z.s1);
    if (landing) return { ok: true, rule: 'Furnivall pontoon – launch / land here', note: '', lane: null };
    const p = sample(route, s);
    const W = p.laneL + p.laneR;
    const fromLeft = (p.laneL - d) / W; // 0 = left high-water bank, 1 = right
    const c = route.dir === 'up' ? streamBase() : -streamBase();
    const tideName = streamBase() > 0 ? 'flood' : 'ebb';
    if (c < -0.1) {
      const cz = route.crossings.find((z) => s >= z.s0 && s <= z.s1);
      const slack = route.slackSideAt(s);
      const rule = `Against the ${tideName}: ${slack.bank} Inshore Zone (your ${slack.side})`;
      if (cz) return { ok: true, rule, note: `In ${cz.name} – you may cross`, lane: slack.side };
      const edge = slack.side === 'left' ? navL(p, F) : -navR(p, F);
      const inshoreLimit = slack.side === 'left' ? p.laneL - W * INSHORE : -p.laneR + W * INSHORE;
      const inshoreDry = slack.side === 'left' ? edge < inshoreLimit + boat.halfSpan + 3 : edge > inshoreLimit - boat.halfSpan - 3;
      let ok = slack.side === 'left' ? d >= inshoreLimit - 4 : d <= inshoreLimit + 4;
      // Hugging the water's edge on the slack side always complies (needed when the Inshore Zone dries)
      if (Math.abs(edge - d) < (inshoreDry ? 30 : boat.halfSpan + 15)) ok = true;
      return { ok, rule, note: inshoreDry ? 'Inshore Zone is dry – keep close to the edge of the water' : '', lane: slack.side };
    }
    const rule = Math.abs(c) <= 0.1 ? 'Slack water: starboard side of the Fairway' : `With the ${tideName}: starboard side of the Fairway`;
    return { ok: fromLeft >= 0.45 && fromLeft <= 0.78, rule, note: '', lane: 'middle' };
  }

  // ---------- Tide ----------
  const STATIONS = [
    { id: '0010', name: 'Hammersmith gauge' },
    { id: '0009', name: 'Richmond gauge (tide there runs ~30 min after Hammersmith)' },
  ];
  const tide = {
    mode: 'live', status: 'loading', source: '', readingTime: null,
    level: 0, min: -1, max: 4, rate: 0, frac: 0.5,
    manualFrac: 0.5, manualRate: 1.0, simulated: false,
  };

  async function fetchStation(st) {
    const since = new Date(Date.now() - 48 * 3600e3).toISOString().slice(0, 19) + 'Z';
    const url = `https://environment.data.gov.uk/flood-monitoring/id/stations/${st.id}/readings?_sorted&since=${since}&_limit=500`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return (j.items || [])
      .filter((it) => String(it.measure).includes('tidal_level'))
      .map((it) => ({ t: Date.parse(it.dateTime), v: Array.isArray(it.value) ? it.value[0] : it.value }))
      .filter((it) => Number.isFinite(it.v))
      .sort((a, b) => b.t - a.t);
  }

  async function loadTide() {
    for (const st of STATIONS) {
      try {
        const items = await fetchStation(st);
        if (items.length < 16 || Date.now() - items[0].t > 4 * 3600e3) continue;
        const vals = items.map((i) => i.v);
        const recent = items.slice(0, 4);
        // Least-squares slope over the last hour, in m/h
        const t0 = recent[recent.length - 1].t;
        const xs = recent.map((r) => (r.t - t0) / 3600e3), ys = recent.map((r) => r.v);
        const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
        let num = 0, den = 0;
        xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
        Object.assign(tide, {
          status: 'live', simulated: false, source: st.name,
          readingTime: items[0].t, readingLevel: items[0].v,
          min: Math.min(...vals), max: Math.max(...vals), rate: den ? num / den : 0,
        });
        return;
      } catch (e) { /* try next station */ }
    }
    Object.assign(tide, { status: 'simulated', simulated: true, source: 'Tide data unavailable – using a simulated 12h25m tide' });
  }

  function updateTide() {
    if (tide.mode === 'manual') {
      tide.frac = tide.manualFrac; tide.rate = tide.manualRate;
      tide.level = lerp(tide.min, tide.max, tide.frac);
      return;
    }
    if (tide.status === 'live') {
      // Readings are published with a delay: extrapolate along the recent trend (max 90 min)
      const ageH = Math.min(1.5, (Date.now() - tide.readingTime) / 3600e3);
      tide.level = clamp(tide.readingLevel + tide.rate * ageH, tide.min, tide.max);
      tide.frac = clamp((tide.level - tide.min) / (tide.max - tide.min), 0, 1);
    } else if (tide.status === 'simulated') {
      const ph = (Date.now() / 3600e3) * 2 * Math.PI / 12.42;
      tide.frac = 0.5 + 0.5 * Math.sin(ph);
      tide.rate = 0.5 * (tide.max - tide.min) * Math.cos(ph) * 2 * Math.PI / 12.42;
      tide.level = lerp(tide.min, tide.max, tide.frac);
    }
  }

  // Surface stream along the river in m/s (+ = running upstream / flood)
  function streamBase() {
    const r = tide.rate;
    return r >= 0 ? Math.min(1.3, 0.75 * r) : Math.max(-1.3, 1.8 * r);
  }
  // Stream across the channel: strongest over the deep water, which shifts to the outside of bends
  function streamProf(p, d, F) {
    const L = navL(p, F), Rr = navR(p, F);
    const x = clamp((d + Rr) / (L + Rr), 0, 1); // 0 = right edge, 1 = left edge
    const bend = clamp(Math.abs(p.k) * 900, 0, 1);
    const xc = 0.5 - 0.25 * Math.sign(p.k) * bend;
    return Math.max(0.2, 1 - ((x - xc) / 0.5) ** 2 * 0.8);
  }
  function streamAt(p, d, F) {
    const c = streamBase() * streamProf(p, d, F);
    return route.dir === 'up' ? c : -c;
  }

  // ---------- Game state ----------
  const routes = {};
  const getRoute = (dir) => routes[dir] || (routes[dir] = buildRoute(dir));
  let route = getRoute('up');
  let boat = BOATS['1x'];
  const st = {
    running: false, paused: false, s: 0, d: 0, psi: 0, u: 0, rate: 24, rowing: true,
    lane: 'middle', manual: false, steer: 0, time: 0, groundings: 0, groundedFor: 0,
    phase: 0, timeScale: 4, camTh: 0, zoom: 2.4, finished: false, vs: 0, stream: 0,
    recover: 'centre', hits: 0, code: null, codeOut: 0, codePenalties: 0, codeOk: 0, codeTotal: 0,
    turn: 0, turns: 0, odo: 0, reachedUL: false, player: 'Rower', codeGrace: 0,
    cleanOv: 0, badOv: 0, away: false, safe: 0, passGrace: 0, dockDist: 0, boatAhead: null,
  };
  const keys = {};
  let toastUntil = 0;

  // Announcements stay on screen TOAST_STRETCH times longer than the duration given where they are triggered
  const TOAST_STRETCH = 1.6;
  function toast(msg, secs = 2) { $('toast').textContent = msg; toastUntil = performance.now() + secs * TOAST_STRETCH * 1000; }

  function startGame() {
    route = getRoute('up');
    boat = BOATS[$('optBoat').value];
    tide.mode = $('optTide').value;
    tide.manualFrac = $('optTideFrac').value / 100;
    tide.manualRate = parseFloat($('optTideDir').value);
    st.timeScale = parseFloat($('optSpeed').value);
    st.player = ($('optName').value.trim() || 'Rower').slice(0, 20);
    store('tideway-name', st.player);
    updateTide();
    // Start alongside the Furnivall pontoon, facing upstream
    const p = sample(route, route.dock.s);
    const m = boat.halfSpan + 4;
    const d0 = clamp(route.dock.tipD + boat.halfSpan + 3, -navR(p, tide.frac) + m, navL(p, tide.frac) - m);
    Object.assign(st, {
      running: true, paused: false, finished: false, s: route.dock.s, d: d0, psi: 0, u: 0,
      rate: 24, rowing: true, lane: 'middle', manual: false, time: 0, groundings: 0, groundedFor: 0, camTh: p.th,
      hits: 0, code: null, codeOut: 0, codePenalties: 0, codeOk: 0, codeTotal: 0, turn: 0, turns: 0, odo: 0, reachedUL: false, codeGrace: 0,
      cleanOv: 0, badOv: 0, away: false, safe: 0, passGrace: 0, dockDist: 0, boatAhead: null,
    });
    spawnNpcs();
    resetCoach();
    $('menu').style.display = 'none';
    updateButtons();
    toast(`Row where you like – UL Boat House = +${UL_BONUS} pts. Get off at the pontoon when you're done!`, 4);
  }

  // ---------- Score ----------
  const UL_BONUS = 1000, OVERTAKE_PTS = 100, CODE_PTS = 50, HIT_PTS = 150;
  // The online server recomputes the score with this same formula from the rounded distance (m) and time (0.1 s)
  function calcScore() {
    const dist = Math.round(st.odo), time = Math.round(st.time * 10) / 10;
    const parts = {
      distance: Math.round(dist / 2),
      ul: st.reachedUL ? UL_BONUS : 0,
      clean: st.cleanOv * OVERTAKE_PTS,
      dodgy: -st.badOv * OVERTAKE_PTS,
      code: -st.codePenalties * CODE_PTS,
      hits: -(st.hits + st.groundings) * HIT_PTS,
      time: -Math.round(time / 10),
    };
    return { parts, total: Math.max(0, Object.values(parts).reduce((a, b) => a + b, 0)) };
  }

  // ---------- Other boats on the river (they always follow the Tideway Code) ----------
  // Positions are kept in the up-river frame: c = chainage upstream, dUp = offset to the left of the upstream direction.
  const NPC_STYLES = [['#f4f4f4', '#c62828'], ['#fff3c4', '#1e5aa8'], ['#e9e9ef', '#7b1fa2'], ['#dff0e0', '#ef6c00'], ['#f9e4e4', '#00796b'], ['#e4ecf9', '#ad1457']];
  const npcs = [];

  function npcPos(n) { // position in the current route frame
    return route.dir === 'up' ? { s: n.c, d: n.dUp } : { s: route.total - n.c, d: -n.dUp };
  }

  // Where this boat has to be to obey the Code: stationary boats and boats going against the stream sit in the Inshore Zone of
  // the slack bank; boats going with the stream (or at slack water) keep to the starboard side of the Fairway.
  function npcLane(n, p, F) {
    const hs = n.spec.halfSpan, W = p.laneL + p.laneR;
    if (n.mode === 'still' || n.dirUp * streamBase() < -0.1) return laneTarget(p, getRoute('up').slackSideAt(n.c).side, F, hs);
    const d = n.dirUp > 0 ? p.laneL - 0.62 * W : 0.62 * W - p.laneR;
    return clamp(d, -navR(p, F) + hs + 8, navL(p, F) - hs - 8);
  }

  function npcArch(ru, c, d, hs) {
    for (const b of ru.bridges) {
      if (!b.archCentres || Math.abs(c - b.s) > 90) continue;
      const clear = hs + 6;
      if (b.archCentres.some((a) => d > a.lo + clear && d < a.hi - clear)) return d;
      return b.archCentres.reduce((best, a) => (Math.abs(a.d - d) < Math.abs(best.d - d) ? a : best)).d;
    }
    return d;
  }

  // Steer round other boats ahead, passing on the outside (river-centre side) with a safe oar clearance
  function boatDodge(items, s, d, target, hs, len, dir, centre) {
    let dodging = false;
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const o of items) {
        const ahead = (o.s - s) * dir;
        if (ahead < -(len + o.len) / 2 || ahead > 80) continue;
        const need = hs + o.hs + 3.5;
        if (o.d < Math.min(d, target) - need || o.d > Math.max(d, target) + need) continue;
        const t = o.d < centre ? Math.max(target, o.d + need) : Math.min(target, o.d - need);
        if (t !== target) { target = t; changed = true; }
        dodging = true;
      }
      if (!changed) break;
    }
    return { target, dodging };
  }

  function spawnNpcs() {
    npcs.length = 0;
    const ru = getRoute('up'), F = tide.frac, types = Object.keys(BOATS);
    const want = 6 + Math.floor(Math.random() * 9);
    for (let tries = 0; npcs.length < want && tries < 500; tries++) {
      const type = types[Math.floor(Math.random() * types.length)], spec = BOATS[type];
      const c = 120 + Math.random() * (ru.total - 240);
      if (Math.abs(c - ru.dock.s) < 160 || ru.bridges.some((b) => Math.abs(c - b.s) < 110) || npcs.some((o) => Math.abs(o.c - c) < 70)) continue;
      const n = {
        type, spec, c, dUp: 0, mode: Math.random() < 0.5 ? 'still' : 'move', dirUp: Math.random() < 0.5 ? 1 : -1,
        u: 1 + Math.random() * 0.9, rate: 16 + Math.floor(Math.random() * 6), ph: Math.random() * 6.28,
        style: ((s) => [s[0], s[1], s[1]])(NPC_STYLES[Math.floor(Math.random() * NPC_STYLES.length)]), sign: 0, near: false, minGap: 99,
      };
      n.dUp = npcLane(n, sample(ru, c), F);
      // Not on top of a pontoon or pier
      if (ru.obstacles.some((o) => !o.dock && c > o.s0 - 15 && c < o.s1 + 15 && n.dUp + spec.halfSpan > o.d0 && n.dUp - spec.halfSpan < o.d1)) continue;
      npcs.push(n);
    }
  }

  function updateNpcs(dt) {
    if (!npcs.length) return;
    const ru = getRoute('up'), F = tide.frac;
    const items = npcs.map((n) => ({ s: n.c, d: n.dUp, len: n.spec.len, hs: n.spec.halfSpan, n }));
    for (const n of npcs) {
      const p = sample(ru, n.c), hs = n.spec.halfSpan;
      let target = npcArch(ru, n.c, npcLane(n, p, F), hs);
      if (n.mode === 'move') {
        target = avoidObstacles(ru, n.c, n.dUp, target, hs, n.spec.len, n.dirUp).target;
        target = boatDodge(items.filter((o) => o.n !== n), n.c, n.dUp, target, hs, n.spec.len, n.dirUp, (p.laneL - p.laneR) / 2).target;
      }
      n.dUp += clamp(target - n.dUp, -1.6 * dt, 1.6 * dt);
      if (n.mode === 'move') {
        let v = n.dirUp * n.u + streamBase() * streamProf(p, n.dUp, F);
        if (n.dirUp * v < 0.4) v = n.dirUp * 0.4; // slow, but never quite stopped
        n.c += v * dt;
        if (n.c > ru.total + 30) n.c = -30; else if (n.c < -30) n.c = ru.total + 30;
        n.ph += (n.rate / 60) * dt * 2 * Math.PI;
      }
    }
  }

  // Collisions and takeovers (Tideway Code: overtake on the outside, never near a bridge, never into oncoming traffic)
  function boatsInteract() {
    const f = route.dir === 'up' ? 1 : -1;
    const p = sample(route, st.s), centre = (p.laneL - p.laneR) / 2;
    let ahead = null, passing = false;
    for (const n of npcs) {
      const o = npcPos(n);
      const rel = o.s - st.s, longi = Math.abs(rel), need = (boat.len + n.spec.len) / 2;
      const lat = Math.abs(st.d - o.d), gap = lat - boat.halfSpan - n.spec.halfSpan;
      const same = n.mode === 'still' || n.dirUp * f > 0;
      if (st.safe <= 0 && longi < need && gap < 0) { collide('another boat'); st.safe = 3; return; }
      if (lat < 16 && rel > -(need + 25) && rel < 70) passing = true;
      if (same && lat < 16 && rel > 0 && rel < 90 && (!ahead || rel < ahead.dist)) ahead = { dist: rel, bridge: route.bridges.some((b) => Math.abs(b.s - o.s) < 90) };
      if (longi < need + 25 && lat < 25) { n.near = true; n.minGap = Math.min(n.minGap, gap); }
      const sign = rel > 0 ? 1 : -1;
      if (n.sign === 1 && sign === -1 && same && n.near && !st.turn) judgeOvertake(n, o, centre, f);
      n.sign = sign;
      if (longi > need + 60) { n.near = false; n.minGap = 99; }
    }
    st.boatAhead = ahead;
    st.passGrace = passing ? 1.5 : st.passGrace;
  }

  function judgeOvertake(n, o, centre, f) {
    const why = [];
    if (n.minGap < 1.5) why.push('too close');
    if (!(o.d < centre ? st.d > o.d : st.d < o.d)) why.push('not on the outside');
    if (route.bridges.some((b) => Math.abs(b.s - st.s) < 75)) why.push('near a bridge');
    const oncoming = npcs.some((m) => {
      if (m === n || m.mode === 'still' || m.dirUp * f > 0) return false;
      const q = npcPos(m);
      return q.s > st.s && q.s - st.s < 70 && Math.abs(q.d - st.d) < 14;
    });
    if (oncoming) why.push('into oncoming traffic');
    n.near = false; n.minGap = 99;
    if (why.length) {
      st.badOv++; st.time += CODE_PENALTY;
      toast(`Dodgy overtake (${why.join(', ')}) -${OVERTAKE_PTS} pts, +${CODE_PENALTY} s`, 3);
      coachAlert(4);
    } else {
      st.cleanOv++;
      toast(`Clean overtake! +${OVERTAKE_PTS} pts`, 2);
    }
  }

  // ---------- The coach ----------
  const COACH_LINES = [
    'Go in your lane !!',
    'What the hell are you doing??',
    'Starboard, mate! STAR-BOARD !!',
    "This is the Thames, not a dodgem track !!",
    'Did the swans give you directions??',
    "Inshore means INSHORE, not 'sort of' !!",
    "I've seen shopping trolleys steer better !!",
    'Is that a rowing boat or a drunk crab??',
  ];
  const coach = { state: 'hidden', ds: 0, dd: 0, alertUntil: 0, calmSince: 0, line: '', lineAt: 0, last: -1 };
  function coachAlert(secs) { coach.alertUntil = Math.max(coach.alertUntil, performance.now() + secs * 1000); }
  function resetCoach() { coach.state = 'hidden'; coach.alertUntil = 0; }

  function updateCoach(dt) {
    const now = performance.now();
    const violating = st.running && (st.codeOut > 1 || now < coach.alertUntil);
    if (violating) {
      coach.calmSince = now;
      if (coach.state === 'hidden') {
        const p = sample(route, st.s);
        // Arrives quickly from behind, on the river-centre side
        Object.assign(coach, { state: 'arrive', ds: -110, dd: ((p.laneL - p.laneR) / 2 >= st.d ? 1 : -1) * 16, line: '', lineAt: 0 });
      } else if (coach.state === 'leave') coach.state = 'stay';
    } else if (coach.state === 'stay' && now - coach.calmSince > 3500) coach.state = 'leave';
    if (coach.state === 'arrive') { coach.ds += 32 * dt; if (coach.ds >= 7) { coach.ds = 7; coach.state = 'stay'; } }
    else if (coach.state === 'leave') { coach.ds += 20 * dt; if (coach.ds > 200) coach.state = 'hidden'; }
    if (coach.state === 'stay' && now - coach.lineAt > 4200) {
      let i;
      do { i = Math.floor(Math.random() * COACH_LINES.length); } while (i === coach.last);
      coach.last = i; coach.line = COACH_LINES[i]; coach.lineAt = now;
    }
  }

  function coachPos() {
    const p = sample(route, clamp(st.s + coach.ds, 0, route.total)), F = tide.frac;
    const lo = -navR(p, F) + 4, hi = navL(p, F) - 4;
    let d = st.d + coach.dd;
    if (d > hi || d < lo) d = st.d - coach.dd;
    return { p, d: clamp(d, lo, hi) };
  }

  // ---------- Leaderboard and CrazyBoard ----------
  // Shared online through the Cloudflare API (site/_worker.js) when config.js sets scoresApi; otherwise (or if the network fails) kept in this browser.
  function store(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* storage unavailable */ } }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function loadList(key) { try { const v = JSON.parse(load(key)); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  const loadBoard = () => loadList('tideway-board');
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // How chaotic a row was: collisions weigh most, then dodgy overtakes, groundings and Code penalties
  const chaosOf = (e) => 10 * (e.hits || 0) + 8 * (e.aground || 0) + 6 * (e.bad || 0) + 3 * (e.pen || 0);

  const CFG = window.TIDEWAY_CONFIG || {};
  // Online boards use the Cloudflare API in site/_worker.js (same address as the page); opening index.html from disk stays local.
  const ONLINE = !!CFG.scoresApi && location.protocol !== 'file:';
  async function api(opts) {
    const r = await fetch(CFG.scoresApi, { cache: 'no-store', ...opts });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }
  // A result the server refused (4xx) will never be accepted, so it is not retried
  const retryable = (err) => !(err && err.status >= 400 && err.status < 500);
  const toDb = (e) => ({
    name: e.name, score: e.score, time_s: Math.round(e.time * 10) / 10, dist_m: Math.round(e.dist), ul: !!e.ul,
    pen: e.pen, hits: e.hits, aground: e.aground, clean: e.clean, bad: e.bad, boat: e.boat,
  });
  const fromDb = (r) => ({
    id: r.id, name: String(r.name), score: Number(r.score), time: Number(r.time_s), dist: Number(r.dist_m), ul: !!r.ul,
    pen: Number(r.pen), hits: Number(r.hits), aground: Number(r.aground), clean: Number(r.clean), bad: Number(r.bad), boat: String(r.boat),
  });
  async function submitOnline(entry) {
    return (await api({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toDb(entry)) })).id;
  }
  // Results that could not be sent (offline, etc.) are kept and retried later
  async function flushPending() {
    if (!ONLINE) return;
    const left = [];
    for (const e of loadList('tideway-pending')) { try { await submitOnline(e); } catch (err) { if (retryable(err)) left.push(e); } }
    store('tideway-pending', JSON.stringify(left));
  }

  let boardSeq = 0;
  async function renderBoard(lastId) {
    const seq = ++boardSeq;
    let best, worst, mode = 'local';
    if (ONLINE) {
      try {
        const d = await api();
        best = d.best.map(fromDb); worst = d.worst.map(fromDb); mode = 'online';
      } catch (err) { mode = 'offline'; }
    }
    if (seq !== boardSeq) return; // a newer refresh is on its way
    if (mode !== 'online') {
      const all = loadBoard();
      best = all.slice().sort((a, b) => b.score - a.score).slice(0, 10);
      worst = all.filter((e) => chaosOf(e) > 0).sort((a, b) => chaosOf(b) - chaosOf(a) || a.score - b.score).slice(0, 10);
    }
    const mark = (e) => (e.id === lastId ? ' ★' : '');
    const table = (head, rows) => `<table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.join('')}</table>`;
    $('board').innerHTML = !best.length ? '<div class="empty">No rows yet – be the first!</div>' :
      table(['#', 'Name', 'Score', 'Km', 'Time', 'UL', 'Pen.', 'Hits', 'Grd', 'Ovt ✔/✘', 'Boat'], best.map((e, i) =>
        `<tr${e.id === lastId ? ' class="last"' : ''}><td>${i + 1}</td><td>${esc(e.name)}${mark(e)}</td><td><b>${e.score}</b></td>` +
        `<td>${e.dist != null ? (e.dist / 1000).toFixed(1) : '–'}</td><td>${fmtTime(e.time)}</td><td>${e.ul ? '✔' : ''}</td><td>${e.pen || 0}</td>` +
        `<td>${e.hits || 0}</td><td>${e.aground || 0}</td><td>${e.clean || 0}/${e.bad || 0}</td><td>${esc(e.boat)}</td></tr>`));
    $('crazy').innerHTML = !worst.length ? '<div class="empty">Nobody has crashed yet… give it time.</div>' :
      table(['#', 'Name', 'Chaos', 'Hits', 'Grd', 'Pen.', 'Dodgy ovt', 'Score'], worst.map((e, i) =>
        `<tr${e.id === lastId ? ' class="last"' : ''}><td>${i + 1}</td><td>${esc(e.name)}${mark(e)}</td><td><b>${chaosOf(e)}</b></td>` +
        `<td>${e.hits || 0}</td><td>${e.aground || 0}</td><td>${e.pen || 0}</td><td>${e.bad || 0}</td><td>${e.score}</td></tr>`));
    $('boardNote').textContent = mode === 'online' ? '🌐 Online boards – shared with everyone who plays this game.' :
      mode === 'offline' ? '⚠ Online boards unreachable – showing results saved on this device (unsent results are retried automatically).' :
        '💾 Boards are stored in this browser only.';
  }

  function finish() {
    st.running = false; st.finished = true; resetCoach();
    const split = st.time / (st.odo / 500);
    const sc = calcScore(), pt = sc.parts;
    const entry = {
      id: Date.now(), name: st.player, score: sc.total, time: st.time, dist: st.odo, ul: st.reachedUL, pen: st.codePenalties,
      hits: st.hits, aground: st.groundings, clean: st.cleanOv, bad: st.badOv, boat: $('optBoat').value,
    };
    // Always keep a local copy, so the boards work offline too
    store('tideway-board', JSON.stringify(loadBoard().concat(entry).slice(-200)));
    const sg = (n) => (n >= 0 ? `+${n}` : `${n}`);
    $('result').textContent =
      `\nWell rowed ${st.player}! Back at the Furnivall pontoon.\n` +
      `Score ${sc.total} · ${(st.odo / 1000).toFixed(2)} km in ${fmtTime(st.time)} (penalties included) · split ${fmtTime(split)} /500m\n` +
      `Distance ${sg(pt.distance)} · UL Boat House ${st.reachedUL ? sg(pt.ul) : 'not reached (0)'} · Clean overtakes ${st.cleanOv} (${sg(pt.clean)}) · ` +
      `Dodgy overtakes ${st.badOv} (${sg(pt.dodgy)}) · Code penalties ${st.codePenalties} (${sg(pt.code)}) · ` +
      `Collisions + groundings ${st.hits + st.groundings} (${sg(pt.hits)}) · Time ${sg(pt.time)}`;
    $('startBtn').textContent = 'Row again';
    showTab('play');
    $('menu').style.display = 'flex';
    if (!ONLINE) { renderBoard(entry.id); return; }
    $('boardNote').textContent = 'Saving your result online…';
    submitOnline(entry)
      .then((id) => { flushPending().finally(() => renderBoard(id)); })
      .catch((err) => {
        if (retryable(err)) store('tideway-pending', JSON.stringify(loadList('tideway-pending').concat(entry)));
        renderBoard(entry.id);
      });
  }

  // Turn around (Tideway Code: never spin on the spot – sweep across into the other channel).
  // The boat arcs through 180°; the tide keeps carrying it, so there must be room and nothing just downstream.
  const TURN_U = 2.5;
  function startTurn(force) {
    if (!st.running || st.paused || st.turn || st.groundedFor > 0) return;
    if (st.odo < 60) { toast('Row out a little before turning round', 2); return; }
    const p = sample(route, st.s), F = tide.frac;
    const diam = 2 * (TURN_U / boat.yaw) + boat.halfSpan + 6;
    const roomL = navL(p, F) - st.d, roomR = st.d + navR(p, F);
    // Prefer to finish on the old left side, which is the starboard side on the way back
    if (roomL >= diam) st.turn = 1;
    else if (roomR >= diam) st.turn = -1;
    else if (force) st.turn = roomL >= roomR ? 1 : -1;
    else { toast('Not enough room to turn here', 2); return; }
    st.manual = false;
    toast('Turning round – sweeping across the river', 2.5);
    updateButtons();
  }

  function flipRoute() {
    const total = route.total;
    route = getRoute(route.dir === 'up' ? 'down' : 'up');
    st.s = clamp(total - st.s, 0, route.total);
    st.d = -st.d;
    st.psi -= st.turn * Math.PI;
    st.turn = 0; st.turns++; st.manual = false; st.codeOut = 0; st.codeGrace = 25; // time to settle into the right lane after the turn
    st.code = codeStatus(route, st.s, st.d, tide.frac);
    st.lane = st.code.lane || st.lane;
    npcs.forEach((n) => { n.sign = 0; n.near = false; n.minGap = 99; });
    resetCoach();
    updateButtons();
    toast(route.dir === 'down' ? 'Heading downstream' : 'Heading upstream', 2.5);
  }

  function ground(side) {
    st.groundings++;
    st.time += 15;
    st.u = 0; st.psi = 0; st.groundedFor = 2; st.recover = 'centre'; st.turn = 0;
    st.lane = 'middle'; st.manual = false;
    toast(`Aground on the ${side} foreshore! +15 s`, 2.5);
    coachAlert(5);
    updateButtons();
  }

  function collide(name) {
    st.hits++;
    st.time += 15;
    st.u = 0; st.psi = 0; st.groundedFor = 2; st.recover = 'back'; st.turn = 0;
    st.s = Math.max(0, st.s - 25);
    toast(`Hit ${name}! +15 s`, 2.5);
    coachAlert(5);
  }

  function boatPoints(p) {
    const c = worldPos(p, st.d), h = p.th + st.psi, hl = boat.len / 2;
    const a = worldPos(p, st.d + boat.halfSpan), b = worldPos(p, st.d - boat.halfSpan);
    return [[c.x, c.y], [c.x + Math.cos(h) * hl, c.y + Math.sin(h) * hl], [c.x - Math.cos(h) * hl, c.y - Math.sin(h) * hl], [a.x, a.y], [b.x, b.y]];
  }

  function physics(dt) {
    const p = sample(route, st.s);
    const F = tide.frac;
    updateNpcs(dt);
    if (st.safe > 0) st.safe -= dt;
    st.passGrace = Math.max(0, st.passGrace - dt);
    if (st.groundedFor > 0) {
      st.groundedFor -= dt;
      // Push off into the middle of the navigable channel
      if (st.recover === 'centre') st.d = lerp(st.d, (navL(p, F) - navR(p, F)) / 2, Math.min(1, dt * 2));
      updateCoach(dt);
      return;
    }
    const target = st.turn ? TURN_U : st.rowing ? (0.12 * st.rate + 0.9) * boat.speedK : 0;
    st.u += (target - st.u) * Math.min(1, dt / (st.turn || st.rowing ? 3 : 8));

    let r;
    if (st.turn) {
      r = st.turn * boat.yaw;
    } else if (st.manual) {
      r = st.steer * boat.yaw;
    } else {
      // Auto-steer to the lane, looking a little ahead so the boat anticipates bends.
      // It dodges pontoons and goes round other boats on the outside, as the Code asks.
      const pa = sample(route, st.s + 30);
      const a1 = avoidObstacles(route, st.s, st.d, laneTarget(pa, st.lane, F));
      const items = npcs.map((n) => { const o = npcPos(n); return { s: o.s, d: o.d, len: n.spec.len, hs: n.spec.halfSpan }; });
      const bd = boatDodge(items, st.s, st.d, a1.target, boat.halfSpan, boat.len, 1, (p.laneL - p.laneR) / 2);
      const a2 = bd.dodging ? avoidObstacles(route, st.s, st.d, bd.target) : a1;
      const tgt = archAdjusted(route, st.s + 30, a2.target);
      const dodging = a1.dodging || bd.dodging;
      const e = tgt - st.d;
      const inCZ = route.crossings.some((z) => st.s >= z.s0 && st.s <= z.s1);
      const lim = inCZ || dodging ? 0.7 : 0.3;
      const psiD = clamp(e * (dodging ? 0.04 : 0.015), -lim, lim);
      r = clamp(1.2 * (psiD - st.psi) + p.k * st.vs, -boat.yaw, boat.yaw);
    }
    st.stream = streamAt(p, st.d, F);
    st.vs = (st.u * Math.cos(st.psi) + st.stream) / (1 - p.k * st.d);
    st.d += st.u * Math.sin(st.psi) * dt;
    st.psi += (r - p.k * st.vs) * dt;
    if (!st.turn) st.psi = clamp(st.psi, -1.2, 1.2);
    st.s = clamp(st.s + st.vs * dt, 0, route.total);
    st.odo += Math.abs(st.vs) * dt;
    st.phase += (st.rowing ? st.rate / 60 : 0) * dt * 2 * Math.PI;
    st.time += dt;
    const bwP = worldPos(p, st.d);
    st.dockDist = Math.hypot(bwP.x - route.dock.x, bwP.y - route.dock.y);
    if (st.dockDist > 150) st.away = true;

    const L = navL(p, F), Rr = navR(p, F);
    if (st.d + boat.halfSpan > L) ground(route.leftBank);
    else if (st.d - boat.halfSpan < -Rr) ground(route.rightBank);
    else {
      const pts = boatPoints(p);
      const hit = route.obstacles.find((o) => !o.dock && pts.some(([x, y]) => x >= o.bb[0] && x <= o.bb[2] && y >= o.bb[1] && y <= o.bb[3] && inPoly(o.poly, x, y)));
      if (hit) collide(hit.name); else boatsInteract();
    }

    if (st.turn && st.turn * st.psi >= Math.PI) { flipRoute(); return; }
    if (st.groundedFor <= 0 && !st.turn) {
      st.code = codeStatus(route, st.s, st.d, F);
      // No penalties while settling after a turn or while passing another boat
      if (st.codeGrace > 0 || st.passGrace > 0) { st.codeGrace = Math.max(0, st.codeGrace - dt); st.codeOut = 0; } else {
        st.codeTotal += dt;
        if (st.code.ok) { st.codeOk += dt; st.codeOut = 0; }
        else if ((st.codeOut += dt) >= CODE_GRACE) {
          st.codeOut = 0; st.codePenalties++; st.time += CODE_PENALTY;
          toast(`Tideway Code! ${st.code.rule} (+${CODE_PENALTY} s)`, 3);
          coachAlert(2);
        }
      }
    }
    const c = route.chain(st.s);
    if (!st.reachedUL && c >= route.ulC) {
      st.reachedUL = true;
      toast(`UL Boat House reached: +${UL_BONUS} pts! Row back and get off at the Furnivall pontoon.`, 4);
    }
    // End of the map: swing round rather than get stuck against the edge
    if (!st.turn && (c > route.total - 40 && route.dir === 'up' || c < 40 && route.dir === 'down')) startTurn(true);
    updateCoach(dt);
  }

  // ---------- Rendering ----------
  let W = 0, H = 0, view = null, camY = 0;
  // Keeps the buttons clear of the footer credit, and the boat clear of the buttons (short or landscape phone screens)
  function layoutCam() {
    document.documentElement.style.setProperty('--attrib-h', `${$('attrib').offsetHeight + 4}px`);
    const top = $('controls').getBoundingClientRect().top;
    camY = clamp(Math.min(H * 0.66, top - 34), H * 0.3, H * 0.66);
  }
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layoutCam();
  }

  function makeView(bx, by, th, S) {
    const a = Math.PI / 2 - th, ca = Math.cos(a), sa = Math.sin(a);
    const cx = W / 2, cy = camY || H * 0.66;
    return {
      a, S,
      p(x, y) {
        const dx = x - bx, dy = y - by;
        return [cx + (dx * ca - dy * sa) * S, cy - (dx * sa + dy * ca) * S];
      },
    };
  }

  function band(getL, getR, color) {
    const pts = route.pts;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i], w = worldPos(q, getL(q)), sp = view.p(w.x, w.y);
      i ? ctx.lineTo(sp[0], sp[1]) : ctx.moveTo(sp[0], sp[1]);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const q = pts[i], w = worldPos(q, -getR(q)), sp = view.p(w.x, w.y);
      ctx.lineTo(sp[0], sp[1]);
    }
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
  }

  function polyline(fn, color, width, dash) {
    ctx.beginPath();
    route.pts.forEach((q, i) => {
      const w = worldPos(q, fn(q)), sp = view.p(w.x, w.y);
      i ? ctx.lineTo(sp[0], sp[1]) : ctx.moveTo(sp[0], sp[1]);
    });
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]);
  }

  function polygon(poly, fill, stroke) {
    ctx.beginPath();
    poly.forEach((pt, i) => { const sp = view.p(pt[0], pt[1]); i ? ctx.lineTo(sp[0], sp[1]) : ctx.moveTo(sp[0], sp[1]); });
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }

  function label(text, x, y, color = '#fff', size = 13, bold = false) {
    const sp = view.p(x, y);
    if (sp[0] < -200 || sp[0] > W + 200 || sp[1] < -50 || sp[1] > H + 50) return;
    ctx.font = `${bold ? '700 ' : ''}${size}px system-ui, Segoe UI, Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.strokeText(text, sp[0], sp[1]);
    ctx.fillStyle = color; ctx.fillText(text, sp[0], sp[1]);
  }

  function draw(now) {
    const F = tide.frac;
    const bp = sample(route, st.s);
    let dth = bp.th + (st.turn ? st.psi : 0) - st.camTh;
    while (dth > Math.PI) dth -= 2 * Math.PI;
    while (dth < -Math.PI) dth += 2 * Math.PI;
    st.camTh += dth * 0.05;
    const bw = worldPos(bp, st.d);
    view = makeView(bw.x, bw.y, st.camTh, st.zoom);

    ctx.fillStyle = '#5d7f45'; ctx.fillRect(0, 0, W, H);
    band((q) => q.oL + 6, (q) => q.oR + 6, '#8a8f80');            // embankment / river wall
    band((q) => q.oL, (q) => q.oR, '#a58e62');                    // foreshore (exposed at low tide)
    // Backwater behind Chiswick Eyot floods only on the upper half of the tide (scenery only)
    const bwF = clamp((F - 0.5) * 2, 0, 1);
    if (bwF > 0) band((q) => lerp(q.hwL, q.oL, bwF), (q) => lerp(q.hwR, q.oR, bwF), '#2f6f9c');
    band((q) => navL(q, F), (q) => navR(q, F), '#2f6f9c');        // navigable water now
    band((q) => navL(q, F) * 0.7, (q) => navR(q, F) * 0.7, 'rgba(25,80,125,.55)');
    if (RIVER.eyot.length) {
      polygon(RIVER.eyot, '#3f6b30', '#2c4d22');
    }

    // Crossing Zones (Tideway Code)
    route.crossings.forEach((z) => {
      ctx.beginPath();
      for (let s = z.s0; s <= z.s1; s += 10) {
        const q = sample(route, s), w = worldPos(q, q.hwL), sp = view.p(w.x, w.y);
        s === z.s0 ? ctx.moveTo(sp[0], sp[1]) : ctx.lineTo(sp[0], sp[1]);
      }
      for (let s = z.s1; s >= z.s0; s -= 10) {
        const q = sample(route, s), w = worldPos(q, -q.hwR), sp = view.p(w.x, w.y);
        ctx.lineTo(sp[0], sp[1]);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,220,80,.10)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,220,80,.5)'; ctx.setLineDash([4, 6]); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
      const q = sample(route, (z.s0 + z.s1) / 2), a = worldPos(q, 0);
      label(z.name, a.x, a.y, '#ffe27a', 13, true);
    });

    // Fairway edges: red = Surrey side, green = Middlesex side
    const surreyLeft = route.leftBank === 'Surrey';
    polyline((q) => q.laneL - (q.laneL + q.laneR) * INSHORE, surreyLeft ? 'rgba(255,90,90,.45)' : 'rgba(90,220,110,.45)', 1.5, [2, 8]);
    polyline((q) => -q.laneR + (q.laneL + q.laneR) * INSHORE, surreyLeft ? 'rgba(90,220,110,.45)' : 'rgba(255,90,90,.45)', 1.5, [2, 8]);

    // Lanes
    ['left', 'middle', 'right'].forEach((ln) => {
      polyline((q) => laneTarget(q, ln, F), ln === st.lane ? 'rgba(255,215,90,.75)' : 'rgba(255,255,255,.28)', ln === st.lane ? 2 : 1.2, [10, 12]);
    });

    // Stream arrows
    const c0 = streamBase();
    if (Math.abs(c0) > 0.05) {
      const dirSign = route.dir === 'up' ? Math.sign(c0) : -Math.sign(c0);
      const off = ((now / 1000) * Math.abs(c0) * 12) % 40;
      for (let s = Math.floor((st.s - 250) / 40) * 40; s < st.s + 500; s += 40) {
        const ss = s + dirSign * off;
        if (ss < 0 || ss > route.total) continue;
        const q = sample(route, ss);
        const L = navL(q, F), Rr = navR(q, F);
        for (let k = 1; k <= 4; k++) {
          const d = -Rr + (L + Rr) * k / 5;
          const c = streamAt(q, d, F);
          const a = worldPos(q, d);
          const len = Math.abs(c) * 10 + 3;
          const dir = Math.sign(c);
          const b = { x: a.x + Math.cos(q.th) * len * dir, y: a.y + Math.sin(q.th) * len * dir };
          const sa = view.p(a.x, a.y), sb = view.p(b.x, b.y);
          ctx.strokeStyle = 'rgba(200,230,255,.35)'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(sa[0], sa[1]); ctx.lineTo(sb[0], sb[1]); ctx.stroke();
          const ang = Math.atan2(sb[1] - sa[1], sb[0] - sa[0]);
          ctx.beginPath();
          ctx.moveTo(sb[0], sb[1]);
          ctx.lineTo(sb[0] - 6 * Math.cos(ang - 0.5), sb[1] - 6 * Math.sin(ang - 0.5));
          ctx.moveTo(sb[0], sb[1]);
          ctx.lineTo(sb[0] - 6 * Math.cos(ang + 0.5), sb[1] - 6 * Math.sin(ang + 0.5));
          ctx.stroke();
        }
      }
    }

    // Distance posts every 250 m from the Furnivall pontoon
    for (let k = 250; k < route.total; k += 250) {
      for (const s of [route.dock.s + k, route.dock.s - k]) {
        if (s < 0 || s > route.total) continue;
        const q = sample(route, s);
        const a = worldPos(q, q.hwL + 10), b = worldPos(q, -q.hwR - 10);
        label(`${k} m`, a.x, a.y, '#f2f2d0', 11);
        label(`${k} m`, b.x, b.y, '#f2f2d0', 11);
      }
    }

    // Bank names
    for (let s = 100; s < route.total; s += 350) {
      const q = sample(route, s);
      const a = worldPos(q, q.hwL + 40), b = worldPos(q, -q.hwR - 40);
      label(route.leftBank.toUpperCase(), a.x, a.y, '#dfeccd', 14, true);
      label(route.rightBank.toUpperCase(), b.x, b.y, '#dfeccd', 14, true);
    }

    // Turn markers on the outside bank
    route.bends.forEach((bd) => {
      const q = sample(route, bd.apex);
      const outsideLeft = bd.dir === 'right';
      const a = worldPos(q, outsideLeft ? q.hwL + 22 : -q.hwR - 22);
      label(`Turn ${bd.id}: ${bd.dir === 'left' ? '↰' : '↱'} ${bd.angle}°`, a.x, a.y, '#ffdf6a', 13, true);
    });

    // Bridges, arch numbers (#1 = Middlesex side) and piers/pontoons
    route.bridges.forEach((b) => {
      polygon(b.poly, '#b9b4a8', '#555');
      const q = sample(route, b.s);
      const a = worldPos(q, q.hwL + 25);
      label(b.name, a.x, a.y, '#f4f0e0', 14, true);
    });
    route.obstacles.forEach((o) => polygon(o.poly, o.dock ? '#1b7a3a' : '#6d5a43', o.dock ? '#f2b705' : '#2b2118'));
    route.arches.forEach((a) => {
      const q = sample(route, a.s), w = worldPos(q, a.d);
      label(a.label, w.x, w.y, '#202020', 12, true);
    });
    route.obstacles.forEach((o) => {
      if (!o.name || o.name === 'pontoon' || o.name.endsWith(' pier') || (!o.dock && route.landmarks.some((l) => l.name === o.name))) return;
      const cx = o.poly.reduce((s, p) => s + p[0], 0) / o.poly.length;
      const cy = o.poly.reduce((s, p) => s + p[1], 0) / o.poly.length;
      label(o.dock ? 'Furnivall pontoon' : o.name, cx, cy, o.dock ? '#ffe27a' : '#f0e0c8', o.dock ? 12 : 11, o.dock);
    });

    // Landing zone round the pontoon: the Get off button appears inside it once you have rowed away
    if (st.away) {
      const sp = view.p(route.dock.x, route.dock.y);
      ctx.beginPath(); ctx.arc(sp[0], sp[1], DOCK_RADIUS * view.S, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(80,220,120,.12)'; ctx.fill();
      ctx.strokeStyle = 'rgba(242,183,5,.9)'; ctx.lineWidth = 2; ctx.setLineDash([8, 6]); ctx.stroke(); ctx.setLineDash([]);
    }

    // PLA Fairway buoys and landmarks
    route.buoys.forEach((b) => {
      const sp = view.p(b.x, b.y);
      if (sp[0] < -50 || sp[0] > W + 50 || sp[1] < -50 || sp[1] > H + 50) return;
      ctx.beginPath(); ctx.arc(sp[0], sp[1], Math.max(3, 1.2 * view.S), 0, Math.PI * 2);
      ctx.fillStyle = b.colour === 'red' ? '#e53935' : '#2e9e44'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
      ctx.font = '11px system-ui, Segoe UI, Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.strokeText(b.name, sp[0], sp[1] - 6);
      ctx.fillStyle = '#fff'; ctx.fillText(b.name, sp[0], sp[1] - 6);
    });
    route.landmarks.forEach((l) => {
      const sp = view.p(l.x, l.y);
      if (sp[0] < -50 || sp[0] > W + 50 || sp[1] < -50 || sp[1] > H + 50) return;
      ctx.fillStyle = '#ffd24a'; ctx.strokeStyle = '#3a2a00'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sp[0], sp[1], Math.max(5, 2.5 * view.S), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      label('★ ' + l.name, l.x, l.y - 14 / view.S, '#fff3b0', 13, true);
    });
    if (RIVER.eyot.length) {
      const cx = RIVER.eyot.reduce((s, p) => s + p[0], 0) / RIVER.eyot.length;
      const cy = RIVER.eyot.reduce((s, p) => s + p[1], 0) / RIVER.eyot.length;
      label('Chiswick Eyot', cx, cy, '#eaf6da', 12, true);
    }

    // Turning line at the UL Boat House
    {
      const q = sample(route, route.ul.s);
      const a = worldPos(q, q.hwL), b = worldPos(q, -q.hwR);
      const sa = view.p(a.x, a.y), sb = view.p(b.x, b.y);
      ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 3; ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.moveTo(sa[0], sa[1]); ctx.lineTo(sb[0], sb[1]); ctx.stroke(); ctx.setLineDash([]);
      const m = worldPos(q, 0);
      label('UL BOAT HOUSE – turn round', m.x, m.y, '#ffd24a', 13, true);
    }

    // Other boats, the coach and the player
    {
      const ru = getRoute('up');
      for (const n of npcs) {
        const q = sample(ru, n.c), w = worldPos(q, n.dUp);
        drawBoatAt(w.x, w.y, q.th + (n.dirUp < 0 ? Math.PI : 0), n.spec, n.style, n.ph, n.mode === 'move');
      }
    }
    if (coach.state !== 'hidden') drawCoach();
    drawBoatAt(bw.x, bw.y, bp.th + st.psi, boat, PLAYER_STYLE, st.phase, st.rowing);
    drawCoachBubble();
    drawMinimap();
  }

  const PLAYER_STYLE = ['#21a34f', '#f2b705', '#21a34f']; // Furnivall: green and gold hoops, green blades

  // Rowing boat: hull in two alternating hoop colours, blades in the third colour
  function drawBoatAt(wx, wy, heading, spec, style, phase, rowing) {
    const sp = view.p(wx, wy);
    if (sp[0] < -80 || sp[0] > W + 80 || sp[1] < -80 || sp[1] > H + 80) return;
    const S = view.S;
    ctx.save();
    ctx.translate(sp[0], sp[1]);
    ctx.rotate(-(heading + view.a));
    const L = spec.len * S, hw = Math.max(3, 0.42 * S);
    // Oars: sweep forward/back with the stroke cycle
    const oarAng = rowing ? 0.55 * Math.sin(phase) : 0;
    const span = spec.halfSpan * S;
    for (let k = 0; k < spec.seats; k++) {
      const x = L * 0.25 - (k * L * 0.6) / Math.max(1, spec.seats);
      for (const side of [1, -1]) {
        if (spec.sweep && (k % 2 === 0) !== (side === 1)) continue;
        ctx.strokeStyle = '#f4f4f4'; ctx.lineWidth = Math.max(1, 0.06 * S);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + Math.sin(oarAng) * span * -1, side * Math.cos(oarAng) * span);
        ctx.stroke();
        ctx.fillStyle = style[2]; ctx.strokeStyle = style[1]; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x - Math.sin(oarAng) * span, side * Math.cos(oarAng) * span, Math.max(1.5, 0.25 * S), 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.save();
    ctx.beginPath(); ctx.ellipse(0, 0, L / 2, hw, 0, 0, Math.PI * 2); ctx.clip();
    const hoops = 9, hs = L / hoops;
    for (let i = 0; i < hoops; i++) {
      ctx.fillStyle = i % 2 ? style[1] : style[0];
      ctx.fillRect(-L / 2 + i * hs, -hw, hs + 0.5, 2 * hw);
    }
    ctx.restore();
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, 0, L / 2, hw, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(L / 2 - 2, 0, 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Coach launch: grey brushed-metal hull, cabin, flashing light and a wake
  function drawCoach() {
    const { p, d } = coachPos();
    const w = worldPos(p, d), sp = view.p(w.x, w.y), S = view.S;
    if (sp[0] < -120 || sp[0] > W + 120 || sp[1] < -120 || sp[1] > H + 120) return;
    const L = 11 * S, hw = Math.max(4, 1.6 * S);
    ctx.save();
    ctx.translate(sp[0], sp[1]);
    ctx.rotate(-(p.th + view.a));
    // Wake
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-L * 0.45, -hw * 0.7); ctx.lineTo(-L * 1.4, -hw * 2.4);
    ctx.moveTo(-L * 0.45, hw * 0.7); ctx.lineTo(-L * 1.4, hw * 2.4);
    ctx.stroke();
    // Hull
    const hull = () => {
      ctx.beginPath();
      ctx.moveTo(L / 2, 0);
      ctx.quadraticCurveTo(L * 0.28, -hw, -L * 0.1, -hw);
      ctx.lineTo(-L / 2, -hw * 0.85); ctx.lineTo(-L / 2, hw * 0.85); ctx.lineTo(-L * 0.1, hw);
      ctx.quadraticCurveTo(L * 0.28, hw, L / 2, 0);
      ctx.closePath();
    };
    const g = ctx.createLinearGradient(0, -hw, 0, hw);
    g.addColorStop(0, '#d9dfe3'); g.addColorStop(0.35, '#8f9aa2'); g.addColorStop(0.55, '#c7ced4'); g.addColorStop(1, '#79848c');
    hull(); ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = '#3d454b'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L * 0.3, 0); ctx.lineTo(-L * 0.4, 0); ctx.stroke(); // brushed-metal centre line
    // Cabin
    ctx.fillStyle = '#59646c'; ctx.fillRect(-L * 0.28, -hw * 0.55, L * 0.34, hw * 1.1);
    ctx.fillStyle = '#a9c4d6'; ctx.fillRect(-L * 0.08, -hw * 0.4, L * 0.12, hw * 0.8);
    // Flashing light
    const on = Math.floor(performance.now() / 180) % 2;
    ctx.fillStyle = on ? '#ff3b30' : '#2f7dff';
    ctx.beginPath(); ctx.arc(-L * 0.17, 0, Math.max(2, 0.4 * S), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Cartoon speech bubble shouted by the coach
  function drawCoachBubble() {
    const now = performance.now();
    if (coach.state !== 'stay' || !coach.line || now - coach.lineAt > 3800) return;
    const { p, d } = coachPos();
    const w = worldPos(p, d), sp = view.p(w.x, w.y);
    ctx.save();
    ctx.font = "bold 15px 'Comic Sans MS', 'Segoe UI', system-ui, sans-serif";
    const lines = []; let cur = '';
    for (const word of coach.line.split(' ')) {
      const t = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(t).width > 200 && cur) { lines.push(cur); cur = word; } else cur = t;
    }
    lines.push(cur);
    const lh = 19, bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 24, bh = lines.length * lh + 14;
    const above = sp[1] - 40 - bh > 8;
    const bx = clamp(sp[0] - bw / 2, 8, W - bw - 8), by = above ? sp[1] - 40 - bh : sp[1] + 34;
    const tx = clamp(sp[0], bx + 16, bx + bw - 16), baseY = above ? by + bh : by, tipY = above ? sp[1] - 12 : sp[1] + 12;
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 3;
    ctx.lineWidth = 2.5; ctx.strokeStyle = '#111'; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 14); ctx.fill(); ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.beginPath(); ctx.moveTo(tx - 9, baseY); ctx.lineTo(sp[0], tipY); ctx.lineTo(tx + 9, baseY); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(tx - 8, baseY); ctx.lineTo(tx + 8, baseY); ctx.stroke();
    ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, bx + bw / 2, by + 7 + lh / 2 + i * lh));
    ctx.restore();
  }

  // Minimap: small north-up overview of the whole course, showing only the next turn
  let mmXf = null;
  function drawMinimap() {
    const w = mm.width, h = mm.height, pad = 10;
    if (!mmXf) {
      const xs = RIVER.points.map((p) => p[0]), ys = RIVER.points.map((p) => p[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const sc = Math.min((w - 2 * pad) / (maxX - minX), (h - 2 * pad) / (maxY - minY));
      mmXf = (x, y) => [pad + (x - minX) * sc + ((w - 2 * pad) - (maxX - minX) * sc) / 2, h - pad - (y - minY) * sc - ((h - 2 * pad) - (maxY - minY) * sc) / 2];
    }
    mctx.fillStyle = '#4e6e3a'; mctx.fillRect(0, 0, w, h);
    mctx.strokeStyle = '#3d86bf'; mctx.lineWidth = 4; mctx.lineJoin = 'round';
    mctx.beginPath();
    route.pts.forEach((q, i) => { const p = mmXf(q.x, q.y); i ? mctx.lineTo(p[0], p[1]) : mctx.moveTo(p[0], p[1]); });
    mctx.stroke();
    mctx.font = '9px system-ui'; mctx.textBaseline = 'middle';
    route.landmarks.forEach((l) => {
      if (l.name !== 'UL Boat House' && !l.name.startsWith('Furnivall')) return;
      const p = mmXf(l.x, l.y), ul = l.name === 'UL Boat House';
      mctx.fillStyle = ul ? '#ffd24a' : '#1b7a3a'; mctx.strokeStyle = '#f2b705'; mctx.lineWidth = 1.5;
      mctx.beginPath(); mctx.arc(p[0], p[1], 3.5, 0, Math.PI * 2); mctx.fill(); mctx.stroke();
      mctx.fillStyle = '#fff'; mctx.textAlign = ul ? 'left' : 'right';
      mctx.fillText(ul ? 'UL' : 'Furnivall', p[0] + (ul ? 6 : -6), p[1] - 1);
    });
    const next = route.bends.find((b) => b.s1 > st.s);
    if (next) {
      const q = sample(route, next.apex), p = mmXf(q.x, q.y);
      const pulse = 1 + 0.25 * Math.sin(performance.now() / 250);
      mctx.fillStyle = '#ffdf6a'; mctx.strokeStyle = '#fff'; mctx.lineWidth = 1.5;
      mctx.beginPath(); mctx.arc(p[0], p[1], 6.5 * pulse, 0, Math.PI * 2); mctx.fill(); mctx.stroke();
      mctx.fillStyle = '#000'; mctx.textAlign = 'center'; mctx.font = 'bold 10px system-ui';
      mctx.fillText(next.dir === 'left' ? '↰' : '↱', p[0], p[1] + 0.5);
    }
    const q = sample(route, st.s), bw = worldPos(q, st.d), p = mmXf(bw.x, bw.y);
    mctx.fillStyle = '#ff3d3d'; mctx.beginPath(); mctx.arc(p[0], p[1], 3, 0, Math.PI * 2); mctx.fill();
    mctx.fillStyle = '#fff'; mctx.textAlign = 'right'; mctx.font = '9px system-ui'; mctx.fillText('N ↑', w - 4, h - 7);
  }

  // ---------- HUD ----------
  function fmtTime(t) {
    if (!Number.isFinite(t)) return '–';
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
  }

  function hud() {
    const p = sample(route, st.s), F = tide.frac;
    // Hidden HUD rows (also commented out in index.html): uncomment both to bring them back.
    // $('hTime').textContent = fmtTime(st.time);
    // const chain = route.chain(st.s);
    // $('hDist').textContent = st.reachedUL ? `✔ +${UL_BONUS}` : `${Math.round(Math.abs(route.ulC - chain))} m`;
    // $('hHome').textContent = `${Math.round(Math.abs(route.dockC - chain))} m`;
    // const sc = calcScore();
    // $('hScore').textContent = sc.total;
    $('hOvt').textContent = `${st.cleanOv} ✔ / ${st.badOv} ✘`;
    $('hSplit').textContent = st.vs > 0.3 ? fmtTime(500 / st.vs) : '–';
    // $('hSpeed').textContent = `${st.u.toFixed(1)} / ${st.vs.toFixed(1)} m/s`;
    $('hRate').textContent = st.rowing ? `${st.rate} spm` : 'easy oar';
    // $('hMode').textContent = st.manual ? 'MANUAL (←/→)' : `auto · ${st.lane} lane`;
    const L = navL(p, F), Rr = navR(p, F);
    const x = (st.d + Rr) / (L + Rr);
    $('hSide').textContent = x > 0.62 ? `${route.leftBank} side (left)` : x < 0.38 ? `${route.rightBank} side (right)` : 'centre';

    const trend = tide.rate > 0.05 ? 'flooding ↑' : tide.rate < -0.05 ? 'ebbing ↓' : 'slack';
    $('hTide').textContent = `${Math.round(F * 100)}% · ${trend}`;
    const c = st.stream;
    $('hStream').textContent = Math.abs(c) < 0.05 ? 'slack' : `${Math.abs(c).toFixed(2)} m/s ${c > 0 ? 'with you' : 'against you'}`;
    $('hWidth').textContent = `${Math.round(L + Rr)} m of ${Math.round(p.hwL + p.hwR)} m`;
    // Tide gauge source line (Richmond gauge...), hidden for now:
    // if (tide.mode === 'manual') $('hSrc').textContent = 'Manual tide setting';
    // else if (tide.status === 'live') {
    //   $('hSrc').textContent = `${tide.source.split(' (')[0]}: ${tide.readingLevel.toFixed(2)} mAOD at ` +
    //     `${new Date(tide.readingTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, now ≈ ${tide.level.toFixed(2)} m`;
    // } else $('hSrc').textContent = tide.source || 'Loading tide…';

    const next = route.bends.find((b) => b.s1 > st.s);
    if (next) {
      const inBend = st.s >= next.s0;
      $('hBend').textContent = `${next.dir} ${next.angle}° ${inBend ? '(now)' : `in ${Math.round(next.s0 - st.s)} m`}`;
    } else $('hBend').textContent = 'none ahead';
    $('hGround').textContent = `${st.groundings} / ${st.hits}`;

    // Get-off button: whenever you are back at the Furnivall pontoon (after rowing away from it)
    const atDock = st.running && st.away && !st.turn && st.dockDist <= DOCK_RADIUS;
    $('bOff').style.display = atDock ? '' : 'none';
    $('bTurn').classList.toggle('on', st.reachedUL && route.dir === 'up' && !st.turn);
    const cs = st.code || codeStatus(route, st.s, st.d, F);
    const laneKey = { left: 'A', middle: 'S', right: 'D' }[cs.lane];
    $('hCode').innerHTML = `${cs.rule}<br>${cs.ok ? '<span style="color:#7dff7d">✔ in position</span>'
      : `<span style="color:#ff7b7b">✘ out of position${st.codeOut > 0 ? ` (${Math.max(0, CODE_GRACE - st.codeOut).toFixed(1)} s)` : ''}</span>`}` +
      `${cs.lane && (cs.lane !== st.lane || !cs.ok) ? ` – ${cs.lane} lane [${laneKey}]` : ''}` +
      `${cs.note ? `<br><span style="color:#ffe27a">${cs.note}</span>` : ''} · penalties: ${st.codePenalties}`;

    // Look ahead: does the chosen lane dry out?
    let warn = '';
    if (st.manual) {
      const q = sample(route, st.s + 40);
      if (st.d + boat.halfSpan + 5 > navL(q, F) || st.d - boat.halfSpan - 5 < -navR(q, F)) warn = '⚠ Shallow water ahead – steer away from the bank!';
    } else {
      for (let a = 0; a <= 200; a += 10) {
        const q = sample(route, st.s + a), d = laneTarget(q, st.lane);
        if (d + boat.halfSpan > navL(q, F) || d - boat.halfSpan < -navR(q, F)) {
          warn = `⚠ ${st.lane} lane dries out ${a ? `in ${a} m` : 'here'} – following the water's edge`;
          break;
        }
      }
    }
    const ba = st.boatAhead;
    if (!warn && st.away && !st.turn && st.dockDist > DOCK_RADIUS && st.dockDist < 400) warn = '⚓ Furnivall pontoon close – take the Middlesex bank to get off the boat';
    if (ba && ba.dist < 80) warn = ba.bridge || route.bridges.some((b) => Math.abs(b.s - st.s - ba.dist) < 75) ?
      '⚠ Slower boat ahead near a bridge – hold back (Easy oar), no overtaking within 75 m!' : '⚠ Slower boat ahead – overtake on the outside';
    $('warn').textContent = warn;
    $('toast').style.opacity = performance.now() < toastUntil ? 1 : 0;
  }

  function updateButtons() {
    $('bL').classList.toggle('on', !st.manual && st.lane === 'left');
    $('bM').classList.toggle('on', !st.manual && st.lane === 'middle');
    $('bR').classList.toggle('on', !st.manual && st.lane === 'right');
    $('bRow').textContent = st.rowing ? 'Easy oar' : 'Row!';
    $('bPause').textContent = st.paused ? 'Resume' : 'Pause';
  }

  // ---------- Input ----------
  function setLane(l) { st.lane = l; st.manual = false; updateButtons(); }
  function changeRate(d) { st.rate = clamp(st.rate + d, 16, 40); st.rowing = true; updateButtons(); }
  function togglePause() { if (st.running) { st.paused = !st.paused; updateButtons(); } }
  function getOff() {
    if (!st.running || $('bOff').style.display === 'none') return;
    finish();
  }

  // Exit: back to the menu without saving. The first tap arms the button (so a stray tap on a phone does not
  // throw a row away); a second tap within 3 seconds leaves.
  let exitTimer = 0;
  function disarmExit() { clearTimeout(exitTimer); exitTimer = 0; $('bExit').textContent = '✕ Exit'; $('bExit').classList.remove('armed'); }
  function exitGame() {
    if (!st.running) return;
    if (!exitTimer) {
      $('bExit').textContent = 'Tap again to exit';
      $('bExit').classList.add('armed');
      exitTimer = setTimeout(disarmExit, 3000);
      return;
    }
    disarmExit();
    st.running = false; st.finished = true; st.paused = false; st.turn = 0;
    resetCoach();
    toastUntil = 0;
    $('bOff').style.display = 'none';
    $('result').textContent = '\nRow abandoned – nothing was saved.';
    $('startBtn').textContent = 'Start';
    showTab('play');
    $('menu').style.display = 'flex';
    renderBoard();
  }

  // Menu tabs: Play / Rules / Sources
  function showTab(name) {
    document.querySelectorAll('#tabs [role=tab]').forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.tabpanel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
    $('menuBox').scrollTop = 0;
  }
  document.querySelectorAll('#tabs [role=tab]').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

  window.addEventListener('keydown', (e) => {
    if ($('menu').style.display !== 'none') return;
    keys[e.key] = true;
    switch (e.key) {
      case 'a': case 'A': case '1': setLane('left'); break;
      case 's': case 'S': case '2': setLane('middle'); break;
      case 'd': case 'D': case '3': setLane('right'); break;
      case 'ArrowUp': changeRate(2); e.preventDefault(); break;
      case 'ArrowDown': changeRate(-2); e.preventDefault(); break;
      case ' ': st.rowing = !st.rowing; updateButtons(); e.preventDefault(); break;
      case 'p': case 'P': case 'Escape': togglePause(); break;
      case 'u': case 'U': case 't': case 'T': startTurn(); break;
      case 'g': case 'G': getOff(); break;
      case 'r': case 'R': startGame(); break;
      case '+': case '=': st.zoom = Math.min(8, st.zoom * 1.2); break;
      case '-': case '_': st.zoom = Math.max(0.4, st.zoom / 1.2); break;
      case 'ArrowLeft': case 'ArrowRight': st.manual = true; updateButtons(); e.preventDefault(); break;
    }
  });
  window.addEventListener('keyup', (e) => { keys[e.key] = false; });
  cv.addEventListener('wheel', (e) => { st.zoom = clamp(st.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.4, 8); e.preventDefault(); }, { passive: false });

  $('bL').onclick = () => setLane('left');
  $('bM').onclick = () => setLane('middle');
  $('bR').onclick = () => setLane('right');
  $('bRateUp').onclick = () => changeRate(2);
  $('bRateDn').onclick = () => changeRate(-2);
  $('bRow').onclick = () => { st.rowing = !st.rowing; updateButtons(); };
  $('bPause').onclick = togglePause;
  $('bTurn').onclick = () => startTurn();
  $('bOff').onclick = getOff;
  $('bExit').onclick = exitGame;
  $('startBtn').onclick = startGame;
  $('optTide').onchange = () => { $('manualTide').style.display = $('optTide').value === 'manual' ? 'block' : 'none'; };
  $('optTideFrac').oninput = () => { $('optTideFracV').textContent = $('optTideFrac').value; };

  // ---------- Main loop ----------
  let last = performance.now(), hudT = 0;
  function frame(now) {
    const realDt = Math.min(0.1, (now - last) / 1000);
    last = now;
    updateTide();
    st.steer = (keys.ArrowLeft ? 1 : 0) - (keys.ArrowRight ? 1 : 0);
    if (st.running && !st.paused) {
      let dt = realDt * st.timeScale;
      while (dt > 0 && st.running) { const h = Math.min(0.05, dt); physics(h); dt -= h; }
    }
    draw(now);
    hudT += realDt;
    if (hudT > 0.1) { hud(); layoutCam(); hudT = 0; }
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  resize();
  loadTide();
  setInterval(loadTide, 5 * 60 * 1000);
  st.s = route.dock.s; st.d = route.dock.tipD + 6; st.camTh = sample(route, route.dock.s).th;
  $('optName').value = load('tideway-name') || '';
  flushPending().finally(() => renderBoard());
  updateButtons();
  requestAnimationFrame(frame);
})();
