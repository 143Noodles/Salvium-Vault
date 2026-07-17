'use strict';

let intervalId = null;

self.onmessage = (event) => {
    if (event.data === 'start') {
        if (intervalId !== null) return;
        intervalId = setInterval(() => self.postMessage(0), 12000);
        return;
    }

    if (event.data === 'stop' && intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
    }
};
