import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyOperations, mergeRanges, subtractRanges, totalDuration, coreClip } from '../public/edit-ops.js';
import { normalizeWords, wordsFromSegments, wordsToCaptions, findFillers, isFiller, wordRanges, findPauses, matchPhrase, wordsInEdit, captionsFromEdit, transcriptText } from '../public/transcript.js';
import { motionTrack, focusFromTrack, reframeOperations } from '../src/reframe.mjs';
import { buildAutoEdit, usableIntervals, windows, hookCandidates, PLATFORMS } from '../src/autoedit.mjs';
import { buildPublishPack, chapters, metadataDrafts, hashtags, frameQuality, wrapTitle } from '../src/publish.mjs';
import { findFfmpegTools } from '../src/ffmpeg.mjs';
import { parseWhisperJson, MODEL_ORDER } from '../src/transcribe.mjs';
import { buildFilter, filterColors, captionDrawStyle, textDrawStyle } from '../src/render.mjs';
import { normalizeTransform } from '../src/finishing.mjs';
import { agentTools, validateArguments, callAgentTool, OPERATIONS } from '../src/agent-tools.mjs';
import { curvesFor } from '../public/insights.js';
import { reviewEdit } from '../public/insights.js';

const words = normalizeWords([
  { start: 0.0, end: 0.3, text: 'Hello' }, { start: 0.35, end: 0.6, text: 'um,' }, { start: 0.7, end: 1.0, text: 'this' },
  { start: 1.05, end: 1.3, text: 'is' }, { start: 1.35, end: 1.8, text: 'Apache.' }, { start: 3.4, end: 3.7, text: 'Laser' },
  { start: 3.75, end: 4.1, text: 'locked' }, { start: 4.15, end: 4.3, text: 'uh' }, { start: 4.4, end: 4.9, text: 'fire!' },
]);
const state = clips => ({ clips, options: {} });
const sources = [{ duration: 10 }, { duration: 10 }];

test('ranges merge and subtract', () => {
  assert.deepEqual(mergeRanges([{ start: 2, end: 3 }, { start: 0, end: 1 }, { start: 2.9, end: 4 }]), [{ start: 0, end: 1 }, { start: 2, end: 4 }]);
  assert.deepEqual(subtractRanges(0, 10, [{ start: 2, end: 3 }, { start: 5, end: 6 }]), [[0, 2], [3, 5], [6, 10]]);
  assert.deepEqual(subtractRanges(0, 10, [{ start: -1, end: 11 }]), []);
});

test('remove_ranges cuts source ranges out of every clip, drops slivers and keeps ids', () => {
  const next = applyOperations(state([{ id: 'a', sourceIndex: 0, start: 0, end: 6, transition: 'fade', transitionSeconds: 0.5 }, { id: 'b', sourceIndex: 1, start: 0, end: 3 }]),
    [{ op: 'remove_ranges', sourceIndex: 0, ranges: [{ start: 1, end: 2 }, { start: 5.8, end: 9 }, { start: 2.2, end: 2.4 }], smooth: true }], { sources });
  assert.deepEqual(next.clips.map(c => [c.sourceIndex, c.start, c.end]), [[0, 0, 1], [0, 2.4, 5.8], [1, 0, 3]]); // 2–2.2 sliver dropped
  assert.equal(next.clips[0].id, 'a');
  assert.equal(next.clips[1].transition, 'fade'); assert.equal(next.clips[1].transitionSeconds, 0.12);
  assert.throws(() => applyOperations(state([{ id: 'a', sourceIndex: 0, start: 0, end: 2 }]), [{ op: 'remove_ranges', sourceIndex: 0, ranges: [{ start: 0, end: 2 }] }], { sources }), /entire edit/);
  assert.ok(OPERATIONS.includes('remove_ranges'));
});

