import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createCoordinatorResponder } from '../coordinator-requests.js';
import { capture, registerRouterEndpoints, answerCoordinatorRequests, sendPacket, SLStatus } from '../router.js';

const basicFrame = { profileId: 0x0104, clusterId: 0, sourceEndpoint: 1, destinationEndpoint: 1 };
const request = Buffer.from('00320001000300050007000400', 'hex');
const response = Buffer.from('18320101000020010300002000050000420d5a696762656520526f757465720700003004040000420747656e65726963', 'hex');
const reportingRequest = Buffer.from('003306000700300000feff', 'hex');
const manufacturerCode = 0xcafe;
const identifyFrame = { ...basicFrame, clusterId: 3 };
const privateIdentifyRead = Buffer.from('04feca35000040', 'hex');
const privateIdentifyReply = Buffer.from('1cfeca35010040001000', 'hex');

class MockEzsp extends EventEmitter {
    version = 13;
    sent = [];

    ezspIncomingMessageHandler(type, frame, info, payload) {
        this.emit('incomingMessage', type, frame, info.lastHopLqi, info.senderShortId, payload);
    }

    receive(payload, frame = basicFrame, senderShortId = 0, type = 0) {
        this.ezspIncomingMessageHandler(type, frame, { lastHopLqi: 240, senderShortId }, payload);
    }

    async ezspSendUnicast(type, destination, frame, tag, payload) {
        this.sent.push({ type, destination, frame, tag, payload });
        return [SLStatus.OK];
    }

    delivered(index, status = SLStatus.OK) {
        const { type, destination, frame, tag } = this.sent[index];
        this.emit('messageSent', status, type, destination, frame, tag);
    }
}

test('answers Basic and standard Identify reads', () => {
    const reply = createCoordinatorResponder(manufacturerCode);
    assert.deepEqual(reply(0, request)?.payload, response);
    assert.equal(reply(0, Buffer.from('103300ffff', 'hex'))?.payload.toString('hex'), '183301ffff86');
    assert.equal(reply(3, Buffer.from('0034000000', 'hex'))?.payload.toString('hex'), '183401000000210000');
});

test('keeps the Identify countdown independent of wall-clock changes', t => {
    const clock = t.mock.method(Date, 'now', () => 100_000_000);
    const reply = createCoordinatorResponder(manufacturerCode);
    reply(3, Buffer.from('113300ffff', 'hex'));
    clock.mock.mockImplementation(() => 0);
    const seconds = reply(3, Buffer.from('0034000000', 'hex')).payload.readUInt16LE(7);
    assert.ok(seconds > 0 && seconds <= 0xffff);
});

test('answers Power Source reporting configuration with the requested status', () => {
    const reply = createCoordinatorResponder(manufacturerCode);
    for (const intervals of ['00000000', '0000ffff', '0000feff']) {
        const answer = reply(0, Buffer.from('10330600070030' + intervals, 'hex'));
        assert.equal(answer.payload.toString('hex'), '18330700');
        assert.equal(answer.reportingConfigured, true);
    }

    for (const intervals of ['ffff0000', 'fffffeff', '00003c00']) {
        const answer = reply(0, Buffer.from('10330600070030' + intervals, 'hex'));
        assert.equal(answer.payload.toString('hex'), '18330787000700');
        assert.equal(answer.reportingConfigured, false);
    }
});

test('serves the inactive Identify attribute for the configured manufacturer', () => {
    const reply = createCoordinatorResponder(manufacturerCode);
    assert.deepEqual(reply(3, privateIdentifyRead)?.payload, privateIdentifyReply);

    const readUnknownAttribute = Buffer.from('04feca36000140', 'hex');
    assert.equal(reply(3, readUnknownAttribute)?.payload.toString('hex'), '1cfeca3601014086');
});

test('uses the request manufacturer for the inactive Identify read only', () => {
    const reply = createCoordinatorResponder(0x10f2);
    const readInactive = Buffer.from('04211234000040', 'hex');
    assert.equal(reply(3, readInactive)?.payload.toString('hex'), '1c211234010040001000');
    assert.equal(reply(0, readInactive), undefined);

    const readUnknown = Buffer.from('04211235000140', 'hex');
    const readMixed = Buffer.from('042112360000400140', 'hex');
    assert.equal(reply(3, readUnknown), undefined);
    assert.equal(reply(3, readMixed), undefined);
});

