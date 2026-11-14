// Long-form editing helpers (pure): fit an edit to a length, search a project, build a rough cut
// from a script, plan a multicam edit, and export EDL/FCPXML/OTIO/CSV/chapters/SRT/VTT.
import { layout, totalDuration, mergeRanges, sectionSpans, applyOperations, LIMITS } from '../public/edit-ops.js';
import { curvesFor, clipEnergy, highlights } from '../public/insights.js';
import { findFillers, findPauses, wordsInEdit, bare, joinWords, splitWords } from '../public/transcript.js';
import { mapCaptions, toSrt, toVtt } from '../public/captions.js';
import { sentences } from './clips.mjs';

const STEP = 0.5;
const r3 = n => Math.round(n * 1000) / 1000;
function meanEnergy(curve, a, b) {
  let s = 0, n = 0;
  for (let i = Math.floor(a / STEP); i < Math.ceil(b / STEP) && i < (curve?.energy.length ?? 0); i++) if (i >= 0) { s += curve.energy[i] ?? 0; n++; }
  return n ? s / n : 0.3;
}

// ------------------------------------------------------------------ fit to duration
/**
 * Operations that bring the edit to `target` seconds, cutting the least valuable material first:
 * long pauses and filler words (transcripts), then the weakest sentences, then whole weak shots,
 * then trimming the remaining shots toward their strongest part. Hook and finale are protected.
 * Each stage is applied before the next is planned, so the operations always compose.
 */
