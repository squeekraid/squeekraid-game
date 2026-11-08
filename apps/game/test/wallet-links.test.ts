// Mobile sign-in: the wallet-app links open this exact page (path and query kept) in the wallet's browser.
import { describe, expect, it } from 'vitest';
import { walletDeepLinks } from '../src/hangar.ts';

describe('wallet app links', () => {
  it('point each wallet at this page, encoded', () => {
    const l = Object.fromEntries(walletDeepLinks('https://squeekraid.xyz/play/?x=1#account'));
    expect(l.MetaMask).toBe('https://metamask.app.link/dapp/squeekraid.xyz/play/?x=1');
    expect(l['Coinbase Wallet']).toBe('https://go.cb-w.com/dapp?cb_url=https%3A%2F%2Fsqueekraid.xyz%2Fplay%2F%3Fx%3D1%23account');
    expect(new URL(l['Trust Wallet']!).searchParams.get('url')).toBe('https://squeekraid.xyz/play/?x=1#account');
  });
});
