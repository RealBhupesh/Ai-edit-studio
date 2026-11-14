// 0.11: story documents — compile, beat timing, events, warnings, scene rendering and the two tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileStory, storySummary, renderGeneratedScene, STORY_GUIDE, readSeconds, sceneAss } from '../src/story.mjs';
import { agentTools, callAgentTool } from '../src/agent-tools.mjs';
import { findFfmpegTools } from '../src/ffmpeg.mjs';

const base = (over = {}) => ({ ...STORY_GUIDE.example, size: '720', ...over });
const scene = (id, extra = {}) => ({ id, kind: 'title', beats: 4, lines: ['Hello *there*'], ...extra });

test('the guide example compiles on the beat grid, with events and a drop on a bar line', () => {
  const c = compileStory(base());
  const sum = storySummary(c);
  assert.equal(c.version, 'aes.story/1');
  assert.ok(sum.scenes.length >= 3);
  sum.scenes.forEach((s, i) => { if (i) assert.ok(Math.abs(s.start / c.beat - Math.round(s.start / c.beat)) < 0.01, `${s.id} starts on a beat`); });
  assert.ok(c.drops.every(d => d.onBar), 'guide example drops sit on bar lines');
  assert.equal(c.events[`${c.scenes[0].id}.in`], 0);
  assert.equal(c.cuts.length, c.scenes.length - 1);
});

test('timing: beats × (60 / bpm), transition overlaps the previous scene and ends on the beat', () => {
  const c = compileStory({ version: 'aes.story/1', music: { bpm: 120 }, scenes: [scene('a'), scene('b', { transition: 'fadeblack', transitionSeconds: 0.25 })] });
  assert.equal(c.beat, 0.5);
  assert.equal(c.scenes[1].timelineStart, 2);
  assert.equal(c.scenes[1].clipSeconds, 2.25);
  assert.equal(c.duration, 4);
});

test('a story with an unknown music style, mood or seed is refused before building', () => {
  const good = { bpm: 96, style: 'lofi', mood: 'chill', seed: 42 };
  const c = compileStory(base({ music: good }));
  assert.equal(c.music.style, 'lofi');
  assert.equal(c.music.mood, 'chill');
  assert.equal(c.music.seed, 42);
  assert.equal(compileStory(base()).music.style, undefined, 'a missing style still means no music');
  assert.equal(compileStory(base({ music: { bpm: 96, style: 'pop' } })).music.mood, undefined);
  for (const seed of [0, 1, 42, 2147483647]) {
    const ok = compileStory(base({ music: { ...good, seed } }));
    assert.equal(ok.music.seed, seed, `an integer seed ${seed} is accepted`);
    assert.equal(typeof ok.music.seed, 'number', 'the compiled seed stays a number');
  }
  const bad = [
    ['style', 'polka', /music.style must be one of pop, trap, house, lofi, synthwave, cinematic/],
    ['mood', 'angry', /music.mood must be one of uplifting, emotional, epic, dark, chill, dreamy/],
    ['seed', 'x', /music.seed must be an integer from 0 to 2147483647/],
    ['seed', '42', /music.seed must be an integer from 0 to 2147483647/],
    ['seed', 1.5, /music.seed must be an integer from 0 to 2147483647/],
    ['seed', true, /music.seed must be an integer from 0 to 2147483647/],
    ['seed', '', /music.seed must be an integer from 0 to 2147483647/],
    ['seed', [], /music.seed must be an integer from 0 to 2147483647/],
    ['seed', null, /music.seed must be an integer from 0 to 2147483647/],
    ['seed', -1, /music.seed must be an integer from 0 to 2147483647/],
    ['seed', 2 ** 31, /music.seed must be an integer from 0 to 2147483647/],
  ];
  for (const [field, value, re] of bad) {
    assert.throws(() => compileStory(base({ music: { ...good, [field]: value } })), (err) => {
      assert.equal(err.code, 'INVALID_STORY');
      assert.match(err.message, re);
      return true;
    }, `${field}=${value}`);
  }
});

test('mistakes are refused or warned in plain words', () => {
  assert.throws(() => compileStory({ scenes: [] }), /scenes/);
  assert.throws(() => compileStory({ scenes: [scene('a'), scene('a')] }), /used twice/);
  assert.throws(() => compileStory({ deliver: 'cinema', scenes: [scene('a')] }), /deliver must be/);
  assert.throws(() => compileStory({ scenes: [scene('a')], drops: [{ beat: 99 }] }), /outside the story/);
  const off = compileStory({ music: { bpm: 120 }, scenes: [scene('a')], drops: [{ beat: 3 }] });
  assert.ok(off.warnings.some(w => w.code === 'DROP_OFF_BAR'));
  const fast = compileStory({ music: { bpm: 120 }, scenes: [scene('a', { beats: 1, lines: ['One two three four five six seven'] })] });
  assert.ok(fast.warnings.some(w => w.code === 'READ_TIME'));
  assert.ok(readSeconds('one two') > 0.8);
});

test('studio_guide and studio_apply dryRun work without a running server', async () => {
  assert.ok(agentTools.find(t => t.name === 'studio_apply') && agentTools.find(t => t.name === 'studio_guide'));
  assert.equal((await callAgentTool('studio_guide', { topic: 'story' })).example.version, 'aes.story/1');
  const calls = [], api = async (route, req) => { calls.push({ route, req }); return route === '/health' ? { service: 'AI Edit Studio', version: '0.11.0' } : { ok: true }; };
  await callAgentTool('studio_apply', { story: base(), dryRun: true }, api);
  assert.equal(calls.at(-1).route, '/studio/story/apply');
  assert.equal(calls.at(-1).req.body.dryRun, true);
  await callAgentTool('studio_apply', { action: 'status', buildId: '00000000-0000-0000-0000-000000000001' }, api);
  assert.equal(calls.at(-1).route, '/studio/story/builds/00000000-0000-0000-0000-000000000001');
  await assert.rejects(callAgentTool('studio_apply', {}, api), /needs story/);
  await assert.rejects(callAgentTool('studio_apply', { story: base() }, async r => (r === '/health' ? { service: 'AI Edit Studio', version: '0.10.1' } : {})), /predates/);
});

