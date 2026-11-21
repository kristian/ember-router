const LENGTH_BYTES = 2;
const APS_KIND = 0;
const TOUCHLINK_KIND = 1;
const APS_HEADER_BYTES = 10;
const TOUCHLINK_HEADER_BYTES = 14;

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
    const body = packetBody(bytes);
    if (!body.length) {
        return null;
    }
    if (body[0] === TOUCHLINK_KIND) {
        if (body.length < TOUCHLINK_HEADER_BYTES) {
            throw new Error('Truncated Touchlink packet.');
        }
        return {
            type: 'touchlink',
            panId: body.readUInt16LE(1),
            source: `0x${body.readBigUInt64LE(3).toString(16).padStart(16, '0')}`,
            groupId: body.readUInt16LE(11),
            lqi: body[13],
            payload: body.subarray(TOUCHLINK_HEADER_BYTES).toString('hex'),
        };
    }

    const { address, payload, ...fields } = decodeApsFields(body);
    return {
        type: fields.profileId === 0 ? 'zdo' : 'aps',
        source: address,
        ...fields,
        lqi: body[9],
        payload: payload.toString('hex'),
    };
}

export async function* decodePackets(stream) {
    for await (const bytes of readPacketBytes(stream)) {
        yield decodePacket(bytes);
    }
}

// Binary packet I/O for the router.
export function decodeSendPacket(bytes) {
    const { address, ...fields } = decodeApsFields(packetBody(bytes));
    return { destination: address, ...fields };
}

export function validateSendPacket({ destination, profileId, clusterId, sourceEndpoint, destinationEndpoint }) {
    const fields = [
        ['destination', destination, 0, 0xfff7],
        ['profileId', profileId, 1, 0xffff],
        ['clusterId', clusterId, 0, 0xffff],
        ['sourceEndpoint', sourceEndpoint, 1, 254],
        ['destinationEndpoint', destinationEndpoint, 1, 240],
    ];
    for (const [name, value, min, max] of fields) {
        if (!Number.isInteger(value) || value < min || value > max) {
            throw Object.assign(new Error(`Invalid ${name}.`), { code: 'INVALID_PACKET' });
        }
    }
}

export function encodePacketBytes(packet) {
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
        throw new RangeError('Packet body exceeds 65535 bytes.');
    }

    const bytes = Buffer.allocUnsafe(LENGTH_BYTES + length);
    bytes.writeUInt16LE(length);
    const body = bytes.subarray(LENGTH_BYTES);
    if (touchlink) {
        body[0] = TOUCHLINK_KIND;
        body.writeUInt16LE(packet.panId, 1);
        body.writeBigUInt64LE(packet.source, 3);
        body.writeUInt16LE(packet.groupId, 11);
        body[13] = packet.lqi;
    } else {
        body[0] = APS_KIND;
        body.writeUInt16LE(packet.destination ?? packet.source, 1);
        body.writeUInt16LE(packet.profileId, 3);
        body.writeUInt16LE(packet.clusterId, 5);
        body[7] = packet.sourceEndpoint;
        body[8] = packet.destinationEndpoint;
        body[9] = packet.lqi;
    }
    packet.payload.copy(body, headerBytes);
    return bytes;
}

export async function* readPacketBytes(stream) {
    const prefix = Buffer.allocUnsafe(LENGTH_BYTES);
    let bytes = prefix;
    let written = 0;

    for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
        for (let offset = 0; offset < chunk.length;) {
            const copied = chunk.copy(bytes, written, offset, offset + bytes.length - written);
            offset += copied;
            written += copied;
            if (written < bytes.length) {
                continue;
            }
            if (bytes === prefix) {
                bytes = Buffer.allocUnsafe(LENGTH_BYTES + prefix.readUInt16LE(0));
                prefix.copy(bytes);
                if (written < bytes.length) {
                    continue;
                }
            }

            const packet = bytes;
            bytes = prefix;
            written = 0;
            yield packet;
        }
    }
    if (bytes !== prefix || written !== 0) {
        throw new Error('Truncated binary packet.');
    }
}

function packetBody(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < LENGTH_BYTES ||
        bytes.readUInt16LE(0) !== bytes.length - LENGTH_BYTES) {
        throw new Error('Expected one complete binary packet.');
    }
    return bytes.subarray(LENGTH_BYTES);
}

function decodeApsFields(body) {
    if (body.length < APS_HEADER_BYTES || body[0] !== APS_KIND) {
        throw new Error('Expected an APS packet.');
    }
    return {
        address: body.readUInt16LE(1),
        profileId: body.readUInt16LE(3),
        clusterId: body.readUInt16LE(5),
        sourceEndpoint: body[7],
        destinationEndpoint: body[8],
        payload: body.subarray(APS_HEADER_BYTES),
    };
}
