// Shared browser/engine edit operations. Pure functions: no DOM, no filesystem.
// The timeline is gapless: every clip follows the previous one, so trims ripple.
// Clips reference ORIGINAL source time; timeline time is derived.

// `captions` is one line per second of the longest edit: a viewer cannot read more
// than one cue per second, so a 20-minute edit (`editSeconds`) never needs more
// lines than it has seconds. It stays its own number because a caption is not a
// second — the two limits are equal today by that argument, not by accident.
export const LIMITS = Object.freeze({ clips: 200, editSeconds: 1200, captions: 1200, sources: 24, sourceSeconds: 7200, minSource: 0.5, minTimeline: 0.25, texts: 100, markers: 100, overlays: 50 });
export const CLIP_FIELDS = Object.freeze(['id', 'sourceIndex', 'start', 'end', 'speed', 'gain', 'framing', 'zoom', 'zoomEnd', 'focusX', 'focusY', 'focusXEnd', 'focusYEnd', 'mirror', 'label', 'audioShift',
  'transition', 'transitionSeconds', 'brightness', 'contrast', 'saturation', 'temperature', 'sharpen', 'denoise', 'stabilize']);
/** Transition INTO a clip from the previous one. Keys are FFmpeg xfade names (plus cut). */
export const TRANSITIONS = Object.freeze({
  cut: 'Cut', fade: 'Dissolve', fadeblack: 'Dip to black', fadewhite: 'Dip to white',
  wipeleft: 'Wipe left', wiperight: 'Wipe right', slideleft: 'Slide left', slideright: 'Slide right',
  circleopen: 'Circle open', smoothleft: 'Smooth wipe', pixelize: 'Pixelize', radial: 'Radial',
});
/** On-screen text in TIMELINE time (title cards, lower thirds). */
export const TEXT_STYLES = Object.freeze({ title: 'Title', lower: 'Lower third', big: 'Big & bold', note: 'Note', callout: 'Callout (subscribe, link…)' });
export const TEXT_POSITIONS = Object.freeze({ center: 'Center', low: 'Bottom', high: 'Top', 'left-low': 'Bottom left', 'left-high': 'Top left' });
export function normalizeText(value = {}, index = 0) {
  const start = Number(value.start), end = Number(value.end ?? start + 3);
  const text = String(value.text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start + 0.1 || end > LIMITS.editSeconds) throw new EditError(`Text ${index + 1}: invalid times.`, 'INVALID_TEXT');
  if (!text) throw new EditError(`Text ${index + 1}: text is missing.`, 'INVALID_TEXT');
  const style = value.style ?? 'title', position = value.position ?? (style === 'lower' ? 'left-low' : 'center');
  if (!TEXT_STYLES[style]) throw new EditError(`Text ${index + 1}: style must be ${Object.keys(TEXT_STYLES).join('/')}.`, 'INVALID_TEXT');
  if (!TEXT_POSITIONS[position]) throw new EditError(`Text ${index + 1}: position must be ${Object.keys(TEXT_POSITIONS).join('/')}.`, 'INVALID_TEXT');
  return { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text, style, position };
}
export function normalizeTexts(rows = []) {
  if (!Array.isArray(rows) || rows.length > LIMITS.texts) throw new EditError(`At most ${LIMITS.texts} texts.`, 'INVALID_TEXT');
  return rows.map(normalizeText).sort((a, b) => a.start - b.start);
}
/** Layers above the edit: B-roll cutaways (full) and picture-in-picture, in TIMELINE time. */
export const OVERLAY_MODES = Object.freeze({ full: 'B-roll (full frame)', pip: 'Picture-in-picture' });
export const OVERLAY_POSITIONS = Object.freeze({ 'top-right': 'Top right', 'top-left': 'Top left', 'bottom-right': 'Bottom right', 'bottom-left': 'Bottom left', center: 'Center' });
export function normalizeOverlay(value = {}, index = 0) {
  const n = (v, d, a, b, name) => { const x = v === undefined || v === '' ? d : Number(v); if (!Number.isFinite(x) || x < a || x > b) throw new EditError(`Overlay ${index + 1}: ${name} must be ${a}–${b}.`, 'INVALID_OVERLAY'); return Math.round(x * 1000) / 1000; };
  const sourceIndex = Number(value.sourceIndex);
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= LIMITS.sources) throw new EditError(`Overlay ${index + 1}: unknown source.`, 'INVALID_OVERLAY');
  const start = n(value.start, 0, 0, LIMITS.sourceSeconds, 'start'), end = n(value.end, start + 3, 0, LIMITS.sourceSeconds, 'end');
  if (end - start < LIMITS.minSource) throw new EditError(`Overlay ${index + 1}: at least ${LIMITS.minSource} s.`, 'INVALID_OVERLAY');
  const mode = value.mode ?? 'full', position = value.position ?? 'top-right';
  if (!OVERLAY_MODES[mode]) throw new EditError(`Overlay ${index + 1}: mode full or pip.`, 'INVALID_OVERLAY');
  if (!OVERLAY_POSITIONS[position]) throw new EditError(`Overlay ${index + 1}: position ${Object.keys(OVERLAY_POSITIONS).join('/')}.`, 'INVALID_OVERLAY');
  return { sourceIndex, start, end, at: n(value.at, 0, 0, LIMITS.editSeconds, 'at'), mode, position, size: n(value.size, 0.32, 0.15, 0.7, 'size'),
    gain: n(value.gain, 0, 0, 2, 'gain'), fade: n(value.fade, mode === 'full' ? 0 : 0.2, 0, 1, 'fade') };
}
export function normalizeOverlays(rows = []) {
  if (!Array.isArray(rows) || rows.length > LIMITS.overlays) throw new EditError(`At most ${LIMITS.overlays} overlays.`, 'INVALID_OVERLAY');
  return rows.map(normalizeOverlay).sort((a, b) => a.at - b.at);
}
/** Sections (chapters) of a long edit: each starts at an anchor clip id, so they survive reorders and trims. */
export function normalizeSections(rows = []) {
  if (!Array.isArray(rows) || rows.length > 60) throw new EditError('At most 60 sections.', 'INVALID_SECTION');
  const seen = new Set(), anchors = new Map();
  return rows.map((r, i) => {
    const name = String(r?.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const clip = String(r?.clip ?? '');
    if (!name) throw new EditError(`Section ${i + 1}: name is missing.`, 'INVALID_SECTION');
    if (!/^[a-z0-9]{1,24}$/.test(clip)) throw new EditError(`Section ${i + 1}: anchor clip id is invalid.`, 'INVALID_SECTION');
    if (seen.has(name.toLowerCase())) throw new EditError(`Section names must be unique ("${name}").`, 'INVALID_SECTION');
    // A shot starts one section: two on the same shot leave the first one without any shots (#138).
    if (anchors.has(clip)) throw new EditError(`Sections "${anchors.get(clip)}" and "${name}" both start at shot ${clip}. A shot can start only one section.`, 'INVALID_SECTION');
    seen.add(name.toLowerCase()); anchors.set(clip, name);
    return { name, clip, ...(r.color ? { color: ['yellow', 'red', 'green', 'blue', 'purple'].includes(r.color) ? r.color : 'yellow' } : {}) };
  });
}
/** Sections saved before two on one shot were refused: the last one on a shot wins, the order stays (#138). */
export function oneSectionPerShot(sections = []) {
  const last = new Map(sections.map((s, i) => [s?.clip, i]));
  return sections.filter((s, i) => last.get(s?.clip) === i);
}
/**
 * Section proposals for an edit: labelled markers, else every change of recording, else (or when that
 * gives fewer than two) a cut about every two minutes. Never two proposals on one shot.
 */
export function suggestSections(clips = [], { markers = [], sources = [] } = {}) {
  const rows = layout(clips), proposals = [];
  const add = (name, r) => { if (!proposals.some(p => p.clip === r.id)) proposals.push({ name: name.slice(0, 60), clip: r.id, at: Math.round(r.visibleStart * 10) / 10 }); };
  for (const m of markers.filter(m => m.label)) { const r = rows.find(x => x.visibleEnd > m.time); if (r) add(m.label, r); }
  if (!proposals.length) rows.forEach((r, i) => { if (!i || r.sourceIndex !== rows[i - 1].sourceIndex) add(`Part ${proposals.length + 1} · ${sources[r.sourceIndex]?.name ?? ''}`, r); });
  if (proposals.length < 2) {
    let next = 0;
    for (const r of rows) if (r.visibleStart >= next) { add(`Part ${proposals.length + 1}`, r); next = r.visibleStart + 120; }
  }
  return proposals.slice(0, 30);
}
/** Sections with their current timeline span and clip ids, in timeline order (anchors that no longer exist drop out). */
export function sectionSpans(clips, sections = []) {
  const rows = layout(clips);
  const anchored = oneSectionPerShot(sections).map(s => ({ ...s, index: clips.findIndex(c => c.id === s.clip) })).filter(s => s.index >= 0).sort((a, b) => a.index - b.index);
  return anchored.map((s, k) => {
    const endIndex = (anchored[k + 1]?.index ?? clips.length) - 1;
    const first = rows[s.index], last = rows[endIndex];
    return { name: s.name, clip: s.clip, color: s.color, startIndex: s.index, endIndex, clipIds: clips.slice(s.index, endIndex + 1).map(c => c.id),
      start: round(first.visibleStart), end: round(last.visibleEnd), duration: round(last.visibleEnd - first.visibleStart) };
  });
}
export const COLOR_DEFAULTS = Object.freeze({ brightness: 0, contrast: 1, saturation: 1, temperature: 0, sharpen: 0, denoise: false });
const EPS = 0.001;

export class EditError extends Error {
  constructor(message, code = 'INVALID_OPERATION') { super(message); this.code = code; }
}

let counter = 0;
export function newClipId() {
  counter = (counter + 1) % 1296;
  return `c${Date.now().toString(36).slice(-4)}${counter.toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 5)}`;
}
const round = n => Math.round(n * 1000) / 1000;
/** Second half of a split: fresh id, no label and no transition (it continues the same footage). */
function tailOf(clip, start) { const { transition, transitionSeconds, ...rest } = clip; return { ...rest, id: newClipId(), start: round(start), label: '' }; }

/** Strip derived fields so a clip can be posted back to the engine. */
export function coreClip(clip) {
  const row = {};
  for (const key of CLIP_FIELDS) if (clip[key] !== undefined && clip[key] !== '') row[key] = clip[key];
  row.speed ??= 1; row.gain ??= 1;
  if (!row.transition || row.transition === 'cut') { delete row.transition; delete row.transitionSeconds; }
  for (const [k, d] of Object.entries(COLOR_DEFAULTS)) if (row[k] === d) delete row[k];
  if (row.zoomEnd !== undefined && row.zoomEnd === (row.zoom ?? 1)) delete row.zoomEnd;
  if (row.focusXEnd !== undefined && row.focusXEnd === (row.focusX ?? 0.5)) delete row.focusXEnd;
  if (row.focusYEnd !== undefined && row.focusYEnd === (row.focusY ?? 0.5)) delete row.focusYEnd;
  if (row.framing === 'fit' || !row.framing) { delete row.framing; delete row.zoomEnd; delete row.focusXEnd; delete row.focusYEnd; if (row.zoom === 1) delete row.zoom; if (row.focusX === 0.5) delete row.focusX; if (row.focusY === 0.5) delete row.focusY; }
  if (row.mirror === false) delete row.mirror;
  if (!row.audioShift) delete row.audioShift;
  if (!row.stabilize) delete row.stabilize;
  return row;
}
export function coreClips(clips = []) { return clips.map(coreClip); }

export function clipDuration(clip) { return (clip.end - clip.start) / (clip.speed || 1); }
/** Seconds the clip overlaps the previous one for its transition (0 for a cut or the first clip). */
export function overlapOf(previous, clip) {
  if (!previous || !clip || !clip.transition || clip.transition === 'cut' || !TRANSITIONS[clip.transition]) return 0;
  const wanted = Number(clip.transitionSeconds) || 0.5;
  const limit = Math.min(clipDuration(previous), clipDuration(clip)) / 2;
  return Math.max(0, Math.min(wanted, Math.round(limit * 1000) / 1000));
}
export function totalDuration(clips = []) { return clips.reduce((sum, c, i) => sum + clipDuration(c) - overlapOf(clips[i - 1], c), 0); }

/**
 * Adds timelineStart/timelineEnd/duration/overlapIn/overlapOut without mutating input.
 * With a transition a clip starts overlapIn seconds before the previous one ends;
 * visibleStart/visibleEnd mark the midpoint of each overlap (where the cut "feels").
 */
export function layout(clips = []) {
  let t = 0;
  const rows = clips.map((clip, index) => {
    const duration = clipDuration(clip);
    const overlapIn = overlapOf(clips[index - 1], clip);
    t -= overlapIn;
    const row = { ...clip, index, timelineStart: t, timelineEnd: t + duration, duration, overlapIn, overlapOut: 0 };
    t += duration;
    return row;
  });
  rows.forEach((r, i) => { r.overlapOut = rows[i + 1]?.overlapIn ?? 0; r.visibleStart = r.timelineStart + r.overlapIn / 2; r.visibleEnd = r.timelineEnd - r.overlapOut / 2; });
  return rows;
}

/** Clip under a timeline time. At an exact edit point, returns the clip that starts there. */
export function clipAt(clips, time) {
  const rows = layout(clips);
  if (!rows.length) return null;
  const t = Math.max(0, Math.min(time, rows.at(-1).timelineEnd - EPS));
  const row = rows.find(r => t >= r.visibleStart - EPS && t < r.visibleEnd - EPS) ?? rows.at(-1);
  const offset = Math.max(0, t - row.timelineStart);
  return { index: row.index, clip: clips[row.index], offset: Math.max(0, t - row.visibleStart), sourceTime: row.start + offset * (row.speed || 1), timelineStart: row.timelineStart };
}

/** Edit points (cut times) on the timeline, including 0 and the end. */
export function editPoints(clips) {
  const rows = layout(clips);
  return [0, ...rows.map(r => r.visibleEnd)];
}

/** Map a source time to timeline time (first occurrence), or null when unused. */
export function sourceToTimeline(clips, sourceIndex, time) {
  for (const r of layout(clips)) {
    if (r.sourceIndex === sourceIndex && time >= r.start - EPS && time <= r.end + EPS) return r.timelineStart + (time - r.start) / (r.speed || 1);
  }
  return null;
}

function resolveIndex(clips, ref, name = 'clip') {
  if (typeof ref === 'string') {
    const index = clips.findIndex(c => c.id === ref);
    if (index < 0) throw new EditError(`Clip id ${ref} does not exist (anymore).`, 'CLIP_NOT_FOUND');
    return index;
  }
  if (!Number.isInteger(ref) || ref < 0 || ref >= clips.length) throw new EditError(`${name}: use a clip index 0–${clips.length - 1} or a clip id.`, 'CLIP_NOT_FOUND');
  return ref;
}

function num(value, name, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new EditError(`${name}: invalid value ${value}.`);
  return n;
}

/** Structural checks shared by UI and engine (engine still runs full validation). */
export function checkClips(clips, sources) {
  if (!clips.length) throw new EditError('An edit needs at least one clip.', 'EMPTY_PLAN');
  if (clips.length > LIMITS.clips) throw new EditError(`At most ${LIMITS.clips} clips.`, 'TOO_MANY_CLIPS');
  clips.forEach((c, i) => {
    const source = sources?.[c.sourceIndex];
    if (sources && !source) throw new EditError(`Clip ${i + 1}: unknown source.`, 'INVALID_CLIP');
    if (c.start < -EPS || (source && c.end > source.duration + EPS) || c.end - c.start < LIMITS.minSource - EPS) {
      throw new EditError(`Clip ${i + 1}: start/end outside the source or shorter than ${LIMITS.minSource} s.`, 'INVALID_CLIP');
    }
  });
  for (let i = 0; i < clips.length; i++) for (let j = i + 1; j < clips.length; j++) {
    const a = clips[i], b = clips[j];
    if (a.sourceIndex === b.sourceIndex && Math.min(a.end, b.end) - Math.max(a.start, b.start) > EPS) {
      throw new EditError(`Clips ${i + 1} and ${j + 1} use the same footage.`, 'OVERLAPPING_CLIPS');
    }
  }
  if (totalDuration(clips) > LIMITS.editSeconds + 0.05) throw new EditError(`Edit longer than ${LIMITS.editSeconds} s.`, 'TOO_LONG');
  return true;
}

/** Room around a clip in its source before touching other used ranges. */
export function sourceRoom(clips, index, sources) {
  const clip = clips[index];
  const duration = sources?.[clip.sourceIndex]?.duration ?? Infinity;
  let before = clip.start, after = duration - clip.end;
  clips.forEach((other, i) => {
    if (i === index || other.sourceIndex !== clip.sourceIndex) return;
    if (other.end <= clip.start + EPS) before = Math.min(before, clip.start - other.end);
    if (other.start >= clip.end - EPS) after = Math.min(after, other.start - clip.end);
  });
  return { before: Math.max(0, before), after: Math.max(0, after) };
}

/** Unused intervals of one source, for "add footage" and the source browser. */
export function unusedRanges(clips, sourceIndex, duration, minimum = LIMITS.minSource) {
  const used = clips.filter(c => c.sourceIndex === sourceIndex).sort((a, b) => a.start - b.start);
  const free = []; let cursor = 0;
  for (const c of used) { if (c.start - cursor >= minimum) free.push([cursor, c.start]); cursor = Math.max(cursor, c.end); }
  if (duration - cursor >= minimum) free.push([cursor, duration]);
  return free;
}

const SETTABLE = {
  speed: v => num(v, 'speed', 0.5, 2), gain: v => num(v, 'gain', 0, 2),
  framing: v => { if (!['fit', 'fill'].includes(v)) throw new EditError('framing: fit or fill.'); return v; },
  zoom: v => num(v, 'zoom', 1, 2), zoomEnd: v => num(v, 'zoomEnd', 1, 2), focusX: v => num(v, 'focusX', 0, 1), focusY: v => num(v, 'focusY', 0, 1),
  focusXEnd: v => num(v, 'focusXEnd', 0, 1), focusYEnd: v => num(v, 'focusYEnd', 0, 1),
  audioShift: v => num(v, 'audioShift', -2, 2),
  mirror: v => { if (typeof v !== 'boolean') throw new EditError('mirror: true/false.'); return v; },
  label: v => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60),
  transition: v => { if (!TRANSITIONS[v]) throw new EditError(`transition: choose ${Object.keys(TRANSITIONS).join(', ')}.`); return v; },
  transitionSeconds: v => num(v, 'transitionSeconds', 0.1, 3),
  brightness: v => num(v, 'brightness', -0.3, 0.3), contrast: v => num(v, 'contrast', 0.5, 1.5), saturation: v => num(v, 'saturation', 0, 2),
  temperature: v => num(v, 'temperature', -1, 1), sharpen: v => num(v, 'sharpen', 0, 1),
  denoise: v => { if (typeof v !== 'boolean') throw new EditError('denoise: true/false.'); return v; },
  stabilize: v => num(v, 'stabilize', 0, 1),
};
function applyProps(clip, props) {
  const next = { ...clip };
  for (const [key, value] of Object.entries(props)) {
    if (!SETTABLE[key]) continue;
    next[key] = SETTABLE[key](value);
  }
  if ((props.zoom !== undefined && next.zoom > 1) || (props.zoomEnd !== undefined && next.zoomEnd > 1)) next.framing = 'fill';
  if (props.focusXEnd !== undefined || props.focusYEnd !== undefined) next.framing = 'fill';
  if (props.framing === 'fit') { next.zoom = 1; delete next.zoomEnd; delete next.focusXEnd; delete next.focusYEnd; }
  if (next.zoomEnd !== undefined && next.zoomEnd === (next.zoom ?? 1)) delete next.zoomEnd;
  if (next.focusXEnd !== undefined && next.focusXEnd === (next.focusX ?? 0.5)) delete next.focusXEnd;
  if (next.focusYEnd !== undefined && next.focusYEnd === (next.focusY ?? 0.5)) delete next.focusYEnd;
  if (next.transition === 'cut') { delete next.transition; delete next.transitionSeconds; }
  for (const [k, d] of Object.entries(COLOR_DEFAULTS)) if (next[k] === d) delete next[k];
  if (next.audioShift === 0) delete next.audioShift;
  if (next.stabilize === 0) delete next.stabilize;
  return next;
}

