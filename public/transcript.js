// Word-level transcripts and text-based editing. Pure functions shared by the browser
// editor and the engine. Word times are ORIGINAL SOURCE seconds, like captions.
import { layout, mergeRanges, LIMITS } from './edit-ops.js';

/** Hesitation words removed by "remove fillers". Deliberately conservative: no "like", "so", "dus". */
export const FILLERS = Object.freeze({
  en: ['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mhm'],
  nl: ['eh', 'ehm', 'euh', 'uh', 'uhm', 'ehh', 'hm', 'hmm', 'mm'],
  de: ['äh', 'ähm', 'öh', 'hm', 'hmm'], fr: ['euh', 'heu', 'hum', 'bah'], es: ['eh', 'mmm'],
});
const ALL_FILLERS = new Set(Object.values(FILLERS).flat());
const round = n => Math.round(n * 1000) / 1000;
export const bare = text => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}']+/gu, '');


// CJK text has no spaces between words: segment it (built-in Intl.Segmenter, no dependency)
// instead of splitting on spaces. Hangul uses spaces and stays on the plain path.
export const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const hasCJK = text => CJK_RE.test(String(text ?? ''));
const jaScript = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

// One Segmenter per locale, built on first use and reused (a long talk segments
// many of them). 'auto' (the transcription default) and other placeholder or
// invalid values throw RangeError in the constructor, so each candidate falls
// back to the script-based ja/zh choice; a missing Intl.Segmenter (older
// browsers) falls through to the per-character path in splitWords.
const segmenters = new Map();
function cjkSegmenter(lang, t) {
  for (const locale of [lang, jaScript.test(t) ? 'ja' : 'zh']) {
    if (typeof locale !== 'string' || !locale || locale === 'auto') continue;
    const cached = segmenters.get(locale);
    if (cached) return cached;
    try {
      const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
      segmenters.set(locale, segmenter);
      return segmenter;
    } catch { /* invalid tag, or no Intl.Segmenter: try the next candidate */ }
  }
  return null;
}

/** Word pieces of `text`: CJK text is segmented by dictionary, other text splits on whitespace. */
export function splitWords(text, lang) {
  const t = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (!hasCJK(t)) return t.split(' ').filter(Boolean);
  const segmenter = cjkSegmenter(lang, t);
  const out = [];
  if (segmenter) {
    for (const { segment, isWordLike } of segmenter.segment(t)) {
      if (!segment.trim()) continue;                    // whitespace between CJK words disappears
      if (!isWordLike && out.length) { out[out.length - 1] += segment; continue; }  // punctuation attaches to the previous word
      out.push(segment);
    }
  } else {
    // No Intl.Segmenter (e.g. Firefox before 125): one piece per CJK character,
    // still attaching punctuation to the previous piece, so captions and search
    // keep working instead of throwing.
    for (const ch of t) {
      if (/\s/.test(ch)) continue;
      if (!CJK_RE.test(ch) && out.length) { out[out.length - 1] += ch; continue; }
      out.push(ch);
    }
  }
  return out.filter(Boolean);
}

/** Join word pieces without inventing spaces between CJK words (English/Dutch join unchanged). */
export function joinWords(parts) {
  return [...parts].map(String).reduce((acc, piece, i) => {
    if (!i) return piece;
    return acc + (CJK_RE.test(acc.at(-1) ?? '') && CJK_RE.test(piece[0] ?? '') ? '' : ' ') + piece;
  }, '');
}

/** Clean, sorted, non-overlapping words: [{start, end, text, p?}]. */
export function normalizeWords(rows = [], duration = Infinity) {
  if (!Array.isArray(rows)) throw new Error('words must be an array.');
  const out = [];
  for (const w of rows) {
    const text = String(w?.text ?? w?.word ?? w?.w ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    let start = Number(w?.start ?? w?.s), end = Number(w?.end ?? w?.e);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, Math.min(start, duration)); end = Math.max(start + 0.02, Math.min(end, duration));
    const p = Number(w?.p ?? w?.probability);
    out.push({ start: round(start), end: round(end), text, ...(Number.isFinite(p) ? { p: Math.round(p * 100) / 100 } : {}) });
  }
  out.sort((a, b) => a.start - b.start);
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) out[i - 1].end = Math.max(out[i - 1].start + 0.02, out[i].start);
  return out;
}

/** Segment-level timings (SRT, FFmpeg whisper) → approximate word timings by character length. */
export function wordsFromSegments(segments = [], lang) {
  const words = [];
  for (const seg of segments) {
    const parts = splitWords(seg.text, lang);
    const span = Number(seg.end) - Number(seg.start);
    if (!parts.length || !(span > 0)) continue;
    const weights = parts.map(p => Math.max(1, p.length) + 1), total = weights.reduce((a, b) => a + b, 0);
    let t = Number(seg.start);
    parts.forEach((text, i) => { const d = span * weights[i] / total; words.push({ start: t, end: t + d * 0.92, text, estimated: true }); t += d; });
  }
  return normalizeWords(words).map(w => ({ ...w, estimated: true }));
}

