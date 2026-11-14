// Director mode: one brief in, a finished edit out. Pure planning from measured signals
// (motion, loudness, scene cuts, black frames, beats, transcript). No taste or story claims.
import { curvesFor, hookScore, reviewEdit } from '../public/insights.js';
import { applyOperations, layout, totalDuration, coreClips, newClipId, mergeRanges, subtractRanges, LIMITS } from '../public/edit-ops.js';
import { captionsFromEdit } from '../public/transcript.js';

export const PLATFORMS = Object.freeze({
  shorts: { name: 'YouTube Shorts', formats: ['vertical'], duration: 30, maxDuration: 60, pace: 'punchy', keep: 'highlights', aspect: '9:16',
    options: { look: 'vivid', lookStrength: 0.55, captionStyle: 'bold', captionPosition: 'middle', captionAnimation: 'karaoke', captionCase: 'upper', fadeIn: 0, fadeOut: 0.25, exportVertical: true } },
  tiktok: { name: 'TikTok', formats: ['vertical'], duration: 25, maxDuration: 180, pace: 'punchy', keep: 'highlights', aspect: '9:16',
    options: { look: 'vivid', lookStrength: 0.6, captionStyle: 'bold', captionPosition: 'middle', captionAnimation: 'pop', captionCase: 'upper', fadeIn: 0, fadeOut: 0.2, exportVertical: true } },
  reels: { name: 'Instagram Reels', formats: ['vertical'], duration: 30, maxDuration: 90, pace: 'punchy', keep: 'highlights', aspect: '9:16',
    options: { look: 'vivid', lookStrength: 0.5, captionStyle: 'bold', captionPosition: 'middle', captionAnimation: 'karaoke', fadeIn: 0, fadeOut: 0.3, exportVertical: true } },
  feed: { name: 'Feed post 4:5 / 1:1', formats: ['portrait', 'square'], duration: 20, maxDuration: 60, pace: 'punchy', keep: 'highlights', aspect: '4:5',
    options: { look: 'vivid', lookStrength: 0.45, captionStyle: 'bold', captionPosition: 'low', captionAnimation: 'highlight', fadeIn: 0, fadeOut: 0.3, exportSquare: true, exportPortrait: true } },
  youtube: { name: 'YouTube video', formats: ['landscape'], duration: 90, maxDuration: 1200, pace: 'balanced', keep: 'story', aspect: null,
    options: { look: 'cinema', lookStrength: 0.35, captionStyle: 'box', captionPosition: 'low', fadeIn: 0.2, fadeOut: 0.6 } },
  trailer: { name: 'Game / product trailer', formats: ['qhd', 'vertical', 'whatsapp'], duration: 60, maxDuration: 180, pace: 'balanced', keep: 'highlights', aspect: '9:16', finale: true,
    options: { look: 'cinema', lookStrength: 0.65, captionStyle: 'box', captionPosition: 'low', fadeIn: 0.3, fadeOut: 0, masterFormat: 'qhd', exportVertical: true } },
  vlog: { name: 'Vlog', formats: ['landscape'], duration: 0, maxDuration: 1200, pace: 'calm', keep: 'most', aspect: null,
    options: { look: 'neutral', lookStrength: 0, captionStyle: 'box', captionPosition: 'low', fadeIn: 0.2, fadeOut: 0.6 } },
  film: { name: 'Cinematic / film', formats: ['qhd'], duration: 0, maxDuration: 1200, pace: 'calm', keep: 'most', aspect: null,
    options: { look: 'cinema', lookStrength: 0.8, captionStyle: 'minimal', captionPosition: 'low', fadeIn: 0.8, fadeOut: 1, masterFormat: 'qhd' } },
});
export const PACES = Object.freeze({
  punchy: { shot: 2.2, min: 1.1, max: 3.5, every: 1, transition: null },
  balanced: { shot: 4, min: 2, max: 7, every: 2, transition: 'fade' },
  calm: { shot: 7, min: 3.5, max: 16, every: 4, transition: 'fade' },
});
const STEP = 0.5;
const r3 = n => Math.round(n * 1000) / 1000;
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function energyAt(curve, start, end) {
  const out = [];
  for (let i = Math.floor(start / STEP); i < Math.ceil(end / STEP) && i < curve.energy.length; i++) if (i >= 0) out.push(curve.energy[i] ?? 0);
  return mean(out);
}

