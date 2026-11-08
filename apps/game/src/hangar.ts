// The Hangar: the online player's account, inventory, Genesis loadout, collection and boards, in the
// game's own pixel style. Everything shown comes from the server; nothing here is simulated.
import { player, type Backend, type BoardView, type Eip1193, type InventoryView, type MeView } from './net.ts';

const GEAR_NAME: Record<string, string> = { shield: 'Bubble Shield', spread: 'Spread Shot', seed: 'Seed Tank', long: 'Long Barrel' };
const GEAR_COLOR: Record<string, string> = { shield: '#9fd8ff', spread: '#ffe08a', seed: '#b6f06a', long: '#ffb3d9' };
/** 12×12 pixel icons for the reveal ('#' = gear colour, '+' = highlight, 'o' = outline). */
const GEAR_PX: Record<string, string[]> = {
  shield: ['....oooo....', '..oo####oo..', '.o##++####o.', '.o#+######o.', 'o##+#######o', 'o##########o', 'o##########o', 'o##########o', '.o########o.', '.o########o.', '..oo####oo..', '....oooo....'],
  spread: ['o....oo....o', '#o...##...o#', '.#o..##..o#.', '..#o.##.o#..', '...#o##o#...', '....####....', '.....##.....', '....o##o....', '....o++o....', '....o##o....', '....o##o....', '....oooo....'],
  seed: ['.....oo.....', '....o##o....', '....o##o....', '...o####o...', '..o##+###o..', '..o#+####o..', '.o#+######o.', '.o########o.', '.o########o.', '..o######o..', '...o####o...', '....oooo....'],
  long: ['.....oo.....', '.....##.....', '...oo##oo...', '...######...', '.....##.....', '.....++.....', '.....##.....', '.....##.....', '....o##o....', '...o####o...', '...o####o...', '...oooooo...'],
};
const GEAR_BLURB: Record<string, string> = { shield: 'Absorbs one hit.', spread: 'Three-way shots for a while.', seed: 'Tops up your seeds.', long: 'Longer range for a while.' };
const TIER_COLOR: Record<string, string> = { common: '#c9c3e6', rare: '#4f7cff', epic: '#b04ad8', legendary: '#f6c445' };
export type Loadout = { gearType: string; copies: number }[];

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') el.className = v; else el.setAttribute(k, v); }
  for (const c of kids) el.append(c);
  return el;
};
const until = (iso: string): string => {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'expired';
  const hrs = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
  return hrs >= 24 ? `${Math.floor(hrs / 24)} d ${hrs % 24} h` : `${hrs} h ${m} min`;
};

interface Wallet6963 { info: { name: string; uuid: string; icon?: string; rdns?: string }; provider: Eip1193 }
const wallets: Wallet6963[] = [];
/** Called when a wallet announces itself while the wallet picker is open. */
let announced: () => void = () => undefined;
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (e) => { const d = (e as CustomEvent<Wallet6963>).detail; if (d && d.info && d.provider && !wallets.some((w) => w.info.uuid === d.info.uuid)) { wallets.push(d); announced(); } });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}
/** Where to get a wallet when this browser has none (desktop). */
const WALLET_SITES: [string, string][] = [['MetaMask', 'https://metamask.io/download/'], ['Rabby', 'https://rabby.io/'], ['Coinbase Wallet', 'https://www.coinbase.com/wallet/downloads']];

