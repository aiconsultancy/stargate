/**
 * Loopback checks for a URL hostname (`new URL(value).hostname`, which
 * writes IPv6 in brackets). Three policies are in use; each caller names
 * the one that it applies, and widening one is a policy decision.
 */

/**
 * `127.0.0.1` or `[::1]` only. For credentials in clear text: a name, also
 * `localhost`, can resolve to another host.
 */
export function isLoopbackAddress(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "[::1]";
}

/** A literal loopback address, or the name `localhost`. */
export function isLocalhost(hostname: string) {
  return hostname === "localhost" || isLoopbackAddress(hostname);
}

/** `localhost`, `[::1]`, or any dotted address that starts with `127.`. */
export function isLoopbackHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  );
}