test('transcript helpers: fillers, pauses, phrases, captions and edit mapping', () => {
  assert.equal(words[1].text, 'um,');
  assert.deepEqual(findFillers(words, 'en'), [1, 7]);
  assert.ok(isFiller('Ehm', 'nl')); assert.ok(!isFiller('er', 'nl')); assert.ok(!isFiller('like', 'en'));
  const ranges = wordRanges(words, [1]);
  assert.equal(ranges.length, 1); assert.ok(ranges[0].start >= 0.3 && ranges[0].end <= 0.7);
  const pauses = findPauses(words, { min: 1, keep: 0.2 });
  assert.equal(pauses.length, 1); assert.equal(pauses[0].start, 2); assert.equal(pauses[0].end, 3.2);
  assert.deepEqual(matchPhrase(words, 'laser LOCKED'), [[5, 6]]);
  const cues = wordsToCaptions(words, 0);
  assert.ok(cues.length >= 2); assert.ok(cues.every(c => c.end > c.start && c.text.length <= 42));
  const clips = [{ id: 'x', sourceIndex: 0, start: 0, end: 2 }, { id: 'y', sourceIndex: 0, start: 3.3, end: 5 }];
  const marked = wordsInEdit(words, clips, 0);
  assert.ok(marked.every(w => w.inEdit));
  assert.equal(marked[5].timeline, 2.1);
  const after = applyOperations(state(clips), [{ op: 'remove_ranges', sourceIndex: 0, ranges: wordRanges(words, findFillers(words, 'en')) }], { sources }).clips;
  const kept = captionsFromEdit(words, after, 0);
  assert.ok(!kept.some(c => /\bum\b|\buh\b/.test(c.text)), JSON.stringify(kept));
  assert.match(transcriptText(words), /^\[00:00 #0\] Hello um, this/);
  const est = wordsFromSegments([{ start: 10, end: 12, text: 'one two three' }]);
  assert.equal(est.length, 3); assert.ok(est[0].estimated && est[2].end <= 12);
});

test('whisper.cpp -ojf parsing joins sub-word tokens and skips special tokens', () => {
  const json = { result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 2000 }, text: ' Laser locked.', tokens: [
    { text: '[_BEG_]', offsets: { from: 0, to: 0 }, p: 1 }, { text: ' La', offsets: { from: 100, to: 300 }, p: 0.9 }, { text: 'ser', offsets: { from: 300, to: 500 }, p: 0.8 },
    { text: ' locked', offsets: { from: 600, to: 1100 }, p: 0.95 }, { text: '.', offsets: { from: 1100, to: 1150 }, p: 0.99 }, { text: '[_TT_100]', offsets: { from: 2000, to: 2000 }, p: 1 }] }] };
  const parsed = parseWhisperJson(json);
  assert.equal(parsed.language, 'en');
  assert.deepEqual(parsed.words.map(w => w.text), ['Laser', 'locked.']);
  assert.equal(parsed.words[0].start, 0.1); assert.equal(parsed.words[0].end, 0.5); assert.equal(parsed.words[0].p, 0.8);
  assert.ok(MODEL_ORDER.includes('base'));
});

