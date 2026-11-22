import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { isAllowedServiceUrl, serviceUrlBase } from "../src/teams/service-url";

describe("Bot Connector service URL allow-list", () => {
  test("accepts the Teams and Bot Framework hosts over https", () => {
    assert.equal(
      serviceUrlBase("https://smba.trafficmanager.net/emea/"),
      "https://smba.trafficmanager.net/emea",
    );
    assert.equal(
      serviceUrlBase("https://SMBA.TrafficManager.NET/uk"),
      "https://smba.trafficmanager.net/uk",
    );
    assert.equal(
      serviceUrlBase("https://europe.botframework.com/"),
      "https://europe.botframework.com",
    );
    // The default https port is the same URL.
    assert.equal(
      serviceUrlBase("https://smba.trafficmanager.net:443/emea/"),
      "https://smba.trafficmanager.net/emea",
    );
  });

  const refused: [string, string][] = [
    ["plain http", "http://smba.trafficmanager.net/emea/"],
    ["another host", "https://evil.example.com/"],
    [
      "a host that only ends in botframework.com",
      "https://evilbotframework.com/",
    ],
    ["a look-alike suffix", "https://smba.trafficmanager.net.evil.com/"],
    ["a trailing dot", "https://smba.trafficmanager.net./emea/"],
    ["user information", "https://user:pass@smba.trafficmanager.net/emea/"],
    ["a user name alone", "https://evil.com@smba.trafficmanager.net/emea/"],
    ["a non-default port", "https://smba.trafficmanager.net:8443/emea/"],
    [
      "a query string",
      "https://smba.trafficmanager.net/emea/?next=https://evil.com",
    ],
    ["a fragment", "https://smba.trafficmanager.net/emea/#x"],
    ["an unparseable URL", "not a url"],
  ];

  for (const [name, url] of refused) {
    test(`refuses ${name}`, () => {
      assert.equal(isAllowedServiceUrl(url), false, url);
      assert.throws(() => serviceUrlBase(url));
    });
  }
});
