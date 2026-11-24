# Subspace API agent identity

This integration is optional. It is off unless the top-level
`subspaceAgents` object is present and `subspaceAgents.enabled` is `true`, and
no configuration has it by default. A section without `enabled: true` counts
as no section at all: its other keys are not validated, and adding, changing
or removing it needs no restart. Absent or disabled, Stargate does not load
its code: it creates no key, file or socket, makes no request, runs no start-up
check and writes no log line about it, and `stargate config check` behaves as
it does without it.

When it is on, the gateway holds one certificate per officer (a fleet's rear
admiral and captains), registers it with the Subspace API, and signs each
officer's requests to that API. The officer's harness reaches the API through
Stargate and holds no credential of its own.

- **Keys.** For each configured officer Stargate keeps an Ed25519 (or ECDSA
  P-256) key and a self-signed X.509 certificate in one owner-only PEM file,
  and enrols the certificate with the API using a one-time enrolment token
  that an administrator issues for the fleet.
- **Signing proxy.** Each officer can have a Unix socket. A request on it for
  an `/api/v1/` path or the MCP endpoint `/mcp` is forwarded to the
  configured API with a fresh, short-lived token signed with that officer's
  key. The operating system decides who can reach the socket; nothing in the
  request does.
- **Bridge.** Harness MCP clients start a stdio command, so
  `stargate subspace mcp --socket PATH` relays MCP over the socket to the API's
  `/mcp`. `stargate subspace request` makes a plain REST call the same
  way, for agent skills.