export function fitDuration({ clips, sources, transcripts = {}, target, protectHook = true, protectFinale = true }) {
  const total = totalDuration(clips);
  if (!(target >= 3)) throw new Error('target: at least 3 seconds.');
  if (target >= total - 0.05) return { operations: [], before: r3(total), after: r3(total), steps: ['Already at or under the target.'] };
  const ctx = { sources: sources.map(x => ({ duration: x.duration })) };
  const curves = curvesFor(sources);
  const hookId = protectHook ? clips[0]?.id : null, finaleId = protectFinale && clips.length > 1 ? clips.at(-1).id : null;
  let state = { clips, options: {} };
  const operations = [], steps = [];
  const excess = () => totalDuration(state.clips) - target;
  const isProtected = c => c.id === hookId || c.id === finaleId;
  const inEdit = (si, r) => state.clips.filter(c => c.sourceIndex === si && !isProtected(c)).reduce((s, c) => s + Math.max(0, Math.min(c.end, r.end) - Math.max(c.start, r.start)) / (c.speed || 1), 0);
  const applyRanges = (si, rs, label) => {
    if (!rs.length) return;
    const op = { op: 'remove_ranges', sourceIndex: si, ranges: mergeRanges(rs).map(r => ({ start: r3(Math.max(0, r.start)), end: r3(r.end) })) };
    try { state = applyOperations(state, [op], ctx); operations.push(op); steps.push(label); } catch { /* skip a cut that would empty the edit */ }
  };
  // 1. Long pauses and filler words inside unprotected shots.
  for (const [key, t] of Object.entries(transcripts)) {
    const si = Number(key); if (!t?.words?.length || excess() <= 0) continue;
    const rs = []; let gain = 0;
    for (const p of findPauses(t.words, { min: 0.7, keep: 0.15 })) { const g = inEdit(si, p); if (g > 0.05 && gain < excess()) { rs.push(p); gain += g; } }
    for (const i of findFillers(t.words, t.language)) { const w = t.words[i], r = { start: w.start - 0.03, end: w.end + 0.03 }, g = inEdit(si, r); if (g > 0.05 && gain < excess()) { rs.push(r); gain += g; } }
    applyRanges(si, rs, `tightened pauses and filler words (source ${si + 1})`);
  }
  // 2. Weakest whole sentences inside unprotected shots.
  if (excess() > 0.5) {
    const candidates = [];
    for (const [key, t] of Object.entries(transcripts)) {
      const si = Number(key); if (!t?.words?.length) continue;
      const marked = wordsInEdit(t.words, state.clips, si), protIds = new Set(state.clips.filter(isProtected).map(c => c.id));
      for (const sp of sentences(t.words)) {
        if (!marked.slice(sp.from, sp.to + 1).every(w => w.inEdit && w.clipId && !protIds.has(w.clipId))) continue;
        const r = { start: sp.start - 0.05, end: sp.end + 0.05 };
        candidates.push({ si, r, seconds: inEdit(si, r), score: meanEnergy(curves[si], r.start, r.end) + (/[?!]/.test(t.words[sp.to].text) ? 0.1 : 0) });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    const bySource = new Map(); let gain = 0, count = 0;
    for (const c of candidates) { if (gain >= excess() - 0.5) break; if (c.seconds > excess() - gain + 2) continue; if (!bySource.has(c.si)) bySource.set(c.si, []); bySource.get(c.si).push(c.r); gain += c.seconds; count++; }
    for (const [si, rs] of bySource) applyRanges(si, rs, `removed ${rs.length} weakest sentence(s) (source ${si + 1})`);
    void count;
  }
  // 3. Whole weakest shots.
  if (excess() > 0.3) {
    const rows = layout(state.clips).filter(r => !isProtected(r)).map(r => ({ r, e: clipEnergy(curves, r) })).sort((a, b) => a.e - b.e);
    const remove = []; let left = excess();
    for (const { r } of rows) { if (left <= 0.3) break; if (r.duration > left * 1.5 || state.clips.length - remove.length <= 2) continue; remove.push(r.id); left -= r.duration - r.overlapIn; }
    if (remove.length) { const op = { op: 'delete', clips: remove }; state = applyOperations(state, [op], ctx); operations.push(op); steps.push(`removed ${remove.length} weakest shot(s)`); }
  }
  // 4. Trim the remaining shots toward their strongest window, in proportion to their length.
  if (excess() > 0.3) {
    const keep = layout(state.clips).filter(r => !isProtected(r) && r.duration > 1.2);
    const room = keep.reduce((sum, r) => sum + (r.duration - 1), 0), need = excess();
    const ops = [];
    for (const r of keep) {
      const cut = Math.min(r.duration - 1, need * (r.duration - 1) / Math.max(room, 1e-6));
      if (cut < 0.1) continue;
      const len = (r.duration - cut) * (r.speed || 1), curve = curves[r.sourceIndex];
      let best = r.start, bestE = -1;
      for (let a = r.start; a + len <= r.end + 1e-6; a += 0.25) { const e = meanEnergy(curve, a, a + len); if (e > bestE) { bestE = e; best = a; } }
      ops.push({ op: 'trim', clip: r.id, start: r3(best), end: r3(Math.min(r.end, best + len)) });
    }
    if (ops.length) { state = applyOperations(state, ops, ctx); operations.push(...ops); steps.push(`trimmed ${ops.length} shot(s) toward their strongest part`); }
  }
  // 5. Still too long (short edits): shorten the hook from its end and the finale from its start, so the
  //    opening moment and the last moment both stay.
  if (excess() > 0.3) {
    const prot = layout(state.clips).filter(r => isProtected(r) && r.duration > 1.5);
    const room = prot.reduce((sum, r) => sum + (r.duration - 1.5), 0), need = excess(), ops = [];
    for (const r of prot) {
      const cut = Math.min(r.duration - 1.5, need * (r.duration - 1.5) / Math.max(room, 1e-6));
      if (cut < 0.1) continue;
      const len = (r.duration - cut) * (r.speed || 1);
      ops.push(r.id === hookId ? { op: 'trim', clip: r.id, end: r3(r.start + len) } : { op: 'trim', clip: r.id, start: r3(r.end - len) });
    }
    if (ops.length) { state = applyOperations(state, ops, ctx); operations.push(...ops); steps.push('shortened the opening and closing shots (their first and last moments kept)'); }
  }
  return { operations, clips: state.clips, before: r3(total), after: r3(totalDuration(state.clips)), target, steps };
}

// ------------------------------------------------------------------ search
// CJK text has no spaces: use the same word segmentation as transcripts, so a
// query typed as one phrase matches the words the transcript was split into.
const tokens = text => splitWords(String(text ?? '')).map(bare).filter(Boolean);
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); best = Math.min(best, cur[j]); }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
/**
 * Fuzzy phrase search in words: best windows by token overlap (F1) with an order bonus. Words match
 * exactly or with a small typo / ASR slip (1 edit for 4–6 letters, 2 for longer words).
 */
