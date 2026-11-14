// A 20-minute talk has far more than 300 cues: the caption limit has to follow the
// longest edit the tool allows, and nothing may be dropped without saying so (#105).
import test from 'node:test';
import assert from 'node:assert/strict';
import { captionsFromEdit } from '../public/transcript.js';
import { normalizeCaptions } from '../public/captions.js';
import { LIMITS } from '../public/edit-ops.js';

// 500 sentences of four words, two seconds per sentence: 500 cues over 1000 s.
function longTranscript(sentences = 500) {
  const words = [];
  for (let s = 0; s < sentences; s += 1) {
    for (let k = 0; k < 4; k += 1) {
      const i = s * 4 + k;
      const start = +(i * 0.5).toFixed(3);
      // "wordN" keeps every sentence longer than the 12-character sentence break, so
      // one sentence is exactly one cue (a bare "w0 w1 w2 w3." would join the next one).
      words.push({ start, end: +(start + 0.45).toFixed(3), text: `word${i}${k === 3 ? '.' : ''}` });
    }
  }
  return words;
}

const clip = [{ id: 'a', sourceIndex: 0, start: 0, end: 1000 }];

test('a 20-minute transcript keeps every cue, not the first 300 (#105)', () => {
  const cues = captionsFromEdit(longTranscript(), clip, 0);
  assert.equal(cues.length, 500, `one cue per sentence, got ${cues.length}`);
  assert.ok(cues.length > 300, 'the old 300-cue cap must be gone');
  assert.equal(cues[0].start, 0);
  assert.ok(cues.at(-1).end > 990, `the last cue must reach the end, got ${cues.at(-1).end}`);
});

test('the limit follows the longest edit and normalizeCaptions accepts it (#105)', () => {
  // One readable caption line per second of the longest edit (20 minutes).
  assert.equal(LIMITS.captions, LIMITS.editSeconds);
  const cues = captionsFromEdit(longTranscript(), clip, 0);
  assert.equal(normalizeCaptions(cues).length, 500, '500 cues is a normal length now');
  const tooMany = Array.from({ length: LIMITS.captions + 1 }, (_, i) => ({ sourceIndex: 0, start: i, end: i + 0.9, text: `c${i}` }));
  assert.throws(() => normalizeCaptions(tooMany), new RegExp(`At most ${LIMITS.captions} caption lines`));
  // One cue under the limit still passes, so the boundary is exact.
  assert.equal(normalizeCaptions(tooMany.slice(0, LIMITS.captions)).length, LIMITS.captions);
});