test('a generated scene renders to the right size and length, and is reused the second time', async t => {
  let tools; try { tools = findFfmpegTools(); } catch { return t.skip('FFmpeg not available'); }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aes-story-'));
  const c = compileStory({ version: 'aes.story/1', size: '720', music: { bpm: 120 }, scenes: [scene('a', { beats: 2 })] });
  const first = await renderGeneratedScene(c, c.scenes[0], dir, { ffmpeg: tools.ffmpeg });
  assert.equal(first.reused, false);
  const again = await renderGeneratedScene(c, c.scenes[0], dir, { ffmpeg: tools.ffmpeg });
  assert.equal(again.reused, true);
  assert.equal(again.file, first.file);
  const { probeMedia } = await import('../src/ffmpeg.mjs');
  const info = await probeMedia(first.file);
  assert.equal(info.video.width, 720); assert.equal(info.video.height, 1280);
  assert.ok(info.duration >= 1 && info.duration < 1.2, `duration ${info.duration}`);
  await fs.rm(dir, { recursive: true, force: true });
});

const bars = (id, extra = {}) => ({ id, kind: 'bars', beats: 8, items: [{ label: 'Before', value: 42 }, { label: 'After', value: 6 }], ...extra });

test('a bars scene compiles, is scheduled on a stagger and fires its done event', () => {
  const c = compileStory({ version: 'aes.story/1', music: { bpm: 120 }, scenes: [scene('a'), bars('b', { title: 'Build time', suffix: ' s' })] });
  const sc = c.scenes[1].schedule;
  assert.equal(sc.bars.length, 2);
  assert.ok(sc.bars[1][0] > sc.bars[0][0], 'bars start one after another');
  assert.ok(c.events['b.done'] > c.events['b.in'] && c.events['b.done'] < c.events['b.out']);
});

test('bars: bad input is refused in plain words', () => {
  const run = extra => compileStory({ scenes: [bars('b', extra)] });
  assert.throws(() => run({ items: [] }), /items needs 1 to 8/);
  assert.throws(() => run({ items: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, value: i })) }), /items needs 1 to 8/);
  assert.throws(() => run({ items: [{ label: 'A', value: -1 }] }), /value must be a number of 0 or more/);
  assert.throws(() => run({ items: [{ label: 'x'.repeat(25), value: 1 }] }), /at most 24 characters/);
  assert.throws(() => run({ max: 10 }), /max .* below the largest value/);
  assert.throws(() => run({ highlight: 2 }), /highlight/);
  assert.throws(() => run({ highlight: -1 }), /highlight/);
});

test('bars: a last value that is on screen for under a second warns', () => {
  const quick = compileStory({ music: { bpm: 120 }, scenes: [bars('b', { beats: 2 })] });
  assert.ok(quick.warnings.some(w => w.code === 'READ_TIME' && w.scene === 'b'));
  const fine = compileStory({ music: { bpm: 120 }, scenes: [bars('b', { beats: 8 })] });
  assert.ok(!fine.warnings.some(w => w.code === 'READ_TIME'));
});

test('bars: the ASS has one bar per item, the widest is the largest value, and the highlight uses the accent', () => {
  const items = [{ label: 'A', value: 10 }, { label: 'B', value: 40 }, { label: 'C', value: 25 }];
  const c = compileStory({ music: { bpm: 120 }, style: { accent: '#112233' }, scenes: [bars('b', { items, highlight: 1 })] });
  const rows = sceneAss(c, c.scenes[0]).split('\n').filter(l => l.startsWith('Dialogue:') && l.includes('\\p1') && l.includes('\\fscx1\\t('));
  assert.equal(rows.length, 3);
  const widths = rows.map(l => { const m = l.match(/\}m (\d+) 0 l (\d+) 0 /); return Number(m[1]) + Number(m[2]); });
  assert.equal(widths.indexOf(Math.max(...widths)), 1);
  assert.ok(widths[0] < widths[2] && widths[2] < widths[1]);
  assert.deepEqual(rows.map(l => l.includes('\\c&H332211&')), [false, true, false]);
});

test('a bars scene renders at the right size and length in every delivery', async t => {
  let tools; try { tools = findFfmpegTools(); } catch { return t.skip('FFmpeg not available'); }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aes-bars-'));
  const { probeMedia } = await import('../src/ffmpeg.mjs');
  const sizes = { 'vertical-share': [720, 1280], 'landscape-share': [1280, 720], square: [720, 720], portrait: [720, 900] };
  for (const [deliver, [width, height]] of Object.entries(sizes)) {
    const c = compileStory({ version: 'aes.story/1', deliver, size: '720', music: { bpm: 120 }, scenes: [bars('b', { beats: 4, title: 'Build time', suffix: ' s', highlight: 1, sourceNote: 'Source: CI logs' })] });
    const out = await renderGeneratedScene(c, c.scenes[0], dir, { ffmpeg: tools.ffmpeg });
    const info = await probeMedia(out.file);
    assert.equal(info.video.width, width, deliver); assert.equal(info.video.height, height, deliver);
    assert.ok(info.duration >= 2 && info.duration < 2.2, `${deliver} duration ${info.duration}`);
  }
  await fs.rm(dir, { recursive: true, force: true });
});