/** Usable source intervals: trims, black frames and long dead stretches (still + silent) removed. */
/** A 0.5 s bucket is dead when the picture is (nearly) frozen AND the sound is (nearly) silent — absolute levels, not relative energy. */
function deadBucket(curve, i, { motion = 0.6, loudness = -45 } = {}) {
  const m = curve.motion[i], l = curve.loudness[i];
  return (m == null || m < motion) && (l == null || l < loudness);
}
export function usableIntervals(sources, curves, { trimStart = 0, trimEnd = 0, dead = 3 } = {}) {
  const out = [];
  sources.forEach((s, sourceIndex) => {
    if (s.still || !(s.duration > 0)) return;
    const cut = [{ start: 0, end: trimStart }, { start: s.duration - trimEnd, end: s.duration }, ...(s.black ?? []).map(b => ({ start: b.start, end: b.end }))];
    const c = curves[sourceIndex];
    if (c && dead > 0) {
      let run = null;
      c.energy.forEach((e, i) => {
        if (c.black[i] || deadBucket(c, i)) run ??= i; else if (run != null) { if ((i - run) * STEP >= dead) cut.push({ start: run * STEP + 0.25, end: i * STEP - 0.25 }); run = null; }
      });
      if (run != null && (c.energy.length - run) * STEP >= dead) cut.push({ start: run * STEP + 0.25, end: s.duration });
    }
    for (const [a, b] of subtractRanges(0, s.duration, mergeRanges(cut.filter(r => r.end > r.start)))) if (b - a >= LIMITS.minSource) out.push({ sourceIndex, start: r3(a), end: r3(b) });
  });
  return out;
}

/** Tile intervals into windows of about `shot` seconds, snapping edges to nearby scene cuts. */
export function windows(intervals, sources, curves, shot) {
  const out = [];
  for (const iv of intervals) {
    const cuts = (sources[iv.sourceIndex].scenes ?? []).filter(t => t > iv.start + 0.4 && t < iv.end - 0.4);
    let t = iv.start;
    while (iv.end - t >= Math.min(shot * 0.6, iv.end - iv.start) - 1e-6 && iv.end - t >= LIMITS.minSource) {
      let end = Math.min(iv.end, t + shot);
      // Prefer to cut where the footage itself cuts: a scene change late in the window (or just after it).
      const near = cuts.find(c => c >= t + Math.max(LIMITS.minSource, shot * 0.6) && c <= t + shot * 1.35);
      if (near) end = near;
      if (iv.end - end < Math.max(LIMITS.minSource, shot * 0.6)) end = iv.end; // no slivers at the end: the last window absorbs them
      out.push({ sourceIndex: iv.sourceIndex, start: r3(t), end: r3(end), energy: energyAt(curves[iv.sourceIndex], t, end), peak: Math.max(...curves[iv.sourceIndex].energy.slice(Math.floor(t / STEP), Math.ceil(end / STEP)), 0) });
      t = end;
    }
  }
  return out;
}

/** Join windows that are contiguous in the same source into single shots (fewer, longer cuts). */
function mergeContiguous(rows, maxShot = Infinity) {
  const out = [];
  for (const w of rows) {
    const last = out.at(-1);
    if (last && last.sourceIndex === w.sourceIndex && Math.abs(last.end - w.start) < 0.02 && w.end - last.start <= maxShot) { last.end = w.end; last.energy = Math.max(last.energy, w.energy); }
    else out.push({ ...w });
  }
  return out;
}

