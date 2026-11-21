import './silence-ember-zli.js';
import { createRequire } from 'node:module';
import { createInterview } from './interview.js';
import {
    emberNetworkConfig,
    emberNetworkInit,
    emberRegisterFixedEndpoints,
    emberStart,
    emberStop,
} from 'ember-zli/dist/utils/ember.js';

const requireHere = createRequire(import.meta.url);
const requireEmber = createRequire(requireHere.resolve('ember-zli'));
const { Zcl, ZSpec, setLogger } = requireEmber('zigbee-herdsman');
const {
    EmberApsOption,
    EmberExtendedSecurityBitmask,
    EmberIncomingMessageType,
    EmberInitialSecurityBitmask,
    EmberJoinMethod,
    EmberKeyStatus,
    EmberNodeType,
    EmberOutgoingMessageType,
    EzspNetworkScanType,
    EzspStatus,
    SLStatus,
} = requireEmber('zigbee-herdsman/dist/adapter/ember/enums.js');
const { AdapterTransport } = requireEmber('zigbee-herdsman/dist/adapter/transport.js');
const { DEFAULT_STACK_CONFIG } = requireEmber('zigbee-herdsman/dist/adapter/ember/adapter/emberAdapter.js');
const { STACK_PROFILE_ZIGBEE_PRO } = requireEmber('zigbee-herdsman/dist/adapter/ember/consts.js');
const { EZSP_EXTENDED_PARAMETERS_INDEX, EZSP_MAX_FRAME_LENGTH } = requireEmber('zigbee-herdsman/dist/adapter/ember/ezsp/consts.js');

export { SLStatus, Zcl };

function routerError(message, code) {
    return Object.assign(new Error(message), code ? { code } : {});
}

function check(status, operation, code) {
    if (status !== SLStatus.OK) {
        throw routerError(`${operation}: ${SLStatus[status] ?? status}`, code);
    }
}

export async function openRouter(options, log, onDisconnect, signal) {
    setLogger(Object.fromEntries(['debug', 'info', 'warning', 'error'].map(level => [
        level,
        (message, namespace) => log(level, message, namespace),
    ])));

    const transport = new AdapterTransport({
        path: options.path,
        baudRate: options.baudRate,
        rtscts: options.rtscts,
        xon: !options.rtscts,
        xoff: !options.rtscts,
    });
    let ezsp;
    let disconnected;
    let closing;
    const adapterLost = message => {
        if (!disconnected) {
            disconnected = routerError(message, 'ADAPTER_DISCONNECTED');
            onDisconnect?.(disconnected);
        }
    };
    const onClose = error => adapterLost(error instanceof Error
        ? `Adapter transport closed: ${error.message}`
        : 'Adapter transport closed.');
    const onReset = status => adapterLost(`Adapter needs a reset: ${EzspStatus[status] ?? status}.`);

    const close = () => closing ??= (async () => {
        transport.off('close', onClose);
        ezsp?.off('ncpNeedsResetAndInit', onReset);
        if (!ezsp) {
            await transport.close();
            return;
        }
        try {
            await emberStop(ezsp);
        } catch (error) {
            await transport.close().catch(closeError =>
                log('warning', `Failed to close adapter transport: ${closeError.message}`));
            throw error;
        }
    })();

    const abortConnect = () => {
        const socket = transport.socketInstance;
        if (socket?.connecting) {
            socket.destroy(signal.reason);
        }
    };
    transport.once('close', onClose);
    signal?.addEventListener('abort', abortConnect, { once: true });
    try {
        signal?.throwIfAborted();
        ezsp = await emberStart(transport);
        signal?.throwIfAborted();
        ezsp.once('ncpNeedsResetAndInit', onReset);
        await emberNetworkConfig(ezsp, DEFAULT_STACK_CONFIG, options.manufacturerCode);
        await emberRegisterFixedEndpoints(ezsp, [], true);
        signal?.throwIfAborted();
        if (disconnected || !transport.isOpen) {
            throw disconnected ?? routerError('Adapter connection closed during initialization.', 'ADAPTER_DISCONNECTED');
        }
        return { ezsp, close };
    } catch (error) {
        await close().catch(closeError => log('warning', `Failed to stop adapter: ${closeError.message}`));
        throw error;
    } finally {
        signal?.removeEventListener('abort', abortConnect);
    }
}

