// Telegram companion bot: liquidation-risk alerts, protective-action buttons, and receipts.
// Uses long polling (getUpdates), so no webhook or public URL is needed. All Telegram traffic can
// go through an HTTP proxy (TELEGRAM_PROXY) for countries where Telegram is blocked.
//
// Linking: a chat must open the private pairing link (printed in the server log) once.
// Linked chats are stored in backend/data/telegram.json (git-ignored).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { ACTION_LABELS, type ActionKind, type PositionView, type Snapshot } from '../../shared/protocol.ts';
import { decodeToPcm16k, parseCommand, transcribe } from './voice.ts';

const MAX_VOICE_SECONDS = 20;
const MAX_VOICE_BYTES = 1_000_000;

// ---------- persistent state ----------

interface LinkedChat {
  id: number;
  title: string;
  paused: boolean;
}

interface BotState {
  pairCode: string;
  chats: LinkedChat[];
  warnPct: number;
  dangerPct: number;
}

const DATA_DIR = new URL('../data/', import.meta.url);
const STATE_FILE = new URL('telegram.json', DATA_DIR);

function loadState(): BotState {
  const fresh: BotState = { pairCode: randomBytes(6).toString('hex'), chats: [], warnPct: 8, dangerPct: 3 };
  if (!existsSync(STATE_FILE)) return fresh;
  try {
    return { ...fresh, ...(JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<BotState>) };
  } catch {
    return fresh;
  }
}

// ---------- helpers ----------

export type Risk = 'OK' | 'WARNING' | 'DANGER';

const RISK_ORDER: Record<Risk, number> = { OK: 0, WARNING: 1, DANGER: 2 };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmt(n: number | null, digits?: number): string {
  if (n === null || !Number.isFinite(n)) return '-';
  const d = digits ?? (n >= 1000 ? 0 : n >= 1 ? 2 : 4);
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function signed(n: number): string {
  return `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}`;
}

const RISK_ICON: Record<Risk, string> = { OK: '🟢', WARNING: '🟠', DANGER: '🔴' };

type Keyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

/** Callback data layout (max 64 bytes): "a|<action>|<coin>" ask, "y|<action>|<coin>|<ts>" confirm, "n" cancel. */
function actionButtons(coin: string): Keyboard {
  const b = (k: ActionKind) => ({ text: ACTION_LABELS[k], callback_data: `a|${k}|${coin}` });
  return { inline_keyboard: [[b('close50'), b('closeAll')], [b('stopBreakEven'), b('stop2pct')]] };
}

const CONFIRM_TTL_MS = 60_000;
const HYSTERESIS_PCT = 0.5;

// ---------- bot ----------

export interface BotDeps {
  /** Latest snapshot of the master account (null if not available yet). */
  getSnapshot: () => Promise<Snapshot | null>;
  /** Runs a protective action; undefined when trading is not enabled. */
  runAction?: (action: ActionKind, coin: string) => Promise<{ ok: boolean; message: string }>;
  /** Local Whisper is loaded: voice notes in linked chats are understood. */
  voiceEnabled: boolean;
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (obj: unknown, msg: string) => void };
}

export class TelegramBot {
  private state = loadState();
  private dispatcher: Dispatcher | undefined;
  private offset = 0;
  private username = '';
  private lastRisk = new Map<string, Risk>(); // coin -> last alerted risk level
  private primed = false; // false until the first snapshot after startup has been seen
  private stopped = false;

  constructor(
    private token: string,
    proxy: string | undefined,
    private deps: BotDeps,
  ) {
    if (proxy) this.dispatcher = new ProxyAgent(proxy);
  }

