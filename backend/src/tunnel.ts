// Free public HTTPS URL for the Telegram Mini App: a Cloudflare "quick tunnel" (no account needed).
// The URL changes on every start, so the bot updates its menu button each time (see telegram.ts).

import { spawn, type ChildProcess } from 'node:child_process';
import { bin } from 'cloudflared';

export function startQuickTunnel(port: number, log: (msg: string) => void): Promise<{ url: string; stop: () => void }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let url = '';
    let registered = false;
    const timeout = setTimeout(() => {
      if (!registered) {
        child.kill();
        reject(new Error('Cloudflare tunnel did not connect within 60 s'));
      }
    }, 60_000);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      url ||= text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? '';
      // Only report the URL once a connection to Cloudflare is registered, or it serves error 1033.
      if (!registered && url && /Registered tunnel connection/.test(text)) {
        registered = true;
        clearTimeout(timeout);
        resolve({ url, stop: () => child.kill() });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (!registered) reject(new Error(`cloudflared exited (${code})`));
      else log(`Cloudflare tunnel stopped (${code})`);
    });
    process.on('exit', () => child.kill());
  });
}

/**
 * Stable public URL for packaged glasses: an ngrok free "dev domain" (one fixed hostname per account).
 * The .ehpk bakes this URL in, so it must not change between restarts. The browser warning page that
 * ngrok shows on free domains only affects HTML page loads, so the Mini App keeps the Cloudflare tunnel.
 */
export async function startNgrok(port: number, authtoken: string, domain: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const { default: ngrok } = await import('@ngrok/ngrok'); // native module: load only when used
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('ngrok did not connect within 45 s')), 45_000);
  });
  try {
    const listener = await Promise.race([ngrok.forward({ addr: port, authtoken, domain }), timeout]);
    return { url: listener.url() ?? `https://${domain}`, stop: () => listener.close() };
  } catch (err) {
    await ngrok.kill().catch(() => undefined); // drop a half-open session before the caller retries
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