- **Fleet API.** Beside each officer's socket, `fleet-api.sock` serves the
  gateway's own [Fleet API](api.md#officers) read-only, for the whole fleet,
  with no token. `stargate fleet request` reads it. See
  [read the fleet](#read-the-fleet).

## Configuration

```json
{
  "subspaceAgents": {
    "enabled": true,
    "api": {
      "baseUrl": "https://subspace.internal.example",
      "headersEnv": {
        "CF-Access-Client-Id": "STARGATE_SUBSPACE_ACCESS_ID",
        "CF-Access-Client-Secret": "STARGATE_SUBSPACE_ACCESS_SECRET"
      }
    },
    "enrolment": { "tokenFile": "/etc/stargate/subspace-enrolment-token" },
    "officers": [
      {
        "name": "example-admiral",
        "rank": "rearAdmiral",
        "model": "example-model",
        "ircNick": "example-admiral",
        "socketPath": "/run/stargate/subspace/example-admiral/api.sock"
      },
      {
        "name": "example-captain",
        "rank": "captain",
        "ship": "example-ship",
        "model": "example-model",
        "ircNick": "example-captain",
        "socketPath": "/run/stargate/subspace/example-captain/api.sock"
      }
    ]
  }
}
```

| Key                       | Default                           | Meaning                                                                                                                                                                                          |
| ------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                 | `false`                           | The feature flag. Off (`false` or left out): the section is treated as absent, and nothing below is validated or used.                                                                           |
| `api.baseUrl`             | Required                          | The API's origin, with no path: its routes are `/api/v1/` and `/mcp`. HTTPS, or HTTP on loopback.                                                                                                |
| `api.audience`            | The origin of `api.baseUrl`       | The API's public origin (its `AGENT_TOKEN_AUDIENCE`), the `aud` of every token. Set it only when Stargate reaches the API by another address, such as a tunnel to `http://127.0.0.1:3000`.       |
| `api.headersEnv`          | `{}`                              | Private-access headers: header name → environment variable name. `Authorization`, `Cookie`, `Origin`, `X-Subspace-Agent` and the headers agent dispatch reserves are refused.                    |
| `api.timeoutSeconds`      | `60`                              | Bound on each upstream request, 1–300.                                                                                                                                                           |
| `enrolment.tokenFile`     | None                              | Absolute path of a file holding the fleet's enrolment token (`senr1.…`). Set this or `tokenEnv`; neither is needed once every officer is enrolled.                                               |
| `enrolment.tokenEnv`      | None                              | Environment variable holding the token instead.                                                                                                                                                  |
| `keyAlgorithm`            | `"ed25519"`                       | Key type for new bundles: `ed25519` or `ecdsa-p256`. An existing bundle keeps its own type.                                                                                                      |
| `stateDirectory`          | `<dataDirectory>/subspace-agents` | Private directory (mode `0700`) for bundles and enrolment records. Created when absent.                                                                                                          |
| `officers[].name`         | Required                          | The agent's name in the API: letters, digits and `-`, at most 64. Also the bundle's file name. Unique, ignoring case.                                                                            |
| `officers[].rank`         | Required                          | `rearAdmiral` or `captain`. A captain needs `ship`; a rear admiral has none.                                                                                                                     |
| `officers[].ship`         | None                              | The captain's ship, one line of at most 64 characters.                                                                                                                                           |
| `officers[].model`        | Required                          | The officer's model, one line of at most 100 characters.                                                                                                                                         |
| `officers[].ircNick`      | None                              | The officer's IRC nick: a letter, then letters, digits, `_` or `-`.                                                                                                                              |
| `officers[].bundlePath`   | `<stateDirectory>/<name>.pem`     | An explicit bundle file, for example to use the same certificate as the officer's IRC `clientPemFile` later. Its directory must belong to the gateway user and be writable by it alone.          |
| `officers[].socketPath`   | None                              | The officer's signing proxy socket. Absent opens no endpoint for that officer. Each officer needs its own directory.                                                                             |
| `officers[].registration` | None                              | A Slack, IRC or Teams registration ID. When that registration's backend is `claude`, Stargate gives it the bridge (see [harnesses](#point-a-harness-at-the-bridge)); it then needs `socketPath`. |

Every change to an enabled section needs a restart; a reload that switches the
section on or changes it while on is refused as restart-only. With the section
enabled, `stargate config check` also checks
that the `api.headersEnv` variables are set. The enrolment token is not
checked there, because an enrolled fleet no longer needs it.

## Enrolment

```sh
stargate subspace enrol --config /etc/stargate/stargate.json
stargate subspace enrol --config /etc/stargate/stargate.json --name example-captain --rotate
```

For each configured officer (or only `--name`), Stargate:

1. checks that the state directory is a real directory owned by the gateway
   user with no group or other access, creating it with mode `0700` when it is
   absent, and that no directory above it is a link or writable by another
   user;
2. reads the officer's bundle, which must be a regular file (never followed
   through a link), owned by the gateway user, with no group or other access;
   or, when there is none, generates a key with the runtime's own cryptography
   and writes the private key (PKCS #8) and the certificate to a new file with
   mode `0600`;
3. refuses two officers with the same certificate, even as copies in
   separate files: the API allows a certificate for one agent only;
4. leaves the officer alone when `<bundle>.enrolment.json` records this
   certificate's fingerprint for this API audience;
5. otherwise posts the certificate, in canonical PEM, to
   `POST /api/v1/agents/enrol` with the enrolment token, the officer's
   configured name, rank, ship, model and nick and always the scopes
   `["api", "irc"]`, and records the returned agent and credential IDs beside
   the bundle in `<bundle>.enrolment.json` (mode `0600`). The API answers 201,
   or 200 for a repeat of the same certificate and scopes, which it accepts
   even once the token's uses are spent.

Keep an officer's `rank` stable: the API refuses (409) an agent of the same
name with another rank, as it does a name in another fleet, a taken IRC nick
or a certificate registered elsewhere. A refusal shows a fixed reason
followed by the API's own one-line detail.

The same steps run at gateway start-up, after the sockets open and in the
background, so an unreachable API never delays or stops the gateway; a failed
enrolment is logged once per officer with its reason. A bundle, state
directory or bundle directory that others can read or write stops start-up
and the command, with a log line or error naming the officer.

`--rotate` generates a new key, enrols it and only then replaces the bundle;
a failed rotation leaves the old bundle in place. The output names the old
fingerprint as `previousFingerprint`, so an administrator can revoke it in the
API. A running gateway notices the replaced bundle at the next request and
signs with the new key. Rotate also after an administrator revokes an
officer's credential: the local record cannot know about the revocation.

The command prints JSON with each officer's state (`unchanged`, `enrolled`,
`rotated` or `failed`), fingerprint, agent and credential IDs and, on failure,
the reason. It never prints key material or the token, and exits with
status 1 when any officer failed. The token file must be a regular file
owned by the gateway user with no group or other access, of at most 4 KiB.

## The signing proxy

Each officer with a `socketPath` gets one HTTP listener on that Unix socket.
For each request it:

- accepts only `GET`, `HEAD`, `POST`, `PUT`, `PATCH` and `DELETE`;
- accepts only an origin-form target under `/api/v1/`, or exactly `/mcp`,
  as normalised: no `..` segment, encoded slash, encoded dot, backslash or
  fragment; the query passes as sent. Anything else gets 404 and never leaves
  the gateway;
- forwards to the configured API origin only, never to a host the request
  names;
