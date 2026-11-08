// Controls and settings: remappable key bindings (two keys per action), sound and reduced motion.
// Kept in this browser, and with the account when the game is online (GET/PUT /v1/me/settings).
export type Action = 'left' | 'right' | 'fire' | 'gear1' | 'gear2' | 'gear3' | 'pause';
export const ACTIONS: readonly { id: Action; label: string }[] = [
  { id: 'left', label: 'Steer left' }, { id: 'right', label: 'Steer right' }, { id: 'fire', label: 'Fire' },
  { id: 'gear1', label: 'Gear slot 1' }, { id: 'gear2', label: 'Gear slot 2' }, { id: 'gear3', label: 'Gear slot 3' }, { id: 'pause', label: 'Pause' },
];
export const DEFAULT_BINDINGS: Readonly<Record<Action, readonly string[]>> = {
  left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], fire: ['Space', 'KeyJ'],
  gear1: ['KeyZ', 'Digit1'], gear2: ['KeyX', 'Digit2'], gear3: ['KeyC', 'Digit3'], pause: ['KeyP', 'Escape'],
};
export interface Settings { bindings: Record<Action, string[]>; sound: boolean; reducedMotion: boolean }

const KEY = 'sqa.v3.settings';
export function defaults(): Settings {
  let reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* no media queries */ }
  return { bindings: Object.fromEntries(ACTIONS.map((a) => [a.id, [...DEFAULT_BINDINGS[a.id]]])) as Record<Action, string[]>, sound: true, reducedMotion: reduced };
}
export function loadLocal(): Settings {
  const d = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<Settings>;
    return { bindings: { ...d.bindings, ...(s.bindings ?? {}) }, sound: s.sound ?? d.sound, reducedMotion: s.reducedMotion ?? d.reducedMotion };
  } catch { return d; }
}
export function saveLocal(s: Settings): void { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } }

/** Maps from key code to action for the input handlers. */
export function keyMaps(s: Settings): { steer: Record<string, 'L' | 'R' | 'F'>; gear: Record<string, number>; pause: Set<string> } {
  const steer: Record<string, 'L' | 'R' | 'F'> = {}, gear: Record<string, number> = {}, pause = new Set<string>();
  for (const c of s.bindings.left) steer[c] = 'L';
  for (const c of s.bindings.right) steer[c] = 'R';
  for (const c of s.bindings.fire) steer[c] = 'F';
  s.bindings.gear1.forEach((c) => { gear[c] = 0; }); s.bindings.gear2.forEach((c) => { gear[c] = 1; }); s.bindings.gear3.forEach((c) => { gear[c] = 2; });
  for (const c of s.bindings.pause) pause.add(c);
  return { steer, gear, pause };
}

export function keyName(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return ({ ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space', Escape: 'Esc', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', Enter: 'Enter' } as Record<string, string>)[code] ?? code;
}

/** The settings sheet. `onSave` receives the new settings (the caller applies and syncs them). */
export function renderSettings(root: HTMLElement, current: Settings, onSave: (s: Settings) => void, onClose: () => void): void {
  const s: Settings = { bindings: Object.fromEntries(Object.entries(current.bindings).map(([k, v]) => [k, [...v]])) as Record<Action, string[]>, sound: current.sound, reducedMotion: current.reducedMotion };
  let capture: { action: Action; slot: number; btn: HTMLButtonElement } | null = null;
  const list = document.createElement('div'); list.className = 'hg-list';
  const draw = () => {
    list.replaceChildren();
    for (const a of ACTIONS) {
      const row = document.createElement('div'); row.className = 'hg-row';
      const name = document.createElement('span'); name.className = 'hg-name'; name.textContent = a.label;
      row.append(name);
      for (let i = 0; i < 2; i++) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost sm keycap';
        b.textContent = s.bindings[a.id][i] ? keyName(s.bindings[a.id][i]!) : '—';
        b.setAttribute('aria-label', `${a.label}, key ${i + 1}`);
        b.addEventListener('click', () => { capture = { action: a.id, slot: i, btn: b }; b.textContent = 'press a key'; b.classList.add('capturing'); });
        row.append(b);
      }
      list.append(row);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (!capture) return;
    e.preventDefault(); e.stopPropagation();
    if (e.code !== 'Escape' || capture.action === 'pause') {
      // a key belongs to one action: remove it elsewhere first
      for (const a of ACTIONS) s.bindings[a.id] = s.bindings[a.id].filter((c) => c !== e.code);
      const arr = s.bindings[capture.action];
      arr[capture.slot] = e.code;
      s.bindings[capture.action] = arr.filter(Boolean);
    }
    capture = null; draw();
  };
  window.addEventListener('keydown', onKey, true);
  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost';
    const paint = () => { b.textContent = `${label}: ${get() ? 'on' : 'off'}`; b.setAttribute('aria-pressed', String(get())); };
    b.addEventListener('click', () => { set(!get()); paint(); }); paint();
    return b;
  };
  const head = document.createElement('div'); head.className = 'kicker'; head.textContent = 'Controls and settings';
  const touch = document.body.classList.contains('touch');
  const note = document.createElement('p'); note.className = 'note'; note.textContent = touch ? 'On a phone: drag on the river to steer, hold FIRE with another finger, and tap the Gear buttons on screen.' : 'Click a key box, then press the key you want. Each action takes up to two keys.';
  const row = document.createElement('div'); row.className = 'set-toggles';
  row.append(toggle('Sound', () => s.sound, (v) => { s.sound = v; }), toggle('Reduced motion', () => s.reducedMotion, (v) => { s.reducedMotion = v; }));
  const acts = document.createElement('div'); acts.className = 'set-acts';
  const save = document.createElement('button'); save.type = 'button'; save.className = 'btn'; save.textContent = 'Save';
  const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'btn ghost set-defaults'; reset.textContent = 'Defaults';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'btn ghost'; close.textContent = 'Back';
  const done = () => { window.removeEventListener('keydown', onKey, true); };
  save.addEventListener('click', () => { done(); onSave(s); onClose(); });
  reset.addEventListener('click', () => { const d = defaults(); s.bindings = d.bindings; draw(); });
  close.addEventListener('click', () => { done(); onClose(); });
  acts.append(save, reset, close);
  draw();
  root.replaceChildren(head, note, list, row, acts);
}