/** Snap a timeline cut point to beats: returns new clips with adjusted out-points. */
export function beatSync(clips, beats, { every = 1, maxShift = 0.35, sources, protectLast = false, mode = 'nearest' } = {}) {
  if (!Array.isArray(beats) || beats.length < 2) throw new EditError('Analyze the beat of your music first.', 'BEATS_REQUIRED');
  const grid = beats.filter((_, i) => i % Math.max(1, every) === 0);
  let rows = clips.map(c => ({ ...c }));
  let moved = 0, total = 0;
  const lastCut = protectLast ? rows.length - 1 : rows.length; // the final clip end is left alone when protected
  for (let i = 0; i < lastCut; i++) {
    const at = layout(rows)[i];
    const cut = at.visibleEnd;
    const speed = rows[i].speed || 1;
    const room = sourceRoom(rows, i, sources);
    const candidates = grid
      .map(b => ({ b, shift: b - cut }))
      .filter(({ shift }) => Math.abs(shift) <= maxShift && (mode !== 'shorten' || shift <= 0))
      .filter(({ shift }) => {
        const delta = shift * speed;
        const end = rows[i].end + delta;
        return end - rows[i].start >= LIMITS.minSource && (delta <= 0 || delta <= room.after + EPS);
      })
      .sort((a, b) => Math.abs(a.shift) - Math.abs(b.shift));
    if (!candidates.length) continue;
    const { shift } = candidates[0];
    if (Math.abs(shift) < 0.005) continue;
    rows[i] = { ...rows[i], end: round(rows[i].end + shift * speed) };
    moved++; total += Math.abs(shift);
  }
  return { clips: rows, moved, averageShift: moved ? round(total / moved) : 0 };
}

