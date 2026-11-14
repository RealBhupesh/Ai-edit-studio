// Measured editorial signals: energy curves, highlight windows, hook strength and
// an automated quality review with machine-applicable fixes. Heuristics only:
// these numbers describe motion/loudness/cuts, not story or meaning.
import { layout, totalDuration, sourceRoom, LIMITS } from './edit-ops.js';
import { mapCaptions } from './captions.js';

const STEP = 0.5;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/** Per-0.5 s curves for one analyzed source. */
export function sourceCurves(source) {
  const buckets = Math.max(1, Math.ceil((source.duration || 0) / STEP));
  const motion = new Array(buckets).fill(null), loud = new Array(buckets).fill(null), cuts = new Array(buckets).fill(0);
  const acc = new Array(buckets).fill(0), cnt = new Array(buckets).fill(0);
  for (const p of source.motion ?? []) { const i = Math.floor(p.time / STEP); if (i >= 0 && i < buckets) { acc[i] += p.value; cnt[i]++; } }
  for (let i = 0; i < buckets; i++) motion[i] = cnt[i] ? acc[i] / cnt[i] : null;
  for (const p of source.audio ?? []) { const i = Math.floor(p.time / STEP + 1e-6); if (i >= 0 && i < buckets) loud[i] = Math.max(-90, p.value); }
  for (const t of source.scenes ?? []) { const i = Math.floor(t / STEP); if (i >= 0 && i < buckets) cuts[i]++; }
  const black = new Array(buckets).fill(false);
  for (const b of source.black ?? []) for (let i = Math.floor(b.start / STEP); i < Math.min(buckets, Math.ceil(b.end / STEP)); i++) if (i >= 0) black[i] = true;
  const mValues = motion.filter(v => v != null), lValues = loud.filter(v => v != null && v > -89);
  const mLo = percentile(mValues, 0.1), mHi = percentile(mValues, 0.95) || 1;
  const lLo = percentile(lValues, 0.1), lHi = percentile(lValues, 0.95);
  const energy = motion.map((m, i) => {
    if (black[i]) return 0;
    const mn = m == null ? 0.3 : clamp((m - mLo) / Math.max(1e-6, mHi - mLo));
    const ln = loud[i] == null || !lValues.length ? 0.3 : clamp((loud[i] - lLo) / Math.max(1, lHi - lLo));
    return round(clamp(0.6 * mn + 0.3 * ln + 0.1 * Math.min(1, cuts[i])), 3);
  });
  return { step: STEP, duration: source.duration, motion: motion.map(v => v == null ? null : round(v, 2)), loudness: loud.map(v => v == null ? null : round(v, 1)), energy, black, cuts: source.scenes ?? [] };
}

export function curvesFor(sources) { return sources.map(sourceCurves); }

function meanRange(series, start, end) {
  let s = 0, n = 0;
  for (let i = Math.floor(start / STEP); i < Math.ceil(end / STEP) && i < series.length; i++) if (i >= 0 && series[i] != null) { s += series[i]; n++; }
  return n ? s / n : null;
}

/** Energy of a clip, using its source curve. */
export function clipEnergy(curves, clip) { return meanRange(curves[clip.sourceIndex]?.energy ?? [], clip.start, clip.end) ?? 0; }

/** Ranked high-energy windows across sources (non-overlapping, outside black). */
export function highlights(sources, { length = 4, count = 8, exclude = [] } = {}) {
  const curves = curvesFor(sources);
  const found = [];
  curves.forEach((c, sourceIndex) => {
    const w = Math.max(1, Math.round(length / STEP));
    for (let i = 0; i + w <= c.energy.length; i++) {
      const window = c.energy.slice(i, i + w);
      if (c.black.slice(i, i + w).some(Boolean)) continue;
      const score = window.reduce((a, b) => a + b, 0) / w;
      found.push({ sourceIndex, start: i * STEP, end: Math.min(c.duration, (i + w) * STEP), score });
    }
  });
  found.sort((a, b) => b.score - a.score);
  const picked = [];
  const overlaps = (a, b) => a.sourceIndex === b.sourceIndex && Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0.01;
  for (const f of found) {
    if (picked.length >= count) break;
    if (picked.some(p => overlaps(p, f)) || exclude.some(e => overlaps(e, f))) continue;
    picked.push({ ...f, start: round(f.start), end: round(f.end), score: Math.round(f.score * 100) });
  }
  return picked;
}