- passes only `Accept`, `Content-Type`, `If-Match`, `If-None-Match`,
  `Last-Event-ID`, `MCP-Protocol-Version`, `Mcp-Session-Id` and
  `X-Correlation-Id` from the caller. Every other header, including
  `Authorization`, `Cookie`, `Origin`, `X-Subspace-Agent` and forwarding
  headers, is dropped;
- adds the configured access headers and `Authorization: Bearer <token>`,
  minting a new token for every request;
- passes the body unchanged (at most 8 MiB), so a crew member's `relayedCrew`
  reaches the API as written. Crew sessions run under their captain and act
  as the captain;
- returns the API's status and body as they stream (at most 64 MiB), with only
  `Allow`, `Cache-Control`, `Content-Disposition`, `Content-Type`, `ETag`,
  `Last-Modified`, `MCP-Protocol-Version`, `Mcp-Session-Id`, `Retry-After` and
  `X-Correlation-Id`. A redirect is returned, never followed, and its
  `Location` is withheld; cookies are never returned.

The token is a JWT: header `alg` `EdDSA` (or `ES256`), `typ`
`subspace-agent+jwt`, `kid` the certificate's fingerprint; claims `iss`
`subspace-agent`, `sub` the fingerprint, `aud` the API's public origin, `iat`,
`exp` 120 seconds later and a random `jti`. The fingerprint is the SHA-256 of
the certificate's DER encoding in lower-case hexadecimal. The caller never
sees the key or a token.

The proxy's own refusals are JSON, `{"error": "…", "source": "stargate"}`:
503 when the officer's key is unusable (for example a bundle someone made
readable) or an access header variable is missing, or when 32 requests are
already open; 502 when the API cannot be reached; 504 after
`api.timeoutSeconds`. An API refusal (for example 401 for an unknown or
revoked key) passes through unchanged, and the gateway logs one warning with
the status per minute. Nothing in a request, a token or a key is logged, and
no failure stops the gateway.

## How the caller is identified

The caller is whoever can connect to the officer's socket, which the
operating system decides; Stargate never reads an identity from the request.
The socket sits in a directory per officer:

- owned by the gateway user and writable by it alone, with safe parent
  directories (the same rules as [fleet control](fleet-tools.md));
- giving others no access at all: Stargate refuses to start otherwise;
- owned by the officer's engine group, with mode `2750`, so that only the
  gateway user and members of that group can enter it. The setgid bit gives
  the socket (mode `0660`) the directory's group; Stargate refuses to start
  when the socket did not get it;
- not sharing its group with another officer's socket directory: Stargate
  refuses to start when two group-accessible socket directories have the same
  group.

A directory with mode `0700` admits only the gateway user, which is what a
gateway-launched (Claude) officer needs.

The officer's read-only [Fleet API socket](api.md#officers), `fleet-api.sock`,
lives in the same directory under the same rules, so the same processes
reach it. Do not name `socketPath` `fleet-api.sock`, and configure no other
socket at that path: start-up stops with a log line naming both. Fleet
Control's `fleet.sock` may share the directory.

A missing socket directory stops start-up by design. The examples use
`/run/stargate/subspace/…`, and `/run` is emptied at boot, so recreate each
directory at boot, before the gateway starts. For example, a tmpfiles.d entry
`d /run/stargate/subspace/example-captain 2750 stargate example-captain-engine -`
makes it with the right owner, group and mode.

This guarantees that a process can obtain a request signed as an officer only
if it runs as the gateway user, as root, or with that officer's engine group.
Keep each officer's engine user out of every other officer's group and out of
the gateway's group; the gateway cannot see group membership, so this is the
installer's part. Linux peer credentials (`SO_PEERCRED`) would identify the
connecting process too, but the runtime does not expose them for Unix
sockets, so Stargate relies on the directory permissions instead.

**Trust model.** The gateway user holds every officer's key, as it already
holds every officer's IRC login and the rear admiral's API token. Anyone who
can act as the gateway user can act as any officer. A Claude Agent SDK
backend inside the gateway that holds the keys runs as the gateway user, so
its tools (for example `Bash`) can reach every officer's key and socket: give
such an officer only the tools you would trust with the gateway itself, or run
it in a gateway process of its own under the officer's user (see below).

## Point a harness at the bridge

The bridge reads newline-delimited JSON-RPC on standard input, posts each
message unchanged to the API's `/mcp` through the socket, and writes each answer
as one line on standard output; for a streamed (`text/event-stream`) answer,
one line per event. After `initialize` it sends the negotiated
`MCP-Protocol-Version` with each request and keeps any `Mcp-Session-Id`. A
refusal becomes a JSON-RPC error for that request ID; for a notification it
goes to standard error.

