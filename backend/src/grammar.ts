// Fixed phrase grammar for voice commands. No LLM: a transcript is matched against known protective
// phrases only. Pure code with no Node dependencies, so the browser demo runs the exact same rules.

import type { ActionKind } from '../../shared/protocol.ts';

export interface VoiceCommand {
  action: ActionKind;
  coin: string | null; // null = the position currently on screen
}

const NUMBER_WORDS: Record<string, string> = { two: '2', fifty: '50', half: 'half', hundred: '100' };

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9% ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => NUMBER_WORDS[w] ?? w)
    .join(' ')
    .replace(/(\d+) ?(percent|per cent|%)/g, '$1%')
    .replace(/\b(break|brick) ?(even|event)\b|breakeven/g, 'breakeven'); // Whisper often hears "brick even" / "break event"
}

// Order matters: more specific phrases first.
const RULES: Array<{ action: ActionKind; test: RegExp }> = [
  // "add margin" (Whisper sometimes hears "had margin" / "at margin"), "top up margin", "more margin"
  { action: 'addMargin', test: /\b(add|had|at|top ?up|more)\b( some)?( more)? margin\b/ },
  { action: 'stopBreakEven', test: /\bbreakeven\b/ },
  { action: 'stop2pct', test: /\b(stop.*\b2%|2% ?stop|2% away)\b/ },
  { action: 'close50', test: /\b(close|cut|reduced?|sell|take)\b.*\b(half|50%?)\b|\b(half|50%) (off|close)\b/ },
  { action: 'closeAll', test: /\b(close|exit|flatten|kill)\b.*\b(all|everything|whole|entire|full|it|position)\b|\bflatten\b|\bclose\b$/ },
];

// "don't close half", "do not close all", "never mind, close it": negated or cancelled speech is
// never an action. Normalising turns "don't" into "don t".
const NEGATION = /\b(don t|dont|do not|not|never|no|nope|cancel|never ?mind)\b/;

export function parseCommand(text: string, coins: string[]): VoiceCommand | null {
  const t = normalise(text);
  if (!t || NEGATION.test(t)) return null;
  const rule = RULES.find((r) => r.test.test(t));
  if (!rule) return null;
  const coin = coins.find((c) => new RegExp(`\\b${c.toLowerCase()}\\b`).test(t) || aliases(c).some((a) => t.includes(a))) ?? null;
  return { action: rule.action, coin };
}

function aliases(coin: string): string[] {
  const map: Record<string, string[]> = {
    BTC: ['bitcoin'],
    ETH: ['ethereum', 'ether', 'eth'],
    SOL: ['solana'],
    HYPE: ['hype', 'hyper liquid'],
  };
  return map[coin] ?? [];
}