const CJK_SENTENCE_END = /[。！？]["”')\]」』）]?$/;

/** Readable caption cues from words: breaks at sentence ends, pauses, length and duration. */
export function wordsToCaptions(words, sourceIndex, { maxChars = 42, maxSeconds = 3.2, pause = 0.6, breakBefore = new Set() } = {}) {
  const cues = []; let cur = null;
  const flush = () => { if (cur?.words.length) cues.push({ sourceIndex, start: round(cur.start), end: round(Math.max(cur.end, cur.start + 0.7)), text: joinWords(cur.words).slice(0, 180), words: cur.timed }); cur = null; };
  words.forEach((w, i) => {
    const text = w.text;
    if (cur && (breakBefore.has(i) || w.start - cur.end > pause || (joinWords(cur.words) + ' ' + text).length > maxChars || w.end - cur.start > maxSeconds)) flush();
    if (!cur) cur = { start: w.start, end: w.end, words: [], timed: [] };
    cur.words.push(text); cur.timed.push({ start: round(w.start), end: round(w.end), text: text.slice(0, 40) }); cur.end = w.end;
    if (CJK_SENTENCE_END.test(text) || (/[.!?…]$/.test(text) && joinWords(cur.words).length > 12)) flush();
  });
  flush();
  for (let i = 0; i < cues.length - 1; i++) if (cues[i].end > cues[i + 1].start) cues[i].end = Math.max(cues[i].start + 0.3, cues[i + 1].start - 0.02);
  return cues;
}

export function isFiller(text, language) {
  const b = bare(text);
  if (!b) return false;
  const list = FILLERS[String(language || '').slice(0, 2)];
  return list ? list.includes(b) : ALL_FILLERS.has(b) && !['er', 'em', 'ah'].includes(b);
}
export function findFillers(words, language) { return words.map((w, i) => (isFiller(w.text, language) ? i : -1)).filter(i => i >= 0); }

/** Source ranges to cut for a set of word indices; extends a little into silence but never into kept words. */
export function wordRanges(words, indices, { pad = 0.05 } = {}) {
  const set = new Set(indices);
  const ranges = [];
  for (const i of [...set].sort((a, b) => a - b)) {
    const w = words[i]; if (!w) continue;
    const prevEnd = i > 0 && !set.has(i - 1) ? words[i - 1].end : -Infinity;
    const nextStart = i < words.length - 1 && !set.has(i + 1) ? words[i + 1].start : Infinity;
    let start = Math.max(w.start - pad, prevEnd + 0.01, 0), end = Math.min(w.end + pad, nextStart - 0.01);
    // A removed word next to a removed word: close the gap between them too.
    if (set.has(i + 1) && words[i + 1]) end = Math.max(end, words[i + 1].start);
    if (end > start) ranges.push({ start: round(start), end: round(end) });
  }
  return mergeRanges(ranges);
}

/** Pauses between words longer than `min`; `keep` seconds of air stay on each side. */
export function findPauses(words, { min = 0.8, keep = 0.2, from = 0, to = Infinity } = {}) {
  const out = [];
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1].end, b = words[i].start;
    if (b - a >= min && a >= from && b <= to) out.push({ start: round(a + keep), end: round(b - keep), seconds: round(b - a) });
  }
  return out.filter(r => r.end - r.start >= 0.1);
}

/** Word index ranges whose text matches a phrase (case/punctuation-insensitive). */
export function matchPhrase(words, phrase) {
  const target = splitWords(phrase).map(bare).filter(Boolean);
  if (!target.length) return [];
  const keys = words.map(w => bare(w.text)); const hits = [];
  for (let i = 0; i + target.length <= keys.length; i++) {
    if (target.every((t, k) => keys[i + k] === t)) { hits.push([i, i + target.length - 1]); i += target.length - 1; }
  }
  return hits;
}

/** Which words are in the edit, with their timeline time (first use). */
export function wordsInEdit(words, clips, sourceIndex) {
  const rows = layout(clips).filter(r => r.sourceIndex === sourceIndex);
  return words.map(w => {
    const mid = (w.start + w.end) / 2;
    const r = rows.find(row => mid >= row.start && mid <= row.end);
    return r ? { ...w, inEdit: true, timeline: round(r.timelineStart + (w.start - r.start) / (r.speed || 1)), clipId: r.id } : { ...w, inEdit: false };
  });
}

/** Captions for one source from the words that are still in the edit. Returns every cue:
 *  the caller applies LIMITS.captions and reports what it had to leave out (#105), so a
 *  long talk no longer loses its last minutes here without saying so. */
export function captionsFromEdit(words, clips, sourceIndex, options = {}) {
  const marked = wordsInEdit(words, clips, sourceIndex);
  const kept = [], breakBefore = new Set();
  marked.forEach((w, i) => { if (w.inEdit) { if (i > 0 && !marked[i - 1].inEdit && kept.length) breakBefore.add(kept.length); kept.push(w); } });
  return wordsToCaptions(kept, sourceIndex, { ...options, breakBefore });
}

/** Plain text with optional [mm:ss] stamps every ~20 s; used by agents to read a transcript cheaply. */
export function transcriptText(words, { stamps = true } = {}) {
  let out = '', last = -Infinity;
  words.forEach((w, i) => {
    if (stamps && w.start - last >= 20) { const m = Math.floor(w.start / 60), s = Math.floor(w.start % 60); out += `${out ? '\n' : ''}[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} #${i}] `; last = w.start; }
    else out += ' ';
    out += w.text;
  });
  return out.trim();
}
export { LIMITS };
