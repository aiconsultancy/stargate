import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Crew state commits run synchronous SQLite fsyncs on the test thread, about
 * 220 per case; Pi Durable also syncs its files. On a disk shared with clones
 * and installs, one commit can wait seconds behind other writeback. Cases that
 * prove logic, not disk durability, keep their small state on RAM-backed
 * storage where Linux has it. Git trees and disk-behaviour cases use tmpdir().
 */
export function fixtureRoot() {
  return existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
}
