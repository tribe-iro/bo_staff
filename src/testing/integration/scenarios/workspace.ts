import path from "node:path";
import type { IntegrationContext } from "../fixtures.ts";
import { pauseStep } from "../fixtures.ts";
import {
  assertContains,
  assertFileContent,
  assertNoPayloadErrors,
  executeRequest,
  getPayloadContent,
  requireTerminalEnvelope,
} from "../assertions.ts";
import { buildRequest, type IntegrationAgent } from "./common.ts";

export async function runWrite(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  filename: string,
  expectedContent: string,
  prefix: string
) {
  const result = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(
      backend,
      sourceRoot,
      `Using tools, create ${filename} in the current directory containing exactly '${expectedContent}'. Then reply with exactly ${filename}.`,
      {}
    ),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });
  const terminal = requireTerminalEnvelope(result.envelopes, `${backend} direct write`);
  assertContains(String(getPayloadContent(terminal)), filename, `${backend} direct write reply`);
  await assertFileContent(path.join(sourceRoot, filename), expectedContent);
  assertNoPayloadErrors(terminal, `${backend} direct write`);
  await pauseStep(context);
}
