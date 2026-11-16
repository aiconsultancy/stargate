// Adapted from CFP Starfleet Teams 0.4.0; transport logic is independent of Claude Code.
// The Bot Connector bearer token must only ever reach Microsoft's Bot Connector
// hosts, which are also the only Teams hosts the fleet VM's egress rule allows.
const ALLOWED_HOSTS = new Set(["smba.trafficmanager.net"]);
const ALLOWED_SUFFIXES = [".botframework.com"];

// Returns the service URL without a trailing slash, or throws when the URL is
// not an https URL on an allowed Bot Connector host.
export function serviceUrlBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid serviceUrl: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  const allowedHost =
    ALLOWED_HOSTS.has(host) ||
    ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (
    url.protocol !== "https:" ||
    !allowedHost ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error(`serviceUrl is not an allowed Bot Connector URL: ${raw}`);
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function isAllowedServiceUrl(raw: string): boolean {
  try {
    serviceUrlBase(raw);
    return true;
  } catch {
    return false;
  }
}
