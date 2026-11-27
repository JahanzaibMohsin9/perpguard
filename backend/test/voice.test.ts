// Fixed phrase grammar: only known protective commands become actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/voice.ts';

const coins = ['ETH', 'BTC'];
const action = (text: string) => parseCommand(text, coins)?.action ?? null;

test('known phrases map to protective actions', () => {
  assert.equal(action('Close half.'), 'close50');
  assert.equal(action('close fifty percent'), 'close50');
  assert.equal(action('Close all.'), 'closeAll');
  assert.equal(action('close everything'), 'closeAll');
  assert.equal(action('Stop at break even.'), 'stopBreakEven');
  assert.equal(action('breakeven stop'), 'stopBreakEven');
  assert.equal(action('2% stop'), 'stop2pct');
  assert.equal(action('two percent stop'), 'stop2pct');
  assert.equal(action('Add margin.'), 'addMargin');
  assert.equal(action('add some margin to ethereum'), 'addMargin');
  assert.equal(action('top up margin'), 'addMargin');
  assert.equal(action('margin call'), null); // "margin" alone is not a command
});

test("Whisper's usual mishearings found by the voice benchmark still work", () => {
  assert.equal(action('reduced by half.'), 'close50');
  assert.equal(action('Stop at brick even.'), 'stopBreakEven');
  assert.equal(action('Break Event Stop'), 'stopBreakEven');
});

test('a coin name selects the position', () => {
  assert.deepEqual(parseCommand('close half of ethereum', coins), { action: 'close50', coin: 'ETH' });
  assert.deepEqual(parseCommand('close all bitcoin', coins), { action: 'closeAll', coin: 'BTC' });
  assert.deepEqual(parseCommand('close half', coins), { action: 'close50', coin: null });
});

test('anything else is ignored, so nothing is sent', () => {
  assert.equal(action('What is the weather today?'), null);
  assert.equal(action('Those 500%'), null);
  assert.equal(action('close five hundred percent'), null);
  assert.equal(action('buy ten bitcoin'), null); // never opens or increases a position
  assert.equal(action('you'), null); // Whisper's typical silence hallucination
  assert.equal(action(''), null);
});

test('negated or cancelled speech is never an action', () => {
  assert.equal(action("Don't close half."), null);
  assert.equal(action('do not close all'), null);
  assert.equal(action('no, close everything'), null);
  assert.equal(action('never mind, close it'), null);
  assert.equal(action("don't add margin"), null);
  assert.equal(action('cancel the two percent stop'), null);
});