/**
 * Apply one operation to {clips, options}. Throws EditError on invalid input.
 * Returns a new state; the input is never mutated.
 */
export function applyOperation(state, operation, context = {}) {
  const { sources } = context;
  let clips = state.clips.map(c => ({ ...c }));
  let options = { ...state.options };
  const op = operation?.op;
  const at = ref => resolveIndex(clips, ref);
  switch (op) {
    case 'split': {
      let index, cut;
      if (operation.clip !== undefined) {
        index = at(operation.clip);
        cut = num(operation.sourceTime, 'sourceTime');
      } else {
        const hit = clipAt(clips, num(operation.at, 'at', 0));
        if (!hit) throw new EditError('No clip at this point.');
        index = hit.index; cut = hit.sourceTime;
      }
      const c = clips[index];
      if (cut - c.start < LIMITS.minSource - EPS || c.end - cut < LIMITS.minSource - EPS) throw new EditError(`Cut point must be at least ${LIMITS.minSource} s from the start and end.`, 'SPLIT_TOO_CLOSE');
      if (clips.length >= LIMITS.clips) throw new EditError(`At most ${LIMITS.clips} clips.`, 'TOO_MANY_CLIPS');
      clips.splice(index, 1, { ...c, end: round(cut) }, tailOf(c, cut));
      break;
    }
    case 'delete': {
      const refs = Array.isArray(operation.clips) ? operation.clips : [operation.clip];
      const indices = [...new Set(refs.map(at))].sort((a, b) => b - a);
      if (indices.length >= clips.length) throw new EditError('An edit needs at least one clip.', 'EMPTY_PLAN');
      for (const i of indices) clips.splice(i, 1);
      break;
    }
    case 'delete_range': {
      const from = num(operation.from, 'from', 0), to = num(operation.to, 'to', 0);
      if (to - from < 0.05) throw new EditError('Range is too short.');
      const next = [];
      for (const r of layout(clips)) {
        if (r.timelineEnd <= from + EPS || r.timelineStart >= to - EPS) { next.push(clips[r.index]); continue; }
        const s = r.speed || 1;
        const cutA = r.start + Math.max(0, from - r.timelineStart) * s;
        const cutB = r.start + Math.min(r.duration, to - r.timelineStart) * s;
        if (cutA - r.start >= LIMITS.minSource - EPS) next.push({ ...clips[r.index], end: round(cutA) });
        if (r.end - cutB >= LIMITS.minSource - EPS) next.push(cutA - r.start >= LIMITS.minSource - EPS ? tailOf(clips[r.index], cutB) : { ...clips[r.index], start: round(cutB) });
      }
      if (!next.length) throw new EditError('This would remove the entire edit.', 'EMPTY_PLAN');
      clips = next;
      break;
    }
    case 'remove_ranges': {
      // Text-based editing: cut source ranges (e.g. removed words, fillers, pauses) out of every clip of one source.
      const sourceIndex = num(operation.sourceIndex, 'sourceIndex', 0, LIMITS.sources - 1);
      if (!Array.isArray(operation.ranges) || !operation.ranges.length || operation.ranges.length > 2000) throw new EditError('remove_ranges: give 1 to 2000 ranges.');
      const ranges = mergeRanges(operation.ranges.map((r, i) => {
        const a = num(r?.start, `ranges[${i}].start`, 0), b = num(r?.end, `ranges[${i}].end`, 0);
        if (b <= a) throw new EditError(`ranges[${i}]: end must be after start.`);
        return { start: a, end: b };
      }));
      const minPiece = operation.minPiece === undefined ? LIMITS.minSource : num(operation.minPiece, 'minPiece', LIMITS.minSource, 10);
      const smooth = operation.smooth === true;
      const next = [];
      for (const c of clips) {
        if (c.sourceIndex !== sourceIndex) { next.push(c); continue; }
        const pieces = subtractRanges(c.start, c.end, ranges).filter(([a, b]) => b - a >= minPiece - EPS);
        pieces.forEach(([a, b], k) => {
          if (k === 0) next.push({ ...c, start: round(a), end: round(b) });
          else next.push({ ...tailOf(c, a), end: round(b), ...(smooth ? { transition: 'fade', transitionSeconds: 0.12 } : {}) });
        });
      }
      if (!next.length) throw new EditError('This would remove the entire edit.', 'EMPTY_PLAN');
      if (next.length > LIMITS.clips) throw new EditError(`This would create more than ${LIMITS.clips} clips; remove fewer ranges at once.`, 'TOO_MANY_CLIPS');
      clips = next;
      break;
    }
    case 'speed_ranges': {
      // Speed up source ranges (pauses, dead air) instead of cutting them: the shot is split at the range edges.
      const sourceIndex = num(operation.sourceIndex, 'sourceIndex', 0, LIMITS.sources - 1);
      const speed = num(operation.speed ?? 2, 'speed', 1.05, 2);
      if (!Array.isArray(operation.ranges) || !operation.ranges.length || operation.ranges.length > 2000) throw new EditError('speed_ranges: give 1 to 2000 ranges.');
      const ranges = mergeRanges(operation.ranges.map((r, i) => ({ start: num(r?.start, `ranges[${i}].start`, 0), end: num(r?.end, `ranges[${i}].end`, 0) })));
      const next = [];
      for (const c of clips) {
        if (c.sourceIndex !== sourceIndex) { next.push(c); continue; }
        // Ranges inside the shot that leave every piece at least the minimum length (others are left alone).
        const cuts = [];
        for (const r of ranges) {
          const a = Math.max(c.start, r.start), b = Math.min(c.end, r.end), min = LIMITS.minSource - EPS;
          if (b - a < min) continue;
          const before = a - (cuts.at(-1) ?? c.start), after = c.end - b;
          if ((before > EPS && before < min) || (after > EPS && after < min)) continue;
          if (before > EPS) cuts.push(round(a));
          if (after > EPS) cuts.push(round(b));
        }
        const edges = [c.start, ...cuts, c.end];
        edges.slice(0, -1).forEach((a, k) => {
          const b = edges[k + 1], mid = (a + b) / 2;
          let piece = k ? { ...tailOf(c, a), end: round(b) } : { ...c, end: round(b) };
          if (ranges.some(r => mid > r.start && mid < r.end)) piece = applyProps(piece, { speed: Math.min(2, (c.speed || 1) * speed) });
          next.push(piece);
        });
      }
      if (next.length > LIMITS.clips) throw new EditError(`This would create more than ${LIMITS.clips} clips.`, 'TOO_MANY_CLIPS');
      clips = next;
      break;
    }
    case 'move': {
      const from = at(operation.clip);
      const to = num(operation.to, 'to', 0, clips.length - 1);
      if (!Number.isInteger(to)) throw new EditError('to: use a whole-number index.');
      const [c] = clips.splice(from, 1); clips.splice(to, 0, c);
      break;
    }
    case 'swap': {
      const a = at(operation.a), b = at(operation.b);
      [clips[a], clips[b]] = [clips[b], clips[a]];
      break;
    }
    case 'trim': {
      const i = at(operation.clip); const c = clips[i];
      let start = c.start, end = c.end;
      if (operation.start !== undefined) start = num(operation.start, 'start', 0);
      if (operation.end !== undefined) end = num(operation.end, 'end', 0);
      if (operation.startDelta !== undefined) start += num(operation.startDelta, 'startDelta');
      if (operation.endDelta !== undefined) end += num(operation.endDelta, 'endDelta');
      if (operation.duration !== undefined) end = start + num(operation.duration, 'duration', LIMITS.minTimeline) * (c.speed || 1);
      clips[i] = { ...c, start: round(start), end: round(end) };
      break;
    }
    case 'trim_to': {
      // Q / W: ripple-trim the clip under the playhead to the playhead.
      const hit = clipAt(clips, num(operation.at, 'at', 0));
      if (!hit) throw new EditError('No clip under the playhead.');
      const c = clips[hit.index];
      if (hit.offset < 0.02) throw new EditError('The playhead is on a cut; place it inside a shot to trim.', 'NOTHING_TO_TRIM');
      if (operation.side === 'start') clips[hit.index] = { ...c, start: round(hit.sourceTime) };
      else if (operation.side === 'end') clips[hit.index] = { ...c, end: round(hit.sourceTime) };
      else throw new EditError('side: start or end.');
      break;
    }
    case 'slip': {
      const i = at(operation.clip); const c = clips[i]; const by = num(operation.by, 'by', -LIMITS.sourceSeconds, LIMITS.sourceSeconds);
      clips[i] = { ...c, start: round(c.start + by), end: round(c.end + by) };
      break;
    }
    case 'insert': {
      const row = { id: newClipId(), sourceIndex: num(operation.sourceIndex, 'sourceIndex', 0, LIMITS.sources - 1), start: round(num(operation.start, 'start', 0)), end: round(num(operation.end, 'end', 0)), speed: 1, gain: 1 };
      Object.assign(row, applyProps(row, operation));
      let index = clips.length;
      if (operation.index !== undefined) index = num(operation.index, 'index', 0, clips.length);
      else if (operation.at !== undefined) {
        const t = num(operation.at, 'at', 0);
        const hit = clipAt(clips, t);
        if (hit && t < totalDuration(clips) - EPS) {
          const c = clips[hit.index];
          if (hit.sourceTime - c.start >= LIMITS.minSource && c.end - hit.sourceTime >= LIMITS.minSource) {
            clips.splice(hit.index, 1, { ...c, end: round(hit.sourceTime) }, tailOf(c, hit.sourceTime));
            index = hit.index + 1;
          } else index = hit.sourceTime - c.start < (c.end - c.start) / 2 ? hit.index : hit.index + 1;
        }
      }
      clips.splice(index, 0, row);
      break;
    }
    case 'set': {
      const refs = operation.clip === 'all' || operation.clips === 'all' ? 'all' : operation.clips ?? (operation.clip === undefined ? null : [operation.clip]);
      if (refs === null) throw new EditError("set: provide clip, clips or clip: 'all'.");
      const { op: _op, clip: _c, clips: _cs, ...props } = operation;
      if (!Object.keys(props).some(k => SETTABLE[k])) throw new EditError('set: no property to change (speed, gain, framing, zoom, focusX, focusY, mirror, label).');
      const targets = refs === 'all' ? clips.map((_, i) => i) : refs.map(at);
      for (const i of targets) clips[i] = applyProps(clips[i], props);
      break;
    }
    case 'replace': {
      if (!Array.isArray(operation.clips)) throw new EditError('replace: clips is missing.');
      clips = operation.clips.map(c => ({ id: c.id || newClipId(), ...coreClip(c) }));
      break;
    }
    case 'beat_sync': {
      const beats = operation.beats ?? context.beats;
      const result = beatSync(clips, beats, { every: operation.every ?? 1, maxShift: operation.maxShift ?? 0.35, sources, mode: operation.mode ?? 'nearest', protectLast: Boolean(options.finaleSeconds) });
      clips = result.clips;
      break;
    }
    case 'set_options': {
      const patch = operation.options;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new EditError('set_options: options is missing.');
      options = { ...options, ...patch };
      break;
    }
    case 'move_block': {
      // Move a set of clips (kept in their current order) before another clip, or to the end.
      const ids = new Set((operation.clips ?? []).map(ref => clips[at(ref)].id));
      if (!ids.size) throw new EditError('move_block: give clips.');
      if (operation.before !== undefined && operation.before !== null && ids.has(clips[at(operation.before)].id)) throw new EditError('move_block: "before" cannot be inside the block.');
      const block = clips.filter(c => ids.has(c.id)), rest = clips.filter(c => !ids.has(c.id));
      const target = operation.before === undefined || operation.before === null ? rest.length : rest.findIndex(c => c.id === clips[at(operation.before)].id);
      clips = [...rest.slice(0, target), ...block, ...rest.slice(target)];
      break;
    }
    case 'add_overlay': {
      const overlays = [...(options.overlays ?? [])];
      if (overlays.length >= LIMITS.overlays) throw new EditError(`At most ${LIMITS.overlays} overlays.`);
      const { op: _o, ...fields } = operation;
      overlays.push(normalizeOverlay(fields, overlays.length));
      if (sources && !sources[overlays.at(-1).sourceIndex]) throw new EditError('Overlay: unknown source.', 'INVALID_OVERLAY');
      if (sources && overlays.at(-1).end > sources[overlays.at(-1).sourceIndex].duration + EPS) throw new EditError('Overlay: end is beyond the source.', 'INVALID_OVERLAY');
      options.overlays = overlays.sort((a, b) => a.at - b.at);
      break;
    }
    case 'update_overlay': {
      const overlays = [...(options.overlays ?? [])];
      const i = num(operation.index, 'index', 0, overlays.length - 1);
      const { op: _o, index: _i, ...patch } = operation;
      overlays[i] = normalizeOverlay({ ...overlays[i], ...patch }, i);
      options.overlays = overlays.sort((a, b) => a.at - b.at);
      break;
    }
    case 'remove_overlay': {
      const overlays = [...(options.overlays ?? [])];
      overlays.splice(num(operation.index, 'index', 0, overlays.length - 1), 1); options.overlays = overlays;
      break;
    }
    case 'punch_in': {
      // Jump-zoom style: split shots at beats (or every N s) and alternate a tighter crop.
      const refs = operation.clip === 'all' || operation.clips === 'all' || (operation.clip === undefined && operation.clips === undefined) ? clips.map((_, i) => i) : (operation.clips ?? [operation.clip]).map(at);
      const zoom = num(operation.zoom ?? 1.15, 'zoom', 1.02, 1.6);
      const times = Array.isArray(operation.times) ? operation.times.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : null;
      const every = times ? null : operation.seconds !== undefined ? num(operation.seconds, 'seconds', 0.8, 30) : null;
      const beats = every || times ? null : (operation.beats ?? context.beats ?? []);
      if (!every && !times && beats.length < 2) throw new EditError('punch_in: give seconds or times, or analyze the music beat first.', 'BEATS_REQUIRED');
      const focus = {};
      if (operation.focusX !== undefined) focus.focusX = num(operation.focusX, 'focusX', 0, 1);
      if (operation.focusY !== undefined) focus.focusY = num(operation.focusY, 'focusY', 0, 1);
      const ids = new Set(refs.map(i => clips[i].id));
      const rows = layout(clips), next = [];
      for (const r of rows) {
        const c = clips[r.index];
        if (!ids.has(c.id)) { next.push(c); continue; }
        const s = r.speed || 1, cuts = [];
        const marks = times ? times.filter(t => t > r.timelineStart && t < r.timelineEnd) : every ? Array.from({ length: Math.floor(r.duration / every) }, (_, k) => r.timelineStart + (k + 1) * every) : beats.filter((b, k) => k % Math.max(1, operation.every ?? 2) === 0);
        for (const t of marks) { const src = r.start + (t - r.timelineStart) * s; if (src - (cuts.at(-1) ?? r.start) >= Math.max(LIMITS.minSource, 0.8) && r.end - src >= Math.max(LIMITS.minSource, 0.8)) cuts.push(round(src)); }
        const edges = [r.start, ...cuts, r.end];
        edges.slice(0, -1).forEach((a, k) => {
          const piece = k ? { ...tailOf(c, a), end: round(edges[k + 1]) } : { ...c, end: round(edges[1]) };
          next.push(k % 2 ? applyProps(piece, { zoom, framing: 'fill', ...focus }) : piece);
        });
      }
      if (next.length > LIMITS.clips) throw new EditError(`This would create more than ${LIMITS.clips} clips.`, 'TOO_MANY_CLIPS');
      clips = next;
      break;
    }
    case 'speed_ramp': {
      // Stepped speed ramp: the shot is split in N parts whose speed moves from → to.
      const i = at(operation.clip), c = clips[i];
      const from = num(operation.from ?? 1, 'from', 0.5, 2), to = num(operation.to ?? 0.5, 'to', 0.5, 2), steps = num(operation.steps ?? 4, 'steps', 2, 8);
      if (!Number.isInteger(steps)) throw new EditError('steps: whole number 2–8.');
      const len = (c.end - c.start) / steps;
      if (len < LIMITS.minSource) throw new EditError(`Shot too short for ${steps} steps.`, 'SPLIT_TOO_CLOSE');
      const parts = Array.from({ length: steps }, (_, k) => {
        const piece = k ? { ...tailOf(c, c.start + k * len), end: round(c.start + (k + 1) * len) } : { ...c, end: round(c.start + len) };
        return { ...piece, speed: round(from + (to - from) * (steps === 1 ? 1 : k / (steps - 1))) };
      });
      parts.at(-1).end = c.end;
      clips.splice(i, 1, ...parts);
      if (clips.length > LIMITS.clips) throw new EditError(`At most ${LIMITS.clips} clips.`, 'TOO_MANY_CLIPS');
      break;
    }
    case 'add_marker': {
      const markers = [...(options.markers ?? [])];
      if (markers.length >= LIMITS.markers) throw new EditError(`At most ${LIMITS.markers} markers.`);
      markers.push({ time: round(num(operation.time, 'time', 0, LIMITS.editSeconds)), label: SETTABLE.label(operation.label ?? '') , color: ['yellow', 'red', 'green', 'blue'].includes(operation.color) ? operation.color : 'yellow' });
      options.markers = markers.sort((a, b) => a.time - b.time);
      break;
    }
    case 'add_text': {
      const texts = [...(options.texts ?? [])];
      if (texts.length >= LIMITS.texts) throw new EditError(`At most ${LIMITS.texts} texts.`);
      texts.push(normalizeText(operation, texts.length));
      options.texts = texts.sort((a, b) => a.start - b.start);
      break;
    }
    case 'update_text': {
      const texts = [...(options.texts ?? [])];
      const i = num(operation.index, 'index', 0, texts.length - 1);
      const { op: _o, index: _i, ...patch } = operation;
      texts[i] = normalizeText({ ...texts[i], ...patch }, i);
      options.texts = texts.sort((a, b) => a.start - b.start);
      break;
    }
    case 'remove_text': {
      const texts = [...(options.texts ?? [])];
      const i = num(operation.index, 'index', 0, texts.length - 1);
      texts.splice(i, 1); options.texts = texts;
      break;
    }
    case 'remove_marker': {
      const markers = [...(options.markers ?? [])];
      const i = num(operation.index, 'index', 0, markers.length - 1);
      markers.splice(i, 1); options.markers = markers;
      break;
    }
    default:
      throw new EditError(`Unknown operation: ${op}. Use split, delete, delete_range, remove_ranges, speed_ranges, move_block, punch_in, speed_ramp, add_overlay, update_overlay, remove_overlay, move, swap, trim, trim_to, slip, insert, set, replace, beat_sync, set_options, add_marker, remove_marker, add_text, update_text or remove_text.`, 'UNKNOWN_OPERATION');
  }
  checkClips(clips, sources);
  return { clips, options };
}

