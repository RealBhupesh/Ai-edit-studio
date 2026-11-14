// Story documents (aes.story/1): a whole video described once, timed in beats, built in one call.
// compileStory() is pure: it validates the document and returns cut times, events, drops, sound effects, texts and
// warnings. renderGeneratedScene() turns one generated scene (title, counter, bars, terminal, chips, card/end) into a
// video file with FFmpeg + libass — kinetic type, glow, film grain — so no extra dependencies are needed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StudioError } from './paths.mjs';
import { runProcess } from './process.mjs';
import { STYLES, MOODS } from './music/compose.mjs';

export const STORY_VERSION = 'aes.story/1';
export const STORY_ENGINE_VERSION = 1;
export const GENERATED_KINDS = ['title', 'counter', 'bars' , 'terminal', 'chips', 'card/end'];
export const TRANSITIONS = ['cut', 'fade', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'circleopen', 'smoothleft', 'pixelize', 'radial'];
const DEFAULT_TRANSITION_SECONDS = { fade: 0.4, fadeblack: 0.3, fadewhite: 0.2 };
const SFX_KINDS = ['whoosh', 'hit', 'pop', 'riser', 'click', 'drop'];
const TEXT_STYLES = ['title', 'lower', 'big', 'note', 'callout'];
const TEXT_POSITIONS = ['center', 'low', 'high', 'left-low', 'left-high'];

/** Canvas per delivery. Generated scenes are designed on this grid and rendered at the chosen size. */
export const DELIVERIES = Object.freeze({
  'vertical-share': { aspect: '9:16', w: 1080, h: 1920, formats: { 720: 'vertical720', 1080: 'vertical', 1440: 'vertical1440', '4k': 'vertical4k' } },
  'landscape-share': { aspect: '16:9', w: 1920, h: 1080, formats: { 720: 'hd', 1080: 'landscape', 1440: 'qhd', '4k': 'uhd' } },
  square: { aspect: '1:1', w: 1080, h: 1080, formats: { 720: 'square720', 1080: 'square', 1440: 'square1440' } },
  portrait: { aspect: '4:5', w: 1080, h: 1350, formats: { 720: 'portrait720', 1080: 'portrait', 1440: 'portrait1440' } },
});
const RENDER_SIZES = { 720: 720, 1080: 1080, 1440: 1440, '4k': 2160 }; // short side in pixels
/** Platform UI zones on the design grid (px kept clear of important content). */
export const SAFE_AREAS = Object.freeze({
  story: { top: 250, bottom: 340, left: 64, right: 64 },
  reels: { top: 220, bottom: 420, left: 64, right: 120 },
  tiktok: { top: 160, bottom: 480, left: 64, right: 160 },
  shorts: { top: 180, bottom: 420, left: 64, right: 120 },
  none: { top: 60, bottom: 60, left: 60, right: 60 },
});