function pendingEvent(timeout, signal, subscribe, description = 'adapter callback', timeoutCode) {
    let unsubscribe;
    let timer;
    let abort;
    const close = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        unsubscribe?.();
        unsubscribe = undefined;
    };
    const promise = new Promise((resolve, reject) => {
        abort = () => {
            close();
            reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
            signal.throwIfAborted();
            unsubscribe = subscribe(resolve, reject);
            timer = setTimeout(() => reject(routerError(`Timed out waiting for ${description}.`, timeoutCode)), timeout);
        } catch (error) {
            reject(error);
        }
    });
    promise.catch(() => {});
    return { promise, close };
}

async function networkCommand(ezsp, command, timeout, signal, expectedStatus = SLStatus.NETWORK_UP) {
    // ember-zli's stack waiter cannot be cancelled when a command returns NOT_JOINED.
    const transition = pendingEvent(timeout, signal, (resolve, reject) => {
        const listener = status => {
            if (status === expectedStatus) {
                resolve();
            } else if (status === SLStatus.NETWORK_DOWN) {
                reject(new Error('Network went down.'));
            }
        };
        ezsp.on('stackStatus', listener);
        return () => ezsp.off('stackStatus', listener);
    });
    try {
        signal.throwIfAborted();
        const status = await command();
        if (status === SLStatus.OK) {
            await transition.promise;
        }
        return status;
    } finally {
        transition.close();
    }
}

async function scan(ezsp, options, signal) {
    const networks = new Map();
    const found = ezsp.ezspNetworkFoundHandler;
    const complete = ezsp.ezspScanCompleteHandler;
    const scanDone = pendingEvent(options.timeout, signal, resolve => {
        ezsp.ezspNetworkFoundHandler = network => {
            const extendedPanId = Buffer.from(network.extendedPanId).toString('hex');
            const matchesPan = options.panId === undefined || options.panId === network.panId;
            const matchesExtendedPan = !options.extendedPanId || options.extendedPanId === extendedPanId;

            if (network.allowingJoin && network.stackProfile === STACK_PROFILE_ZIGBEE_PRO && matchesPan && matchesExtendedPan) {
                networks.set(`${network.panId}:${extendedPanId}:${network.channel}`, network);
            }
        };
        ezsp.ezspScanCompleteHandler = (_channel, status) => resolve(status);
        return () => {
            ezsp.ezspNetworkFoundHandler = found;
            ezsp.ezspScanCompleteHandler = complete;
        };
    });
    try {
        signal.throwIfAborted();
        const channels = options.channel ? 1 << options.channel : ZSpec.ALL_802_15_4_CHANNELS_MASK;
        check(await ezsp.ezspStartScan(EzspNetworkScanType.ACTIVE_SCAN, channels, options.scanDuration), 'Start scan');
        check(await scanDone.promise, 'Complete scan');
        if (networks.size > 1) {
            throw new Error('Multiple open networks match. Specify --pan-id, --extended-pan-id or --channel.');
        }
        return networks.values().next().value;
    } finally {
        scanDone.close();
    }
}

async function configureJoinSecurity(ezsp, linkKey) {
    const useGlobalKey = linkKey === undefined;
    const preconfiguredKey = {
        contents: useGlobalKey ? Buffer.from(ZSpec.INTEROPERABILITY_LINK_KEY) : Buffer.from(linkKey, 'hex'),
    };
    const initial = EmberInitialSecurityBitmask;
    const extended = EmberExtendedSecurityBitmask;
    let initialFlags = initial.HAVE_PRECONFIGURED_KEY | initial.REQUIRE_ENCRYPTED_KEY | initial.NO_FRAME_COUNTER_RESET;
    let extendedFlags = extended.EXT_NO_FRAME_COUNTER_RESET;

    if (useGlobalKey) {
        initialFlags |= initial.TRUST_CENTER_GLOBAL_LINK_KEY;
        extendedFlags |= extended.JOINER_GLOBAL_LINK_KEY;
    }

    check(await ezsp.ezspSetInitialSecurityState({
        bitmask: initialFlags,
        preconfiguredKey,
        networkKey: { contents: Buffer.alloc(16) },
        networkKeySequenceNumber: 0,
        preconfiguredTrustCenterEui64: ZSpec.BLANK_EUI64,
    }), 'Configure join security');
    check(await ezsp.ezspSetExtendedSecurityBitmask(extendedFlags), 'Configure extended security');

    if (useGlobalKey) {
        check(await ezsp.ezspImportTransientKey(ZSpec.BLANK_EUI64, preconfiguredKey), 'Import global transient key');
    }
}

