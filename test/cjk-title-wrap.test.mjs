// CJK titles wrap by display width on thumbnails and vertical covers (#97).
// Han / Hiragana / Katakana and full-width punctuation are two units wide,
// everything else one; `max` is a budget in these units, not a character count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapTitle } from '../src/publish.mjs';

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\u3040-\u30ff\u31f0-\u31ff\uff00-\uffef]/u;
const width = (s) => [...s].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : ch.length), 0);
const linesOf = (title, max) => wrapTitle(title, max).split('\n');
const assertFits = (lines, max) => {
  assert.ok(lines.length <= 3, `too many lines: ${JSON.stringify(lines)}`);
  assert.ok(lines.every((l) => width(l) <= max), `a line is wider than ${max} units: ${JSON.stringify(lines)}`);
};

test('a Chinese title wraps into lines of at most max width units (#97)', () => {
  const lines = linesOf('今天我们来做一个游戏的完整教程，非常有趣的内容，一定要看一看', 12);
  assertFits(lines, 12);
  assert.ok(lines.length > 1, 'the title must actually wrap');
  // A 12-unit cover line holds six Han characters, not twelve.
  assert.equal([...lines[0]].length, 6);
  assert.equal(width(lines[0]), 12);
});

test('a Japanese title with kana and kanji wraps the same way (#97)', () => {
  const lines = linesOf('ゲームを作る完全チュートリアルとても面白い内容です', 12);
  assertFits(lines, 12);
  assert.ok(lines.length > 1);
  assert.equal(lines[0], 'ゲームを作る');
  // The prolonged sound mark 'ー' (Script=Common) is as wide as the kana around it.
  assert.equal(width('ゲーム'), 6);
});

test('a 22-unit thumbnail line holds eleven Han characters (#97)', () => {
  const lines = linesOf('今天我们来做一个游戏的完整教程，非常有趣的内容，一定要看一看', 22);
  assertFits(lines, 22);
  assert.deepEqual(lines.map((l) => [...l].length), [11, 11, 8]);
});

test('a CJK title longer than three lines ends in an ellipsis that fits too (#97)', () => {
  const lines = linesOf('今天我们来做一个游戏'.repeat(6), 12);
  assert.equal(lines.length, 3);
  assert.ok(lines[2].endsWith('…'));
  assertFits(lines, 12); // the '…' is included in the width budget
});

test('a spaced title with a long CJK run wraps the run too (#97)', () => {
  const lines = linesOf('Unity 教程：今天我们来做一个游戏的完整教程非常有趣的内容 2024', 12);
  assertFits(lines, 12);
  assert.ok(lines.length > 2, 'the CJK run must be cut, not left as one long line');
  assert.ok(lines.every((l) => !l.includes('今天我们来做一个游戏的完整教程')), 'no long CJK run may remain');
});

test('a Latin word next to a CJK run keeps its own line (#97)', () => {
  const lines = linesOf('Unity 教程：今天我们来做一个游戏', 12);
  assertFits(lines, 12);
  assert.equal(lines[0], 'Unity');
});

test('full-width punctuation and letters count as two units (#97)', () => {
  const lines = linesOf('ＡＢＣＤＥＦＧ', 12);
  assertFits(lines, 12);
  assert.equal(lines[0], 'ＡＢＣＤＥＦ');
  assert.equal(lines[1], 'Ｇ');
});

test('space-separated titles wrap exactly as before (#97)', () => {
  assert.equal(wrapTitle('Short title here for the thing', 12), 'Short title\nhere for the\nthing');
  assert.equal(wrapTitle('The Last Lighthouse Keeper: A', 12), 'The Last\nLighthouse\nKeeper: A');
  assert.equal(wrapTitle('The Last Lighthouse Keeper: A Story About Courage', 12), 'The Last\nLighthouse\nKeeper: A…');
  assert.equal(wrapTitle('alpha bravo charlie d echo', 9), 'alpha\nbravo\ncharlie…');
  assert.equal(wrapTitle('alpha bravo abcdefghijkl echo', 9), 'alpha\nbravo\nabcdefgh…');
});
