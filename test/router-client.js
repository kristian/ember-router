import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodePacket } from "ember-router";
import { readPacketBytes } from "../packet-io.js";
import { createRouterClient } from "../router-client.js";

const write = { destination: 4660, clusterId: 513, payload: "042112010203401001" };
const read = { ...write, payload: "1002000000" };
const written = "0c2112010400";
const temperature = "08020100000029fc08";
const encodeReply = payload => encodePacket({ ...write, payload });
const failure = Buffer.alloc(2);
const disconnect = Symbol("disconnect");

async function mockRouter(t, replies, options) {
    const name = "ember-router-test-" + randomUUID().slice(0, 12);
    const path = process.platform === "win32" ? "\\\\.\\pipe\\" + name : join(tmpdir(), name + ".sock");
    const packets = [];
    const sockets = new Set();
    const firstRequest = Promise.withResolvers();
    const server = createServer(async socket => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        try {
            for await (const bytes of readPacketBytes(socket)) {
                packets.push(bytes);
                firstRequest.resolve();
                const reply = replies[packets.length - 1];
                if (reply === disconnect) {
                    socket.end();
                    return;
                }
                if (reply) {
                    socket.write(reply);
                }
            }
        } catch {
            socket.destroy();
        }
    });

    const client = createRouterClient(path, { timeout: 2000, ...options });
    t.after(async () => {
        client.close();
        for (const socket of sockets) {
            socket.destroy();
        }
        if (server.listening) {
            await new Promise(resolve => server.close(resolve));
        }
    });
    await once(server.listen(path), "listening");
    return { client, packets, firstRequest: firstRequest.promise };
}

test("retries the same bytes before sending the next queued request", async t => {
    const { client, packets } = await mockRouter(t, [failure, encodeReply(written), encodeReply(temperature)], { retry: true });
    const replies = await Promise.all([client.request(write), client.request(read)]);

    assert.deepEqual(replies.map(reply => reply.payload), [written, temperature]);
    assert.deepEqual(packets, [encodePacket(write), encodePacket(write), encodePacket(read)]);
});

test("reports an empty reply without retrying by default", async t => {
    const { client, packets } = await mockRouter(t, [failure]);

    await assert.rejects(client.request(write), /Router could not complete the Zigbee request/);
    assert.deepEqual(packets, [encodePacket(write)]);
});

test("reports a second failure and releases the request queue", async t => {
    const { client, packets } = await mockRouter(t, [failure, failure, encodeReply(temperature)], { retry: true });
    const failed = assert.rejects(client.request(write), /Router could not complete the Zigbee request/);
    const queued = client.request(read);

    await failed;
    assert.equal((await queued).payload, temperature);
    assert.deepEqual(packets, [encodePacket(write), encodePacket(write), encodePacket(read)]);
});

test("reconnects and retries after the router disconnects before replying", async t => {
    const { client, packets } = await mockRouter(t, [disconnect, encodeReply(written)], { retry: true });

    assert.equal((await client.request(write)).payload, written);
    assert.deepEqual(packets, [encodePacket(write), encodePacket(write)]);
});

test("reconnects and retries after the reply deadline expires", async t => {
    const { client, packets } = await mockRouter(t, [undefined, encodeReply(written)], { retry: true, timeout: 250 });
    assert.equal((await client.request(write)).payload, written);
    assert.deepEqual(packets, [encodePacket(write), encodePacket(write)]);
});

test("returns a Zigbee rejection response without retrying", async t => {
    const rejection = "0c2112010487";
    const { client, packets } = await mockRouter(t, [encodeReply(rejection)], { retry: true });

    assert.equal((await client.request(write)).payload, rejection);
    assert.deepEqual(packets, [encodePacket(write)]);
});

test("rejects a malformed reply without retrying", async t => {
    const { client, packets } = await mockRouter(t, [Buffer.from([1, 0, 0])], { retry: true });

    await assert.rejects(client.request(write), /Expected an APS packet/);
    assert.deepEqual(packets, [encodePacket(write)]);
});

test("closing a client cancels an in-flight request and prevents reconnecting", async t => {
    const { client, packets, firstRequest } = await mockRouter(t, [], { retry: true });
    const failed = assert.rejects(client.request(write));

    await firstRequest;
    client.close();

    await failed;
    await assert.rejects(client.request(read), /Router client is closed/);
    assert.deepEqual(packets, [encodePacket(write)]);
});
