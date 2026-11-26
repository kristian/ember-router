#!/usr/bin/env node
import { addAbortListener, once } from 'node:events';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Command, InvalidArgumentError, Option } from 'commander';
import packageJson from './package.json' with { type: 'json' };
import { decodePackets, encodePacket } from './packet.js';
import { decodeSendPacket, encodePacketBytes, readPacketBytes } from './packet-codec.js';
import { openRequestSocket } from './request-socket.js';
import { attachNetwork, capture, openRouter, resetRouter, sendPacket, SLStatus, Zcl } from './router.js';

function integer(min, max) {
    return value => {
        const number = Number(value);
        if (!/^(?:-?\d+|0x[\da-f]+)$/i.test(value) || !Number.isInteger(number) || number < min || number > max) {
            throw new InvalidArgumentError(`Expected an integer from ${min} to ${max}.`);
        }
        return number;
    };
}

function hex(length) {
    return value => {
        if (value.length !== length || !/^[a-f\d]+$/i.test(value)) {
            throw new InvalidArgumentError(`Expected ${length} hex digits.`);
        }
        return value.toLowerCase();
    };
}

function manufacturer(value) {
    const code = Zcl.ManufacturerCode[value.toUpperCase()];
    return typeof code === 'number' ? code : integer(0, 0xffff)(value);
}

function writeLog(level, message, namespace) {
    const text = typeof message === 'function' ? message() : message;
    const prefix = typeof namespace === 'string' ? `${level} ${namespace}` : level;
    process.stderr.write(`${prefix}: ${text}\n`);
}

function createSender(ezsp, timeout, signal) {
    let tag = 0;
    let pending = Promise.resolve();
    return (packet, expect, clientSignal) => {
        const requestSignal = clientSignal ? AbortSignal.any([signal, clientSignal]) : signal;
        const operation = pending.then(() => {
            requestSignal.throwIfAborted();
            tag = (tag + 1) & 0x7f;
            return sendPacket(ezsp, packet, tag, timeout, requestSignal, expect);
        });
        pending = operation.catch(() => {});
        // Release the caller on abort while the adapter queue drains.
        return new Promise((resolve, reject) => {
            const abort = addAbortListener(requestSignal, () => reject(requestSignal.reason));
            operation.then(resolve, reject).finally(() => abort[Symbol.dispose]());
        });
    };
}

async function readWrites(send, signal) {
    const { stdin } = process;
    if (stdin.readableEnded || stdin.destroyed) {
        return;
    }

    const abort = addAbortListener(signal, () => stdin.destroy());
    let packetNumber = 0;
    try {
        for await (const bytes of readPacketBytes(stdin)) {
            if (signal.aborted) {
                break;
            }

            packetNumber++;
            try {
                await send(decodeSendPacket(bytes));
            } catch (error) {
                if (signal.aborted) {
                    break;
                }
                process.exitCode = 1;
                writeLog('error', `Write packet ${packetNumber}: ${error.message}`);
            }
        }
    } catch (error) {
        signal.throwIfAborted();
        throw error;
    } finally {
        abort[Symbol.dispose]();
        stdin.pause();
    }
}

async function readPacket() {
    const { stdin } = process;
    try {
        for await (const bytes of readPacketBytes(stdin)) {
            return decodeSendPacket(bytes);
        }
        throw new Error('Expected a packet on stdin.');
    } finally {
        stdin.pause();
    }
}

async function readOnce(options) {
    const packet = await readPacket();
    const reply = await run(options, 'read', packet);
    process.stdout.write(encodePacketBytes(reply));
}

async function* encodePackets(input) {
    const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
    let lineNumber = 0;
    try {
        for await (const line of lines) {
            lineNumber++;
            if (!line.trim()) {
                continue;
            }
            try {
                yield encodePacket(JSON.parse(line));
            } catch (error) {
                throw new Error(`Encode line ${lineNumber}: ${error.message}`);
            }
        }
    } finally {
        lines.close();
    }
}

async function* decodeJsonLines(input) {
    for await (const packet of decodePackets(input)) {
        yield `${JSON.stringify(packet)}\n`;
    }
}

async function convertPackets(packets) {
    try {
        await pipeline(process.stdin, packets, process.stdout);
    } catch (error) {
        if (error.code !== 'EPIPE') {
            throw error;
        }
    }
}

async function closeSession(session) {
    try {
        await session.close();
    } catch (error) {
        writeLog('warning', `Could not close adapter: ${error.message}`);
    }
}

async function reconnect(connect, graceful, signal) {
    for (let backoff = 5000; ; backoff = Math.min(backoff * 2, 120_000)) {
        writeLog('info', `Reconnecting to adapter in ${backoff / 1000} seconds.`);
        await delay(backoff, undefined, { signal });
        try {
            return await connect();
        } catch (error) {
            signal.throwIfAborted();
            if (graceful < 2 || ['NO_SAVED_NETWORK', 'WRONG_NODE_TYPE', 'NETWORK_CHANGED'].includes(error.code)) {
                throw error;
            }
            writeLog('warning', `Could not reconnect to adapter: ${error.message}`);
        }
    }
}