async function joinNetwork(ezsp, options, signal) {
    check(await ezsp.ezspSetRadioPower(options.radioPower), 'Set radio power');
    const selected = await scan(ezsp, options, signal);
    if (!selected) {
        throw new Error('No matching open network found. Open permit joining and retry.');
    }

    await configureJoinSecurity(ezsp, options.linkKey);
    const parameters = {
        extendedPanId: selected.extendedPanId,
        panId: selected.panId,
        radioChannel: selected.channel,
        radioTxPower: options.radioPower,
        joinMethod: EmberJoinMethod.MAC_ASSOCIATION,
        nwkManagerId: 0,
        nwkUpdateId: selected.nwkUpdateId,
        channels: 1 << selected.channel,
    };
    const status = await networkCommand(ezsp, () => ezsp.ezspJoinNetwork(EmberNodeType.ROUTER, parameters), options.timeout, signal);
    check(status, 'Join network');
    return selected;
}

async function updateTrustCenterKey(ezsp, timeout, signal) {
    const original = ezsp.ezspZigbeeKeyEstablishmentHandler;
    const verified = pendingEvent(timeout, signal, (resolve, reject) => {
        ezsp.ezspZigbeeKeyEstablishmentHandler = (partner, status) => {
            original.call(ezsp, partner, status);
            switch (status) {
                case EmberKeyStatus.VERIFY_LINK_KEY_SUCCESS:
                    resolve();
                    break;
                case EmberKeyStatus.VERIFY_LINK_KEY_FAILURE:
                case EmberKeyStatus.ESTABLISHMENT_TIMEOUT:
                case EmberKeyStatus.TABLE_FULL:
                case EmberKeyStatus.TRUST_CENTER_IS_PRE_R21:
                    reject(new Error(`Trust-center link key update: ${EmberKeyStatus[status]}.`));
                    break;
            }
        };
        return () => { ezsp.ezspZigbeeKeyEstablishmentHandler = original; };
    }, 'trust-center link key verification');

    try {
        signal.throwIfAborted();
        check(await ezsp.ezspUpdateTcLinkKey(2), 'Request trust-center link key update');
        await verified.promise;
    } finally {
        verified.close();
    }
}

function listenForInterview(ezsp, timeout, signal) {
    const reply = createInterview();
    const complete = Promise.withResolvers();
    complete.promise.catch(() => {});
    let queue = Promise.resolve();
    let tag = 0;

    const listener = (type, frame, _lqi, sender, payload) => {
        if (type > 1 || sender !== ZSpec.COORDINATOR_ADDRESS ||
            frame.profileId !== ZSpec.HA_PROFILE_ID || frame.destinationEndpoint !== 1) {
            return;
        }
        queue = queue.then(async () => {
            signal.throwIfAborted();
            const answer = reply(frame.clusterId, payload);
            if (!answer) {
                return;
            }

            tag = (tag + 1) & 0x7f;
            await sendPacket(ezsp, {
                destination: sender,
                destinationEndpoint: frame.sourceEndpoint,
                clusterId: frame.clusterId,
                payload: answer.payload,
            }, tag, timeout, signal);
            if (answer.complete) {
                complete.resolve();
            }
        }).catch(complete.reject);
    };
    ezsp.on('incomingMessage', listener);
    return { complete: complete.promise, close: () => ezsp.off('incomingMessage', listener) };
}

export async function attachNetwork(ezsp, options, join, signal) {
    const status = await networkCommand(ezsp, () => emberNetworkInit(ezsp, true), options.timeout, signal);
    if (status !== SLStatus.NOT_JOINED) {
        check(status, 'Restore network');
        if (join) {
            throw new Error('The adapter already has a saved network. Run without join to resume it.');
        }
    } else if (!join) {
        throw routerError('No saved network. Run ember-router join first.', 'NO_SAVED_NETWORK');
    }

    const stop = new AbortController();
    const joinSignal = AbortSignal.any([signal, stop.signal]);
    const interview = join && options.answerInterview ? listenForInterview(ezsp, options.timeout, joinSignal) : undefined;
    try {
        const selected = join ? await joinNetwork(ezsp, options, joinSignal) : undefined;
        const network = await verifyNetwork(ezsp, selected);
        if (!join || !options.skipPostJoinSecurity) {
            check(await ezsp.ezspPermitJoining(0), 'Close local permit joining');
        }

        if (join) {
            const interviewDone = interview && pendingEvent(options.timeout, joinSignal, (resolve, reject) => {
                interview.complete.then(resolve, reject);
            }, 'the interview reporting response');
            try {
                const keyUpdate = options.skipPostJoinSecurity
                    ? undefined
                    : updateTrustCenterKey(ezsp, options.timeout, joinSignal);
                await Promise.all([keyUpdate, interviewDone?.promise]);
            } finally {
                interviewDone?.close();
            }
        }
        return network;
    } finally {
        interview?.close();
        stop.abort();
    }
}