/** Best opening moment candidates: short windows whose first seconds are strongest. */
export function hookCandidates(intervals, sources, curves, { length = 2.5, count = 3 } = {}) {
  const found = [];
  for (const iv of intervals) {
    const c = curves[iv.sourceIndex];
    for (let t = iv.start; t + length <= iv.end; t += STEP) {
      const head = energyAt(c, t, t + Math.min(1.5, length)), body = energyAt(c, t, t + length);
      const cut = (sources[iv.sourceIndex].scenes ?? []).some(s => s > t + 0.2 && s < t + length - 0.2) ? 0.05 : 0;
      found.push({ sourceIndex: iv.sourceIndex, start: r3(t), end: r3(t + length), score: 0.6 * head + 0.4 * body + cut });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const f of found) {
    if (picked.length >= count) break;
    if (picked.some(p => p.sourceIndex === f.sourceIndex && Math.min(p.end, f.end) - Math.max(p.start, f.start) > -2)) continue;
    picked.push(f);
  }
  return picked;
}

/** Put `hook` first and cut its range out of the other clips. */
function withHook(clips, hook) {
  const rest = [];
  for (const c of clips) {
    if (c.sourceIndex !== hook.sourceIndex) { rest.push(c); continue; }
    const pieces = subtractRanges(c.start, c.end, [{ start: hook.start, end: hook.end }]).filter(([a, b]) => b - a >= LIMITS.minSource);
    pieces.forEach(([a, b], k) => rest.push({ ...c, id: k ? newClipId() : c.id, start: r3(a), end: r3(b) }));
  }
  return [{ id: newClipId(), sourceIndex: hook.sourceIndex, start: hook.start, end: hook.end, label: 'hook' }, ...rest];
}

/** Fit a chronological selection into `budget` seconds by dropping the weakest windows. */
function fitToBudget(rows, budget) {
  let total = rows.reduce((s, w) => s + (w.end - w.start), 0);
  const order = rows.map((w, i) => ({ i, e: w.energy })).sort((a, b) => a.e - b.e);
  const drop = new Set();
  for (const { i } of order) { if (total <= budget + 0.5) break; drop.add(i); total -= rows[i].end - rows[i].start; }
  return rows.filter((_, i) => !drop.has(i));
}

/**
 * Plan a complete edit. `goal`: {platform, duration, pace, keep, hook, hookText, title, cta, transitions}.
 * Returns {clips, options, texts, variants, report}. Never repeats footage and never invents frames.
 */
export function buildAutoEdit({ sources, options = {}, goal = {}, beats = [], transcripts = {} }) {
  const platform = PLATFORMS[goal.platform ?? 'shorts'];
  if (!platform) throw new Error(`Unknown platform. Choose ${Object.keys(PLATFORMS).join(', ')}.`);
  const pace = PACES[goal.pace ?? platform.pace];
  if (!pace) throw new Error('pace: calm, balanced or punchy.');
  const keep = goal.keep ?? platform.keep;
  if (!['highlights', 'story', 'most'].includes(keep)) throw new Error('keep: highlights, story or most.');
  if (!sources.some(s => !s.still && s.motion?.length)) throw new Error('Analyze the sources first.');
  const curves = curvesFor(sources);
  const intervals = usableIntervals(sources, curves, { trimStart: options.trimStart ?? 0, trimEnd: options.trimEnd ?? 0, dead: keep === 'most' ? 4 : 2.5 });
  const available = intervals.reduce((s, x) => s + x.end - x.start, 0);
  const sourceSeconds = sources.filter(s => !s.still).reduce((s, x) => s + x.duration, 0);
  if (available < 1) throw new Error('No usable footage after removing black frames and dead stretches.');
  let target = Number(goal.duration) || platform.duration || available;
  target = Math.min(target, platform.maxDuration, LIMITS.editSeconds, available);
  const steps = [];
  steps.push(`${available.toFixed(1)} s usable of ${sourceSeconds.toFixed(1)} s (${(sourceSeconds - available).toFixed(1)} s black, trimmed or dead removed)`);

  // 1. Select footage.
  let rows;
  const all = windows(intervals, sources, curves, pace.shot);
  if (keep === 'most') {
    rows = mergeContiguous(fitToBudget(all, target));
    steps.push(`kept ${rows.length} continuous shot(s) in recorded order`);
  } else if (keep === 'story') {
    rows = mergeContiguous(fitToBudget(all, target), pace.max * 2);
    steps.push(`story order: ${rows.length} shot(s), weakest windows dropped`);
  } else {
    const ranked = [...all].sort((a, b) => b.energy - a.energy || a.start - b.start);
    const picked = []; let total = 0;
    const minGap = pace.shot * 0.5;
    for (const w of ranked) {
      if (total >= target - 0.3) break;
      if (picked.some(p => p.sourceIndex === w.sourceIndex && Math.max(p.start, w.start) - Math.min(p.end, w.end) < minGap)) continue;
      const len = Math.min(w.end - w.start, target - total);
      if (len < pace.min * 0.8) continue;
      picked.push({ ...w, end: r3(w.start + len) }); total += len;
    }
    // Second pass: fill the remaining time with the next-best windows that do not overlap (gap rule relaxed).
    for (const w of ranked) {
      if (total >= target - 0.3) break;
      if (picked.some(p => p.sourceIndex === w.sourceIndex && Math.min(p.end, w.end) - Math.max(p.start, w.start) > 0.01)) continue;
      const len = Math.min(w.end - w.start, target - total);
      if (len < pace.min * 0.8) continue;
      picked.push({ ...w, end: r3(w.start + len) }); total += len;
    }
    // Build-up: strongest opens (hook), the rest rises in energy, the second strongest closes.
    const sorted = [...picked].sort((a, b) => b.energy - a.energy);
    const finale = sorted.length > 2 ? sorted[1] : null;
    const middle = picked.filter(p => p !== sorted[0] && p !== finale).sort((a, b) => a.energy - b.energy);
    rows = [sorted[0], ...middle, ...(finale ? [finale] : [])].filter(Boolean);
    steps.push(`${rows.length} highlight shot(s), energy build-up, strongest moment first`);
  }
  if (!rows.length) throw new Error('No footage could be selected; try keep:"most" or a longer duration.');
  let clips = rows.slice(0, LIMITS.clips).map(r => ({ id: newClipId(), sourceIndex: r.sourceIndex, start: r.start, end: r.end }));

  // 2. Hook variants: the strongest possible first seconds.
  let variants = [];
  if (goal.hook !== false && clips.length) {
    const candidates = hookCandidates(intervals, sources, curves, { length: Math.min(3, Math.max(1.5, pace.shot)), count: 3 });
    const base = { label: 'As selected', clips, hook: hookScore(clips, sources, 3, curves).score };
    variants = [base, ...candidates.map((h, k) => {
      const v = withHook(clips, h);
      // Keep within the budget: trim the weakest tail clip(s) if the hook made the edit longer.
      while (totalDuration(v) > target + 1 && v.length > 2) v.splice(v.length - 2, 1);
      return { label: `Hook ${String.fromCharCode(65 + k)}`, clips: v, hook: hookScore(v, sources, 3, curves).score, moment: { sourceIndex: h.sourceIndex, start: h.start, end: h.end } };
    })].filter(v => v.clips.length);
    variants.sort((a, b) => b.hook - a.hook);
    clips = variants[0].clips;
    steps.push(`opening: ${variants[0].label} (hook ${variants[0].hook}/100; tried ${variants.length})`);
  }

  // 3. Transitions: dissolve on jumps between recordings for calm/balanced; dip to black before a finale.
  const transition = goal.transitions === false ? null : pace.transition;
  clips = clips.map((c, i) => {
    if (!i) return c;
    const prev = clips[i - 1];
    const continuous = prev.sourceIndex === c.sourceIndex && Math.abs(prev.end - c.start) < 0.05;
    if (continuous) return c;
    if (platform.finale && i === clips.length - 1 && clips.length > 2) return { ...c, transition: 'fadeblack', transitionSeconds: 0.6, label: c.label || 'finale' };
    if (transition && (keep !== 'highlights' || prev.sourceIndex !== c.sourceIndex)) return { ...c, transition, transitionSeconds: keep === 'most' ? 0.8 : 0.5 };
    return c;
  });

  // 4. Options: platform look, titles, captions from transcripts.
  const patch = { ...platform.options, duration: Math.max(5, Math.round(totalDuration(clips))), style: pace === PACES.punchy ? 'action' : 'flight', template: '' };
  if (goal.title !== undefined) patch.title = String(goal.title).slice(0, 100);
  if (goal.cta !== undefined) patch.endTitle = String(goal.cta).slice(0, 100);
  if (goal.label !== undefined) patch.label = String(goal.label).slice(0, 70);
  if (platform.finale) patch.finaleSeconds = 0;
  const texts = [...(options.texts ?? [])];
  if (goal.hookText) texts.push({ start: 0.15, end: Math.min(2.6, totalDuration(clips) - 0.2), text: String(goal.hookText).slice(0, 120), style: 'big', position: platform.aspect === '9:16' ? 'high' : 'center' });
  patch.texts = texts;
  const captions = [];
  let captionsDropped = 0, captionsDroppedSources = [];
  for (const [index, t] of Object.entries(transcripts)) if (t?.words?.length) captions.push(...captionsFromEdit(t.words, clips, Number(index)));
  if (captions.length) {
    const leftOut = captions.slice(LIMITS.captions);
    patch.captions = captions.slice(0, LIMITS.captions);
    captionsDropped = leftOut.length;
    captionsDroppedSources = [...new Set(leftOut.map(c => c.sourceIndex))];
    steps.push(`${patch.captions.length} caption(s) from the transcript`);
    if (captionsDropped) steps.push(`${captionsDropped} caption(s) not added: at most ${LIMITS.captions} lines`);
  }

  // 5. Beat sync and an automatic review-fix loop.
  let state = { clips: coreClips(clips), options: { ...options, ...patch } };
  const ctx = { sources: sources.map(s => ({ duration: s.duration })), beats };
  if (beats.length > 4 && state.clips.length > 1 && goal.beatSync !== false) {
    try { state = applyOperations(state, [{ op: 'beat_sync', every: pace.every, maxShift: 0.4 }], ctx); steps.push(`cuts snapped to the beat (every ${pace.every})`); } catch { /* keep unsynced */ }
  }
  const SAFE = new Set(['BLACK_FRAMES', 'SHORT_SHOT', 'NARRATION_AFTER_END', 'FINALE_FADE', ...(keep === 'most' ? [] : ['JUMP_CUT'])]);
  let review = reviewEdit({ clips: state.clips, sources, options: state.options, beats, analyzed: true, curves });
  const fixed = [];
  for (let round = 0; round < 3; round++) {
    const issue = review.issues.find(i => SAFE.has(i.code) && i.fix?.operations?.length);
    if (!issue) break;
    try {
      const next = applyOperations(state, issue.fix.operations, ctx);
      const after = reviewEdit({ clips: next.clips, sources, options: next.options, beats, analyzed: true, curves });
      if (after.score < review.score) break;
      state = next; review = after; fixed.push(issue.code);
    } catch { break; }
  }
  if (fixed.length) steps.push(`auto-fixed: ${fixed.join(', ')}`);
  const used = state.clips.reduce((s, c) => s + c.end - c.start, 0);
  return {
    clips: state.clips, options: state.options,
    variants: variants.map(v => ({ label: v.label, hook: v.hook, moment: v.moment, clips: coreClips(v.clips) })),
    report: {
      platform: goal.platform ?? 'shorts', platformName: platform.name, pace: goal.pace ?? platform.pace, keep,
      duration: r3(totalDuration(state.clips)), target: r3(target), shots: state.clips.length,
      footageUsedSeconds: r3(used), footageUsedPercent: Math.round(100 * used / Math.max(1, available)),
      hook: review.hook?.score ?? null, review: { score: review.score, grade: review.grade, counts: review.counts, top: review.issues.slice(0, 4).map(i => ({ code: i.code, message: i.message })) },
      formats: platform.formats, aspect: platform.aspect, steps, captionsDropped, captionsDroppedSources,
      note: 'Selection uses measured motion, loudness, scene cuts and black frames — not story or meaning. Watch the preview.',
    },
  };
}

export function layoutSummary(clips) { return layout(clips).map(r => ({ id: r.id, sourceIndex: r.sourceIndex, start: r.start, end: r.end, timelineIn: r3(r.timelineStart), timelineOut: r3(r.timelineEnd) })); }
