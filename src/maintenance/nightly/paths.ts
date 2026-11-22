import { join } from "node:path";

export function maintenanceDirectory(dataDirectory: string) {
  return join(dataDirectory, "maintenance");
}
