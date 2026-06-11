import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildAssetMediaSources,
  fetchExplorerAssetCatalog,
  fetchExplorerAssetDetail,
  normalizeAssetMediaUrlCandidates,
} from '../utils/assetMedia';

describe('asset media helpers', () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset();
  });

  it('normalizes IPFS media into multiple durable gateways', () => {
    expect(normalizeAssetMediaUrlCandidates('ipfs://bafy-example/path/image.png')).toEqual([
      'https://dweb.link/ipfs/bafy-example/path/image.png',
      'https://bafy-example.ipfs.dweb.link/path/image.png',
      'https://ipfs.io/ipfs/bafy-example/path/image.png',
    ]);
  });

  it('normalizes Arweave media urls used by explorer NFT metadata', () => {
    expect(normalizeAssetMediaUrlCandidates('ar://SY5byrRJsoRzMXahT53xXsXveVXySovJt4moaqm9-ns')).toEqual([
      'https://arweave.net/SY5byrRJsoRzMXahT53xXsXveVXySovJt4moaqm9-ns',
    ]);
  });

  it('prefers the media proxy but keeps direct image fallbacks', () => {
    expect(buildAssetMediaSources(['ar://abc123'])).toEqual([
      '/api/asset-media?url=https%3A%2F%2Farweave.net%2Fabc123',
      'https://arweave.net/abc123',
    ]);
  });

  it('falls back from bundled-app relative catalog calls to the public explorer API', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: vi.fn(),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ success: true, assets: [{ assetType: 'salCULT' }] }),
      } as unknown as Response);

    await expect(fetchExplorerAssetCatalog()).resolves.toEqual({
      success: true,
      assets: [{ assetType: 'salCULT' }],
    });
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/explorer-assets', expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://explorer.salvium.tools/api/assets', expect.any(Object));
  });

  it('falls back from relative asset detail calls to the public explorer API', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('network failed'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ success: true, asset: { assetType: 'salSOON' } }),
      } as unknown as Response);

    await expect(fetchExplorerAssetDetail('salSOON')).resolves.toEqual({
      success: true,
      asset: { assetType: 'salSOON' },
    });
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/explorer-assets/salSOON', expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://explorer.salvium.tools/api/assets/salSOON', expect.any(Object));
  });
});
