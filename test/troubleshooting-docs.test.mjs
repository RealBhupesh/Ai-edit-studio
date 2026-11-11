// Read source as text, never import it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const READ_PATHS = [
  'TROUBLESHOOTING.md', 'SUPPORT.md', 'src/studio.mjs',
  'src/agent-tools.mjs', 'src/transcribe.mjs', 'src/ffmpeg.mjs', 'src/render.mjs',
];
const texts = new Map(await Promise.all(READ_PATHS.map(async file =>
  [file, await readFile(new URL(`../${file}`, import.meta.url), 'utf8')])));

// Keyword groups allow prose edits while retaining each cause and recovery.
// Find actual throw sites and check their bounded surrounding context.
const cases = [
  {
    code: 'REVISION_CONFLICT',
    meaning: [/project.{0,30}changed/i, /render.{0,30}started/i],
    recovery: [/wait/i, /reload/i, /review/i, /only.{0,40}(needed|necessary)/i, /current revision/i],
    anchors: [['src/studio.mjs', /request\.revision !== project\.revision \|\| active\.has\(project\.status\)/]],
  },
  {
    code: 'PROJECT_BUSY',
    meaning: [/analyz/i, /render/i, /preview/i],
    recovery: [/wait.{0,40}finish/i, /reload/i, /studio_wait/, /until:"idle"/],
    anchors: [['src/studio.mjs', /active\.has\(project\.status\)/]],
  },
  {
    code: 'PLAN_REQUIRED',
    meaning: [/needs?.{0,25}(edit )?plan/i],
    recovery: [/create.{0,30}review.{0,30}proposal/i, /if.{0,50}(cannot|can't).{0,50}clips/i, /add shots/i],
    anchors: [['src/studio.mjs', /if \(!project\.plan\)/]],
  },
  {
    code: 'NOT_ANALYZED',
    meaning: [/motion/i, /audio/i, /measurements?.{0,30}missing/i],
    recovery: [/analy[sz]e/i, /wait.{0,30}completion/i, /transcrib/i, /selected source/i],
    anchors: [
      ['src/studio.mjs', /!project\.sources\[index\]\?\.audio\?\.length/],
      ['src/studio.mjs', /!project\.sources\.some\(s => s\.motion\?\.length\)/],
    ],
  },
  {
    code: 'TRANSCRIPT_MISSING',
    meaning: [/selected source/i, /no transcript/i],
    recovery: [/transcribe.{0,20}source/i, /import.{0,20}real/i, /SRT/i, /VTT/i, /JSON/i],
    anchors: [['src/studio.mjs', /const t = all\[index\];[\s\S]*if \(!t\)/]],
  },
  {
    code: 'ASR_MODEL_MISSING',
    meaning: [/requested/i, /model.{0,35}not installed/i],
    recovery: [/choose.{0,25}listed/i, /install.{0,40}speech setup/i],
    anchors: [['src/transcribe.mjs', /models\.find\(m => m\.name === wanted \|\| m\.file === wanted\)/]],
  },
  {
    code: 'ASR_SETUP_MANUAL',
    meaning: [/could not find whisper\.cpp/i, /non-Windows/i],
    recovery: [/install whisper\.cpp/i, /package manager/i, /speech setup again/i, /import.{0,25}transcript/i],
    anchors: [['src/transcribe.mjs', /if \(!findWhisperCli\(\)\)[\s\S]*process\.platform !== 'win32'/]],
  },
  {
    code: 'MUSIC_NOT_FOUND',
    meaning: [/music file/i, /(?:not|cannot).{0,25}(?:found|access)/i],
    recovery: [/check.{0,25}location/i, /select.{0,30}existing local/i],
    anchors: [
      ['src/studio.mjs', /fs\.stat\(file\)\.catch\(\(\) => null\)/],
      ['src/render.mjs', /!fsSync\.existsSync\(musicPath\)/],
    ],
  },
  {
    code: 'INVALID_AUDIO',
    meaning: [/audio file/i, /audio setting/i],
    recovery: [/message/i, /choose.{0,35}usable stream/i, /correct/i, /trim/i, /start time/i, /volume/i, /audio.repair/i],
    anchors: [
      ['src/ffmpeg.mjs', /!stream \|\| !Number\.isFinite\(duration\) \|\| duration <= 0/],
      ['src/render.mjs', /narrationTrimStart[\s\S]*narrationGain/],
      ['src/studio.mjs', /normalizeAudioRepair/],
    ],
  },
  {
    code: 'INVALID_MEDIA',
    meaning: [/failed check.{0,25}message/i, /import request/i],
    recovery: [/choose.{0,20}regular file/i, /allowed type/i, /size limit/i, /correct.{0,35}content type/i],
    anchors: [
      ['src/studio.mjs', /!info\.isFile\(\) \|\| info\.isSymbolicLink\(\)/],
      ['src/studio.mjs', /!extensions\.includes\(ext\)/],
      ['src/studio.mjs', /info\.size > limit/],
      ['src/studio.mjs', /request\.headers\['content-type'\] !== 'application\/octet-stream'/],
    ],
  },
  {
    code: 'UNSUPPORTED_MEDIA',
    meaning: [/could not read/i, /usable video or image/i],
    recovery: [/check.{0,25}opens/i, /choose.{0,25}supported copy/i, /keep the original/i],
    anchors: [
      ['src/ffmpeg.mjs', /error\.code === 'PROCESS_FAILED'/],
      ['src/ffmpeg.mjs', /!video \|\| !Number\.isFinite\(duration\)/],
      ['src/ffmpeg.mjs', /!video \|\| !\(Number\(video\.width\) > 0\)/],
    ],
  },
  {
    code: 'INVALID_ARGUMENTS',
    meaning: [/argument.{0,20}missing/i, /type/i, /value/i, /format/i],
    recovery: [/correct.{0,20}field/i, /message/i, /help/i, /studio_schema/, /INVALID_\*/, /specific.{0,25}(field|operation)/i],
    anchors: [['src/agent-tools.mjs', /const fail = message =>/]],
  },
];

test('tool errors have twelve distinct exact rows with useful causes and recoveries', () => {
  const docs = texts.get('TROUBLESHOOTING.md');
  const heading = '## Errors from tools and agents';
  assert.equal(docs.split(heading).length, 2, 'one tool-error section');
  const section = docs.split(heading)[1].split(/^## /m)[0];
  assert.match(docs, /## Errors from tools and agents[\s\S]*?\n## Render and quality/);
  const table = section.split('\n').filter(line => line.trim().startsWith('|'));
  assert.equal(table.length, 14, 'header, separator and twelve rows');
  assert.match(table[0], /^\|\s*Problem\s*\|\s*Fix\s*\|$/);
  assert.match(table[1], /^\|\s*-{3,}\s*\|\s*-{3,}\s*\|$/);
  const rows = table.slice(2).map(line => {
    const match = line.match(/^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|\s*([^|]+?)\s*\|$/);
    assert.ok(match, `two cells and one exact backticked code: ${line}`);
    return [match[1], match[2]];
  });
  assert.equal(new Set(rows.map(([code]) => code)).size, 12, 'no duplicate codes');
  assert.deepEqual(rows.map(([code]) => code).sort(), cases.map(({ code }) => code).sort());
  for (const { code, meaning, recovery } of cases) {
    const prose = rows.find(([name]) => name === code)[1];
    assert.ok(prose.split(/\s+/).length >= 12, `${code}: substantive explanation`);
    for (const group of [...meaning, ...recovery]) assert.match(prose, group, `${code}: ${group}`);
  }
  assert.match(section, /wait[\s\S]*reload[\s\S]*review/i);
  assert.match(section, /accepted[\s\S]{0,40}fail/i);
  for (const field of ['status', 'message', 'errorCode', 'errorDetail']) assert.ok(section.includes(field));
});

test('known throw sites still support the documented meanings', () => {
  for (const { code, anchors } of cases) {
    for (const [file, semantics] of anchors) {
      const lines = texts.get(file).split('\n');
      const throwsCode = new RegExp(`\\bthrow\\s+new\\s+StudioError\\(\\s*['"]${code}['"]\\s*,`);
      const contexts = lines.flatMap((line, i) =>
        !/^\s*(?:\/\/|\/\*|\*)/.test(line) && throwsCode.test(line)
          ? [lines.slice(Math.max(0, i - 4), i + 2).join('\n')] : []);
      assert.ok(contexts.some(context => semantics.test(context)), `${code}: ${file}: ${semantics}`);
    }
  }
  const studio = texts.get('src/studio.mjs');
  assert.match(studio, /const active = new Set\(\['analyzing', 'rendering', 'previewing'\]\)/);
  assert.match(studio, /error\.code !== 'NO_CANDIDATES'[\s\S]{0,100}project\.plan = null/);
  assert.match(studio, /project\.status = 'failed';[^\n]*project\.errorCode = error\.code/);
});

test('support promises common guidance and PR 37 rows remain intact', () => {
  const support = texts.get('SUPPORT.md');
  const promise = support.match(/1\. \*\*Something doesn't work\?\*\*[\s\S]*?(?=\n2\. )/)?.[0];
  assert.ok(promise, 'support troubleshooting step');
  assert.match(promise, /\[TROUBLESHOOTING\.md\]\(TROUBLESHOOTING\.md\)/);
  assert.match(promise, /common error codes/i);
  assert.match(promise, /suggested fixes/i);
  assert.doesNotMatch(support, /(?:every|all|each)\s+(?:\w+\s+){0,2}error\s+codes?|every\s+code/i);
  const render = texts.get('TROUBLESHOOTING.md').split('## Render and quality')[1].split(/^## /m)[0];
  for (const [code, meaning] of [
    ['HDR_NOT_SUPPORTED', [/HDR10/, /HLG/, /SDR/]],
    ['SOURCE_CHANGED', [/source file/i, /restore/i, /new project/i]],
    ['MEDIA_TOO_LONG', [/2.hour/i, /trim/i, /split/i]],
    ['ENCODER_MISSING', [/FFmpeg/, /NVENC/, /libx264/, /install/i]],
  ]) {
    const rows = [...render.matchAll(/^\|\s*`([A-Z_]+)`\s*\|\s*([^|]+)\|$/gm)]
      .filter(([, name]) => name === code);
    assert.equal(rows.length, 1, `${code}: one legacy row in render section`);
    for (const group of meaning) assert.match(rows[0][2], group, code);
  }
});