async function verifyNetwork(ezsp, selected) {
    const [parameterStatus, role, network] = await ezsp.ezspGetNetworkParameters();
    check(parameterStatus, 'Read network parameters');
    if (role !== EmberNodeType.ROUTER) {
        throw routerError('Saved network is not configured for a router.', 'WRONG_NODE_TYPE');
    }
    if (selected && (
        network.panId !== selected.panId ||
        network.radioChannel !== selected.channel ||
        !Buffer.from(network.extendedPanId).equals(Buffer.from(selected.extendedPanId))
    )) {
        throw new Error('Joined network did not match the scan result.');
    }

    return network;
}

export async function resetRouter(ezsp, options, signal) {
    signal.throwIfAborted();
    const eui64 = await ezsp.ezspGetEui64();
    const initialize = () => emberNetworkInit(ezsp, true);
    const status = await networkCommand(ezsp, initialize, options.timeout, signal);
    if (status !== SLStatus.NOT_JOINED) {
        check(status, 'Restore network before reset');
        const leave = () => ezsp.ezspLeaveNetwork();
        const leaveStatus = await networkCommand(ezsp, leave, options.timeout, signal, SLStatus.NETWORK_DOWN);
        check(leaveStatus, 'Leave network');
    }

    signal.throwIfAborted();
    await ezsp.ezspTokenFactoryReset(options.preserveFrameCounters, options.preserveBootCounter);
    return eui64.replace(/^0x/i, '');
}

const apsObservers = new WeakMap();

function observeAps(ezsp, observe) {
    let observers = apsObservers.get(ezsp);
    if (!observers) {
        observers = new Set();
        apsObservers.set(ezsp, observers);
        const original = ezsp.ezspIncomingMessageHandler.bind(ezsp);
        let dispatching = false;
        const dispatch = (type, frame, lqi, source, payload) => {
            for (const listener of observers) {
                listener(type, frame, lqi, source, payload);
            }
        };

        // The driver emits incomingMessage for selected profiles only.
        ezsp.ezspIncomingMessageHandler = (type, frame, info, payload) => {
            dispatch(type, frame, info.lastHopLqi, info.senderShortId, payload);
            dispatching = true;
            try {
                original(type, frame, info, payload);
            } finally {
                dispatching = false;
            }
        };
        ezsp.on('incomingMessage', (...args) => {
            if (!dispatching) {
                dispatch(...args);
            }
        });
    }
    observers.add(observe);
    return () => observers.delete(observe);
}

function apsPacket(frame, source, lqi, payload) {
    return {
        type: frame.profileId === 0 ? 'zdo' : 'aps',
        source,
        sourceEndpoint: frame.sourceEndpoint,
        destinationEndpoint: frame.destinationEndpoint,
        profileId: frame.profileId,
        clusterId: frame.clusterId,
        lqi,
        payload,
    };
}

export function capture(ezsp, emit) {
    observeAps(ezsp, (_type, frame, lqi, source, payload) => emit(apsPacket(frame, source, lqi, payload)));
    ezsp.on('touchlinkMessage', (panId, source, groupId, lqi, payload) =>
        emit({ type: 'touchlink', panId, source, groupId, lqi, payload }));
}

const attributeReplies = new Map([
    [Zcl.Foundation.read.ID, Zcl.Foundation.readRsp.ID],
    [Zcl.Foundation.write.ID, Zcl.Foundation.writeRsp.ID],
]);

function matchesReply(request, commandId, payload) {
    const header = Zcl.Header.fromBuffer(payload);
    if (!header ||
        header.transactionSequenceNumber !== request.transactionSequenceNumber ||
        header.manufacturerCode !== request.manufacturerCode ||
        header.frameControl.direction === request.frameControl.direction) {
        return false;
    }

    const defaultResponse = Zcl.Foundation.defaultRsp.ID;
    if (header.isGlobal && header.commandIdentifier === defaultResponse) {
        return payload.length >= header.length + 2 && payload[header.length] === request.commandIdentifier &&
            (commandId === defaultResponse || payload[header.length + 1] !== Zcl.Status.SUCCESS);
    }
    return header.frameControl.frameType === request.frameControl.frameType && header.commandIdentifier === commandId;
}