const r3 = x => Math.round(x * 1000) / 1000;
const fail = (message, code = 'INVALID_STORY') => { throw new StudioError(code, message); };
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const num = (v, d, a, b, name) => {
  const x = v === undefined ? d : Number(v);
  if (!Number.isFinite(x) || x < a || x > b) fail(`${name} must be a number from ${a} to ${b}.`);
  return x;
};
const str = (v, max, name, required = false) => {
  if (v === undefined || v === null || v === '') { if (required) fail(`${name} is missing.`); return ''; }
  if (typeof v !== 'string') fail(`${name} must be text.`);
  return v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').slice(0, max);
};
const words = s => String(s).replace(/[*\n]/g, ' ').split(/\s+/).filter(Boolean).length;
/** Reading time for a card: 0.4 s + 0.22 s per word. */
export const readSeconds = s => 0.4 + 0.22 * words(s);
const color = (v, d) => {
  const c = v === undefined ? d : String(v);
  if (!/^#[0-9a-f]{6}$/i.test(c)) fail(`Colour ${c} must look like #1e4f91.`);
  return c.toLowerCase();
};

// ---------------------------------------------------------------------------------------------------- scene timing
/**
 * When things happen inside a generated scene, in beats from the scene's start. Shared by the compiler (events,
 * reading checks) and the renderer, so both always agree.
 */
export function sceneSchedule(scene) {
  const b = scene.beats;
  switch (scene.kind) {
    case 'title': {
      const n = scene.lines.length;
      const stagger = scene.stagger ?? Math.min(1, b / (n + 1));
      const lines = scene.lines.map((_, i) => i * stagger);
      const sub = scene.sub ? (scene.subBeat ?? Math.min(b - 0.5, lines.at(-1) + Math.max(0.5, stagger))) : null;
      return { lines, sub, events: { ...Object.fromEntries(lines.map((t, i) => [`l${i + 1}`, t])), ...(sub !== null ? { sub } : {}) } };
    }
    case 'counter': {
      const count = Math.min(scene.countBeats ?? b * 0.6, b - 0.25);
      return { title: 0, count: [0.1, count], label: 0.25, sub: Math.min(b - 0.5, scene.subBeat ?? 1.5), events: { done: count } };
    }
    case 'bars': {
      // Bars fill one after another; a value shows when its bar is full; `done` is the last bar full.
      const start = scene.title ? 0.4 : 0;
      const room = Math.max(0.25, b - 0.25 - start);
      const grow = Math.min(1, room / 2);
      const n = scene.items.length;
      const step = n > 1 ? Math.min(0.4, (room - grow) / (n - 1)) : 0;
      const bars = scene.items.map((_, i) => [start + i * step, start + i * step + grow]);
      return { title: 0, bars, note: scene.sourceNote ? Math.min(b - 0.5, bars.at(-1)[1] + 0.25) : null, events: { done: bars.at(-1)[1] } };
    }
    case 'terminal': {
      const typing = Math.min(1.25, b * 0.3);
      const out = Math.min(b - 0.25, typing + 0.35);
      const step = scene.output.length > 1 ? Math.min(0.25, Math.max(0.12, (b - 1 - out) / scene.output.length)) : 0;
      return { title: 0, typing: [0.1, typing], out, step, note: scene.note ? Math.min(b - 0.5, out + step * scene.output.length + 0.25) : null, events: { out } };
    }
    case 'chips': {
      const start = scene.title ? 0.4 : 0;
      const step = Math.min(0.25, Math.max(0.1, (b * 0.45) / Math.max(1, scene.items.length)));
      const all = start + step * (scene.items.length - 1);
      return { title: 0, items: scene.items.map((_, i) => start + i * step), footer: scene.footer ? Math.min(b - 0.5, scene.footerBeat ?? Math.max(all + 0.5, b / 2)) : null, events: { all } };
    }
    case 'card/end': {
      return { logo: 0, title: 0.1, tagline: Math.min(1, b * 0.25), cta: Math.min(1.5, b * 0.4), url: Math.min(1.75, b * 0.45), events: { cta: Math.min(1.5, b * 0.4) } };
    }
    default: return { events: {} };
  }
}

// ---------------------------------------------------------------------------------------------------- compile
function normalizeScene(raw, i, ids) {
  if (!isObj(raw)) fail(`Scene ${i + 1} must be an object.`);
  const kind = raw.source !== undefined ? 'footage' : raw.kind;
  if (kind !== 'footage' && !GENERATED_KINDS.includes(kind)) fail(`Scene ${i + 1}: kind must be one of ${GENERATED_KINDS.join(', ')}, or give source for footage.`);
  const id = raw.id === undefined ? `s${i + 1}` : String(raw.id);
  if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(id)) fail(`Scene ${i + 1}: id must be a short name (letters, digits, - or _).`);
  if (ids.has(id)) fail(`Scene id "${id}" is used twice.`);
  ids.add(id);
  const s = { id, kind, index: i };
  s.beats = raw.beats === undefined ? undefined : num(raw.beats, 0, 0.5, 256, `Scene ${id}: beats`);
  if (s.beats !== undefined && Math.abs(s.beats * 2 - Math.round(s.beats * 2)) > 1e-9) fail(`Scene ${id}: beats must be whole or half beats.`);
  const tr = raw.transition ?? 'cut';
  if (!TRANSITIONS.includes(tr)) fail(`Scene ${id}: transition must be one of ${TRANSITIONS.join(', ')}.`);
  s.transition = i === 0 ? 'cut' : tr;
  s.transitionSeconds = s.transition === 'cut' ? 0 : num(raw.transitionSeconds, DEFAULT_TRANSITION_SECONDS[s.transition] ?? 0.3, 0.1, 3, `Scene ${id}: transitionSeconds`);
  s.label = str(raw.label, 60, `Scene ${id}: label`);
  if (kind === 'footage') {
    s.source = str(raw.source, 1000, `Scene ${id}: source`, true);
    if (!path.isAbsolute(s.source)) fail(`Scene ${id}: source must be an absolute local file path.`);
    s.start = num(raw.start, 0, 0, 7200, `Scene ${id}: start`);
    s.end = raw.end === undefined ? undefined : num(raw.end, 0, 0, 7200, `Scene ${id}: end`);
    if (s.beats === undefined && s.end === undefined) fail(`Scene ${id}: give beats (preferred) or end.`);
    for (const k of ['framing']) if (raw[k] !== undefined && !['fit', 'fill'].includes(raw[k])) fail(`Scene ${id}: framing must be fit or fill.`);
    s.framing = raw.framing;
    for (const [k, a, b] of [['zoom', 1, 2], ['zoomEnd', 1, 2], ['focusX', 0, 1], ['focusY', 0, 1], ['focusXEnd', 0, 1], ['focusYEnd', 0, 1], ['brightness', -0.3, 0.3], ['contrast', 0.5, 1.5], ['saturation', 0, 2], ['temperature', -1, 1], ['gain', 0, 2], ['sharpen', 0, 1]]) {
      if (raw[k] !== undefined) s[k] = num(raw[k], 0, a, b, `Scene ${id}: ${k}`);
    }
    if ((s.zoom !== undefined || s.zoomEnd !== undefined || s.focusXEnd !== undefined) && s.framing !== 'fill') s.framing = 'fill';
    if (raw.text !== undefined) {
      if (!isObj(raw.text) && typeof raw.text !== 'string') fail(`Scene ${id}: text must be text or {text, style, position}.`);
      const t = typeof raw.text === 'string' ? { text: raw.text } : raw.text;
      s.text = { text: str(t.text, 120, `Scene ${id}: text`, true), style: t.style ?? 'big', position: t.position ?? 'center' };
      if (!TEXT_STYLES.includes(s.text.style)) fail(`Scene ${id}: text style ${TEXT_STYLES.join('/')}.`);
      if (!TEXT_POSITIONS.includes(s.text.position)) fail(`Scene ${id}: text position ${TEXT_POSITIONS.join('/')}.`);
    }
    return s;
  }
  if (s.beats === undefined) fail(`Scene ${id}: give beats (generated scenes are timed in beats).`);
  if (kind === 'title') {
    const lines = typeof raw.lines === 'string' ? raw.lines.split('\n') : raw.lines ?? (raw.text ? String(raw.text).split('\n') : null);
    if (!Array.isArray(lines) || !lines.length || lines.length > 5) fail(`Scene ${id}: lines needs 1 to 5 lines (put *stars* around words in the accent colour).`);
    s.lines = lines.map((l, k) => str(l, 60, `Scene ${id}: line ${k + 1}`, true));
    s.sub = str(raw.sub, 120, `Scene ${id}: sub`);
    if (raw.stagger !== undefined) s.stagger = num(raw.stagger, 1, 0, 8, `Scene ${id}: stagger`);
    if (raw.subBeat !== undefined) s.subBeat = num(raw.subBeat, 1, 0, 256, `Scene ${id}: subBeat`);
    if (raw.align !== undefined && !['center', 'left'].includes(raw.align)) fail(`Scene ${id}: align center or left.`);
    s.align = raw.align ?? 'center';
    if (raw.size !== undefined) s.size = num(raw.size, 0, 40, 400, `Scene ${id}: size`);
  } else if (kind === 'counter') {
    s.to = num(raw.to, 0, -1e12, 1e12, `Scene ${id}: to`);
    s.from = num(raw.from, 0, -1e12, 1e12, `Scene ${id}: from`);
    s.decimals = Math.round(num(raw.decimals, 0, 0, 3, `Scene ${id}: decimals`));
    s.prefix = str(raw.prefix, 8, `Scene ${id}: prefix`); s.suffix = str(raw.suffix, 12, `Scene ${id}: suffix`);
    s.title = str(raw.title, 60, `Scene ${id}: title`); s.label = str(raw.label, 40, `Scene ${id}: label`); s.sub = str(raw.sub, 80, `Scene ${id}: sub`);
    s.sourceNote = str(raw.sourceNote, 120, `Scene ${id}: sourceNote`);
    if (raw.countBeats !== undefined) s.countBeats = num(raw.countBeats, 1, 0.25, 64, `Scene ${id}: countBeats`);
    if (raw.subBeat !== undefined) s.subBeat = num(raw.subBeat, 1, 0, 256, `Scene ${id}: subBeat`);
    s.locale = str(raw.locale, 20, `Scene ${id}: locale`) || 'en-US';
  } else if (kind === 'bars') {
    s.title = str(raw.title, 60, `Scene ${id}: title`);
    if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > 8) fail(`Scene ${id}: items needs 1 to 8 entries, each {label, value}.`);
    s.items = raw.items.map((x, k) => {
      if (!isObj(x)) fail(`Scene ${id}: item ${k + 1} must be {label, value}.`);
      if (typeof x.label !== 'string' || !x.label.trim()) fail(`Scene ${id}: item ${k + 1} needs a label.`);
            if (x.label.length > 24) fail(`Scene ${id}: item ${k + 1} label is ${x.label.length} characters; use at most 24 characters.`);
      const value = typeof x.value === 'number' ? x.value : typeof x.value === 'string' && x.value.trim() ? Number(x.value) : NaN;
      if (!Number.isFinite(value) || value < 0 || value > 1e12) fail(`Scene ${id}: item ${k + 1} value must be a number of 0 or more.`);
      return { label: str(x.label, 24, `Scene ${id}: item ${k + 1} label`, true), value };
    });
    const largest = Math.max(...s.items.map(x => x.value));
    if (raw.max !== undefined) {
      s.max = num(raw.max, 0, 0, 1e12, `Scene ${id}: max`);
      if (s.max < largest) fail(`Scene ${id}: max ${s.max} is below the largest value (${largest}); raise it or leave it out.`);
    }
    if (raw.highlight !== undefined) {
      if (!Number.isInteger(raw.highlight) || raw.highlight < 0 || raw.highlight >= s.items.length) fail(`Scene ${id}: highlight must be an item number from 0 to ${s.items.length - 1}.`);
      s.highlight = raw.highlight;
    }
    s.decimals = Math.round(num(raw.decimals, 0, 0, 3, `Scene ${id}: decimals`));
    s.prefix = str(raw.prefix, 8, `Scene ${id}: prefix`); s.suffix = str(raw.suffix, 12, `Scene ${id}: suffix`);
    s.sourceNote = str(raw.sourceNote, 120, `Scene ${id}: sourceNote`);
    s.locale = str(raw.locale, 20, `Scene ${id}: locale`) || 'en-US';
  } else if (kind === 'terminal') {
    s.title = str(raw.title, 60, `Scene ${id}: title`);
    s.window = str(raw.window, 40, `Scene ${id}: window`);
    s.command = str(raw.command, 70, `Scene ${id}: command`, true);
    const out = raw.output ?? [];
    if (!Array.isArray(out) || out.length > 12) fail(`Scene ${id}: output is a list of at most 12 lines.`);
    s.output = out.map((l, k) => str(l, 60, `Scene ${id}: output line ${k + 1}`));
    s.note = str(raw.note, 40, `Scene ${id}: note`);
  } else if (kind === 'chips') {
    s.title = str(raw.title, 80, `Scene ${id}: title`);
    if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > 12) fail(`Scene ${id}: items needs 1 to 12 entries.`);
    s.items = raw.items.map((x, k) => str(x, 28, `Scene ${id}: item ${k + 1}`, true));
    s.footer = str(raw.footer, 60, `Scene ${id}: footer`);
    if (raw.footerBeat !== undefined) s.footerBeat = num(raw.footerBeat, 1, 0, 256, `Scene ${id}: footerBeat`);
  } else if (kind === 'card/end') {
    s.title = str(raw.title, 40, `Scene ${id}: title`, true);
    s.tagline = str(raw.tagline, 120, `Scene ${id}: tagline`);
    s.cta = str(raw.cta, 40, `Scene ${id}: cta`);
    s.url = str(raw.url, 60, `Scene ${id}: url`);
    s.logo = str(raw.logo, 1000, `Scene ${id}: logo`);
    if (s.logo && !path.isAbsolute(s.logo)) fail(`Scene ${id}: logo must be an absolute path to a PNG or JPEG.`);
  }
  return s;
}