/** Sort and merge overlapping/touching {start,end} ranges. */
export function mergeRanges(ranges, join = 0.02) {
  const sorted = ranges.filter(r => r && r.end > r.start).map(r => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) { const last = out.at(-1); if (last && r.start <= last.end + join) last.end = Math.max(last.end, r.end); else out.push(r); }
  return out;
}
/** [start,end] minus merged ranges → remaining pieces. */
export function subtractRanges(start, end, ranges) {
  const pieces = []; let cursor = start;
  for (const r of ranges) {
    if (r.end <= cursor || r.start >= end) continue;
    if (r.start > cursor) pieces.push([cursor, Math.min(r.start, end)]);
    cursor = Math.max(cursor, r.end);
    if (cursor >= end) break;
  }
  if (cursor < end) pieces.push([cursor, end]);
  return pieces;
}

/** Apply a batch atomically. Errors name the failing operation. */
export function applyOperations(state, operations, context = {}) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 100) throw new EditError('Provide 1 to 100 operations.');
  let next = { clips: state.clips.map(c => ({ ...c })), options: { ...state.options } };
  operations.forEach((operation, i) => {
    try { next = applyOperation(next, operation, context); }
    catch (e) { const err = new EditError(`Operation ${i + 1} (${operation?.op ?? '?'}): ${e.message}`, e.code); throw err; }
  });
  // Sections whose first shot was deleted move to the next surviving shot (in the original order); none left → dropped.
  if (next.options.sections?.length) {
    const alive = new Set(next.clips.map(c => c.id)), order = state.clips.map(c => c.id);
    const used = new Set(next.options.sections.filter(s => alive.has(s.clip)).map(s => s.clip));
    next.options.sections = next.options.sections.map(s => {
      if (alive.has(s.clip)) return s;
      const from = order.indexOf(s.clip);
      const clip = from < 0 ? null : order.slice(from + 1).find(id => alive.has(id));
      if (!clip || used.has(clip)) return null;
      used.add(clip); return { ...s, clip };
    }).filter(Boolean);
  }
  return next;
}