async function run(options, mode, packet) {
    const join = mode === 'join';
    const streaming = mode === 'run' || mode === 'write';
    const stop = new AbortController();
    const { signal } = stop;
    const interrupt = () => stop.abort();
    const brokenPipe = error => stop.abort(error);
    const log = (level, message, namespace) => {
        // EZSP debug traces may contain the join key in raw command bytes.
        if (join && level === 'debug') {
            return;
        }

        const alwaysLog = level === 'error' || level === 'warning' || level === 'warn';
        const minimumVerbosity = level === 'debug' ? 2 : 1;
        if (alwaysLog || options.verbose >= minimumVerbosity) {
            writeLog(level, message, namespace);
        }
    };

    let networkId;
    const connect = async () => {
        const disconnected = new AbortController();
        const sessionSignal = AbortSignal.any([signal, disconnected.signal]);
        const adapter = await openRouter(options, log, error => disconnected.abort(error), sessionSignal);
        const { ezsp } = adapter;
        let captureReady = !networkId;
        try {
            sessionSignal.throwIfAborted();
            if (mode !== 'reset') {
                ezsp.on('stackStatus', status => {
                    if (status === SLStatus.NETWORK_DOWN) {
                        disconnected.abort(new Error('Network went down.'));
                    }
                });
                if (streaming) {
                    capture(ezsp, packet => {
                        if (!captureReady || sessionSignal.aborted) {
                            return;
                        }
                        process.stdout.write(encodePacketBytes(packet));
                        if (process.stdout.writableLength > 1024 * 1024) {
                            stop.abort(new Error('Packet output consumer is too slow.'));
                        }
                    });
                }

                const network = await attachNetwork(ezsp, options, join, sessionSignal);
                sessionSignal.throwIfAborted();
                if (options.graceful) {
                    const id = Buffer.from(network.extendedPanId);
                    if (networkId && !networkId.equals(id)) {
                        throw Object.assign(new Error('Adapter resumed a different Zigbee network.'), { code: 'NETWORK_CHANGED' });
                    }
                    networkId = id;
                }
                captureReady = true;
                writeLog('info', `${join ? 'Joined' : 'Resumed'} PAN 0x${network.panId.toString(16)} on channel ${network.radioChannel}.`);
            }
            return {
                ...adapter,
                signal: sessionSignal,
                send: streaming ? createSender(ezsp, options.writeTimeout, sessionSignal) : undefined,
            };
        } catch (error) {
            await closeSession(adapter);
            throw error;
        }
    };

    let session;
    let closeSocket;
    let monitor;
    const watchSession = async () => {
        for (;;) {
            if (!session.signal.aborted) {
                await once(session.signal, 'abort');
            }
            signal.throwIfAborted();
            const error = session.signal.reason;
            if (!options.graceful || error.code !== 'ADAPTER_DISCONNECTED') {
                throw error;
            }

            const previous = session;
            session = undefined;
            writeLog('warning', error.message);
            await closeSession(previous);
            signal.throwIfAborted();
            session = await reconnect(connect, options.graceful, signal);
        }
    };

    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    process.stdout.on('error', brokenPipe);
    try {
        session = await connect();
        session.signal.throwIfAborted();
        if (mode === 'reset') {
            const eui64 = await resetRouter(session.ezsp, options, session.signal);
            writeLog('info', 'Reset NVM3 tokens.');
            writeLog('info', `Adapter EUI64: ${eui64}`);
            return;
        }
        if (join) {
            return;
        }

        const expect = { commandId: options.expect, timeout: options.readTimeout };
        if (mode === 'read') {
            if (options.settleDelay > 0) {
                await delay(options.settleDelay, undefined, { signal: session.signal });
            }
            return await sendPacket(session.ezsp, packet, 1, options.writeTimeout, session.signal, expect);
        }

        monitor = watchSession().catch(error => stop.abort(error));
        const send = (packet, expect, requestSignal) => {
            if (!session) {
                throw new Error('Adapter is reconnecting.');
            }
            return session.send(packet, expect, requestSignal);
        };
        if (options.socket !== undefined) {
            const read = async (bytes, requestSignal) => {
                try {
                    return await send(decodeSendPacket(bytes), expect, requestSignal);
                } catch (error) {
                    if (!requestSignal.aborted) {
                        writeLog('error', `Socket request: ${error.message}`);
                    }
                    return null;
                }
            };
            closeSocket = await openRequestSocket(options.socket, read, signal, error => stop.abort(error));
        }
        await readWrites(send, signal);
        if (!options.exitAfterWrite && !signal.aborted) {
            await once(signal, 'abort');
        }
        signal.throwIfAborted();
    } catch (error) {
        if (mode === 'read' || (error?.name !== 'AbortError' && error?.code !== 'EPIPE')) {
            throw error;
        }
    } finally {
        stop.abort();
        try {
            await closeSocket?.();
        } finally {
            try {
                await monitor;
                await session?.close();
            } finally {
                process.off('SIGINT', interrupt);
                process.off('SIGTERM', interrupt);
                process.stdout.off('error', brokenPipe);
            }
        }
    }
}

