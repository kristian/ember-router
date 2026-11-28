import { decodePacketBytes, encodePacketBytes, readPacketBytes, validateSendPacket } from './packet-io.js';

export function encodePacket(packet) {
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
        throw new Error('Expected a packet to send.');
    }
    const { destination, profileId = 260, clusterId, sourceEndpoint = 1, destinationEndpoint = 1, payload } = packet;
    validateSendPacket({ destination, profileId, clusterId, sourceEndpoint, destinationEndpoint });
    if (typeof payload !== 'string' || !payload.length || payload.length % 2 || /[^0-9a-f]/i.test(payload)) {
        throw new Error('payload must be nonempty, even-length hex.');
    }
    return encodePacketBytes({
        type: 'aps', destination, profileId, clusterId, sourceEndpoint, destinationEndpoint,
        lqi: 0, payload: Buffer.from(payload, 'hex'),
    });
}

export function decodePacket(bytes) {
    const packet = decodePacketBytes(bytes);
    if (packet === null) {
        return null;
    }

    const source = packet.type === 'touchlink'
        ? `0x${packet.source.toString(16).padStart(16, '0')}`
        : packet.source;
    return { ...packet, source, payload: packet.payload.toString('hex') };
}

export async function* decodePackets(stream) {
    for await (const bytes of readPacketBytes(stream)) {
        yield decodePacket(bytes);
    }
}
