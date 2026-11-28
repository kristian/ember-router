const BASIC = 0x0000;
const IDENTIFY = 0x0003;
const THERMOSTAT = 0x0201;
const READ_ATTRIBUTES = 0x00;
const IDENTIFY_EXTENSION = 0x4000;

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

const noAttributes = new Map();
const clientAttributes = new Map([[0xfffd, Buffer.from([0x21, 1, 0])]]);
const identifyExtensionAttributes = new Map([[IDENTIFY_EXTENSION, Buffer.from([0x10, 0])]]);

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

export function createCoordinatorResponder(manufacturerCode) {
    let identifyUntil = 0;
    const identifySeconds = () => Math.max(0, Math.ceil((identifyUntil - performance.now()) / 1000));

    return (cluster, payload) => {
        const control = payload[0];
        const manufacturerSpecific = Boolean(control & 4);
        const serverToClient = Boolean(control & 8);
        const disableDefault = Boolean(control & 16);
        const frameType = control & 3;
        const offset = manufacturerSpecific ? 3 : 1;
        if (payload.length < offset + 2 || (control & 0xe0) || frameType > 1 ||
            (cluster !== BASIC && cluster !== IDENTIFY && !(serverToClient && cluster === THERMOSTAT)) ||
            (frameType === 1 && serverToClient)) {
            return;
        }

        const sequence = payload[offset];
        const command = payload[offset + 1];
        const body = payload.subarray(offset + 2);
        const identifyExtension = manufacturerSpecific && !serverToClient && cluster === IDENTIFY;
        if (manufacturerSpecific && payload.readUInt16LE(1) !== manufacturerCode) {
            // A coordinator can read this Identify extension using its own manufacturer code.
            if (!identifyExtension || frameType !== 0 || command !== READ_ATTRIBUTES ||
                body.length !== 2 || body.readUInt16LE(0) !== IDENTIFY_EXTENSION) {
                return;
            }
        }

        let attributes = noAttributes;
        if (identifyExtension) {
            attributes = identifyExtensionAttributes;
        } else if (!manufacturerSpecific) {
            if (!serverToClient && cluster === BASIC) {
                attributes = basicAttributes;
            } else if (!serverToClient && cluster === IDENTIFY) {
                attributes = new Map([
                    [0, Buffer.concat([Buffer.from([0x21]), word(identifySeconds())])],
                    [0xfffd, Buffer.from([0x21, 1, 0])],
                ]);
            } else if (serverToClient && (cluster === BASIC || cluster === THERMOSTAT)) {
                attributes = clientAttributes;
            }
        }

        function response(id, data, kind = 0, reportingConfigured = false) {
            const control = 0x10 | (serverToClient ? 0 : 8) | (manufacturerSpecific ? 4 : 0) | kind;
            const manufacturer = manufacturerSpecific ? payload.subarray(1, 3) : Buffer.alloc(0);
            return {
                payload: Buffer.concat([Buffer.from([control]), manufacturer, Buffer.from([sequence, id]), data]),
                reportingConfigured,
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

        if (frameType === 0 && command === READ_ATTRIBUTES) {
            const records = readAttributeRecords(attributes, body);
            if (records) {
                return response(1, records);
            }
        }

        if (frameType === 0 && command === 6 && !manufacturerSpecific && !serverToClient && cluster === BASIC &&
            body.length === 8 && body[0] === 0 && body.readUInt16LE(1) === 7 && body[3] === 0x30) {
            const minimumInterval = body.readUInt16LE(4);
            const maximumInterval = body.readUInt16LE(6);
            const changeOnly = maximumInterval === 0 && minimumInterval !== 0xffff;
            const disabled = maximumInterval === 0xffff;
            // Preserve the observed long interval for coordinator compatibility.
            const compatibilityInterval = maximumInterval === 0xfffe && minimumInterval <= maximumInterval;
            if (changeOnly || disabled || compatibilityInterval) {
                return response(7, Buffer.from([0]), 0, true);
            }
            return response(7, Buffer.from([0x87, ...body.subarray(0, 3)]));
        }

        if (frameType === 1 && !manufacturerSpecific && !serverToClient && cluster === IDENTIFY) {
            if (command === 0 && body.length === 2) {
                identifyUntil = performance.now() + body.readUInt16LE(0) * 1000;
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
        const unsupported = frameType === 0
            ? (manufacturerSpecific ? 0x84 : 0x82)
            : (manufacturerSpecific ? 0x83 : 0x81);
        return response(0x0b, Buffer.from([command, unsupported]));
    };
}