const program = new Command().name('ember-router').version(packageJson.version)
    .description('Run a Zigbee router, join a network, or convert packet formats')
    .option('-p, --path <path>', 'Serial port or tcp://host:port (required for adapter commands)')
    .option('-b, --baud-rate <rate>', 'Serial baud rate', integer(1, 4_000_000), 115200)
    .option('-r, --rtscts', 'Use RTS/CTS flow control', false)
    .option('-m, --manufacturer-code <code>', 'ZCL manufacturer enum name, decimal or hex', manufacturer, Zcl.ManufacturerCode.SILICON_LABORATORIES)
    .option('--timeout <ms>', 'Network and scan callback timeout', integer(100, 300_000), 45000)
    .option('-v, --verbose', 'Increase diagnostic verbosity', (_, count) => count + 1, 0);

program.hook('preAction', (_program, command) => {
    if (!['encode', 'decode'].includes(command.name()) && !command.optsWithGlobals().path) {
        command.error("error: required option '-p, --path <path>' not specified");
    }
});

program.command('join').description('Join one matching open network and save membership on the adapter')
    .option('-c, --channel <channel>', 'Scan only this Zigbee channel', integer(11, 26))
    .option('--pan-id <pan>', 'Filter by decimal or 0x-prefixed PAN ID', integer(0, 0xfffe))
    .option('--extended-pan-id <hex>', 'Filter by the 16 hex digits in EZSP byte order', hex(16))
    .addOption(new Option('-l, --link-key <hex>', 'Use a private 16-byte link key instead of the global link key').env('EMBER_ROUTER_LINK_KEY').argParser(hex(32)))
    .option('-P, --radio-power <dbm>', 'Radio transmit power', integer(-128, 127), 5)
    .option('--scan-duration <exponent>', 'EZSP active scan duration', integer(0, 14), 4)
    .option('--answer-interview', 'Answer the coordinator interview and wait for its reporting exchange')
    .option('--skip-post-join-security', 'Skip closing local permit-join and updating the trust-center link key')
    .action((_options, command) => run(command.optsWithGlobals(), 'join'));

function packetOptions(command) {
    return command
        .option('--write-timeout <ms>', 'Wait for each APS delivery status', integer(100, 300_000), 15000);
}

function readOptions(command) {
    return packetOptions(command)
        .option('--read-timeout <ms>', 'Wait for a matching ZCL reply', integer(100, 300_000), 5000)
        .option('--expect <commandId>', 'Expected ZCL reply command ID (inferred for attribute reads and writes)', integer(0, 255));
}

function gracefulOption() {
    return new Option('-g, --graceful', 'Reconnect after adapter loss (-g once, -gg repeatedly)')
        .argParser((_, count) => count + 1)
        .default(0);
}

readOptions(program.command('run', { isDefault: true }))
    .addOption(gracefulOption())
    .description('Resume, stream received packets, and accept writes on stdin')
    .option('--socket <path>', 'Listen for requests on a local IPC socket')
    .action((_options, command) => {
        const options = command.optsWithGlobals();
        return run(options, 'run');
    });

packetOptions(program.command('write'))
    .addOption(gracefulOption())
    .description('Resume and send packets from stdin, then exit at EOF')
    .action((_options, command) => {
        const options = command.optsWithGlobals();
        return run({ ...options, exitAfterWrite: true }, 'write');
    });

readOptions(program.command('read'))
    .description('Send one packet from stdin and print the matching reply')
    .option('--settle-delay <ms>', 'Wait after resuming the network before sending', integer(0, 300_000), 0)
    .action((_options, command) => readOnce(command.optsWithGlobals()));

program.command('encode')
    .description('Encode packets to send from JSON Lines to binary')
    .action(() => convertPackets(encodePackets));

program.command('decode')
    .description('Decode received binary packets to JSON Lines')
    .action(() => convertPackets(decodeJsonLines));

program.command('reset').description('Leave the saved network and reset NVM3 tokens')
    .option('--yes', 'Confirm deletion of saved adapter state')
    .option('--preserve-frame-counters', 'Keep outgoing network and APS frame counter tokens', false)
    .option('--preserve-boot-counter', 'Keep the stack boot counter token', false)
    .action((_options, command) => {
        const options = command.optsWithGlobals();
        if (!options.yes) {
            command.error('Reset erases saved network state and NVM3 tokens. Pass --yes to confirm.');
        }
        return run(options, 'reset');
    });

try {
    await program.parseAsync();
} catch (error) {
    writeLog('error', error.message);
    process.exitCode = 1;
}