function normalizeStyle(raw = {}) {
  if (!isObj(raw)) fail('style must be an object.');
  const bg = raw.background ?? {};
  return {
    accent: color(raw.accent, '#8db4ee'),
    accent2: color(raw.accent2, '#f0b544'),
    ink: color(raw.ink, '#e8eef0'),
    muted: color(raw.muted, '#9aa8b4'),
    panel: color(raw.panel, '#0f2138'),
    background: { from: color(bg.from, '#070e17'), to: color(bg.to, '#10243e') },
    font: str(raw.font, 80, 'style.font'), fontBody: str(raw.fontBody, 80, 'style.fontBody'), fontMono: str(raw.fontMono, 80, 'style.fontMono'),
    fontsDir: str(raw.fontsDir, 1000, 'style.fontsDir'),
    grain: num(raw.grain, 6, 0, 20, 'style.grain'),
    grid: raw.grid === undefined ? true : Boolean(raw.grid),
    glow: num(raw.glow, 0.6, 0, 1, 'style.glow'),
  };
}

/** Resolve {beat}, {event}, {at} or a plain event name / beat number to timeline seconds. */
function resolveTime(ref, events, beat, where) {
  if (typeof ref === 'number') return ref * beat;
  if (typeof ref === 'string') { if (!(ref in events)) fail(`${where}: unknown event "${ref}". Events: ${Object.keys(events).slice(0, 40).join(', ')}.`); return events[ref]; }
  if (!isObj(ref)) fail(`${where}: give beat, event or at.`);
  const off = ref.offset === undefined ? 0 : num(ref.offset, 0, -30, 30, `${where}: offset`);
  if (ref.event !== undefined) { if (!(ref.event in events)) fail(`${where}: unknown event "${ref.event}".`); return events[ref.event] + off; }
  if (ref.beat !== undefined) return num(ref.beat, 0, 0, 100000, `${where}: beat`) * beat + off;
  if (ref.at !== undefined) return num(ref.at, 0, 0, 1200, `${where}: at`) + off;
  return fail(`${where}: give beat, event or at.`);
}

/**
 * Validate and time a story. Returns everything a build needs: per scene its timeline start/end, clip in/out
 * (including the incoming transition), events, drops, sfx, texts, delivery and warnings.
 */
