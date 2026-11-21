const LENGTH_BYTES = 2;
const APS_KIND = 0;
const TOUCHLINK_KIND = 1;
const APS_HEADER_BYTES = 10;
const TOUCHLINK_HEADER_BYTES = 14;

export function encodePacket(packet) {
    if (packet === null) {
        return Buffer.alloc(LENGTH_BYTES);
    }

    const touchlink = packet.type === 'touchlink';
    if (!touchlink && packet.type !== 'aps' && packet.type !== 'zdo') {
        throw new TypeError(`Unsupported packet type: ${packet.type}.`);
    }
    const headerBytes = touchlink ? TOUCHLINK_HEADER_BYTES : APS_HEADER_BYTES;
    const length = headerBytes + packet.payload.length;
    if (length > 0xffff) {
        throw new RangeError('Packet exceeds the maximum record length.');
    }

    const record = Buffer.allocUnsafe(LENGTH_BYTES + length);
    record.writeUInt16LE(length);
    const body = record.subarray(LENGTH_BYTES);
    if (touchlink) {
        body[0] = TOUCHLINK_KIND;
        body.writeUInt16LE(packet.panId, 1);
        body.writeBigUInt64LE(BigInt(packet.source), 3);
        body.writeUInt16LE(packet.groupId, 11);
        body[13] = packet.lqi;
    } else {
        body[0] = APS_KIND;
        body.writeUInt16LE(packet.source, 1);
        body.writeUInt16LE(packet.profileId, 3);
        body.writeUInt16LE(packet.clusterId, 5);
        body[7] = packet.sourceEndpoint;
        body[8] = packet.destinationEndpoint;
        body[9] = packet.lqi;
    }
    packet.payload.copy(body, headerBytes);
    return record;
}

export function decodeOutgoing(body) {
    if (body.length < APS_HEADER_BYTES || body[0] !== APS_KIND) {
        throw new Error('Expected an APS packet.');
    }
    return {
        destination: body.readUInt16LE(1),
        profileId: body.readUInt16LE(3),
        clusterId: body.readUInt16LE(5),
        sourceEndpoint: body[7],
        destinationEndpoint: body[8],
        payload: body.subarray(APS_HEADER_BYTES),
    };
}

export async function* readRecords(stream) {
    const length = Buffer.allocUnsafe(LENGTH_BYTES);
    let buffer = length;
    let written = 0;

    for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
        for (let offset = 0; offset < chunk.length;) {
            const copied = chunk.copy(buffer, written, offset, offset + buffer.length - written);
            offset += copied;
            written += copied;
            if (written < buffer.length) {
                continue;
            }
            if (buffer === length) {
                buffer = Buffer.allocUnsafe(length.readUInt16LE());
                written = 0;
                if (buffer.length) {
                    continue;
                }
            }

            const body = buffer;
            buffer = length;
            written = 0;
            yield body;
        }
    }
    if (buffer !== length || written !== 0) {
        throw new Error('Truncated packet record.');
    }
}
