import { describe, it, expect, vi, beforeEach } from 'vitest';

// A2: SellerApi Gateway onboarding. Mock the Circle Gateway client so we test the SDK's branching
// (idempotent no-op, deposit path, clear error) without network or real USDC.
const gw = {
  address: '0x5e11e0000000000000000000000000000000Aaaa',
  getBalances: vi.fn(),
  getUsdcBalance: vi.fn(),
  deposit: vi.fn(),
};
vi.mock('@circle-fin/x402-batching/client', () => ({ GatewayClient: vi.fn(() => gw) }));

const { Verdikt, OnboardingError } = await import('../src/index.js');

const vk = () => new Verdikt({ endpoint: 'http://x', signer: { privateKey: `0x${'a1'.repeat(32)}` } });
const u = (n: number) => BigInt(Math.round(n * 1e6));
function balances(availableUsdc: number, walletUsdc: number) {
  return {
    wallet: { balance: u(walletUsdc), formatted: String(walletUsdc) },
    gateway: {
      total: u(availableUsdc), available: u(availableUsdc), withdrawing: 0n, withdrawable: 0n,
      formattedTotal: '', formattedAvailable: '', formattedWithdrawing: '', formattedWithdrawable: '',
    },
  };
}

beforeEach(() => { gw.getBalances.mockReset(); gw.getUsdcBalance.mockReset(); gw.deposit.mockReset(); });

describe('gatewayBalance', () => {
  it('converts atomic units to USDC', async () => {
    gw.getBalances.mockResolvedValue(balances(0.092, 4.89));
    expect(await vk().seller.gatewayBalance()).toEqual({ availableUsdc: 0.092, totalUsdc: 0.092, walletUsdc: 4.89 });
  });
});

describe('ensureOnboarded', () => {
  it('is an idempotent no-op when already funded above min', async () => {
    gw.getBalances.mockResolvedValue(balances(0.05, 4));
    const r = await vk().seller.ensureOnboarded({ minUsdc: 0.01 });
    expect(r).toMatchObject({ onboarded: true, deposited: false, availableUsdc: 0.05 });
    expect(gw.deposit).not.toHaveBeenCalled();
  });

  it('deposits when below min and the wallet can cover it', async () => {
    gw.getBalances.mockResolvedValueOnce(balances(0, 4)).mockResolvedValue(balances(0.05, 3.95));
    gw.getUsdcBalance.mockResolvedValue({ balance: u(4), formatted: '4' });
    gw.deposit.mockResolvedValue({ depositTxHash: '0xdep', approvalTxHash: '0xapp', amount: u(0.05), formattedAmount: '0.05', depositor: gw.address });
    const r = await vk().seller.ensureOnboarded({ minUsdc: 0.01, depositUsdc: 0.05 });
    expect(r).toMatchObject({ onboarded: true, deposited: true, depositTxHash: '0xdep' });
    expect(gw.deposit).toHaveBeenCalledWith('0.05');
  });

  it('reports onboarded even if the post-deposit balance read is still stale (eventual consistency)', async () => {
    // gateway balance lags: below-min before AND right after the deposit, but the deposit confirmed.
    gw.getBalances.mockResolvedValue(balances(0, 4));
    gw.getUsdcBalance.mockResolvedValue({ balance: u(4), formatted: '4' });
    gw.deposit.mockResolvedValue({ depositTxHash: '0xdep', amount: u(0.05), formattedAmount: '0.05', depositor: gw.address });
    const r = await vk().seller.ensureOnboarded({ minUsdc: 0.01, depositUsdc: 0.05 });
    expect(r.onboarded).toBe(true);
    expect(r.deposited).toBe(true);
  });
});

describe('depositFee', () => {
  it('throws OnboardingError with the faucet hint when the wallet cannot cover the deposit', async () => {
    gw.getUsdcBalance.mockResolvedValue({ balance: 0n, formatted: '0' });
    await expect(vk().seller.depositFee(0.05)).rejects.toBeInstanceOf(OnboardingError);
    await expect(vk().seller.depositFee(0.05)).rejects.toThrow(/faucet\.circle\.com/);
    expect(gw.deposit).not.toHaveBeenCalled();
  });

  it('rejects a non-positive amount', async () => {
    await expect(vk().seller.depositFee(0)).rejects.toBeInstanceOf(OnboardingError);
  });
});
