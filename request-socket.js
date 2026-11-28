import { once } from 'node:events';
import { createServer } from 'node:net';
import { encodePacketBytes, readPacketBytes } from "./packet-io.js";

const MAX_CLIENTS = 16;

function validateSocketPath(path) {
    if (process.platform === 'win32') {
        if (typeof path !== 'string' || !/^\\\\[.?]\\pipe\\[^\\/\0]+$/i.test(path)) {
            throw new Error('Expected a Windows named pipe path (\\\\.\\pipe\\name).');
        }
    } else {
        if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) {
            throw new Error('Expected an absolute Unix socket path.');
        }
        const maxPathBytes = process.platform === 'linux' ? 107 : 103;
        if (Buffer.byteLength(path) > maxPathBytes) {
            throw new Error(`Socket path is longer than ${maxPathBytes} bytes.`);
        }
    }
}

async function serveClient(socket, handleRequest, signal) {
    const disconnected = new AbortController();
    socket.once('close', () => disconnected.abort());
    const requestSignal = AbortSignal.any([signal, disconnected.signal]);

    for await (const bytes of readPacketBytes(socket)) {
        requestSignal.throwIfAborted();
        const result = await handleRequest(bytes, requestSignal);
        requestSignal.throwIfAborted();
        await new Promise((resolve, reject) => {
            socket.write(encodePacketBytes(result), error => error ? reject(error) : resolve());
        });
    }
    socket.end();
}

export async function openRequestSocket(path, handleRequest, signal, onError) {
    validateSocketPath(path);
    signal.throwIfAborted();

    const clients = new Set();
    const server = createServer({ allowHalfOpen: true }, socket => {
        clients.add(socket);
        socket.on('error', () => socket.destroy());
        socket.once('close', () => clients.delete(socket));
        serveClient(socket, handleRequest, signal).catch(() => socket.destroy());
    });
    server.maxConnections = MAX_CLIENTS;

    let closing;
    const close = () => {
        if (!closing) {
            signal.removeEventListener('abort', abort);
            closing = new Promise(resolve => server.close(() => resolve()));
            for (const socket of clients) {
                socket.destroy();
            }
        }
        return closing;
    };
    const abort = () => {
        void close();
    };

    await once(server.listen(path), 'listening');
    if (signal.aborted) {
        await close();
        signal.throwIfAborted();
    }
    server.on('error', error => {
        void close();
        onError?.(error);
    });
    signal.addEventListener('abort', abort, { once: true });
    return close;
}
