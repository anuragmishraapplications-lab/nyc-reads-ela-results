/* =====================================================================
   NYC Reads — ELA Results Explorer
   ---------------------------------------------------------------------
   Every percentage on this page is derived from student counts held in
   D.city / D.boro / D.dist.  Row layout:
       [geoIdx, gradeIdx, yearIdx, catIdx, nTested, meanScale, c1, c2, c3, c4]
   Nothing is read from a published percentage.
   ===================================================================== */

const YEARS   = D.years;                 // [2018,2019,2022,2023,2024,2025,2026]
const GRADES  = D.grades;                // ['3'..'8','All Grades']
const CATS    = D.cats;                      // the file's exact Category strings
const CATL    = D.catLabels || D.cats;       // how those groups are named on screen
const catName = c => CATL[c] || CATS[c];
const AGI     = GRADES.indexOf('All Grades');
const ALLCAT  = CATS.indexOf('All Students');
const MODERN  = [2023, 2024, 2025, 2026];      // comparable era (current standards)
const BASELINES = [2023, 2024, 2025];
const yIdx = y => YEARS.indexOf(y);

/* ---------- indexes: key -> row ---------- */
function buildIndex(rows){
  const m = new Map();
  for (const r of rows) m.set(r[0]*100000 + r[1]*10000 + r[2]*1000 + r[3], r);
  return m;
}
const IX = { city: buildIndex(D.city), boro: buildIndex(D.boro), dist: buildIndex(D.dist) };
const getRow = (lvl, g, gr, y, c) => IX[lvl].get(g*100000 + gr*10000 + y*1000 + c) || null;

/* ---------- grade bands ---------- */
const BANDS = [
  { k:'all',  label:'All grades (3–8)', grades:null },          // uses the All Grades row
  { k:'35',   label:'Grades 3–5 (elementary)', grades:[0,1,2] },
  { k:'68',   label:'Grades 6–8 (middle)',     grades:[3,4,5] },
  { k:'g3',   label:'Grade 3', grades:[0] },
  { k:'g4',   label:'Grade 4', grades:[1] },
  { k:'g5',   label:'Grade 5', grades:[2] },
  { k:'g6',   label:'Grade 6', grades:[3] },
  { k:'g7',   label:'Grade 7', grades:[4] },
  { k:'g8',   label:'Grade 8', grades:[5] },
];
const band = k => BANDS.find(b => b.k === k);

/* =====================================================================
   CORE AGGREGATOR
   Sums counts over the requested geographies and grades, then derives
   percentages.  Returns null when nothing is available (all suppressed).
   `partial` flags an aggregate assembled from an incomplete grade set.
   ===================================================================== */
function agg(lvl, geos, bandKey, year, cat){
  const b = band(bandKey), yi = yIdx(year);
  if (yi < 0) return null;
  const gradeIdxs = b.grades || [AGI];
  let n=0, c1=0, c2=0, c3=0, c4=0, wMean=0, found=0, want=0, sup=0, gmask=0;
  for (const g of geos) for (const gr of gradeIdxs){
    want++;
    const r = getRow(lvl, g, gr, yi, cat);
    if (!r){ sup++; continue; }
    found++;
    gmask |= (1 << gr);                     // which grades actually contributed
    n += r[4]; c1 += r[6]; c2 += r[7]; c3 += r[8]; c4 += r[9];
    wMean += r[5] * r[4];
  }
  if (!found || !n) return null;
  return {
    n, c1, c2, c3, c4,
    l1: c1/n*100, l2: c2/n*100, l3: c3/n*100, l4: c4/n*100,
    prof: (c3+c4)/n*100,
    mean: wMean/n,
    gmask,                                   // bitmask of contributing grades
    nGrades: gradeIdxs.length,
    partial: sup > 0, suppressed: sup, cells: want
  };
}

/* ---------------------------------------------------------------------
   Comparability of two years.

   A grade band is the sum of its grades, and suppression can remove a grade
   from one year and not the other. When that happens the two aggregates
   describe different sets of grades and the difference between them is not a
   change over time. D02, Black students, grades 3-5 is the case that found
   this: grade 3 is suppressed in 2024, so the band was comparing grades 4-5
   in 2024 against grades 3-5 in 2026 and reporting -1.4pp. Like for like on
   grades 4 and 5 it is -3.2pp.

   So: no change is computed unless both years rest on exactly the same
   grades. Where they do not, the change reads `s`.
   --------------------------------------------------------------------- */
const comparable = (a, b) => !!a && !!b && a.gmask === b.gmask;
/* difference in a metric between two aggregates, or null if not like for like */
function delta(cur, bse, getter){
  if (!comparable(cur, bse)) return null;
  return getter(cur) - getter(bse);
}
/* the grades a band is actually resting on, for labelling */
function gradesOf(a){
  if (!a) return [];
  const out=[];
  for (let g=0; g<6; g++) if (a.gmask & (1<<g)) out.push(g+3);
  return out;
}
function bandNote(cur, bse, bandKey){
  if (bandKey === 'all' || !cur || !bse) return '';
  if (comparable(cur, bse)) return '';
  const cg = gradesOf(cur).join(', '), bg = gradesOf(bse).join(', ');
  return `grades ${bg || 'none'} available in the baseline year against grades ${cg || 'none'} in 2026`;
}

/* metric accessors — `good` is the direction that counts as improvement */
const METRICS = {
  prof: { label:'Proficiency (Level 3–4)', short:'% Level 3–4', get:a=>a.prof, good:+1 },
  l1:   { label:'Level 1 share',                short:'% Level 1',        get:a=>a.l1,   good:-1 },
  l4:   { label:'Level 4 share',                short:'% Level 4',        get:a=>a.l4,   good:+1 },
  mean: { label:'Mean scale score',             short:'Mean scale score', get:a=>a.mean, good:+1 },
};

/* ---------- geography helpers ---------- */
const ALL_DIST = D.districts.map((_,i)=>i);
const ALL_BORO = D.boros.map((_,i)=>i);
const distNum  = i => parseInt(D.districts[i],10);
const distIdx  = n => D.districts.indexOf(String(n).padStart(2,'0'));

/* ---------------------------------------------------------------------
   Vendor and curriculum assignments (NYC Reads professional learning
   provider and adopted curriculum, by district). No personal data is
   carried in the payload.
   --------------------------------------------------------------------- */
const HAS_VENDORS = !!D.vendors;
const V = D.vendors || { k5JespRoster:[], k5CurrRoster:[], msJespRoster:[], msCurrRoster:[],
                         byDistrict:[], phaseDisagree:[], source:'' };
const vendorOf = i => V.byDistrict[i] || { kj:null, kc:null, mj:null, mc:null };
const nm = (roster, k) => (k==null ? '' : roster[k]);
const k5Jesp = i => nm(V.k5JespRoster, vendorOf(i).kj);
const k5Curr = i => nm(V.k5CurrRoster, vendorOf(i).kc);
const msJesp = i => nm(V.msJespRoster, vendorOf(i).mj);
const msCurr = i => nm(V.msCurrRoster, vendorOf(i).mc);
/* the four ways districts can be grouped on the provider page */
const VE_FIELDS = {
  k5j: { label:'K–5 provider (JESP)',   roster:()=>V.k5JespRoster, get:k5Jesp, band:'35' },
  k5c: { label:'K–5 curriculum',        roster:()=>V.k5CurrRoster, get:k5Curr, band:'35' },
  msj: { label:'Grades 6–8 provider (JESP)', roster:()=>V.msJespRoster, get:msJesp, band:'68' },
  msc: { label:'Grades 6–8 curriculum', roster:()=>V.msCurrRoster, get:msCurr, band:'68' },
};
const distsWith = (fk, v) => ALL_DIST.filter(i => VE_FIELDS[fk].get(i) === v);
/* A build may carry curriculum without providers, or the reverse. An empty
   roster is the signal that the field is not in this file at all, so every
   control that offers it drops out rather than rendering an empty picker. */
const hasField = fk => (VE_FIELDS[fk].roster() || []).length > 0;
const HAS_JESP = () => hasField('k5j') || hasField('msj');
const HAS_CURR = () => hasField('k5c') || hasField('msc');

/* ---------------------------------------------------------------------
   Grade bands are governed by different assignments. The K-5 curriculum and
   its provider reach tested grades 3 to 5; the middle-school rollout reaches
   grades 6 to 8. A district can have one provider for K-5 and another for
   6-8, so a filter or a column that always reads the K-5 field is wrong for
   the middle grades. One district surfaced this in review: its middle-grade
   provider does not appear in its K-5 assignment at all, so filtering the
   middle grades by that provider wrongly returned nothing.
   --------------------------------------------------------------------- */
const BAND_SCOPE = { all:'both', '35':'k5', g3:'k5', g4:'k5', g5:'k5',
                     '68':'ms',  g6:'ms', g7:'ms', g8:'ms' };
const scopeOf = bk => BAND_SCOPE[bk] || 'both';
/* every provider / curriculum value that applies to a district for this band */
function jespFor(i, bk){
  const sc = scopeOf(bk);
  return sc==='k5' ? [k5Jesp(i)] : sc==='ms' ? [msJesp(i)]
       : [k5Jesp(i), msJesp(i)];
}
function currFor(i, bk){
  const sc = scopeOf(bk);
  return sc==='k5' ? [k5Curr(i)] : sc==='ms' ? [msCurr(i)]
       : [k5Curr(i), msCurr(i)];
}
const phaseFor = (n, bk) => scopeOf(bk)==='ms' ? phaseMsLabel(n) : phaseElemLabel(n);
/* roster for the filter control, scoped to the band */
function jespRoster(bk){
  const sc = scopeOf(bk);
  const r = sc==='k5' ? V.k5JespRoster : sc==='ms' ? V.msJespRoster
          : [...new Set([...V.k5JespRoster, ...V.msJespRoster])].sort();
  return r;
}
function currRoster(bk){
  const sc = scopeOf(bk);
  return sc==='k5' ? V.k5CurrRoster : sc==='ms' ? V.msCurrRoster
       : [...new Set([...V.k5CurrRoster, ...V.msCurrRoster])].sort();
}

const PHASES = {
  elem1: new Set(D.phase.elem1), elem2: new Set(D.phase.elem2),
  ms1:   new Set(D.phase.ms1),   ms2:   new Set(D.phase.ms2),
};
const phaseElemLabel = n => PHASES.elem1.has(n) ? 'Elem Phase 1' : PHASES.elem2.has(n) ? 'Elem Phase 2' : '—';
const phaseMsLabel   = n => PHASES.ms1.has(n) ? 'MS Phase 1' : PHASES.ms2.has(n) ? 'MS Phase 2' : '—';

/* ---------- formatting ---------- */
const f1 = v => v==null || !isFinite(v) ? '—' : v.toFixed(1);
const f2 = v => v==null || !isFinite(v) ? '—' : v.toFixed(2);
/* percentage-point change. A value that rounds to zero is shown unsigned, so a
   trivially negative number never reads as "−0.0". */
const pp = v => v==null || !isFinite(v) ? '—'
  : Math.abs(v) < 0.05 ? '0.0' : (v>0?'+':'−') + Math.abs(v).toFixed(1);
const num = v => v==null ? '—' : v.toLocaleString('en-US');
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* #RRGGBB + alpha -> rgba(), so table shading can be derived from the same
   constants the charts use instead of restating them as literals */
function rgba(hex, a){
  const h = hex.replace('#','');
  const n = parseInt(h, 16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a.toFixed(3)})`;
}
/* diverging color ramp; `good` = sign that means improvement */
function heat(v, scale, good){
  if (v==null || !isFinite(v)) return 'background:#F3F4F6;color:#9CA3AF';
  if (good === 0){          /* magnitude only: neither direction is "better" */
    const t = Math.min(1, Math.abs(v)/scale);
    if (t < 0.06) return 'background:#F1F4F7;color:#41505C';
    const a = 0.12 + t*0.6;
    return `background:rgba(90,98,112,${a.toFixed(3)});color:${a>0.45?'#fff':'#33393F'}`;
  }
  const t = Math.max(-1, Math.min(1, (v*good)/scale));         // +1 = best
  if (Math.abs(t) < 0.06) return 'background:#F1F4F7;color:#41505C';
  const a = Math.min(0.88, 0.16 + Math.abs(t)*0.72);
  /* purple = moved in the direction of improvement, orange = moved against it.
     Both come from C_UP / C_DOWN so a table cell and a chart mark of the same
     meaning can never drift apart. */
  return t > 0
    ? `background:${rgba(C_UP, a)};color:${a>0.5?'#fff':'#3F2454'}`
    : `background:${rgba(C_DOWN, a)};color:${a>0.5?'#fff':'#7A4408'}`;
}
/* level-shading ramp (single hue, higher = darker) */
function shade(v, lo, hi, hue){
  if (v==null || !isFinite(v)) return 'background:#F3F4F6;color:#9CA3AF';
  const t = Math.max(0, Math.min(1, (v-lo)/(hi-lo)));
  const a = 0.10 + t*0.72;
  return `background:rgba(${hue},${a.toFixed(3)});color:${a>0.5?'#fff':'#243447'}`;
}

/* ---------------------------------------------------------------------
   Color.

   Five colors are reserved and mean one thing throughout:
     proficiency (Level 3-4)  CPRL blue
     Level 1 / Level 2 / Level 3 / Level 4  the performance ramp

   Everything categorical (borough, phase, provider, curriculum, student
   group) draws from CAT, which contains none of the reserved five. A color
   therefore never carries two meanings, on a page or across pages.
   --------------------------------------------------------------------- */
const C_PROF = '#0070B9';
/* direction of change: purple for improvement, orange against it. Deliberately
   not green/red, at NYCPS's request. */
const C_UP = '#6A3D8A', C_DOWN = '#D67C20';
const LVL_COLOR  = ['#C0483C','#E8A33D','#6FB0C7','#1C355E'];   // Level 1 to 4
const RESERVED = new Set([C_PROF, ...LVL_COLOR]);
const CAT = ['#6D345F','#0F7B6C','#B0722E','#4F748B','#7C6BAD',
             '#A0416B','#3F7A3F','#8A5A44','#2E7D8F','#6B6F2E','#5B5EA6'];
console.assert(!CAT.some(c => RESERVED.has(c)), 'categorical palette reuses a reserved color');
const BORO_COLOR = { 'Bronx':CAT[0], 'Brooklyn':CAT[1], 'Manhattan':CAT[2],
                     'Queens':CAT[3], 'Staten Island':CAT[4] };
const CSS = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();

/* =====================================================================
   CHART PLUMBING
   ===================================================================== */
Chart.defaults.font.family = 'Hind, sans-serif';
Chart.defaults.font.size = 12;
Chart.defaults.color = '#41505C';
Chart.defaults.animation.duration = 340;
Chart.defaults.plugins.legend.labels.usePointStyle = true;
/* boxHeight must be set alongside boxWidth: with usePointStyle the marker is
   drawn at boxHeight/2 radius but the label is offset by boxWidth, so leaving
   boxHeight at its default (the font size) makes the dot overlap the text. */
Chart.defaults.plugins.legend.labels.boxWidth = 9;
Chart.defaults.plugins.legend.labels.boxHeight = 9;
Chart.defaults.plugins.legend.labels.padding = 20;
Chart.defaults.maintainAspectRatio = false;

/* ---------------------------------------------------------------------
   NYC Reads phase markers.
   A spring test in year Y sits at the end of school year (Y-1)–Y, so a wave
   that launches in SY 2023–24 first appears in the 2024 results.  The marker
   is drawn on the first tested year of each wave, not on the launch year.
   --------------------------------------------------------------------- */
const WAVES = [
  { k:'elem1', label:'Elementary Phase 1', sy:'SY 2023–24', firstTested:2024, color:CAT[5],
    scope:'elementary districts' },
  { k:'elem2', label:'Elementary Phase 2', sy:'SY 2024–25', firstTested:2025, color:CAT[6],
    scope:'elementary districts' },
  { k:'ms1',   label:'Middle school Phase 1', sy:'SY 2025–26', firstTested:2026, color:CAT[7],
    scope:'middle school districts' },
];
/* how many districts each wave covers, read from the launch timeline rather
   than written down twice */
const waveN = w => (D.phase[w.k] || []).length;
/* marks for an axis whose categories are MODERN years, optionally offset */
function markSet(waves, slotOf){
  return waves.map((w,i) => ({ at: slotOf(w.firstTested), label:w.label,
                               sub:w.sy, color:w.color, row:i }))
              .filter(m => m.at != null);
}
const MODERN_SLOT = y => { const i = MODERN.indexOf(y); return i < 0 ? null : i; };

/* Chart.js plugin: dashed rule + label at each marker, and a light tint over
   the years before any wave had reached a tested grade. */
function markerPlugin(getMarks){
  return {
    id: 'phasemarks',
    beforeDatasetsDraw(c){
      const marks = getMarks(); if (!marks || !marks.length) return;
      const {ctx, chartArea:a, scales:{x}} = c;
      const first = Math.min(...marks.map(m=>m.at));
      const edge = x.getPixelForValue(first) - (x.getPixelForValue(1)-x.getPixelForValue(0))/2;
      if (edge > a.left){
        ctx.save();
        ctx.fillStyle = 'rgba(120,134,148,.055)';
        ctx.fillRect(a.left, a.top, edge-a.left, a.bottom-a.top);
        ctx.restore();
      }
    },
    afterDatasetsDraw(c){
      const marks = getMarks(); if (!marks || !marks.length) return;
      const {ctx, chartArea:a, scales:{x}} = c;
      ctx.save();
      for (const m of marks){
        const px = x.getPixelForValue(m.at);
        if (!isFinite(px) || px < a.left-1 || px > a.right+1) continue;
        ctx.strokeStyle = m.color; ctx.globalAlpha = .75; ctx.lineWidth = 1.5;
        ctx.setLineDash([5,4]);
        ctx.beginPath(); ctx.moveTo(px, a.top+4); ctx.lineTo(px, a.bottom); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        /* label pill, stacked so overlapping markers stay readable */
        ctx.font = '700 9.5px Hind';
        const t = m.label, w = ctx.measureText(t).width + 12, h = 15;
        let lx = px - w/2;
        lx = Math.max(a.left+2, Math.min(a.right-w-2, lx));
        const ly = a.top + 4 + m.row*(h+3);
        ctx.fillStyle = m.color;
        ctx.beginPath(); ctx.roundRect(lx, ly, w, h, 4); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(t, lx + w/2, ly + h/2 + .5);
      }
      ctx.restore();
    }
  };
}
/* ---------------------------------------------------------------------
   Axis break.

   One chart carries 2022 alongside the comparable era, separated by an empty
   category so that nothing joins across the 2023 standards change. Left
   unmarked, that empty slot reads as missing data and the lone 2022 point
   reads as a rendering fault: the reader sees a stranded dot and a hole of
   unexplained width, and the only explanation sits in a caption below the
   chart. So the break is drawn where it happens — a cut through the plot in
   the page background, closed with the conventional double-rule glyph on the
   axis, and named.
   --------------------------------------------------------------------- */
function breakPlugin(slotIndex, label){
  const W = 30;                                   // half-width of the cut, px
  return {
    id: 'axisbreak',
    /* after the tint, before the lines: the cut hides gridlines but nothing
       is ever plotted in the empty slot, so no data is obscured. */
    beforeDatasetsDraw(c){
      const {ctx, chartArea:a, scales:{x}} = c;
      const px = x.getPixelForValue(slotIndex);
      if (!isFinite(px)) return;
      ctx.save();
      /* the card colour, not the page colour: the cut has to erase the
         gridlines and the shaded tint alike, so that nothing at all reads
         as continuing across it */
      ctx.fillStyle = CSS('--card') || '#FFFFFF';
      ctx.fillRect(px-W, a.top, W*2, a.bottom-a.top+1);
      ctx.strokeStyle = '#C8D2DC'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
      ctx.beginPath();
      ctx.moveTo(px-W, a.top); ctx.lineTo(px-W, a.bottom);
      ctx.moveTo(px+W, a.top); ctx.lineTo(px+W, a.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      /* the break glyph: two parallel strokes straddling the axis line */
      ctx.strokeStyle = '#8D99A6'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const dx of [-5, 5]){
        ctx.moveTo(px+dx-5, a.bottom+5); ctx.lineTo(px+dx+5, a.bottom-5);
      }
      ctx.stroke();
      ctx.restore();
    },
    afterDatasetsDraw(c){
      if (!label) return;
      const {ctx, chartArea:a, scales:{x}} = c;
      const px = x.getPixelForValue(slotIndex);
      if (!isFinite(px)) return;
      ctx.save();
      ctx.translate(px, (a.top + a.bottom)/2);
      ctx.rotate(-Math.PI/2);
      ctx.font = '600 9.5px Hind';
      ctx.fillStyle = '#7B858B';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
  };
}

/* per-page marker toggle */
const MARKS = { ov:true, bo:true, ph:true, sg:true, ve:true, di:true };
/* A bare "Elementary Phase 1" tells a reader nothing about how much of the
   city the rule represents. The legend states the size of the wave, when it
   launched and when it could first show up in results. */
const markHTML = waves => waves.map(w =>
  `<span><i class="dot" style="background:${w.color}"></i><b>${w.label} start:</b>&nbsp;${waveN(w)} ${w.scope}, launched ${w.sy}, first tested ${w.firstTested}</span>`).join('');

const CHARTS = {};
function draw(id, cfg){
  const cv = document.getElementById(id);
  if (!cv) return;
  /* Destroy whatever is actually attached to this canvas, not merely the
     instance we happen to be tracking. If a render is interrupted part way
     the two can diverge, and Chart.js then refuses to reuse the canvas. */
  if (CHARTS[id]) CHARTS[id].destroy();
  const attached = Chart.getChart ? Chart.getChart(cv) : null;
  if (attached) attached.destroy();
  cfg.options = cfg.options || {};
  cfg.options.responsive = true;
  cfg.options.maintainAspectRatio = false;
  CHARTS[id] = new Chart(cv.getContext('2d'), cfg);
}
const gridX = { grid:{display:false}, ticks:{autoSkip:false} };
const gridY = (title, extra={}) => Object.assign({
  grid:{color:'#EDF1F5'}, border:{display:false},
  title:{display:!!title, text:title, font:{size:11,weight:'600'}, color:'#7B858B'}
}, extra);
const ppTip = suffix => ({ callbacks:{ label: c => `${c.dataset.label}: ${f1(c.parsed.y)}${suffix}` } });

/* PNG export — repaint on white so the download is not transparent */
function exportPNG(id){
  const c = CHARTS[id]; if (!c) return;
  const src = c.canvas, out = document.createElement('canvas');
  const s = 2;
  out.width = src.width * s / (window.devicePixelRatio||1);
  out.height = src.height * s / (window.devicePixelRatio||1);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0,0,out.width,out.height);
  ctx.drawImage(src, 0, 0, out.width, out.height);
  const a = document.createElement('a');
  a.href = out.toDataURL('image/png');
  a.download = `nyc-reads-${id}.png`;
  a.click();
}
/* =====================================================================
   SELECT HELPERS
   ===================================================================== */
function fill(el, items, value){
  el.innerHTML = items.map(i => `<option value="${esc(i.v)}">${esc(i.t)}</option>`).join('');
  if (value != null) el.value = value;
}
function fillBands(el, v='all'){ fill(el, BANDS.map(b=>({v:b.k,t:b.label})), v); }
/* 2023 is the default baseline: it is the first year on the current
   standards, so it is the longest comparison the data legitimately
   supports, and 2025 is off-trend enough that starting there flatters or
   punishes districts for reasons unrelated to instruction. */
function fillBaselines(el, v=2023){
  fill(el, BASELINES.map(y=>({v:y, t:`${y} → 2026`})), v);
}
function fillDims(el, v='all'){ fill(el, D.dims.map(d=>({v:d.k,t:d.label})), v); }
/* category select follows the chosen dimension */
function fillCats(dimEl, catEl){
  const dim = D.dims.find(d => d.k === dimEl.value) || D.dims[0];
  fill(catEl, dim.cats.map(c=>({v:c, t:catName(c)})));
  catEl.style.display = dim.cats.length > 1 ? '' : 'none';
}
function fillMetrics(el, keys, v){ fill(el, keys.map(k=>({v:k,t:METRICS[k].label})), v); }

const on = (el, fn) => el.addEventListener('change', fn);
const $ = id => document.getElementById(id);

/* ---------------------------------------------------------------------
   Suppression coverage.
   NYSED suppresses groups of five or fewer tested students AND, where a
   suppressed group could otherwise be recovered by subtraction, the next
   smallest group as well.  That second rule blanks out some very large
   cells — citywide Female for all grades in 2025, for example, covering
   149,821 tested students.  Any view touching such a cell has to say so,
   or a reader will take a gap in a line for a real movement.
   Returns an HTML warning, or '' when the view is complete.
   --------------------------------------------------------------------- */
function coverageNote(lvl, geos, bandKey, cats, where){
  const missing = [];
  for (const c of cats){
    const yrs = MODERN.filter(y => !agg(lvl, geos, bandKey, y, c));
    if (yrs.length) missing.push({ cat: CATS[c], yrs });
  }
  if (!missing.length) return '';
  const bits = missing.map(m => `<b>${esc(m.cat)}</b> in ${m.yrs.join(', ')}`);
  return `<div class="note warn"><b>Part of this view is suppressed in the source files.</b> `
    + `No result is published for ${bits.join('; ')}${where?` (${esc(where)}, ${esc(band(bandKey).label.toLowerCase())})`:''}. `
    + `Lines break at those years rather than joining across them, and the affected cells read <span class="sup">s</span>. `
    + `Suppression is not always a sign of a small group: where one category is too small to publish, NYSED also withholds the next smallest so it cannot be recovered by subtraction, which can remove a very large category from a single year.</div>`;
}

/* ---------------------------------------------------------------------
   Multi-select filter control.
   Renders as a button that opens a checkbox list. Selecting nothing means
   "no restriction on this field". Within one control the selected values are
   combined with OR; separate controls are combined with AND, so adding a
   second control always narrows the set.
   --------------------------------------------------------------------- */
const MS_STATE = {};                       // id -> Set of selected values
function multiSelect(id, label, items, onChange, allText){
  MS_STATE[id] = MS_STATE[id] || new Set();
  const host = $(id);
  if (!host) return;
  const sel = MS_STATE[id];
  const render = () => {
    const n = sel.size;
    const summary = n === 0 ? (allText || `All ${label.toLowerCase()}`)
      : n === 1 ? [...sel].map(v => (items.find(i=>i.v===v)||{}).t || v)[0]
      : `${n} selected`;
    host.querySelector('.ms-btn').innerHTML =
      `<span class="ms-sum${n?' on':''}">${esc(summary)}</span>`
      + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>`;
    host.querySelectorAll('.ms-opt input').forEach(cb => { cb.checked = sel.has(cb.value); });
    host.querySelector('.ms-clear').style.display = n ? '' : 'none';
  };
  host.classList.add('ms');
  host.innerHTML =
    `<button class="ms-btn" type="button" aria-haspopup="listbox"></button>`
  + `<div class="ms-pop" hidden>
       <div class="ms-hd">${esc(label)}<button class="ms-clear" type="button">Clear</button></div>
       <div class="ms-list">`
  + items.map(i => `<label class="ms-opt"><input type="checkbox" value="${esc(i.v)}">`
      + `<span>${esc(i.t)}</span>${i.n!=null?`<em>${i.n}</em>`:''}</label>`).join('')
  + `   </div></div>`;
  const pop = host.querySelector('.ms-pop');
  host.querySelector('.ms-btn').onclick = e => {
    e.stopPropagation();
    document.querySelectorAll('.ms-pop').forEach(p => { if (p!==pop) p.hidden = true; });
    pop.hidden = !pop.hidden;
  };
  pop.onclick = e => e.stopPropagation();
  host.querySelector('.ms-clear').onclick = () => { sel.clear(); render(); onChange(); };
  host.querySelectorAll('.ms-opt input').forEach(cb => {
    cb.onchange = () => { cb.checked ? sel.add(cb.value) : sel.delete(cb.value); render(); onChange(); };
  });
  render();
}
document.addEventListener('click', () =>
  document.querySelectorAll('.ms-pop').forEach(p => p.hidden = true));
