import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { X, RefreshCw, AlertCircle } from './Icons';
import { Button } from './UIComponents';
import { reportTaskEvent, startTaskTelemetry } from '../utils/clientTelemetry';

interface QRScannerProps {
    onScan: (data: string) => void;
    onClose: () => void;
}

const CAMERA_PERMISSION_ERROR = 'Camera permission is required to scan QR codes.';
const CAMERA_NOT_FOUND_ERROR = 'No camera was found on this device.';
const CAMERA_IN_USE_ERROR = 'The camera is already in use by another app.';
const CAMERA_UNAVAILABLE_ERROR = 'Camera access is not available on this device.';
const CAMERA_SECURE_CONTEXT_ERROR = 'Camera access requires a secure connection.';
const CAMERA_START_ERROR = 'Failed to start camera. Please ensure you have granted camera permissions.';

const getCameraErrorMessage = (err: unknown): string => {
    const error = err as { name?: string; message?: string } | null | undefined;
    const knownMessage = [
        CAMERA_PERMISSION_ERROR,
        CAMERA_NOT_FOUND_ERROR,
        CAMERA_IN_USE_ERROR,
        CAMERA_UNAVAILABLE_ERROR,
        CAMERA_SECURE_CONTEXT_ERROR,
        CAMERA_START_ERROR,
    ].find((message) => message === error?.message);

    if (knownMessage) {
        return knownMessage;
    }

    switch (error?.name) {
        case 'NotAllowedError':
        case 'PermissionDeniedError':
        case 'SecurityError':
            return CAMERA_PERMISSION_ERROR;
        case 'NotFoundError':
        case 'DevicesNotFoundError':
            return CAMERA_NOT_FOUND_ERROR;
        case 'NotReadableError':
        case 'TrackStartError':
            return CAMERA_IN_USE_ERROR;
        default:
            if (typeof window !== 'undefined' && window.isSecureContext === false) {
                return CAMERA_SECURE_CONTEXT_ERROR;
            }
            return error?.message || CAMERA_START_ERROR;
    }
};

const requestCameraPermission = async (): Promise<void> => {
    const task = startTaskTelemetry('qr.camera_permission', 'QRScanner');
    if (!navigator.mediaDevices?.getUserMedia) {
        task.failed(new Error(CAMERA_UNAVAILABLE_ERROR), 'unsupported');
        throw new Error(CAMERA_UNAVAILABLE_ERROR);
    }

    let stream: MediaStream | null = null;
    try {
        task.stage('get_user_media');
        stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: 'environment' } },
        });
        task.completed();
    } catch (err) {
        task.failed(err, 'permission_failed');
        throw new Error(getCameraErrorMessage(err));
    } finally {
        stream?.getTracks().forEach((track) => track.stop());
    }
};

const selectCamera = async (): Promise<string | MediaTrackConstraints> => {
    const cameras = await Html5Qrcode.getCameras();
    const preferredCamera = cameras.find((camera) => /back|rear|environment/i.test(camera.label));

    return preferredCamera?.id || { facingMode: { ideal: 'environment' } };
};

