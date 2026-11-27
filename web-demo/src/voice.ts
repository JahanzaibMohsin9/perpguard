// Real voice in the browser: the same Whisper model the PerpGuard server runs (whisper-base.en, q8),
// here through transformers.js in the page, then the same fixed phrase grammar (backend/src/grammar.ts).
// Audio never leaves the browser. The model (~80 MB) downloads once, on the first hold, then is cached.

const MODEL = 'onnx-community/whisper-base.en';
const RATE = 16_000; // what the G2 microphone delivers, and what Whisper expects

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | Array<{ text: string }>>;
let asr: Promise<Asr> | null = null;
const files = new Map<string, { loaded: number; total: number }>();

/** Starts (or reuses) the model download. onProgress gets 0..1 while files arrive. */
export function loadModel(onProgress?: (fraction: number) => void): Promise<Asr> {
  asr ??= import('@huggingface/transformers').then(({ env, pipeline }) => {
    // The deployed demo serves the model itself (./models/, added at build time by the Pages workflow);
    // Hugging Face is only the fallback.
    env.localModelPath = new URL('./models/', location.href).href;
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    return pipeline('automatic-speech-recognition', MODEL, {
      dtype: 'q8',
      progress_callback: (e: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (e.status !== 'progress' || !e.file || !e.total) return;
        files.set(e.file, { loaded: e.loaded ?? 0, total: e.total });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        onProgress?.(total ? loaded / total : 0);
      },
    }) as unknown as Promise<Asr>;
  });
  asr.catch(() => (asr = null)); // allow a retry after a failed download
  return asr;
}

/** Opens the microphone. Call the returned function to stop and get 16 kHz mono samples. */
export async function startRecording(): Promise<() => Promise<Float32Array>> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is old but works everywhere without a separate worklet file. Its output is silence.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc);
  proc.connect(ctx.destination);
  return async () => {
    proc.disconnect();
    src.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    const rate = ctx.sampleRate;
    await ctx.close();
    const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.length; }
    return resample(all, rate);
  };
}

async function resample(x: Float32Array, rate: number): Promise<Float32Array> {
  if (rate === RATE || x.length === 0) return x;
  const off = new OfflineAudioContext(1, Math.ceil((x.length * RATE) / rate), RATE);
  const buf = off.createBuffer(1, x.length, rate);
  buf.copyToChannel(x as Float32Array<ArrayBuffer>, 0);
  const s = off.createBufferSource();
  s.buffer = buf;
  s.connect(off.destination);
  s.start();
  return (await off.startRendering()).getChannelData(0);
}

/** Same guards as the server: too short or near-silent audio is not sent to Whisper (it invents words). */
export async function transcribe(audio: Float32Array): Promise<string> {
  if (audio.length < RATE * 0.3) return '';
  let sumSq = 0;
  for (const v of audio) sumSq += v * v;
  if (Math.sqrt(sumSq / audio.length) < 0.004) return '';
  const model = await loadModel();
  const r = await model(audio, { max_new_tokens: 24 });
  return (Array.isArray(r) ? r.map((x) => x.text).join(' ') : r.text).trim();
}