const msSel = id => MS_STATE[id] || new Set();
/* Remove a filter and its label from the bar when the build does not carry
   that field. Clears any selection first, so a hidden control can never go on
   silently narrowing the view. */
function hideIfAbsent(id, present){
  const host = $(id); if (!host) return;
  const group = host.closest('.fg') || host;
  group.style.display = present ? '' : 'none';
  if (!present) msSel(id).clear();
}
/* a control with nothing ticked does not restrict anything */
const msPass = (id, values) => { const s = msSel(id);
  if (!s.size) return true;
  return (Array.isArray(values) ? values : [values]).some(v => s.has(v)); };

/* human labels for filter values shown in the active-filter bar */
const PHASE_LABEL = { elem1:'Elementary Phase 1', elem2:'Elementary Phase 2',
                      ms1:'Middle school Phase 1', ms2:'Middle school Phase 2' };
function activeBar(hostId, prefix, total, totalLabel){
  const nameOf = { dist:'Districts', boro:'Borough', phase:'Phase', reads:'PL provider', curr:'Curriculum' };
  const bits = [];
  for (const k of Object.keys(nameOf)){
    const sel = msSel(`${prefix}-ms-${k}`);
    if (!sel.size) continue;
    const vals = [...sel].map(v => k === 'phase' ? (PHASE_LABEL[v] || v)
                                 : k === 'dist'  ? `District ${D.districts[+v]}`
                                 : v);
    bits.push(`<span class="abit"><b>${nameOf[k]}</b> ${esc(vals.join(', '))}</span>`);
  }
  $(hostId).innerHTML = bits.length
    ? `<div class="activebar"><span class="activelbl">Filtered to</span>`
      + bits.join('<span class="sep">and</span>')
      + `<span class="activecount">${totalLabel}</span></div>`
    : '';
}

/* group label used in subtitles */
function groupLabel(dimEl, catEl){
  const dim = D.dims.find(d => d.k === dimEl.value);
  return dim.cats.length > 1 ? catName(+catEl.value) : 'all students';
}

/* ---------------------------------------------------------------------
   Slope (dumbbell) chart.
   One row per group: a connector from the baseline value to the 2026 value,
   a hollow dot at the baseline and a filled dot at 2026, colored by whether
   the movement is an improvement. Shows level and change in one read, which
   a bar of changes alone cannot do: a group can move a long way and still sit
   far below everyone else.
   --------------------------------------------------------------------- */
function slopeChart(id, rows, opts){
  const { baseYear, unit, good, valueFmt = f1 } = opts;
  /* height follows the number of rows, so four groups do not float in a
     panel sized for eleven */
  const wrap = document.getElementById('wrap-' + id);
  if (wrap) wrap.style.height = Math.max(200, rows.length * 46 + 96) + 'px';
  const dots = {
    id: 'dumbbell',
    afterDatasetsDraw(c){
      const { ctx, scales:{x, y} } = c;
      ctx.save();
      rows.forEach((r, i) => {
        const yy = y.getPixelForValue(i);
        const x0 = x.getPixelForValue(r.from), x1 = x.getPixelForValue(r.to);
        const improving = (r.to - r.from) * good > 0;
        const col = improving ? C_UP : C_DOWN;
        /* baseline: hollow */
        ctx.beginPath(); ctx.arc(x0, yy, 5.5, 0, 7); ctx.fillStyle = '#fff';
        ctx.fill(); ctx.lineWidth = 2.2; ctx.strokeStyle = '#94A3B8'; ctx.stroke();
        /* 2026: filled */
        ctx.beginPath(); ctx.arc(x1, yy, 6, 0, 7); ctx.fillStyle = col; ctx.fill();
        /* change, printed past the leading dot */
        ctx.font = '700 11px Hind'; ctx.fillStyle = col;
        ctx.textBaseline = 'middle';
        const d = r.to - r.from;
        const txt = `${pp(d)}${unit}`;
        if (x1 >= x0){ ctx.textAlign = 'left'; ctx.fillText(txt, x1 + 11, yy); }
        else { ctx.textAlign = 'right'; ctx.fillText(txt, x1 - 11, yy); }
      });
      ctx.restore();
    }
  };
  draw(id, {
    type: 'bar',
    data: { labels: rows.map(r => r.label), datasets: [{
      label: 'change',
      data: rows.map(r => [r.from, r.to]),
      backgroundColor: rows.map(r => (r.to - r.from) * good > 0 ? C_UP+'55' : C_DOWN+'55'),
      borderWidth: 0, barThickness: 4, borderSkipped: false,
    }]},
    options: {
      indexAxis: 'y',
      layout: { padding: { right: 58 } },
      scales: {
        x: gridY(`${opts.axisLabel} — hollow dot ${baseYear}, filled dot 2026`),
        y: { grid: { display:false }, ticks: { font:{ size:11.5 }, autoSkip:false } },
      },
      plugins: {
        legend: { display:false },
        tooltip: { callbacks: {
          title: c => rows[c[0].dataIndex].label,
          label: c => { const r = rows[c.dataIndex];
            return [`${baseYear}: ${valueFmt(r.from)}`, `2026: ${valueFmt(r.to)}`,
                    `Change: ${pp(r.to - r.from)}${unit}`, r.sub].filter(Boolean); } } },
      },
    },
    plugins: [dots],
  });
}

/* =====================================================================
   PAGE 1 — CITYWIDE OVERVIEW
   ===================================================================== */