const QRScanner: React.FC<QRScannerProps> = ({ onScan, onClose }) => {
    const [error, setError] = useState<string | null>(null);
    const [isInitializing, setIsInitializing] = useState(true);
    const scannerRef = useRef<Html5Qrcode | null>(null);
    const elementId = 'qr-reader';

    useEffect(() => {
        let isActive = true;

        const startScanner = async () => {
            const task = startTaskTelemetry('qr.camera_start', 'QRScanner');
            try {
                await requestCameraPermission();
                if (!isActive) return;

                task.stage('scanner_create');
                const html5QrCode = new Html5Qrcode(elementId);
                scannerRef.current = html5QrCode;

                task.stage('camera_select');
                const cameraConfig = await selectCamera();
                if (!isActive) return;

                const config = {
                    fps: 10,
                    qrbox: { width: 250, height: 250 },
                    aspectRatio: 1.0,
                    formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE]
                };

                task.stage('scanner_start');
                await html5QrCode.start(
                    cameraConfig,
                    config,
                    (decodedText) => {
                        reportTaskEvent('completed', 'qr.scan', 'decoded', 'QRScanner', {
                            count: decodedText ? 1 : 0,
                        });
                        onScan(decodedText);
                        stopAndClose();
                    },
                    () => {}
                );

                if (isActive) {
                    setIsInitializing(false);
                    task.completed();
                }
            } catch (err) {
                task.failed(err, 'start_failed');
                if (isActive) {
                    setError(getCameraErrorMessage(err));
                    setIsInitializing(false);
                }
            }
        };

        startScanner();

        return () => {
            isActive = false;
            void stopScanner();
        };
    }, []);

    const stopScanner = async () => {
        if (scannerRef.current && scannerRef.current.isScanning) {
            const task = startTaskTelemetry('qr.camera_stop', 'QRScanner');
            try {
                await scannerRef.current.stop();
                scannerRef.current.clear();
                task.completed();
            } catch (error) {
                task.failed(error, 'stop_failed');
            }
        }
    };

    const stopAndClose = async () => {
        await stopScanner();
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[300] bg-black flex flex-col items-center justify-center overflow-hidden p-3 sm:p-4">
            <div className="absolute top-0 left-0 right-0 px-4 pb-4 pt-[calc(var(--safe-area-top)+0.75rem)] sm:p-6 flex justify-between items-center z-10 bg-gradient-to-b from-black/80 to-transparent">
                <h3 className="text-white font-bold text-lg">Scan QR Code</h3>
                <button
                    onClick={stopAndClose}
                    className="p-2 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors"
                >
                    <X size={24} />
                </button>
            </div>

            <div className="relative w-full max-w-[min(22rem,calc(100vw-1.5rem),calc(100dvh-11rem))] aspect-square bg-[#0f0f1a] rounded-2xl overflow-hidden shadow-2xl border border-white/5">
                {isInitializing && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#0f0f1a] z-10">
                        <RefreshCw size={40} className="text-accent-primary animate-spin" />
                        <p className="text-text-muted text-sm font-medium">Initializing camera...</p>
                    </div>
                )}

                {error && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center gap-4 bg-[#0f0f1a] z-20">
                        <div className="p-3 bg-red-500/10 rounded-full text-red-500">
                            <AlertCircle size={32} />
                        </div>
                        <p className="text-white font-medium">{error}</p>
                        <Button variant="secondary" onClick={stopAndClose} className="mt-2">
                            Go Back
                        </Button>
                    </div>
                )}

                <div id={elementId} className="w-full h-full"></div>

                {!isInitializing && !error && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <div className="h-[70vw] w-[70vw] max-h-[250px] max-w-[250px] border-2 border-accent-primary/50 rounded-2xl relative shadow-[0_0_0_1000px_rgba(0,0,0,0.5)]">
                            <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-accent-primary rounded-tl-lg"></div>
                            <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-accent-primary rounded-tr-lg"></div>
                            <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-accent-primary rounded-bl-lg"></div>
                            <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-accent-primary rounded-br-lg"></div>

                            <div className="absolute left-0 right-0 top-0 h-0.5 bg-accent-primary shadow-[0_0_15px_rgba(99,102,241,0.8)] animate-[scan_2.5s_ease-in-out_infinite]"></div>
                        </div>
                    </div>
                )}
            </div>

            <div className="mt-4 sm:mt-12 text-center max-w-xs animate-fade-in">
                <p className="text-text-secondary text-xs sm:text-sm leading-relaxed">
                    Position the Salvium address QR code within the frame to scan it automatically.
                </p>
            </div>

            <style>{`
        @keyframes scan {
          0%, 100% { top: 0%; opacity: 0.2; }
          50% { top: 100%; opacity: 1; }
        }
        #qr-reader {
          background: #0f0f1a !important;
          border: none !important;
        }
        #qr-reader video {
          object-fit: cover !important;
          width: 100% !important;
          height: 100% !important;
          border-radius: 1rem !important;
        }
      `}</style>
        </div>
    );
};

export default QRScanner;
