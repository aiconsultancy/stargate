import { BlockList, isIP } from "node:net";

export const privateNetworks = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "::1/128",
  "fc00::/7",
] as const;

function family(address: string): "ipv4" | "ipv6" | undefined {
  if (address.includes("%")) return undefined;
  const version = isIP(address);

  switch (version) {
    case 4:
      return "ipv4";
    case 6:
      return "ipv6";
    default:
      return undefined;
  }
}

function parseNetwork(cidr: string) {
  const [address, suffix, extra] = cidr.split("/");

  if (!address || !suffix || extra !== undefined || !/^\d{1,3}$/.test(suffix))
    return;
  const type = family(address);
  const prefix = Number(suffix);

  if (!type || prefix > (type === "ipv4" ? 32 : 128)) return;

  return { address, type, prefix };
}

function networkList(networks: readonly string[]) {
  const list = new BlockList();

  for (const cidr of networks) {
    const network = parseNetwork(cidr);

    if (!network) throw new Error("Invalid Fleet API network");
    list.addSubnet(network.address, network.prefix, network.type);
  }

  return list;
}

const privateRanges = privateNetworks.map((cidr) => ({
  network: parseNetwork(cidr),
  list: networkList([cidr]),
}));

export function isPrivateNetwork(cidr: string) {
  const network = parseNetwork(cidr);

  return (
    !!network &&
    privateRanges.some(
      ({ network: range, list }) =>
        range &&
        range.type === network.type &&
        range.prefix <= network.prefix &&
        list.check(network.address, network.type),
    )
  );
}

export function parseApiListen(listen: string) {
  const match = /^(?:\[([^\]]+)\]|([^:]*)):(\d{1,5})$/.exec(listen);

  if (!match) return;

  const hostname =
    match[1] ??
    (match[2] === undefined || match[2] === "" ? "127.0.0.1" : match[2]);

  const port = Number(match[3]);
  const type = family(hostname);

  if (
    !type ||
    type !== (match[1] ? "ipv6" : "ipv4") ||
    !privateRanges.some(
      ({ network, list }) =>
        network?.type === type && list.check(hostname, type),
    ) ||
    port < 1 ||
    port > 65_535
  )
    return;

  return { hostname, port };
}

/** Normalize IPv4-mapped clients to the same identity used by IPv4 peers. */
export function peerAddress(address: string | undefined) {
  if (!address) return;
  const type = family(address);

  if (!type) return;

  if (type === "ipv4") return address;
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);

  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1] ?? "", 16);
  const low = Number.parseInt(mapped[2] ?? "", 16);

  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function networkMatcher(networks: readonly string[]) {
  if (!networks.every(isPrivateNetwork))
    throw new Error("Fleet API is private-network only. Use private CIDRs.");
  const list = networkList(networks);

  return (address: string) => {
    const type = family(address);

    return !!type && list.check(address, type);
  };
}

export const defaultCorsOrigins = ["subspace://*"] as const;

export function isOriginPattern(pattern: string) {
  const match =
    /^[a-z][a-z0-9+.-]*:\/\/(\[[a-f0-9:]+\]|(?:[a-z0-9-]+|\*)(?:\.(?:[a-z0-9-]+|\*))*)(?::([1-9]\d{0,4}))?$/.exec(
      pattern,
    );

  if (!match?.[1] || Number(match[2] ?? 0) > 65_535) return false;

  return !match[1].startsWith("[") || isIP(match[1].slice(1, -1)) === 6;
}

export function originMatcher(patterns: readonly string[]) {
  const matchers = patterns.map(
    (pattern) =>
      new RegExp(
        `^${pattern
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("[a-z0-9-]+")}$`,
      ),
  );

  return (origin: string | null): origin is string =>
    origin !== null && matchers.some((matcher) => matcher.test(origin));
}
