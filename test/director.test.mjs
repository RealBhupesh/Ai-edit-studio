import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions, validateClips, proposeEdit, validateCaptionSources } from '../src/editing.mjs';
import { normalizeFinish, normalizeTransform, gradeFilter } from '../src/finishing.mjs';
import { EditHistory, splitClip, availableClip } from '../public/edit-history.js';
import { parseSrt, parseSrtCues, parseVttCues, mapCaptions, normalizeCaptions, toSrt, toVtt } from '../public/captions.js';
import { LIMITS } from '../public/edit-ops.js';
import { callAgentTool, agentTools } from '../src/agent-tools.mjs';
import { buildFilter, renderTrailer } from '../src/render.mjs';
import { proposeSilenceCuts } from '../src/silence.mjs';
const source = { file: 'test.mp4', duration: 60, hasAudio: true, black: [], audio: [], video: { width: 1920, height: 1080 }, motion: [], scenes: [] };
const clip = { sourceIndex: 0, start: 0, end: 10, speed: 1, gain: 1 };

test('speed changes rendered duration without extending source spans', () => {
  const p = validateClips([{ ...clip, speed: 2 }, { ...clip, start: 10, end: 15, speed: 0.5 }], [source]);
  assert.equal(p.actualDuration, 15); assert.equal(p.clips[1].timelineStart, 5);
  for (const speed of [0, 4, NaN, Infinity]) assert.throws(() => validateClips([{ ...clip, speed }], [source]));
  assert.throws(() => validateClips([{ ...clip, gain: -1 }], [source]));
});
test('finale is continuous, at trimmed end and never overlaps prelude', () => {
  for (const style of ['flight', 'action']) {
    const p = proposeEdit({ sources: [source] }, { style, duration: 30, trimStart: 5, trimEnd: 5, finaleSeconds: 16 });
    assert.ok(p.actualDuration >= 29 && p.actualDuration <= 30); assert.equal(p.clips.at(-1).start, 39); assert.equal(p.clips.at(-1).end, 55);
    if (p.actualDuration < 30) assert.ok(p.warnings.length);
    assert.ok(p.clips.slice(0, -1).every(c => c.end <= 39));
  }
  assert.throws(() => proposeEdit({ sources: [source] }, { duration: 10, finaleSeconds: 11 }));
  assert.equal(proposeEdit({ sources: [source] }, { duration: 30, finaleSeconds: 30 }).clips.length, 1);
});
test('finish validates all filter inputs and has a true neutral look', () => {
  assert.equal(gradeFilter({ look: 'neutral' }), ''); assert.match(gradeFilter({ look: 'cinema' }), /eq=contrast=/);
  for (const v of [{ look: "a';movie=x" }, { exposure: 5 }, { duckMusic: 'yes' }, { fadeOut: -1 }]) assert.throws(() => normalizeFinish(v));
  assert.equal(normalizeOptions({ fadeOut: 0 }).fadeOut, 0);
});
test('filter preserves no-fade choice, applies clip gains after normalization and ducks music', () => {
  const plan = validateClips([{ ...clip, gain: 0.5, speed: 2 }], [source]);
  const graph = buildFilter(plan, { width: 640, height: 360, fps: 30, gameGain: 1, musicGain: 0.2, musicInputIndex: 1,
    finish: normalizeFinish({ duckMusic: true, reduceRumble: true, fadeOut: 0, fadeIn: 0, look: 'cinema' }) });
  assert.match(graph, /atempo=2/); assert.match(graph, /sidechaincompress/); assert.match(graph, /highpass=f=80/);
  assert.match(graph, /loudnorm=I=-18.*volume=0.5/); assert.doesNotMatch(graph, /\[vcat\]null,fade/);
  assert.doesNotMatch(graph, /maskedmerge/); // No footage-specific cockpit filter for other creators.
});
test('standalone renderer rejects NaN before accessing tools or files', async () => {
  await assert.rejects(() => renderTrailer({ clips: [{ ...clip, duration: NaN }], actualDuration: 10 }, { tools: {} }), /invalid/);
});
test('agent image transforms are explicit, bounded and survive validated edits', () => {
  assert.equal(normalizeTransform().framing, 'fit');
  assert.throws(() => normalizeTransform({ framing: 'fit', zoom: 1.5 }));
  assert.throws(() => normalizeTransform({ framing: 'fill', focusX: 5 }));
  assert.throws(() => normalizeTransform({ mirror: 'true' }));
  const p = validateClips([{ ...clip, framing: 'fill', zoom: 1.25, focusX: 0.2, mirror: true }], [source]);
  assert.equal(p.clips[0].zoom, 1.25);
  const graph = buildFilter(p, { width: 1080, height: 1920, fps: 30, gameGain: 1, musicGain: 0.2, musicInputIndex: 1, narrationInputIndex: 2, narrationStart: 2, narrationGain: 0.8,
    finish: normalizeFinish({ sourceChannel: 'left', duckMusic: true }) });
  assert.match(graph, /hflip/); assert.match(graph, /scale=trunc\(iw\*1.2500\/2\)\*2.*crop=1080:1920:x='\(iw-ow\)\*0.2'/);
  assert.match(graph, /adelay=2000:all=1/); assert.match(graph, /pan=stereo\|c0=c0\|c1=c0/); assert.match(graph, /\[foreground\]asplit/);
  assert.equal(normalizeOptions({ narrationGain: 0 }).narrationGain, 0); assert.throws(() => normalizeOptions({ narrationTrimStart: -1 }));
});
test('undo/redo isolates snapshots, bounds history and truncates redo after edits', () => {
  const h = new EditHistory(3); h.reset({ a: 1 }); h.commit({ a: 2 }); h.commit({ a: 3 });
  const before = h.undo(); before.a = 99; assert.equal(h.redo().a, 3); h.undo(); h.commit({ a: 4 }); assert.equal(h.canRedo, false);
  h.commit({ a: 5 }); assert.equal(h.states.length, 3); assert.equal(h.undo().a, 4);
});
test('split retains speed/gain and rejects invalid or edge cursor', () => {
  assert.equal(splitClip([{ ...clip, speed: 2, gain: 0 }], 0, 4)[1].gain, 0);
  assert.throws(() => splitClip([clip], 0, 0.2)); assert.throws(() => splitClip([clip], -1, 2));
  assert.deepEqual(availableClip([clip], 0, 20), { sourceIndex: 0, start: 10, end: 18, speed: 1, gain: 1 });
});
test('SRT captions follow source trims, reorder, speed and timing correction', () => {
  const cues = parseSrt('1\n00:00:02,000 --> 00:00:04,000\nHello <b>world</b>\n\n2\n00:00:08,000 --> 00:00:10,000\nLanding', 0);
  const mapped = mapCaptions(cues, [{ ...clip, start: 8, end: 10, speed: 2 }, { ...clip, start: 2, end: 4 }]);
  assert.deepEqual(mapped.map(({ words, ...c }) => c), [{ start: 0, end: 1, text: 'Landing' }, { start: 1, end: 3, text: 'Hello world' }]);
  assert.deepEqual(mapped[1].words.map(w => w.text), ['Hello', 'world']);
  assert.match(toSrt(mapped), /00:00:01,000 --> 00:00:03,000/);
  assert.equal(mapCaptions(cues, [clip], 1)[0].start, 3);
  assert.throws(() => parseSrt('1\nnot a time\nHello')); assert.throws(() => normalizeCaptions([{ sourceIndex: 0, start: 5, end: 2, text: 'bad' }]));
  assert.throws(() => validateCaptionSources(cues, [{ duration: 3 }]));
});
test('SRT: one-digit hours and position coordinates after the end time are accepted', () => {
  const pick = ({ start, end, text }) => ({ start, end, text });
  const hour = '1\n0:00:01,000 --> 0:00:02,000\nHi';
  const coords = '1\n00:00:01,000 --> 00:00:02,000 X1:100 X2:200 Y1:10 Y2:20\nHi';
  for (const srt of [hour, coords]) {
    assert.deepEqual(pick(parseSrt(srt)[0]), { start: 1, end: 2, text: 'Hi' });
    assert.deepEqual(pick(parseSrtCues(srt)[0]), { start: 1, end: 2, text: 'Hi' });
  }
  assert.throws(() => parseSrt('1\n00:00:01,000 --> not a time\nHi'), /SRT requires times/);
});
test('SRT: an empty cue is skipped, like the WebVTT importer does', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\n\n\n3\n00:00:05,000 --> 00:00:06,000\nBye\n';
  for (const cues of [parseSrt(srt), parseSrtCues(srt)]) assert.deepEqual(cues.map(c => c.text), ['Hello', 'Bye']);
  // A cue whose text is only tags has no text either.
  assert.deepEqual(parseSrtCues('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}\n\n2\n00:00:03,000 --> 00:00:04,000\nHi\n').map(c => c.text), ['Hi']);
  // A block with no --> line is still invalid, and a bad time still errors even with no text.
  assert.throws(() => parseSrt('1\n00:00:01,000 --> 00:00:02,000\nHi\n\n2\nno time line here\nHello'), /Invalid SRT block/);
  assert.throws(() => parseSrt('1\n00:00:01,000 --> not a time\n'), /SRT requires times/);
  // A file whose only cue is empty: no cues for transcripts, a clear error for captions.
  const only = '1\n00:00:01,000 --> 00:00:02,000\n';
  assert.deepEqual(parseSrtCues(only), []);
  assert.throws(() => parseSrt(only), /SRT has no captions/);
});
test('transcript cues drop the caption limits; VTT reads header, settings, ids and short times', () => {
  const srt = n => Array.from({ length: n }, (_, i) => {
    const at = s => `00:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`;
    return `${i + 1}\n${at(i)} --> ${at(i + 1)}\ncue ${i + 1}`;
  }).join('\n\n');
  // 400 cues is a normal 20-minute talk, so both parsers must read it in full (#105).
  assert.equal(parseSrtCues(srt(400)).length, 400);
  assert.equal(parseSrt(srt(400)).length, 400);
  assert.throws(() => parseSrt(srt(LIMITS.captions + 1)), new RegExp(`At most ${LIMITS.captions} caption lines|too large`));
  assert.ok(parseSrtCues(`1\n00:00:01,000 --> 00:00:02,000\n${'word '.repeat(40)}`)[0].text.length > 180);
  // A talk has more than 300 cues, so the transcript import path must not go through parseSrt.
  const youtube = ['WEBVTT', 'Kind: captions', 'Language: en', '', 'intro', '00:00:04.000 --> 00:00:06.000 align:start position:0%', 'Hello there', '', 'NOTE this block is a comment', '', 'STYLE\n::cue { color: red }', '', '00:01.000 --> 00:04.000', 'Short times on both sides', '', '00:00:10.000 --> 01:02:03.456', 'Full form end'].join('\n');
  const cues = parseVttCues(youtube, 2);
  assert.deepEqual(cues.map(c => [c.sourceIndex, c.start, c.end]), [
    [2, 4, 6], [2, 1, 4], [2, 10, 1 * 3600 + 2 * 60 + 3.456],
  ]);
  assert.deepEqual(cues.map(c => c.text), ['Hello there', 'Short times on both sides', 'Full form end']);
});
test('VTT import decodes HTML entities in cue text after stripping tags', () => {
  const cues = parseVttCues('WEBVTT\n\n00:01.000 --> 00:02.000\nTom &amp; Jerry &lt;3 &quot;hi&quot; &#39;ok&apos; ok&nbsp;é &#233; &#xE9;');
  assert.equal(cues[0].text, 'Tom & Jerry <3 "hi" \'ok\' ok é é é');
  const tagged = parseVttCues('WEBVTT\n\n00:01.000 --> 00:02.000\n&lt;b&gt;bold&lt;/b&gt;');
  assert.equal(tagged[0].text, '<b>bold</b>');
  const proto = parseVttCues('WEBVTT\n\n00:01.000 --> 00:02.000\n&constructor; &amp;lt; &amp;');
  assert.equal(proto[0].text, '&constructor; &lt; &');
});
test('VTT export escapes cue text and round-trips without changing timing or SRT', () => {
  const rows = [
    { start: 0, end: 2, text: 'Tom & Jerry <3 forever' },
    { start: 2, end: 4, text: 'a --> b' },
    { start: 4, end: 6, text: 'Literal &lt;' },
    { start: 6, end: 8, text: 'Ordinary caption' },
    { start: 8, end: 10, text: 'Timecode 00:00:01,250' },
  ];
  const vtt = toVtt(rows);
  assert.equal(vtt, [
    'WEBVTT', '',
    '1', '00:00:00.000 --> 00:00:02.000', 'Tom &amp; Jerry &lt;3 forever', '',
    '2', '00:00:02.000 --> 00:00:04.000', 'a --&gt; b', '',
    '3', '00:00:04.000 --> 00:00:06.000', 'Literal &amp;lt;', '',
    '4', '00:00:06.000 --> 00:00:08.000', 'Ordinary caption', '',
    '5', '00:00:08.000 --> 00:00:10.000', 'Timecode 00:00:01,250', '',
  ].join('\n'));
  assert.deepEqual(parseVttCues(vtt), rows.map(row => ({ sourceIndex: 0, ...row })));
  assert.equal(toSrt(rows.slice(0, 2)), [
    '1', '00:00:00,000 --> 00:00:02,000', 'Tom & Jerry <3 forever', '',
    '2', '00:00:02,000 --> 00:00:04,000', 'a --> b', '',
  ].join('\n'));
});
test('SRT import drops ASS override blocks but keeps literal braces', () => {
  const srt = String.raw`1
00:00:01,000 --> 00:00:03,000
{\an8}Hello <b>there</b>

2
00:00:04,000 --> 00:00:06,000
{\i1}{\pos(10,20)} {bonus} keep me
`;
  for (const cues of [parseSrt(srt, 0), parseSrtCues(srt, 0)]) assert.deepEqual(cues.map(c => c.text), ['Hello there', '{bonus} keep me']);
  assert.equal(parseSrt(String.raw`1
00:00:01,000 --> 00:00:03,000
{\an8}Top line`, 0)[0].text, 'Top line');
});
test('silence proposal is non-mutating, preserves padding and protected final shot', () => {
  const s = { ...source, audio: Array.from({ length: 20 }, (_, i) => ({ time: i / 2, value: i >= 6 && i < 12 ? -90 : -10 })) };
  const plan = validateClips([clip], [s]); const before = JSON.stringify(plan);
  const result = proposeSilenceCuts(plan, [s]); assert.equal(result.removedSeconds, 2.6); assert.equal(result.plan.clipCount, 2);
  assert.equal(JSON.stringify(plan), before); assert.equal(proposeSilenceCuts(plan, [s], { protectFinale: true }).removedSeconds, 0);
  assert.throws(() => proposeSilenceCuts(plan, [source]), /Analyze/);
});
test('agent identity accepts the new brand and existing running servers only', async () => {
  for (const service of ['AI Edit Studio', 'Game Trailer Studio']) {
    const result = await callAgentTool('studio_list', {}, async route => route === '/health'
      ? { service, version: '0.3.0-beta.1' } : { projects: [] });
    assert.deepEqual(result, { projects: [] });
  }
  await assert.rejects(() => callAgentTool('studio_list', {}, async () => ({ service: 'Unrelated app', version: '0.3.0' })), /restart/);
});

