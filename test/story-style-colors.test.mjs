import test from 'node:test';
import assert from 'node:assert/strict';
import { compileStory, sceneKey } from '../src/story.mjs';

const fields = [
  ['accent', '#8db4ee'],
  ['accent2', '#f0b544'],
  ['ink', '#e8eef0'],
  ['muted', '#9aa8b4'],
  ['panel', '#0f2138'],
  ['background.from', '#070e17'],
  ['background.to', '#10243e'],
];

const fonts = {
  display: 'Review Display',
  body: 'Review Body',
  mono: 'Review Mono',
};

const story = () => ({
  scenes: [{ id: 'a', kind: 'title', beats: 4, lines: ['Hello'] }],
});

const compile = style => compileStory({ ...story(), style });

function styleWith(field, value) {
  const [first, second] = field.split('.');
  return second === undefined
    ? { [first]: value }
    : { [first]: { [second]: value } };
}

const readColor = (compiled, field) =>
  field.split('.').reduce((value, key) => value[key], compiled.style);

const key = compiled => sceneKey(compiled, compiled.scenes[0], fonts);

for (const [field] of fields) {
  const name = `style.${field}`;

  for (const [short, expanded] of [
    ['#fff', '#ffffff'],
    ['#FA0', '#ffaa00'],
    ['#a1B', '#aa11bb'],
  ]) {
    test(`${name}: ${short} matches ${expanded} and its cache key`, () => {
      const actual = compile(styleWith(field, short));
      const control = compile(styleWith(field, expanded));

      assert.equal(readColor(actual, field), expanded);
      assert.deepEqual(actual.style, control.style);
      assert.equal(key(actual), key(control));
    });
  }

  test(`${name}: six-digit colours remain lowercase`, () => {
    const actual = compile(styleWith(field, '#Ab12Ef'));
    const control = compile(styleWith(field, '#ab12ef'));

    assert.equal(readColor(actual, field), '#ab12ef');
    assert.deepEqual(actual.style, control.style);
    assert.equal(key(actual), key(control));
  });

  for (const invalid of [
    'red',
    'FFB400',
    '#abcd',
    null,
    '',
    '   ',
    ' #FA0 ',
    '#ggg',
    '#12345',
    '#1234567',
  ]) {
    test(`${name}: rejects ${JSON.stringify(invalid)} with its exact field`, () => {
      assert.throws(() => compile(styleWith(field, invalid)), {
        code: 'INVALID_STORY',
        message: `${name}: use a hex colour like #1e4f91 (or #fff).`,
      });
    });
  }

  // Deliberately non-JSON inputs: preserve legacy String(v) coercion.
  for (const [label, value] of [
    ['boxed string', new String('#FA0')],
    ['single-element array', ['#FA0']],
  ]) {
    test(`${name}: preserves ${label} coercion`, () => {
      const actual = compile(styleWith(field, value));
      const control = compile(styleWith(field, '#ffaa00'));

      assert.equal(readColor(actual, field), '#ffaa00');
      assert.deepEqual(actual.style, control.style);
      assert.equal(key(actual), key(control));
    });
  }
}

test('omitted, empty and undefined style preserve defaults', () => {
  const omitted = compileStory(story());

  assert.deepEqual(omitted.style, {
    accent: '#8db4ee',
    accent2: '#f0b544',
    ink: '#e8eef0',
    muted: '#9aa8b4',
    panel: '#0f2138',
    background: { from: '#070e17', to: '#10243e' },
    font: '',
    fontBody: '',
    fontMono: '',
    fontsDir: '',
    grain: 6,
    grid: true,
    glow: 0.6,
  });

  for (const style of [{}, undefined]) {
    const actual = compile(style);
    assert.deepEqual(actual.style, omitted.style);
    assert.equal(key(actual), key(omitted));
  }
});

for (const [field, fallback] of fields) {
  test(`style.${field}: undefined preserves its default`, () => {
    const actual = compile(styleWith(field, undefined));
    const control = compileStory(story());

    assert.equal(readColor(actual, field), fallback);
    assert.deepEqual(actual.style, control.style);
    assert.equal(key(actual), key(control));
  });
}
