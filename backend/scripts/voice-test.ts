// Dev check: transcribe 16 kHz mono 16-bit WAV files and show which command each maps to.
// Usage: npx tsx scripts/voice-test.ts file1.wav file2.wav ...
import { readFileSync } from 'node:fs';
import { loadWhisper, parseCommand, transcribe } from '../src/voice.ts';

let t = Date.now();
await loadWhisper();
console.log(`model ready in ${Date.now() - t} ms`);
for (const f of process.argv.slice(2)) {
  const wav = readFileSync(f);
  const pcm = wav.subarray(44); // skip the canonical 44-byte WAV header
  t = Date.now();
  const text = await transcribe(pcm);
  console.log(`${f.split(/[\/]/).pop()}: "${text}" -> ${JSON.stringify(parseCommand(text, ['BTC', 'ETH']))} (${Date.now() - t} ms)`);
}
