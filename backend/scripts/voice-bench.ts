// Voice benchmark: every phrase in bench/phrases.json, spoken by several synthetic voices, clean and
// with background noise, through the exact product path (16 kHz PCM -> transcribe() -> parseCommand()).
//
// Usage (from backend/):  pip install edge-tts;  GEMINI_API_KEY=... npx tsx scripts/voice-bench.ts
// Speech comes from Microsoft neural voices (edge-tts, several English accents) and Gemini TTS. They are
// test fixtures only; the product itself uses no cloud AI. Clips are cached under ../internal/bench/audio,
// so later runs re-score without generating speech again.
// Writes bench/results.md and bench/results.json.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { loadWhisper, parseCommand, transcribe, SAMPLE_RATE } from '../src/voice.ts';

type Phrase = { text: string; expect: string | null; coin?: string | null };
const cfg = JSON.parse(readFileSync(new URL('../bench/phrases.json', import.meta.url), 'utf8')) as {
  coins: string[]; voices: string[]; phrases: Phrase[];
};
const TTS_MODEL = process.env.TTS_MODEL ?? 'gemini-3.8-flash-tts';
const SNR_DB = 10;
const MODEL_ID = (process.env.WHISPER_MODEL ?? 'onnx-community/whisper-base.en').split('/').pop()!;
const OUT = MODEL_ID === 'whisper-base.en' ? 'results' : `results-${MODEL_ID}`;
const cacheDir = new URL('../../internal/bench/audio/', import.meta.url);
mkdirSync(cacheDir, { recursive: true });

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nextSlot = 0;

const ACCENTS: Record<string, string> = { IN: 'Indian', GB: 'British', AU: 'Australian', NG: 'Nigerian', KE: 'Kenyan', US: 'American', ZA: 'South African' };
/** "edge:en-IN-PrabhatNeural" -> "Indian English (Prabhat, Microsoft)"; "gemini:Kore" -> "American English (Kore, Gemini)". */
function label(spec: string): string {
  const [provider, name] = spec.split(':') as [string, string];
  if (provider === 'gemini') return `American English (${name}, Gemini)`;
  const [, region, who] = /^en-([A-Z]{2})-(\w+?)(Multilingual)?Neural$/.exec(name) ?? [];
  return `${ACCENTS[region ?? ''] ?? region} English (${who}, Microsoft)`;
}

const cachePath = (spec: string, text: string) => {
  const [provider, name] = spec.split(':') as [string, string];
  return new URL(`${name}-${slug(text)}.${provider === 'edge' ? 'mp3' : 'wav'}`, cacheDir);
};

/** Speech for one voice + phrase, from the cache or the voice's provider. */
function speech(spec: string, text: string): Promise<Buffer> {
  const [provider, name] = spec.split(':') as [string, string];
  return provider === 'edge' ? edgeMp3(name, text) : speechWav(name, text);
}

/** Microsoft neural voice via the edge-tts CLI (24 kHz mono MP3). */
async function edgeMp3(voice: string, text: string): Promise<Buffer> {
  const file = cachePath(`edge:${voice}`, text);
  if (existsSync(file)) return readFileSync(file);
  for (let attempt = 1; ; attempt++) {
    const code = await new Promise<number>((resolve) => {
      const p = spawn('python', ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', fileURLToPath(file)], { stdio: 'ignore' });
      p.on('error', () => resolve(-1));
      p.on('close', (c) => resolve(c ?? -1));
    });
    if (code === 0 && existsSync(file)) return readFileSync(file);
    if (attempt >= 5) throw new Error(`edge-tts failed for ${voice} "${text}" (exit ${code})`);
    await sleep(2000 * attempt);
  }
}

/** Gemini TTS returns a 24 kHz 16-bit mono WAV. Cached per voice + phrase. */
async function speechWav(voice: string, text: string): Promise<Buffer> {
  const file = new URL(`${voice}-${slug(text)}.wav`, cacheDir);
  if (existsSync(file)) return readFileSync(file);
  for (let attempt = 1; ; attempt++) {
    // Every attempt takes a slot: the tier allows 10 requests a minute, and dropped responses still count.
    const slot = Math.max(Date.now(), nextSlot);
    nextSlot = slot + 8000;
    await sleep(slot - Date.now());
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }], // the words only: any instruction here would be read aloud
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
    }).catch((e: Error) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }) as const);
    const j = (await r.json()) as any;
    const data = j?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData?.data;
    if (data) {
      const buf = Buffer.from(data, 'base64');
      writeFileSync(file, buf);
      return buf;
    }
    if (attempt >= 30) throw new Error(`TTS failed for ${voice} "${text}": ${j?.error?.message ?? 'no audio'}`);
    const retry = Number(/(\d+(\.\d+)?)s/.exec(JSON.stringify(j?.error?.details ?? ''))?.[1] ?? 0);
    const wait = Math.max(retry * 1000, 2000);
    console.log(`  retry ${voice} "${text}" in ${Math.round(wait / 1000)} s (${j?.error?.message?.slice(0, 80) ?? r.status})`);
    await sleep(wait);
  }
}