/** Human + machine readable comparison of two edits, keyed by clip id where possible. */
export function diffEdits(before = { clips: [], options: {} }, after = { clips: [], options: {} }) {
  const key = (c, i) => c.id ?? `#${i}`;
  const a = new Map(before.clips.map((c, i) => [key(c, i), { ...c, index: i }]));
  const b = new Map(after.clips.map((c, i) => [key(c, i), { ...c, index: i }]));
  const added = [], removed = [], changed = [], moved = [];
  for (const [id, c] of b) {
    const old = a.get(id);
    if (!old) { added.push({ id, index: c.index, sourceIndex: c.sourceIndex, start: c.start, end: c.end }); continue; }
    const fields = CLIP_FIELDS.filter(f => f !== 'id' && JSON.stringify(old[f] ?? null) !== JSON.stringify(c[f] ?? null)
      && !(['speed', 'gain'].includes(f) && (old[f] ?? 1) === (c[f] ?? 1)));
    if (fields.length) changed.push({ id, index: c.index, fields, before: Object.fromEntries(fields.map(f => [f, old[f]])), after: Object.fromEntries(fields.map(f => [f, c[f]])) });
    if (old.index !== c.index) moved.push({ id, from: old.index, to: c.index });
  }
  for (const [id, c] of a) if (!b.has(id)) removed.push({ id, index: c.index, sourceIndex: c.sourceIndex, start: c.start, end: c.end });
  const optionKeys = [...new Set([...Object.keys(before.options ?? {}), ...Object.keys(after.options ?? {})])]
    .filter(k => JSON.stringify(before.options?.[k] ?? null) !== JSON.stringify(after.options?.[k] ?? null));
  // Report only real reorders: clips outside the longest run that kept its relative order.
  const kept = [...a.keys()].filter(k => b.has(k));
  const orderB = [...b.keys()].filter(k => a.has(k)).map(k => kept.indexOf(k));
  const stable = new Set();
  { // longest increasing subsequence over before-positions, in after-order
    const tails = [], prev = new Array(orderB.length).fill(-1), at = [];
    orderB.forEach((v, i) => {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (orderB[tails[mid]] < v) lo = mid + 1; else hi = mid; }
      if (lo > 0) prev[i] = tails[lo - 1];
      tails[lo] = i; at[i] = lo;
    });
    for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]) stable.add(kept[orderB[i]]);
  }
  const relative = moved.filter(m => !stable.has(m.id));
  const parts = [];
  if (added.length) parts.push(`${added.length} added`);
  if (removed.length) parts.push(`${removed.length} removed`);
  if (changed.length) parts.push(`${changed.length} changed`);
  if (relative.length) parts.push(`${relative.length} moved`);
  if (optionKeys.length) parts.push(`settings: ${optionKeys.slice(0, 4).join(', ')}${optionKeys.length > 4 ? '…' : ''}`);
  return {
    added, removed, changed, moved: relative, options: optionKeys,
    durationBefore: round(totalDuration(before.clips)), durationAfter: round(totalDuration(after.clips)),
    summary: parts.length ? parts.join(' · ') : 'No changes',
  };
}

export function formatTime(seconds, precision = 1) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(precision).padStart(precision ? 3 + precision : 2, '0')}`;
}