test('filters directed ZCL requests from the coordinator and keeps streaming them', async t => {
    const ezsp = new MockEzsp();
    const stop = new AbortController();
    const seen = [];
    t.after(() => stop.abort());
    capture(ezsp, packet => seen.push(packet));
    ezsp.receive(request);
    assert.equal(ezsp.sent.length, 0);

    answerCoordinatorRequests(ezsp, { manufacturerCode, timeout: 1000, signal: stop.signal, log: assert.fail });
    ezsp.receive(request, basicFrame, 0x1234);
    ezsp.receive(request, basicFrame, 0, 4);
    ezsp.receive(request, { ...basicFrame, profileId: 0xc05e });
    ezsp.receive(request, { ...basicFrame, clusterId: 0xaabb });
    ezsp.receive(request, { ...basicFrame, destinationEndpoint: 2 });
    for (const ignored of ['04341232000100', '00', '10320001', '00320b0000', '1832010000002008', '18320a07003004']) {
        ezsp.receive(Buffer.from(ignored, 'hex'));
    }
    await setImmediate();
    assert.equal(ezsp.sent.length, 0);

    const streamCount = seen.length;
    ezsp.receive(request);
    await setImmediate();
    assert.equal(seen.length, streamCount + 1);
    assert.deepEqual(seen.at(-1).payload, request);
    assert.equal(ezsp.sent.length, 1);
    const [reply] = ezsp.sent;
    assert.equal(reply.destination, 0);
    for (const [field, value] of Object.entries(basicFrame)) {
        assert.equal(reply.frame[field], value);
    }
    assert.deepEqual(reply.payload, response);
    ezsp.delivered(0);

    stop.abort();
    ezsp.receive(request);
    await setImmediate();
    assert.equal(ezsp.sent.length, 1);
});

test('completes the reporting exchange after delivery and replies to the requesting endpoint', async t => {
    const ezsp = new MockEzsp();
    const stop = new AbortController();
    t.after(() => stop.abort());
    const complete = answerCoordinatorRequests(ezsp, { manufacturerCode, timeout: 1000, signal: stop.signal, log: assert.fail });
    let completed = false;
    complete.then(() => { completed = true; }, () => {});

    ezsp.receive(reportingRequest);
    ezsp.receive(privateIdentifyRead, { ...identifyFrame, sourceEndpoint: 2 }, 0, 1);
    await setImmediate();
    assert.equal(ezsp.sent.length, 1);
    assert.equal(ezsp.sent[0].frame.clusterId, 0);
    assert.equal(ezsp.sent[0].payload.toString('hex'), '18330700');
    assert.equal(completed, false);
    ezsp.delivered(0);
    await complete;
    assert.equal(completed, true);
    await setImmediate();
    assert.equal(ezsp.sent.length, 2);
    assert.equal(ezsp.sent[1].frame.clusterId, 3);
    assert.equal(ezsp.sent[1].frame.sourceEndpoint, 1);
    assert.equal(ezsp.sent[1].frame.destinationEndpoint, 2);
    assert.deepEqual(ezsp.sent[1].payload, privateIdentifyReply);
    ezsp.delivered(1);
});

test('registers responder clusters without losing standard endpoints or multicast groups', async () => {
    for (const withResponder of [false, true]) {
        const endpoints = new Map();
        const groups = [];
        const ezsp = {
            async ezspGetEndpointFlags(endpoint) {
                return [endpoints.has(endpoint) ? SLStatus.OK : SLStatus.NOT_FOUND];
            },
            async ezspAddEndpoint(endpoint, profile, device, version, input, output) {
                assert.equal(endpoints.has(endpoint), false);
                endpoints.set(endpoint, { profile, device, version, input, output });
                return SLStatus.OK;
            },
            async ezspSetMulticastTableEntry(index, entry) {
                groups[index] = entry;
                return SLStatus.OK;
            },
        };
        await registerRouterEndpoints(ezsp, withResponder);
        assert.deepEqual(endpoints.get(1), {
            profile: 0x0104,
            device: 8,
            version: 1,
            input: withResponder ? [0, 0x1000, 3] : [0, 0x1000],
            output: withResponder ? [0x19, 0, 3, 0x0201] : [0x19],
        });
        assert.deepEqual([...endpoints.keys()], [1, 242]);
        assert.deepEqual(groups.map(entry => entry.multicastId), [0, 901, 0x0b84]);
    }
});

test('responds while a client is waiting for its own reply from the coordinator', async t => {
    const ezsp = new MockEzsp();
    const stop = new AbortController();
    const warnings = [];
    t.after(() => stop.abort());
    answerCoordinatorRequests(ezsp, {
        manufacturerCode,
        timeout: 1000,
        signal: stop.signal,
        log: (_level, message) => warnings.push(message),
    });
    const clientRead = sendPacket(ezsp, {
        destination: 0,
        clusterId: 0,
        payload: Buffer.from('1041000000', 'hex'),
    }, 1, 1000, stop.signal, { timeout: 1000 });
    clientRead.catch(() => {});

    ezsp.receive(request);
    await setImmediate();
    assert.equal(ezsp.sent.length, 2);
    assert.notEqual(ezsp.sent[0].tag, ezsp.sent[1].tag);
    assert.deepEqual(ezsp.sent[1].payload, response);
    ezsp.delivered(0, SLStatus.ZIGBEE_DELIVERY_FAILED);
    ezsp.delivered(1);
    const clientResponse = Buffer.from('1841010000002008', 'hex');
    ezsp.receive(clientResponse);
    assert.deepEqual((await clientRead).payload, clientResponse);
    await setImmediate();
    assert.deepEqual(warnings, []);
});