/** How strong the opening seconds are compared with the rest of the edit (0–100). */
export function hookScore(clips, sources, seconds = 3, curves = curvesFor(sources)) {
  const rows = layout(clips);
  const samples = [];
  for (const r of rows) {
    const e = curves[r.sourceIndex]?.energy ?? [];
    for (let t = r.timelineStart; t < r.timelineEnd; t += STEP) {
      const sourceTime = r.start + (t - r.timelineStart) * (r.speed || 1);
      samples.push({ t, v: e[Math.floor(sourceTime / STEP)] ?? 0 });
    }
  }
  if (!samples.length) return { score: 0, opening: 0, median: 0 };
  const opening = samples.filter(s => s.t < seconds).map(s => s.v);
  const openingMean = opening.reduce((a, b) => a + b, 0) / Math.max(1, opening.length);
  const all = samples.map(s => s.v);
  const top = percentile(all, 0.9) || 1e-6;
  const cutsInOpening = rows.filter(r => r.timelineStart > 0.05 && r.timelineStart < seconds).length;
  const score = Math.round(100 * clamp(0.75 * openingMean / top + 0.1 * Math.min(1, cutsInOpening) + (rows[0] && rows[0].duration < 6 ? 0.15 : 0)));
  return { score, opening: round(openingMean), top: round(top), median: round(percentile(all, 0.5)), seconds };
}

const severityWeight = { error: 18, warning: 7, tip: 2 };

/**
 * Plan-level quality review. Each issue may carry `fix.operations` that can be
 * sent to studio_edit unchanged. Nothing is applied automatically.
 */