export function compileStory(story) {
  if (!isObj(story)) fail('story must be an object (see studio_guide {topic:"story"}).');
  if (story.version !== undefined && story.version !== STORY_VERSION) fail(`version must be "${STORY_VERSION}".`);
  const deliver = story.deliver ?? 'vertical-share';
  if (!DELIVERIES[deliver]) fail(`deliver must be one of ${Object.keys(DELIVERIES).join(', ')}.`);
  const canvas = DELIVERIES[deliver];
  const size = String(story.size ?? '1080');
  if (!canvas.formats[size]) fail(`size must be one of ${Object.keys(canvas.formats).join(', ')} for ${deliver}.`);
  const safeName = story.safeArea ?? (canvas.aspect === '9:16' ? 'reels' : 'none');
  if (!SAFE_AREAS[safeName]) fail(`safeArea must be one of ${Object.keys(SAFE_AREAS).join(', ')}.`);
  const safe = canvas.aspect === '9:16' ? SAFE_AREAS[safeName] : SAFE_AREAS.none;
  const fps = Math.round(num(story.fps, 30, 24, 60, 'fps'));
  const music = story.music === undefined ? {} : story.music;
  if (!isObj(music)) fail('music must be an object: {bpm, style?, mood?, seed?, file?}.');
  const bpm = num(music.bpm, 120, 40, 220, 'music.bpm');
  // compose() silently falls back to 'pop' / the style's default mood and turns a
  // non-numeric seed into a random one. Catch bad values here so the dry run and
  // the build fail with INVALID_STORY instead of quietly composing another track.
  if (music.style !== undefined && !Object.hasOwn(STYLES, music.style)) fail(`music.style must be one of ${Object.keys(STYLES).join(', ')}.`);
  if (music.mood !== undefined && !Object.hasOwn(MOODS, music.mood)) fail(`music.mood must be one of ${Object.keys(MOODS).join(', ')}.`);
  // studio_music takes an integer seed from 0 to 2147483647. Only a real
  // number in that range is safe: coercing with Number() would also accept
  // true, "", [], null and "42" and would leave that raw value in the story.
  if (music.seed !== undefined && (typeof music.seed !== 'number' || !Number.isInteger(music.seed) || music.seed < 0 || music.seed > 2147483647)) fail('music.seed must be an integer from 0 to 2147483647.');
  const beat = 60 / bpm, bar = 4 * beat;
  const style = normalizeStyle(story.style);
  if (!Array.isArray(story.scenes) || !story.scenes.length || story.scenes.length > 60) fail('scenes needs 1 to 60 scenes.');
  const ids = new Set();
  const scenes = story.scenes.map((s, i) => normalizeScene(s, i, ids));
  const warnings = [];
  let t = 0, beatPos = 0;
  const events = {};
  for (const s of scenes) {
    const dur = s.beats !== undefined ? s.beats * beat : (s.end - s.start);
    if (!(dur > 0)) fail(`Scene ${s.id}: end must be after start.`);
    const prev = scenes[s.index - 1];
    if (s.transitionSeconds) {
      const room = Math.min(dur, prev ? prev.duration : dur) * 0.5;
      if (s.transitionSeconds > room) fail(`Scene ${s.id}: transitionSeconds ${s.transitionSeconds} is longer than half a neighbouring scene (${r3(room)} s).`);
    }
    Object.assign(s, { start: s.kind === 'footage' ? s.start : 0, timelineStart: r3(t), duration: r3(dur), timelineEnd: r3(t + dur), beatStart: s.beats !== undefined ? beatPos : null });
    s.clipSeconds = r3(dur + s.transitionSeconds);
    events[`${s.id}.in`] = r3(t); events[`${s.id}.out`] = r3(t + dur);
    if (s.kind !== 'footage') {
      s.schedule = sceneSchedule(s);
      for (const [k, b] of Object.entries(s.schedule.events)) events[`${s.id}.${k}`] = r3(t + b * beat);
    }
    if (dur < 0.8) warnings.push({ code: 'SHORT_SHOT', scene: s.id, message: `Scene ${s.id} lasts ${r3(dur)} s: under 0.8 s it reads as a flash.` });
    if (prev && s.transition === 'fade' && prev.kind !== 'footage' && s.kind !== 'footage') warnings.push({ code: 'TEXT_DISSOLVE', scene: s.id, message: `Scene ${s.id}: a dissolve between two text cards shows both cards' words on top of each other; use cut or fadeblack.` });
    t += dur;
    if (s.beats !== undefined) beatPos += s.beats; else beatPos = null;
  }
  const duration = r3(t);
  if (duration > 1200) fail('A story may be at most 20 minutes long.');
  const allBeats = scenes.every(s => s.beats !== undefined);
  const totalBeats = allBeats ? scenes.reduce((a, s) => a + s.beats, 0) : null;
  if (allBeats && Math.abs(totalBeats / 4 - Math.round(totalBeats / 4)) > 1e-9) warnings.push({ code: 'PARTIAL_BAR', message: `The story is ${totalBeats} beats: not a whole number of bars (${r3(totalBeats / 4)}). End on a bar line so the music ends with the picture.` });
  // Reading time for generated text
  for (const s of scenes.filter(x => x.kind !== 'footage')) {
    const sc = s.schedule, left = b => (s.beats - b) * beat;
    const check = (text, b, what) => { if (text && b !== null && b !== undefined && left(b) < readSeconds(text)) warnings.push({ code: 'READ_TIME', scene: s.id, message: `Scene ${s.id}: ${what} "${text.slice(0, 40)}" is on screen ${r3(left(b))} s; it needs about ${r3(readSeconds(text))} s to read. Give the scene more beats or show it earlier.` }); };
    if (s.kind === 'title') { s.lines.forEach((l, i) => check(l, sc.lines[i], `line ${i + 1}`)); check(s.sub, sc.sub, 'sub'); }
    if (s.kind === 'counter') { check(s.sub, sc.sub, 'sub'); }
    if (s.kind === 'bars') {
      // The last value shows when its bar is full: it needs about a second on screen.
      const shown = left(sc.events.done);
      if (shown < 1) warnings.push({ code: 'READ_TIME', scene: s.id, message: `Scene ${s.id}: the last value is on screen ${r3(shown)} s; give it about 1 s (more beats or fewer bars).` });
    }
    if (s.kind === 'chips') check(s.footer, sc.footer, 'footer');
    if (s.kind === 'terminal' && s.output.length) {
      // Code is scanned, not read word by word: the last line needs about a second on screen.
      const last = sc.out + sc.step * (s.output.length - 1);
      if (left(last) < 0.9) warnings.push({ code: 'READ_TIME', scene: s.id, message: `Scene ${s.id}: the last output line is on screen ${r3(left(last))} s; give it about 0.9 s (more beats or fewer lines).` });
      check(s.note, sc.note, 'note');
    }
    if (s.kind === 'card/end') check(s.url, sc.url, 'url');
  }
  // Drops: where the music must hit. On a bar line, or the composer has to bend the tempo.
  const drops = (Array.isArray(story.drops) ? story.drops : story.drops === undefined ? [] : fail('drops must be a list.')).slice(0, 8).map((d, i) => {
    const time = r3(resolveTime(d, events, beat, `drops[${i}]`));
    const beatNo = time / beat, onBar = Math.abs(beatNo / 4 - Math.round(beatNo / 4)) < 1e-6;
    if (!onBar) warnings.push({ code: 'DROP_OFF_BAR', message: `Drop ${i + 1} at ${time} s (beat ${r3(beatNo)}) is not on a bar line (every 4 beats). Move it to beat ${Math.round(beatNo / 4) * 4}.` });
    if (time <= 0 || time >= duration) fail(`drops[${i}] is outside the story (0–${duration} s).`);
    return { time, beat: r3(beatNo), onBar };
  });
  const sfx = (Array.isArray(story.sfx) ? story.sfx : []).slice(0, 300).map((e, i) => {
    if (!isObj(e) || !SFX_KINDS.includes(e.kind)) fail(`sfx[${i}]: kind must be one of ${SFX_KINDS.join(', ')}.`);
    const time = r3(Math.max(0, resolveTime(e.at ?? e, events, beat, `sfx[${i}]`)));
    return { time, kind: e.kind, gain: num(e.gain, 0.7, 0, 2, `sfx[${i}].gain`) };
  });
  const texts = (Array.isArray(story.texts) ? story.texts : []).slice(0, 100).map((x, i) => {
    if (!isObj(x)) fail(`texts[${i}] must be an object.`);
    const start = r3(resolveTime(x.at ?? 0, events, beat, `texts[${i}].at`));
    const end = x.until !== undefined ? r3(resolveTime(x.until, events, beat, `texts[${i}].until`)) : r3(start + num(x.beats, 4, 0.5, 256, `texts[${i}].beats`) * beat);
    const text = str(x.text, 120, `texts[${i}].text`, true);
    if (end - start < readSeconds(text)) warnings.push({ code: 'READ_TIME', message: `Text "${text.slice(0, 40)}" is on screen ${r3(end - start)} s; it needs about ${r3(readSeconds(text))} s.` });
    return { start, end: Math.min(end, duration), text, style: x.style ?? 'big', position: x.position ?? 'center' };
  });
  for (const s of scenes.filter(x => x.kind === 'footage' && x.text)) texts.push({ start: s.timelineStart, end: s.timelineEnd, ...s.text });
  // The same range of the same file twice reads as a mistake; refuse it.
  const footage = scenes.filter(s => s.kind === 'footage');
  for (const a of footage) for (const b of footage) {
    if (a.index >= b.index || a.source.toLowerCase() !== b.source.toLowerCase()) continue;
    const [a0, a1] = [a.start - a.transitionSeconds, a.start + a.duration], [b0, b1] = [b.start - b.transitionSeconds, b.start + b.duration];
    if (Math.min(a1, b1) - Math.max(a0, b0) > 0.05) fail(`Scenes ${a.id} and ${b.id} use the same part of ${path.basename(a.source)}; take another second for a reprise.`);
  }
  return {
    version: STORY_VERSION, name: str(story.name, 100, 'name') || 'Story', deliver, aspect: canvas.aspect, canvas: { w: canvas.w, h: canvas.h }, size, renderFormat: canvas.formats[size],
    safeArea: safeName, safe, fps, bpm, beat: r3(beat), bar: r3(bar), totalBeats, duration, style, music: { ...music, bpm }, scenes, events, drops, sfx, texts,
    cuts: scenes.slice(1).map(s => s.timelineStart), warnings,
  };
}

/** A compact view of a compiled story for dry runs and build results. */
export function storySummary(c) {
  return {
    name: c.name, deliver: c.deliver, size: c.size, renderFormat: c.renderFormat, bpm: c.bpm, beat: c.beat, bar: c.bar, totalBeats: c.totalBeats,
    bars: c.totalBeats === null ? null : r3(c.totalBeats / 4), duration: c.duration,
    scenes: c.scenes.map(s => ({ id: s.id, kind: s.kind, beats: s.beats ?? null, start: s.timelineStart, end: s.timelineEnd, transition: s.transition, ...(s.transitionSeconds ? { transitionSeconds: s.transitionSeconds } : {}) })),
    cuts: c.cuts, events: c.events, drops: c.drops, sfx: c.sfx.length, texts: c.texts.length, warnings: c.warnings,
  };
}

