import { expect, test } from "bun:test";
import {
  isLocalhost,
  isLoopbackAddress,
  isLoopbackHost,
} from "../src/lib/loopback";

const hostname = (value: string) => new URL(value).hostname;

test("the three loopback policies accept exactly their hosts", () => {
  const cases: [
    url: string,
    address: boolean,
    local: boolean,
    host: boolean,
  ][] = [
    ["http://127.0.0.1:8317/v1", true, true, true],
    ["http://[::1]:8317/v1", true, true, true],
    ["http://localhost:8317/v1", false, true, true],
    ["http://127.0.0.2:8317/v1", false, false, true],
    ["http://127.1:8317/v1", true, true, true],
    ["http://localhost.example:8317/v1", false, false, false],
    ["http://127.0.0.1.example:8317/v1", false, false, false],
    ["http://10.0.0.1:8317/v1", false, false, false],
    ["http://[::ffff:127.0.0.1]:8317/v1", false, false, false],
  ];
  for (const [url, address, local, host] of cases) {
    const name = hostname(url);
    expect([url, isLoopbackAddress(name)]).toEqual([url, address]);
    expect([url, isLocalhost(name)]).toEqual([url, local]);
    expect([url, isLoopbackHost(name)]).toEqual([url, host]);
  }
});