test('focus pan: transform validation, render expression and coreClip cleanup', () => {
  const t = normalizeTransform({ framing: 'fill', focusX: 0.2, focusXEnd: 0.8 });
  assert.equal(t.focusXEnd, 0.8); assert.equal(t.focusYEnd, 0.5);
  assert.throws(() => normalizeTransform({ focusX: 0.2, focusXEnd: 0.8 }), /crop/);
  const graph = buildFilter({ actualDuration: 3, clips: [{ source: 'a.mp4', start: 0, end: 3, duration: 3, speed: 1, hasAudio: false, framing: 'fill', zoom: 1, focusX: 0.2, focusXEnd: 0.8, focusY: 0.5 }] }, { width: 1080, height: 1920, fps: 30, vertical: true });
  assert.match(graph, /crop=1080:1920:x='\(iw-ow\)\*\(0\.2\+\(0\.6000\)\*\(st\(0,clip\(t\/3\.000,0,1\)\)/);
  const kb = buildFilter({ actualDuration: 3, clips: [{ source: 'a.mp4', start: 0, end: 3, duration: 3, speed: 1, hasAudio: true, framing: 'fill', zoom: 1, zoomEnd: 1.3, focusX: 0.2, focusXEnd: 0.8, focusY: 0.5 }] }, { width: 1080, height: 1920, fps: 30, vertical: true });
  assert.match(kb, /zoompan=.*x='\(iw-iw\/zoom\)\*\(0\.2\+.*ot\/3\.000/);
  assert.match(kb, /apad,atrim=duration=3\.000,asetpts=N\/SR\/TB/);
  assert.deepEqual(coreClip({ sourceIndex: 0, start: 0, end: 1, framing: 'fill', focusX: 0.3, focusXEnd: 0.3, focusYEnd: 0.5 }), { sourceIndex: 0, start: 0, end: 1, framing: 'fill', focusX: 0.3, speed: 1, gain: 1 });
  const next = applyOperations(state([{ id: 'a', sourceIndex: 0, start: 0, end: 4 }]), [{ op: 'set', clip: 'a', focusX: 0.1, focusXEnd: 0.9 }], { sources });
  assert.equal(next.clips[0].framing, 'fill'); assert.equal(next.clips[0].focusXEnd, 0.9);
});

test('motion tracking follows a moving blob and turns it into a pan', () => {
  const W = 96, H = 54, frames = [];
  for (let f = 0; f < 30; f++) {
    const b = Buffer.alloc(W * H, 30);
    const cx = Math.round(8 + f * 2.6);
    for (let y = 22; y < 32; y++) for (let x = cx; x < cx + 8; x++) b[y * W + x] = 230;
    frames.push(b);
  }
  const track = motionTrack(frames, 6);
  assert.ok(track[2].x < 0.3 && track.at(-2).x > 0.7, `${track[2].x} → ${track.at(-2).x}`);
  const focus = focusFromTrack(track, 16 / 9, 9 / 16);
  assert.equal(focus.pan, true); assert.ok(focus.focusX < 0.25 && focus.focusXEnd > 0.75); assert.equal(focus.confidence, 'high');
  const still = focusFromTrack(track.map(p => ({ ...p, x: 0.5 })), 16 / 9, 9 / 16);
  assert.equal(still.pan, false); assert.equal(still.focusX, 0.5);
  assert.equal(focusFromTrack(track, 16 / 9, 16 / 9).focusX, 0.5, 'same aspect: no horizontal reframe');
  const ops = reframeOperations([{ id: 'a', focus }, { id: 'b', skipped: 'still' }]);
  assert.equal(ops.length, 1); assert.equal(ops[0].framing, 'fill'); assert.equal(ops[0].focusXEnd, focus.focusXEnd);
});

function analyzedSource(duration, energyAt, extra = {}) {
  const motion = [], audio = [];
  for (let t = 0; t < duration; t += 0.25) { motion.push({ time: t, value: energyAt(t) * 40 }); audio.push({ time: t, value: -60 + energyAt(t) * 45 }); }
  return { file: `/v/${duration}.mp4`, duration, hasAudio: true, video: { width: 1920, height: 1080 }, motion, audio, scenes: [], black: [], ...extra };
}

test('auto-edit: highlights with best hook, no repeated footage, platform options and review', () => {
  const src = analyzedSource(60, t => (t > 40 && t < 44 ? 1 : t > 10 && t < 14 ? 0.8 : 0.2 + 0.1 * Math.sin(t)), { black: [{ start: 50, end: 53, duration: 3 }] });
  const out = buildAutoEdit({ sources: [src], options: {}, goal: { platform: 'tiktok', hookText: 'WATCH THIS', cta: 'Follow' } });
  assert.equal(out.report.platform, 'tiktok');
  assert.ok(out.report.duration <= PLATFORMS.tiktok.duration + 1.5 && out.report.duration >= 15, String(out.report.duration));
  const first = out.clips[0];
  assert.ok(first.start >= 39 && first.start <= 44, `hook starts at ${first.start}`);
  for (let i = 0; i < out.clips.length; i++) for (let j = i + 1; j < out.clips.length; j++) {
    const a = out.clips[i], b = out.clips[j];
    assert.ok(Math.min(a.end, b.end) - Math.max(a.start, b.start) <= 0.001, 'no repeated footage');
  }
  assert.ok(out.clips.every(c => c.end <= 50.001 || c.start >= 53), 'black frames skipped');
  assert.equal(out.options.captionStyle, 'bold'); assert.equal(out.options.endTitle, 'Follow');
  assert.equal(out.options.texts[0].text, 'WATCH THIS');
  assert.ok(out.variants.length >= 2 && out.variants[0].hook >= out.variants.at(-1).hook);
  assert.ok(out.report.review.score >= 60);
});

test('auto-edit keep:"most" keeps nearly all footage in order with few cuts', () => {
  const src = analyzedSource(40, t => (t > 20 && t < 26 ? 0.01 : 0.5));
  const out = buildAutoEdit({ sources: [src], options: {}, goal: { platform: 'vlog', hook: false } });
  assert.equal(out.report.keep, 'most');
  assert.ok(out.report.footageUsedPercent >= 95);
  assert.ok(out.clips.length <= 3, `${out.clips.length} clips`);
  assert.ok(out.clips.every(c => c.end <= 21 || c.start >= 25), 'dead stretch removed');
  assert.ok(out.clips.every((c, i) => !i || c.start > out.clips[i - 1].start), 'recorded order');
  assert.ok(out.clips.slice(1).every(c => c.transition === 'fade'));
});

test('auto-edit helpers and transcript captions', () => {
  const src = analyzedSource(20, t => (t > 12 ? 0.9 : 0.3), { scenes: [8] });
  const curves = curvesFor([src]);
  const iv = usableIntervals([src], curves, {});
  assert.deepEqual(iv, [{ sourceIndex: 0, start: 0, end: 20 }]);
  const w = windows(iv, [src], curves, 3);
  assert.ok(w.some(x => x.end === 8 || x.start === 8), 'snapped to scene cut');
  assert.ok(w.at(-1).end === 20);
  assert.ok(hookCandidates(iv, [src], curves)[0].start >= 12);
  const out = buildAutoEdit({ sources: [src], options: {}, goal: { platform: 'youtube', duration: 15 }, transcripts: { 0: { words: [{ start: 12.2, end: 12.6, text: 'Go' }, { start: 12.7, end: 13.1, text: 'now!' }] } } });
  assert.ok(out.options.captions.length >= 1);
  assert.throws(() => buildAutoEdit({ sources: [src], goal: { platform: 'myspace' } }), /Unknown platform/);
});

test('publish: chapters, drafts, hashtags and frame quality', () => {
  const clips = [{ sourceIndex: 0, start: 0, end: 15, label: 'Intro' }, { sourceIndex: 0, start: 20, end: 40, label: 'Takeoff' }, { sourceIndex: 0, start: 50, end: 70, label: 'Attack' }, { sourceIndex: 0, start: 80, end: 95, label: 'Landing' }];
  const ch = chapters(clips, {});
  assert.deepEqual(ch.map(c => c.line), ['00:00 Intro', '00:15 Takeoff', '00:35 Attack', '00:55 Landing']);
  assert.deepEqual(chapters(clips.slice(0, 2), {}), []);
  const tags = hashtags('AH-64 Apache laser guided missiles', 'Our helicopter game');
  assert.ok(tags.includes('apache') && tags.includes('laser') && !tags.includes('our'));
  // filler words stay out and the topic words survive (#61)
  assert.deepEqual(hashtags('Everything about our new update', 'Here are some things that would make your base better and where to find them'), ['update', 'base', 'find']);
  assert.deepEqual(hashtags('Alles over onze nieuwe update', 'Hier zijn enkele dingen die jouw basis beter maken, omdat ze echt werken'), ['update', 'basis']);
  const d = metadataDrafts({ title: 'Apache strike', brief: 'Cockpit footage.', cta: 'Wishlist now', chapterList: ch, tags, platforms: ['youtube', 'x', 'shorts'] });
  assert.equal(d.youtube.title, 'Apache strike'); assert.match(d.youtube.description, /00:15 Takeoff/);
  assert.ok(d.x.description.length <= 280); assert.ok(d.shorts.hashtags.includes('#shorts'));
  assert.ok(Object.values(d).every(x => x.draft === true));
  const flat = Buffer.alloc(160 * 90, 128), busy = Buffer.from(Array.from({ length: 160 * 90 }, (_, i) => ((i * 7919) % 255)));
  assert.ok(frameQuality(busy).score > frameQuality(flat).score);
  assert.equal(frameQuality(Buffer.alloc(160 * 90, 5)).mean, 5);
});

test('publish: chapters use sections before markers or clip labels', () => {
  const clips = [
    { id: 'a', sourceIndex: 0, start: 0, end: 40 },
    { id: 'b', sourceIndex: 0, start: 40, end: 80 },
    { id: 'c', sourceIndex: 0, start: 80, end: 120 },
  ];
  const sections = [
    { name: 'Setup', clip: 'a' },
    { name: 'Build', clip: 'b' },
    { name: 'Result', clip: 'c' },
  ];
  const expected = ['00:00 Setup', '00:40 Build', '01:20 Result'];

  // Sections produce chapters even when the clips have no labels.
  assert.deepEqual(
    chapters(clips, { sections }).map(c => c.line),
    expected
  );

  const labelledClips = clips.map((clip, i) => ({
    ...clip,
    label: `Clip ${i + 1}`,
  }));
  const markers = [
    { time: 0, label: 'Marker A' },
    { time: 40, label: 'Marker B' },
    { time: 80, label: 'Marker C' },
  ];

  // Sections take precedence over both markers and clip labels.
  assert.deepEqual(
    chapters(labelledClips, { sections, markers }).map(c => c.line),
    expected
  );

  // An empty sections list preserves the marker fallback.
  assert.deepEqual(
    chapters(labelledClips, { sections: [], markers }).map(c => c.line),
    ['00:00 Marker A', '00:40 Marker B', '01:20 Marker C']
  );

  // Too few sections must not fall back to otherwise valid markers or labels.
  assert.deepEqual(
    chapters(labelledClips, { sections: sections.slice(0, 2), markers }),
    []
  );
});

test('publish: hashtags preserve Japanese voiced kana', () => {
  assert.deepEqual(
    hashtags('新しいアップデートが公開されました', 'ゲームの新しいステージ'),
    ['新しいアップデートが公開されました', 'ゲームの新しいステージ']
  );

  assert.deepEqual(hashtags('アップデート'), ['アップデート']);
});

test('publish: hashtags still fold Latin accents', () => {
  assert.deepEqual(hashtags('Café CAFÉ résumé'), ['cafe', 'resume']);
});

test('publish: German hashtags skip function words and keep topic words', () => {
  assert.deepEqual(
    hashtags('Das ist nicht das Spiel, aber auch wirklich schön und viele andere Dinge'),
    ['spiel', 'wirklich', 'schon']
  );
});

test('publish: French hashtags skip function words and keep topic words', () => {
  assert.deepEqual(
    hashtags('Nous avons dans cette vidéo beaucoup de choses pour vous'),
    ['video']
  );
});

test('publish: Spanish hashtags skip function words and keep topic words', () => {
  assert.deepEqual(
    hashtags('Esto es para todos los jugadores, pero también muchas cosas'),
    ['jugadores']
  );
});

test('publish: hashtags preserve English and Dutch examples', () => {
  assert.deepEqual(
    hashtags('This is about the Apache helicopter with laser guided missiles'),
    ['apache', 'helicopter', 'laser', 'guided', 'missiles']
  );

  assert.deepEqual(
    hashtags('Deze video gaat over onze nieuwe Apache helikopter met laser'),
    ['video', 'gaat', 'apache', 'helikopter', 'laser']
  );
});

test('publish: a long brief is shortened so the call to action and the hashtags still fit', () => {
  const d = metadataDrafts({ title: 'T', brief: 'word '.repeat(100), cta: 'Wishlist now', tags: ['gamedev', 'indie'], platforms: ['x', 'steam'] });
  assert.ok(d.x.description.length <= 280);
  assert.ok(d.x.description.startsWith('word word'), d.x.description.slice(0, 20));
  assert.match(d.x.description, /…/);
  assert.ok(d.x.description.endsWith('Wishlist now\n\n#gamedev #indie'), d.x.description.slice(-40));
  assert.deepEqual(d.x.hashtags, ['#gamedev', '#indie']);
  const short = metadataDrafts({ title: 'T', brief: 'Short brief.', cta: 'Wishlist now', tags: ['gamedev'], platforms: ['x'] });
  assert.equal(short.x.description, 'Short brief.\n\nWishlist now\n\n#gamedev');
  const words = metadataDrafts({ title: 'T', brief: 'bravo '.repeat(60), platforms: ['steam'] });
  assert.ok(words.steam.description.length <= 300);
  assert.ok(words.steam.description.endsWith('bravo…'), words.steam.description.slice(-12));
});

test('publish: title and brief cuts never end in half an emoji', () => {
  const loneSurrogate = s => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s);
  // Emoji straddling the 100-unit title limit is dropped, not split.
  const cutTitle = metadataDrafts({ title: `${'a'.repeat(99)}🎬 extra text`, brief: '', platforms: ['youtube'] });
  assert.equal(cutTitle.youtube.title, 'a'.repeat(99));
  assert.ok(!loneSurrogate(cutTitle.youtube.title));
  // An emoji that fits entirely inside the limit is kept.
  const fits = metadataDrafts({ title: `${'a'.repeat(98)}🎬`, brief: '', platforms: ['youtube'] });
  assert.equal(fits.youtube.title, `${'a'.repeat(98)}🎬`);
  // A brief shortened for x ends cleanly when the cut lands mid-emoji.
  const brief = `${'a'.repeat(254)}🎬 tail words here to pad the brief out a bit more so it needs shortening`;
  const x = metadataDrafts({ title: 'T', brief, cta: 'Wishlist now', tags: ['gamedev'], platforms: ['x'] });
  assert.ok(x.x.description.length <= 280);
  assert.ok(!loneSurrogate(x.x.description));
  assert.match(x.x.description, /…/);
});

test('publish drafts deduplicate hashtags before applying each platform limit', () => {
  const tags = ['GameDev', 'Shorts', ...hashtags('GameDev trailer shorts')];
  const d = metadataDrafts({ title: 'GameDev trailer', tags, platforms: ['shorts'] });
  assert.deepEqual(d.shorts.hashtags, ['#shorts', '#GameDev', '#trailer']);
  const x = metadataDrafts({ title: 'T', tags: ['GameDev', 'gamedev', 'Indie'], platforms: ['x'] }).x;
  assert.deepEqual(x.hashtags, ['#GameDev', '#Indie']);
});

test('publish pack deduplicates brand and title hashtags before taking six', async t => {
  let tools; try { tools = findFfmpegTools(); } catch { return t.skip('FFmpeg not available'); }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aes-publish-tags-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'still.ppm');
  await fs.writeFile(file, 'P3\n2 2\n255\n255 0 0  0 255 0\n0 0 255  255 255 255\n');
  const project = {
    id: 'test', revision: 1, sources: [{ file, still: true }],
    options: { title: 'GameDev trailer launch' },
    plan: { clips: [{ id: 'clip', sourceIndex: 0, start: 0, end: 2 }] }
  };
  const brand = { hashtags: ['GameDev', 'GAMEDEV', 'Indie', 'INDIE', 'DevLog', 'DEVLOG'] };
  const pack = await buildPublishPack(project, path.join(dir, 'pack'), { platforms: ['youtube'], thumbnails: 1 }, { brand, tools });
  assert.deepEqual(pack.drafts.youtube.hashtags, ['#GameDev', '#Indie', '#DevLog', '#trailer', '#launch']);
});

