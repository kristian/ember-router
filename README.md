# Ember Router

A command-line utility for using an EmberZNet adapter as a router on an existing Zigbee network. Ember Router connects over serial or TCP to an adapter running EmberZNet coordinator (NCP) firmware, following the approach described in the [ember-zli Router wiki](https://github.com/Nerivec/ember-zli/wiki/Router). It can join an open network or resume the network saved on the adapter.

The utility exchanges binary packets over stdin, stdout, or a local socket. It can send a finite batch or stay connected to receive packets and accept writes in the same session. The adapter can remain a router while powered after the CLI exits. Keep a session running to stream packets to the host.

## Installation

```sh
npm install -g ember-router
```

## Usage

```sh
ember-router join -p <path> [options]
ember-router run -p <path> [options]
ember-router read -p <path> [options]
ember-router write -p <path> [options]
ember-router reset -p <path> --yes [options]
ember-router encode
ember-router decode
```

`run` is the default command (and can be omitted). It resumes the saved network, streams received packets to stdout, and reads packets to send from stdin. With empty or closed stdin, it continues receiving.

`read` sends one packet from stdin and writes the matching ZCL reply to stdout.

`write` resumes the saved network and sends a single packet or a batch from stdin. It exits after stdin closes and all submitted packets have been processed. Use `--listen-after-write` to keep it open for follow-up requests.

When upgrading from 2.4.0, replace `--respond-basic-reads` in existing commands and scripts with `--answer-coordinator-requests`.

### Options

- `-p, --path <path>` for the serial port or TCP address (required for adapter commands).
- `-b, --baud-rate <rate>` for the serial baud rate (default `115200`).
- `-r, --rtscts` to enable hardware flow control.
- `-m, --manufacturer-code <code>` for the ZCL enum name, decimal value, or `0x` value (default `SILICON_LABORATORIES`). Pass the override again on resume when needed.
- `--timeout <ms>` for scan and network callbacks (default `45000`).
- `--read-timeout <ms>` for `read` and `run --socket` to set the ZCL reply timeout (default `5000`, range `100`–`300000`).
- `--write-timeout <ms>` for `run`, `write`, and `read` to set the APS delivery timeout (default `15000`).
- `--answer-coordinator-requests` for `run`, `write`, and `read` to answer coordinator requests on endpoint 1 while the session is open. Supported requests include Basic attribute reads, Power Source Configure Reporting, Identify, and Thermostat client Cluster Revision reads. Power Source configuration accepts change-only reporting, disabled reporting, and the `0xfffe` interval for coordinator compatibility. Applications can send their own periodic reports. Reads of manufacturer-specific Identify attribute `0x4000` return an inactive value with the request’s manufacturer code. Other manufacturer-specific requests must match `-m`.
- `--listen-after-write <ms>` for `write` keeps the session open after stdin closes and writes finish (default `0`, range `0`–`300000`). It can also be set with `EMBER_ROUTER_LISTEN_AFTER_WRITE_MS`.
- `--expect <commandId>` for `read` and `run --socket` to select the ZCL reply command by decimal or `0x` value.
- `--socket <path>` for `run` to accept requests over a local Unix domain socket or a Windows named pipe.
- `-g, --graceful` for `run` and `write` to attempt one reconnect after adapter loss. Repeat as `-gg` to keep retrying.
- `-v, --verbose` for more diagnostics on stderr. Repeat for debug output during `run`.

#### Graceful reconnect

After a session starts, `-g` waits 5 seconds and makes one recovery attempt per adapter loss. `-gg` continues with exponential backoff capped at 120 seconds. Recovery resumes the network saved on the adapter. Initial startup failures still exit with an error.

Stdin, stdout, stderr, and local socket clients stay open during recovery. Interrupted requests and requests submitted while offline fail. Socket responses use the `00 00` failure marker and writes report errors on stderr. Once the adapter reconnects, the router can handle new requests. `write` still exits after EOF and reports any failed packets in its exit status.

#### Joining networks

`join` also accepts the shared adapter and logging options above. Open permit joining on the target network before running the command. Exactly one open network must match, and the adapter must have no saved network.

- `-c, --channel <channel>` to scan a single channel from 11 to 26 (default scans all channels).
- `--pan-id <pan>` to filter by decimal or `0x`-prefixed PAN ID.
- `--extended-pan-id <hex>` to filter by 16 hex digits in EZSP byte order.
- `-l, --link-key <hex>` to use a derived 16-byte link key as 32 hex digits (default uses the global Zigbee link key). You can also set `EMBER_ROUTER_LINK_KEY`.
- `-P, --radio-power <dbm>` to set transmit power in dBm (default `5`).
- `--scan-duration <exponent>` to set the EZSP active scan duration exponent from 0 to 14 (default `4`).
- `--answer-interview` to answer coordinator requests while joining and wait for delivery of the Basic Power Source Configure Reporting response. It handles the same requests as `--answer-coordinator-requests`.
- `--skip-post-join-security` to skip closing local permit-join and requesting and verifying the trust-center link-key update.


#### Reset an adapter

`ember-router reset -p <path> --yes` leaves the saved Zigbee network, then resets the adapter's NVM3 tokens. If there is no saved network, it resets the tokens directly. This erases persisted adapter state. Back up tokens with ember-zli first if you need to restore that state.

After a successful reset, the adapter's EUI64, also called EUID, is reported on stderr.

- `--yes` confirms the reset (required).
- `--preserve-frame-counters` keeps the outgoing network and APS frame counter tokens.
- `--preserve-boot-counter` keeps the stack boot counter token.

### Examples

```sh
# Join a specific open network on channel 19
ember-router join -p tcp://192.168.1.42:6638 -c 19 --pan-id 0x8cde

# Join a network with a link key on channel 19
ember-router join -p tcp://192.168.1.42:6638 -c 19 -l 00112233445566778899aabbccddeeff

# Resume the saved network and receive packets
ember-router -p tcp://192.168.1.42:6638 > capture.bin

# Send packets from stdin and keep receiving after stdin closes
ember-router run -p tcp://192.168.1.42:6638 < requests.bin > capture.bin

# Send a finite batch and exit
ember-router write -p tcp://192.168.1.42:6638 < requests.bin > capture.bin

# Leave network, reset the adapter and print the EUI64
ember-router reset -p tcp://192.168.1.42:6638 --yes
```

## Binary packet format

Starting with version 2.0, `read`, `write`, `run`, and `run --socket` use the same length-prefixed binary packets. The addressing fields follow [Silicon Labs’ EZSP APS metadata](https://docs.silabs.com/zigbee/7.4/zigbee-stack-api/ember-aps-frame). The length prefix and packet kind are specific to Ember Router. Payloads are raw Zigbee bytes. Diagnostics go to stderr.

Each binary packet starts with a two-byte unsigned little-endian body length. It excludes the length field itself. The first byte of the body is the packet kind. All multi-byte values below are little-endian.

| Kind | Body fields after the kind byte, in order |
| --- | --- |
| `0x00` APS or ZDO | Short address (2), profile ID (2), cluster ID (2), source endpoint (1), destination endpoint (1), LQI (1), raw payload |
| `0x01` Touchlink | PAN ID (2), source EUI64 (8), group ID (2), LQI (1), raw payload |

Field sizes are in bytes. For APS sends, the short address is the destination and the LQI byte can be zero. The short address and LQI are the sender’s values on receive. Profile `0x0000` identifies a ZDO packet. Stdin and socket clients send APS application unicasts. ZDO and Touchlink records are receive-only.

### Encode and decode JSON Lines

`encode` converts JSON Lines requests to binary. It takes `destination`, `clusterId`, and a hex `payload`. Endpoints default to `1` and `profileId` to `260`.

`decode` converts received binary packets to JSON Lines. A socket failure decodes to `null`. Both commands work without an adapter.

```sh
ember-router decode < capture.bin
```

### Node.js socket client

Connect to a running `ember-router run --socket` instance from Node.js:

```js
import { createRouterClient } from 'ember-router/client';

const router = createRouterClient('/path/to/private/ember-router.sock', { timeout: 30_000, retry: true });
try {
    const reply = await router.request({ destination: 4660, clusterId: 513, payload: '1001001200' });
    console.log(reply);
} finally {
    router.close();
}
```

Requests share a connection and run one at a time. The timeout is in milliseconds and defaults to 30 seconds per attempt, starting when the attempt begins. After a lost connection, the next attempt reconnects. A Zigbee error response is returned as a packet, so inspect its ZCL status when needed.

`retry: true` resends the same encoded packet once after an empty router reply, a timeout, or a recoverable socket error. It preserves the original ZCL transaction sequence number. Both attempts run before the next queued request. Retries are off by default.

A retry can recover a request that was lost in transit. A missing reply can also occur after the device has applied the command. In that case, the device may ignore the retry as a duplicate or process it again. Enable retries only for commands that are safe to replay.

The package root exports the packet helpers. `encodePacket(packet)` produces request bytes, `decodePacket(bytes)` decodes one received packet, and `decodePackets(stream)` decodes a stream of packets.

### Read an attribute

Read the occupied heating setpoint (`0x0012`) from short address `0x1234`, endpoint `1`, profile `0x0104`, and cluster `0x0201`.

```sh
printf '%s\n' '{"destination":4660,"clusterId":513,"payload":"1001001200"}' |
  ember-router encode | ember-router read -p tcp://192.168.1.42:6638 | ember-router decode
```

The same request in binary can be sent and inspected with `xxd`.

```sh
printf '%s' 0f00003412040101020101001001001200 | xxd -r -p |
  ember-router read -p tcp://192.168.1.42:6638 | xxd -g 1
```

The request body is 15 bytes and ends with ZCL payload `10 01 00 12 00`. The router infers Read Attributes Response (`0x01`) or Write Attributes Response (`0x04`) for those requests. Use `--expect` to select a different ZCL reply command. `read` writes one matching packet, including a matching ZCL Default Response with an error status. A send failure or timeout reports an error on stderr and exits with status `1`.

For a shared capture and router adapter, `read --settle-delay 5000` waits five seconds after the network resumes before sending. The delay is in milliseconds and defaults to zero. The delivery and reply timeouts start when the request is sent.

### Local socket

```sh
ember-router run -p tcp://192.168.1.42:6638 --socket /path/to/private/ember-router.sock > capture.bin
```

Send packets and receive their replies in the same order on the same connection. A failed exchange returns `00 00` (a zero-length body) and logs the error on stderr. Keep the connection open until the replies arrive. The socket supports up to 16 clients and one active send on the adapter at a time.

Use a private directory for the Unix socket. If a crash leaves a stale socket, confirm it is unused before removing it. On Windows, use a named pipe such as `\\.\pipe\ember-router`.
