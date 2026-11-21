export const metaCommandSyntax = (): string[] => [
  "/help",
  "/health [host|agents|stargate|opencode|proxy|services|starfleet]",
  "/config",
  "/config waiting <0..3600|off>",
  "/config questions <on|off>",
  "/config questions timeout <5m|15m|1h>",
  "/config questions answer <requester|allowed>",
  "/config mutes",
  "/config system1 <on|off>",
];
