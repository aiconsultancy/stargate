import { z } from "zod";

// Claude rejects root-level unions. Advertise their fields as one object, but
// keep the original strict union as the validator before any tool can execute.
// Operation handlers parse again to apply their original branch defaults.
export function objectToolInput(
  schema:
    | z.ZodDiscriminatedUnion<readonly z.ZodObject[]>
    | z.ZodUnion<readonly z.ZodObject[]>,
) {
  const fields = new Map<string, z.core.$ZodType[]>();
  for (const option of schema.options) {
    for (const [name, field] of Object.entries(option.shape)) {
      const variants = fields.get(name) ?? [];
      let advertised: z.core.$ZodType =
        field instanceof z.ZodDefault ? field.removeDefault() : field;
      if (advertised instanceof z.ZodOptional) advertised = advertised.unwrap();
      // Advertise a transform's input; the original validator still normalizes it.
      if (advertised instanceof z.ZodPipe) advertised = advertised.in;
      variants.push(advertised);
      fields.set(name, variants);
    }
  }
  const shape: Record<string, z.ZodType> = {};
  for (const [name, variants] of fields)
    shape[name] =
      name === "op" ? z.union(variants) : z.union(variants).optional();
  return z.strictObject(shape).superRefine((input, context) => {
    const result = schema.safeParse(input);
    if (!result.success)
      for (const issue of result.error.issues)
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
  });
}
