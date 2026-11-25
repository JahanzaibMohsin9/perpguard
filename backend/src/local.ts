import type { IncomingHttpHeaders } from 'node:http';

/** Headers that tunnels (Cloudflare, ngrok) and reverse proxies add. Any of them means "not this PC". */
const FORWARDING_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'];

/**
 * Direct connection from this PC (the glasses simulator / Even App on the same machine).
 * Tunnel traffic also arrives from 127.0.0.1, so it is told apart by its forwarding headers.
 * Everything else (LAN, tunnels) is remote and must pair or prove a linked Telegram user.
 */
export function isLocalConnection(remoteAddress: string | undefined, headers: IncomingHttpHeaders): boolean {
  const ip = remoteAddress ?? '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  return loopback && !FORWARDING_HEADERS.some((name) => headers[name] !== undefined);
}
