import { useEffect } from 'react';
import { isMobileOrTablet } from '../utils/device';

const REF_WIDTH = 360;
const REF_HEIGHT = 800;
const BASE_FONT_SIZE = 16;

export const useMobileScaling = () => {
    useEffect(() => {
        const handleResize = () => {
            document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);

            const isSmallScreen = window.innerWidth <= 768;

            if (!isMobileOrTablet && !isSmallScreen) {
                document.documentElement.style.removeProperty('font-size');
                return;
            }

            const scaleX = window.innerWidth / REF_WIDTH;
            const scaleY = window.innerHeight / REF_HEIGHT;
            const scale = Math.min(scaleX, scaleY);

            document.documentElement.style.fontSize = `${BASE_FONT_SIZE * scale}px`;
        };

        window.addEventListener('resize', handleResize);
        window.addEventListener('orientationchange', handleResize);
        handleResize();

        return () => {
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('orientationchange', handleResize);
            document.documentElement.style.removeProperty('font-size');
        };
    }, []);
};