test('brand colours stay numeric in filters', () => {
  assert.deepEqual(filterColors({ primary: '#ff0000', accent: 'red;drawtext', text: undefined }), { primary: '0xFF0000', accent: '0xF7CF72', text: '0xFFFFFF' });
  assert.match(captionDrawStyle('box', 'low', 1920, false, { primary: '#123456' }), /boxcolor=0x123456@0.72/);
  assert.match(captionDrawStyle('box', 'low', 1920, false), /boxcolor=black@0.72/);
  assert.match(textDrawStyle('note', 'center', 1920, false, { accent: '#00FF00' }), /fontcolor=0x00FF00/);
  const graph = buildFilter({ actualDuration: 2, clips: [{ source: 'a.mp4', start: 0, end: 2, duration: 2, speed: 1, hasAudio: false }] }, { width: 1920, height: 1080, fps: 30, logoInputIndex: 1, logoPosition: 'bottom-right', logoOpacity: 0.5 });
  assert.match(graph, /colorchannelmixer=aa=0\.500/); assert.match(graph, /overlay=x=W-w-W\*0\.04:y=H-h-H\*0\.05/);
});

test('publish: titles that fit keep their original wrapping', () => {
  assert.equal(wrapTitle('The Last Lighthouse Keeper: A', 12), 'The Last\nLighthouse\nKeeper: A');
});