export function searchWords(words, query, { limit = 20, minScore = 0.5 } = {}) {
  const q = tokens(query); if (!q.length || !words.length) return [];
  const qset = new Set(q), memo = new Map();
  const matchOf = key => {
    if (memo.has(key)) return memo.get(key);
    let m = qset.has(key) ? { token: key, weight: 1 } : null;
    if (!m && key.length >= 4) for (const token of qset) {
      if (token.length < 4) continue;
      const max = Math.max(key.length, token.length) >= 7 ? 2 : 1;
      if (editDistance(key, token, max) <= max) { m = { token, weight: 0.85 }; break; }
    }
    memo.set(key, m); return m;
  };
  const matches = words.map(w => matchOf(bare(w.text))), hits = [];
  for (let len = Math.max(1, q.length - 1); len <= q.length + 2; len++) {
    for (let i = 0; i + len <= matches.length; i++) {
      if (!matches[i] && !matches[i + len - 1]) continue;
      const win = matches.slice(i, i + len), common = win.reduce((sum, m) => sum + (m?.weight ?? 0), 0);
      if (!common) continue;
      const p = common / len, r = Math.min(1, common / q.length), f1 = (2 * p * r) / (p + r);
      let order = 0, j = 0; for (const m of win) if (m && m.token === q[j]) { order++; j++; }
      const score = 0.8 * f1 + 0.2 * order / q.length;
      if (score >= minScore) hits.push({ from: i, to: i + len - 1, score: r3(score) });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.from - b.from);
  const picked = [];
  for (const h of hits) { if (picked.length >= limit) break; if (picked.some(p => h.from <= p.to && h.to >= p.from)) continue; picked.push(h); }
  return picked;
}
export function searchProject({ clips, sources, options = {}, transcripts = {}, query, kinds, limit = 20 }) {
  const want = new Set(kinds?.length ? kinds : ['speech', 'shots', 'markers', 'texts', 'captions', 'moments']);
  const q = String(query ?? '').trim(), ql = q.toLowerCase(), out = [];
  if (!q) throw new Error('query is empty.');
  const rows = layout(clips);
  if (want.has('speech')) for (const [key, t] of Object.entries(transcripts)) {
    const si = Number(key); if (!t?.words?.length) continue;
    const marked = wordsInEdit(t.words, clips, si);
    for (const h of searchWords(t.words, q, { limit })) {
      const a = t.words[h.from], b = t.words[h.to], ctx = joinWords(t.words.slice(Math.max(0, h.from - 6), h.to + 7).map(w => w.text));
      const inEdit = marked[h.from].inEdit;
      out.push({ kind: 'speech', score: h.score, sourceIndex: si, start: r3(a.start), end: r3(b.end), words: [h.from, h.to], text: ctx, inEdit,
        ...(inEdit ? { timeline: marked[h.from].timeline } : { insert: { op: 'insert', sourceIndex: si, start: r3(Math.max(0, a.start - 0.15)), end: r3(b.end + 0.25) } }) });
    }
  }
  if (want.has('shots')) for (const r of rows) if (r.label && r.label.toLowerCase().includes(ql)) out.push({ kind: 'shot', score: 1, clip: r.id, timeline: r3(r.timelineStart), text: r.label });
  if (want.has('markers')) for (const m of options.markers ?? []) if ((m.label ?? '').toLowerCase().includes(ql)) out.push({ kind: 'marker', score: 1, timeline: m.time, text: m.label });
  if (want.has('texts')) for (const x of options.texts ?? []) if (x.text.toLowerCase().includes(ql)) out.push({ kind: 'text', score: 1, timeline: x.start, text: x.text });
  if (want.has('captions')) for (const c of mapCaptions(options.captions ?? [], clips, Number(options.captionOffset) || 0)) if (c.text.toLowerCase().includes(ql)) out.push({ kind: 'caption', score: 0.9, timeline: r3(c.start), text: c.text });
  if (want.has('moments') && /^(action|peak|highlights?|loud|best|energy|moments?|unused)\b/i.test(q)) {
    for (const h of highlights(sources, { count: limit, exclude: /unused/i.test(q) ? clips : [] })) out.push({ kind: 'moment', score: h.score / 100, sourceIndex: h.sourceIndex, start: h.start, end: h.end, text: `energy ${h.score}`, insert: { op: 'insert', sourceIndex: h.sourceIndex, start: h.start, end: h.end } });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ------------------------------------------------------------------ script → rough cut
export function scriptLines(script) {
  return String(script ?? '').split(/\r?\n/).map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/^#+\s*/, '').trim()).filter(l => l && tokens(l).length >= 2).slice(0, LIMITS.clips);
}
/** Match each script line to the best transcript passage (fuzzy), in script order, never reusing footage. */
export function assembleFromScript({ script, transcripts, sources, minScore = 0.55, pad = 0.15 }) {
  const lines = scriptLines(script);
  if (!lines.length) throw new Error('The script has no usable lines (at least two words per line).');
  const used = [], clips = [], unmatched = [];
  lines.forEach((line, k) => {
    let best = null;
    for (const [key, t] of Object.entries(transcripts)) {
      const si = Number(key); if (!t?.words?.length) continue;
      for (const h of searchWords(t.words, line, { limit: 8, minScore })) {
        const a = t.words[h.from], b = t.words[h.to];
        const range = { start: Math.max(0, a.start - pad, h.from ? t.words[h.from - 1].end + 0.02 : 0), end: Math.min(sources[si]?.duration ?? Infinity, b.end + pad + 0.1, t.words[h.to + 1]?.start ?? Infinity) };
        if (used.some(u => u.si === si && Math.min(u.end, range.end) - Math.max(u.start, range.start) > 0)) continue;
        if (!best || h.score > best.score) best = { si, ...range, score: h.score, text: joinWords(t.words.slice(h.from, h.to + 1).map(w => w.text)) };
      }
    }
    if (!best || best.end - best.start < LIMITS.minSource) { unmatched.push({ line: k + 1, text: line }); return; }
    used.push({ si: best.si, start: best.start, end: best.end });
    clips.push({ sourceIndex: best.si, start: r3(best.start), end: r3(best.end), label: line.slice(0, 60), match: { score: best.score, text: best.text.slice(0, 200) } });
  });
  return { lines: lines.length, matched: clips.length, unmatched, clips };
}

// ------------------------------------------------------------------ multicam
/**
 * Multicam switching in REFERENCE time. cams: [{sourceIndex, offset}] where source time = ref time − offset.
 * Each camera's own sound level (relative to its median) picks who is talking; hysteresis keeps shots
 * between minShot and maxShot; `wide` (optional) covers overlaps and long stretches.
 */
export function multicamPlan({ sources, cams, from = 0, to, minShot = 2, maxShot = 8, wide = null }) {
  const curves = curvesFor(sources);
  const step = STEP, n = Math.floor((to - from) / step);
  const level = (cam, t) => {
    const c = curves[cam.sourceIndex], st = t - cam.offset;
    if (st < 0 || st >= sources[cam.sourceIndex].duration) return null;
    return c.loudness[Math.floor(st / step)] ?? null;
  };
  const medians = cams.map(cam => { const v = curves[cam.sourceIndex].loudness.filter(x => x != null && x > -89).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] ?? -40; });
  const pick = [];
  for (let k = 0; k < n; k++) {
    const t = from + k * step;
    let best = null, bestV = -Infinity;
    cams.forEach((cam, ci) => { const l = level(cam, t); if (l == null) return; const v = l - medians[ci]; if (v > bestV) { bestV = v; best = ci; } });
    pick.push(best);
  }
  const shots = [];
  let cur = pick.find(x => x != null) ?? 0, start = 0;
  const minN = Math.round(minShot / step), maxN = Math.round(maxShot / step);
  for (let k = 1; k <= n; k++) {
    const len = k - start;
    let next = cur;
    if (k < n) {
      const window = pick.slice(k, k + minN).filter(x => x != null);
      const lead = window.length ? [...new Set(window)].map(c => [c, window.filter(x => x === c).length]).sort((a, b) => b[1] - a[1])[0] : null;
      if (len >= minN && lead && lead[0] !== cur && lead[1] >= window.length * 0.6) next = lead[0];
      else if (len >= maxN) next = wide != null && cur !== wide ? wide : cams.length > 1 ? (cur + 1) % cams.length : cur;
    }
    if (next !== cur || k === n) { shots.push({ cam: cur, from: from + start * step, to: from + k * step }); start = k; cur = next; }
  }
  // Never more than the clip limit: merge the shortest neighbours.
  while (shots.length > LIMITS.clips - 2) { let i = 0; for (let j = 1; j < shots.length; j++) if (shots[j].to - shots[j].from < shots[i].to - shots[i].from) i = j; const k = i ? i - 1 : 1; shots[Math.min(i, k)].to = shots[Math.max(i, k)].to; shots.splice(Math.max(i, k), 1); }
  return shots.map(s => {
    const cam = cams[s.cam];
    return { sourceIndex: cam.sourceIndex, start: r3(Math.max(0, s.from - cam.offset)), end: r3(Math.min(sources[cam.sourceIndex].duration, s.to - cam.offset)), gain: 0, label: `cam ${s.cam + 1}` };
  }).filter(c => c.end - c.start >= LIMITS.minSource);
}

// ------------------------------------------------------------------ timeline export
const pad2 = n => String(n).padStart(2, '0');
/** Exact rates as rationals (SMPTE): 29.97 is really 30000/1001, 23.976 is 24000/1001. */
const FPS_RATES = new Map([[23.976, [24000, 1001]], [24, [24, 1]], [25, [25, 1]], [29.97, [30000, 1001]], [30, [30, 1]], [50, [50, 1]], [59.94, [60000, 1001]], [60, [60, 1]]]);
const rateOf = fps => FPS_RATES.get(Number(fps)) ?? [Math.max(1, Math.round(Number(fps))) || 30, 1];
/** SMPTE 12M drop-frame timecode for 29.97/59.94: frame numbers 0 and 1 (0–3 at 59.94) are skipped at the start of every minute except every tenth. */
export function dropFrameTimecode(frames, base) {
  const drop = base >= 60 ? 4 : 2, per10 = base * 600 - 9 * drop, perMin = base * 60 - drop;
  const tens = Math.floor(frames / per10), rest = frames % per10;
  const fn = frames + 9 * drop * tens + (rest > drop ? drop * Math.floor((rest - drop) / perMin) : 0);
  const ff = fn % base, total = Math.floor(fn / base);
  return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor(total / 60) % 60)}:${pad2(total % 60)};${pad2(ff)}`;
}
export function timecode(seconds, fps) {
  const [num, den] = rateOf(fps), base = Math.round(num / den);
  const f = Math.round(seconds * num / den), ff = f % base, s = Math.floor(f / base);
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}:${pad2(ff)}`;
}
const xml = v => String(v ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const fileUrl = f => `file://${f.startsWith('/') ? '' : '/'}${encodeURI(f.replaceAll('\\', '/')).replace(/[#?]/g, c => encodeURIComponent(c))}`;
/** Chapters shared by the chapters export and the MP4 render: sections first, else labelled markers.
 * `offset` is the length of a brand intro in front of the programme; the first chapter always starts at 0:00.
 * Marks at or past the end of the edit are dropped and each time gives one chapter, so 0 <= start < end <= programme end. */
export function chapterMarks(clips, options = {}, offset = 0) {
  const sections = sectionSpans(clips, options.sections ?? []);
  const length = r3(totalDuration(clips));
  const marks = (sections.length ? sections.map(s => ({ t: s.start, n: s.name })) : (options.markers ?? []).filter(m => m.label).map(m => ({ t: m.time, n: m.label })))
    .filter(m => r3(m.t) < length)
    .sort((a, b) => a.t - b.t)
    .filter((m, i, all) => !i || r3(m.t) > r3(all[i - 1].t));
  if (!marks.length) return [];
  if (marks[0].t >= 1) marks.unshift({ t: 0, n: marks.some(m => m.n.toLowerCase() === 'intro') ? 'Start' : 'Intro' }); else marks[0].t = 0; // YouTube needs the first chapter at 0:00
  const total = length + offset;
  return marks.map((m, i) => ({ start: i ? r3(m.t + offset) : 0, end: r3(marks[i + 1] ? marks[i + 1].t + offset : total), title: m.n })).filter(c => c.start < c.end);
}
const escapeMeta = s => String(s).replace(/[=;#\\\n]/g, c => `\\${c}`);
/** ffmetadata text for FFmpeg's -map_chapters (millisecond timebase). */
export function chapterMetadata(chapters) {
  return ';FFMETADATA1\n' + chapters.map(c => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(c.start * 1000)}\nEND=${Math.round(c.end * 1000)}\ntitle=${escapeMeta(c.title)}\n`).join('');
}
export function exportTimeline({ format, clips, sources, options = {}, name = 'Edit', fps = 30 }) {
  const rows = layout(clips), sections = sectionSpans(clips, options.sections ?? []);
  const [num, den] = rateOf(fps), base = Math.round(num / den);
  const df = den !== 1 && (base === 30 || base === 60); // NTSC drop-frame rates (29.97, 59.94); 23.976 stays non-drop
  if (format === 'srt' || format === 'vtt') {
    const cues = mapCaptions(options.captions ?? [], clips, Number(options.captionOffset) || 0);
    if (!cues.length) throw new Error('No captions are available for this edit. Add or import captions before exporting SRT or VTT.');
    return format === 'srt'
      ? { extension: 'srt', mime: 'application/x-subrip', content: toSrt(cues) }
      : { extension: 'vtt', mime: 'text/vtt', content: toVtt(cues) };
  }
  if (format === 'edl') {
    const tc = s => df ? dropFrameTimecode(Math.round(s * num / den), base) : timecode(s, fps);
    // The record hour is a whole hour of the timecode clock, not 3600 s of real time: only drop-frame rates
    // turn 3600 s into 01:00:00;xx by seconds, so at non-drop rates the hour is a frame offset (base * 3600 frames).
    const ndFrameTc = f => { const ff = f % base, t = Math.floor(f / base); return `${pad2(Math.floor(t / 3600))}:${pad2(Math.floor(t / 60) % 60)}:${pad2(t % 60)}:${pad2(ff)}`; };
    const recTc = s => df ? tc(3600 + s) : ndFrameTc(base * 3600 + Math.round(s * num / den));
    const lines = [`TITLE: ${name.replace(/[^\x20-\x7e]/g, '').slice(0, 60) || 'EDIT'}`, `FCM: ${df ? 'DROP FRAME' : 'NON-DROP FRAME'}`, ''];
    rows.forEach((r, i) => {
      const src = sources[r.sourceIndex], reel = `AX`, track = src?.hasAudio ? 'AA/V' : 'V   ';
      const recIn = 3600 + r.visibleStart, recOut = 3600 + r.visibleEnd;
      const srcIn = r.start + (r.visibleStart - r.timelineStart) * (r.speed || 1), srcOut = srcIn + (recOut - recIn) * (r.speed || 1);
      lines.push(`${String(i + 1).padStart(3, '0')}  ${reel.padEnd(8)} ${track}  C        ${tc(srcIn)} ${tc(srcOut)} ${recTc(r.visibleStart)} ${recTc(r.visibleEnd)}`);
      if ((r.speed ?? 1) !== 1) lines.push(`M2   ${reel.padEnd(8)}     ${(num / den * r.speed).toFixed(1).padStart(5, '0')}    ${tc(srcIn)}`);
      lines.push(`* FROM CLIP NAME: ${(src?.name ?? 'source').replace(/[^\x20-\x7e]/g, '_')}`);
      if (r.label) lines.push(`* COMMENT: ${r.label.replace(/[^\x20-\x7e]/g, '_')}`);
      if (r.transition && r.transition !== 'cut') lines.push(`* TRANSITION IN: ${r.transition} ${r.overlapIn.toFixed(2)} s (cut in this EDL)`);
      lines.push('');
    });
    for (const m of options.markers ?? []) lines.push(`* MARKER ${recTc(m.time)}: ${(m.label || '').replace(/[^\x20-\x7e]/g, '_')}`);
    return { extension: 'edl', mime: 'text/plain', content: lines.join('\r\n') };
  }
  if (format === 'csv') {
    const q = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
    // CSV formula injection guard (OWASP): a text cell starting with one of = + - @, a tab or a CR is read as a formula by Excel & co.
    const safe = v => { const s = String(v ?? ''); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; };
    const head = ['#', 'section', 'label', 'source', 'source_in', 'source_out', 'timeline_in', 'timeline_out', 'duration', 'speed', 'transition'];
    const sec = i => sections.find(s => i >= s.startIndex && i <= s.endIndex)?.name ?? '';
    const body = rows.map((r, i) => [i + 1, safe(sec(i)), safe(r.label ?? ''), safe(sources[r.sourceIndex]?.name), r.start.toFixed(3), r.end.toFixed(3), r.visibleStart.toFixed(3), r.visibleEnd.toFixed(3), (r.visibleEnd - r.visibleStart).toFixed(3), r.speed ?? 1, safe(r.transition ?? 'cut')].map(q).join(','));
    return { extension: 'csv', mime: 'text/csv', content: [head.join(','), ...body].join('\r\n') };
  }
    if (format === 'chapters') {
    const marks = chapterMarks(clips, options);
    if (!marks.length) marks.push({ start: 0, title: 'Intro' });
    const long = totalDuration(clips) >= 3600;
    const clock = t => (long ? `${Math.floor(t / 3600)}:${pad2(Math.floor(t / 60) % 60)}` : pad2(Math.floor(t / 60))) + `:${pad2(Math.floor(t % 60))}`;
    // YouTube only shows a chapter list that starts at 0:00, has at least 3 chapters and keeps
    // every chapter at least 10 s long. chapterMarks already pins the first chapter at 0:00;
    // these warnings only say when the list breaks the other two rules and YouTube ignores it.
    const warnings = [];
    if (marks.length < 3) warnings.push(`YouTube needs at least 3 chapters; this list has ${marks.length}.`);
    const total = totalDuration(clips);
    for (let i = 0; i < marks.length; i++) {
      const span = r3((marks[i + 1] ? marks[i + 1].start : total) - marks[i].start);
      if (span < 10) warnings.push(`Chapter "${marks[i].title}" is ${span} s long; YouTube needs at least 10 s.`);
    }
    return { extension: 'txt', mime: 'text/plain', content: marks.map(m => `${clock(m.start)} ${m.title}`).join('\n'), warnings };
  }
  // Voice-over / multicam sound and music as separate audio (FCPXML connected clips, OTIO audio track).
  const total = totalDuration(clips);
  const extra = [
    options.narration ? { file: options.narration, name: 'Voice', at: Number(options.narrationStart) || 0, trim: Number(options.narrationTrimStart) || 0 } : null,
    options.music ? { file: options.music, name: 'Music', at: 0, trim: Number(options.musicTrimStart) || 0 } : null,
  ].filter(x => x && x.at < total).map(x => ({ ...x, duration: total - x.at }));
  const frames = s => Math.round(s * num / den); // integer rates keep den = 1, so nothing changes there
  if (format === 'fcpxml') {
    const used = [...new Set(rows.map(r => r.sourceIndex))];
    const assets = used.map(i => { const s = sources[i]; return `    <asset id="a${i}" name="${xml(s.name)}" start="0s" duration="${frames(s.duration) * den}/${num}s" hasVideo="1" hasAudio="${s.hasAudio ? 1 : 0}" format="r1"><media-rep kind="original-media" src="${xml(fileUrl(s.file))}"/></asset>`; }).join('\n');
    const w = sources[used[0]]?.video?.width ?? 1920, h = sources[used[0]]?.video?.height ?? 1080;
    const spine = rows.map(r => {
      const off = frames(r.visibleStart), dur = Math.max(1, frames(r.visibleEnd) - off), st = frames(r.start + (r.visibleStart - r.timelineStart) * (r.speed || 1));
      const speed = (r.speed ?? 1) !== 1 ? `<timeMap><timept time="0s" value="0s" interp="linear"/><timept time="${dur * den}/${num}s" value="${Math.round(dur * r.speed) * den}/${num}s" interp="linear"/></timeMap>` : '';
      const mute = r.gain === 0 ? '<adjust-volume amount="-96dB"/>' : '';
      const connected = r.index === 0 ? extra.map((x, k) => `<asset-clip ref="x${k}" lane="-${k + 1}" name="${xml(x.name)}" offset="${(st + frames(x.at)) * den}/${num}s" start="${frames(x.trim) * den}/${num}s" duration="${frames(x.duration) * den}/${num}s" audioRole="${k || !options.narration ? 'music' : 'dialogue'}"/>`).join('') : '';
      return `          <asset-clip ref="a${r.sourceIndex}" name="${xml(r.label || sources[r.sourceIndex]?.name)}" offset="${off * den}/${num}s" start="${st * den}/${num}s" duration="${dur * den}/${num}s">${speed}${mute}${connected}</asset-clip>`;
    }).join('\n');
    const extraAssets = extra.map((x, k) => `\n    <asset id="x${k}" name="${xml(x.name)}" start="0s" duration="${frames(x.trim + x.duration) * den}/${num}s" hasAudio="1" audioSources="1" audioChannels="2"><media-rep kind="original-media" src="${xml(fileUrl(x.file))}"/></asset>`).join('');
    const totalFrames = frames(total);
    const markers = (options.markers ?? []).map(m => `          <marker start="${frames(m.time) * den}/${num}s" duration="${den}/${num}s" value="${xml(m.label)}"/>`).join('\n');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" frameDuration="${den}/${num}s" width="${w}" height="${h}"/>
${assets}${extraAssets}
  </resources>
  <library>
    <event name="AI Edit Studio">
      <project name="${xml(name)}">
        <sequence format="r1" duration="${totalFrames * den}/${num}s" tcStart="0s" tcFormat="${df ? 'DF' : 'NDF'}">
          <spine>
${spine}
          </spine>
${markers}
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
    return { extension: 'fcpxml', mime: 'application/xml', content };
  }
  if (format === 'otio') {
    const rate = num / den;
    const rt = s => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value: frames(s) });
    const tr = (a, d) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: rt(a), duration: rt(d) });
    const clipItems = rows.map(r => ({
      OTIO_SCHEMA: 'Clip.2', name: r.label || sources[r.sourceIndex]?.name || 'clip', metadata: { aiEditStudio: { id: r.id, speed: r.speed ?? 1, transition: r.transition ?? 'cut' } },
      source_range: tr(r.start + (r.visibleStart - r.timelineStart) * (r.speed || 1), (r.visibleEnd - r.visibleStart) * (r.speed || 1)),
      media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: 'ExternalReference.1', target_url: fileUrl(sources[r.sourceIndex]?.file ?? ''), available_range: tr(0, sources[r.sourceIndex]?.duration ?? 0) } },
      active_media_reference_key: 'DEFAULT_MEDIA', effects: [], markers: [], enabled: true,
    }));
    // A transition sits between two clips and takes no track time: each side uses half the overlap, in whole frames.
    const rtFrames = value => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value });
    const children = [];
    let headUsed = 0; // frames the transition before the previous clip already takes from that clip
    rows.forEach((r, i) => {
      const half = Math.round(r.overlapIn / 2 * num / den);
      const inFrames = i > 0 ? Math.min(half, Math.max(0, clipItems[i - 1].source_range.duration.value - headUsed)) : 0;
      const outFrames = Math.min(half, clipItems[i].source_range.duration.value);
      const cut = i > 0 && inFrames + outFrames > 0;
      if (cut) children.push({
        OTIO_SCHEMA: 'Transition.1', name: r.transition, transition_type: r.transition === 'fade' ? 'SMPTE_Dissolve' : 'Custom_Transition',
        in_offset: rtFrames(inFrames), out_offset: rtFrames(outFrames), metadata: { aiEditStudio: { transition: r.transition, seconds: r.overlapIn } },
      });
      headUsed = cut ? outFrames : 0;
      children.push(clipItems[i]);
    });
    const doc = { OTIO_SCHEMA: 'Timeline.1', name, global_start_time: rt(0), metadata: {},
      tracks: { OTIO_SCHEMA: 'Stack.1', name: 'tracks', children: [{ OTIO_SCHEMA: 'Track.1', name: 'V1', kind: 'Video', children, markers: (options.markers ?? []).map(m => ({ OTIO_SCHEMA: 'Marker.2', name: m.label ?? '', marked_range: tr(m.time, 0), color: (m.color ?? 'yellow').toUpperCase() })) },
        ...extra.map((x, k) => ({ OTIO_SCHEMA: 'Track.1', name: `A${k + 1} ${x.name}`, kind: 'Audio', markers: [], children: [
          ...(x.at > 0 ? [{ OTIO_SCHEMA: 'Gap.1', name: '', source_range: tr(0, x.at) }] : []),
          { OTIO_SCHEMA: 'Clip.2', name: x.name, source_range: tr(x.trim, x.duration), media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: 'ExternalReference.1', target_url: fileUrl(x.file), available_range: null } }, active_media_reference_key: 'DEFAULT_MEDIA', effects: [], markers: [], enabled: true }] }))] } };
    return { extension: 'otio', mime: 'application/json', content: JSON.stringify(doc, null, 2) };
  }
  throw new Error('format: edl, fcpxml, otio, csv, chapters, srt or vtt.');
}
export { r3 };
