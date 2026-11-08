// Staging builds only (scripts/build-site.ts inlines this, hash-pinned, with the permitted API address).
// Shows on the homepage what the game's session really is: it asks the API (/v1/me) with the token the
// game keeps on this origin and changes the Wallet / Connect X buttons only on the server's answer. No
// token, an expired or signed-out session, a guest, or an unreachable API all leave the Connect buttons.
// Connected, a button opens a small menu instead of navigating: Disconnect (wallet) or Sign out (X);
// both end this browser's session (the wallet is the account; X is attached to it).
/* global document, localStorage, addEventListener */
(() => {
  const API = '__SQK_API__';
  const KEY = 'sqa.v3.token';
  const AVATAR = /^https:\/\/pbs\.twimg\.com\/[A-Za-z0-9._/-]+$/;
  const wallet = document.getElementById('authWallet'), x = document.getElementById('authX');
  if (!wallet || !x) return;
  const initial = [wallet, x].map((a) => ({ a, href: a.getAttribute('href'), aria: a.getAttribute('aria-label'), label: a.querySelector('.lbl').textContent }));
  const token = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

  // one menu per button, created once, shown under it
  const menus = [wallet, x].map((a, i) => {
    const m = document.createElement('div');
    m.className = 'acct-menu'; m.id = a.id + 'Menu'; m.hidden = true; m.setAttribute('role', 'menu');
    const who = document.createElement('p'); who.className = 'who';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm'; b.setAttribute('role', 'menuitem');
    b.textContent = i === 0 ? 'Disconnect' : 'Sign out';
    b.addEventListener('click', () => void signOut(b));
    m.append(who, b);
    a.parentElement.append(m);
    return { m, who, b };
  });
  const closeMenus = () => menus.forEach((n, i) => { n.m.hidden = true; [wallet, x][i].setAttribute('aria-expanded', 'false'); });
  [wallet, x].forEach((a, i) => a.addEventListener('click', (e) => {
    if (!a.classList.contains('on')) return;          // not connected: the link goes to the game as before
    e.preventDefault();
    const open = menus[i].m.hidden;
    closeMenus();
    if (open) { menus[i].m.hidden = false; a.setAttribute('aria-expanded', 'true'); menus[i].b.focus(); }
  }));
  addEventListener('click', (e) => { if (!e.target.closest || !e.target.closest('.acct')) closeMenus(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

  const show = (i, on, label, aria, who) => {
    const a = initial[i].a;
    a.querySelector('.lbl').textContent = label;
    a.setAttribute('aria-label', aria);
    a.setAttribute('href', on ? '#' : initial[i].href);
    a.classList.toggle('on', on);
    if (on) { a.setAttribute('title', aria); a.setAttribute('aria-haspopup', 'menu'); a.setAttribute('aria-controls', menus[i].m.id); a.setAttribute('aria-expanded', 'false'); }
    else { a.removeAttribute('title'); a.removeAttribute('aria-haspopup'); a.removeAttribute('aria-controls'); a.removeAttribute('aria-expanded'); menus[i].m.hidden = true; }
    menus[i].who.textContent = who || '';
  };
  const avatar = (url) => {
    let img = x.querySelector('img.av');
    if (!url) { if (img) img.remove(); x.classList.remove('has-av'); return; }
    if (!img) { img = document.createElement('img'); img.className = 'av'; img.alt = ''; img.width = 22; img.height = 22; img.referrerPolicy = 'no-referrer'; x.prepend(img); }
    img.src = url; x.classList.add('has-av');
    img.onerror = () => avatar(null);
  };
  const reset = (i) => { show(i, false, initial[i].label, initial[i].aria, ''); if (i === 1) avatar(null); };

  let asked = 0;
  async function check() {
    const mine = ++asked;
    const t = token();
    let me = null;
    if (t) {
      try {
        const r = await fetch(API + '/v1/me', { headers: { authorization: 'Bearer ' + t }, cache: 'no-store', credentials: 'omit' });
        if (r.ok) me = await r.json();
      } catch { /* API unreachable: show nothing as connected */ }
    }
    if (mine !== asked) return;
    const address = me && me.wallet && typeof me.wallet.address === 'string' ? me.wallet.address : null;
    const handle = address && me.x && typeof me.x.handle === 'string' ? me.x.handle : null;
    if (address) show(0, true, '✓ Wallet', 'Wallet connected: ' + address, address.slice(0, 6) + '…' + address.slice(-4));
    else reset(0);
    if (handle) {
      show(1, true, '@' + handle, 'X connected: @' + handle, '@' + handle);
      avatar(typeof me.x.avatarUrl === 'string' && AVATAR.test(me.x.avatarUrl) ? me.x.avatarUrl : null);
    } else reset(1);
  }

  // ends the session on the server, then forgets it here (the game reads the same storage)
  async function signOut(button) {
    const t = token();
    button.disabled = true;
    if (t) {
      try { await fetch(API + '/v1/auth/logout', { method: 'POST', headers: { authorization: 'Bearer ' + t }, credentials: 'omit' }); }
      catch { /* offline: still forget the session here */ }
    }
    try { localStorage.setItem(KEY, ''); } catch { /* storage unavailable */ }
    button.disabled = false;
    closeMenus();
    await check();
  }

  void check();
  // back from the game (back/forward cache), or signed in or out in another tab
  addEventListener('pageshow', (e) => { if (e.persisted) void check(); });
  addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) void check(); });
})();