export function reviewEdit({ clips, sources, options = {}, beats = [], analyzed = true, curves: given,
  captionsDropped = 0, captionsDroppedSources = [] }) {
  const issues = [];
  const add = (severity, code, message, extra = {}) => issues.push({ severity, code, message, ...extra });
  const rows = layout(clips);
  const total = totalDuration(clips);
  const curves = analyzed ? given ?? curvesFor(sources) : null;
  const action = options.style === 'action';
  const finaleProtected = Number(options.finaleSeconds) > 0;

  rows.forEach((r, i) => {
    const ref = r.id ?? i;
    const last = i === rows.length - 1;
    if (r.duration < 0.8 && !(last && finaleProtected)) {
      add('warning', 'SHORT_SHOT', `Shot ${i + 1} lasts ${r.duration.toFixed(2)} s — viewers see this as a flash.`, { clip: i, time: r.timelineStart,
        fix: { label: 'Delete shot', operations: [{ op: 'delete', clip: ref }] } });
    }
    if (action && r.duration > 6 && !(last && finaleProtected)) {
      const mid = r.start + (r.end - r.start) / 2;
      add('tip', 'LONG_SHOT', `Shot ${i + 1} lasts ${r.duration.toFixed(1)} s in a punchy edit.`, { clip: i, time: r.timelineStart,
        fix: { label: 'Split in two', operations: [{ op: 'split', clip: ref, sourceTime: round(mid) }] } });
    }
    const prev = rows[i - 1];
    if (prev && prev.sourceIndex === r.sourceIndex && !(r.overlapIn > 0) && !options.allowJumpCuts) {
      const gap = r.start - prev.end;
      if (gap > 0 && gap < 2) {
        const merge = gap < 0.6 && (prev.speed || 1) === (r.speed || 1) && (prev.gain ?? 1) === (r.gain ?? 1);
        add('warning', 'JUMP_CUT', `Jump cut between shots ${i} and ${i + 1}: ${gap.toFixed(2)} s of the same recording skipped.`, { clip: i, time: r.timelineStart,
          fix: merge ? { label: 'Merge', operations: [{ op: 'delete', clip: ref }, { op: 'trim', clip: prev.id ?? i - 1, end: r.end }] }
            : { label: 'Delete second shot', operations: [{ op: 'delete', clip: ref }] } });
      }
    }
    if (curves) {
      const c = curves[r.sourceIndex];
      for (const b of sources[r.sourceIndex]?.black ?? []) {
        const overlap = Math.min(b.end, r.end) - Math.max(b.start, r.start);
        if (overlap < 0.25) continue;
        let fix;
        if (b.start <= r.start + 0.05 && r.end - (b.end + 0.05) >= LIMITS.minSource) fix = { label: 'Trim black start', operations: [{ op: 'trim', clip: ref, start: round(b.end + 0.05) }] };
        else if (b.end >= r.end - 0.05 && (b.start - 0.05) - r.start >= LIMITS.minSource) fix = { label: 'Trim black end', operations: [{ op: 'trim', clip: ref, end: round(b.start - 0.05) }] };
        add('warning', 'BLACK_FRAMES', `Shot ${i + 1} contains ${overlap.toFixed(1)} s of (near-)black frames.`, { clip: i, time: r.timelineStart + Math.max(0, b.start - r.start) / (r.speed || 1), ...(fix ? { fix } : {}) });
        break;
      }
      const loud = meanRange(c?.loudness ?? [], r.start, r.end);
      if (sources[r.sourceIndex]?.hasAudio && loud != null && loud < -50 && (r.gain ?? 1) > 0 && !options.music && !options.narration) {
        add('tip', 'SILENT_SHOT', `Shot ${i + 1} is nearly silent (${loud.toFixed(0)} dB) and there is no music or voice-over.`, { clip: i, time: r.timelineStart });
      }
    }
    if ((r.zoom ?? 1) > 1.6) add('tip', 'HEAVY_ZOOM', `Shot ${i + 1} zooms in ${r.zoom}×; check the sharpness in a preview.`, { clip: i, time: r.timelineStart });
  });

  if (curves && rows.length > 1) {
    const hook = hookScore(clips, sources, 3, curves);
    if (hook.score < 45) {
      const energies = rows.map((r, i) => ({ i, e: clipEnergy(curves, r), last: i === rows.length - 1 }));
      const best = energies.filter(x => !(x.last && finaleProtected)).sort((a, b) => b.e - a.e)[0];
      add('warning', 'WEAK_HOOK', `Weak opening (hook score ${hook.score}/100): the first 3 seconds have less motion/sound than the rest.`, { time: 0,
        ...(best && best.i > 0 ? { fix: { label: `Move shot ${best.i + 1} to the front`, operations: [{ op: 'move', clip: rows[best.i].id ?? best.i, to: 0 }] } } : {}) });
    }
  }

  const target = Number(options.duration) || 0;
  if (target && Math.abs(total - target) > 2) add('tip', 'DURATION', `Edit lasts ${total.toFixed(1)} s; target duration is ${target} s.`);
  if ((options.exportVertical || options.exportSquare || options.exportPortrait) && total > 60) {
    add('tip', 'SOCIAL_LENGTH', 'Vertical/social version is longer than 60 s; consider a separate short cut for Shorts/Reels/TikTok.');
  }
  if (action && !options.music) add('tip', 'NO_MUSIC', 'Punchy edit without music. Music with beat sync usually adds more drive.');
  if (options.narration && Number(options.narrationStart) >= total) add('error', 'NARRATION_AFTER_END', 'Voice-over starts after the end of the edit.', { fix: { label: 'Start voice-over at 0', operations: [{ op: 'set_options', options: { narrationStart: 0 } }] } });
  if (finaleProtected && Number(options.fadeOut) > 0) add('tip', 'FINALE_FADE', 'Your finale fades out at the end. Fade-out 0 keeps the last frames fully visible.', { fix: { label: 'Fade-out off', operations: [{ op: 'set_options', options: { fadeOut: 0 } }] } });
  // Timeline texts count too: a hook text in the first seconds or a call to action at the end.
  const timelineTexts = Array.isArray(options.texts) ? options.texts : [];
  const textAtEdges = timelineTexts.some(x => Number(x.start) < 3 || Number(x.end) > total - 3);
  if (!options.title && !options.endTitle && !textAtEdges) add('tip', 'NO_TEXT', 'No opening or end text. A short title or call to action helps viewers.');

  const cues = mapCaptions(options.captions ?? [], clips, Number(options.captionOffset) || 0);
  cues.forEach((cue, i) => {
    const d = cue.end - cue.start;
    if (d > 0 && cue.text.length / d > 21) add('warning', 'CAPTION_FAST', `Caption ${i + 1} is too fast to read (${Math.round(cue.text.length / d)} chars/s).`, { time: cue.start });
    else if (d < 0.6) add('tip', 'CAPTION_CUT', `Caption ${i + 1} is on screen for only ${d.toFixed(2)} s because of a cut.`, { time: cue.start });
  });

  if (beats.length > 4 && rows.length > 2) {
    const cuts = rows.slice(0, -1).map(r => r.timelineEnd);
    const offsets = cuts.map(t => Math.min(...beats.map(b => Math.abs(b - t))));
    const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
    if (mean > 0.08) add('tip', 'OFF_BEAT', `Cuts are on average ${Math.round(mean * 1000)} ms off the beat.`, { fix: { label: 'Snap cuts to beat', operations: [{ op: 'beat_sync' }] } });
  }
  if (!analyzed) add('tip', 'NOT_ANALYZED', 'Analyze the sources for picture/sound checks (black frames, hook, silence).');
  // The caption cap is a real loss of content, not a style tip: an agent that only
  // calls studio_review has to see that the end of the transcript has no captions (#105).
  if (captionsDropped > 0) {
    const from = captionsDroppedSources.length ? ` Sources that lost lines: ${captionsDroppedSources.map(i => `#${i}`).join(', ')}.` : '';
    add('warning', 'CAPTIONS_LIMIT', `${captionsDropped} caption(s) were not added: at most ${LIMITS.captions} lines. Shorten the edit or split it, or the end of the talk will have no captions.${from}`, { time: 0 });
  }

  const order = { error: 0, warning: 1, tip: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || (a.time ?? 0) - (b.time ?? 0));
  const score = Math.max(0, 100 - issues.reduce((s, i) => s + severityWeight[i.severity], 0));
  return {
    score, grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D',
    duration: round(total), clipCount: rows.length,
    hook: curves && rows.length ? hookScore(clips, sources, 3, curves) : null,
    counts: { error: issues.filter(i => i.severity === 'error').length, warning: issues.filter(i => i.severity === 'warning').length, tip: issues.filter(i => i.severity === 'tip').length },
    issues,
    note: 'Measurable heuristics (motion, sound, black frames, timing). No judgment of story or taste; always watch the preview.',
  };
}