const OV = {};
function initOV(){
  fillBaselines($('ov-base')); fillBands($('ov-grade')); fillDims($('ov-dim'));
  fillCats($('ov-dim'), $('ov-cat'));
  fill($('ov-zyear'), MODERN.map(y=>({v:y,t:String(y)})), 2026);
  on($('ov-dim'), () => { fillCats($('ov-dim'), $('ov-cat')); renderOV(); });
  ['ov-base','ov-grade','ov-cat','ov-zyear'].forEach(id => on($(id), renderOV));
}
function ovSeries(){
  const bk = $('ov-grade').value, cat = +$('ov-cat').value;
  return MODERN.map(y => ({ y, a: agg('city', [0], bk, y, cat) }));
}
function renderOV(){
  const base = +$('ov-base').value, bk = $('ov-grade').value, cat = +$('ov-cat').value;
  const S = ovSeries();
  const cur = S.find(s=>s.y===2026).a, bse = S.find(s=>s.y===base).a;
  const gl = groupLabel($('ov-dim'), $('ov-cat'));
  const bl = band(bk).label.toLowerCase();

  /* ---- KPIs ---- */
  const dProf = delta(cur, bse, a=>a.prof);
  const dL1   = delta(cur, bse, a=>a.l1);
  const ggAll = ggCount(bk, cat, base);
  $('ov-kpi').innerHTML = [
    /* The two levels and their two changes are paired by colour and tint —
       blue for proficiency, red for Level 1 — so that a reader scanning the
       row knows which change belongs to which level without reading the
       labels, and so the pairing survives the row wrapping on a narrow
       screen. Direction of movement is carried by the sign, which is what
       the reader actually reads. */
    kpi('2026 proficiency', cur?f1(cur.prof):'—','%', null, 'Level 3–4 share', 'pair-p'),
    kpi(`Proficiency change vs ${base}`, dProf==null?'—':pp(dProf),'pp', dProf==null?null:dProf>0, 'Percentage points', 'pair-p'),
    kpi('2026 Level 1', cur?f1(cur.l1):'—','%', null, 'Lowest performance level', 'pair-l'),
    kpi(`Level 1 change vs ${base}`, dL1==null?'—':pp(dL1),'pp', dL1==null?null:dL1<0, 'Fewer Level 1s is better', 'pair-l'),
    kpi('Students tested', cur?num(cur.n):'—','', null, `2026, ${bl}`, 'n'),
    kpi('Districts improving on both', `${ggAll.gg}`, `/${ggAll.total}`, null, `Fewer Level 1s and higher proficiency vs ${base}`, ggAll.gg > ggAll.total/2 ? 'g':'n'),
  ].join('');

  /* ---- insight ---- */
  const y25 = S.find(s=>s.y===2025).a, y23 = S.find(s=>s.y===2023).a, y24 = S.find(s=>s.y===2024).a;
  let txt = '';
  if (cur && bse){
    const dirP = dProf > 0.05 ? 'higher' : dProf < -0.05 ? 'lower' : 'level with';
    const dirL = dL1 < -0.05 ? 'lower' : dL1 > 0.05 ? 'higher' : 'level with';
    txt = `Across ${bl}, ${gl === 'all students' ? 'all students' : gl.toLowerCase()} citywide, proficiency in 2026 stands at <b>${f1(cur.prof)}%</b>, ${Math.abs(dProf)<0.05?'':`<b>${pp(dProf)}pp</b> `}${dirP} than ${base}. The Level&nbsp;1 share is <b>${f1(cur.l1)}%</b>, ${Math.abs(dL1)<0.05?'':`<b>${pp(dL1)}pp</b> `}${dirL} than ${base}.`;
    if (y25 && y23 && y24){
      const peak = y25.prof - Math.max(y23.prof, y24.prof);
      if (peak > 2) txt += ` 2025 sits well above both neighbouring years (proficiency ${f1(y25.prof)}%, against ${f1(y24.prof)}% in 2024 and ${f1(cur.prof)}% in 2026), so a change measured from 2025 will read very differently from one measured from 2023 or 2024.`;
    }
    txt += ` ${ggAll.gg} of ${ggAll.total} districts moved the right way on both measures over the same window.`;
  } else txt = 'No data available for this combination — the group is suppressed in the source files at this level of detail.';
  $('ov-insight').innerHTML = txt;
  $('ov-supp').innerHTML = coverageNote('city', [0], bk, [cat], 'citywide');

  /* ---------------------------------------------------------------------
     What "citywide" contains.

     Two different readers get this wrong in two different directions. One
     compares this figure with a NYSED "New York City" figure and finds it
     does not match, because NYSED's aggregate includes charter schools and
     this one does not. The other sees that citywide exceeds the sum of the
     32 districts and concludes the difference must be the charters. It is
     not: the difference is District 75 and out-of-district placements, and
     it was exactly zero in every year through 2023, which is far too small
     to hold the roughly 65,000 charter students in grades 3 to 8. Both
     readings are answered by stating the scope and quantifying the gap.
     --------------------------------------------------------------------- */
  const cy = agg('city',[0],'all',2026,ALLCAT), dy = D.districts.reduce((s,_,i) => {
    const a = agg('dist',[i],'all',2026,ALLCAT); return s + (a ? a.n : 0); }, 0);
  $('ov-scope').innerHTML =
    `<b>What this citywide figure covers.</b> NYCPS district schools only. Charter schools are excluded here and `
    + `at borough and district level; NYCPS publishes charter results separately, at school level. NYSED's `
    + `"New York City" aggregate does include charter schools, so figures published by NYSED will not match `
    + `the figures here. `
    + `The citywide total exceeds the sum of the 32 community school districts by <b>${num(cy.n - dy)}</b> students in 2026 `
    + `(${num(cy.n)} against ${num(dy)}). That difference is District&nbsp;75 and out-of-district placement students, not charter schools.`;

  /* ---- trend ---- */
  const ovMarks = () => MARKS.ov ? markSet(WAVES, MODERN_SLOT) : [];
  draw('ov-trend', {
    type:'line',
    data:{ labels: MODERN.map(String), datasets:[
      { label:'Proficient (Level 3–4)', data:S.map(s=>s.a?s.a.prof:null), borderColor:C_PROF, backgroundColor:C_PROF,
        tension:.25, borderWidth:3, pointRadius:5, pointHoverRadius:7 },
      { label:'Level 1', data:S.map(s=>s.a?s.a.l1:null), borderColor:'#C0483C', backgroundColor:'#C0483C',
        tension:.25, borderWidth:3, pointRadius:5, pointHoverRadius:7 },
    ]},
    options:{ scales:{ x:gridX, y:gridY('% of tested students',{beginAtZero:true,suggestedMax:70}) },
      plugins:{ tooltip:ppTip('%'), legend:{position:'bottom'} } },
    plugins:[markerPlugin(ovMarks)]
  });
  $('ov-trend-marks').innerHTML = (MARKS.ov ? markHTML(WAVES) : '')
    + `<span><i class="dot" style="background:#DDE3E9"></i>Shaded: before NYC Reads reached a tested grade</span>`;

  /* ---- distribution by year ---- */
  draw('ov-dist', {
    type:'bar',
    data:{ labels: MODERN.map(String), datasets: [0,1,2,3].map(i => ({
      label:`Level ${i+1}`, backgroundColor:LVL_COLOR[i], borderWidth:0,
      data: S.map(s => s.a ? [s.a.l1,s.a.l2,s.a.l3,s.a.l4][i] : null)
    }))},
    options:{ scales:{ x:Object.assign({stacked:true},gridX), y:gridY('% of tested students',{stacked:true,max:100}) },
      plugins:{ legend:{display:false}, tooltip:ppTip('%') } }
  });

  /* ---- diverging by grade ---- */
  const zy = +$('ov-zyear').value;
  const gs = ['g3','g4','g5','g6','g7','g8'].map(k => agg('city',[0],k,zy,cat));
  /* Fixed to the full 0-100 range in both directions rather than fitted to
     the data. A scale that moves with the selected group makes two student
     groups look more alike than they are: Students with Disabilities put
     about 78% below the line and all students about 50%, and on a fitted
     axis both fill the panel. Fixed, the difference is the thing you see. */
  const zBound = 100;
  draw('ov-zero', {
    type:'bar',
    data:{ labels: ['Grade 3','Grade 4','Grade 5','Grade 6','Grade 7','Grade 8'], datasets:[
      /* Level 2 sits against the axis so Level 1 reads on the outside, the
         furthest point from proficiency */
      { label:'Level 2', backgroundColor:LVL_COLOR[1], data: gs.map(a=>a?-a.l2:null), borderWidth:0 },
      { label:'Level 1', backgroundColor:LVL_COLOR[0], data: gs.map(a=>a?-a.l1:null), borderWidth:0 },
      { label:'Level 3', backgroundColor:LVL_COLOR[2], data: gs.map(a=>a? a.l3:null), borderWidth:0 },
      { label:'Level 4', backgroundColor:LVL_COLOR[3], data: gs.map(a=>a? a.l4:null), borderWidth:0 },
    ]},
    options:{ scales:{ x:Object.assign({stacked:true},gridX),
        /* the axis follows the data: Students with Disabilities put ~78% below
           the line, which a fixed 70 clipped */
        y:gridY('← below proficient   ·   proficient →',{stacked:true,
          min:-zBound, max:zBound, ticks:{callback:v=>Math.abs(v)+'%'}}) },
      plugins:{ legend:{display:false},
        tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${f1(Math.abs(c.parsed.y))}%`}} } }
  });

  /* ---- grade movement vs baseline ---- */
  const gk = ['g3','g4','g5','g6','g7','g8'];
  const dP = gk.map(k => delta(agg('city',[0],k,2026,cat), agg('city',[0],k,base,cat), a=>a.prof));
  const dL = gk.map(k => delta(agg('city',[0],k,2026,cat), agg('city',[0],k,base,cat), a=>a.l1));
  $('ov-grades').closest('.cd').querySelector('[data-png]').textContent = 'PNG';
  draw('ov-grades', {
    type:'bar',
    data:{ labels:['Grade 3','Grade 4','Grade 5','Grade 6','Grade 7','Grade 8'], datasets:[
      { label:'Change in proficiency', data:dP, backgroundColor:C_PROF, borderWidth:0 },
      { label:'Change in Level 1 share', data:dL, backgroundColor:'#C0483C', borderWidth:0 },
    ]},
    options:{ scales:{ x:gridX, y:gridY(`percentage points vs ${base}`,{grid:{color:c=>c.tick.value===0?'#9AA6B2':'#EDF1F5'}}) },
      plugins:{ legend:{position:'bottom'}, tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${pp(c.parsed.y)}pp`}} } }
  });

  /* ---- the last pre-standards year against the comparable era ----
     Only 2022 is carried back. 2018 and 2019 add nothing here and their own
     two-point stub invited exactly the cross-era comparison the break exists
     to prevent. The empty slot is the standards change. */
  /* one narrow blank slot marks the standards change without leaving a hole */
  const longLabels = ['2022','','2023','2024','2025','2026'];
  const slotFor = { 2022:0, 2023:2, 2024:3, 2025:4, 2026:5 };
  const mk = getter => { const a = new Array(6).fill(null);
    for (const y of YEARS){ if (!(y in slotFor)) continue;
      const v = agg('city',[0],bk,y,cat); if (v) a[slotFor[y]] = getter(v); } return a; };
  draw('ov-long', {
    type:'line',
    data:{ labels: longLabels, datasets:[
      { label:'Proficient (Level 3–4)', data: mk(a=>a.prof), borderColor:C_PROF, backgroundColor:C_PROF,
        borderWidth:3, tension:.2, pointRadius:4, spanGaps:false },
      { label:'Level 1', data: mk(a=>a.l1), borderColor:'#C0483C', backgroundColor:'#C0483C',
        borderWidth:3, tension:.2, pointRadius:4, spanGaps:false },
    ]},
    options:{ scales:{ x:Object.assign({},gridX,{ticks:{autoSkip:false,callback:(v,i)=>longLabels[i]||''}}),
        y:gridY('% of tested students',{beginAtZero:true,suggestedMax:70}) },
      plugins:{ legend:{position:'bottom'},
        tooltip:{callbacks:{ title:c=>longLabels[c[0].dataIndex]||'', label:c=>`${c.dataset.label}: ${f1(c.parsed.y)}%` }} } },
    plugins:[markerPlugin(() => MARKS.ov ? markSet(WAVES, y => slotFor[y] ?? null) : []),
             breakPlugin(1, 'standards change')]
  });
  $('ov-long-marks').innerHTML =
    `<span><i class="dot" style="background:#DDE3E9"></i>Shaded: before NYC Reads reached a tested grade</span>`
    + `<span class="muted">The cut in the axis is the 2023 standards change: 2022 is measured on a different test and is not joined to the years after it. 2020 and 2021 have no usable data.</span>`;
}
function kpi(label, value, unit, up, sub, cls){
  return `<div class="kc ${cls||''}"><div class="kl">${esc(label)}</div>
    <div class="kv">${value}<small>${unit||''}</small></div>
    <div class="kx">${esc(sub||'')}</div></div>`;
}
/* how many districts improved on both measures */
function ggCount(bk, cat, base){
  let gg=0, total=0;
  for (const i of ALL_DIST){
    const a = agg('dist',[i],bk,2026,cat), b = agg('dist',[i],bk,base,cat);
    if (!comparable(a, b)) continue;          /* like-for-like grades only */
    total++;
    if (a.l1 < b.l1 && a.prof > b.prof) gg++;
  }
  return { gg, total };
}
/* ---------------------------------------------------------------------
   Focus panel.

   The citywide page answers "what happened in the city?". Before comparing
   districts to each other, people want the same answer for one district or
   one borough. This renders the citywide blocks (headline numbers, the
   proficiency and Level 1 trend, the level distribution) for a single
   geography, and stays hidden until one is chosen.
   --------------------------------------------------------------------- */
function renderFocus(prefix, lvl, geoIdx, name, bk, cat, base){
  const host = $(prefix + '-focus');
  if (geoIdx == null){ host.style.display = 'none'; return; }
  host.style.display = '';

  const S = MODERN.map(y => ({ y, a: agg(lvl, [geoIdx], bk, y, cat) }));
  const cur = S.find(x=>x.y===2026).a, bse = S.find(x=>x.y===base).a;
  const dProf = delta(cur, bse, a=>a.prof), dL1 = delta(cur, bse, a=>a.l1);
  const note  = bandNote(cur, bse, bk);

  $(prefix+'-focus-title').textContent = name;
  $(prefix+'-focus-sub').textContent =
    `${band(bk).label}, ${catName(cat)}, measured against ${base}.`;

  $(prefix+'-focus-kpi').innerHTML = [
    kpi('2026 proficiency', cur?f1(cur.prof):'—','%', null, 'Level 3–4 share', 'n'),
    kpi(`Change vs ${base}`, dProf==null?(note?'n/c':'—'):pp(dProf),'pp', null,
        note ? 'Not comparable on these grades' : 'Percentage points',
        dProf==null?'n':dProf>0?'g':'b'),
    kpi('2026 Level 1', cur?f1(cur.l1):'—','%', null, 'Lowest performance level', 'n'),
    kpi(`Change vs ${base}`, dL1==null?(note?'n/c':'—'):pp(dL1),'pp', null,
        note ? 'Not comparable on these grades' : 'Fewer Level 1s is better',
        dL1==null?'n':dL1<0?'g':'b'),
    kpi('Students tested', cur?num(cur.n):'—','', null, `2026, ${band(bk).label.toLowerCase()}`, 'n'),
    kpi('Mean scale score', cur?f1(cur.mean):'—','', null, '2026', 'n'),
  ].join('');

  $(prefix+'-focus-note').innerHTML = note
    ? `<div class="note warn" style="margin-bottom:0"><b>Not comparable across these years.</b> ${esc(note)}, so no change is reported.</div>` : '';

  draw(prefix+'-focus-trend', {
    type:'line',
    data:{ labels:MODERN.map(String), datasets:[
      { label:'Proficient (Level 3–4)', data:S.map(x=>x.a?x.a.prof:null),
        borderColor:C_PROF, backgroundColor:C_PROF, borderWidth:3, tension:.25, pointRadius:5 },
      { label:'Level 1', data:S.map(x=>x.a?x.a.l1:null),
        borderColor:LVL_COLOR[0], backgroundColor:LVL_COLOR[0], borderWidth:3, tension:.25, pointRadius:5 },
    ]},
    options:{ scales:{ x:gridX, y:gridY('% of tested students',{beginAtZero:true,suggestedMax:80}) },
      plugins:{ legend:{position:'bottom'}, tooltip:ppTip('%') } },
    plugins:[markerPlugin(() => MARKS[prefix] ? markSet(WAVES, MODERN_SLOT) : [])]
  });

  draw(prefix+'-focus-dist', {
    type:'bar',
    data:{ labels:MODERN.map(String), datasets:[0,1,2,3].map(i=>({
      label:`Level ${i+1}`, backgroundColor:LVL_COLOR[i], borderWidth:0,
      data:S.map(x=>x.a?[x.a.l1,x.a.l2,x.a.l3,x.a.l4][i]:null) })) },
    options:{ scales:{ x:Object.assign({stacked:true},gridX),
        y:gridY('% of tested students',{stacked:true,max:100}) },
      plugins:{ legend:{display:false}, tooltip:ppTip('%') } }
  });
}

/* =====================================================================
   PAGE 2 — DISTRICT EXPLORER
   ===================================================================== */
const DI = { sort:'dprof', dir:1 };
function initDI(){
  fillBaselines($('di-base')); fillBands($('di-grade')); fillDims($('di-dim'));
  fillCats($('di-dim'), $('di-cat'));
  fillMetrics($('di-metric'), ['prof','l1','l4','mean'], 'prof');
  const count = fn => v => ALL_DIST.filter(i => fn(i, v)).length;
  multiSelect('di-ms-boro', 'Boroughs',
    D.boros.map(b => ({ v:b, t:b, n: ALL_DIST.filter(i=>D.districtBoro[i]===b).length })), renderDI, 'All boroughs');
  multiSelect('di-ms-phase', 'NYC Reads phase', [
    { v:'elem1', t:'Elementary Phase 1 · SY 2023–24', n:D.phase.elem1.length },
    { v:'elem2', t:'Elementary Phase 2 · SY 2024–25', n:D.phase.elem2.length },
    { v:'ms1',   t:'Middle school Phase 1 · SY 2025–26', n:D.phase.ms1.length },
    { v:'ms2',   t:'Middle school Phase 2 · SY 2026–27', n:D.phase.ms2.length },
  ], renderDI, 'All phases');
  multiSelect('di-ms-dist', 'Districts',
    D.districts.map((d,i) => ({ v:String(i), t:`District ${d} · ${D.districtBoro[i]}` })),
    renderDI, 'All 32 districts');
  buildDIAssignmentPickers();
  on($('di-dim'), () => { fillCats($('di-dim'), $('di-cat')); renderDI(); });
  on($('di-grade'), () => {   /* the assignment fields follow the grade band */
    msSel('di-ms-reads').clear(); msSel('di-ms-curr').clear();
    buildDIAssignmentPickers(); renderDI(); });
  fill($('di-sg-dim'), D.dims.filter(d => d.k !== 'all').map(d => ({ v:d.k, t:d.label })), 'eth');
  on($('di-sg-dim'), renderDI);
  ['di-base','di-cat','di-metric'].forEach(id => on($(id), renderDI));
  $('di-reset').onclick = () => {
    ['di-ms-dist','di-ms-boro','di-ms-phase','di-ms-reads','di-ms-curr'].forEach(k => msSel(k).clear());
    initDI(); renderDI();
  };
}
function buildDIAssignmentPickers(){
  if (!HAS_VENDORS) return;                 // build carries no assignments at all
  const bk = $('di-grade').value, sc = scopeOf(bk);
  const lbl = sc==='k5' ? 'K–5' : sc==='ms' ? 'Grades 6–8' : 'Any';
  hideIfAbsent('di-ms-reads', HAS_JESP());
  hideIfAbsent('di-ms-curr',  HAS_CURR());
  if (HAS_JESP()) multiSelect('di-ms-reads', `${lbl} provider (JESP)`,
    jespRoster(bk).map(v => ({ v, t:v, n: ALL_DIST.filter(i=>jespFor(i,bk).includes(v)).length })),
    renderDI, 'All providers');
  multiSelect('di-ms-curr', `${lbl} curriculum`,
    currRoster(bk).map(c => ({ v:c, t:c, n: ALL_DIST.filter(i=>currFor(i,bk).includes(c)).length })),
    renderDI, 'All curricula');
}

/* Exactly one district ticked in the Districts filter means "show me this
   one"; anything else means the comparison view. Returns a district index or
   null. */
function diFocusIndex(){
  const sel = msSel('di-ms-dist');
  if (sel.size !== 1) return null;
  const i = +[...sel][0];
  return Number.isInteger(i) && i >= 0 && i < D.districts.length ? i : null;
}

function diRows(){
  const base=+$('di-base').value, bk=$('di-grade').value, cat=+$('di-cat').value;
  const out=[];
  for (const i of ALL_DIST){
    const n = distNum(i), b = D.districtBoro[i];
    /* every control must pass: the filters narrow together, not separately */
    if (!msPass('di-ms-dist', String(i))) continue;
    if (!msPass('di-ms-boro', b)) continue;
    const phases = ['elem1','elem2','ms1','ms2'].filter(k => PHASES[k].has(n));
    if (!msPass('di-ms-phase', phases)) continue;
    if (!msPass('di-ms-reads', jespFor(i, bk).filter(Boolean))) continue;
    if (!msPass('di-ms-curr',  currFor(i, bk).filter(Boolean))) continue;
    const cur = agg('dist',[i],bk,2026,cat), bse = agg('dist',[i],bk,base,cat);
    out.push({
      i, n, boro:b, label:`District ${D.districts[i]}`,
      elem: phaseElemLabel(n), ms: phaseMsLabel(n),
      k5j: k5Jesp(i), k5c: k5Curr(i), msj: msJesp(i), msc: msCurr(i),
      reads: jespFor(i, bk).filter(Boolean).join(' / '),
      ec:    currFor(i, bk).filter(Boolean).join(' / '),
      phase: phaseFor(n, bk),
      cur, bse,
      dprof: delta(cur, bse, a=>a.prof),
      dl1:   delta(cur, bse, a=>a.l1),
      dn:    comparable(cur,bse) && bse.n ? (cur.n-bse.n)/bse.n*100 : null,
      bandNote: bandNote(cur, bse, bk),
    });
  }
  return out;
}
/* The signal Liz asked for: a district is marked "improved on both" when it
   moved the right way on BOTH measures — fewer Level 1s and higher
   proficiency — and "worse on both" when it moved the wrong way on both.
   Anything else is mixed. Named after the direction, not a color, because
   the palette is purple and orange rather than green and red. */
function signal(r){
  if (r.dprof==null || r.dl1==null) return { t:'—', c:'#9CA3AF', rank:-1, k:'na' };
  if (r.dl1<0 && r.dprof>0) return { t:'Improved on both', c:C_UP,   rank:3, k:'up' };
  if (r.dl1<0 || r.dprof>0) return { t:'Mixed',            c:'#94A3B2', rank:2, k:'mixed' };
  return { t:'Worse on both', c:C_DOWN, rank:1, k:'down' };
}
/* ---------------------------------------------------------------------
   Subgroup analysis, on the district page.

   The Subgroups page answers "how does this group do across the system".
   The question people actually arrive with is the other way round: "how do
   the groups compare inside the district I serve". That needs the district
   context beside it, so it lives here rather than being a second trip.

   Scope follows the page. With a district in Focus it reports that district;
   otherwise it reports the districts left by the filters, aggregated by
   summing counts. Suppressed groups are named rather than dropped silently,
   because at district level suppression is common and a missing bar is
   otherwise indistinguishable from a group that does not exist.
   --------------------------------------------------------------------- */
