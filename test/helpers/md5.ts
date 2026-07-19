/**
 * MD5 hex of a string — identical to the SyncEngine's hash computation
 * (createHash("md5") over the byte content). Used in integration tests
 * to populate base entries with the actual local hash.
 */

import { createHash } from "crypto";

export function md5Hex(content: string): string {
  return createHash("md5").update(Buffer.from(content, "utf-8")).digest("hex");
}
