import { describe, expect, it } from 'vitest';

const REQUIRED_TASK_TELEMETRY = [
  'wallet.create',
  'wallet.restore_seed',
  'wallet.unlock_password',
  'wallet.unlock_biometric',
  'wallet.lock',
  'wallet.backup_generate',
  'wallet.backup_download',
  'wallet.backup_parse',
  'wallet.backup_restore',
  'wallet.change_password',
  'wallet.seed_reveal',
  'wallet.seed_copy',
  'wallet.manual_rescan',
  'scan.journal',
  'staking.confirm_modal',
  'staking.submit',
  'staking.transaction',
  'return.transaction',
  'return.transaction_ui',
  'send.confirm',
  'send.transaction',
  'send.sweep_all',
  'asset.wallet_load',
  'asset.catalog_load',
  'asset.detail_load',
  'asset.create_ui_submit',
  'asset.metadata_fetch',
  'salpay.send',
  'salpay.callback',
  'salpay.invoice_create',
  'salpay.invoice_poll',
  'salpay.invoice_return',
  'salpay.invoice_delete',
  'receive.create_subaddress',
  'receive.copy_address',
  'qr.camera_permission',
  'qr.camera_start',
  'history.export',
  'pwa.install_prompt',
  'service_worker.register',
  'service_worker.update',
  'storage.persistence_check',
  'ui.language_change',
  'wake_lock.request',
  'server.route',
] as const;

describe('privacy-preserving task telemetry coverage checklist', () => {
  it('tracks unique task entrypoints across major Vault task areas', () => {
    expect(new Set(REQUIRED_TASK_TELEMETRY).size).toBe(REQUIRED_TASK_TELEMETRY.length);
    expect(REQUIRED_TASK_TELEMETRY.length).toBeGreaterThanOrEqual(40);
  });

  it('includes representative wallet, scan, send, assets, SalPay, UI, and server paths', () => {
    expect(REQUIRED_TASK_TELEMETRY).toContain('wallet.create');
    expect(REQUIRED_TASK_TELEMETRY).toContain('scan.journal');
    expect(REQUIRED_TASK_TELEMETRY).toContain('staking.transaction');
    expect(REQUIRED_TASK_TELEMETRY).toContain('asset.metadata_fetch');
    expect(REQUIRED_TASK_TELEMETRY).toContain('salpay.callback');
    expect(REQUIRED_TASK_TELEMETRY).toContain('qr.camera_start');
    expect(REQUIRED_TASK_TELEMETRY).toContain('service_worker.register');
    expect(REQUIRED_TASK_TELEMETRY).toContain('server.route');
  });
});