function renderDISubgroups(rows, base, bk){
  const dimKey = $('di-sg-dim').value;
  const dim = D.dims.find(d => d.k === dimKey) || D.dims[1];
  const focusIdx = diFocusIndex();
  const geos = focusIdx == null ? rows.map(r => r.i) : [focusIdx];
  const where = focusIdx == null
    ? (geos.length === 32 ? 'all 32 districts' : `${geos.length} district${geos.length===1?'':'s'}`)
    : `District ${D.districts[focusIdx]}`;
  const bl = band(bk).label.toLowerCase();

  $('di-sg-title').textContent = `${dim.label}: proficiency and change, ${where}`;
  $('di-sg-sub').innerHTML =
    `Percent at Level&nbsp;3&ndash;4 in 2026 for each reported group, and the change from ${base}, ${esc(bl)}. `
    + (geos.length > 1
       ? `Groups are aggregated across the districts shown by summing student counts, so larger districts carry more weight. `
       : ``)
    + `The number above each bar is the change from ${base}: purple where the group moved toward improvement, orange against it. A group whose figures are suppressed is listed below the chart rather than drawn as a gap.`;

  const cats = dim.cats.map(c => {
    const cur = agg('dist', geos, bk, 2026, c);
    const bse = agg('dist', geos, bk, base,  c);
    return { c, name: catName(c), cur, bse,
             d: delta(cur, bse, a => a.prof),
             nc: !!(cur && bse && !comparable(cur, bse)) };
  });
  const shown = cats.filter(x => x.cur);
  const missing = cats.filter(x => !x.cur);

  /* One axis, one meaning. A dual axis with the change as a second bar
     series reads badly here: the change bars start from the secondary axis
     floor, so a movement of a third of a point draws as tall as a bar
     representing sixty percent proficiency. The level is the bar; the change
     is printed above it in the direction colour. */
  const chgLabels = {
    id:'sgchange',
    afterDatasetsDraw(c){
      const meta = c.getDatasetMeta(0);
      const {ctx} = c;
      ctx.save();
      ctx.font = '700 11px Hind';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      meta.data.forEach((bar, i) => {
        const x = shown[i];
        const txt = x.nc ? 'n/c' : x.d == null ? '' : `${pp(x.d)}pp`;
        if (!txt) return;
        ctx.fillStyle = x.nc ? '#8A6D28' : x.d > 0.05 ? C_UP : x.d < -0.05 ? C_DOWN : '#7B858B';
        ctx.fillText(txt, bar.x, bar.y - 6);
      });
      ctx.restore();
    }
  };
  draw('di-sg', {
    type:'bar',
    data:{ labels: shown.map(x => x.name), datasets:[
      { label:'% at Level 3–4, 2026', data: shown.map(x => x.cur.prof),
        backgroundColor: C_PROF, borderWidth:0 },
    ]},
    options:{
      layout:{ padding:{ top: 22 } },
      scales:{
        x: Object.assign({}, gridX, { ticks:{ autoSkip:false, maxRotation:38, minRotation:0, font:{size:11} } }),
        y: gridY('% at Level 3–4, 2026', { beginAtZero:true, suggestedMax:80 }),
      },
      plugins:{ legend:{ display:false },
        tooltip:{ callbacks:{ label:c => {
          const x = shown[c.dataIndex];
          return [`2026: ${f1(x.cur.prof)}% of ${num(x.cur.n)} tested`,
                  `Level 1: ${f1(x.cur.l1)}%`,
                  x.nc ? `Change vs ${base}: not like for like` : `Change vs ${base}: ${pp(x.d)}pp`];
        } } } } },
    plugins:[chgLabels]
  });

  $('di-sg-supp').innerHTML = missing.length
    ? `<div class="note warn" style="margin:16px 0 0"><b>${missing.length} group${missing.length===1?'':'s'} not shown:</b> `
      + missing.map(x => esc(x.name)).join(', ')
      + `. No 2026 figure is published for ${missing.length===1?'it':'them'} at this level of detail, so ${missing.length===1?'it is':'they are'} omitted rather than drawn as zero.</div>`
    : '';

  const gaps = shown.filter(x => x.d != null);
  const widest = shown.length > 1
    ? shown.slice().sort((a,b) => b.cur.prof - a.cur.prof) : [];
  $('di-sg-table').innerHTML =
    `<thead><tr><th class="nos">Student group</th><th class="nos">Tested 2026</th>`
    + `<th class="nos">% Level 3–4</th><th class="nos">% Level 1</th>`
    + `<th class="nos">Change in proficiency vs ${base}</th></tr></thead><tbody>`
    + cats.map(x => {
        if (!x.cur) return `<tr><td class="nm">${esc(x.name)}</td>`
          + `<td><span class="sup">s</span></td><td><span class="sup">s</span></td>`
          + `<td><span class="sup">s</span></td><td><span class="sup">s</span></td></tr>`;
        const chg = x.nc
          ? `<span class="cell nc" title="The grade band rests on different grades in the two years, so the two figures are not like for like">n/c</span>`
          : `<span class="cell" style="${heat(x.d, 6, +1)}">${pp(x.d)}</span>`;
        return `<tr><td class="nm">${esc(x.name)}</td><td>${num(x.cur.n)}</td>`
          + `<td><span class="cell" style="${shade(x.cur.prof, 5, 80, '0,112,185')}">${f1(x.cur.prof)}</span></td>`
          + `<td><span class="cell" style="${shade(x.cur.l1, 5, 60, '192,72,60')}">${f1(x.cur.l1)}</span></td>`
          + `<td>${chg}</td></tr>`;
      }).join('')
    + `</tbody>`;

  return { shown, missing, widest, gaps, where };
}

function renderDI(){
  const base=+$('di-base').value, rows=diRows(), mk=$('di-metric').value, M=METRICS[mk];
  const bl = band($('di-grade').value).label.toLowerCase();
  const gl = groupLabel($('di-dim'), $('di-cat'));

  const valid = rows.filter(r=>r.dprof!=null);
  const nUpP = valid.filter(r=>r.dprof>0).length;
  const nDnL = valid.filter(r=>r.dl1<0).length;
  const nGG  = valid.filter(r=>r.dl1<0 && r.dprof>0).length;
  const best = valid.slice().sort((a,b)=>b.dprof-a.dprof)[0];

  $('di-kpi').innerHTML = [
    kpi('Districts shown', String(rows.length), '', null, `${bl}, ${gl.toLowerCase()}`, 'n'),
    kpi('Proficiency up', `${nUpP}`, `/${valid.length}`, null, `vs ${base}`, nUpP>valid.length/2?'g':'b'),
    kpi('Level 1 share down', `${nDnL}`, `/${valid.length}`, null, `vs ${base}`, nDnL>valid.length/2?'g':'b'),
    kpi('Improved on both', `${nGG}`, `/${valid.length}`, null, best?`Largest proficiency gain: District ${D.districts[best.i]} (${pp(best.dprof)}pp)`:'', nGG>valid.length/2?'g':'n'),
  ].join('');

  /* The separate Focus control is gone. Ticking exactly one district in the
     Districts filter is the same intent expressed once, so that drives the
     detail panel; two or more, or none, means the comparison view. */
  const focusIdx = diFocusIndex();
  renderFocus('di', 'dist', focusIdx,
              focusIdx==null ? '' : `District ${D.districts[focusIdx]}`,
              $('di-grade').value, +$('di-cat').value, base);

  activeBar('di-active', 'di', 32, `${rows.length} of 32 districts`);

  /* subgroup breakdown for whatever this page is currently scoped to */
  renderDISubgroups(rows, base, $('di-grade').value);

  /* districts whose grade band rests on different grades in the two years */
  const nc = rows.filter(r => r.bandNote);
  $('di-nc').innerHTML = nc.length
    ? `<div class="note warn"><b>${nc.length} district${nc.length===1?'':'s'} cannot be compared across these two years on this grade band.</b> `
      + `Suppression removes a grade from one year and not the other, so the two figures would describe different grades. Those changes read <b>n/c</b> rather than a number. `
      + nc.map(r=>`District&nbsp;${D.districts[r.i]} (${esc(r.bandNote)})`).join('; ') + `.</div>`
    : '';

  $('di-insight').innerHTML = valid.length
    ? `Measured from <b>${base}</b> to <b>2026</b> on ${bl}, ${gl.toLowerCase()}: <b>${nDnL}</b> of ${valid.length} districts reduced their Level&nbsp;1 share and <b>${nUpP}</b> raised proficiency; <b>${nGG}</b> did both. `
      + (valid.length>3 ? `The largest reductions in Level&nbsp;1 are in ${valid.slice().sort((a,b)=>a.dl1-b.dl1).slice(0,4).map(r=>`District&nbsp;${D.districts[r.i]} (${pp(r.dl1)}pp)`).join(', ')}.` : '')
    : 'No districts have data for this combination — the group is suppressed at district level.';

  $('di-tblsub').innerHTML = `2026 levels and change from ${base}, ${bl}, ${esc(gl.toLowerCase())}. Click a column heading to sort. Cells are shaded within the column: purple where the movement is in the direction of improvement, orange where it is against.`;

  /* named lists, so the two groups that matter can be read at a glance */
  const byMove = (a,b) => (b.dprof - a.dprof);
  const improved = valid.filter(r=>signal(r).k==='up').sort(byMove);
  const flag  = valid.filter(r=>signal(r).k==='down').sort((a,b)=>a.dprof-b.dprof);
  const mixed = valid.filter(r=>signal(r).k==='mixed');
  const chips = (rows, col) => rows.length
    ? rows.map(r=>`<span class="dchip" style="border-color:${col}44;background:${col}0F">`
        + `<b style="color:${col}">D${D.districts[r.i]}</b> `
        + `<span class="dchip-n">${pp(r.dprof)} / ${pp(r.dl1)}</span>`
        + `<span class="dchip-p">${r.elem==='Elem Phase 1'?'P1':r.elem==='Elem Phase 2'?'P2':'—'}${r.ms!=='—'?' · MS1':''}</span></span>`).join('')
    : '<span class="muted">None on this selection.</span>';
  $('di-flags').innerHTML = `
    <div class="flagbox">
      <div class="flaghd"><span class="dot" style="background:${C_UP}"></span>
        Improved on both <b>(${improved.length})</b>
        <span class="muted">fewer Level 1s and higher proficiency vs ${base}</span></div>
      <div class="chiprow">${chips(improved,C_UP)}</div>
    </div>
    <div class="flagbox">
      <div class="flaghd"><span class="dot" style="background:${C_DOWN}"></span>
        Worse on both <b>(${flag.length})</b>
        <span class="muted">more Level 1s and lower proficiency vs ${base}</span></div>
      <div class="chiprow">${chips(flag,C_DOWN)}</div>
    </div>
    <div class="flagnote">Each chip shows the district, then its change in proficiency and in the Level&nbsp;1 share in percentage points, then its NYC Reads wave (P1 or P2 elementary, MS1 if it also began the middle-school rollout). ${mixed.length} district${mixed.length===1?'':'s'} moved the right way on one measure only and ${mixed.length===1?'is':'are'} not listed here.</div>`;

  /* ---- scatter ---- */
  const pts = valid.map(r=>({ x:r.dl1, y:r.dprof, r:Math.max(4,Math.min(15,Math.sqrt(r.cur.n)/12)), d:r }));
  const quadrant = {
    id:'quadrant',
    beforeDatasetsDraw(c){
      const {ctx, chartArea:a, scales:{x,y}} = c;
      const x0 = x.getPixelForValue(0), y0 = y.getPixelForValue(0);
      ctx.save();
      ctx.fillStyle = 'rgba(106,61,138,.07)';
      ctx.fillRect(a.left, a.top, Math.max(0,x0-a.left), Math.max(0,y0-a.top));
      ctx.strokeStyle = '#9AA6B2'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(x0,a.top); ctx.lineTo(x0,a.bottom);
      ctx.moveTo(a.left,y0); ctx.lineTo(a.right,y0); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C_UP; ctx.font = '600 11px Hind';
      ctx.fillText('fewer Level 1s + higher proficiency', a.left+8, a.top+16);
      ctx.restore();
    }
  };
  draw('di-scatter', {
    type:'bubble',
    data:{ datasets: D.boros.map(b => ({
      label:b, backgroundColor:BORO_COLOR[b]+'CC', borderColor:BORO_COLOR[b], borderWidth:1,
      data: pts.filter(p=>p.d.boro===b)
    })).filter(ds=>ds.data.length) },
    options:{
      scales:{ x:gridY(`change in Level 1 share vs ${base} (pp)`,{grid:{color:'#EDF1F5'}}),
               y:gridY(`change in proficiency vs ${base} (pp)`) },
      plugins:{ legend:{display:false},
        tooltip:{callbacks:{ label:c=>{ const d=c.raw.d;
          return [`District ${D.districts[d.i]} · ${d.boro}`,
                  `Proficiency ${pp(d.dprof)}pp (now ${f1(d.cur.prof)}%)`,
                  `Level 1 ${pp(d.dl1)}pp (now ${f1(d.cur.l1)}%)`,
                  `${num(d.cur.n)} tested in 2026`]; }}} },
    },
    plugins:[quadrant]
  });
  $('di-scatter-lg').innerHTML = D.boros.map(b=>`<span><i class="dot" style="background:${BORO_COLOR[b]}"></i>${b}</span>`).join('')
    + '<span class="muted">Bubble size reflects students tested in 2026.</span>';

  /* ---- ranked bars ---- */
  const rk = rows.map(r=>({ ...r, v: delta(r.cur, r.bse, M.get) }))
                 .filter(r=>r.v!=null).sort((a,b)=> (b.v-a.v)*M.good );
  draw('di-rank', {
    type:'bar',
    data:{ labels: rk.map(r=>'D'+D.districts[r.i]), datasets:[{
      label:`Change in ${M.short}`, data: rk.map(r=>r.v), borderWidth:0,
      backgroundColor: rk.map(r => (r.v*M.good) > 0 ? C_UP : C_DOWN) }]},
    options:{ indexAxis:'y',
      scales:{ x:gridY(`change vs ${base}${mk==='mean'?' (points)':' (pp)'}`),
               y:{grid:{display:false},ticks:{font:{size:10.5},autoSkip:false}} },
      plugins:{ legend:{display:false},
        tooltip:{callbacks:{ title:c=>`District ${D.districts[rk[c[0].dataIndex].i]}`,
          label:c=>{ const r=rk[c.dataIndex];
            return [`${M.short}: ${f1(M.get(r.bse))} → ${f1(M.get(r.cur))}`,
                    `Change: ${pp(r.v)}${mk==='mean'?'':'pp'}`,
                    `${r.boro} · ${r.elem}${r.ms!=='—'?' · '+r.ms:''}`]; }}} } }
  });

  /* ---- table ---- */
  renderDITable(rows, base);
  renderCohort(rows, base);
}
/* ---------------------------------------------------------------------
   Cohort size.
   The number of students tested is not fixed: some districts lost more than
   a tenth of their tested cohort between 2024 and 2026. Because a district's
   result is a percentage of whoever sat the test, a large change in who is
   being tested is a competing explanation for a large change in the result.
   This panel puts the two side by side rather than leaving it to be noticed.
   --------------------------------------------------------------------- */
function pearson(a, b){
  const n=a.length, ma=a.reduce((x,y)=>x+y,0)/n, mb=b.reduce((x,y)=>x+y,0)/n;
  let num=0, da=0, db=0;
  for (let i=0;i<n;i++){ const x=a[i]-ma, y=b[i]-mb; num+=x*y; da+=x*x; db+=y*y; }
  return num/Math.sqrt(da*db);
}
function renderCohort(rows, base){
  const pts = rows.filter(r=>r.cur&&r.bse&&r.bse.n).map(r=>({
    i:r.i, boro:r.boro,
    dn: (r.cur.n - r.bse.n)/r.bse.n*100,
    dp: r.dprof, dl: r.dl1,
  }));
  if (pts.length < 3){ $('di-cohort-wrap').style.display='none'; return; }
  $('di-cohort-wrap').style.display='';
  const rP = pearson(pts.map(p=>p.dn), pts.map(p=>p.dp));
  const rL = pearson(pts.map(p=>p.dn), pts.map(p=>p.dl));

  draw('di-cohort', {
    type:'bubble',
    data:{ datasets: D.boros.map(b=>({
      label:b, backgroundColor:BORO_COLOR[b]+'CC', borderColor:BORO_COLOR[b], borderWidth:1,
      data: pts.filter(p=>p.boro===b).map(p=>({x:p.dn, y:p.dp, r:7, d:p}))
    })).filter(ds=>ds.data.length) },
    options:{
      scales:{ x:gridY(`change in students tested vs ${base} (%)`,
                 {grid:{color:c=>c.tick.value===0?'#5B6B7A':'#EDF1F5',
                        lineWidth:c=>c.tick.value===0?1.6:1}}),
               y:gridY(`change in proficiency vs ${base} (pp)`,
                 {grid:{color:c=>c.tick.value===0?'#5B6B7A':'#EDF1F5',
                        lineWidth:c=>c.tick.value===0?1.6:1}}) },
      plugins:{ legend:{display:false},
        tooltip:{callbacks:{ label:c=>{ const d=c.raw.d;
          return [`District ${D.districts[d.i]} · ${d.boro}`,
                  `Students tested ${pp(d.dn)}%`,
                  `Proficiency ${pp(d.dp)}pp`,
                  `Level 1 ${pp(d.dl)}pp`]; }}} } }
  });

  const shrank = pts.filter(p=>p.dn < -5), steady = pts.filter(p=>p.dn >= -2);
  const mean = a => a.reduce((x,y)=>x+y,0)/a.length;
  $('di-cohort-note').innerHTML =
    `<b>Reading the zero lines.</b> The darker lines mark zero on each axis. A district above the horizontal line raised proficiency; one to the right of the vertical line tested more students than in ${base}. A district sitting on a line did not move on that measure. `
    + `Where a change is shown as <b>0.0</b> it is written without a sign on purpose: the movement is smaller than a tenth of a percentage point, which is not the same as no change at all, and it is never rendered as &minus;0.0. A district with no comparable figure in both years reads <b>n/c</b> and is left out of this chart entirely rather than plotted at zero. `
    +
    `Across the ${pts.length} districts shown, the change in how many students sat the test correlates with the change in proficiency at <b>r = ${rP.toFixed(2)}</b>, and with the change in the Level&nbsp;1 share at <b>r = ${rL.toFixed(2)}</b>. `
    + (shrank.length && steady.length
      ? `The ${shrank.length} districts whose tested cohort shrank by more than 5% averaged <b>${pp(mean(shrank.map(p=>p.dp)))}pp</b> on proficiency and <b>${pp(mean(shrank.map(p=>p.dl)))}pp</b> on Level&nbsp;1; the ${steady.length} whose cohort held steady or grew averaged <b>${pp(mean(steady.map(p=>p.dp)))}pp</b> and <b>${pp(mean(steady.map(p=>p.dl)))}pp</b>. `
      : '')
    + `A district's result is a percentage of whoever sat the test, so a cohort that changes size by a tenth is a competing explanation for a large measured gain. This does not say the gains are not real; it says cohort change has to be ruled out before they are attributed to instruction.`;
}

/* Columns follow the selected grade band: elementary grades show the K-5
   phase, provider and curriculum; middle grades show the 6-8 ones; all grades
   shows both, since both are in play. */
function diCols(bk){
  const sc = scopeOf(bk);
  const assign = !HAS_VENDORS ? [
        {k:'phaseBoth', t:'Phase (elem / MS)', sort:r=>r.elem+r.ms, kind:'phaseBoth'} ]
    : sc === 'both'
    ? [ {k:'phaseBoth', t:'Phase (elem / MS)', sort:r=>r.elem+r.ms, kind:'phaseBoth'},
        {k:'k5j', t:'K–5 provider',   sort:r=>r.k5j, kind:'wrap'},
        {k:'k5c', t:'K–5 curriculum', sort:r=>r.k5c, kind:'text'},
        {k:'msj', t:'6–8 provider',   sort:r=>r.msj, kind:'wrap'},
        {k:'msc', t:'6–8 curriculum', sort:r=>r.msc, kind:'text'} ]
    : [ {k:'phase', t:sc==='ms'?'MS phase':'Elem phase', sort:r=>r.phase, kind:'text'},
        {k:'reads', t:sc==='ms'?'6–8 provider':'K–5 provider',     sort:r=>r.reads, kind:'wrap'},
        {k:'ec',    t:sc==='ms'?'6–8 curriculum':'K–5 curriculum', sort:r=>r.ec,    kind:'text'} ];
  return [
    {k:'label', t:'District', sort:r=>r.n,    kind:'name'},
    {k:'boro',  t:'Borough',  sort:r=>r.boro, kind:'text'},
    ...assign,
    {k:'n',     t:'Tested 2026', sort:r=>r.cur?r.cur.n:-1,     kind:'num'},
    {k:'dn',    t:'Δ tested %',  sort:r=>r.dn==null?-999:r.dn, kind:'heat', good:0, scale:12},
    {k:'prof',  t:'% L3–4 2026', sort:r=>r.cur?r.cur.prof:-1,  kind:'lvl', hue:'0,112,185', lo:20, hi:80},
    {k:'dprof', t:'Δ L3–4',      sort:r=>r.dprof==null?-99:r.dprof, kind:'heat', good:+1, scale:8},
    {k:'l1',    t:'% L1 2026',   sort:r=>r.cur?r.cur.l1:-1,    kind:'lvl', hue:'192,72,60', lo:5, hi:45},
    {k:'dl1',   t:'Δ L1',        sort:r=>r.dl1==null?99:r.dl1, kind:'heat', good:-1, scale:8},
    {k:'l4',    t:'% L4 2026',   sort:r=>r.cur?r.cur.l4:-1,    kind:'lvl', hue:'28,53,94', lo:2, hi:45},
    {k:'mean',  t:'Mean score',  sort:r=>r.cur?r.cur.mean:-1,  kind:'mean'},
    {k:'sig',   t:'Signal',      sort:r=>signal(r).rank,       kind:'sig'},
  ];
}

