// Shared browser/engine contract: captions stay attached to source time, not edit time.
import { LIMITS, overlapOf } from './edit-ops.js';
import { splitWords, joinWords } from './transcript.js';
export function normalizeCaptions(rows = []) {
  if (!Array.isArray(rows) || rows.length > LIMITS.captions) throw new Error(`At most ${LIMITS.captions} caption lines.`);
  return rows.map((c, i) => {
    if (!Number.isInteger(c.sourceIndex) || c.sourceIndex < 0 || c.sourceIndex >= LIMITS.sources
      || !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < 0 || c.end <= c.start || c.end > LIMITS.sourceSeconds) {
      throw new Error(`Invalid caption time at line ${i + 1}.`);
    }
    const text = String(c.text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 180) throw new Error(`Caption ${i + 1}: use 1–180 characters.`);
    const out = { sourceIndex: c.sourceIndex, start: c.start, end: c.end, text };
    // Optional word timings (source seconds) for animated captions; bounded and clamped to the cue.
    if (Array.isArray(c.words) && c.words.length) {
      const words = c.words.slice(0, 40).map(w => ({ start: Number(w.start), end: Number(w.end), text: String(w.text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40) }))
        .filter(w => w.text && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start && w.start >= c.start - 0.05 && w.end <= c.end + 0.05)
        .map(w => ({ start: Math.max(c.start, w.start), end: Math.min(c.end, w.end), text: w.text }));
      if (words.length) out.words = words;
    }
    return out;
  });
}
/** Word timings for a cue: real ones when present, otherwise spread over the cue by word length. */
export function cueWords(cue) {
  if (cue.words?.length) return cue.words;
  const parts = splitWords(cue.text), span = cue.end - cue.start;
  const weights = parts.map(p => p.length + 1), total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = cue.start;
  return parts.map((text, i) => { const d = span * weights[i] / total; const w = { start: t, end: t + d, text }; t += d; return w; });
}
function stamp(value) {
  const m = value.trim().match(/^(\d+):([0-5]\d):([0-5]\d)[,.](\d{3})$/);
  if (!m) throw new Error('SRT requires times like 00:00:01,250.');
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}
function srtBlocks(text) {
  return text.replace(/\r/g, '').trim().split(/\n\s*\n/).filter(Boolean);
}
function cueFromBlock(block, sourceIndex) {
  const lines = block.split('\n'); if (/^\d+$/.test(lines[0].trim())) lines.shift();
  const times = lines.shift()?.split('-->');
  if (times?.length !== 2) throw new Error('Invalid SRT block.');
  const start = stamp(times[0]), end = stamp(times[1].trim().split(/\s+/)[0]);
  const text = lines.join(' ').replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
  if (!text) return null; // A cue with a valid time line but no text is skipped, like parseVttCues.
  return { sourceIndex, start, end, text };
}
export function parseSrt(text, sourceIndex = 0) {
  if (text.length > 128 * 1024) throw new Error('SRT is too large (at most 128 KiB).');
  const blocks = srtBlocks(text.replace(/^\uFEFF/, ''));
  const cues = blocks.map(block => cueFromBlock(block, sourceIndex)).filter(Boolean);
  if (blocks.length && !cues.length) throw new Error('SRT has no captions.');
  return normalizeCaptions(cues);
}
/** Transcript cues: the same SRT shape without the caption limits — a talk has thousands of
 * cues, and importTranscript already caps the file at 32 MiB. */
export function parseSrtCues(text, sourceIndex = 0) {
  return srtBlocks(text.replace(/^\uFEFF/, '')).map(block => cueFromBlock(block, sourceIndex)).filter(Boolean);
}
function vttStamp(value) {
  const m = value.trim().match(/^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/);
  if (!m) throw new Error('VTT requires times like 00:00:04.000.');
  return (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3] + +m[4] / 1000;
}
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
/** Decode the HTML entities WebVTT requires in cue text (`&amp;` `&lt;` `&gt;`) plus the ones
 * YouTube downloads use (`&quot;` `&#39;`/`&apos;` `&nbsp;` as a normal space) and numeric forms
 * like `&#233;` / `&#xE9;`. Unknown named entities are left as written, and one pass decodes
 * exactly once, so `&amp;lt;` stays the literal text `&lt;`. */
function decodeEntities(text) {
  return text.replace(/&(?:[a-z]+|#[0-9]+|#x[0-9a-fA-F]+);/gi, entity => {
    const name = entity.slice(1, -1).toLowerCase();
    if (Object.hasOwn(NAMED_ENTITIES, name)) return NAMED_ENTITIES[name];
    if (name[0] !== '#') return entity;
    const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : +name.slice(1);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}
/** WebVTT as transcript cues: skips the header block (Kind:/Language: lines after WEBVTT) and
 * NOTE/STYLE/REGION blocks, accepts cue identifiers, ignores cue settings after the end time,
 * and reads `mm:ss.ttt` or `hh:mm:ss.ttt` on both sides of --> (YouTube downloads). */
export function parseVttCues(text, sourceIndex = 0) {
  const out = [];
  for (const block of srtBlocks(text)) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if (!lines.length) continue;
    const head = lines[0].trim();
    if (/^WEBVTT($|[\s:])/i.test(head) || /^(NOTE|STYLE|REGION)\b/.test(head)) continue;
    const at = lines.findIndex(l => l.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at].split('-->');
    if (!to) continue;
    const cueText = decodeEntities(lines.slice(at + 1).join(' ').replace(/<[^>]*>/g, '')).trim();
    if (!cueText) continue;
    out.push({ sourceIndex, start: vttStamp(from.trim().split(/\s+/)[0]), end: vttStamp(to.trim().split(/\s+/)[0]), text: cueText });
  }
  return out;
}
export function mapCaptions(rows, clips, offset = 0) {
  const result = []; let cursor = 0;
  clips.forEach((clip, i) => {
    const speed = clip.speed ?? 1;
    cursor -= overlapOf(clips[i - 1], clip);
    for (const cue of rows) {
      if (cue.sourceIndex !== clip.sourceIndex) continue;
      const start = Math.max(clip.start, cue.start + offset), end = Math.min(clip.end, cue.end + offset);
      if (end - start > 0.001) {
        const at = t => cursor + (t - clip.start) / speed;
        const words = cueWords(cue).map(w => ({ start: w.start + offset, end: w.end + offset, text: w.text }))
          .filter(w => (w.start + w.end) / 2 >= start && (w.start + w.end) / 2 <= end)
          .map(w => ({ start: at(Math.max(start, w.start)), end: at(Math.min(end, w.end)), text: w.text }));
        result.push({ start: at(start), end: at(end), text: words.length && words.length < cueWords(cue).length ? joinWords(words.map(w => w.text)) : cue.text, words });
      }
    }
    cursor += (clip.end - clip.start) / speed;
  });
  return result.sort((a, b) => a.start - b.start);
}
function captionTime(value, separator = ',') {
  const ms = Math.round(value * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
}
export function toSrt(rows) { return rows.map((c, i) => `${i + 1}\n${captionTime(c.start)} --> ${captionTime(c.end)}\n${c.text}\n`).join('\n'); }
export function toVtt(rows) {
  const cues = rows.map((c, i) => {
    const text = String(c.text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return `${i + 1}\n${captionTime(c.start, '.')} --> ${captionTime(c.end, '.')}\n${text}\n`;
  });
  return `WEBVTT\n\n${cues.join('\n')}`;
}