/** Any WAV -> raw 16 kHz 16-bit mono PCM (the glasses microphone format), with ffmpeg. */
function to16k(wav: Buffer): Buffer {
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync(ffmpegPath as unknown as string,
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
        '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', 'pipe:1'], { input: wav, maxBuffer: 64 << 20 });
    if (r.status === 0 && r.stdout?.length) return r.stdout;
    // Windows sometimes fails to start the process (0xC0000142): wait a moment and try again.
    if (attempt >= 5) throw new Error(`ffmpeg status ${r.status} ${r.error?.message ?? ''} ${r.stderr ?? ''} (${wav.length} bytes in)`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt);
  }
}

/** Adds seeded pink noise at SNR_DB below the speech level (street / cafe-like hiss). */
function withNoise(pcm: Buffer, seed: number): Buffer {
  const n = pcm.length >> 1;
  const x = new Float32Array(n);
  let sp = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    x[i] = pcm.readInt16LE(i * 2) / 32768;
    if (Math.abs(x[i]) > 0.01) { sp += x[i] * x[i]; cnt++; } // speech power: ignore the silent edges
  }
  const speechRms = Math.sqrt(sp / Math.max(cnt, 1));
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  let b0 = 0, b1 = 0, b2 = 0; // Paul Kellet's economy pink filter
  const noise = new Float32Array(n);
  let np = 0;
  for (let i = 0; i < n; i++) {
    const w = rand();
    b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
    noise[i] = b0 + b1 + b2 + w * 0.1848;
    np += noise[i] * noise[i];
  }
  const gain = speechRms / 10 ** (SNR_DB / 20) / Math.sqrt(np / n);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((x[i] + noise[i] * gain) * 32767))), i * 2);
  return out;
}

type Row = { voice: string; noise: boolean; text: string; expect: string | null; coin: string | null; heard: string; action: string | null; got: string | null; verdict: 'correct' | 'onScreen' | 'missed' | 'ignored' | 'WRONG' };

const rows: Row[] = [];
console.log(`Speech: ${cfg.voices.length} voices x ${cfg.phrases.length} phrases`);
const audio = new Map<string, Buffer>();
const jobs = cfg.voices.flatMap((voice) => cfg.phrases.map((p) => ({ voice, text: p.text })));
let done = 0;
// A few requests in flight; the shared slot timer in speechWav keeps the Gemini rate down.
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    const { voice, text } = job;
    let pcm: Buffer;
    try {
      pcm = to16k(await speech(voice, text));
    } catch (err) {
      console.log(`  ${voice} "${text}": ${(err as Error).message}; fetching it again`);
      rmSync(cachePath(voice, text), { force: true });
      pcm = to16k(await speech(voice, text));
    }
    audio.set(`${voice}|${text}`, pcm);
    if (++done % 21 === 0) console.log(`  ${done}/${cfg.voices.length * cfg.phrases.length} clips ready`);
  }
}));

