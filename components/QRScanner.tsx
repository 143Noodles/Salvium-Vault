import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { X, RefreshCw, AlertCircle } from './Icons';
import { Button } from './UIComponents';

interface QRScannerProps {
    onScan: (data: string) => void;
    onClose: () => void;
}

const QRScanner: React.FC<QRScannerProps> = ({ onScan, onClose }) => {
    const [error, setError] = useState<string | null>(null);
    const [isInitializing, setIsInitializing] = useState(true);
    const scannerRef = useRef<Html5Qrcode | null>(null);
    const elementId = "qr-reader";

    useEffect(() => {
        const startScanner = async () => {
            try {
                const html5QrCode = new Html5Qrcode(elementId);
                scannerRef.current = html5QrCode;

                const config = {
                    fps: 10,
                    qrbox: { width: 250, height: 250 },
                    aspectRatio: 1.0,
                    formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE]
                };

                await html5QrCode.start(
                    { facingMode: "environment" },
                    config,
                    (decodedText) => {
                        // Success
                        onScan(decodedText);
                        stopAndClose();
                    },
                    (errorMessage) => {
                        // Scan error (usually just "no QR code found in frame")
                        // We ignore these to keep the console clean
                    }
                );
                setIsInitializing(false);
            } catch (err: any) {
                setError(err.message || "Failed to start camera. Please ensure you have granted camera permissions.");
                setIsInitializing(false);
            }
        };

        startScanner();

        return () => {
            stopScanner();
        };
    }, []);

    const stopScanner = async () => {
        if (scannerRef.current && scannerRef.current.isScanning) {
            try {
                await scannerRef.current.stop();
                scannerRef.current.clear();
            } catch {
                // Scanner stop failed - may already be stopped
            }
        }
    };

    const stopAndClose = async () => {
        await stopScanner();
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[300] bg-black flex flex-col items-center justify-center p-4">
            {/* Header */}
            <div className="absolute top-0 left-0 right-0 p-6 flex justify-between items-center z-10 bg-gradient-to-b from-black/80 to-transparent">
                <h3 className="text-white font-bold text-lg">Scan QR Code</h3>
                <button
                    onClick={stopAndClose}
                    className="p-2 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors"
                >
                    <X size={24} />
                </button>
            </div>

            {/* Main Content */}
            <div className="relative w-full max-w-sm aspect-square bg-[#0f0f1a] rounded-2xl overflow-hidden shadow-2xl border border-white/5">
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

                {/* Overlay Guides */}
                {!isInitializing && !error && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <div className="w-[250px] h-[250px] border-2 border-accent-primary/50 rounded-2xl relative shadow-[0_0_0_1000px_rgba(0,0,0,0.5)]">
                            {/* Corners */}
                            <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-accent-primary rounded-tl-lg"></div>
                            <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-accent-primary rounded-tr-lg"></div>
                            <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-accent-primary rounded-bl-lg"></div>
                            <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-accent-primary rounded-br-lg"></div>

                            {/* Scanning Line Animation */}
                            <div className="absolute left-0 right-0 top-0 h-0.5 bg-accent-primary shadow-[0_0_15px_rgba(99,102,241,0.8)] animate-[scan_2.5s_ease-in-out_infinite]"></div>
                        </div>
                    </div>
                )}
            </div>

            {/* Instructions */}
            <div className="mt-12 text-center max-w-xs animate-fade-in">
                <p className="text-text-secondary text-sm leading-relaxed">
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
