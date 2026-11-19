import { Effect, Schema, SchemaIssue } from "effect";
import { z } from "zod";
import { isOriginPattern, isPrivateNetwork, parseApiListen } from "./network";

const fields = z.strictObject({
  listen: z.string().refine(parseApiListen, {
    message:
      "Fleet API is private-network only. Use a private literal host and port 1–65535 (bracket IPv6), or :PORT for loopback.",
  }),
  allowedNetworks: z
    .array(
      z.string().refine(isPrivateNetwork, {
        message:
          "Fleet API is private-network only. Use a CIDR wholly within a supported private network.",
      }),
    )
    .min(1)
    .optional(),
  corsOrigins: z
    .array(
      z.string().refine(isOriginPattern, {
        message:
          "Use an exact origin or replace a whole hostname label with *.",
      }),
    )
    .optional(),
  fleetName: z.string().trim().min(1).optional(),
});

export type ApiV1Config = z.output<typeof fields>;

function configIssues(error: z.ZodError) {
  return error.issues.map(({ path, code, message }) => ({
    path,
    message:
      code === "unrecognized_keys" ? "Unrecognized Fleet API setting" : message,
  }));
}

// Keep the API object strict while using the existing configuration decoder.
export const apiV1ConfigSchema = Schema.declareConstructor<ApiV1Config>()(
  [],
  () => (input, ast) => {
    const result = fields.safeParse(input);
    if (result.success) return Effect.succeed(result.data);
    const issues = configIssues(result.error).map(
      ({ path, message }) =>
        new SchemaIssue.Pointer(
          path,
          new SchemaIssue.InvalidValue({ message }),
        ),
    );
    const [first, ...rest] = issues;
    return Effect.fail(
      first
        ? new SchemaIssue.Composite(ast, [first, ...rest])
        : new SchemaIssue.InvalidValue({
            message: "Invalid Fleet API configuration",
          }),
    );
  },
);
