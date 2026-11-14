// A wrong --duration / --fps / --seed used to be silently replaced by another
// number and the whole render ran with it. Validate on the server, where both
// the CLI and POST /api/jobs land, before any job is created (#134).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequest } from '../src/jobs.mjs';
import { requestFromFlags } from '../cli.mjs';

const norm = (extra = {}) => normalizeRequest({ input: 'video.mp4', ...extra });

test('omitted and empty numeric options keep their defaults (#134)', () => {
  const defaults = norm();
  assert.equal(defaults.duration, 60);
  assert.equal(defaults.fps, 60);
  assert.equal(defaults.seed, 42);
  for (const empty of [undefined, null, '']) {
    const r = norm({ duration: empty, fps: empty, seed: empty });
    assert.deepEqual([r.duration, r.fps, r.seed], [60, 60, 42], `empty ${JSON.stringify(empty)}`);
  }
  // Valid values still pass through unchanged.
  const set = norm({ duration: 8, fps: 30, seed: 7 });
  assert.deepEqual([set.duration, set.fps, set.seed], [8, 30, 7]);
  assert.equal(norm({ duration: '120', fps: '24', seed: '0' }).duration, 120);
});

test('a bad or out-of-range number is refused with a stable code and the range (#134)', () => {
  const cases = [
    ['duration', 'INVALID_DURATION', '5 to 300 seconds', ['abc', 0, 4, 301, -1, NaN, Infinity, true, {}, []]],
    ['fps', 'INVALID_FPS', '24 to 120 frames per second', ['abc', 0, 23, 121, NaN, Infinity, true]],
    ['seed', 'INVALID_SEED', '0 to 2147483647', ['abc', -1, 2_147_483_648, NaN, Infinity, true]],
  ];
  for (const [field, code, range, bad] of cases) {
    for (const value of bad) {
      assert.throws(() => norm({ [field]: value }),
        error => error.code === code && new RegExp(`Invalid ${field}: `).test(error.message)
          && error.message.includes(range),
        `${field} = ${JSON.stringify(value)} must be refused with ${code}`);
    }
  }
  // The message names the value the user actually typed, not a coerced number.
  const out = (() => { try { norm({ duration: 'abc' }); } catch (e) { return e; } })();
  assert.match(out.message, /Invalid duration: abc\. Use 5 to 300 seconds\./);
  const zero = (() => { try { norm({ fps: 0 }); } catch (e) { return e; } })();
  assert.match(zero.message, /Invalid fps: 0\. Use 24 to 120 frames per second\./);
});

test('the CLI passes the raw flag through so the error names what was typed (#134)', () => {
  const bad = requestFromFlags({ input: 'video.mp4', duration: 'abc' });
  assert.equal(bad.duration, 'abc');
  assert.throws(() => normalizeRequest(bad), error => error.code === 'INVALID_DURATION'
    && /Invalid duration: abc/.test(error.message));
  assert.throws(() => normalizeRequest(requestFromFlags({ input: 'video.mp4', fps: '0' })),
    error => error.code === 'INVALID_FPS');
  assert.throws(() => normalizeRequest(requestFromFlags({ input: 'video.mp4', seed: 'soon' })),
    error => error.code === 'INVALID_SEED');
  // Leaving the flags out still produces a request with the documented defaults.
  const plain = normalizeRequest(requestFromFlags({ input: 'video.mp4' }));
  assert.deepEqual([plain.duration, plain.fps, plain.seed], [60, 60, 42]);
  const good = normalizeRequest(requestFromFlags({ input: 'video.mp4', duration: '8', fps: '30', seed: '7' }));
  assert.deepEqual([good.duration, good.fps, good.seed], [8, 30, 7]);
});
