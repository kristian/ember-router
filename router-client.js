import { createConnection } from "node:net";
import { decodePackets, encodePacket } from "./packet.js";

const retryableErrors = new Set([
    "ROUTER_REQUEST_FAILED", "ROUTER_REPLY_TIMEOUT", "ROUTER_DISCONNECTED",
    "ECONNREFUSED", "ECONNRESET", "ENOENT", "EPIPE", "ETIMEDOUT",
]);

function routerError(message, code) {
    return Object.assign(new Error(message), { code });
}

export function createRouterClient(path, { timeout = 30_000, retry = false } = {}) {
    if (typeof path !== "string" || !path || path.includes("\0")) {
        throw new TypeError("Expected a local socket or named pipe path.");
    }
    if (!Number.isInteger(timeout) || timeout < 0) {
        throw new RangeError("timeout must be a positive integer.");
    }
    if (typeof retry !== "boolean") {
        throw new TypeError("retry must be a boolean.");
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
        const deadline = setTimeout(() => {
            socket.destroy(routerError("Timed out waiting for the router reply.", "ROUTER_REPLY_TIMEOUT"));
        }, timeout);
        try {
            socket.write(bytes);
            const { done, value } = await replies.next();
            if (done) {
                throw routerError("Router disconnected before replying.", "ROUTER_DISCONNECTED");
            }
            return value;
        } catch (error) {
            socket.destroy();
            throw error;
        } finally {
            clearTimeout(deadline);
        }
    }

    async function send(bytes) {
        const reply = await exchange(bytes);
        if (reply === null) {
            throw routerError("Router could not complete the Zigbee request.", "ROUTER_REQUEST_FAILED");
        }
        return reply;
    }

    return {
        async request(packet) {
            const bytes = encodePacket(packet);
            // keep the same encoded request and its retry ahead of later requests.
            const result = pending.then(() => send(bytes)).catch(error => {
                if (!retry || closed || !retryableErrors.has(error.code)) {
                    throw error;
                }
                return send(bytes);
            });
            pending = result.catch(() => {});
            return result;
        },
        close() {
            closed = true;
            connection?.socket.destroy();
        },
    };
}