export async function sendPacket(ezsp, packet, tag, timeout, signal, expect) {
    const { destination, destinationEndpoint = 1, sourceEndpoint = 1, profileId = ZSpec.HA_PROFILE_ID, clusterId, payload } = packet;
    const fields = [
        ['destination', destination, 0, 0xfff7],
        ['sourceEndpoint', sourceEndpoint, 1, 254],
        ['destinationEndpoint', destinationEndpoint, 1, 240],
        ['clusterId', clusterId, 0, 0xffff],
        ['profileId', profileId, 1, 0xffff],
    ];
    for (const [label, value, min, max] of fields) {
        if (!Number.isInteger(value) || value < min || value > max) {
            throw routerError(`Invalid ${label}.`, 'INVALID_PACKET');
        }
    }
    // SEND_UNICAST uses three bytes for mode and destination, eleven for the APS frame, and one for payload length.
    const messageTagLength = ezsp.version < 0x0e ? 1 : 2;
    const maxPayloadLength = EZSP_MAX_FRAME_LENGTH - EZSP_EXTENDED_PARAMETERS_INDEX - 3 - 11 - messageTagLength - 1;
    if (!Buffer.isBuffer(payload) || payload.length === 0 || payload.length > maxPayloadLength) {
        throw routerError(`payload must contain 1 to ${maxPayloadLength} bytes.`, 'INVALID_PACKET');
    }

    const request = expect && Zcl.Header.fromBuffer(payload);
    if (expect && (!request || !(request.isGlobal || request.isSpecific) || request.frameControl.reservedBits !== 0)) {
        throw routerError('payload must have a valid ZCL header to match a reply.', 'INVALID_PACKET');
    }
    const responseCommand = expect?.commandId ?? (request?.isGlobal ? attributeReplies.get(request.commandIdentifier) : undefined);
    if (expect && responseCommand === undefined) {
        throw routerError('Use --expect to select a reply for this ZCL command.', 'EXPECT_REQUIRED');
    }

    const aps = {
        profileId,
        clusterId,
        sourceEndpoint,
        destinationEndpoint,
        groupId: 0,
        sequence: 0,
        options: EmberApsOption.RETRY | EmberApsOption.ENABLE_ROUTE_DISCOVERY,
    };
    const delivery = pendingEvent(timeout, signal, resolve => {
        const listener = (status, type, target, _frame, messageTag) => {
            if (type === EmberOutgoingMessageType.DIRECT && target === destination && messageTag === tag) {
                resolve(status);
            }
        };
        ezsp.on('messageSent', listener);
        return () => ezsp.off('messageSent', listener);
    }, 'adapter callback', 'DELIVERY_TIMEOUT');
    const reply = expect && pendingEvent(expect.timeout, signal, resolve =>
        observeAps(ezsp, (type, frame, lqi, source, payload) => {
            if ((type === EmberIncomingMessageType.UNICAST || type === EmberIncomingMessageType.UNICAST_REPLY) &&
                source === destination && frame.profileId === profileId && frame.clusterId === clusterId &&
                frame.sourceEndpoint === destinationEndpoint && frame.destinationEndpoint === sourceEndpoint &&
                matchesReply(request, responseCommand, payload)) {
                resolve(apsPacket(frame, source, lqi, payload));
            }
        }), 'ZCL reply', 'REPLY_TIMEOUT');
    try {
        signal.throwIfAborted();
        const [status] = await ezsp.ezspSendUnicast(EmberOutgoingMessageType.DIRECT, destination, aps, tag, payload);
        check(status, 'Queue write', 'QUEUE_FAILED');
        const delivered = delivery.promise.then(result => check(result, 'Deliver write', 'DELIVERY_FAILED'));
        if (!reply) {
            await delivered;
            return;
        }

        // A matching device response can arrive before the APS delivery callback, even if its ACK is lost.
        let deliveryError;
        delivered.catch(error => { deliveryError = error; });
        try {
            return await reply.promise;
        } catch (error) {
            signal.throwIfAborted();
            throw deliveryError ?? error;
        }
    } finally {
        reply?.close();
        delivery.close();
    }
}
