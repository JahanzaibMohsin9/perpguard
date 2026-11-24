// Voice commands: local Whisper speech-to-text (transformers.js, runs on this machine, no API key)
// plus a FIXED phrase grammar. No LLM: the transcript is matched against known phrases only.
// Voice only *selects* an action; the glasses still require a tap to confirm it.

import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import type { ActionKind } from '../../shared/protocol.ts';

const MODEL = process.env.WHISPER_MODEL ?? 'onnx-community/whisper-base.en';
export const SAMPLE_RATE = 16_000; // Even Hub audio: 16 kHz, signed 16-bit little-endian, mono

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

/** Loads the model once (first call downloads it, ~100 MB, then it is cached). */
export function loadWhisper(): Promise<AutomaticSpeechRecognitionPipeline> {
  asr ??= pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8' }) as Promise<AutomaticSpeechRecognitionPipeline>;
  return asr;
}

export function pcm16ToFloat32(pcm: Uint8Array): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2));
  const out = new Float32Array(view.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

export async function transcribe(pcm: Uint8Array): Promise<string> {
  const audio = pcm16ToFloat32(pcm);
  if (audio.length < SAMPLE_RATE * 0.3) return ''; // under 0.3 s: nothing useful
  // Whisper invents words ("you", "thank you") on silence: skip near-silent clips.
  let sumSq = 0;
  for (const x of audio) sumSq += x * x;
  if (Math.sqrt(sumSq / audio.length) < 0.004) return '';
  const model = await loadWhisper();
  const result = await model(audio);
  const text = Array.isArray(result) ? result.map((r) => r.text).join(' ') : result.text;
  return text.trim();
}

// ---------- fixed phrase grammar ----------

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
    .replace(/break ?even|breakeven/g, 'breakeven');
}

// Order matters: more specific phrases first.
const RULES: Array<{ action: ActionKind; test: RegExp }> = [
  { action: 'stopBreakEven', test: /\bbreakeven\b/ },
  { action: 'stop2pct', test: /\b(stop.*\b2%|2% ?stop|2% away)\b/ },
  { action: 'close50', test: /\b(close|cut|reduce|sell|take)\b.*\b(half|50%?)\b|\b(half|50%) (off|close)\b/ },
  { action: 'closeAll', test: /\b(close|exit|flatten|kill)\b.*\b(all|everything|whole|entire|full|it|position)\b|\bflatten\b|\bclose\b$/ },
];

export function parseCommand(text: string, coins: string[]): VoiceCommand | null {
  const t = normalise(text);
  if (!t) return null;
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

// ---------- Telegram voice notes (OGG/Opus) -> 16 kHz mono s16le PCM ----------


export function decodeToPcm16k(input: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg binary not available'));
    const ff = spawn(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1']);
    const out: Buffer[] = [];
    let err = '';
    ff.stdout.on('data', (d: Buffer) => out.push(d));
    ff.stderr.on('data', (d: Buffer) => (err += d));
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exit ${code}: ${err.slice(0, 200)}`))));
    ff.stdin.on('error', () => {}); // ffmpeg may close stdin early on bad input
    ff.stdin.end(Buffer.from(input));
  });
}