await loadWhisper();
let seed = 1;
for (const voice of cfg.voices) {
  for (const p of cfg.phrases) {
    for (const noise of [false, true]) {
      const clean = audio.get(`${voice}|${p.text}`)!;
      const pcm = noise ? withNoise(clean, seed++) : clean;
      const heard = await transcribe(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      const cmd = parseCommand(heard, cfg.coins);
      const coin = p.coin ?? null;
      const verdict: Row['verdict'] = p.expect === null
        ? (cmd ? 'WRONG' : 'ignored')
        : !cmd ? 'missed'
          : cmd.action !== p.expect ? 'WRONG'
            : cmd.coin === coin ? 'correct'
              : cmd.coin === null ? 'onScreen' // right action, coin name not heard: it acts on the position on screen
                : 'WRONG';
      rows.push({ voice, noise, text: p.text, expect: p.expect, coin, heard, action: cmd?.action ?? null, got: cmd?.coin ?? null, verdict });
      if (verdict !== 'correct' && verdict !== 'ignored') console.log(`  ${verdict.padEnd(7)} ${voice}${noise ? '+noise' : ''} "${p.text}" heard "${heard}" -> ${cmd?.action ?? 'nothing'}`);
    }
  }
}

// ---------- report ----------
const count = (f: (r: Row) => boolean) => rows.filter(f).length;
const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(1)}%`;
const cmds = rows.filter((r) => r.expect !== null);
const nots = rows.filter((r) => r.expect === null);
const line = (name: string, set: Row[]) => {
  const c = set.filter((r) => r.expect !== null), n = set.filter((r) => r.expect === null);
  const ok = c.filter((r) => r.verdict === 'correct').length, miss = c.filter((r) => r.verdict === 'missed').length;
  const onScreen = c.filter((r) => r.verdict === 'onScreen').length;
  const ign = n.filter((r) => r.verdict === 'ignored').length, wrong = set.filter((r) => r.verdict === 'WRONG').length;
  return `| ${name} | ${ok}/${c.length} (${pct(ok, c.length)}) | ${onScreen} | ${miss} | ${ign}/${n.length} | **${wrong}** |`;
};
const wrong = count((r) => r.verdict === 'WRONG');
const md = [
  '# Voice benchmark',
  '',
  `Generated by \`backend/scripts/voice-bench.ts\` on ${new Date().toISOString().slice(0, 10)}.`,
  `${cfg.phrases.length} phrases (${cfg.phrases.filter((p) => p.expect).length} protective commands, ${cfg.phrases.filter((p) => !p.expect).length} that must be ignored), `
    + `${cfg.voices.length} synthetic voices with different English accents (${cfg.voices.map(label).join('; ')}), each clean and with pink background noise at ${SNR_DB} dB SNR: `
    + `**${rows.length} clips**. Each clip goes through the same path as the glasses microphone: 16 kHz PCM, local Whisper (\`${MODEL_ID}\`), then the fixed phrase grammar.`,
  '',
  '- **Correct:** the right action on the right position.',
  '- **Coin not heard:** the right action, but Whisper misheard the coin name ("Ethereum" as "the theory"), so it applies to the position on screen. The confirm card names the coin, so you see it before anything is sent.',
  '- **Missed:** nothing happens and you say it again. Safe.',
  '- **Ignored:** a phrase that is not a protective command did nothing. This is what should happen.',
  '- **Wrong action:** the risky case: a different action, a different named coin, or any action from a phrase that must be ignored. Even then, the confirm card would show it before anything is sent.',
  '',
  '| Set | Commands understood | Coin not heard | Missed | Non-commands ignored | Wrong actions |',
  '|---|---|---|---|---|---|',
  line('Clean', rows.filter((r) => !r.noise)),
  line(`Noise (${SNR_DB} dB SNR)`, rows.filter((r) => r.noise)),
  line('**All**', rows),
  '',
  '## By voice',
  '',
  '| Voice | Commands understood | Coin not heard | Missed | Non-commands ignored | Wrong actions |',
  '|---|---|---|---|---|---|',
  ...cfg.voices.map((v) => line(label(v), rows.filter((r) => r.voice === v))),
  '',
  '## Every clip that was not handled perfectly',
  '',
  rows.some((r) => r.verdict !== 'correct' && r.verdict !== 'ignored')
    ? ['| Voice | Noise | Said | Whisper heard | Result |', '|---|---|---|---|---|',
      ...rows.filter((r) => r.verdict !== 'correct' && r.verdict !== 'ignored')
        .map((r) => `| ${label(r.voice)} | ${r.noise ? 'yes' : 'no'} | ${r.text} | ${r.heard || '(nothing)'} | ${r.verdict === 'WRONG' ? `**wrong: ${r.action} ${r.got ?? ''}**` : r.verdict === 'onScreen' ? `${r.action}, coin not heard` : 'missed'} |`)].join('\n')
    : 'None.',
  '',
].join('\n');
writeFileSync(new URL(`../bench/${OUT}.md`, import.meta.url), md);
writeFileSync(new URL(`../bench/${OUT}.json`, import.meta.url), JSON.stringify(rows, null, 1));
console.log(`\nCommands understood ${count((r) => r.verdict === 'correct')}/${cmds.length}, missed ${count((r) => r.verdict === 'missed')}, `
  + `coin not heard ${count((r) => r.verdict === 'onScreen')}, non-commands ignored ${count((r) => r.verdict === 'ignored')}/${nots.length}, WRONG ${wrong}`);
