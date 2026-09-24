// Writes the published contract (`contract/bo.v1.schema.json`, `contract/openapi.json`) from src/contract/schema.ts.
//   npm run contract

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { openApiDocument, schemaDocument } from "../src/contract/documents.ts";
import { CONTRACT_VERSION } from "../src/contract/schema.ts";

const dir = path.resolve(import.meta.dirname, "..", "contract");
await mkdir(dir, { recursive: true });
for (const [name, doc] of [[`bo.v${CONTRACT_VERSION}.schema.json`, schemaDocument()], ["openapi.json", openApiDocument()]] as const) {
  await writeFile(path.join(dir, name), `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`wrote contract/${name}\n`);
}
