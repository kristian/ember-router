const BASIC = 0x0000;
const IDENTIFY = 0x0003;
const THERMOSTAT = 0x0201;

function word(value) {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16LE(value);
    return bytes;
}

function string(value) {
    return Buffer.concat([Buffer.from([0x42, Buffer.byteLength(value)]), Buffer.from(value)]);
}

const basicAttributes = new Map([
    [0x0000, Buffer.from([0x20, 8])], // ZCLVersion: ZCL revision 8.
    [0x0001, Buffer.from([0x20, 1])], // ApplicationVersion: version 1.
    [0x0003, Buffer.from([0x20, 0])], // HWVersion: unspecified.
    [0x0004, string('Generic')], // ManufacturerName: generic manufacturer label.
    [0x0005, string('Zigbee Router')], // ModelIdentifier: generic router name.
    [0x0007, Buffer.from([0x30, 4])], // PowerSource: DC source.
    [0xfffd, Buffer.from([0x21, 2, 0])], // ClusterRevision: Basic cluster revision 2.
]);

function readAttributeRecords(attributes, body) {
    if (body.length === 0 || body.length % 2 !== 0 || body.length > 48) {
        return;
    }

    const records = [];
    for (let offset = 0; offset < body.length; offset += 2) {
        const id = body.readUInt16LE(offset);
        const value = attributes.get(id);
        records.push(Buffer.concat([word(id), Buffer.from([value ? 0 : 0x86]), value ?? Buffer.alloc(0)]));
    }
    return Buffer.concat(records);
}

export function basicReadResponse(payload) {
    // Standard global client-to-server Read Attributes, with either default response setting.
    if ((payload[0] !== 0 && payload[0] !== 0x10) || payload[2] !== 0) {
        return;
    }
    const records = readAttributeRecords(basicAttributes, payload.subarray(3));
    if (records) {
        return Buffer.concat([Buffer.from([0x18, payload[1], 1]), records]);
    }
}

export function createInterview() {
    let identifyUntil = 0;
    const identifySeconds = () => Math.max(0, Math.ceil((identifyUntil - Date.now()) / 1000));

    return (cluster, payload) => {
        const manufacturerSpecific = Boolean(payload[0] & 4);
        const serverToClient = Boolean(payload[0] & 8);
        const disableDefault = Boolean(payload[0] & 16);
        const frameType = payload[0] & 3;
        const offset = manufacturerSpecific ? 3 : 1;
        if (payload.length < offset + 2) {
            return;
        }

        const sequence = payload[offset];
        const command = payload[offset + 1];
        const body = payload.subarray(offset + 2);
        const attributes = new Map();
        if (manufacturerSpecific) {
            if (!serverToClient && cluster === IDENTIFY && payload.readUInt16LE(1) === 0x1221) {
                attributes.set(0x4000, Buffer.from([0x10, 0]));
            }
        } else if (!serverToClient && cluster === BASIC) {
            for (const [id, value] of basicAttributes) {
                attributes.set(id, value);
            }
        } else if (!serverToClient && cluster === IDENTIFY) {
            attributes.set(0, Buffer.concat([Buffer.from([0x21]), word(identifySeconds())]));
            attributes.set(0xfffd, Buffer.from([0x21, 1, 0]));
        } else if (serverToClient && (cluster === BASIC || cluster === THERMOSTAT)) {
            attributes.set(0xfffd, Buffer.from([0x21, 1, 0]));
        }

        function response(id, data, kind = 0, complete = false) {
            const control = 0x10 | (serverToClient ? 0 : 8) | (manufacturerSpecific ? 4 : 0) | kind;
            const manufacturer = manufacturerSpecific ? payload.subarray(1, 3) : Buffer.alloc(0);
            return {
                payload: Buffer.concat([Buffer.from([control]), manufacturer, Buffer.from([sequence, id]), data]),
                complete,
            };
        }

        if (frameType === 0 && command === 0x0c && body.length === 3) {
            if (body[2] === 0) {
                return response(0x0b, Buffer.from([command, 0x80]));
            }
            const start = body.readUInt16LE(0);
            const remaining = [...attributes].filter(([id]) => id >= start).sort(([a], [b]) => a - b);
            const page = remaining.slice(0, Math.min(body[2], 16));
            const records = page.map(([id, value]) => Buffer.concat([word(id), value.subarray(0, 1)]));
            return response(0x0d, Buffer.concat([Buffer.from([Number(page.length === remaining.length)]), ...records]));
        }

        if (frameType === 0 && command === 0) {
            const records = readAttributeRecords(attributes, body);
            if (records) {
                return response(1, records);
            }
        }

        if (frameType === 0 && command === 6 && !manufacturerSpecific && !serverToClient && cluster === BASIC &&
            body.length === 8 && body[0] === 0 && body.readUInt16LE(1) === 7 && body[3] === 0x30 && body.readUInt16LE(6) >= 0xfffe) {
            // Use successful Power Source reporting configuration as the interview completion checkpoint.
            return response(7, Buffer.from([0]), 0, true);
        }

        if (frameType === 1 && !manufacturerSpecific && !serverToClient && cluster === IDENTIFY) {
            if (command === 0 && body.length === 2) {
                identifyUntil = Date.now() + body.readUInt16LE(0) * 1000;
                return disableDefault ? undefined : response(0x0b, Buffer.from([command, 0]));
            }
            if (command === 1 && body.length === 0) {
                const seconds = identifySeconds();
                return seconds ? response(0, word(seconds), 1) : undefined;
            }
        }

        if (disableDefault || (frameType === 0 && [1, 4, 7, 9, 0x0a, 0x0b, 0x0d, 0x12, 0x14, 0x16].includes(command))) {
            return;
        }
        return response(0x0b, Buffer.from([command, frameType === 0 ? 0x82 : 0x81]));
    };
}