// ---------------------------------------------------------------------------------------------------- render (ASS)
const assColor = hex => `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase();
const assTime = s => { const x = Math.max(0, s); const h = Math.floor(x / 3600), m = Math.floor(x / 60) % 60, sec = x % 60; return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`; };
const esc = s => String(s).replace(/\\/g, '\u29f5').replace(/[{}]/g, m => (m === '{' ? '(' : ')'));
/** "Port it *anywhere*." → ASS with the starred words in the accent colour. */
function accentText(text, base, accent) {
  return esc(text).split(/(\*[^*]+\*)/g).map(part => (part.startsWith('*') && part.endsWith('*') && part.length > 2
    ? `{\\c${assColor(accent)}}${part.slice(1, -1)}{\\c${assColor(base)}}` : part)).join('');
}
const plain = s => String(s).replace(/\*/g, '');
const ms = s => Math.round(s * 1000);

export function defaultFonts(platform = process.platform) {
  if (platform === 'win32') return { display: 'Segoe UI Black', body: 'Segoe UI Semibold', mono: 'Consolas' };
  if (platform === 'darwin') return { display: 'Helvetica Neue', body: 'Helvetica Neue', mono: 'Menlo' };
  return { display: 'Inter Display Black', body: 'Inter Display SemiBold', mono: 'DejaVu Sans Mono' };
}

/** Approximate rendered width of text for layout (bold display faces run about 0.58 em per character). */
const textWidth = (s, size, k = 0.58) => plain(s).length * size * k;
const fit = (lines, maxSize, width, k = 0.58) => Math.floor(Math.min(maxSize, ...lines.map(l => width / Math.max(1, plain(l).length * k))));

class Ass {
  constructor(c, fonts) {
    this.c = c; this.f = fonts; this.rows = [];
  }
  /** One text event. t0/t1 in clip seconds; anim: slam | fade | pop | none. */
  text({ t0, t1, x, y, text, size, font, color, align = 5, anim = 'slam', glow = 0, glowColor, layer = 2, bold = 0, extra = '' }) {
    const st = this.c.style;
    const base = `\\an${align}\\pos(${Math.round(x)},${Math.round(y)})\\fn${esc(font)}\\fs${Math.round(size)}\\c${assColor(color)}\\bord0\\shad0\\b${bold}${extra}`;
    const a = { slam: '\\alpha&HFF&\\fscx118\\fscy118\\blur7\\t(0,90,\\alpha&H00&)\\t(0,320,0.4,\\fscx100\\fscy100\\blur0)', fade: '\\alpha&HFF&\\t(0,260,\\alpha&H00&)',
      pop: '\\alpha&HFF&\\fscx55\\fscy55\\t(0,70,\\alpha&H00&)\\t(0,170,0.6,\\fscx108\\fscy108)\\t(170,280,\\fscx100\\fscy100)', rise: '\\alpha&HFF&\\t(0,200,\\alpha&H00&)', none: '' }[anim];
    const body = anim === 'rise' ? `\\an${align}\\move(${Math.round(x)},${Math.round(y + 40)},${Math.round(x)},${Math.round(y)},0,260)${base.slice(base.indexOf('\\fn'))}` : base;
    if (glow > 0 && st.glow > 0) {
      const ga = Math.round(255 - 255 * Math.min(1, glow * st.glow * 0.55));
      const gtext = String(text).replace(/\{[^}]*\}/g, '').replace(/\*/g, ''); // text is already escaped ASS: drop its colour tags, keep the glyphs
      const gbase = body.replace(/\\c&H[0-9A-F]{6}&/, `\\c${assColor(glowColor ?? color)}`);
      const gan = anim === 'none' ? `\\alpha&H${ga.toString(16).padStart(2, '0').toUpperCase()}&` : `\\alpha&HFF&\\t(0,160,\\alpha&H${ga.toString(16).padStart(2, '0').toUpperCase()}&)${anim === 'slam' ? '\\fscx118\\fscy118\\t(0,320,0.4,\\fscx100\\fscy100)' : ''}`;
      this.rows.push([layer - 1, t0, t1, `{${gbase}\\blur${Math.round(size * 0.12)}${gan}}${gtext}`]);
    }
    this.rows.push([layer, t0, t1, `{${body}${a}}${text}`]);
  }
  shape({ t0, t1, d, color, alpha = 0, layer = 1, anim = 'fade', blur = 0, x = 0, y = 0, border, borderColor, grow = 0.5 }) {
    const al = `&H${Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase()}&`;
    // grow: the shape is drawn from its top-left (\an7), so scaling X from 1 to 100 % widens it from the left edge.
    const a = { fade: `\\alpha&HFF&\\t(0,240,\\alpha${al})`, pop: `\\alpha&HFF&\\t(0,90,\\alpha${al})`, none: `\\alpha${al}`,
      grow: `\\alpha${al}\\fscx1\\t(0,${ms(grow)},0.5,\\fscx100)` }[anim];
    const bord = border ? `\\bord${border}\\3c${assColor(borderColor ?? color)}\\3a&H60&` : '\\bord0';
    this.rows.push([layer, t0, t1, `{\\an7\\pos(${Math.round(x)},${Math.round(y)})\\p1\\c${assColor(color)}${bord}\\shad0${blur ? `\\blur${blur}` : ''}${a}}${d}{\\p0}`]);
  }
  toString() {
    const { w, h } = this.c.canvas;
    const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 2\nScaledBorderAndShadow: yes\nYCbCr Matrix: TV.709\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: D,${this.f.display},80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
    return head + this.rows.map(([l, a, b, t]) => `Dialogue: ${l},${assTime(a)},${assTime(b)},D,,0,0,0,,${t}`).join('\n') + '\n';
  }
}
/** Rounded rectangle as an ASS drawing (origin top-left). */
function roundRect(w, h, r) {
  const k = 0.5523 * r, W = Math.round(w), H = Math.round(h), R = Math.round(r);
  return `m ${R} 0 l ${W - R} 0 b ${Math.round(W - R + k)} 0 ${W} ${Math.round(R - k)} ${W} ${R} l ${W} ${H - R} b ${W} ${Math.round(H - R + k)} ${Math.round(W - R + k)} ${H} ${W - R} ${H} l ${R} ${H} b ${Math.round(R - k)} ${H} 0 ${Math.round(H - R + k)} 0 ${H - R} l 0 ${R} b 0 ${Math.round(R - k)} ${Math.round(R - k)} 0 ${R} 0`;
}
const ellipse = (w, h) => roundRect(w, h, Math.min(w, h) / 2);

/** Colour JSON-ish terminal output: strings, numbers and keys, so real tool output reads at a glance. */
function codeLine(line, st) {
  const parts = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\b\d[\d.,]*\b)|([^"\d-]+|-)/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[1]) parts.push(`{\\c${assColor(m[2] ? st.accent : '#c3dca6')}}${esc(m[1])}${m[2] ? `{\\c${assColor(st.ink)}}${m[2]}` : ''}`);
    else if (m[3]) parts.push(`{\\c${assColor(st.accent2)}}${esc(m[3])}`);
    else parts.push(`{\\c${assColor(st.ink)}}${esc(m[4])}`);
  }
  return parts.join('');
}