test('agent contract validates boundaries and merges options without lost settings', async () => {
  const id = '00000000-0000-0000-0000-000000000001'; const calls = [];
  const api = async (route, request) => { calls.push({ route, request }); if (route === '/health') return { service: 'Game Trailer Studio', version: '0.3.0-beta.1' }; return { project: { revision: 2, options: { title: 'Keep me', look: 'cinema' } } }; };
  await callAgentTool('studio_update', { projectId: id, revision: 2, options: { musicGain: 0 } }, api);
  assert.equal(calls.find(c => c.request?.method === 'PATCH').request.body.options.title, 'Keep me'); assert.equal(calls.find(c => c.request?.method === 'PATCH').request.body.options.musicGain, 0);
  await assert.rejects(() => callAgentTool('studio_update', { projectId: id, revision: 1 }, api), /changed/);
  await assert.rejects(() => callAgentTool('studio_render', { projectId: '../escape', revision: 2 }, api));
  await assert.rejects(() => callAgentTool('studio_create', { name: 'x', inputs: ['x'], options: { unknown: 1 } }, api));
  assert.equal((await callAgentTool('studio_schema', {}, api)).tools.length, agentTools.length);
  await assert.rejects(() => callAgentTool('studio_list', {}, async () => ({ service: 'Game Trailer Studio', version: '0.2.0' })), /restart/);
});