test('publish: truncated titles show an ellipsis within the third line limit', () => {
  assert.equal(wrapTitle('The Last Lighthouse Keeper: A Story About Courage', 12), 'The Last\nLighthouse\nKeeper: A…');
  assert.equal(wrapTitle('alpha bravo charlie d echo', 9), 'alpha\nbravo\ncharlie…');
  assert.equal(wrapTitle('alpha bravo abcdefghijkl echo', 9), 'alpha\nbravo\nabcdefgh…');
});

test('publish: a first chapter before 10 s moves to 0:00 instead of getting an Intro', () => {
  const clips = [{ sourceIndex: 0, start: 0, end: 120 }];
  const early = chapters(clips, { markers: [{ time: 4, label: 'Setup' }, { time: 20, label: 'Fight' }, { time: 40, label: 'Boss' }] });
  assert.deepEqual(early.map(c => c.line), ['00:00 Setup', '00:20 Fight', '00:40 Boss']);
  assert.ok(early.every((c, i) => i === 0 || c.time - early[i - 1].time >= 10));
  const late = chapters(clips, { markers: [{ time: 12, label: 'Setup' }, { time: 30, label: 'Fight' }, { time: 50, label: 'Boss' }] });
  assert.deepEqual(late.map(c => c.line), ['00:00 Intro', '00:12 Setup', '00:30 Fight', '00:50 Boss']);
  assert.ok(late.every((c, i) => i === 0 || c.time - late[i - 1].time >= 10));
});

