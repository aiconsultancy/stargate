import { Schema } from "effect";

const projectKeyPattern = /^[a-z][a-z0-9_-]{0,47}$/u;

export const effectProjectKeySchema = Schema.String.check(
  Schema.makeFilter(
    (key) => !["__proto__", "prototype", "constructor"].includes(key),
  ),
  Schema.isPattern(projectKeyPattern),
);
