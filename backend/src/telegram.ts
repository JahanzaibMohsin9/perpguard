// Telegram companion bot: liquidation-risk alerts, protective-action buttons, and receipts.
// Uses long polling (getUpdates), so no webhook or public URL is needed. All Telegram traffic can
// go through an HTTP proxy (TELEGRAM_PROXY) for countries where Telegram is blocked.
//
// Linking: a chat must open the private pairing link (printed in the server log) once.
// Linked chats are stored in backend/data/telegram.json (git-ignored).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { ACTION_LABELS, ADD_MARGIN_MAX_USD, ADD_MARGIN_TARGET_PCT, type ActionKind, type HistoryEntry, type PositionView, type Snapshot } from '../../shared/protocol.ts';
import { decodeToPcm16k, parseCommand, transcribe } from './voice.ts';

const MAX_VOICE_SECONDS = 20;
const MAX_VOICE_BYTES = 1_000_000;

// ---------- persistent state ----------

interface LinkedChat {
  id: number;
  title: string;
  paused: boolean;
  /** Message id of the pinned live risk card (/live), if on. */
  liveMsgId?: number;
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
  return { inline_keyboard: [[b('addMargin'), b('close50')], [b('closeAll'), b('stopBreakEven')], [b('stop2pct')]] };
}

/** What a confirmed action will do, in one line (adding margin is not an order). */
function actionNote(action: ActionKind): string {
  return action === 'addMargin'
    ? `Moves free USDC into this isolated position so liquidation is ${ADD_MARGIN_TARGET_PCT}% away (max ${ADD_MARGIN_MAX_USD} USDC). The size never changes.`
    : 'Testnet order, reduce-only.';
}

const CONFIRM_TTL_MS = 60_000;
const LIVE_EDIT_MS = 10_000; // live card edit rate per chat (well under Telegram's limits)
const HYSTERESIS_PCT = 0.5;

// ---------- bot ----------

export interface BotDeps {
  /** Latest snapshot of the master account (null if not available yet). */
  getSnapshot: () => Promise<Snapshot | null>;
  /** Runs a protective action; undefined when trading is not enabled. `source` = who and where, for the audit trail. */
  runAction?: (action: ActionKind, coin: string, source: string) => Promise<{ ok: boolean; message: string }>;
  /** Recent protective actions, newest first. */
  history?: () => HistoryEntry[];
  /** Block explorer page of the protected account. */
  explorerUrl?: string;
  /** Guardian mode controls; undefined when trading is not enabled. */
  /** Glasses pairing (codes shown on remote glasses). */
  pairing?: {
    complete: (code: string, pairedBy: string) => boolean;
    list: () => Array<{ id: string; pairedBy: string; createdAt: number }>;
    revokeAll: () => number;
  };
  guardian?: {
    settings: () => { enabled: boolean; graceSec: number; closePct: number };
    update: (patch: { enabled?: boolean; graceSec?: number; closePct?: number }) => void;
    cancel: (coin: string) => void;
  };
  /** Local Whisper is loaded: voice notes in linked chats are understood. */
  voiceEnabled: boolean;
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (obj: unknown, msg: string) => void };
}

export class TelegramBot {
  private state = loadState();
  private dispatcher: Dispatcher | undefined;
  private offset = 0;
  username = ''; // the bot's @username, set by start()
  private lastRisk = new Map<string, Risk>(); // coin -> last alerted risk level
  private primed = false; // false until the first snapshot after startup has been seen
  private alertTimes = new Map<string, number>(); // coin -> when the last WARNING/DANGER alert went out

  /** When the last risk alert for this coin was sent (for the "protected N s after the alert" stopwatch). */
  lastAlertAt(coin: string): number | undefined {
    return this.alertTimes.get(coin);
  }
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