**OpenCode officers.** Run the engine as the officer's own user, in the
socket directory's group, and give it a local MCP server in its OpenCode V2
configuration, in place of a remote server with an `X-Subspace-Agent` header:

```json
{
  "mcp": {
    "servers": {
      "subspace": {
        "type": "local",
        "command": [
          "/usr/local/bin/bun",
          "/srv/stargate/src/main.ts",
          "subspace",
          "mcp",
          "--socket",
          "/run/stargate/subspace/example-captain/api.sock"
        ]
      }
    }
  }
}
```

**Claude Agent SDK officers.** When the officer's Claude backend runs in the
gateway that holds the keys, set the officer's `registration` to that
registration. Stargate adds an MCP server named `subspace` that runs the
bridge (Stargate's own Bun and `src/main.ts`) with that officer's socket, and
so permits its tools (`mcp__subspace`). Do not configure a `subspace` server
of your own there; the configuration is refused. When the Claude backend runs
in a separate gateway process under the officer's own user, that gateway does
not enable `subspaceAgents`; give its backend an ordinary stdio server
instead, `{"type": "stdio", "command": "/usr/local/bin/bun", "args":
["/srv/stargate/src/main.ts", "subspace", "mcp", "--socket", "<socket>"]}`,
with the socket directory in that user's group.

**Other backends.** OpenCode engines are configured by their operator, as
above. Codex and Pi Durable backends have no MCP server configuration in
Stargate, so they get nothing.

**REST.** Agent skills call the API through the same socket:

```sh
stargate subspace request --socket /run/stargate/subspace/example-captain/api.sock /api/v1/me
stargate subspace request --socket /run/stargate/subspace/example-captain/api.sock \
  --method POST --input issue.json /api/v1/issues
```

The answer's body goes to standard output; the exit status is 0 for a 2xx
answer, 1 otherwise, with the status and the API's title on standard error.

## Read the fleet

An officer, and its crew running as its user, can read what the fleet's
people see in Fleet Console: the fleet overview, each ship and each crew
member, for every ship of the gateway, read-only. The gateway serves its
[Fleet API](api.md#officers) on `fleet-api.sock` in each officer's socket
directory, with no token: who can reach the directory is who can read. There
is nothing to switch on; it comes with the officer's `socketPath`, and it
works whether or not the gateway's `api` listener is configured.

```sh
stargate fleet request --socket /run/stargate/subspace/example-captain/fleet-api.sock /api/v1/fleet
stargate fleet request --socket /run/stargate/subspace/example-captain/fleet-api.sock /api/v1/ships/example-ship
stargate fleet request --socket /run/stargate/subspace/example-captain/fleet-api.sock \
  /api/v1/ships/example-ship/crew/example-member
```

Set `STARGATE_FLEET_API_SOCKET` to the socket in the officer's environment to
leave out `--socket`. The command needs no configuration and no credential.
It exits 0 with the JSON on standard output, 1 with the status on standard
error (404 for an unknown ship or member) and 2 for any path but the four
Fleet API routes. Nothing on the socket changes anything: writes get 405, and
other paths 404. `/api/v1/events` streams events until the gateway closes it
or the command is stopped, so give it a time limit in a harness.

For an OpenCode officer whose shell runs commands through a permission
policy, allow the command with its socket, for example the bash pattern
`<bun> <stargate>/src/main.ts fleet request --socket /run/stargate/subspace/example-captain/fleet-api.sock *`.
There is no MCP tool for it: the command works in every harness with a
shell, including crew.

## Not verified yet

The tests use local stand-ins for the API, the harness and the sockets. This
integration has not run against a real Subspace API with agent key
credentials, a real OpenCode engine or Claude Code session, or a fleet VM
with per-officer users and groups; nor have the officers' Fleet API sockets.

## Tests

`tests/subspace-keys.test.ts` covers the configuration and its off switch,
certificates and their fingerprints, the token checked with the
certificate's public key, enrolment against a stub API (the request, the
record, a re-run that changes nothing, each refusal, rotation, one
certificate per officer) and the file permission refusals.
`tests/subspace-proxy.test.ts` covers the proxy's signing per officer, path
and header filtering, redirects, upstream failures, socket directory checks,
the stdio bridge with JSON and streamed answers, the REST command and the
`stargate subspace mcp` command in a child process.
`tests/subspace-runtime.test.ts` runs the gateway with the section absent,
disabled and enabled (with the officer's Fleet API socket and no `api`
listener), and with a bundle others can read.
`tests/api-v1-officers.test.ts` covers the officers' Fleet API sockets and
`stargate fleet request`. No test contacts a real service.
