import { Predicate, Schema } from "effect";
import { settingsPlainRecord } from "../../src/config/settings-schema";

// The record decoder discards symbol keys before its property-name check.
// Zod string-keyed records instead reject enumerable symbols on the input.
const noEnumerableSymbols = Schema.makeFilter((input: unknown) => {
  if (!Predicate.isObject(input)) return true;

  return !Object.getOwnPropertySymbols(input).some((key) =>
    Object.prototype.propertyIsEnumerable.call(input, key),
  );
});

export function zodStringRecord<V extends Schema.Constraint>(value: V) {
  return Schema.Unknown.check(noEnumerableSymbols).pipe(
    Schema.decodeTo(settingsPlainRecord(Schema.String, value)),
  );
}
