// Voice commands: local Whisper speech-to-text (transformers.js, runs on this machine, no API key)
// plus a FIXED phrase grammar. No LLM: the transcript is matched against known phrases only.
// Voice only *selects* an action; the glasses still require a tap to confirm it.

import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

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
  // Commands are a few words: cap the output so Whisper cannot loop on repeated phrases.
  const result = await model(audio, { max_new_tokens: 24 } as Record<string, unknown>);
  const text = Array.isArray(result) ? result.map((r) => r.text).join(' ') : result.text;
  return text.trim();
}

// ---------- fixed phrase grammar (in grammar.ts, shared with the browser demo) ----------

export { parseCommand, type VoiceCommand } from './grammar.ts';

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