/** The ASS for one generated scene. Times are clip seconds; the scene's own beat 0 is at `lead` seconds. */
export function sceneAss(c, scene, fonts = defaultFonts()) {
  const st = c.style, { w, h } = c.canvas, safe = c.safe, beat = c.beat;
  const lead = scene.transitionSeconds, end = lead + scene.duration + 0.05;
  const at = b => lead + b * beat;
  const A = new Ass(c, fonts);
  const top = safe.top, bottom = h - safe.bottom, left = safe.left, right = w - safe.right;
  const cx = (left + right) / 2, cy = top + (bottom - top) * 0.47, width = right - left;
  const portrait = h > w;
  const sc = scene.schedule;
  // soft accent glow behind the content
  A.shape({ t0: 0, t1: end, d: ellipse(w * 0.9, w * 0.9), x: cx - w * 0.45, y: cy - w * 0.45, color: st.accent, alpha: 0.86, blur: Math.round(w * 0.12), layer: 0, anim: 'none' });
  if (scene.kind === 'title') {
    const maxSize = scene.size ?? (portrait ? 190 : 150);
    const size = fit(scene.lines, maxSize, width * 0.94);
    const lh = size * 1.06, block = lh * scene.lines.length + (scene.sub ? size * 0.6 : 0);
    const y0 = cy - block / 2 + lh / 2;
    const x = scene.align === 'left' ? left : cx, align = scene.align === 'left' ? 4 : 5;
    scene.lines.forEach((line, i) => {
      const hasAccent = /\*[^*]+\*/.test(line);
      A.text({ t0: at(sc.lines[i]), t1: end, x, y: y0 + i * lh, text: accentText(line, st.ink, st.accent), size, font: fonts.display, color: st.ink, align, glow: hasAccent ? 1 : 0.35, glowColor: hasAccent ? st.accent : st.ink });
    });
    if (scene.sub) A.text({ t0: at(sc.sub), t1: end, x, y: y0 + scene.lines.length * lh - lh / 2 + size * 0.45, text: accentText(scene.sub, st.muted, st.accent), size: Math.max(34, size * 0.3), font: fonts.body, color: st.muted, align, anim: 'rise' });
  } else if (scene.kind === 'counter') {
    const fmt = v => `${scene.prefix}${new Intl.NumberFormat(scene.locale, { minimumFractionDigits: scene.decimals, maximumFractionDigits: scene.decimals }).format(v)}${scene.suffix}`;
    const longest = fmt(scene.to).length > fmt(scene.from).length ? fmt(scene.to) : fmt(scene.from);
    const size = fit([longest], portrait ? 220 : 200, width * 0.9, 0.6);
    const [c0, c1] = sc.count;
    if (scene.title) A.text({ t0: at(sc.title), t1: end, x: cx, y: cy - size * 1.05, text: accentText(scene.title, st.ink, st.accent2), size: fit([scene.title], portrait ? 86 : 72, width * 0.94), font: fonts.display, color: st.ink, glow: 0.3 });
    const steps = Math.max(2, Math.round((c1 - c0) * beat * c.fps));
    for (let k = 0; k <= steps; k++) {
      const p = k / steps, e = 1 - (1 - p) ** 3, v = scene.from + (scene.to - scene.from) * e;
      const t0 = at(c0) + (c1 - c0) * beat * p, t1 = k === steps ? end : at(c0) + (c1 - c0) * beat * ((k + 1) / steps);
      A.text({ t0, t1, x: cx, y: cy, text: esc(fmt(k === steps ? scene.to : v)), size, font: fonts.display, color: st.ink, anim: k === 0 ? 'fade' : 'none', glow: 0.5, glowColor: st.accent });
    }
    if (scene.label) A.text({ t0: at(sc.label), t1: end, x: cx, y: cy + size * 0.68, text: accentText(scene.label, st.accent, st.accent2), size: Math.max(36, size * 0.3), font: fonts.body, color: st.accent, anim: 'rise', glow: 0.3 });
    if (scene.sub) A.text({ t0: at(sc.sub), t1: end, x: cx, y: cy + size * 1.05, text: esc(scene.sub), size: Math.max(28, size * 0.2), font: fonts.body, color: st.muted, anim: 'rise' });
    if (scene.sourceNote) A.text({ t0: at(sc.label), t1: end, x: cx, y: bottom - 30, text: esc(scene.sourceNote), size: 26, font: fonts.body, color: st.muted, anim: 'fade' });
  } else if (scene.kind === 'bars') {
    const n = scene.items.length;
    const fmt = v => `${scene.prefix}${new Intl.NumberFormat(scene.locale, { minimumFractionDigits: scene.decimals, maximumFractionDigits: scene.decimals }).format(v)}${scene.suffix}`;
    const scale = (scene.max ?? Math.max(...scene.items.map(x => x.value))) || 1;
    const tsize = scene.title ? fit([scene.title], portrait ? 86 : 72, width * 0.94) : 0;
    const titleH = scene.title ? tsize * 1.5 : 0, noteH = scene.sourceNote ? 50 : 0;
    const rowH = Math.min(portrait ? 190 : 150, (bottom - top - titleH - noteH - 40) / n);
    const longest = Math.max(...scene.items.map(x => x.label.length)) + Math.max(...scene.items.map(x => fmt(x.value).length)) + 2;
    const fs = Math.max(18, Math.min(portrait ? 52 : 44, Math.floor(rowH * 0.3), Math.floor(width / (longest * 0.6))));
    const barH = Math.max(14, Math.round(rowH * 0.36));
    let y = top + (bottom - top - noteH - titleH - n * rowH) / 2;
    if (scene.title) { A.text({ t0: at(sc.title), t1: end, x: cx, y: y + titleH / 2, text: accentText(scene.title, st.ink, st.accent2), size: tsize, font: fonts.display, color: st.ink, glow: 0.3 }); y += titleH; }
    scene.items.forEach((item, i) => {
      const [b0, b1] = sc.bars[i], on = scene.highlight === undefined || scene.highlight === i;
      const bw = Math.round(width * item.value / scale);
      A.text({ t0: at(b0), t1: end, x: left, y: y + fs * 0.6, align: 4, text: esc(item.label), size: fs, font: fonts.body, color: on ? st.ink : st.muted, anim: 'rise', layer: 3 });
      A.shape({ t0: at(b0), t1: end, d: roundRect(bw, barH, Math.min(barH / 2, bw / 2)), x: left, y: y + fs * 1.4, color: on ? st.accent : st.muted, alpha: on ? 0 : 0.45, layer: 2, anim: 'grow', grow: (b1 - b0) * beat });
      A.text({ t0: at(b1), t1: end, x: right, y: y + fs * 0.6, align: 6, text: esc(fmt(item.value)), size: fs, font: fonts.display, color: on ? st.ink : st.muted, anim: 'pop', layer: 3 });
      y += rowH;
    });
    if (scene.sourceNote) A.text({ t0: at(sc.note), t1: end, x: cx, y: bottom - 30, text: esc(scene.sourceNote), size: 26, font: fonts.body, color: st.muted, anim: 'fade' });
  } else if (scene.kind === 'terminal') {
    const lines = [scene.command, ...scene.output];
    const fs = Math.min(portrait ? 40 : 34, Math.floor((width * 0.86) / (Math.max(...lines.map(l => l.length)) + 2) / 0.6));
    const lh = fs * 1.6, pad = fs * 1.4;
    const boxW = width, boxH = 90 + pad + lh * (lines.length + (scene.output.length ? 0.6 : 0)) + pad * 0.6;
    const titleSize = fit([scene.title || 'x'], portrait ? 86 : 64, width);
    const titleH = scene.title ? titleSize * 1.6 : 0;
    const by = cy - (boxH + titleH + (scene.note ? 130 : 0)) / 2 + titleH;
    if (scene.title) A.text({ t0: at(sc.title), t1: end, x: cx, y: by - titleH / 2, text: accentText(scene.title, st.ink, st.accent2), size: titleSize, font: fonts.display, color: st.ink, glow: 0.3 });
    A.shape({ t0: at(0), t1: end, d: roundRect(boxW, boxH, 30), x: left, y: by, color: st.panel, alpha: 0, layer: 1, border: 2, borderColor: st.accent });
    ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => A.shape({ t0: at(0), t1: end, d: ellipse(22, 22), x: left + 34 + i * 38, y: by + 34, color: col, layer: 2 }));
    if (scene.window) A.text({ t0: at(0), t1: end, x: cx, y: by + 45, text: esc(scene.window), size: 24, font: fonts.body, color: st.muted, anim: 'fade' });
    const tx = left + pad, ty = by + 90 + pad * 0.6;
    const [k0, k1] = sc.typing, n = scene.command.length;
    for (let i = 1; i <= n; i++) {
      const t0 = at(k0) + (k1 - k0) * beat * ((i - 1) / n), t1 = i === n ? end : at(k0) + (k1 - k0) * beat * (i / n);
      A.text({ t0, t1, x: tx, y: ty, align: 4, text: `{\\c${assColor(st.accent2)}}$ {\\c${assColor(st.ink)}}${esc(scene.command.slice(0, i))}${i < n ? '▌' : ''}`, size: fs, font: fonts.mono, color: st.ink, anim: 'none', layer: 3 });
    }
    scene.output.forEach((line, i) => A.text({ t0: at(sc.out + i * sc.step), t1: end, x: tx, y: ty + lh * (i + 1.4), align: 4, text: codeLine(line, st), size: fs, font: fonts.mono, color: st.ink, anim: 'rise', layer: 3 }));
    if (scene.note) {
      const nw = textWidth(scene.note, 46, 0.6) + 90;
      A.shape({ t0: at(sc.note), t1: end, d: roundRect(nw, 92, 46), x: cx - nw / 2, y: by + boxH + 40, color: st.accent2, anim: 'pop', layer: 3 });
      A.text({ t0: at(sc.note), t1: end, x: cx, y: by + boxH + 86, text: esc(scene.note), size: 46, font: fonts.display, color: st.background.from, anim: 'pop', layer: 4 });
    }
  } else if (scene.kind === 'chips') {
    const tlines = scene.title ? scene.title.split('\n') : [];
    const tsize = tlines.length ? fit(tlines, portrait ? 120 : 96, width) : 0;
    const csize = portrait ? 50 : 42, chipH = csize * 2.1, gap = 26;
    const rows = []; let row = [], rw = 0;
    for (const item of scene.items) {
      const iw = textWidth(item, csize, 0.55) + csize * 1.6;
      if (row.length && rw + gap + iw > width) { rows.push({ row, rw }); row = []; rw = 0; }
      row.push({ item, iw }); rw += (row.length > 1 ? gap : 0) + iw;
    }
    if (row.length) rows.push({ row, rw });
    const block = tlines.length * tsize * 1.08 + 60 + rows.length * (chipH + gap) + (scene.footer ? 110 : 0);
    let y = cy - block / 2;
    tlines.forEach((l, i) => { A.text({ t0: at(sc.title + i * 0.15), t1: end, x: cx, y: y + tsize * 0.54, text: accentText(l, st.ink, st.accent), size: tsize, font: fonts.display, color: st.ink, glow: /\*/.test(l) ? 1 : 0.3, glowColor: st.accent }); y += tsize * 1.08; });
    y += 60;
    let k = 0;
    for (const { row: r, rw: w2 } of rows) {
      let x = cx - w2 / 2;
      for (const { item, iw } of r) {
        const t0 = at(sc.items[k++]);
        A.shape({ t0, t1: end, d: roundRect(iw, chipH, chipH / 2), x, y, color: st.panel, layer: 2, anim: 'pop', border: 2, borderColor: st.accent });
        A.text({ t0, t1: end, x: x + iw / 2, y: y + chipH / 2, text: esc(item), size: csize, font: fonts.body, color: st.ink, anim: 'pop', layer: 3 });
        x += iw + gap;
      }
      y += chipH + gap;
    }
    if (scene.footer) A.text({ t0: at(sc.footer), t1: end, x: cx, y: y + 60, text: accentText(scene.footer, st.accent2, st.accent), size: portrait ? 52 : 44, font: fonts.body, color: st.accent2, glow: 0.4, glowColor: st.accent2 });
  } else if (scene.kind === 'card/end') {
    const tsize = fit([scene.title], portrait ? 150 : 130, width);
    const logoH = scene.logo ? (portrait ? 190 : 160) : 0;
    const taglines = scene.tagline ? scene.tagline.split('\n') : [];
    const gsize = fit(taglines.length ? taglines : ['x'], portrait ? 56 : 48, width, 0.52);
    const block = logoH + (logoH ? 60 : 0) + tsize * 1.1 + taglines.length * gsize * 1.35 + (scene.cta ? 170 : 0) + (scene.url ? 80 : 0);
    let y = cy - block / 2;
    if (logoH) { scene.logoBox = { x: cx - logoH / 2, y, size: logoH, t: at(sc.logo) }; y += logoH + 60; }
    A.text({ t0: at(sc.title), t1: end, x: cx, y: y + tsize * 0.55, text: accentText(scene.title, st.ink, st.accent), size: tsize, font: fonts.display, color: st.ink, glow: 0.4, glowColor: st.accent });
    y += tsize * 1.1;
    taglines.forEach((l, i) => { A.text({ t0: at(sc.tagline + i * 0.12), t1: end, x: cx, y: y + gsize * 0.6, text: accentText(l, st.ink, st.accent), size: gsize, font: fonts.body, color: st.ink, anim: 'rise' }); y += gsize * 1.35; });
    if (scene.cta) {
      y += 40;
      const fsz = Math.min(46, Math.floor((width * 0.8) / (scene.cta.length + 2) / 0.6));
      const cw = Math.min(width, textWidth(`$ ${scene.cta}`, fsz, 0.6) + 110), chh = fsz * 2.6;
      A.shape({ t0: at(sc.cta), t1: end, d: roundRect(cw, chh, chh / 2), x: cx - cw / 2, y, color: st.panel, layer: 2, anim: 'pop', border: 3, borderColor: st.accent2 });
      A.text({ t0: at(sc.cta), t1: end, x: cx, y: y + chh / 2, text: `{\\c${assColor(st.accent2)}}$ {\\c${assColor(st.ink)}}${esc(scene.cta)}`, size: fsz, font: fonts.mono, color: st.ink, anim: 'pop', layer: 3, glow: 0.4, glowColor: st.accent2 });
      y += chh + 30;
    }
    if (scene.url) A.text({ t0: at(sc.url), t1: end, x: cx, y: y + 30, text: esc(scene.url), size: portrait ? 38 : 32, font: fonts.body, color: st.muted, anim: 'fade' });
  }
  return A.toString();
}