test('Director 0.6 agent tools validate and route', async () => {
  const names = agentTools.map(t => t.name);
  for (const n of ['studio_auto_edit', 'studio_transcribe', 'studio_transcript', 'studio_text_edit', 'studio_reframe', 'studio_publish_pack', 'studio_brand']) assert.ok(names.includes(n), n);
  assert.ok(agentTools.length >= 30);
  const tool = n => agentTools.find(t => t.name === `studio_${n}`).inputSchema;
  const id = '00000000-0000-0000-0000-000000000001';
  validateArguments({ projectId: id, platform: 'tiktok', reframe: false, render: true }, tool('auto_edit'));
  validateArguments({ projectId: id, reframe: '4:5' }, tool('auto_edit'));
  assert.throws(() => validateArguments({ projectId: id, reframe: true }, tool('auto_edit')), /no allowed form/);
  validateArguments({ projectId: id, revision: 3, removePauses: { min: 1 }, removeFillers: true }, tool('text_edit'));
  validateArguments({ projectId: id, revision: 3, removePauses: true, assemble: [{ from: 0, to: 5 }] }, tool('text_edit'));
  const calls = [];
  const api = async (route, request) => { calls.push({ route, request }); return route === '/health' ? { service: 'AI Edit Studio', version: '0.6.0-beta.1' } : { ok: true }; };
  await callAgentTool('studio_auto_edit', { projectId: id, platform: 'reels' }, api); assert.equal(calls.at(-1).route, `/studio/projects/${id}/auto-edit`);
  await callAgentTool('studio_transcript', { projectId: id, sourceIndex: 1, format: 'text' }, api); assert.equal(calls.at(-1).route, `/studio/projects/${id}/transcript?sourceIndex=1&format=text`);
  await callAgentTool('studio_transcript', { projectId: id, action: 'import', file: 'C:/a.srt' }, api); assert.equal(calls.at(-1).request.method, 'POST');
  await callAgentTool('studio_brand', { action: 'save', name: 'Acme', primary: '#112233' }, api); assert.deepEqual(calls.at(-1).request.body, { name: 'Acme', primary: '#112233' });
  await callAgentTool('studio_brand', { action: 'apply', name: 'Acme', projectId: id, revision: 2 }, api); assert.equal(calls.at(-1).route, `/studio/projects/${id}/brand`);
  await callAgentTool('studio_publish_pack', { projectId: id }, api); assert.equal(calls.at(-1).route, `/studio/projects/${id}/publish`);
  const old = async route => (route === '/health' ? { service: 'AI Edit Studio', version: '0.5.0-beta.1' } : {});
  await assert.rejects(() => callAgentTool('studio_reframe', { projectId: id, revision: 1 }, old), /restart Studio 0\.6/);
});

test('review respects allowJumpCuts for text-based edits', () => {
  const src = analyzedSource(20, () => 0.5);
  const clips = [{ id: 'a', sourceIndex: 0, start: 0, end: 4 }, { id: 'b', sourceIndex: 0, start: 4.4, end: 8 }];
  assert.ok(reviewEdit({ clips, sources: [src], options: {} }).issues.some(i => i.code === 'JUMP_CUT'));
  assert.ok(!reviewEdit({ clips, sources: [src], options: { allowJumpCuts: true } }).issues.some(i => i.code === 'JUMP_CUT'));
  assert.ok(Math.abs(totalDuration(clips) - 7.6) < 1e-9);
});
