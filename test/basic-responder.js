import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { basicReadResponse, createInterview } from '../interview.js';
import { capture, respondToBasicReads, sendPacket, SLStatus } from '../router.js';

const basicFrame = { profileId: 0x0104, clusterId: 0, sourceEndpoint: 1, destinationEndpoint: 1 };
const request = Buffer.from('00320001000300050007000400', 'hex');
const response = Buffer.from('18320101000020010300002000050000420d5a696762656520526f757465720700003004040000420747656e65726963', 'hex');

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

test('answers the captured Basic read with the same attributes as the interview', () => {
    assert.deepEqual(basicReadResponse(request), response);
    assert.deepEqual(createInterview()(0, request)?.payload, response);
    assert.equal(basicReadResponse(Buffer.from('103300ffff', 'hex'))?.toString('hex'), '183301ffff86');
});

test('answers only standard coordinator Basic reads and keeps streaming the request', async t => {
    const ezsp = new MockEzsp();
    const stop = new AbortController();
    const seen = [];
    t.after(() => stop.abort());
    capture(ezsp, packet => seen.push(packet));
    ezsp.receive(request);
    assert.equal(ezsp.sent.length, 0);

    respondToBasicReads(ezsp, 1000, stop.signal, assert.fail);
    ezsp.receive(request, basicFrame, 0x1234);
    ezsp.receive(request, basicFrame, 0, 4);
    ezsp.receive(request, { ...basicFrame, profileId: 0xc05e });
    ezsp.receive(request, { ...basicFrame, clusterId: 3 });
    ezsp.receive(request, { ...basicFrame, sourceEndpoint: 2 });
    ezsp.receive(request, { ...basicFrame, destinationEndpoint: 2 });
    for (const ignored of ['04341232000100', '0832000100', '0132000100', '0032060100', '00320001']) {
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

test('responds while a client is waiting for its own reply from the coordinator', async t => {
    const ezsp = new MockEzsp();
    const stop = new AbortController();
    const warnings = [];
    t.after(() => stop.abort());
    respondToBasicReads(ezsp, 1000, stop.signal, (_level, message) => warnings.push(message));
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
