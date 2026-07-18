/**
 * MD5-Hex eines Strings — identisch zur Hash-Berechnung der SyncEngine
 * (createHash("md5") über den Byte-Inhalt). Wird in Integrationstests
 * gebraucht, um Base-Einträge mit dem tatsächlichen lokalen Hash zu bestücken.
 */

import { createHash } from "crypto";

export function md5Hex(content: string): string {
  return createHash("md5").update(Buffer.from(content, "utf-8")).digest("hex");
}