/** Compact, agent-friendly description of the timeline. */
export function describeTimeline({ clips, sources, options = {}, beats = [] }) {
  const curves = sources.some(s => s.motion?.length || s.audio?.length) ? curvesFor(sources) : null;
  const cues = mapCaptions(options.captions ?? [], clips, Number(options.captionOffset) || 0);
  return layout(clips).map(r => {
    const row = {
      index: r.index, id: r.id, label: r.label || undefined, sourceIndex: r.sourceIndex, source: sources[r.sourceIndex]?.name,
      sourceIn: round(r.start), sourceOut: round(r.end), timelineIn: round(r.timelineStart), timelineOut: round(r.timelineEnd), duration: round(r.duration),
      speed: r.speed ?? 1, gain: r.gain ?? 1,
    };
    if (r.framing === 'fill') Object.assign(row, { framing: 'fill', zoom: r.zoom, focusX: r.focusX, focusY: r.focusY });
    if (r.mirror) row.mirror = true;
    if (curves) {
      row.energy = Math.round(100 * clipEnergy(curves, r));
      const loud = meanRange(curves[r.sourceIndex].loudness, r.start, r.end);
      if (loud != null) row.loudnessDb = round(loud, 1);
      row.sceneCutsInside = (sources[r.sourceIndex].scenes ?? []).filter(t => t > r.start + 0.1 && t < r.end - 0.1).length;
      const room = sourceRoom(clips, r.index, sources);
      row.roomBefore = round(room.before, 2); row.roomAfter = round(room.after, 2);
    }
    const inside = cues.filter(c => c.start < r.timelineEnd && c.end > r.timelineStart).map(c => c.text);
    if (inside.length) row.captions = inside.slice(0, 6);
    if (beats.length) row.cutOffBeatMs = Math.round(1000 * Math.min(...beats.map(b => Math.abs(b - r.timelineEnd))));
    return row;
  });
}