function renderDITable(rows, base){
  const COLS = diCols($('di-grade').value);
  const col = COLS.find(c=>c.k===DI.sort) || COLS.find(c=>c.k==='dprof');
  const sorted = rows.slice().sort((a,b)=>{
    const x=col.sort(a), y=col.sort(b);
    if (typeof x === 'string') return DI.dir * x.localeCompare(y);
    return DI.dir * (y-x);
  });
  const head = COLS.map(c =>
    `<th data-sort="${c.k}">${c.t}${DI.sort===c.k?` <span class="ar">${DI.dir>0?'▼':'▲'}</span>`:''}</th>`).join('');
  const body = sorted.map(r => {
    const s = signal(r);
    const cell = c => {
      switch(c.kind){
        case 'name': return `<td class="nm">District ${D.districts[r.i]}</td>`;
        case 'text': return `<td>${esc(r[c.k]) || '<span class="muted">—</span>'}</td>`;
        case 'wrap': return `<td style="white-space:normal;min-width:140px">${esc(r[c.k]) || '<span class="muted">—</span>'}</td>`;
        case 'phaseBoth': return `<td style="white-space:normal">${esc(r.elem)}<br><span class="muted">${esc(r.ms)}</span></td>`;
        case 'num':  return `<td>${r.cur?num(r.cur.n):'<span class="sup">s</span>'}</td>`;
        case 'lvl':  { const v = r.cur ? (c.k==='prof'?r.cur.prof:c.k==='l1'?r.cur.l1:r.cur.l4) : null;
                       return `<td><span class="cell" style="${shade(v,c.lo,c.hi,c.hue)}">${v==null?'s':f1(v)}</span></td>`; }
        case 'heat': { const v = r[c.k];
                       if (v==null && r.bandNote)
                         return `<td><span class="cell nc" title="Not comparable: ${esc(r.bandNote)}">n/c</span></td>`;
                       return `<td><span class="cell" style="${heat(v,c.scale,c.good)}">${v==null?'s':pp(v)}</span></td>`; }
        case 'mean': return `<td>${r.cur?f1(r.cur.mean):'<span class="sup">s</span>'}</td>`;
        case 'sig':  return `<td><span class="tag" style="background:${s.c}">${s.t}</span></td>`;
      }
    };
    return `<tr>${COLS.map(cell).join('')}</tr>`;
  }).join('');
  const t = $('di-table');
  t.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  t.querySelectorAll('th[data-sort]').forEach(th => th.onclick = () => {
    const k = th.dataset.sort;
    if (DI.sort === k) DI.dir *= -1; else { DI.sort = k; DI.dir = 1; }
    renderDI();
  });
}
/* =====================================================================
   PAGE 3 — BOROUGHS
   ===================================================================== */
function initBO(){
  fillBaselines($('bo-base')); fillBands($('bo-grade')); fillDims($('bo-dim'));
  fillCats($('bo-dim'), $('bo-cat'));
  fillMetrics($('bo-metric'), ['prof','l1','l4','mean'], 'prof');
  multiSelect('bo-ms-boro', 'Boroughs',
    D.boros.map(b => ({ v:b, t:b, n: ALL_DIST.filter(i=>D.districtBoro[i]===b).length })), renderBO, 'All boroughs');
  multiSelect('bo-ms-phase', 'NYC Reads phase', [
    { v:'elem1', t:'Elementary Phase 1 · SY 2023–24', n:D.phase.elem1.length },
    { v:'elem2', t:'Elementary Phase 2 · SY 2024–25', n:D.phase.elem2.length },
    { v:'ms1',   t:'Middle school Phase 1 · SY 2025–26', n:D.phase.ms1.length },
    { v:'ms2',   t:'Middle school Phase 2 · SY 2026–27', n:D.phase.ms2.length },
  ], renderBO, 'All phases');
  hideIfAbsent('bo-ms-reads', HAS_JESP());
  hideIfAbsent('bo-ms-curr',  HAS_CURR());
  if (HAS_JESP()) multiSelect('bo-ms-reads', 'K–5 provider (JESP)',
    V.k5JespRoster.map(v => ({ v, t:v, n: distsWith('k5j',v).length })), renderBO, 'All providers');
  multiSelect('bo-ms-curr', 'K–5 curriculum',
    V.k5CurrRoster.map(c => ({ v:c, t:c, n: distsWith('k5c',c).length })), renderBO, 'All curricula');
  on($('bo-dim'), () => { fillCats($('bo-dim'), $('bo-cat')); renderBO(); });
  ['bo-base','bo-grade','bo-cat','bo-metric'].forEach(id => on($(id), renderBO));
  $('bo-reset').onclick = () => {
    ['bo-ms-boro','bo-ms-phase','bo-ms-reads','bo-ms-curr'].forEach(k => msSel(k).clear());
    initBO(); renderBO();
  };
}
/* boroughs shown on this page: the borough control alone drives the borough
   charts, since the phase / provider / curriculum controls are district-level */
function boShown(){
  return ALL_BORO.filter(i => msPass('bo-ms-boro', D.boros[i]));
}
/* districts shown in the district-level chart on this page: every control applies */
function boDistricts(){
  return ALL_DIST.filter(i => {
    const n = distNum(i);
    if (!msPass('bo-ms-boro', D.districtBoro[i])) return false;
    const phases = ['elem1','elem2','ms1','ms2'].filter(k => PHASES[k].has(n));
    if (!msPass('bo-ms-phase', phases)) return false;
    if (!msPass('bo-ms-reads', k5Jesp(i))) return false;
    if (!msPass('bo-ms-curr', k5Curr(i))) return false;
    return true;
  });
}
function renderBO(){
  const base=+$('bo-base').value, bk=$('bo-grade').value, cat=+$('bo-cat').value;
  const mk=$('bo-metric').value, M=METRICS[mk];
  const bl = band(bk).label.toLowerCase(), gl = groupLabel($('bo-dim'),$('bo-cat'));

  $('bo-trendsub').textContent = `${M.label}, ${band(bk).label.toLowerCase()}, ${gl.toLowerCase()}, 2023 to 2026.`;
  $('bo-dsub').innerHTML = `${M.label} in 2026 for all 32 community school districts, ordered ${M.good>0?'highest to lowest':'lowest to highest'}. Bars are colored by borough. District values come from the district file and will not sum to the borough bars above.`;

  const shown = boShown();
  const dshown = boDistricts();
  renderFocus('bo', 'boro', shown.length === 1 ? shown[0] : null,
              shown.length === 1 ? D.boros[shown[0]] : '', bk, cat, base);
  activeBar('bo-active', 'bo', 5, `${shown.length} of 5 boroughs · ${dshown.length} of 32 districts`);

  const series = shown.map(i => ({ i, name:D.boros[i],
    vals: MODERN.map(y => { const a = agg('boro',[i],bk,y,cat); return a ? M.get(a) : null; }),
    cur: agg('boro',[i],bk,2026,cat), bse: agg('boro',[i],bk,base,cat) }));

  const moved = series.map(s=>({ ...s, d: delta(s.cur, s.bse, M.get) })).filter(s=>s.d!=null);
  const bestB = moved.slice().sort((a,b)=>(b.d-a.d)*M.good)[0];
  $('bo-insight').innerHTML = moved.length
    ? `On ${bl}, ${gl.toLowerCase()}, ${M.label.toLowerCase()} in 2026 ranges from <b>${f1(Math.min(...moved.map(s=>M.get(s.cur))))}</b> to <b>${f1(Math.max(...moved.map(s=>M.get(s.cur))))}</b> across the five boroughs. `
      + `Measured from ${base}, ${bestB.name} moved furthest in the direction of improvement (${pp(bestB.d)}${mk==='mean'?'':'pp'}). `
      + moved.slice().sort((a,b)=>(b.d-a.d)*M.good).map(s=>`${s.name} ${pp(s.d)}`).join(', ') + '.'
    : 'No borough data for this combination.';

  draw('bo-trend', {
    type:'line',
    data:{ labels:MODERN.map(String), datasets: series.map(s=>({
      label:s.name, data:s.vals, borderColor:BORO_COLOR[s.name], backgroundColor:BORO_COLOR[s.name],
      borderWidth:2.6, tension:.25, pointRadius:4, pointHoverRadius:6 })) },
    options:{ scales:{ x:gridX, y:gridY(M.short) },
      plugins:{ legend:{position:'bottom'}, tooltip:ppTip(mk==='mean'?'':'%') } },
    plugins:[markerPlugin(() => MARKS.bo ? markSet(WAVES, MODERN_SLOT) : [])]
  });
  $('bo-trend-marks').innerHTML = MARKS.bo ? markHTML(WAVES) : '';

  const d26 = shown.map(i => agg('boro',[i],bk,2026,cat));
  draw('bo-dist', {
    type:'bar',
    data:{ labels:shown.map(i=>D.boros[i]), datasets:[0,1,2,3].map(i=>({
      label:`Level ${i+1}`, backgroundColor:LVL_COLOR[i], borderWidth:0,
      data:d26.map(a=>a?[a.l1,a.l2,a.l3,a.l4][i]:null) })) },
    options:{ scales:{ x:Object.assign({stacked:true},gridX,{ticks:{font:{size:10.5}}}),
        y:gridY('% of tested students',{stacked:true,max:100}) },
      plugins:{ legend:{display:false}, tooltip:ppTip('%') } }
  });

  /* districts colored by borough */
  const dd = dshown.map(i => ({ i, boro:D.districtBoro[i], a: agg('dist',[i],bk,2026,cat) }))
                   .filter(d=>d.a).sort((a,b)=>(M.get(b.a)-M.get(a.a))*M.good);
  draw('bo-dbar', {
    type:'bar',
    data:{ labels: dd.map(d=>'D'+D.districts[d.i]), datasets:[{
      label:M.short, data: dd.map(d=>M.get(d.a)), borderWidth:0,
      backgroundColor: dd.map(d=>BORO_COLOR[d.boro]) }]},
    options:{ scales:{ x:Object.assign({},gridX,{ticks:{font:{size:10},autoSkip:false}}), y:gridY(M.short) },
      plugins:{ legend:{display:false},
        tooltip:{callbacks:{ title:c=>`District ${D.districts[dd[c[0].dataIndex].i]} · ${dd[c[0].dataIndex].boro}`,
          label:c=>{ const a=dd[c.dataIndex].a;
            return [`${M.short}: ${f1(M.get(a))}`, `${num(a.n)} tested`, `Level 1 ${f1(a.l1)}% · Level 3–4 ${f1(a.prof)}%`]; }}} } }
  });
  $('bo-dbar-lg').innerHTML = [...new Set(dd.map(d=>d.boro))]
    .map(b=>`<span><i class="dot" style="background:${BORO_COLOR[b]}"></i>${b}</span>`).join('');

  /* borough x grade table */
  const gk = ['g3','g4','g5','g6','g7','g8'];
  const head = `<thead><tr><th class="nos">Borough</th><th class="nos">Measure</th>`
    + gk.map((k,i)=>`<th class="nos">Grade ${i+3}</th>`).join('')
    + `<th class="nos">All grades</th></tr></thead>`;
  const body = shown.map(i=>{
    const pr = gk.concat(['all']).map(k=>{ const a=agg('boro',[i],k,2026,cat); return a?a.prof:null; });
    const l1 = gk.concat(['all']).map(k=>{ const a=agg('boro',[i],k,2026,cat); return a?a.l1:null; });
    return `<tr><td class="nm" rowspan="2">${D.boros[i]}</td><td class="muted">% Level 3–4</td>`
      + pr.map(v=>`<td><span class="cell" style="${shade(v,20,80,'0,112,185')}">${v==null?'s':f1(v)}</span></td>`).join('') + '</tr>'
      + `<tr><td class="muted">% Level 1</td>`
      + l1.map(v=>`<td><span class="cell" style="${shade(v,5,45,'192,72,60')}">${v==null?'s':f1(v)}</span></td>`).join('') + '</tr>';
  }).join('');
  $('bo-table').innerHTML = head + `<tbody>${body}</tbody>`;
}
/* =====================================================================
   PAGE 4 — NYC READS PHASES
   ===================================================================== */
/* exposure at the time of each spring test, in completed school years */
const EXPOSURE = [
  { g:'Elementary Phase 1', band:'Grades 3–5', launch:'SY 2023–24', e:{2023:0,2024:1,2025:2,2026:3} },
  { g:'Elementary Phase 2', band:'Grades 3–5', launch:'SY 2024–25', e:{2023:0,2024:0,2025:1,2026:2} },
  { g:'Middle school Phase 1', band:'Grades 6–8', launch:'SY 2025–26', e:{2023:0,2024:0,2025:0,2026:1} },
  { g:'Middle school Phase 2', band:'Grades 6–8', launch:'SY 2026–27', e:{2023:0,2024:0,2025:0,2026:0} },
];
function initPH(){
  fillDims($('ph-dim')); fillCats($('ph-dim'), $('ph-cat'));
  fillMetrics($('ph-metric'), ['prof','l1','l4','mean'], 'prof');
  on($('ph-dim'), () => { fillCats($('ph-dim'), $('ph-cat')); renderPH(); });
  ['ph-cat','ph-metric'].forEach(id => on($(id), renderPH));

  /* timeline */
  const chips = arr => arr.slice().sort((a,b)=>a-b).map(n=>`<span class="chip">D${String(n).padStart(2,'0')}</span>`).join('');
  $('ph-timeline').innerHTML = [
    ['Phase 1 Elementary', 'SY 2023–24', D.phase.elem1, 'K–5 curriculum — reaches tested grades 3–5'],
    ['Phase 2 Elementary', 'SY 2024–25', D.phase.elem2, 'K–5 curriculum — reaches tested grades 3–5'],
    ['Phase 1 Middle school', 'SY 2025–26', D.phase.ms1, 'Grades 6–8 curriculum'],
    ['Phase 2 Middle school', 'SY 2026–27', D.phase.ms2, 'Grades 6–8 — begins after the 2026 test'],
  ].map(([t,sy,ds,note]) =>
    `<div style="margin-bottom:14px"><div style="font-weight:700;font-size:13.5px;color:var(--navy)">${t}
      <span class="muted" style="font-weight:500"> · launched ${sy} · ${ds.length} districts in the district file</span></div>
      <div class="muted" style="font-size:11.5px;margin-bottom:5px">${note}</div>${chips(ds)}</div>`).join('')
    + `<div class="muted" style="font-size:11.5px;margin-top:6px">District&nbsp;75 is listed by NYCPS in the Phase&nbsp;1 Elementary, Phase&nbsp;2 Elementary and Phase&nbsp;2 Middle School cohorts. It is not reported in the district file, so it cannot appear above. The Phase&nbsp;1 High School cohort is defined by high-school networks rather than community school districts and falls outside grades 3–8 entirely.</div>`;

  /* exposure table */
  $('ph-exposure').innerHTML =
    `<thead><tr><th class="nos">Group</th><th class="nos">Tested grades reached</th><th class="nos">Launch</th>`
    + MODERN.map(y=>`<th class="nos">${y} test</th>`).join('') + `</tr></thead><tbody>`
    + EXPOSURE.map(r=>`<tr><td class="nm">${r.g}</td><td>${r.band}</td><td>${r.launch}</td>`
        + MODERN.map(y=>{ const v=r.e[y];
            return `<td><span class="cell" style="${shade(v,0,3,'0,112,185')}">${v} yr${v===1?'':'s'}</span></td>`; }).join('')
        + `</tr>`).join('')
    + `</tbody>`;
}
function phaseAgg(dnums, bandKey, year, cat){
  return agg('dist', dnums.map(distIdx).filter(i=>i>=0), bandKey, year, cat);
}
function renderPH(){
  const cat=+$('ph-cat').value, mk=$('ph-metric').value, M=METRICS[mk];
  const gl = groupLabel($('ph-dim'),$('ph-cat'));
  const G = {
    e1: { name:'Elementary Phase 1', ds:D.phase.elem1, band:'35', color:CAT[5] },
    e2: { name:'Elementary Phase 2', ds:D.phase.elem2, band:'35', color:CAT[6] },
    m1: { name:'Middle school Phase 1', ds:D.phase.ms1, band:'68', color:CAT[7] },
    m0: { name:'Not yet in middle school rollout', ds:ALL_DIST.map(distNum).filter(n=>!PHASES.ms1.has(n)), band:'68', color:CAT[3] },
    p1: { name:'Elementary Phase 1 districts', ds:D.phase.elem1, band:'68', color:CAT[5] },
    p2: { name:'Elementary Phase 2 districts', ds:D.phase.elem2, band:'68', color:CAT[6] },
  };
  const ser = g => MODERN.map(y => { const a = phaseAgg(g.ds, g.band, y, cat); return a ? M.get(a) : null; });
  const lineOpts = (title) => ({ scales:{ x:gridX, y:gridY(title) },
    plugins:{ legend:{position:'bottom'}, tooltip:ppTip(mk==='mean'?'':'%') } });
  const mkLine = (id, gs, title, waves) => {
    draw(id, {
      type:'line',
      data:{ labels:MODERN.map(String), datasets: gs.map(g=>({
        label:`${g.name} (${g.ds.filter(n=>distIdx(n)>=0).length} districts)`, data:ser(g),
        borderColor:g.color, backgroundColor:g.color, borderWidth:3, tension:.25, pointRadius:5 })) },
      options: lineOpts(title),
      plugins:[markerPlugin(() => MARKS.ph ? markSet(waves, MODERN_SLOT).map((m,i)=>({...m,row:i})) : [])]
    });
    const el = $(id+'-marks'); if (el) el.innerHTML = MARKS.ph ? markHTML(waves) : '';
  };
  const W = k => WAVES.filter(w=>k.includes(w.k));
  /* only the waves that reach the grades on each chart */
  mkLine('ph-elem', [G.e1,G.e2], `${M.short}, grades 3–5`, W(['elem1','elem2']));
  mkLine('ph-ms',   [G.m1,G.m0], `${M.short}, grades 6–8`, W(['ms1']));
  mkLine('ph-placebo', [G.p1,G.p2], `${M.short}, grades 6–8`, W(['ms1']));

  /* contrast table */
  const rowsFor = (gs, label) => {
    const cells = gs.map(g => {
      const o = {};
      for (const y of MODERN) o[y] = phaseAgg(g.ds, g.band, y, cat);
      return { g, o, d23: delta(o[2026], o[2023], M.get),
                    d24: delta(o[2026], o[2024], M.get) };
    });
    const diff23 = cells[0].d23!=null && cells[1].d23!=null ? cells[0].d23-cells[1].d23 : null;
    const diff24 = cells[0].d24!=null && cells[1].d24!=null ? cells[0].d24-cells[1].d24 : null;
    return { label, cells, diff23, diff24 };
  };
  const blocks = [
    rowsFor([G.e1,G.e2], 'Elementary rollout · tested grades 3–5'),
    rowsFor([G.m1,G.m0], 'Middle-school rollout · tested grades 6–8'),
    rowsFor([G.p1,G.p2], 'Check: elementary groups measured on grades 6–8'),
  ];
  const head = `<thead><tr><th class="nos">Group</th><th class="nos">Districts</th><th class="nos">Tested 2026</th>`
    + MODERN.map(y=>`<th class="nos">${y}</th>`).join('')
    + `<th class="nos">Δ 2023→2026</th><th class="nos">Δ 2024→2026</th></tr></thead>`;
  const body = blocks.map(b => {
    const sub = `<tr><td colspan="${3+MODERN.length+2}" style="background:#F3F6F8;font-weight:700;color:var(--navy);text-align:left;font-size:11.5px;letter-spacing:.04em;text-transform:uppercase">${b.label}</td></tr>`;
    const rs = b.cells.map(c =>
      `<tr><td class="nm">${c.g.name}</td><td>${c.g.ds.filter(n=>distIdx(n)>=0).length}</td>
        <td>${c.o[2026]?num(c.o[2026].n):'s'}</td>`
      + MODERN.map(y=>`<td>${c.o[y]?f1(M.get(c.o[y])):'s'}</td>`).join('')
      + `<td><span class="cell" style="${heat(c.d23,8,M.good)}">${c.d23==null?'s':pp(c.d23)}</span></td>`
      + `<td><span class="cell" style="${heat(c.d24,8,M.good)}">${c.d24==null?'s':pp(c.d24)}</span></td></tr>`).join('');
    const dr = `<tr><td class="nm muted" style="font-style:italic">Difference between the two groups</td>
      <td colspan="${1+MODERN.length+1}"></td>
      <td><span class="cell" style="${heat(b.diff23,4,M.good)}">${b.diff23==null?'s':pp(b.diff23)}</span></td>
      <td><span class="cell" style="${heat(b.diff24,4,M.good)}">${b.diff24==null?'s':pp(b.diff24)}</span></td></tr>`;
    return sub + rs + dr;
  }).join('');
  $('ph-table').innerHTML = head + `<tbody>${body}</tbody>`;

  /* insight — written from the numbers, with the placebo contrast alongside */
  const eb = blocks[0], mb = blocks[1], pb = blocks[2];
  const unit = mk==='mean' ? ' points' : 'pp';
  let t = `On ${M.label.toLowerCase()} for ${gl.toLowerCase()}: between 2023 and 2026, Elementary Phase&nbsp;1 districts moved <b>${pp(eb.cells[0].d23)}${unit}</b> on tested grades 3–5 and Phase&nbsp;2 districts moved <b>${pp(eb.cells[1].d23)}${unit}</b> — a difference of <b>${pp(eb.diff23)}${unit}</b>, `;
  t += Math.abs(eb.diff23) < 1
    ? `which is small enough that the two waves are essentially tracking each other despite a year's difference in exposure.`
    : `with the ${(eb.diff23*M.good)>0?'earlier':'later'} wave ahead.`;
  t += ` The same two groups measured on grades 6–8, which the elementary curriculum does not reach, differ by <b>${pp(pb.diff23)}${unit}</b> over the same years`;
  t += Math.abs(Math.abs(pb.diff23) - Math.abs(eb.diff23)) < 1
    ? `, about the same size — so the elementary contrast is not distinguishable from a general difference between these two sets of districts.`
    : `, a different size, so the elementary contrast is not simply a property of these districts.`;
  t += ` On grades 6–8, the eight districts that began the middle-school rollout in 2025–26 moved <b>${pp(mb.cells[0].d23)}${unit}</b> since 2023 against <b>${pp(mb.cells[1].d23)}${unit}</b> for the rest, a gap of <b>${pp(mb.diff23)}${unit}</b> after a single year of implementation.`;
  $('ph-insight').innerHTML = t;
}
/* =====================================================================
   PAGE 5 — SUBGROUPS AND GAPS
   ===================================================================== */
