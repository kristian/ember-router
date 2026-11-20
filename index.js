#!/usr/bin/env node
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Command, InvalidArgumentError, Option } from 'commander';
import packageJson from './package.json' with { type: 'json' };
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

function parsePacket(line) {
    const packet = JSON.parse(line);
    if (packet === null || typeof packet !== 'object' || Array.isArray(packet)) {
        throw new Error('Expected a packet object.');
    }
    return packet;
}

function createSender(ezsp, timeout, signal) {
    let tag = 0;
    let pending = Promise.resolve();
    return (packet, expect, requestSignal = signal) => {
        const operation = pending.then(() => {
            requestSignal.throwIfAborted();
            tag = (tag + 1) & 0x7f;
            return sendPacket(ezsp, packet, tag, timeout, requestSignal, expect);
        });
        pending = operation.catch(() => {});
        return operation;
    };
}

async function readWrites(send, signal) {
    const { stdin } = process;
    if (stdin.readableEnded || stdin.destroyed) {
        return;
    }

    const input = createInterface({ input: stdin, crlfDelay: Infinity, terminal: false });
    const closeInput = () => input.close();
    signal.addEventListener('abort', closeInput, { once: true });

    let lineNumber = 0;
    try {
        for await (const line of input) {
            if (signal.aborted) {
                break;
            }

            lineNumber++;
            if (!line.trim()) {
                continue;
            }

            try {
                await send(parsePacket(line));
            } catch (error) {
                if (signal.aborted) {
                    break;
                }
                process.exitCode = 1;
                writeLog('error', `Write line ${lineNumber}: ${error.message}`);
            }
        }
    } finally {
        signal.removeEventListener('abort', closeInput);
        input.close();
        stdin.pause();
    }
}

async function readPacketLine() {
    const { stdin } = process;
    const input = createInterface({ input: stdin, crlfDelay: Infinity, terminal: false });
    try {
        for await (const line of input) {
            if (line.trim()) {
                return line;
            }
        }
        throw new Error('Expected a packet on stdin.');
    } finally {
        input.close();
        stdin.pause();
    }
}

async function readOnce(options) {
    const packet = parsePacket(await readPacketLine());
    const reply = await run(options, 'read', packet);
    process.stdout.write(`${JSON.stringify(reply)}\n`);
}

async function run(options, mode, packet) {
    const join = mode === 'join';
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
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    process.stdout.on('error', brokenPipe);
    let session;
    let closeSocket;
    try {
        session = await openRouter(options, log);
        signal.throwIfAborted();
        const { ezsp } = session;
        ezsp.on('ncpNeedsResetAndInit', () => stop.abort(new Error('Adapter needs a reset. Restart ember-router to resume.')));
        if (mode === 'reset') {
            const eui64 = await resetRouter(ezsp, options, signal);
            writeLog('info', 'Reset NVM3 tokens.');
            writeLog('info', `Adapter EUI64: ${eui64}`);
            return;
        }

        ezsp.on('stackStatus', status => {
            if (status === SLStatus.NETWORK_DOWN && !signal.aborted) {
                stop.abort(new Error('Network went down.'));
            }
        });
        if (mode === 'run' || mode === 'write') {
            capture(ezsp, record => {
                if (signal.aborted) {
                    return;
                }
                process.stdout.write(`${JSON.stringify(record)}\n`);
                if (process.stdout.writableLength > 1024 * 1024) {
                    stop.abort(new Error('JSON output consumer is too slow.'));
                }
            });
        }

        const network = await attachNetwork(ezsp, options, join, signal);
        writeLog('info', `${join ? 'Joined' : 'Resumed'} PAN 0x${network.panId.toString(16)} on channel ${network.radioChannel}.`);
        if (join) {
            return;
        }

        signal.throwIfAborted();
        const expect = { commandId: options.expect, timeout: options.readTimeout };
        if (mode === 'read') {
            return await sendPacket(ezsp, packet, 1, options.writeTimeout, signal, expect);
        }

        const send = createSender(ezsp, options.writeTimeout, signal);
        if (options.socket !== undefined) {
            const read = async (line, requestSignal) => {
                try {
                    return await send(parsePacket(line), expect, requestSignal);
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
        try {
            try {
                await closeSocket?.();
            } finally {
                await session?.close();
            }
        } finally {
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', interrupt);
            process.stdout.off('error', brokenPipe);
        }
    }
}

const program = new Command().name('ember-router').version(packageJson.version)
    .description('Resume a saved Zigbee router network and stream packets, or join an open network')
    .requiredOption('-p, --path <path>', 'Serial port or tcp://host:port')
    .option('-b, --baud-rate <rate>', 'Serial baud rate', integer(1, 4_000_000), 115200)
    .option('-r, --rtscts', 'Use RTS/CTS flow control', false)
    .option('-m, --manufacturer-code <code>', 'ZCL manufacturer enum name, decimal or hex', manufacturer, Zcl.ManufacturerCode.SILICON_LABORATORIES)
    .option('--timeout <ms>', 'Network and scan callback timeout', integer(100, 300_000), 45000)
    .option('-v, --verbose', 'Increase diagnostic verbosity', (_, count) => count + 1, 0);

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

readOptions(program.command('run', { isDefault: true }))
    .description('Resume, stream received packets, and accept writes on stdin')
    .option('--socket <path>', 'Listen for requests on a local IPC socket')
    .action((_options, command) => {
        const options = command.optsWithGlobals();
        return run(options, 'run');
    });

packetOptions(program.command('write'))
    .description('Resume and send packets from stdin, then exit at EOF')
    .action((_options, command) => {
        const options = command.optsWithGlobals();
        return run({ ...options, exitAfterWrite: true }, 'write');
    });

readOptions(program.command('read'))
    .description('Send one packet from stdin and print the matching reply')
    .action((_options, command) => readOnce(command.optsWithGlobals()));

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
