# Ember Router

A command-line utility for using an EmberZNet adapter as a router on an existing Zigbee network. Ember Router connects over serial or TCP to an adapter running EmberZNet coordinator (NCP) firmware, following the approach described in the [ember-zli Router wiki](https://github.com/Nerivec/ember-zli/wiki/Router). It can join an open network or resume the network saved on the adapter.

The utility writes packets delivered to the router as JSON Lines on standard output and accepts outgoing Zigbee packets in the same format on standard input. It can send a finite batch or stay connected to receive packets and accept writes in the same session. The adapter can remain a router while powered after the CLI exits. Keep a session running to stream packets to the host.

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
```

`run` is the default command (and can be omitted). It resumes the saved network, streams received packets to stdout, and accepts outgoing packets on stdin. With empty or closed stdin, it continues receiving.

`read` sends one JSON packet from stdin and prints the matching ZCL reply.

`write` resumes the saved network and sends a single packet or a batch from stdin. It exits after stdin closes and all submitted packets have been processed.

### Options

- `-p, --path <path>` for the serial port or TCP address (required).
- `-b, --baud-rate <rate>` for the serial baud rate (default `115200`).
- `-r, --rtscts` to enable hardware flow control.
- `-m, --manufacturer-code <code>` for the ZCL enum name, decimal value, or `0x` value (default `SILICON_LABORATORIES`). Pass the override again on resume when needed.
- `--timeout <ms>` for scan and network callbacks (default `45000`).
- `--read-timeout <ms>` for `read` and `run --socket` to set the ZCL reply timeout (default `5000`, range `100`–`300000`).
- `--write-timeout <ms>` for `run`, `write`, and `read` to set the APS delivery timeout (default `15000`).
- `--expect <commandId>` for `read` and `run --socket` to select the ZCL reply command by decimal or `0x` value.
- `--socket <path>` for `run` to accept requests over a local Unix domain socket or a Windows named pipe.
- `-g, --graceful` for `run` and `write` to attempt one reconnect after adapter loss. Repeat as `-gg` to keep retrying.
- `-v, --verbose` for more diagnostics on stderr. Repeat for debug output during `run`.

#### Graceful reconnect

After a session starts, `-g` waits 5 seconds and makes one recovery attempt per adapter loss. `-gg` continues with exponential backoff capped at 120 seconds. Recovery resumes the network saved on the adapter. Initial startup failures still exit with an error.

Stdin, stdout, stderr, and local socket clients stay open during recovery. Interrupted requests and requests submitted while offline fail. Socket requests return `null` and writes report errors on stderr. Once the adapter reconnects, the router can handle new requests. `write` still exits after EOF and reports any failed packets in its exit status.

#### Joining networks

`join` also accepts the shared adapter and logging options above. Open permit joining on the target network before running the command. Exactly one open network must match, and the adapter must have no saved network.

- `-c, --channel <channel>` to scan a single channel from 11 to 26 (default scans all channels).
- `--pan-id <pan>` to filter by decimal or `0x`-prefixed PAN ID.
- `--extended-pan-id <hex>` to filter by 16 hex digits in EZSP byte order.
- `-l, --link-key <hex>` to use a derived 16-byte link key as 32 hex digits (default uses the global Zigbee link key). You can also set `EMBER_ROUTER_LINK_KEY`.
- `-P, --radio-power <dbm>` to set transmit power in dBm (default `5`).
- `--scan-duration <exponent>` to set the EZSP active scan duration exponent from 0 to 14 (default `4`).
- `--answer-interview` to answer coordinator interview requests and wait for delivery of the Basic Power Source Configure Reporting response.
- `--skip-post-join-security` to skip closing local permit-join and requesting and verifying the trust-center link-key update.


#### Reset an adapter

`ember-router reset -p <path> --yes` leaves the saved Zigbee network, then resets the adapter's NVM3 tokens. If there is no saved network, it resets the tokens directly. This erases persisted adapter state. Back up tokens with ember-zli first if you need to restore that state.

After a successful reset, stdout contains the adapter's EUI64, also called EUID. Diagnostics go to stderr.

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
ember-router -p tcp://192.168.1.42:6638

# Send packets from stdin and keep receiving after stdin closes
cat packets.jsonl | ember-router run -p tcp://192.168.1.42:6638

# Send a finite batch and exit
cat packets.jsonl | ember-router write -p tcp://192.168.1.42:6638

# Leave network, reset the adapter and print the EUI64
ember-router reset -p tcp://192.168.1.42:6638 --yes
```

## Packet format

With `run` and `write`, stdout contains one JSON object per received packet. Diagnostics go to stderr. The router sees packets delivered to its host by EZSP. Retain the sniffer for passive observation of exchanges between other devices.

```json
{"type":"aps","source":4660,"sourceEndpoint":1,"destinationEndpoint":1,"profileId":260,"clusterId":513,"lqi":180,"payload":"1842011200299e07"}
```

`zdo` packets use the same frame fields. `touchlink` packets carry `panId`, `source`, `groupId`, `lqi`, and `payload`.

Send one JSON object per line on stdin. The following example sends an already encoded ZCL Read Attributes frame. Use `read` to wait for a matching reply.

```json
{"destination":4660,"destinationEndpoint":1,"clusterId":513,"payload":"1001001200"}
```

For attribute writes, supply the encoded ZCL Write Attributes frame in `payload`. The CLI sends raw APS unicasts and leaves encoding and device identity resolution to the caller. Addresses and IDs are numeric. Endpoints default to `1` and `profileId` to `260`. The CLI waits for each delivery result before proceeding.

## Read format

Read the occupied heating setpoint (`0x0012`) from a thermostat at short address `4660`.

```sh
ember-router read -p tcp://192.168.1.42:6638 <<'EOF'
{"destination":4660,"clusterId":513,"payload":"1001001200"}
EOF
```

The router automatically expects Read Attributes Response (`0x01`) or Write Attributes Response (`0x04`) for the corresponding request. Use `--expect` to override that choice or match a reply to another ZCL command.

`read` prints the received packet, including matching ZCL Default Responses with an error status. A send failure or timeout reports an error on stderr and exits with status `1`.

```json
{"type":"aps","source":4660,"sourceEndpoint":1,"destinationEndpoint":1,"profileId":260,"clusterId":513,"lqi":180,"payload":"180101120000299e07"}
```

### Local socket

```sh
ember-router run -p tcp://192.168.1.42:6638 --socket /path/to/private/ember-router.sock
```

Send one packet per JSON line and receive one reply per line in the same order. A failed request returns `null` and logs the error on stderr. Keep the connection open until replies arrive. The socket supports 16 clients and 8192 bytes per line, with one request active on the adapter at a time.

Use a private directory for the Unix socket. If a crash leaves a stale socket, confirm it is unused before removing it. On Windows, use a named pipe such as `\\.\pipe\ember-router`.