const GAP_PAIRS = [
  ['White','Black'], ['White','Hispanic'],
  ['Not Econ Disadv','Econ Disadv'],
  ['Not SWD','SWD'], ['Never ELL','Current ELL'],
];
function initSG(){
  fill($('sg-level'), [{v:'city',t:'Citywide'},{v:'boro',t:'Borough'},{v:'dist',t:'District'}], 'city');
  fillBands($('sg-grade'));
  fill($('sg-dim'), D.dims.filter(d=>d.k!=='all').map(d=>({v:d.k,t:d.label})), 'eth');
  fillMetrics($('sg-metric'), ['prof','l1','l4','mean'], 'prof');
  syncSGGeo();
  on($('sg-level'), () => { syncSGGeo(); renderSG(); });
  ['sg-geo','sg-grade','sg-dim','sg-metric'].forEach(id => on($(id), renderSG));
  renderGlossary();
}

/* ---------------------------------------------------------------------
   Glossary.

   NYCPS asked for the abbreviations in the Category column to be spelled
   out, and separately for the file's own strings to be identifiable. Both
   at once: the screen carries the readable name, and this table maps every
   one of them back to the exact Category value and the tab it was read
   from, so a reader can check any group against the workbook without
   taking the mapping on trust.

   Built once, from the payload, so it cannot drift from what the lookups
   actually use.
   --------------------------------------------------------------------- */
function renderGlossary(){
  const rows = D.dims.flatMap(d => d.cats.map(c => ({ dim:d.label, c })));
  $('sg-glossary').innerHTML =
    `<thead><tr><th class="nos">Name used here</th><th class="nos">Category value in the file</th>`
    + `<th class="nos">Source tab</th><th class="nos">Reported group</th><th class="nos">Definition</th></tr></thead><tbody>`
    + rows.map(({dim, c}) => {
        const label = catName(c), raw = CATS[c];
        const sheet = (D.catSheets || [])[c] || '—';
        const note  = (D.catNotes  || [])[c] || '';
        return `<tr><td class="nm">${esc(label)}</td>`
          + `<td><code>${esc(raw)}</code>${label===raw?' <span class="muted">(unchanged)</span>':''}</td>`
          + `<td>${esc(sheet)}</td><td>${esc(dim)}</td>`
          + `<td style="white-space:normal;text-align:left;max-width:420px">${esc(note)}</td></tr>`;
      }).join('')
    + `</tbody>`;
}
function syncSGGeo(){
  const lvl=$('sg-level').value, el=$('sg-geo');
  if (lvl==='city'){ fill(el,[{v:0,t:'All of New York City'}]); el.disabled=true; }
  else if (lvl==='boro'){ fill(el, D.boros.map((b,i)=>({v:i,t:b}))); el.disabled=false; }
  else { fill(el, D.districts.map((d,i)=>({v:i,t:`District ${d} · ${D.districtBoro[i]}`}))); el.disabled=false; }
}
function renderSG(){
  const lvl=$('sg-level').value, geo=+$('sg-geo').value, bk=$('sg-grade').value;
  const dim=D.dims.find(d=>d.k===$('sg-dim').value), mk=$('sg-metric').value, M=METRICS[mk];
  const where = lvl==='city' ? 'New York City' : lvl==='boro' ? D.boros[geo] : `District ${D.districts[geo]}`;
  $('sg-trendsub').textContent = `${M.label} by ${dim.label.toLowerCase()}, ${where}, ${band(bk).label.toLowerCase()}, 2023 to 2026.`;

  const PAL = CAT;
  const series = dim.cats.map((c,i) => ({
    c, name:catName(c), color:PAL[i%PAL.length],
    vals: MODERN.map(y => { const a=agg(lvl,[geo],bk,y,c); return a?M.get(a):null; }),
    cur: agg(lvl,[geo],bk,2026,c), b23: agg(lvl,[geo],bk,2023,c), b24: agg(lvl,[geo],bk,2024,c),
  }));
  draw('sg-trend', {
    type:'line',
    data:{ labels:MODERN.map(String), datasets: series.map(s=>({
      label:s.name, data:s.vals, borderColor:s.color, backgroundColor:s.color,
      /* never bridge a suppressed year: a joined line would read as data */
      borderWidth:2.6, tension:.25, pointRadius:4, spanGaps:false })) },
    options:{ scales:{ x:gridX, y:gridY(M.short) },
      plugins:{ legend:{position:'bottom'}, tooltip:ppTip(mk==='mean'?'':'%') } },
    plugins:[markerPlugin(() => MARKS.sg ? markSet(WAVES, MODERN_SLOT) : [])]
  });
  $('sg-trend-marks').innerHTML = MARKS.sg ? markHTML(WAVES) : '';
  $('sg-supp').innerHTML = coverageNote(lvl, [geo], bk, dim.cats, where);

  $('sg-table').innerHTML =
    `<thead><tr><th class="nos">Group</th><th class="nos">Tested</th><th class="nos">% L1</th>
      <th class="nos">% L3–4</th><th class="nos">Δ vs 2023</th><th class="nos">Δ vs 2024</th></tr></thead><tbody>`
    + series.map(s=>{
        const d23 = delta(s.cur, s.b23, M.get);
        const d24 = delta(s.cur, s.b24, M.get);
        return `<tr><td class="nm">${esc(s.name)}</td>
          <td>${s.cur?num(s.cur.n):'<span class="sup">s</span>'}</td>
          <td>${s.cur?f1(s.cur.l1):'<span class="sup">s</span>'}</td>
          <td>${s.cur?f1(s.cur.prof):'<span class="sup">s</span>'}</td>
          <td><span class="cell" style="${heat(d23,8,M.good)}">${d23==null?'s':pp(d23)}</span></td>
          <td><span class="cell" style="${heat(d24,8,M.good)}">${d24==null?'s':pp(d24)}</span></td></tr>`;
      }).join('') + '</tbody>';

  /* citywide paired gaps (always citywide, all grades — stated on the card) */
  const gapSeries = GAP_PAIRS.map(([a,b],i) => ({
    name:`${catName(CATS.indexOf(a))} − ${catName(CATS.indexOf(b))}`, color:PAL[i%PAL.length],
    vals: MODERN.map(y => {
      const A=agg('city',[0],'all',y,CATS.indexOf(a)), B=agg('city',[0],'all',y,CATS.indexOf(b));
      return A&&B ? A.prof-B.prof : null; })
  }));
  draw('sg-gap', {
    type:'line',
    data:{ labels:MODERN.map(String), datasets: gapSeries.map(g=>({
      label:g.name, data:g.vals, borderColor:g.color, backgroundColor:g.color,
      borderWidth:2.6, tension:.25, pointRadius:4 })) },
    options:{ scales:{ x:gridX, y:gridY('gap in % Level 3–4 (pp)',{beginAtZero:true}) },
      plugins:{ legend:{position:'bottom'}, tooltip:ppTip('pp') } }
  });
  $('sg-gaptable').innerHTML =
    `<thead><tr><th class="nos">Gap in proficiency</th>` + MODERN.map(y=>`<th class="nos">${y}</th>`).join('')
    + `<th class="nos">Δ 2023→2026</th></tr></thead><tbody>`
    + gapSeries.map(g=>{
        const d = g.vals[3]!=null && g.vals[0]!=null ? g.vals[3]-g.vals[0] : null;
        return `<tr><td class="nm">${esc(g.name)}</td>`
          + g.vals.map(v=>`<td>${v==null?'s':f1(v)}</td>`).join('')
          + `<td><span class="cell" style="${heat(d,6,-1)}">${d==null?'s':pp(d)}</span></td></tr>`; }).join('')
    + `</tbody>`;
  const narrowed = gapSeries.filter(g=>g.vals[3]!=null&&g.vals[0]!=null&&g.vals[3]<g.vals[0]);
  const widened  = gapSeries.filter(g=>g.vals[3]!=null&&g.vals[0]!=null&&g.vals[3]>g.vals[0]);
  $('sg-insight').innerHTML = `Citywide across all grades, ${narrowed.length} of the ${gapSeries.length} paired proficiency gaps narrowed between 2023 and 2026 and ${widened.length} widened. `
    + (narrowed.length ? `Narrowed: ${narrowed.map(g=>`${g.name} (${pp(g.vals[3]-g.vals[0])}pp, now ${f1(g.vals[3])}pp)`).join('; ')}. ` : '')
    + (widened.length  ? `Widened: ${widened.map(g=>`${g.name} (${pp(g.vals[3]-g.vals[0])}pp, now ${f1(g.vals[3])}pp)`).join('; ')}.` : '');
}
/* =====================================================================
   PAGE 6 — TEST FORMAT
   ===================================================================== */
/* Grade -> first year administered by computer, per the NOTES tab:
   "Starting in 2024, NYSED transitioned from a paper-based test to a
    computer-based test for grades 5 and 8; this was expanded to grades
    4 and 6 in 2025."  Grades 3 and 7 are not named. */
