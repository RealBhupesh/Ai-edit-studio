// CJK queries and script lines must use the same word segmentation as transcripts (#122).
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWords, scriptLines } from '../src/longform.mjs';
import { splitWords } from '../public/transcript.js';

const words = (text, lang) => splitWords(text, lang).map((w, i) => ({ text: w, start: i, end: i + 0.9 }));

test('searchWords finds a Chinese phrase typed without spaces (#122)', () => {
  const zh = words('今天我们来做一个游戏', 'zh');
  assert.deepEqual(searchWords(zh, '做一个游戏').map((h) => [h.from, h.to]), [[3, 5]]);
  assert.deepEqual(searchWords(zh, '做 一个 游戏').map((h) => [h.from, h.to]), [[3, 5]]);
  const ja = words('私たちはゲームを作ります', 'ja');
  assert.ok(searchWords(ja, 'ゲーム').length > 0, 'a Japanese query finds the kana word');
});

test('scriptLines keeps Chinese and Japanese lines of two or more words (#122)', () => {
  assert.deepEqual(scriptLines('今天我们来做一个游戏\n这个游戏很好玩'), ['今天我们来做一个游戏', '这个游戏很好玩']);
  assert.ok(scriptLines('私たちはゲームを作ります').length === 1);
  assert.deepEqual(scriptLines('the quick brown fox\nx'), ['the quick brown fox']);
});

test('space-separated languages split exactly as before (#122)', () => {
  const en = words('the quick brown fox jumps over the lazy dog', 'en');
  assert.equal(searchWords(en, 'brown fox').length > 0, true);
  assert.equal(scriptLines('a slow green turtle')[0], 'a slow green turtle');
});