// ---------------------------------------------------------------------------------------------------- render (FFmpeg)
/** Output size for a delivery and size (even numbers, short side = size). */
export function renderSize(c) {
  const short = RENDER_SIZES[c.size] ?? 1080;
  const { w, h } = c.canvas;
  const k = short / Math.min(w, h);
  const even = v => Math.round(v * k / 2) * 2;
  return { width: even(w), height: even(h) };
}

/** Content hash of everything that changes a generated scene's pixels: unchanged scenes are reused on rebuilds. */
export function sceneKey(c, scene, fonts) {
  const { schedule, index, timelineStart, timelineEnd, beatStart, ...rest } = scene;
  return createHash('sha1').update(JSON.stringify([STORY_ENGINE_VERSION, rest, c.style, c.canvas, c.size, c.fps, c.beat, c.safe, fonts])).digest('hex').slice(0, 16);
}

const ffPath = p => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

/** Render one generated scene to an H.264 file with silent stereo audio. Reuses an existing file with the same key. */
export async function renderGeneratedScene(c, scene, dir, { ffmpeg, fonts = defaultFonts(), timeoutMs = 300_000 } = {}) {
  const key = sceneKey(c, scene, fonts);
  const out = path.join(dir, `${scene.id}-${key}.mp4`);
  try { await fs.access(out); return { file: out, key, reused: true }; } catch { /* render it */ }
  await fs.mkdir(dir, { recursive: true });
  const assFile = path.join(dir, `${scene.id}-${key}.ass`);
  await fs.writeFile(assFile, sceneAss(c, scene, fonts), 'utf8');
  const { width, height } = renderSize(c);
  const st = c.style, dur = r3(scene.clipSeconds + 2 / c.fps); // two spare frames: the clip is cut on the exact beat, never short
  const bg = `gradients=s=${width}x${height}:c0=${st.background.from.replace('#', '0x')}:c1=${st.background.to.replace('#', '0x')}:x0=${Math.round(width / 2)}:y0=0:x1=${Math.round(width / 2)}:y1=${height}:d=${dur}:r=${c.fps}:speed=0.00001`;
  const grid = st.grid ? `,drawgrid=w=${Math.round(width / 12)}:h=${Math.round(width / 12)}:t=1:c=${st.accent.replace('#', '0x')}@0.045` : '';
  const grain = st.grain ? `,noise=alls=${st.grain}:allf=t` : '';
  const fontsDir = st.fontsDir ? `:fontsdir='${ffPath(st.fontsDir)}'` : '';
  let graph = `[0:v]format=rgb24${grid},vignette=PI/5${grain},ass='${ffPath(assFile)}'${fontsDir}`;
  const inputs = ['-f', 'lavfi', '-i', bg, '-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=48000:cl=stereo'];
  if (scene.kind === 'card/end' && scene.logo && scene.logoBox) {
    const k = width / c.canvas.w, b = scene.logoBox, sz = Math.round(b.size * k);
    inputs.push('-loop', '1', '-t', String(dur), '-i', scene.logo);
    graph += `[base];[2:v]scale=${sz}:${sz}:force_original_aspect_ratio=decrease,format=rgba,fade=t=in:st=${Math.max(0, b.t).toFixed(3)}:d=0.25:alpha=1[logo];[base][logo]overlay=x=${Math.round(b.x * k)}:y=${Math.round(b.y * k)}:format=auto`;
  }
  graph += ',format=yuv420p[v]';
  await runProcess(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...inputs, '-filter_complex', graph, '-map', '[v]', '-map', '1:a', '-t', String(dur),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', '-r', String(c.fps), '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', out], { timeoutMs });
  return { file: out, key, reused: false };
}

// ---------------------------------------------------------------------------------------------------- guide
export const STORY_GUIDE = {
  topic: 'story',
  version: STORY_VERSION,
  summary: 'Describe the whole video once as aes.story/1, time every scene in beats, and build it with ONE studio_apply call. dryRun:true returns cut times, events, drops and warnings without rendering. A build renders the generated scenes, links the footage, lays every cut on the beat grid, adds texts, sound effects and (optionally) composed music, then the project is ready to render. Rebuild with {projectId, revision, story}: unchanged scenes are reused.',
  timing: [
    'Set music.bpm and give every scene "beats". One bar = 4 beats = 240/bpm s (96 bpm → 2.5 s; 120 bpm → 2 s).',
    'Each scene starts exactly on its beat. A transition into a scene overlaps the previous scene and finishes on the beat, so cuts stay on the grid.',
    'Keep the total a whole number of bars and put big moments on a bar line: drops:[{beat:16}] or drops:[{event:"s5.in"}]. DROP_OFF_BAR warns when a drop misses.',
    'Between two text scenes use cut or fadeblack, never fade (both cards would show at once). fadewhite 0.2 s sells a hit.',
  ],
  scenes: {
    title: '{kind:"title", beats, lines:["Any game.", "Any *binary*."], sub?, stagger? (beats between lines, default 1 or less), align?:"center"|"left", size?} — lines slam in on their beats; *stars* = accent colour. Events: <id>.in, <id>.l1…, <id>.sub, <id>.out.',
    counter: '{kind:"counter", beats, to, from?:0, prefix?, suffix?, decimals?, title?, label?, sub?, sourceNote?, countBeats?} — counts up with an ease-out. Events: <id>.done. Only real numbers; put the source in sourceNote.',
    bars: '{kind:"bars", beats, items:[{label, value}] (1–8, label at most 24 characters), title?, prefix?, suffix?, decimals?, locale?, max? (default: the largest value), highlight? (item index from 0; that bar uses the accent colour), sourceNote?} — horizontal bars grow in one after another and each value appears when its bar is full. Events: <id>.done (last bar full). Only real numbers; put the source in sourceNote.',
    terminal: '{kind:"terminal", beats, command, output:[lines], title?, window?, note?} — the command types out, output lines appear one by one; JSON-looking output is coloured. Events: <id>.out.',
    chips: '{kind:"chips", beats, title? ("Works with\\n*your agent.*"), items:[…≤12], footer?, footerBeat?} — items pop in on a fast stagger. Events: <id>.all.',
    'card/end': '{kind:"card/end", beats, title, tagline? (\\n for lines), cta? (shown as "$ cta"), url?, logo? (absolute PNG)} — end card. Events: <id>.cta.',
    footage: '{source:"/abs/clip.mp4", start, beats|end, framing?:"fill", zoom?, zoomEnd?, focusX?, focusXEnd?, brightness?, contrast?, saturation?, temperature?, gain?, text?} — no events inside; use {beat} there. A source range can be used once.',
  },
  story: '{version:"aes.story/1", name, deliver:"vertical-share"|"landscape-share"|"square"|"portrait", size:"720"|"1080"|"1440"|"4k", safeArea:"story"|"reels"|"tiktok"|"shorts"|"none", fps?, music:{bpm, style?, mood?, seed?, file?} (style composes a track, file uses yours, neither = silent), style:{accent, accent2, ink, muted, panel, background:{from,to}, font?, fontBody?, fontMono?, fontsDir?, grain?, grid?, glow?}, scenes:[…], drops?:[{beat}|{event}], sfx?:[{kind:"whoosh"|"hit"|"pop"|"riser"|"click"|"drop", at:{event}|{beat}, gain?}], texts?:[{text, at, beats|until, style?, position?}]}',
  checks: 'Warnings: SHORT_SHOT (<0.8 s), READ_TIME (0.4 s + 0.22 s per word), TEXT_DISSOLVE, PARTIAL_BAR, DROP_OFF_BAR. Never invent facts, numbers or quotes: everything on screen must be something the user can stand behind.',
  after: 'studio_apply returns projectId and starts the build: studio_wait {projectId, until:"idle"}. Then studio_storyboard, studio_render {formats:[renderFormat]}, studio_wait, studio_qc. Look at real frames before reporting.',
  example: {
    version: STORY_VERSION, name: 'Launch teaser', deliver: 'vertical-share', size: '1080', safeArea: 'reels',
    music: { bpm: 96 },
    style: { accent: '#8db4ee', accent2: '#f0b544' },
    scenes: [
      { id: 'hook', kind: 'title', beats: 4, lines: ['Any game.', 'Any app.', 'Any *binary*.'] },
      { id: 'count', kind: 'counter', beats: 4, to: 18976, label: 'links mapped', sub: '5,023 files · 42 packages', title: 'One call.' },
      { id: 'big', kind: 'title', beats: 4, lines: ['Port it', '*anywhere.*'], transition: 'fadewhite' },
      { id: 'end', kind: 'card/end', beats: 4, title: 'ReversePort', tagline: 'Reverse engineer anything.\n*Port it anywhere.*', cta: 'npx reverseport setup', url: 'github.com/laaielichter/reverseport' },
    ],
    drops: [{ event: 'big.in' }],
    sfx: [{ kind: 'hit', at: { event: 'big.in' } }, { kind: 'pop', at: { event: 'end.cta' } }],
  },
};