const CBT_YEAR = { 3:null, 4:2025, 5:2024, 6:2025, 7:null, 8:2024 };
const TF_GROUPS = [
  { k:'y24', name:'Moved to computer in 2024', grades:[5,8], color:CAT[0] },
  { k:'y25', name:'Moved to computer in 2025', grades:[4,6], color:CAT[1] },
  { k:'pap', name:'Not named in the transition', grades:[3,7], color:CAT[3] },
];
function initTF(){
  fillMetrics($('tf-metric'), ['prof','l1','l4','mean'], 'prof');
  on($('tf-metric'), renderTF);
  $('tf-key').innerHTML =
    `<thead><tr><th class="nos">Grade</th><th class="nos">First computer-based year</th><th class="nos">Group used on this page</th></tr></thead><tbody>`
    + [3,4,5,6,7,8].map(g=>{
        const y = CBT_YEAR[g];
        const grp = TF_GROUPS.find(t=>t.grades.includes(g));
        return `<tr><td class="nm">Grade ${g}</td><td>${y ?? '<span class="muted">not stated in the source notes</span>'}</td><td>${grp.name}</td></tr>`;
      }).join('') + '</tbody>';
}
function tfAgg(grades, y, mkey){
  const keys = grades.map(g=>'g'+g);
  let n=0,c1=0,c2=0,c3=0,c4=0,wm=0;
  for (const k of keys){ const a=agg('city',[0],k,y,ALLCAT); if(!a) return null;
    n+=a.n; c1+=a.c1; c2+=a.c2; c3+=a.c3; c4+=a.c4; wm+=a.mean*a.n; }
  return { n, l1:c1/n*100, l2:c2/n*100, l3:c3/n*100, l4:c4/n*100, prof:(c3+c4)/n*100, mean:wm/n };
}
function renderTF(){
  const mk=$('tf-metric').value, M=METRICS[mk];
  $('tf-sub1').textContent = `${M.label}, citywide, all students. Grades are grouped by the year in which the source notes record their transition to computer. Each line is dashed while those grades were administered on paper and solid once they were administered on computer.`;

  const ser = TF_GROUPS.map(g=>({ ...g,
    vals: MODERN.map(y=>{ const a=tfAgg(g.grades,y,mk); return a?M.get(a):null; }) }));

  /* The administration mode is carried by the line itself rather than by
     annotations over the plot: hollow points and a dashed line while the
     grades were on paper, filled points and a solid line once they moved to
     computer. The year the switch happened is where the points change. */
  const onComputer = (g, yi) => { const cy = CBT_YEAR[g.grades[0]];
    return cy != null && MODERN[yi] >= cy; };
  draw('tf-trend', {
    type:'line',
    data:{ labels:MODERN.map(String), datasets: ser.map(g=>({
      label:`Grades ${g.grades.join(' and ')}`, data:g.vals,
      borderColor:g.color, backgroundColor:'#fff',
      borderWidth:3, tension:.25,
      pointRadius:6, pointHoverRadius:8, pointBorderWidth:2.5,
      pointBorderColor:g.color,
      /* filled once on computer, hollow while on paper */
      pointBackgroundColor: MODERN.map((_,i)=> onComputer(g,i) ? g.color : '#fff'),
      segment:{ borderDash: c =>
        (onComputer(g, c.p0DataIndex) && onComputer(g, c.p1DataIndex)) ? undefined : [6,5] },
    })) },
    options:{ scales:{ x:gridX, y:gridY(M.short) },
      plugins:{ legend:{position:'bottom'},
        tooltip:{ callbacks:{ label: c => {
          const g = ser[c.datasetIndex];
          return `Grades ${g.grades.join(' and ')}: ${f1(c.parsed.y)}${mk==='mean'?'':'%'}`
               + ` · ${onComputer(g,c.dataIndex) ? 'computer' : 'paper'}`; } } } } }
  });
  $('tf-trend-marks').innerHTML =
    `<span><svg width="34" height="12"><line x1="0" y1="6" x2="34" y2="6" stroke="#4F748B" stroke-width="2.5" stroke-dasharray="6,5"/><circle cx="17" cy="6" r="4.5" fill="#fff" stroke="#4F748B" stroke-width="2.5"/></svg>Paper-based that year</span>`
  + `<span><svg width="34" height="12"><line x1="0" y1="6" x2="34" y2="6" stroke="#0070B9" stroke-width="2.5"/><circle cx="17" cy="6" r="4.5" fill="#0070B9" stroke="#0070B9" stroke-width="2.5"/></svg>Computer-based that year</span>`
  + `<span class="muted">Grades 3 and 7 are not named in the source notes as having transitioned, so they stay hollow throughout.</span>`;
  draw('tf-delta', {
    type:'bar',
    data:{ labels:['2024','2025','2026'], datasets: ser.map(g=>({
      label:`Grades ${g.grades.join(' and ')}`, backgroundColor:g.color, borderWidth:0,
      data:[1,2,3].map(i=> g.vals[i]!=null && g.vals[0]!=null ? g.vals[i]-g.vals[0] : null) })) },
    options:{ scales:{ x:gridX, y:gridY(`change from 2023${mk==='mean'?' (points)':' (pp)'}`,
        {grid:{color:c=>c.tick.value===0?'#9AA6B2':'#EDF1F5'}}) },
      plugins:{ legend:{position:'bottom'},
        tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${pp(c.parsed.y)}${mk==='mean'?'':'pp'}`}} } }
  });

  const g24=ser[0], g25=ser[1], gp=ser[2];
  const d24 = g24.vals[1]-g24.vals[0], dp24 = gp.vals[1]-gp.vals[0];
  const unit = mk==='mean' ? ' points' : 'pp';
  $('tf-insight').innerHTML =
    `In <b>2024</b>, the first year grades&nbsp;5 and&nbsp;8 were tested on computer, those two grades moved <b>${pp(d24)}${unit}</b> on ${M.label.toLowerCase()} against 2023, while grades&nbsp;3 and&nbsp;7, which the notes do not list as transitioning, moved <b>${pp(dp24)}${unit}</b> — a difference of <b>${pp(d24-dp24)}${unit}</b> in the same year. `
    + `By <b>2026</b> the three groups stand at ${ser.map(g=>`${f1(g.vals[3])} (grades ${g.grades.join(' and ')})`).join(', ')}. `
    + `This is a timing coincidence worth knowing about when reading year-on-year changes by grade; it is not evidence that the format caused the movement.`;

  /* per-grade table */
  const head = `<thead><tr><th class="nos">Grade</th><th class="nos">Computer from</th>`
    + MODERN.map(y=>`<th class="nos">${y}</th>`).join('') + `<th class="nos">Δ 2023→2026</th></tr></thead>`;
  const body = [3,4,5,6,7,8].map(g=>{
    const vs = MODERN.map(y=>{ const a=agg('city',[0],'g'+g,y,ALLCAT); return a?M.get(a):null; });
    const d = vs[3]!=null&&vs[0]!=null ? vs[3]-vs[0] : null;
    return `<tr><td class="nm">Grade ${g}</td><td>${CBT_YEAR[g] ?? '<span class="muted">—</span>'}</td>`
      + vs.map((v,i)=>`<td${CBT_YEAR[g]===MODERN[i]?' style="box-shadow:inset 0 -3px 0 #0070B9"':''}>${v==null?'s':f1(v)}</td>`).join('')
      + `<td><span class="cell" style="${heat(d,8,M.good)}">${d==null?'s':pp(d)}</span></td></tr>`;
  }).join('');
  $('tf-table').innerHTML = head + `<tbody>${body}</tbody>`;
}
/* =====================================================================
   PAGE — PROFESSIONAL LEARNING PROVIDERS AND CURRICULUM
   Groups districts by the NYC Reads PL provider they work with and by the
   elementary curriculum they adopted, and shows ELA results for each group.
   Group aggregates sum student counts across the districts in the group.
   ===================================================================== */
function initVE(){
  fillBaselines($('ve-base')); fillDims($('ve-dim')); fillCats($('ve-dim'), $('ve-cat'));
  fillMetrics($('ve-metric'), ['prof','l1','l4','mean'], 'prof');
  const groupFields = Object.entries(VE_FIELDS).filter(([k]) => hasField(k));
  fill($('ve-group'), groupFields.map(([k,f]) => ({ v:k, t:f.label })),
       groupFields.length ? groupFields[0][0] : '');
  fill($('ve-band'), [
    { v:'35',  t:'Grades 3–5 (reached by the K–5 curriculum)' },
    { v:'all', t:'All grades (3–8)' },
    { v:'68',  t:'Grades 6–8' },
  ], '35');
  /* the single-district groups are noise; default to groups of 3 or more */
  fill($('ve-min'), [
    { v:'1', t:'Include every group' },
    { v:'2', t:'2 or more districts' },
    { v:'3', t:'3 or more districts' },
    { v:'5', t:'5 or more districts' },
  ], '3');
  buildVEPicker();
  on($('ve-dim'), () => { fillCats($('ve-dim'), $('ve-cat')); renderVE(); });
  on($('ve-group'), () => { msSel('ve-ms-groups').clear();
    /* the grade band follows the field: a K–5 provider only reaches grades 3–5 */
    $('ve-band').value = VE_FIELDS[$('ve-group').value].band;
    buildVEPicker(); renderVE(); });
  ['ve-base','ve-cat','ve-metric','ve-band','ve-min'].forEach(id => on($(id), renderVE));
  $('ve-reset').onclick = () => { msSel('ve-ms-groups').clear(); $('ve-min').value='3'; buildVEPicker(); renderVE(); };

  const row = (name, ds) =>
    `<tr><td class="nm">${esc(name)}</td><td>${ds.length}</td>
      <td style="white-space:normal">${ds.length
        ? ds.map(i=>`<span class="chip">D${D.districts[i]}</span>`).join('')
        : '<span class="muted">No district in the ELA files</span>'}</td></tr>`;
  /* The provider roster is only meaningful in a build that carries providers.
     Where it does not, the card is removed rather than left as an empty table,
     and the page presents itself as a curriculum page. */
  const jesp = HAS_JESP();
  /* nav entry and the comparison caveat follow the same fact */
  const navVE = document.querySelector('.ni[data-p="ve"]');
  if (navVE) navVE.lastChild.textContent = jesp ? 'Providers & curriculum' : 'Curriculum';
  const warn = $('ve-warn');
  if (warn) warn.innerHTML = jesp
    ? `<b>These groups were not formed for comparison.</b> Districts were not assigned to providers or curricula at random and did not start from the same place, group sizes are very uneven, and several districts work with more than one provider. Differences between groups describe the districts in them; they do not measure provider or curriculum effectiveness.`
    : `<b>These groups were not formed for comparison.</b> Districts did not choose their curriculum at random and did not start from the same place, and group sizes are very uneven. Differences between groups describe the districts in them; they do not measure curriculum effectiveness.`;
  const rosterCard = $('ve-roster-card');
  if (rosterCard) rosterCard.style.display = jesp ? '' : 'none';
  $('ve-title').textContent = jesp
    ? 'Professional learning providers and curriculum'
    : 'Curriculum';
  $('ve-sub').innerHTML = jesp
    ? `Districts grouped by the NYC Reads professional learning provider (JESP) they worked with and by the curriculum they adopted in <b>school year 2025&ndash;26</b>, the year the spring 2026 test measures. K&ndash;5 and grades 6&ndash;8 assignments are held separately because they differ.`
    : `Districts grouped by the curriculum they adopted in <b>school year 2025&ndash;26</b>, the year the spring 2026 test measures. K&ndash;5 and grades 6&ndash;8 adoptions are held separately because they differ. Professional learning provider assignments are not included in this version.`;
  if (jesp) $('ve-roster').innerHTML =
    `<thead><tr><th class="nos">K–5 provider (JESP)</th><th class="nos"># of districts</th><th class="nos">Districts</th></tr></thead><tbody>`
    + V.k5JespRoster.map(v => row(v, distsWith('k5j',v))).join('') + `</tbody>`;
  $('ve-roster2').innerHTML =
    `<thead><tr><th class="nos">K–5 curriculum</th><th class="nos"># of districts</th><th class="nos">Districts</th></tr></thead><tbody>`
    + V.k5CurrRoster.map(c => row(c, distsWith('k5c',c))).join('') + `</tbody>`;
  /* the chart's own Phase column disagrees with the launch timeline; say so */
  $('ve-phasenote').innerHTML = (V.phaseDisagree||[]).length
    ? `<div class="note warn"><b>The supplied chart's Phase column disagrees with the NYC Reads launch timeline for ${V.phaseDisagree.length} districts.</b> `
      + V.phaseDisagree.map(x=>`D${String(x.d).padStart(2,'0')} (timeline Phase ${x.timeline}, chart Phase ${x.chart})`).join(', ')
      + `. This tool keeps the launch timeline, because it is corroborated by the "year joined" columns of the 2026-27 workbook for all 32 districts. Worth resolving with NYCPS before the phase contrasts are quoted.</div>`
    : '';
}
/* every group, before any filtering */
function veAllGroups(){
  const fk = $('ve-group').value;
  return VE_FIELDS[fk].roster().map(v => ({ name:v, ds:distsWith(fk, v) })).filter(g=>g.ds.length);
}
function buildVEPicker(){
  multiSelect('ve-ms-groups', 'Groups',
    veAllGroups().map(g => ({ v:g.name, t:g.name, n:g.ds.length })), renderVE, 'All groups');
}
/* the groups actually shown: size threshold, then the explicit picker */
function veGroups(){
  const min = +$('ve-min').value;
  return veAllGroups().filter(g => g.ds.length >= min && msPass('ve-ms-groups', g.name));
}
function renderVE(){
  const base=+$('ve-base').value, cat=+$('ve-cat').value, mk=$('ve-metric').value;
  const M=METRICS[mk], bk=$('ve-band').value;
  const groups = veGroups(), all = veAllGroups();
  const fk = $('ve-group').value, kindLabel = VE_FIELDS[fk].label.toLowerCase();
  const bandMismatch = bk !== VE_FIELDS[fk].band;
  const unit = mk==='mean' ? '' : 'pp';

  const rows = groups.map(g => {
    const cur = agg('dist', g.ds, bk, 2026, cat);
    const bse = agg('dist', g.ds, bk, base, cat);
    return { ...g, cur, bse, d: delta(cur, bse, M.get) };
  }).filter(r => r.cur && r.bse && r.d != null);
  const ranked = rows.slice().sort((a,b)=>(M.get(b.cur)-M.get(a.cur))*M.good);

  $('ve-sub').textContent = `${M.label}, ${band(bk).label.toLowerCase()}, ${groupLabel($('ve-dim'),$('ve-cat')).toLowerCase()}.`;

  /* hidden-group notice, so nothing is silently dropped */
  const hidden = all.filter(g => !groups.some(x => x.name === g.name));
  $('ve-hidden').innerHTML = hidden.length
    ? `<div class="note neut" style="margin-bottom:18px"><b>${hidden.length} group${hidden.length===1?'':'s'} not shown:</b> `
      + hidden.map(g=>`${esc(g.name)} (${g.ds.length})`).join(', ')
      + `. ${(+$('ve-min').value)>1 ? `Groups below the ${$('ve-min').value}-district threshold rest on too few districts to read as a trend. ` : ''}`
      + `They remain in the table below.</div>`
    : '';

  slopeChart('ve-slope', ranked.map(r => ({
    label: `${r.name} (${r.ds.length})`,
    from: M.get(r.bse), to: M.get(r.cur),
    sub: `${r.ds.length} district${r.ds.length===1?'':'s'} · ${num(r.cur.n)} tested in 2026`,
  })), { baseYear: base, unit, good: M.good, axisLabel: M.short });

  const PAL = CAT;
  draw('ve-trend', {
    type:'line',
    data:{ labels:MODERN.map(String), datasets: ranked.map((r,i)=>({
      label:`${r.name} (${r.ds.length})`, borderColor:PAL[i%PAL.length], backgroundColor:PAL[i%PAL.length],
      data: MODERN.map(y=>{ const a=agg('dist',r.ds,bk,y,cat); return a?M.get(a):null; }),
      borderWidth:2.6, tension:.25, pointRadius:4 })) },
    options:{ scales:{ x:gridX, y:gridY(M.short) },
      plugins:{ legend:{position:'bottom'}, tooltip:ppTip(mk==='mean'?'':'%') } },
    plugins:[markerPlugin(() => MARKS.ve ? markSet(WAVES, MODERN_SLOT) : [])]
  });
  $('ve-trend-marks').innerHTML = MARKS.ve ? markHTML(WAVES) : '';

  /* the table always carries every group, filtered or not */
  const full = all.map(g => {
    const cur = agg('dist', g.ds, bk, 2026, cat), bse = agg('dist', g.ds, bk, base, cat);
    return { ...g, cur, bse, d: delta(cur, bse, M.get), shown: groups.some(x=>x.name===g.name) };
  }).filter(r=>r.cur).sort((a,b)=>(M.get(b.cur)-M.get(a.cur))*M.good);
  const head = `<thead><tr><th class="nos">${esc(VE_FIELDS[fk].label)}</th>
    <th class="nos"># of districts</th><th class="nos">Tested 2026</th>`
    + MODERN.map(y=>`<th class="nos">${y}</th>`).join('')
    + `<th class="nos">Δ ${base}→2026</th></tr></thead>`;
  $('ve-table').innerHTML = head + '<tbody>' + full.map(r =>
    `<tr${r.shown?'':' style="opacity:.5"'}><td class="nm">${esc(r.name)}${r.shown?'':' <span class="muted" style="font-weight:500">(not charted)</span>'}</td>`
    + `<td>${r.ds.length}</td><td>${num(r.cur.n)}</td>`
    + MODERN.map(y=>{ const a=agg('dist',r.ds,bk,y,cat); return `<td>${a?f1(M.get(a)):'s'}</td>`; }).join('')
    + `<td><span class="cell" style="${heat(r.d,6,M.good)}">${r.d==null?'s':pp(r.d)}</span></td></tr>`).join('')
    + '</tbody>';

  /* insight, and an explicit warning when 2025 is the baseline */
  const anomaly = base === 2025
    ? ` <b>Note the baseline.</b> 2025 sits well above 2024 and 2026 everywhere in the city, so measuring from 2025 makes almost every group look negative. That is a property of the baseline year, not of these groups — compare against 2023 or 2024 as well before reading anything into it.`
    : '';
  /* the count follows the filters rather than always reading 32 */
  const shownDistricts = new Set(ranked.flatMap(r => r.ds)).size;
  $('ve-insight').innerHTML = ranked.length
    ? `Grouping ${shownDistricts} district${shownDistricts===1?'':'s'} by ${kindLabel}, on ${band(bk).label.toLowerCase()}: `
      + `in 2026 the ${ranked.length} charted group${ranked.length===1?'':'s'} run from <b>${f1(M.get(ranked[ranked.length-1].cur))}</b> to <b>${f1(M.get(ranked[0].cur))}</b>, `
      + `and their change from ${base} runs from <b>${pp(Math.min(...ranked.map(r=>r.d)))}</b> to <b>${pp(Math.max(...ranked.map(r=>r.d)))}${unit}</b>. `
      + `Because districts started at different proficiency levels, differences across ${kindLabel}s should not be interpreted as ${kindLabel} effects.`
      + anomaly
    : 'No group passes the current filters.';
  $('ve-overlap').innerHTML = bandMismatch
    ? `<div class="note warn" style="margin-bottom:18px"><b>The grade band does not match the grouping.</b> ${esc(VE_FIELDS[fk].label)} applies to ${fk.startsWith('k5') ? 'grades 3 to 5' : 'grades 6 to 8'}, but the results shown are for ${esc(band(bk).label.toLowerCase())}. Grades outside that range were not touched by this assignment.</div>`
    : '';
}
/* =====================================================================
   PAGE 8 — PARTICIPATION AND REFUSALS

   The only page not built on the NYCPS results files. Those files carry
   `Number Tested` and no enrollment denominator, so no participation rate
   can be derived from them at any grain. The NYCPS InfoHub points readers to
   its "2026 ELA, Math and Science Results Summary" for "participation and
   results"; that document carries proficiency only and no participation
   figure, so it does not fill the gap either.

   That last sentence contradicts how the InfoHub page describes its own
   document, so it was checked against the document rather than against the
   description, and here is the check so nobody has to repeat it:

     Source   infohub.nyced.org/docs/default-source/default-document-library/
              ela-math-science.pdf  (the link behind "2026 English Language
              Arts, Math and Science Results Summary")
     File     14 pages, PowerPoint web deck, created 6 August 2026
     SHA-256  681caa0fc8996fdaf3b5545b81b263d06c1bf92aadfb787bd6d142a36c32feb7
     Read     17 August 2026, all 14 pages read as rendered images. Text
              extraction alone is NOT sufficient on this file: the figures are
              drawn as images and a text dump returns only 41-513 characters
              per page, so an absence in the text proves nothing.

   What all 14 pages hold: citywide proficiency for Math and ELA (p2), the
   long trend 2013-2019 and 2022-2026 (p3), Math and ELA by grade (p4-p5),
   race/ethnicity and gender-by-race/ethnicity for both subjects (p6-p11),
   students with disabilities against general education (p12), Current/Ever/
   Never ELL (p13), and Science by grade (p14). Every quantity in the deck is
   a proficiency rate or a percentage-point change in one. There is no
   participation, refusal, opt-out or not-tested figure at any grain, and
   nothing below citywide. The nearest thing is a footnote on p4 — "most
   students in accelerated math courses who took the Algebra Regents exam were
   exempted from taking the 8th grade State math assessment" — which is an
   exemption policy, quantifies nothing, and concerns Math, not ELA.

   If NYCPS later publishes participation in this deck, this page should carry
   it as a labelled citywide reference point beside the NYSED series, never
   merged into it: different measure, different denominator.

   NYSED publishes the measure: for every district, the percent of students
   reported with a REFUSAL code. That is deliberately not enrolled-minus-
   tested, which across these 32 districts runs 13 to 15 percent because it
   also absorbs absence and every other reason a student did not sit.

   The series ends at 2025, and that is the entire public record as of
   17 August 2026, not a shortcut. Checked that day: NYSED's downloads page
   tops out at the 2024-25 Refusals workbook; its 3-8 Assessment Database
   (the researcher file carrying enrolled / tested / not tested) stops at
   2020-21; NYC Open Data's ELA results run 2013-2023 with no participation
   column; and NYCPS's own 2026 Results Summary is proficiency only. NYSED's
   preliminary 2026 release of 5 August 2026 carries no participation figure
   and says the public release of all final state assessment data is
   anticipated for early November 2026. The 2026 refusal figures should
   appear then; nothing here is estimated or carried forward in the meantime.
   ===================================================================== */
const REF = D.refusals || null;
const HAS_REF = !!REF;

/* districts passing the borough filter on this page */
const paDistricts = () => ALL_DIST.filter(i => msPass('pa-ms-boro', D.districtBoro[i]));

/* Count-weighted mean of the published district rates. NYSED publishes each
   rate to one decimal place, so this inherits that rounding; it is not
   recomputed from underlying refusal counts, which are not published. */
function refAgg(subKey, yi, geos){
  let num = 0, den = 0;
  for (const i of geos){
    const p = REF.pct[subKey][i][yi], n = REF.n[subKey][i][yi];
    if (p == null || n == null) continue;
    num += p * n; den += n;
  }
  return den ? { pct: num/den, n: den } : null;
}

function initPA(){
  if (!HAS_REF) return;
  fill($('pa-sub'), REF.subs.map(s => ({ v:s.k, t:s.label })), 'all');
  fill($('pa-year'), REF.years.slice().reverse().map(y => ({ v:y, t:String(y) })), REF.years[REF.years.length-1]);
  multiSelect('pa-ms-boro', 'Borough', D.boros.map(b=>({v:b,t:b})), renderPA);
  on($('pa-sub'), renderPA); on($('pa-year'), renderPA);
  $('pa-reset').onclick = () => {
    msSel('pa-ms-boro').clear();
    $('pa-sub').value = 'all'; $('pa-year').value = REF.years[REF.years.length-1];
    initPA(); renderPA();
  };
}

function renderPA(){
  if (!HAS_REF) return;
  const sk = $('pa-sub').value, yr = +$('pa-year').value, yi = REF.years.indexOf(yr);
  const subLabel = (REF.subs.find(s=>s.k===sk)||{}).label || 'All students';
  const geos = paDistricts();
  const first = REF.years[0], last = REF.years[REF.years.length-1];

  /* How far NYSED's student count sits above the NYCPS tested count, for the
     latest year both cover. Computed rather than asserted, and reported as a
     citywide figure with the district range beside it: the two are very
     different numbers and a reader shown only one will assume it is the other. */
  const gapYear = last, gy = REF.years.indexOf(gapYear);
  let gapN = 0, gapT = 0; const gapEach = [];
  for (const i of ALL_DIST){
    const n = REF.n['all'][i][gy], a = agg('dist',[i],'all',gapYear,ALLCAT);
    if (n == null || !a) continue;
    gapN += n; gapT += a.n;
    gapEach.push({ d: D.districts[i], v: (n - a.n)/n*100 });
  }
  const gapCity = gapN ? (gapN - gapT)/gapN*100 : null;
  gapEach.sort((a,b) => a.v - b.v);
  const gapLo = gapEach[0], gapHi = gapEach[gapEach.length-1];

  $('pa-scope').innerHTML =
    `<b>Read this before using this page.</b> These figures come from NYSED, not from the NYCPS results files used everywhere else in this tool, `
    + `and the two do not share a denominator. NYSED reports the percent of students carrying a <b>refusal code</b>, against its own count of students; `
    + `the NYCPS files report only how many students were tested. Refusal is also not the same as not testing: taking the 32 districts together, `
    + `the gap between NYSED's student count and the number NYCPS records as tested was <b>${f1(gapCity)}%</b> in ${gapYear} — several times the refusal rate, `
    + `because it also absorbs absence and every other reason a student did not sit the test. That gap is a citywide figure, and individual districts sit `
    + `a long way either side of it: in ${gapYear} it ranges from ${f1(gapLo.v)}% in District&nbsp;${gapLo.d} to ${f1(gapHi.v)}% in District&nbsp;${gapHi.d}. `
    + `Neither number is an opt-out rate, and nothing on this page is differenced against the NYCPS tested counts used elsewhere in this tool. `
    + `<b>The series runs ${first} to ${last}, and that is the whole public record.</b> NYSED released preliminary ${MODERN[MODERN.length-1]} proficiency data on 5&nbsp;August&nbsp;${MODERN[MODERN.length-1]} with no participation figures in it, `
    + `and states that the public release of all final state assessment data is anticipated for <b>early November&nbsp;${MODERN[MODERN.length-1]}</b>, after districts have verified their own data. `
    + `The ${MODERN[MODERN.length-1]} refusal figures should appear then. Until they do, this page stops one year short of the results shown on every other page: `
    + `there is no ${MODERN[MODERN.length-1]} opt-out figure published by NYSED, by NYCPS or on NYC Open Data, and none has been estimated or carried forward here.`;

  /* ---- KPIs ---- */
  const now = refAgg(sk, yi, geos), then = refAgg(sk, 0, geos);
  const rows = geos.map(i => ({ i, pct: REF.pct[sk][i][yi], n: REF.n[sk][i][yi],
                                from: REF.pct[sk][i][0] }))
                   .filter(r => r.pct != null);
  const sorted = rows.slice().sort((a,b)=>b.pct-a.pct);
  const hi = sorted[0], lo = sorted[sorted.length-1];
  const rose = rows.filter(r => r.from != null && r.pct > r.from).length;

  /* Districts tie on these rates more often than one might expect — NYSED
     publishes to one decimal place, so 32 districts share about 130 possible
     values. Naming one of a tied pair as "the highest" would be arbitrary and
     would change with the sort, so every district at the extreme is named. */
  function extremeLabel(rowset, want){
    if (!rowset.length) return '';
    const v = want === 'hi' ? Math.max(...rowset.map(r=>r.pct)) : Math.min(...rowset.map(r=>r.pct));
    const ds = rowset.filter(r => r.pct === v).map(r => r.i);
    if (ds.length === 1) return `District ${D.districts[ds[0]]} (${D.districtBoro[ds[0]]})`;
    const names = ds.map(i => D.districts[i]);
    return `Districts ${names.slice(0,-1).join(', ')} and ${names[names.length-1]}, tied`;
  }

  $('pa-kpi').innerHTML = [
    kpi(`Refusal rate, ${yr}`, now ? f1(now.pct) : '—', '%', null,
        `${subLabel.toLowerCase()}, ${geos.length} district${geos.length===1?'':'s'}`, 'n'),
    kpi(`Change since ${first}`, now && then ? pp(now.pct-then.pct) : '—', 'pp', null,
        now && then ? `${f1(then.pct)}% in ${first}` : '', now && then && now.pct>then.pct ? 'b' : 'g'),
    kpi('Highest district', hi ? f1(hi.pct) : '—', '%', null, extremeLabel(rows,'hi'), 'n'),
    kpi('Lowest district',  lo ? f1(lo.pct) : '—', '%', null, extremeLabel(rows,'lo'), 'n'),
  ].join('');

  activeBar('pa-active', 'pa', 32, `${geos.length} of 32 districts`);

  $('pa-insight').innerHTML = now
    ? `Across the ${geos.length} district${geos.length===1?'':'s'} shown, <b>${f1(now.pct)}%</b> of ${subLabel.toLowerCase()} `
      + `were reported with a refusal code on the ${yr} ELA test, against ${f1(then.pct)}% in ${first}. `
      + `District rates range from <b>${f1(lo.pct)}%</b> in District&nbsp;${D.districts[lo.i]} to <b>${f1(hi.pct)}%</b> in District&nbsp;${D.districts[hi.i]}, `
      + `a spread of ${f1(hi.pct-lo.pct)} percentage points. ${rose} of ${rows.length} districts refuse at a higher rate than in ${first}.`
    : 'No refusal figures are published for this combination.';

  /* ---- trend: one line per student group ---- */
  $('pa-trendtitle').textContent = `Refusal rate, ${first} to ${last}`;
  draw('pa-trend', {
    type:'line',
    data:{ labels: REF.years.map(String), datasets: REF.subs.map((s, si) => ({
      label: s.label,
      data: REF.years.map((_, j) => { const a = refAgg(s.k, j, geos); return a ? a.pct : null; }),
      borderColor: si===0 ? C_PROF : CAT[si-1], backgroundColor: si===0 ? C_PROF : CAT[si-1],
      borderWidth: s.k===sk ? 3.5 : 2, pointRadius: s.k===sk ? 4 : 3,
      tension:.2, spanGaps:false,
    }))},
    options:{ scales:{ x:gridX, y:gridY('% reported with a refusal code',{beginAtZero:true}) },
      plugins:{ legend:{position:'bottom'},
        tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${f1(c.parsed.y)}%`}} } }
  });

  /* ---- refusal rate against proficiency ----
     Both measured on the same district and the same year. Descriptive only:
     districts differ in many ways that move both figures, and nothing here
     separates them. */
  const py = Math.min(yr, MODERN[MODERN.length-1]);
  $('pa-scattersub').innerHTML =
    `Refusal rate against the proficient share, ${py}, all grades, all students. `
    + `Districts differ in many ways that bear on both figures; this is a description of how they sit together, not a claim that one moves the other.`;
  const pts = rows.map(r => {
    const a = agg('dist',[r.i],'all',py,ALLCAT);
    return a ? { x:r.pct, y:a.prof, i:r.i } : null;
  }).filter(Boolean);
  draw('pa-scatter', {
    type:'scatter',
    data:{ datasets: D.boros.map(b => ({
      label: b, backgroundColor: BORO_COLOR[b], pointRadius: 5,
      data: pts.filter(p => D.districtBoro[p.i]===b),
    })).filter(d => d.data.length) },
    options:{ scales:{ x:gridY(`% with a refusal code, ${yr}`,{beginAtZero:true}),
                       y:gridY(`% at Level 3–4, ${py}`) },
      plugins:{ legend:{display:false},
        tooltip:{callbacks:{ label:c=>[`District ${D.districts[c.raw.i]} (${D.districtBoro[c.raw.i]})`,
                                       `Refusals: ${f1(c.raw.x)}%`, `Proficient: ${f1(c.raw.y)}%`] }} } }
  });
  $('pa-scatter-lg').innerHTML = D.boros.map(b =>
    `<span><i class="dot" style="background:${BORO_COLOR[b]}"></i>${b}</span>`).join('');

  /* ---- ranked bar ---- */
  $('pa-ranktitle').textContent = `Refusal rate by district, ${yr}`;
  draw('pa-rank', {
    type:'bar',
    data:{ labels: sorted.map(r=>`D${D.districts[r.i]}`), datasets:[{
      label:'% refused', data: sorted.map(r=>r.pct), borderWidth:0,
      backgroundColor: sorted.map(r=>BORO_COLOR[D.districtBoro[r.i]]) }]},
    options:{ scales:{ x:gridX, y:gridY('% reported with a refusal code',{beginAtZero:true}) },
      plugins:{ legend:{display:false},
        tooltip:{callbacks:{ title:c=>`District ${D.districts[sorted[c[0].dataIndex].i]}`,
                             label:c=>`${f1(c.parsed.y)}% of ${num(sorted[c.dataIndex].n)} students` }} } }
  });
  $('pa-rank-lg').innerHTML = D.boros.map(b =>
    `<span><i class="dot" style="background:${BORO_COLOR[b]}"></i>${b}</span>`).join('');

  /* ---- table ---- */
  $('pa-tbltitle').textContent = `Refusal rate by district and year, ${first} to ${last}`;
  $('pa-tblsub').innerHTML = `${esc(subLabel)}. Change is in percentage points between ${first} and ${last}. `
    + `Student count is NYSED's count for the selected year, which is the denominator of its published rate.`;
  const trows = geos.map(i => ({
    i, vals: REF.years.map((_, j) => REF.pct[sk][i][j]), n: REF.n[sk][i][yi],
  })).sort((a,b) => (b.vals[REF.years.length-1] ?? -1) - (a.vals[REF.years.length-1] ?? -1));
  const chg = r => (r.vals[REF.years.length-1]!=null && r.vals[0]!=null)
    ? r.vals[REF.years.length-1]-r.vals[0] : null;
  const allv = trows.flatMap(r=>r.vals).filter(v=>v!=null);
  const vmax = Math.max(...allv), vmin = Math.min(...allv);
  $('pa-table').innerHTML =
    `<thead><tr><th class="nos">District</th><th class="nos">Borough</th>`
    + REF.years.map(y=>`<th class="nos">${y}</th>`).join('')
    + `<th class="nos">Change</th><th class="nos">Students, ${yr}</th></tr></thead><tbody>`
    + trows.map(r => `<tr><td class="nm">District ${D.districts[r.i]}</td><td>${D.districtBoro[r.i]}</td>`
        + r.vals.map(v => `<td>${v==null?'<span class="sup">s</span>'
            :`<span class="cell" style="${shade(v, vmin, vmax, '106,61,138')}">${f1(v)}%</span>`}</td>`).join('')
        + `<td><span class="cell" style="${heat(chg(r), 6, -1)}">${pp(chg(r))}</span></td>`
        + `<td>${num(r.n)}</td></tr>`).join('')
    + `</tbody>`;
}

/* =====================================================================
   NAVIGATION + WIRING
   ===================================================================== */
const RENDER = { ov:renderOV, di:renderDI, bo:renderBO, ph:renderPH, sg:renderSG, tf:renderTF };
if (HAS_VENDORS) RENDER.ve = renderVE;
if (HAS_REF)     RENDER.pa = renderPA;
const drawn = new Set();

function show(p){
  document.querySelectorAll('.ni').forEach(n => n.classList.toggle('ac', n.dataset.p===p));
  document.querySelectorAll('.pg').forEach(s => s.classList.toggle('ac', s.id===`pg-${p}`));
  if (!drawn.has(p)){ RENDER[p](); drawn.add(p); }
  window.scrollTo({top:0});
  history.replaceState(null,'','#'+p);
}
document.querySelectorAll('.ni').forEach(n => n.onclick = () => show(n.dataset.p));
document.addEventListener('click', e => {
  const png = e.target.closest('[data-png]');
  if (png) exportPNG(png.dataset.png);
});

/* re-render the visible page whenever its filters change (handled per page),
   but make sure a page that was never opened renders on first view */
['ov','di','bo','ph','ve','sg','tf','pa'].forEach(p => {
  document.querySelectorAll(`#pg-${p} select`).forEach(s => s.addEventListener('change', () => { drawn.add(p); }));
});

/* marker toggles */
Object.keys(MARKS).forEach(p => {
  const el = $(p+'-marks-t');
  if (!el) return;
  el.addEventListener('change', () => { MARKS[p] = el.checked; RENDER[p](); });
});

initOV(); initDI(); initBO(); initPH(); if (HAS_VENDORS) initVE(); initSG(); initTF();
if (HAS_REF) initPA(); else {
  /* no refusals data in the payload: drop the page rather than leave an
     empty one in the navigation */
  document.querySelectorAll('[data-p="pa"]').forEach(n => n.remove());
  const pg = $('pg-pa'); if (pg) pg.remove();
}
renderOV(); drawn.add('ov');

/* ---------------------------------------------------------------------
   Orientation.

   Most people arriving here have one district in mind and no idea which of
   seven pages answers their question. Three sentences on where to start,
   then the two pieces of context that change how every number on the page
   should be read: which districts had the curriculum long enough to show up
   in these results, and what "citywide" does and does not contain.
   --------------------------------------------------------------------- */
/* citywide minus the 32 districts, read from the payload so the sentence
   below cannot go stale against a newer file */
const ORIENT_GAP = (() => { const r = D.meta.recon['2026']; return r.city - r.dist; })();
const orientEl = $('ov-orient');
if (orientEl){
  const w1 = WAVES[0], w2 = WAVES[1], w3 = WAVES[2];
  orientEl.innerHTML =
    `<b>Start here.</b> This page is the systemwide picture: how New York City as a whole performed in grades 3 to 8 English Language Arts, and how that has moved. `
    + `Once you have the citywide shape, go to <b>District explorer</b> for the district or districts you serve — it carries the same measures for each of the 32 community school districts, side by side and sortable. `
    + `<b>Boroughs</b> sits between the two. <b>NYC Reads phases</b>, <b>Subgroups &amp; gaps</b>, <b>Test format</b> and <b>Participation</b> each take one question and follow it across the system.`
    + `<br><br>`
    + `<b>Two things to know before reading any number here.</b>`
    + `<br>`
    + `<b>1. Districts are at different stages of NYC Reads.</b> ${waveN(w1)} districts began the elementary curriculum in ${w1.sy} and first appear in the ${w1.firstTested} results; ${waveN(w2)} began in ${w2.sy} and first appear in ${w2.firstTested}. `
    + `The middle school rollout reached ${waveN(w3)} districts in ${w3.sy}, so ${w3.firstTested} is their first tested year. A district that started later has had fewer years for the curriculum to show up in a test score, and the dashed markers on the charts show where each wave first could.`
    + `<br>`
    + `<b>2. Citywide and district figures cover different students.</b> The citywide total is larger than the 32 districts added together — by ${num(ORIENT_GAP)} students in 2026. That difference is District&nbsp;75 and out-of-district placement students, who appear in the citywide file but not the district file. `
    + `<b>Charter school students are not in either.</b> NYCPS excludes charters from all three of these files and publishes charter results separately at school level. Note that NYSED's own "New York City" figures do include charters, so a number published by NYSED will not match the citywide number here.`;
}

$('buildstamp').textContent = `Built ${BUILD}.`;
/* ---------------------------------------------------------------------
   Sources. Numbered so they can be cited directly, and kept in one place so
   the wording can be replaced without touching anything else.
   The provider and curriculum line is marked pending until NYCPS confirms it
   may be shared; VENDOR_APPROVED flips that.
   --------------------------------------------------------------------- */
/* The provider and curriculum assignments are withheld from the public build
   again as of 21 August 2026, so the pending-approval note returns with them. */
const VENDOR_APPROVED = false;
const INFOHUB_URL = 'https://infohub.nyced.org/reports/academics/test-results';

/* ---------------------------------------------------------------------
   What the figures do and do not cover.

   Stated once, from the NYCPS notes and from the files themselves. Figures
   are read out of the payload rather than typed in, so a rebuild on a newer
   file cannot leave a stale number in the prose.
   --------------------------------------------------------------------- */
const RECON = D.meta.recon, DGAP = D.meta.demoGap;

/* The reconciliation between the three files is not one fact, it is two: the
   district file agreed with citywide exactly until 2024 and the borough file
   did not, and from 2025 that reverses. A note describing only the current
   year would misdescribe two thirds of the series. */
const reconYears = Object.keys(RECON).map(Number).sort((a,b)=>a-b);
const exactDist  = reconYears.filter(y => RECON[y].city === RECON[y].dist);
const boroShort  = reconYears.filter(y => RECON[y].city !== RECON[y].boro);
const lastY      = reconYears[reconYears.length-1];
const boroGapEarly = exactDist.map(y => RECON[y].city - RECON[y].boro);

$('coverage').innerHTML = `
  <h4>What these results cover</h4>
  <ul class="cov">
    <li><b>District here means community school district, not superintendency.</b> The 32
        districts are the geographic community school districts numbered 1 to 32. No result
        is attributed to a superintendent or to a superintendency.</li>
    <li><b>Charter schools are not included at any level.</b> The NYCPS notes state that
        charter schools are excluded from these files, citywide as well as by borough and
        district. School-level charter results are published separately by NYCPS. Note that
        NYSED's own "New York City" aggregate <b>does</b> include charter schools, so a
        figure published by NYSED will not match the citywide figure here.</li>
    <li><b>District 75 students appear in the citywide results only</b>, and are excluded
        from the borough and district files.</li>
    <li><b>Out-of-district placement students appear in the citywide and borough results</b>,
        and are excluded from the district file. Before 2025 they were attributed separately;
        from 2025 they are attributed to the school they attended.</li>
    <li><b>The three files do not reconcile with one another, and the way they fail to
        reconcile changed in 2025.</b> Through ${exactDist[exactDist.length-1]} the district file totalled exactly the same
        number of tested students as the citywide file, while the borough file ran short of
        citywide by ${num(Math.min(...boroGapEarly))} to ${num(Math.max(...boroGapEarly))} students. In 2024 the district file falls ${num(RECON['2024'].city - RECON['2024'].dist)} students short,
        and from 2025 the relationship inverts: citywide now exceeds the district file by
        ${num(RECON['2025'].city - RECON['2025'].dist)} students in 2025 and ${num(RECON[lastY].city - RECON[lastY].dist)} in ${lastY}. The NYCPS notes describe the current
        arrangement only, so they do not account for the earlier borough shortfall.
        Each level is therefore read only from its own file, and no figure here is
        assembled by adding one level up to another.</li>
    <li><b>Participation and opt-out are not in these files, but they are published.</b>
        The NYCPS results files carry a count of students tested and no enrollment
        denominator, so no participation rate can be derived from them. NYSED publishes the
        percent of students reported with a refusal code, by district, and that series is on
        the <b>Participation</b> page${HAS_REF ? ` for ${REF.years[0]} to ${REF.years[REF.years.length-1]}` : ''}. It comes from a different source with a
        different denominator and is not comparable cell for cell with the results here.</li>
    <li><b>Demographic categories do not add up to the citywide total.</b> NYCPS attributes
        this to demographic information missing from the files it receives from NYSED. In ${lastY}
        the reported ethnicity categories fall ${num(DGAP[lastY].ethGap)} students short of the citywide total and the
        gender categories ${num(DGAP[lastY].genGap)} short; in 2024 the ethnicity shortfall was ${num(DGAP['2024'].ethGap)}. Any
        breakdown by ethnicity or gender therefore covers slightly fewer students than the
        all-students figure on the same page.</li>
    <li><b>Asian includes Native Hawaiian or Other Pacific Islanders</b>, as stated in the
        NYCPS notes. The two are not reported separately.</li>
    <li><b>Suppression removes more than small groups.</b> Groups of five or fewer tested
        students are suppressed with an <span class="sup">s</span>. So is the group with the
        next lowest count, wherever the first could otherwise be recovered by addition or
        subtraction. That second rule can blank a very large group: citywide Female for all
        grades in 2025, covering 149,821 tested students, is withheld because the 41 students
        reported as neither female nor male would otherwise be recoverable. Suppressed cells
        are never read as zero and no line is joined across one.</li>
    <li><b>District 15 is not comparable across these years.</b> Students at the Children's
        School may be attributed to either of two school codes. Before 2025 those enrolled at
        15K418 were counted as out-of-district placements, in 2025 all of them were attributed
        to 75M732, and in 2026 they are reported by the school in which they were enrolled.
        District 15's tested count moves between years for that reason alone, independently of
        anything that happened in its classrooms.</li>
  </ul>`;

$('sources').innerHTML = `<h4>Sources</h4><ol>
  <li><b>ELA results, grades 3 to 8, 2018 to 2026.</b> New York City Public Schools,
      public ELA results files (citywide, borough and district), published on the NYCPS
      InfoHub. File date 3&nbsp;August&nbsp;2026.
      <a href="${INFOHUB_URL}" target="_blank" rel="noopener">Download the source files from the NYCPS InfoHub</a>.</li>
  <li><b>NYC Reads launch phases by district.</b> New York City Public Schools, NYC Reads
      program information.</li>
  ${HAS_REF ? `<li><b>Test refusals by district, ${REF.years[0]} to ${REF.years[REF.years.length-1]}.</b> New York State Education
      Department, ${esc(REF.srcName)}. Used on the Participation page only, and labeled there as NYSED
      rather than NYCPS because the denominator is NYSED's own and differs from the count of
      students tested in the NYCPS files.
      <a href="${esc(REF.src)}" target="_blank" rel="noopener">Download the source files from the NYSED data site</a>.</li>` : ''}
  ${HAS_VENDORS ? `<li><b>Curriculum and professional learning provider by district, school year
      2025&ndash;26.</b> New York City Public Schools.</li>` : ''}
</ol>`
+ (VENDOR_APPROVED || !HAS_VENDORS ? '' :
   `<div class="pending"><b>Pending confirmation.</b> The curriculum and professional learning
    provider source is shown while approval to share the district-level assignments is
    confirmed with NYCPS. This build carries that data; it should not circulate beyond the
    team until the approval is in hand.</div>`);

/* ---------------------------------------------------------------------
   Which build this is.

   The two builds differ by a few kilobytes in a 1.6 MB file and, until now,
   only by filename — which survives neither a rename nor a forward. The
   restricted data is the thing that must not travel, so the build says on
   its face whether it is carrying any.
   --------------------------------------------------------------------- */
/* Both builds now carry the provider and curriculum assignments, so the
   marker states which file this is rather than inferring it from whether the
   data is present. If the public build is ever stripped again, the two
   branches diverge on their own. */
const IS_PUBLIC = BUILDKIND !== 'internal';
$('buildkind').innerHTML = IS_PUBLIC
  ? `<b>Public build.</b> Cleared for sharing, including the curriculum and professional learning provider assignments.`
  : `<b>Internal build.</b> Working copy for the CPRL team.`
    + (HAS_VENDORS ? ` Carries district-level curriculum and provider assignments.` : '');
$('buildkind').className = IS_PUBLIC ? 'sb-kind public' : 'sb-kind internal';

$('foot').innerHTML = `<b>NYC Reads &mdash; ELA Results Explorer.</b> Prepared by the Center for Public Research and Leadership. `
  + `Percentages are computed from student counts rather than copied from the published percentage columns; grade bands and district groups are aggregated by summing counts. `
  + `Changes are differences in percentage points. NYSED re-aligned the ELA test to new standards in 2023, so 2022 and earlier are shown for reference only and are never differenced against later years. `
  + `The citywide, borough and district files are compiled on different rules and do not sum to one another, so each level is read only from its own file, and the way they fail to reconcile changed in 2025. `
  + `Suppressed groups are omitted rather than treated as zero: NYSED withholds groups of five or fewer tested students and, where the first could be recovered by subtraction, the next smallest group as well. `
  + `${HAS_REF ? `Refusal figures on the Participation page come from NYSED, not NYCPS, and run to ${REF.years[REF.years.length-1]}. ` : ''}`
  + `Mathematics, Science, charter schools and school-level results are out of scope. Build ${BUILD}.`;

const hash = location.hash.replace('#','');
if (RENDER[hash]) show(hash);