  /** Message every linked (and not paused, unless force) chat, except `exceptChatId`. */
  async broadcast(html: string, keyboard?: Keyboard, force = false, exceptChatId?: number) {
    for (const c of this.state.chats) {
      if ((c.paused && !force) || c.id === exceptChatId) continue;
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
      case '/history':
        return this.send(chatId, historyHtml(this.deps.history?.() ?? [], this.deps.explorerUrl));
      case '/live':
        return this.toggleLive(chatId);
      case '/pause':
        this.setPaused(chatId, true);
        return this.send(chatId, '⏸ Alerts paused for this chat. /resume to turn them back on.');
      case '/resume':
        this.setPaused(chatId, false);
        return this.send(chatId, '▶️ Alerts resumed.');
      case '/pair': {
        if (!this.deps.pairing) return this.send(chatId, 'Pairing is not available on this server.');
        if (msg.chat.type !== 'private') return this.send(chatId, 'For safety, pair glasses from your private chat with me.');
        const code = args.join('');
        if (!/^\d{6}$/.test(code)) return this.send(chatId, 'Send the 6-digit code shown on your glasses, like <code>/pair 482913</code>.');
        const ok = this.deps.pairing.complete(code, msg.from?.first_name ?? 'Telegram user');
        return this.send(chatId, ok
          ? '👓 <b>Glasses paired.</b> They can now protect your positions. Revoke any time with /unpair.'
          : '❌ That code is wrong or expired. Codes last 5 minutes; reopen PerpGuard on the glasses for a new one.');
      }
      case '/devices': {
        const list = this.deps.pairing?.list() ?? [];
        return this.send(chatId, list.length
          ? `👓 <b>Paired glasses (${list.length})</b>\n` + list.map((d) => `• ${esc(d.id)}, paired by ${esc(d.pairedBy)} on ${new Date(d.createdAt).toISOString().slice(0, 10)}`).join('\n') + '\nRevoke all: /unpair'
          : 'No paired glasses. Glasses on this computer do not need pairing.');
      }
      case '/unpair': {
        const n = this.deps.pairing?.revokeAll() ?? 0;
        return this.send(chatId, `🔒 Revoked ${n} paired device${n === 1 ? '' : 's'}. They are read-only until paired again.`);
      }
      case '/guardian': {
        const g = this.deps.guardian;
        if (!g) return this.send(chatId, 'Guardian needs trading to be enabled on the server.');
        const [mode, grace, pct] = args;
        if (mode === 'on' || mode === 'off') {
          g.update({
            enabled: mode === 'on',
            ...(grace && Number(grace) > 0 ? { graceSec: Number(grace) } : {}),
            ...(pct && Number(pct) > 0 ? { closePct: Number(pct) } : {}),
          });
        } else if (mode) {
          return this.send(chatId, 'Usage: <code>/guardian on 60 25</code> (seconds to wait, % to close) or <code>/guardian off</code>');
        }
        const s = g.settings();
        return this.send(
          chatId,
          s.enabled
            ? `🛡 <b>Guardian is ON.</b>
If a position hits DANGER and nobody acts within <b>${s.graceSec} s</b>, PerpGuard closes <b>${s.closePct}%</b> and places a safety stop just before the liquidation price. Reduce-only.
Turn off: <code>/guardian off</code>`
            : '🛡 Guardian is <b>OFF</b>.\nTurn on: <code>/guardian on</code> (default: wait 60 s, close 25%, safety stop before liquidation).',
        );
      }
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
      return say(`🎙 Heard: “${esc(transcript || '(nothing)')}”\nNot a PerpGuard command. Try: <i>add margin, close half, close all, break even, two percent stop</i>.`);
    }
    // No coin named: use the riskiest position (snapshots are sorted riskiest first).
    const p = parsed.coin ? positions.find((x) => x.coin === parsed.coin) : positions[0];
    if (!p) return say(`🎙 Heard: “${esc(transcript)}”\nThere is no open position to act on.`);
    if (!this.deps.runAction) return say(`🎙 Heard: “${esc(transcript)}”\nTrading is not enabled on this server.`);

    const dist = p.liqDistancePct === null ? '-' : `${fmt(p.liqDistancePct, 1)}%`;
    return say(
      `🎙 <b>${who}</b> said: “${esc(transcript)}”\n→ <b>${ACTION_LABELS[parsed.action]} ${esc(p.coin)}</b> (${p.side} ${p.leverage}x, ${dist} from liquidation)\n\nConfirm? ${actionNote(parsed.action)} Expires in 60 s.`,
      {
        inline_keyboard: [[
          { text: `✅ Yes, ${ACTION_LABELS[parsed.action]}`, callback_data: `y|${parsed.action}|${p.coin}|${Date.now()}|v` },
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
    const [kind, action, coin, ts, via] = String(q.data ?? '').split('|') as [string, ActionKind, string, string?, string?];
    const chat = q.message.chat;
    const isGroup = chat.type === 'group' || chat.type === 'supergroup';
    // Groups: everyone sees alerts, but only the group's admins (trusted buddies) can act.
    if (isGroup && !(await this.isGroupAdmin(chatId, q.from?.id))) return answer('Only group admins can protect this account.');
    const live = this.state.chats.find((c) => c.id === chatId)?.liveMsgId === q.message.message_id;
    const edit = (html: string, keyboard?: Keyboard) =>
      this.api('editMessageText', {
        chat_id: chatId,
        message_id: q.message.message_id,
        text: html,
        parse_mode: 'HTML',
        ...(keyboard ? { reply_markup: keyboard } : {}),
      }).catch(() => {});

    if (kind === 'g') {
      this.deps.guardian?.cancel(action as unknown as string);
      await answer('Guardian cancelled');
      return edit('🛡 Guardian cancelled for this alert. Nothing was sent.');
    }
    if (kind === 'n') {
      await answer('Cancelled');
      return edit('❎ Cancelled. Nothing was sent.');
    }
    if (!this.deps.runAction || !(action in ACTION_LABELS) || !/^[A-Z0-9]{1,12}$/.test(coin ?? '')) {
      return answer('Trading is not enabled.');
    }
    if (kind === 'a') {
      await answer();
      const html = `⚠️ <b>Confirm: ${ACTION_LABELS[action]} ${esc(coin)}?</b>\n${actionNote(action)} Expires in 60 s.`;
      const keyboard = {
        inline_keyboard: [[
          { text: `✅ Yes, ${ACTION_LABELS[action]}`, callback_data: `y|${action}|${coin}|${Date.now()}` },
          { text: 'Cancel', callback_data: 'n' },
        ]],
      };
      // The pinned live card keeps updating, so its confirmations go in a new message.
      if (live) return this.api('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
      return edit(html, keyboard);
    }
    if (kind === 'y') {
      if (!ts || Date.now() - Number(ts) > CONFIRM_TTL_MS) {
        await answer('Expired');
        return edit('⌛ Confirmation expired. Nothing was sent.');
      }
      await answer('Sending...');
      await edit(`⏳ ${ACTION_LABELS[action]} ${esc(coin)}: sending...`);
      const name: string = q.from?.first_name ?? 'someone';
      const where = isGroup ? ` in ${chat.title ?? 'a group'}` : '';
      const source = `Telegram${via === 'v' ? ' voice' : ''} (${name}${where})`;
      const r = await this.deps.runAction(action, coin, source);
      await edit(`${r.ok ? '✅' : '❌'} <b>${ACTION_LABELS[action]} ${esc(coin)}</b> by ${esc(name)} (Telegram)\n${esc(r.message)}`);
      // Everyone else who watches this account learns who stepped in.
      return this.broadcast(
        `${r.ok ? '🧾' : '❌'} <b>${ACTION_LABELS[action]} ${esc(coin)}</b> by ${esc(name)}${esc(where)} (Telegram)\n${esc(r.message)}`,
        undefined,
        true,
        chatId,
      );
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

  // ---------- Guardian notifications ----------

  thresholds() {
    return { warnPct: this.state.warnPct, dangerPct: this.state.dangerPct };
  }

  guardianArmed(coin: string, graceSec: number, closePct: number) {
    return this.broadcast(
      `🛡 <b>Guardian armed for ${esc(coin)}</b>
If nobody acts within <b>${graceSec} s</b>, PerpGuard will close <b>${closePct}%</b> and set a safety stop before liquidation.`,
      { inline_keyboard: [[{ text: 'Cancel Guardian', callback_data: `g|${coin}` }]] },
      true,
    );
  }

  guardianCancelled(coin: string, reason: string) {
    return this.broadcast(`🛡 Guardian stood down for ${esc(coin)}: ${esc(reason)}.`, undefined, true);
  }

  guardianActed(coin: string, ok: boolean, message: string) {
    return this.broadcast(
      `${ok ? '🛡' : '❌'} <b>Guardian ${ok ? 'protected' : 'could not protect'} ${esc(coin)}</b> (no response in time)
${esc(message)}`,
      undefined,
      true,
    );
  }

  guardianChanged(enabled: boolean, by: string) {
    return this.broadcast(`🛡 Guardian turned <b>${enabled ? 'ON' : 'OFF'}</b> from the ${esc(by)}.`, undefined, true);
  }

  // ---------- groups ----------

  private adminCache = new Map<string, { ok: boolean; at: number }>();

  private async isGroupAdmin(chatId: number, userId: number | undefined): Promise<boolean> {
    if (!userId) return false;
    const key = `${chatId}:${userId}`;
    const hit = this.adminCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.ok;
    const m = await this.api<{ status: string }>('getChatMember', { chat_id: chatId, user_id: userId }).catch(() => null);
    const ok = Boolean(m && (m.status === 'creator' || m.status === 'administrator'));
    this.adminCache.set(key, { ok, at: Date.now() });
    return ok;
  }

  // ---------- live risk card (/live): one pinned message, edited as prices move ----------

  private liveText = new Map<number, string>(); // chat -> last text sent
  private liveAt = new Map<number, number>(); // chat -> last edit time

  private async toggleLive(chatId: number) {
    const c = this.state.chats.find((x) => x.id === chatId)!;
    if (c.liveMsgId) {
      const id = c.liveMsgId;
      delete c.liveMsgId;
      this.save();
      await this.api('unpinChatMessage', { chat_id: chatId, message_id: id }).catch(() => {});
      await this.api('editMessageText', { chat_id: chatId, message_id: id, text: '📡 Live card stopped. /live to start it again.' }).catch(() => {});
      return this.send(chatId, '📡 Live card stopped.');
    }
    const snap = await this.deps.getSnapshot();
    const html = liveHtml(snap, (p) => this.risk(p));
    const kb = this.liveKeyboard(snap);
    const msg = await this.api<{ message_id: number }>('sendMessage', {
      chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
      ...(kb ? { reply_markup: kb } : {}),
    });
    c.liveMsgId = msg.message_id;
    this.save();
    this.liveText.set(chatId, html);
    this.liveAt.set(chatId, Date.now());
    const pinned = await this.api('pinChatMessage', { chat_id: chatId, message_id: msg.message_id, disable_notification: true }).then(() => true, () => false);
    if (!pinned) await this.send(chatId, 'Tip: make me an admin with "Pin messages" so the live card stays on top. It updates either way.');
  }

  private liveKeyboard(snap: Snapshot | null): Keyboard | undefined {
    const p = snap?.positions[0]; // riskiest first
    return p && this.deps.runAction ? actionButtons(p.coin) : undefined;
  }

  private async updateLiveCards(snap: Snapshot) {
    const now = Date.now();
    const stamp = /\nUpdated .*$/;
    for (const c of this.state.chats) {
      if (!c.liveMsgId || now - (this.liveAt.get(c.id) ?? 0) < LIVE_EDIT_MS) continue;
      const html = liveHtml(snap, (p) => this.risk(p));
      if (html.replace(stamp, '') === (this.liveText.get(c.id) ?? '').replace(stamp, '')) continue; // only the time changed
      this.liveAt.set(c.id, now);
      this.liveText.set(c.id, html);
      const kb = this.liveKeyboard(snap);
      await this.api('editMessageText', {
        chat_id: c.id, message_id: c.liveMsgId, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: kb ?? { inline_keyboard: [] },
      }).catch((err: Error) => {
        if (/not modified/i.test(err.message)) return;
        if (/not found|MESSAGE_ID_INVALID|can't be edited/i.test(err.message)) {
          delete c.liveMsgId; // deleted by the user: stop updating
          this.save();
        } else this.deps.log.warn(`live card ${c.id}: ${err.message}`);
      });
    }
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
    await this.updateLiveCards(snap);
  }

  private alertHtml(p: PositionView, risk: Risk, network: string) {
    const head = risk === 'DANGER' ? '🔴 <b>DANGER</b>: close to liquidation' : '🟠 <b>WARNING</b>: liquidation risk rising';
    return `${head}\n\n${positionHtml(p, risk, network)}`;
  }

  private alert(p: PositionView, risk: Risk, network: string) {
    this.alertTimes.set(p.coin, Date.now());
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
    ...(p.minutesToLiq !== null ? [`⏳ At this pace: liquidation in <b>~${fmtMinutes(p.minutesToLiq)}</b>`] : []),
  ].join('\n');
}

/** 10-cell safety bar: full = far from liquidation (25%+), one cell = about to be liquidated. */
export function safetyCells(distancePct: number | null): string {
  const filled = distancePct === null ? 10 : Math.max(1, Math.min(10, Math.round(distancePct / 2.5)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

/** The pinned live card: every position, riskiest first, with Guardian state. */
export function liveHtml(snap: Snapshot | null, risk: (p: PositionView) => Risk, now = new Date()): string {
  const lines = [`📡 <b>PerpGuard live</b> · ${snap?.network ?? 'connecting'}`];
  if (!snap) lines.push('', 'Waiting for data...');
  else if (snap.positions.length === 0) lines.push('', `No open positions. Equity ${fmt(snap.accountValue, 2)} USDC`);
  for (const p of snap?.positions ?? []) {
    const r = risk(p);
    const d = p.liqDistancePct;
    lines.push(
      '',
      `${RISK_ICON[r]} <b>${esc(p.coin)} ${p.side} ${p.leverage}x</b>  ${r === 'OK' ? 'SAFE' : r}`,
      `<code>${safetyCells(d)}</code> ${d === null ? 'no liquidation price' : `${d >= 100 ? '>99' : fmt(d, 1)}% to liquidation`}`,
      `Mark ${fmt(p.markPx)} · Liq ${fmt(p.liqPx)} · PnL ${signed(p.unrealizedPnl)}`,
      ...(p.minutesToLiq !== null ? [`⏳ ~${fmtMinutes(p.minutesToLiq)} to liquidation at this pace`] : []),
    );
  }
  const g = snap?.guardian;
  if (g) {
    const armed = g.armed.map((a) => `closes ${g.closePct}% of ${esc(a.coin)} in ${a.secondsLeft} s`).join(', ');
    lines.push('', g.enabled ? `🛡 Guardian ON${armed ? `: <b>${armed}</b>` : ''}` : '🛡 Guardian off');
  }
  lines.push(`Updated ${now.toISOString().slice(11, 19)} UTC`);
  return lines.join('\n');
}

const historyLabel = (e: HistoryEntry) => (e.action === 'guardian' ? 'Guardian close + safety stop' : ACTION_LABELS[e.action]);

/** /history: the audit trail with Hyperliquid order ids. */
export function historyHtml(entries: HistoryEntry[], explorerUrl?: string): string {
  if (entries.length === 0) return '📜 No protective actions yet.';
  const rows = entries.map((e) => {
    const when = new Date(e.ts).toISOString().replace('T', ' ').slice(5, 16);
    const ids = e.orderIds.length ? ` · order${e.orderIds.length > 1 ? 's' : ''} ${e.orderIds.join(', ')}` : '';
    return `${e.ok ? (e.action === 'guardian' ? '🛡' : '✅') : '❌'} ${when} UTC · <b>${esc(historyLabel(e))} ${esc(e.coin)}</b>\n    ${esc(e.source)}${ids}`;
  });
  return [
    `📜 <b>Last ${entries.length} protective action${entries.length > 1 ? 's' : ''}</b> (newest first)`,
    '',
    ...rows,
    '',
    'Every order is reduce-only and signed by the agent wallet, which cannot withdraw.',
    ...(explorerUrl ? [`<a href="${esc(explorerUrl)}">Check them on the Hyperliquid explorer</a>`] : []),
  ].join('\n');
}

function fmtMinutes(m: number): string {
  if (m < 1) return 'under 1 min';
  if (m < 90) return `${Math.round(m)} min`;
  return `${(m / 60).toFixed(1)} h`;
}

const HELP = [
  '<b>PerpGuard</b> watches your Hyperliquid positions (testnet) and shows them on Even Realities G2 glasses.',
  '',
  '/status  positions, distance to liquidation, action buttons',
  '/live  pin a live risk card that updates as prices move',
  '/history  every protective action, who did it, order ids',
  '/alerts  view or change alert levels',
  '/pause  /resume  mute alerts in this chat',
  '/guardian  auto-protect if nobody answers a DANGER alert',
  '/pair 123456  pair glasses showing a code  (/devices, /unpair)',
  '',
  'Actions are protective only (add margin, close 50%, close all, break-even stop, 2% stop) and always ask for confirmation. Nothing ever opens or increases a position.',
  'In groups, everyone sees alerts; group admins can act.',
  'PerpGuard never asks for your seed phrase or private key.',
].join('\n');
