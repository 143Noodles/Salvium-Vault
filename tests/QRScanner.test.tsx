import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QRScanner from '../components/QRScanner';

const html5QrcodeMocks = vi.hoisted(() => ({
    constructor: vi.fn(),
    getCameras: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    clear: vi.fn(),
}));

vi.mock('html5-qrcode', () => {
    const Html5Qrcode = html5QrcodeMocks.constructor.mockImplementation(function Html5QrcodeMock() {
        return {
            start: html5QrcodeMocks.start,
            stop: html5QrcodeMocks.stop,
            clear: html5QrcodeMocks.clear,
            get isScanning() {
                return true;
            },
        };
    });
    (Html5Qrcode as any).getCameras = html5QrcodeMocks.getCameras;

    return {
        Html5Qrcode,
        Html5QrcodeSupportedFormats: { QR_CODE: 0 },
    };
});

describe('QRScanner camera permissions', () => {
    const getUserMedia = vi.fn();
    const stopTrack = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        getUserMedia.mockResolvedValue({
            getTracks: () => [{ stop: stopTrack }],
        });
        html5QrcodeMocks.getCameras.mockResolvedValue([
            { id: 'front-camera', label: 'Front Camera' },
            { id: 'back-camera', label: 'Back Camera' },
        ]);
        html5QrcodeMocks.start.mockResolvedValue(null);
        html5QrcodeMocks.stop.mockResolvedValue(undefined);

        Object.defineProperty(globalThis.navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia },
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('requests camera permission before starting the QR scanner', async () => {
        render(<QRScanner onScan={vi.fn()} onClose={vi.fn()} />);

        await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({
            audio: false,
            video: { facingMode: { ideal: 'environment' } },
        }));
        await waitFor(() => expect(html5QrcodeMocks.start).toHaveBeenCalled());

        expect(stopTrack).toHaveBeenCalled();
        expect(html5QrcodeMocks.getCameras).toHaveBeenCalled();
        expect(html5QrcodeMocks.start.mock.calls[0][0]).toBe('back-camera');
    });

    it('shows a permission error when camera access is denied', async () => {
        const deniedError = new Error('Permission denied');
        deniedError.name = 'NotAllowedError';
        getUserMedia.mockRejectedValueOnce(deniedError);

        render(<QRScanner onScan={vi.fn()} onClose={vi.fn()} />);

        expect(await screen.findByText('Camera permission is required to scan QR codes.')).not.toBeNull();
        expect(html5QrcodeMocks.start).not.toHaveBeenCalled();
    });
});