/** X profile pictures come from X's own image host only (the server stores nothing else). */
export const X_AVATAR = /^https:\/\/pbs\.twimg\.com\/[A-Za-z0-9._/-]+$/;
export function avatarImg(url: string | null | undefined, size = 22): HTMLImageElement | null {
  if (!url || !X_AVATAR.test(url)) return null;
  const img = h('img', { class: 'xav', src: url, width: String(size), height: String(size), alt: '', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.remove());
  return img;
}

const isMobile = () => document.body.classList.contains('touch') || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
/** Universal links that open a page in a wallet app's in-app browser (documented by each wallet). */
export function walletDeepLinks(href: string): [string, string][] {
  const u = new URL(href);
  return [
    ['MetaMask', `https://metamask.app.link/dapp/${u.host}${u.pathname}${u.search}`],
    ['Coinbase Wallet', `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(u.toString())}`],
    ['Trust Wallet', `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(u.toString())}`],
  ];
}

export class Hangar {
  private readonly b: Backend;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private tab: 'pilot' | 'inventory' | 'collection' | 'flights' | 'boards' = 'pilot';
  private meCache: MeView | null = null;
  private inv: InventoryView | null = null;
  /** The Genesis loadout chosen here (types and copies), used by the next online Genesis flight. */
  loadout: Loadout | null = null;
  onChange: () => void = () => undefined;

  constructor(b: Backend, root: HTMLElement) {
    this.b = b; this.root = root;
    const tabs = h('div', { class: 'hg-tabs', role: 'tablist' });
    for (const [id, label] of [['pilot', 'Profile'], ['inventory', 'Gear'], ['collection', 'Collection'], ['flights', 'Flights'], ['boards', 'Boards']] as const) {
      const t = h('button', { type: 'button', role: 'tab', 'data-tab': id }, label);
      t.addEventListener('click', () => { this.tab = id; this.root.scrollTop = 0; void this.render(); });
      tabs.append(t);
    }
    this.body = h('div', { class: 'hg-body' });
    const close = h('button', { type: 'button', class: 'btn ghost', id: 'hgClose' }, 'Back to routes');
    close.addEventListener('click', () => this.hide());
    // the title, a way back and the tabs stay at the top however long a tab is
    const back = h('button', { type: 'button', class: 'hg-back', id: 'hgBack' }, '‹ Routes');
    back.addEventListener('click', () => this.hide());
    const head = h('div', { class: 'hg-head' }, h('div', { class: 'hg-title' }, h('div', { class: 'kicker' }, 'Hangar'), back), tabs);
    root.replaceChildren(head, this.body, close);
  }

  show(tab?: Hangar['tab']): Promise<void> { if (tab) this.tab = tab; this.root.hidden = false; this.root.scrollTop = 0; return this.render(); }
  hide(): void { this.root.hidden = true; this.onChange(); }
  get visible(): boolean { return !this.root.hidden; }
  /** The pilot's name for the menu's sign-in button, once signed in with a wallet. */
  get signedInLabel(): string | null { const m = this.meCache; return !m || m.state === 'guest' ? null : m.x ? `@${m.x.handle}` : 'My pilot'; }
  me(): MeView | null { return this.meCache; }

  async refresh(): Promise<void> {
    try { [this.meCache, this.inv] = await Promise.all([player.me(this.b), player.inventory(this.b)]); } catch { /* offline: keep the last view */ }
  }

  /** A message to show at the top of the next render (actions re-render the tab). */
  private note: { text: string; bad: boolean } | null = null;
  private msg(text: string, bad = false): void {
    this.note = { text, bad };
    this.flash();
  }
  private flash(): void {
    if (!this.note || this.body.querySelector('.hg-flash')) return;
    const p = h('p', { class: this.note.bad ? 'note bad hg-flash' : 'note hg-flash', role: 'status' }, this.note.text);
    this.body.prepend(p);
    setTimeout(() => { p.remove(); this.note = null; }, 5000);
  }

  async render(): Promise<void> {
    for (const t of Array.from(this.root.querySelectorAll<HTMLButtonElement>("[data-tab]"))) t.setAttribute('aria-selected', String(t.dataset.tab === this.tab));
    this.body.replaceChildren(h('p', { class: 'note' }, 'Loading…'));
    try {
      await this.refresh();
      if (this.tab === 'pilot') this.renderPilot();
      else if (this.tab === 'inventory') this.renderInventory();
      else if (this.tab === 'collection') await this.renderCollection();
      else if (this.tab === 'flights') await this.renderFlights();
      else await this.renderBoards();
      this.flash();
    } catch (e) {
      this.body.replaceChildren(h('p', { class: 'note bad' }, navigator.onLine === false ? 'You are offline. The Hangar needs a connection; practice flights still work.' : `The server did not answer: ${(e as Error).message}`));
    }
  }

  private renderPilot(): void {
    const m = this.meCache;
    if (!m) { this.body.replaceChildren(h('p', { class: 'note bad' }, 'Not connected to the server.')); return; }
    const state = m.state === 'listed_eligible' ? 'Verified pilot: wallet and X linked. Your verified flights are listed.' : m.state === 'wallet' ? 'Permanent pilot. Link X to appear on the boards.' : 'Guest pilot. Clearing this browser loses the account. Link a wallet to keep it, with your Gear and drops.';
    const rows = h('dl', { class: 'hg-dl' },
      h('dt', {}, 'Account'), h('dd', {}, m.state === 'guest' ? 'Guest' : m.state === 'wallet' ? 'Wallet' : 'Wallet + X'),
      h('dt', {}, 'Wallet'), h('dd', {}, m.wallet ? `${m.wallet.address.slice(0, 6)}…${m.wallet.address.slice(-4)} (${m.wallet.kind === 'eoa' ? 'wallet' : 'smart account'})` : '—'),
      h('dt', {}, 'X'), h('dd', { class: 'hg-x' }, ...(m.x ? [avatarImg(m.x.avatarUrl) ?? '', `@${m.x.handle}`] : ['—'])),
    );
    const acts = h('div', { class: 'row-btns' });
    if (!m.wallet) {
      const btn = h('button', { type: 'button', class: 'btn', id: 'btnConnectWallet' }, 'Connect wallet');
      btn.addEventListener('click', () => this.openWallets());
      acts.append(btn);
    } else if (!m.x) {
      const btn = h('button', { type: 'button', class: 'btn' }, 'Link X');
      btn.addEventListener('click', async () => { const r = await player.xStart(this.b); if (r.url) location.href = r.url; else this.msg(r.message ?? 'X linking is not available.', true); });
      acts.append(btn);
    } else {
      const btn = h('button', { type: 'button', class: 'btn ghost' }, 'Refresh handle');
      btn.addEventListener('click', async () => { const r = await player.xStart(this.b); if (r.url) location.href = r.url; else this.msg(r.message ?? 'X is not available.', true); });
      acts.append(btn);
    }
    if (m.wallet) {
      const out = h('button', { type: 'button', class: 'btn ghost' }, 'Sign out');
      out.addEventListener('click', async () => { await player.logout(this.b); this.msg('Signed out. Your account stays linked to your wallet.'); await this.render(); this.onChange(); });
      acts.append(out);
    }
    const betaBox = h('div', { class: 'hg-appeal' });
    void player.beta(this.b).then((bt) => {
      if (bt.mode !== 'closed') return;
      if (bt.tester) { betaBox.append(h('p', { class: 'note' }, 'Closed beta: you are an invited tester.')); return; }
      const input = h('input', { type: 'text', maxlength: '24', placeholder: 'SQK-XXXX-XXXX-XXXX', 'aria-label': 'Invite code', autocomplete: 'off' }) as HTMLInputElement;
      const go = h('button', { type: 'button', class: 'btn' }, 'Join the beta');
      const out = h('p', { class: 'note', role: 'status' }, 'Online play is in closed beta. Practice is open to everyone.');
      go.addEventListener('click', async () => { (go as HTMLButtonElement).disabled = true; const r = await player.redeemBeta(this.b, input.value).catch(() => ({ ok: false, message: 'Could not reach the server.' })); out.textContent = r.message; (go as HTMLButtonElement).disabled = r.ok; });
      betaBox.append(out, input, go);
    }).catch(() => undefined);
    const record = h('div', { class: 'hg-record' }, h('p', { class: 'note' }, 'Loading your record…'));
    this.body.replaceChildren(h('p', { class: 'note' }, state), rows, acts, betaBox, h('div', { class: 'group-label' }, 'Record'), record);
    if (m.state === 'listed_eligible' && m.x) acts.append(h('a', { class: 'btn ghost', href: `#pilot/${m.x.handle}` }, 'Public profile'));
    void this.fillRecord(record, m.state === 'listed_eligible');
    if (m.activeFlight) this.body.append(h('p', { class: 'note' }, `A flight is in progress (${m.activeFlight.routeId ?? 'route'}, started ${new Date(m.activeFlight.startedAt).toLocaleTimeString()}).`));
  }

  /** The wallet picker behind the one "Connect wallet" button: the Ethereum wallets this browser
   *  offers (EIP-6963, or the single injected one), or ways to get one. Signing in is a message
   *  signature (Sign-In with Ethereum), never a transaction. */
  openWallets(): void {
    const host = this.root.parentElement ?? this.root;
    host.querySelector('.wallet-modal')?.remove();
    const list = h('div', { class: 'wm-list' });
    const status = h('p', { class: 'note', role: 'status' }, 'Ethereum wallets only. Signing in costs nothing and moves no funds.');
    const x = h('button', { type: 'button', class: 'wm-x', 'aria-label': 'Close' }, '×');
    const card = h('div', { class: 'wm-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wmTitle' },
      h('div', { class: 'wm-head' }, h('h2', { id: 'wmTitle' }, 'Connect a wallet'), x), list, status);
    const modal = h('div', { class: 'wallet-modal' }, card);
    let busy = false;
    const close = () => { if (busy) return; modal.remove(); announced = () => undefined; document.removeEventListener('keydown', onKey); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    x.addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', onKey);
    const fill = () => {
      const injected = (window as unknown as { ethereum?: Eip1193 }).ethereum;
      const found = wallets.length ? [...wallets] : injected ? [{ info: { name: 'Browser wallet', uuid: 'injected' }, provider: injected }] : [];
      list.replaceChildren();
      for (const w of found) {
        const icon = w.info.icon && /^data:image\//.test(w.info.icon) ? h('img', { src: w.info.icon, width: '28', height: '28', alt: '' }) : h('span', { class: 'wm-dot', 'aria-hidden': 'true' });
        const b = h('button', { type: 'button', class: 'wm-item' }, icon, h('span', { class: 'wm-name' }, w.info.name), h('span', { class: 'wm-tag' }, 'Detected'));
        b.addEventListener('click', async () => {
          busy = true;
          for (const o of Array.from(list.querySelectorAll('button'))) o.disabled = true;
          status.textContent = `Check ${w.info.name}: approve the connection, then sign the sign-in message.`;
          let ok = false;
          try {
            const r = await player.signIn(this.b, w.provider);
            if (r.result) { ok = true; this.note = { text: r.result === 'merged' ? 'Signed in. This guest was merged into your wallet account: nothing was lost.' : r.result === 'linked' ? 'Wallet connected. This account is now permanent.' : 'Signed in.', bad: false }; }
            else status.textContent = r.message ?? 'Sign-in failed.';
          } catch (e) { status.textContent = (e as Error).message; }
          busy = false;
          if (ok) { close(); await this.render(); this.onChange(); }
          else for (const o of Array.from(list.querySelectorAll('button'))) o.disabled = false;
        });
        list.append(b);
      }
      if (found.length) return;
      if (isMobile()) {
        // phones: open this page inside a wallet app's own browser, where the wallet is injected and the
        // same sign-in (SIWE) runs. No third-party relay is used.
        list.append(h('p', { class: 'note' }, 'No wallet in this browser. Open SqueekRaid inside your wallet app and connect there; afterwards the same wallet signs you in anywhere.'));
        for (const [name, url] of walletDeepLinks(location.href)) list.append(h('a', { class: 'wm-item', href: url, rel: 'noopener' }, h('span', { class: 'wm-dot', 'aria-hidden': 'true' }), h('span', { class: 'wm-name' }, `Open in ${name}`), h('span', { class: 'wm-tag' }, 'App')));
      } else {
        list.append(h('p', { class: 'note' }, 'No Ethereum wallet found in this browser. Install one, then reload this page.'));
        for (const [name, url] of WALLET_SITES) list.append(h('a', { class: 'wm-item', href: url, target: '_blank', rel: 'noopener' }, h('span', { class: 'wm-dot', 'aria-hidden': 'true' }), h('span', { class: 'wm-name' }, name), h('span', { class: 'wm-tag' }, 'Get ↗')));
      }
    };
    announced = fill;
    fill();
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    host.append(modal);
    (list.querySelector('button, a') as HTMLElement | null ?? x).focus();
  }

  /** The profile's record, from the same endpoints the other tabs use: verified flights and best
   *  distance, board standing on Genesis and today's Daily, and the collection. */
  private async fillRecord(el: HTMLElement, listed: boolean): Promise<void> {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [fl, g, d, c] = await Promise.all([player.flights(this.b), player.board(this.b, 'genesis'), player.board(this.b, { date: today }), player.collection(this.b)]);
      const verified = fl.flights.filter((f) => f.phase === 'verified');
      const best = verified.reduce((m, f) => Math.max(m, f.distanceM ?? 0), 0);
      const standing = (v: BoardView) => !v.me ? 'No verified flight yet' : v.me.listed && v.me.rank ? `#${v.me.rank} · ${v.me.distanceKm} km` : `${v.me.distanceKm} km · ${listed ? 'not ranked yet' : 'not listed (needs wallet and X)'}`;
      const items = c.holdings.length, copies = c.holdings.reduce((n, x) => n + x.copies, 0);
      el.replaceChildren(h('dl', { class: 'hg-dl' },
        h('dt', {}, 'Verified flights'), h('dd', {}, `${verified.length} of ${fl.flights.length}`),
        h('dt', {}, 'Best verified'), h('dd', {}, verified.length ? `${(best / 1000).toFixed(2)} km` : '—'),
        h('dt', {}, 'Genesis board'), h('dd', {}, standing(g)),
        h('dt', {}, `Daily ${today}`), h('dd', {}, standing(d)),
        h('dt', {}, 'Collection'), h('dd', {}, items ? `${items} item${items === 1 ? '' : 's'} (${copies} cop${copies === 1 ? 'y' : 'ies'})` : 'Nothing yet'),
      ));
    } catch { el.replaceChildren(h('p', { class: 'note bad' }, 'Your record could not be loaded.')); }
  }

  /** The box-opening presentation: the box shakes while the server decides, then bursts open on the
   *  Gear the server assigned. The reveal shows only what the server returned. */
  private async reveal<T extends { gearType?: string; validUntil?: string; message?: string }>(pending: Promise<T>): Promise<T> {
    const reduced = document.body.classList.contains('reduced');
    const cv = h('canvas', { width: '96', height: '96', class: 'px reveal-cv', 'aria-hidden': 'true' });
    const title = h('div', { class: 'reveal-title' }, 'Opening…');
    const sub = h('p', { class: 'note' }, '');
    const ok = h('button', { type: 'button', class: 'btn' }, 'Collect');
    ok.hidden = true;
    const card = h('div', { class: 'reveal', role: 'dialog', 'aria-label': 'Mystery Box', 'aria-live': 'polite' }, cv, title, sub, ok);
    this.root.append(card);
    const x = cv.getContext('2d')!;
    let t = 0, phase: 'shake' | 'burst' = 'shake', gear = '', raf = 0;
    const parts: { x: number; y: number; vx: number; vy: number; c: string; l: number }[] = [];
    const color = (g: string) => GEAR_COLOR[g] ?? '#f6c445';
    const drawBox = (dx: number, lid: number, lidX = 0, lidOn = true) => {
      const X = 30 + dx, Y = 40, LX = X + lidX;
      x.fillStyle = '#3a2340'; if (lidOn) x.fillRect(LX - 2, Y - 2 - lid, 40, 10); x.fillRect(X - 2, Y + 6, 40, 30);
      x.fillStyle = '#f6c445'; x.fillRect(X, Y + 8, 36, 26); x.fillStyle = '#ffe08a'; x.fillRect(X, Y + 8, 36, 3);
      x.fillStyle = '#c99a2e'; x.fillRect(X, Y + 30, 36, 4);
      if (lidOn) { x.fillStyle = '#f6c445'; x.fillRect(LX, Y - lid, 36, 6); x.fillStyle = '#ffe08a'; x.fillRect(LX, Y - lid, 36, 2); x.fillStyle = '#b04ad8'; x.fillRect(LX + 15, Y - lid, 6, 6); }
      x.fillStyle = '#b04ad8'; x.fillRect(X + 15, Y + 8, 6, 26);
      x.fillStyle = '#e08cff'; x.fillRect(X + 15, Y + 8, 2, 26);
      x.fillStyle = '#fff6c9'; x.fillRect(X + 16, Y + 18, 4, 6); x.fillStyle = '#3a2340'; x.fillRect(X + 17, Y + 20, 2, 2);
    };
    const frame = () => {
      t++;
      x.clearRect(0, 0, 96, 96);
      if (phase === 'shake') {
        const amp = reduced ? 0 : Math.min(3, 1 + t / 30);
        drawBox(Math.round(Math.sin(t * 0.9) * amp), t % 24 < 3 && !reduced ? 2 : 0);
      } else {
        const k = Math.min(1, t / 14);
        // rays behind the item, turning slowly
        x.fillStyle = color(gear); x.globalAlpha = 0.22;
        for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 + t * 0.02; for (let d = 10; d < 44; d += 3) x.fillRect(Math.round(48 + Math.cos(a) * d), Math.round(30 + Math.sin(a) * d), 2, 2); }
        x.globalAlpha = 1;
        drawBox(0, Math.round(k * 40), Math.round(-k * 50), k < 1);
        for (const p of parts) { p.x += p.vx; p.y += p.vy; p.vy += 0.06; p.l--; if (p.l > 0) { x.fillStyle = p.c; x.fillRect(Math.round(p.x), Math.round(p.y), 2, 2); } }
        // the item rises out of the box
        const iy = Math.round(44 - 26 * Math.min(1, t / 18)) + (t > 18 && !reduced ? Math.round(Math.sin(t / 8)) : 0);
        const px = GEAR_PX[gear];
        if (px) px.forEach((row, ry) => { for (let rx = 0; rx < 12; rx++) { const ch = row[rx]; if (ch === '.') continue; x.fillStyle = ch === 'o' ? '#1b1530' : ch === '+' ? '#fff6c9' : color(gear); x.fillRect(30 + rx * 3, iy - 18 + ry * 3, 3, 3); } });
      }
      if (phase === 'shake' || t < 600) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    this.sfx('shake');
    const [r] = await Promise.all([pending, new Promise((res) => setTimeout(res, reduced ? 0 : 900))]);
    cancelAnimationFrame(raf);
    if (!r.gearType) { card.remove(); return r; }
    gear = r.gearType; phase = 'burst'; t = 0;
    if (!reduced) for (let i = 0; i < 40; i++) { const a = (i / 40) * Math.PI * 2; parts.push({ x: 48, y: 44, vx: Math.cos(a) * (1 + (i % 3)), vy: Math.sin(a) * (1 + (i % 3)) - 1, c: i % 2 ? color(gear) : '#fff6c9', l: 30 + (i % 20) }); }
    raf = requestAnimationFrame(frame);
    this.sfx('burst');
    title.textContent = GEAR_NAME[gear] ?? gear;
    title.style.color = color(gear);
    card.classList.add('open');
    sub.textContent = `${GEAR_BLURB[gear] ?? ''} Valid until 00:00 UTC.`;
    ok.hidden = false; ok.focus();
    await new Promise<void>((res) => ok.addEventListener('click', () => res(), { once: true }));
    cancelAnimationFrame(raf); card.remove();
    return r;
  }
  /** Sound hook, set by the game (the Hangar has no audio of its own). */
  sfx: (k: 'shake' | 'burst') => void = () => undefined;

  private renderInventory(): void {
    const inv = this.inv;
    if (!inv) { this.body.replaceChildren(h('p', { class: 'note bad' }, 'Not connected to the server.')); return; }
    const boxes = h('div', { class: 'hg-list' });
    if (!inv.boxes.length) boxes.append(h('p', { class: 'note' }, 'No unopened boxes. Daily flights online can find Mystery Boxes.'));
    for (const b of inv.boxes) {
      const open = h('button', { type: 'button', class: 'btn' }, 'Open');
      open.addEventListener('click', async () => {
        open.disabled = true;
        const result = player.openBox(this.b, b.id).catch((e: Error): { gearType?: string; message?: string } => ({ message: e.message }));
        const r = await this.reveal(result);
        if (!r.gearType) this.msg(r.message ?? 'The box could not be opened.', true);
        await this.render(); this.onChange();
      });
      boxes.append(h('div', { class: 'hg-row' }, h('span', { class: 'hg-box' }), h('span', { class: 'hg-name' }, 'Mystery Box'), h('span', { class: 'hg-sub' }, `expires in ${until(b.expiresAt)}`), open));
    }
    const gear = h('div', { class: 'hg-list' });
    const avail = inv.gear.filter((g) => g.available > 0);
    if (!avail.length) gear.append(h('p', { class: 'note' }, 'No Gear. Open a box, or use Flight Lab → Add test Gear on the local server.'));
    // Genesis loadout: up to 3 types, up to 2 copies each (gear.loadout), reserved at take-off
    const chosen = new Map((this.loadout ?? avail.slice(0, 3).map((g) => ({ gearType: g.gearType, copies: Math.min(2, g.available) }))).map((l) => [l.gearType, l.copies] as const));
    const save = () => { this.loadout = [...chosen.entries()].filter(([, n]) => n > 0).map(([gearType, copies]) => ({ gearType, copies })); this.onChange(); };
    for (const g of avail) {
      const n = h('span', { class: 'hg-count' }, String(chosen.get(g.gearType) ?? 0));
      const minus = h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': `fewer ${g.gearType}` }, '−');
      const plus = h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': `more ${g.gearType}` }, '+');
      const set = (v: number) => {
        const types = [...chosen.entries()].filter(([k, c]) => c > 0 && k !== g.gearType).length;
        if (v > 0 && types >= 3) { this.msg('A Genesis flight carries at most 3 Gear types.', true); return; }
        chosen.set(g.gearType, Math.max(0, Math.min(2, g.available, v))); n.textContent = String(chosen.get(g.gearType)); save();
      };
      minus.addEventListener('click', () => set((chosen.get(g.gearType) ?? 0) - 1));
      plus.addEventListener('click', () => set((chosen.get(g.gearType) ?? 0) + 1));
      gear.append(h('div', { class: 'hg-row' }, h('span', { class: 'hg-name' }, GEAR_NAME[g.gearType] ?? g.gearType),
        h('span', { class: 'hg-sub' }, `${g.available} ready${g.soonestExpiry ? `, first expires in ${until(g.soonestExpiry)}` : ''}`), minus, n, plus));
    }
    save();
    this.body.replaceChildren(h('div', { class: 'group-label' }, 'Mystery Boxes'), boxes, h('div', { class: 'group-label' }, 'Genesis loadout (3 types × 2)'), gear,
      h('p', { class: 'note' }, 'Gear is single use. Equipped copies are reserved at take-off and spent only when the server commits a use; unused copies return after the flight.'));
  }

  private async renderCollection(): Promise<void> {
    const c = await player.collection(this.b);
    const legend = h('div', { class: 'hg-legend' }, ...['common', 'rare', 'epic', 'legendary'].map((t) => h('span', { class: `tier-${t}` }, t)));
    const grid = h('div', { class: 'hg-grid' });
    const glyph = (kind: string) => ({ plane_skin: '✈', hamster_hat: '^', goggles: 'oo', scarf: '~', trail: '≈' } as Record<string, string>)[kind] ?? '?';
    const tierCls = (t: string) => `tier-${TIER_COLOR[t] ? t : 'common'}`;
    for (const it of c.holdings) {
      grid.append(h('div', { class: `hg-card ${tierCls(it.tier)}` }, h('span', { class: 'swatch', 'aria-hidden': 'true' }, glyph(it.kind)), h('span', { class: 'nm' }, it.name), h('span', { class: 'meta' }, `${it.tier} · ${it.kind.replace('_', ' ')}`), h('span', { class: 'cnt', 'aria-label': `${it.copies} copies` }, `×${it.copies}`)));
    }
    for (const it of c.pendingClaims) {
      grid.append(h('div', { class: `hg-card pending ${tierCls(it.tier)}` }, h('span', { class: 'swatch', 'aria-hidden': 'true' }, '?'), h('span', { class: 'nm' }, it.name), h('span', { class: 'meta' }, `${it.tier} · held`), h('span', { class: 'dl' }, `${until(it.deadline)} left: link a wallet to keep it`)));
    }
    const total = c.holdings.reduce((n, it) => n + it.copies, 0);
    const head = h('p', { class: 'note' }, c.holdings.length || c.pendingClaims.length ? `${c.holdings.length} item${c.holdings.length === 1 ? '' : 's'}, ${total} cop${total === 1 ? 'y' : 'ies'}${c.pendingClaims.length ? `, ${c.pendingClaims.length} held for this guest` : ''}. Duplicates add copies.` : 'No cosmetics yet. Live Drops appear on Genesis only while Squeektoshi is really running on his wheel.');
    this.body.replaceChildren(head, legend, grid);
  }

  /** Online flight history: what the server recorded and how verification ended. */
  private async renderFlights(): Promise<void> {
    const { flights } = await player.flights(this.b);
    const STATE: Record<string, [string, string]> = { verified: ['Verified', 'ok'], held: ['Under review', 'warn'], rejected: ['Not verified', 'bad'], verifying: ['Checking', 'info'], terminated: ['Ended by server', 'bad'], active: ['In progress', 'info'], offline: ['In progress', 'info'], paused: ['Paused', 'info'], starting: ['Starting', 'info'] };
    if (!flights.length) { this.body.replaceChildren(h('p', { class: 'note' }, 'No online flights yet. Switch to Online on the title screen to fly a verified flight.')); return; }
    const list = h('div', { class: 'hg-list' });
    for (const f of flights) {
      const [label, tone] = STATE[f.phase] ?? [f.phase, 'info'];
      const route = f.routeId === 'genesis' ? 'Genesis' : f.routeId.replace(/^daily-/, 'Daily ');
      list.append(h('div', { class: 'hg-row' },
        h('span', { class: 'hg-name' }, route),
        h('span', { class: 'hg-km' }, f.distanceM === null ? '—' : `${(f.distanceM / 1000).toFixed(2)} km`),
        h('span', { class: `hg-state ${tone}` }, label),
        h('span', { class: 'hg-sub' }, new Date(f.startedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC')));
      if (f.appeal && typeof f.appeal === 'object') {
        const a = f.appeal, said = { open: 'Review requested: a person will decide.', overturned: 'Review: overturned.', upheld: 'Review: the decision stands.' }[a.status] ?? a.status;
        list.append(h('p', { class: 'note hg-appeal' }, a.reason ? `${said} ${a.reason}` : said));
      } else if (f.appeal === 'available') list.append(this.appealForm(f.id));
    }
    this.body.replaceChildren(h('p', { class: 'note' }, 'Your last 50 online flights. Only verified flights count on the boards and earn rewards.'), list);
  }

  /** A held or reviewed flight can be sent to a person once, with the player's own explanation. */
  private appealForm(flightId: string): HTMLElement {
    const box = h('div', { class: 'hg-appeal' });
    const open = h('button', { class: 'btn ghost', type: 'button' }, 'Ask a person to review this flight');
    open.addEventListener('click', () => {
      const text = h('textarea', { maxlength: '1000', rows: '3', 'aria-label': 'What happened during this flight?', placeholder: 'What happened? For example: lost signal on a train, or an assistive controller.' }) as HTMLTextAreaElement;
      const send = h('button', { class: 'btn', type: 'button' }, 'Send');
      const msg = h('p', { class: 'note', role: 'status' });
      send.addEventListener('click', async () => {
        if (text.value.trim().length < 3) { msg.textContent = 'Write a few words about what happened.'; return; }
        (send as HTMLButtonElement).disabled = true;
        const r = await player.appeal(this.b, flightId, text.value.trim()).catch(() => ({ ok: false, message: 'Could not reach the server. Try again.' }));
        msg.textContent = r.message;
        if (r.ok) box.replaceChildren(msg); else (send as HTMLButtonElement).disabled = false;
      });
      box.replaceChildren(text, send, msg);
      text.focus();
    });
    box.append(open);
    return box;
  }

  private async renderBoards(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const [g, d] = await Promise.all([player.board(this.b, 'genesis'), player.board(this.b, { date: today })]);
    const table = (title: string, v: BoardView, gearCol: boolean) => {
      const t = h('div', { class: 'hg-board' }, h('div', { class: 'group-label' }, title));
      if (!v.entries.length) t.append(h('p', { class: 'note' }, 'No listed pilots yet. Listing needs a wallet and X.'));
      for (const e of v.entries) t.append(h('div', { class: `hg-row${e.rank <= 3 ? ' podium-' + e.rank : ''}${v.me?.listed && v.me.rank === e.rank ? ' me' : ''}` }, h('span', { class: 'hg-rank' }, e.rank <= 3 ? ['', '1st', '2nd', '3rd'][e.rank]! : `#${e.rank}`), h('a', { class: 'hg-name', href: `#pilot/${e.handle}` }, `@${e.handle} ✓`), h('span', { class: 'hg-km', title: `decided by Game Over at ${e.gameOverAt}` }, `${e.distanceKm} km`), ...(gearCol ? [h('span', { class: 'hg-sub' }, Object.entries(e.gearUsed).map(([k, n]) => `${GEAR_NAME[k] ?? k} ×${n}`).join(', ') || 'no Gear')] : [])));
      if (v.me) t.append(h('p', { class: 'note' }, v.me.listed ? `You: #${v.me.rank}, ${v.me.distanceKm} km` : `Your best: ${v.me.distanceKm} km (not listed: needs a wallet and X)`));
      return t;
    };
    this.body.replaceChildren(table('Genesis · all time', g, true), table(`Daily · ${today}`, d, false));
  }
}