  private save() {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  private async api<T = any>(method: string, body: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const res = await undiciFetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
    return json.result;
  }

  private send(chatId: number, html: string, keyboard?: Keyboard) {
    return this.api('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  private isLinked(chatId: number) {
    return this.state.chats.some((c) => c.id === chatId);
  }

  /** Message every linked (and not paused, unless force) chat. */
  async broadcast(html: string, keyboard?: Keyboard, force = false) {
    for (const c of this.state.chats) {
      if (c.paused && !force) continue;
      await this.send(c.id, html, keyboard).catch((err) => this.deps.log.error({ err }, `telegram send to ${c.id} failed`));
    }
  }

  async start() {
    const me = await this.api<{ username: string }>('getMe');
    this.username = me.username;
    this.save(); // persist the pairing code on first run
    this.deps.log.info(`Telegram bot @${me.username} ready. ${this.state.chats.length} linked chat(s).`);
    this.deps.log.info(`Link a chat (keep private): https://t.me/${me.username}?start=${this.state.pairCode}`);
    void this.pollLoop();
  }

  stop() {
    this.stopped = true;
  }

  private async pollLoop() {
    while (!this.stopped) {
      try {
        const updates = await this.api<any[]>('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35_000);
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handle(u).catch((err) => this.deps.log.error({ err }, 'telegram update failed'));
        }
      } catch (err) {
        this.deps.log.warn(`Telegram poll failed (${(err as Error).message}); retrying in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  // ---------- incoming ----------

  private async handle(u: any) {
    if (u.callback_query) return this.handleCallback(u.callback_query);
    const msg = u.message;
    if ((msg?.voice || msg?.audio) && this.isLinked(msg.chat.id)) return this.handleVoice(msg);
    if (!msg?.text) return;
    const chatId: number = msg.chat.id;
    const [rawCmd = '', ...args] = String(msg.text).trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@\w+$/, ''); // "/status@PerpGuard2Bot" in groups

    if (cmd === '/start') {
      if (args[0] && args[0] === this.state.pairCode) {
        if (!this.isLinked(chatId)) {
          this.state.chats.push({ id: chatId, title: msg.chat.title ?? msg.chat.first_name ?? String(chatId), paused: false });
          this.save();
        }
        await this.send(chatId, '✅ <b>Linked to PerpGuard.</b>\nYou will get liquidation alerts and receipts here.\n\n' + HELP);
        return this.sendCurrentRisk(chatId); // positions already at risk would otherwise never alert
      }
      if (!this.isLinked(chatId)) {
        return this.send(chatId, 'This chat is not linked yet. Open the private pairing link from your PerpGuard server.');
      }
      return this.send(chatId, HELP);
    }

    if (!this.isLinked(chatId)) return; // ignore strangers silently

    switch (cmd) {
      case '/help':
        return this.send(chatId, HELP);
      case '/app':
        if (!this.miniAppUrl) return this.send(chatId, 'The Mini App is offline (server started without TUNNEL=cloudflare).');
        if (msg.chat.type !== 'private') return this.send(chatId, 'Open the Mini App from your private chat with me (menu button).');
        return this.api('sendMessage', {
          chat_id: chatId,
          text: '📱 Live dashboard:',
          reply_markup: { inline_keyboard: [[{ text: 'Open PerpGuard', web_app: { url: this.miniAppUrl } }]] },
        });
      case '/status':
        return this.sendStatus(chatId);
      case '/pause':
        this.setPaused(chatId, true);
        return this.send(chatId, '⏸ Alerts paused for this chat. /resume to turn them back on.');
      case '/resume':
        this.setPaused(chatId, false);
        return this.send(chatId, '▶️ Alerts resumed.');
      case '/alerts': {
        const [w, d] = args.map(Number);
        if (w !== undefined && d !== undefined && w > d && d > 0 && w <= 50) {
          this.state.warnPct = w;
          this.state.dangerPct = d;
          this.save();
        } else if (args.length) {
          return this.send(chatId, 'Usage: <code>/alerts 8 3</code> = warn under 8% from liquidation, danger under 3%.');
        }
        return this.send(
          chatId,
          `🔔 Alerts: 🟠 warning under <b>${this.state.warnPct}%</b>, 🔴 danger under <b>${this.state.dangerPct}%</b> from liquidation.\nChange: <code>/alerts 8 3</code>`,
        );
      }
    }
  }

  /** Voice note in a linked chat (private or group): local Whisper + fixed phrases -> confirm buttons. */
  private async handleVoice(msg: any) {
    const chatId: number = msg.chat.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const media = msg.voice ?? msg.audio;
    const replyTo = { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } };
    const say = (html: string, keyboard?: Keyboard) =>
      this.api('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', ...replyTo, ...(keyboard ? { reply_markup: keyboard } : {}) });

    if (!this.deps.voiceEnabled) return isGroup ? undefined : say('Voice commands are off on this server.');
    if ((media.duration ?? 0) > MAX_VOICE_SECONDS || (media.file_size ?? 0) > MAX_VOICE_BYTES) {
      return isGroup ? undefined : say(`Voice note too long. Keep it under ${MAX_VOICE_SECONDS} s.`);
    }

    void this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const file = await this.api<{ file_path: string }>('getFile', { file_id: media.file_id });
    const res = await undiciFetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, {
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`voice download ${res.status}`);
    const t0 = Date.now();
    const pcm = await decodeToPcm16k(new Uint8Array(await res.arrayBuffer()));
    const transcript = await transcribe(pcm);

    const snap = await this.deps.getSnapshot();
    const positions = snap?.positions ?? [];
    const parsed = parseCommand(transcript, positions.map((p) => p.coin));
    const who = esc(msg.from?.first_name ?? 'Someone');
    this.deps.log.info(`telegram voice from ${msg.from?.id} in ${chatId}: "${transcript}" -> ${JSON.stringify(parsed)} (${Date.now() - t0} ms)`);

    if (!parsed) {
      // In groups people talk about other things: stay quiet unless it was a command.
      if (isGroup) return;
      return say(`🎙 Heard: “${esc(transcript || '(nothing)')}”\nNot a PerpGuard command. Try: <i>close half, close all, break even, two percent stop</i>.`);
    }
    // No coin named: use the riskiest position (snapshots are sorted riskiest first).
    const p = parsed.coin ? positions.find((x) => x.coin === parsed.coin) : positions[0];
    if (!p) return say(`🎙 Heard: “${esc(transcript)}”\nThere is no open position to act on.`);
    if (!this.deps.runAction) return say(`🎙 Heard: “${esc(transcript)}”\nTrading is not enabled on this server.`);

    const dist = p.liqDistancePct === null ? '-' : `${fmt(p.liqDistancePct, 1)}%`;
    return say(
      `🎙 <b>${who}</b> said: “${esc(transcript)}”\n→ <b>${ACTION_LABELS[parsed.action]} ${esc(p.coin)}</b> (${p.side} ${p.leverage}x, ${dist} from liquidation)\n\nConfirm? Testnet order, reduce-only. Expires in 60 s.`,
      {
        inline_keyboard: [[
          { text: `✅ Yes, ${ACTION_LABELS[parsed.action]}`, callback_data: `y|${parsed.action}|${p.coin}|${Date.now()}` },
          { text: 'Cancel', callback_data: 'n' },
        ]],
      },
    );
  }

  private setPaused(chatId: number, paused: boolean) {
    const c = this.state.chats.find((x) => x.id === chatId);
    if (c) c.paused = paused;
    this.save();
  }

  private async sendStatus(chatId: number) {
    const snap = await this.deps.getSnapshot();
    if (!snap) return this.send(chatId, 'No data yet. Is the wallet set?');
    if (snap.positions.length === 0) {
      return this.send(chatId, `📊 <b>No open positions</b> (${snap.network})\nEquity ${fmt(snap.accountValue, 2)} USDC`);
    }
    for (const p of snap.positions) {
      await this.send(chatId, positionHtml(p, this.risk(p), snap.network), this.deps.runAction ? actionButtons(p.coin) : undefined);
    }
  }

  private async handleCallback(q: any) {
    const chatId: number | undefined = q.message?.chat?.id;
    const answer = (text?: string) => this.api('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => {});
    if (!chatId || !this.isLinked(chatId)) return answer('Not linked.');
    const [kind, action, coin, ts] = String(q.data ?? '').split('|') as [string, ActionKind, string, string?];
    const edit = (html: string, keyboard?: Keyboard) =>
      this.api('editMessageText', {
        chat_id: chatId,
        message_id: q.message.message_id,
        text: html,
        parse_mode: 'HTML',
        ...(keyboard ? { reply_markup: keyboard } : {}),
      }).catch(() => {});

    if (kind === 'n') {
      await answer('Cancelled');
      return edit('❎ Cancelled. Nothing was sent.');
    }
    if (!this.deps.runAction || !(action in ACTION_LABELS) || !/^[A-Z0-9]{1,12}$/.test(coin ?? '')) {
      return answer('Trading is not enabled.');
    }
    if (kind === 'a') {
      await answer();
      return edit(`⚠️ <b>Confirm: ${ACTION_LABELS[action]} ${esc(coin)}?</b>\nTestnet order, reduce-only. Expires in 60 s.`, {
        inline_keyboard: [[
          { text: `✅ Yes, ${ACTION_LABELS[action]}`, callback_data: `y|${action}|${coin}|${Date.now()}` },
          { text: 'Cancel', callback_data: 'n' },
        ]],
      });
    }
    if (kind === 'y') {
      if (!ts || Date.now() - Number(ts) > CONFIRM_TTL_MS) {
        await answer('Expired');
        return edit('⌛ Confirmation expired. Nothing was sent.');
      }
      await answer('Sending...');
      await edit(`⏳ ${ACTION_LABELS[action]} ${esc(coin)}: sending...`);
      const who = q.from?.first_name ? ` by ${esc(q.from.first_name)}` : '';
      const r = await this.deps.runAction(action, coin);
      return edit(`${r.ok ? '✅' : '❌'} <b>${ACTION_LABELS[action]} ${esc(coin)}</b>${who} (Telegram)\n${esc(r.message)}`);
    }
  }

  // ---------- Mini App ----------

  private miniAppUrl: string | null = null;

  /** Points the bot's menu button (and /app) at the current public Mini App URL. */
  async setMiniAppUrl(url: string) {
    this.miniAppUrl = url;
    await this.api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'PerpGuard', web_app: { url } } });
    this.deps.log.info('Telegram menu button now opens the Mini App.');
  }

  /**
   * Verifies Telegram Mini App initData (HMAC-SHA256 per Telegram docs) and that the user is allowed:
   * linked in a private chat, or a member of a linked group.
   */
  async verifyMiniAppUser(initData: string): Promise<{ id: number; name: string } | null> {
    const checked = checkInitData(initData, this.token, Date.now() / 1000);
    if (!checked) return null;
    const { id, name } = checked;
    if (this.isLinked(id)) return { id, name };
    for (const c of this.state.chats.filter((x) => x.id < 0)) {
      const m = await this.api<{ status: string }>('getChatMember', { chat_id: c.id, user_id: id }).catch(() => null);
      if (m && ['creator', 'administrator', 'member'].includes(m.status)) return { id, name };
    }
    return null;
  }

  // ---------- outgoing: alerts and receipts ----------

  risk(p: PositionView): Risk {
    return riskLevel(p.liqDistancePct, this.state.warnPct, this.state.dangerPct);
  }

  /** Call on every fresh snapshot: alerts when a position's risk level changes. */
  async onSnapshot(snap: Snapshot) {
    const seen = new Set<string>();
    for (const p of snap.positions) {
      seen.add(p.coin);
      const before = this.lastRisk.get(p.coin);
      const now = nextRisk(before, p.liqDistancePct, this.state.warnPct, this.state.dangerPct);
      this.lastRisk.set(p.coin, now);
      if (before === undefined) {
        // First sight of a risky position. Right after a server restart we only record the level,
        // so restarts don't re-send alerts (newly linked chats get the current risks on /start).
        if (now !== 'OK' && this.primed) await this.alert(p, now, snap.network);
      } else if (RISK_ORDER[now] > RISK_ORDER[before]) {
        await this.alert(p, now, snap.network);
      } else if (now === 'OK' && before !== 'OK') {
        await this.broadcast(`🟢 <b>${esc(p.coin)} is back to safe</b>: ${fmt(p.liqDistancePct, 1)}% from liquidation.`);
      }
    }
    for (const coin of this.lastRisk.keys()) if (!seen.has(coin)) this.lastRisk.delete(coin);
    this.primed = true;
  }

  private alertHtml(p: PositionView, risk: Risk, network: string) {
    const head = risk === 'DANGER' ? '🔴 <b>DANGER</b>: close to liquidation' : '🟠 <b>WARNING</b>: liquidation risk rising';
    return `${head}\n\n${positionHtml(p, risk, network)}`;
  }

  private alert(p: PositionView, risk: Risk, network: string) {
    return this.broadcast(this.alertHtml(p, risk, network), this.deps.runAction ? actionButtons(p.coin) : undefined);
  }

  private async sendCurrentRisk(chatId: number) {
    const snap = await this.deps.getSnapshot();
    for (const p of snap?.positions ?? []) {
      const r = this.risk(p);
      if (r !== 'OK') await this.send(chatId, this.alertHtml(p, r, snap!.network), this.deps.runAction ? actionButtons(p.coin) : undefined);
    }
  }

  /** Receipt for an action taken somewhere else (glasses tap or voice). */
  receipt(source: string, action: ActionKind, coin: string, ok: boolean, message: string, heard?: string) {
    const said = heard ? `\nHeard: “${esc(heard)}”` : '';
    return this.broadcast(
      `${ok ? '🧾' : '❌'} <b>${ACTION_LABELS[action]} ${esc(coin)}</b> via ${source}${said}\n${esc(message)}`,
      undefined,
      true, // receipts go out even when alerts are paused
    );
  }
}

/** Risk level for a liquidation distance (null distance = no liquidation price = OK). */
export function riskLevel(distancePct: number | null, warnPct: number, dangerPct: number): Risk {
  if (distancePct === null) return 'OK';
  if (distancePct < dangerPct) return 'DANGER';
  if (distancePct < warnPct) return 'WARNING';
  return 'OK';
}

/**
 * Risk level with hysteresis: escalate immediately, but only step DOWN a level once the distance is
 * HYSTERESIS_PCT past the threshold, so a price hovering at a boundary cannot spam alternating alerts.
 */
export function nextRisk(before: Risk | undefined, distancePct: number | null, warnPct: number, dangerPct: number): Risk {
  const now = riskLevel(distancePct, warnPct, dangerPct);
  if (before && RISK_ORDER[now] < RISK_ORDER[before] && distancePct !== null) {
    const threshold = before === 'DANGER' ? dangerPct : warnPct;
    if (distancePct < threshold + HYSTERESIS_PCT) return before;
  }
  return now;
}

/**
 * Verifies Telegram Mini App initData per Telegram's spec (HMAC-SHA256 with key HMAC("WebAppData", token))
 * and rejects launch data older than 24 h. Returns the Telegram user, or null.
 */
export function checkInitData(initData: string, botToken: string, nowSec: number): { id: number; name: string } | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash') ?? '';
  params.delete('hash');
  const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (hash.length !== expected.length || !timingSafeEqual(Buffer.from(hash), Buffer.from(expected))) return null;
  if (nowSec - Number(params.get('auth_date') ?? 0) > 24 * 3600) return null; // stale launch data
  let user: { id?: number; first_name?: string };
  try {
    user = JSON.parse(params.get('user') ?? '');
  } catch {
    return null;
  }
  if (!user?.id) return null;
  return { id: user.id, name: user.first_name ?? String(user.id) };
}

function positionHtml(p: PositionView, risk: Risk, network: string): string {
  return [
    `${RISK_ICON[risk]} <b>${esc(p.coin)} ${p.side} ${p.leverage}x</b>  (${network})`,
    `Size ${p.size}  ·  PnL <b>${signed(p.unrealizedPnl)}</b> USDC`,
    `Mark ${fmt(p.markPx)}  ·  Liq ${fmt(p.liqPx)}`,
    `Distance to liquidation: <b>${p.liqDistancePct === null ? '-' : p.liqDistancePct >= 100 ? '>99' : fmt(p.liqDistancePct, 1)}%</b>`,
  ].join('\n');
}

const HELP = [
  '<b>PerpGuard</b> watches your Hyperliquid positions (testnet) and shows them on Even Realities G2 glasses.',
  '',
  '/status  positions, distance to liquidation, action buttons',
  '/alerts  view or change alert levels',
  '/pause  /resume  mute alerts in this chat',
  '',
  'Actions are protective only (close 50%, close all, break-even stop, 2% stop) and always ask for confirmation.',
  'PerpGuard never asks for your seed phrase or private key.',
].join('\n');
