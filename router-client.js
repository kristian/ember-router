import { createConnection } from "node:net";
import { decodePackets, encodePacket } from "./packet.js";

export function createRouterClient(path, { timeout = 30_000 } = {}) {
    if (typeof path !== "string" || !path || path.includes("\0")) {
        throw new TypeError("Expected a local socket or named pipe path.");
    }
    if (!Number.isInteger(timeout) || timeout < 0) {
        throw new RangeError("timeout must be a positive integer.");
    }

    let connection;
    let closed = false;
    let pending = Promise.resolve();

    async function exchange(bytes) {
        if (closed) {
            throw new Error("Router client is closed.");
        }
        if (!connection || connection.socket.destroyed || connection.socket.readableEnded) {
            const socket = createConnection({ path });
            // the decoder observes errors during exchanges. handle idle socket errors too
            socket.on("error", () => {});
            connection = { socket, replies: decodePackets(socket) };
        }

        const { socket, replies } = connection;
        const deadline = setTimeout(() => socket.destroy(new Error("Timed out waiting for the router reply.")), timeout);
        try {
            socket.write(bytes);
            const { done, value } = await replies.next();
            if (done) {
                throw new Error("Router disconnected before replying.");
            }
            return value;
        } catch (error) {
            socket.destroy();
            throw error;
        } finally {
            clearTimeout(deadline);
        }
    }

    return {
        async request(packet) {
            const bytes = encodePacket(packet);
            // the socket protocol matches replies to requests by order
            const result = pending.then(() => exchange(bytes));
            pending = result.catch(() => {});
            const reply = await result;
            if (reply === null) {
                throw new Error("Router could not complete the Zigbee request.");
            }
            return reply;
        },
        close() {
            closed = true;
            connection?.socket.destroy();
        },
    };
}
