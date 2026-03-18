import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { normalizeAndValidateRequest } from "../../src/validation.ts";

test("validates pinned and override execution profile requirements", async () => {
  const sourceRoot = os.tmpdir();

  const pinned = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: {
      selection_mode: "pinned"
    },
    task: {
      prompt: "x"
    },
    session: {
      mode: "ephemeral"
    },
    workspace: {
      source_root: sourceRoot
    },
    output: {
      schema: {
        type: "object"
      }
    }
  });

  assert.equal(pinned.ok, false);
  assert.match(pinned.issues[0].message, /required for pinned/);

  const override = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: {
      selection_mode: "override"
    },
    task: {
      prompt: "x"
    },
    session: {
      mode: "ephemeral"
    },
    workspace: {
      source_root: sourceRoot
    },
    output: {
      schema: {
        type: "object"
      }
    }
  });

  assert.equal(override.ok, false);
  assert.match(override.issues[0].message, /required for override/);
});

test("validates attachments must define exactly one content source", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    task: {
      prompt: "x",
      attachments: [
        {
          name: "bad",
          path: "/tmp/a",
          content: "also bad"
        }
      ]
    },
    session: {
      mode: "ephemeral"
    },
    workspace: {
      source_root: os.tmpdir()
    },
    output: {
      schema: {
        type: "object"
      }
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /exactly one of path or content/);
});

test("restricts attachment paths to the effective workspace scope", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-validation-"));
  const insidePath = path.join(workspaceRoot, "allowed.txt");
  const outsidePath = path.join(os.tmpdir(), "bo-staff-validation-outside.txt");
  await writeFile(insidePath, "ok", "utf8");
  await writeFile(outsidePath, "nope", "utf8");

  try {
    const inside = await normalizeAndValidateRequest({
      backend: "codex",
      task: {
        prompt: "x",
        attachments: [
          {
            name: "inside",
            path: "./allowed.txt"
          }
        ]
      },
      session: {
        mode: "ephemeral"
      },
      workspace: {
        source_root: workspaceRoot
      },
      output: {
        schema: {
          type: "object"
        }
      }
    });

    assert.equal(inside.ok, true);
    if (!inside.ok) {
      throw new Error("expected normalized request");
    }
    assert.equal(inside.value.task.attachments[0]?.kind, "path");
    if (inside.value.task.attachments[0]?.kind !== "path") {
      throw new Error("expected path attachment");
    }
    assert.equal(inside.value.task.attachments[0].path, insidePath);

    const outside = await normalizeAndValidateRequest({
      backend: "codex",
      task: {
        prompt: "x",
        attachments: [
          {
            name: "outside",
            path: outsidePath
          }
        ]
      },
      session: {
        mode: "ephemeral"
      },
      workspace: {
        source_root: workspaceRoot
      },
      output: {
        schema: {
          type: "object"
        }
      }
    });

    assert.equal(outside.ok, false);
    assert.match(outside.issues[0].message, /effective workspace scope/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsidePath, { force: true });
  }
});

test("rejects attachment paths that escape workspace scope through symlinks", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-validation-symlink-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-validation-symlink-outside-"));
  const outsidePath = path.join(outsideRoot, "secret.txt");
  const symlinkPath = path.join(workspaceRoot, "escape.txt");
  await writeFile(outsidePath, "secret", "utf8");
  await symlink(outsidePath, symlinkPath);

  try {
    const result = await normalizeAndValidateRequest({
      backend: "codex",
      task: {
        prompt: "x",
        attachments: [
          {
            name: "escape",
            path: "./escape.txt"
          }
        ]
      },
      session: {
        mode: "ephemeral"
      },
      workspace: {
        source_root: workspaceRoot
      },
      output: {
        schema: {
          type: "object"
        }
      }
    });

    assert.equal(result.ok, false);
    assert.match(result.issues.map((issue) => issue.message).join("; "), /symlink resolution/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("reports missing scoped workspace subpaths as missing instead of symlink escape", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-validation-missing-scope-"));
  try {
    const result = await normalizeAndValidateRequest({
      backend: "codex",
      task: {
        prompt: "x"
      },
      session: {
        mode: "ephemeral"
      },
      workspace: {
        source_root: workspaceRoot,
        scope: {
          mode: "subpath",
          subpath: "does-not-exist"
        }
      },
      output: {
        schema: {
          type: "object"
        }
      }
    });

    assert.equal(result.ok, false);
    assert.match(result.issues.map((issue) => issue.message).join("; "), /must exist and be readable/);
    assert.doesNotMatch(result.issues.map((issue) => issue.message).join("; "), /symlink resolution/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("reports missing attachment paths as missing instead of symlink escape", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-validation-missing-attachment-"));
  try {
    const result = await normalizeAndValidateRequest({
      backend: "codex",
      task: {
        prompt: "x",
        attachments: [
          {
            name: "missing",
            path: "./missing.txt"
          }
        ]
      },
      session: {
        mode: "ephemeral"
      },
      workspace: {
        source_root: workspaceRoot
      },
      output: {
        schema: {
          type: "object"
        }
      }
    });

    assert.equal(result.ok, false);
    assert.match(result.issues.map((issue) => issue.message).join("; "), /must exist and be readable/);
    assert.doesNotMatch(result.issues.map((issue) => issue.message).join("; "), /symlink resolution/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("defaults runtime timeout from performance tier and rejects invalid explicit values", async () => {
  const sourceRoot = os.tmpdir();

  const defaulted = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: {
      performance_tier: "high"
    },
    task: {
      prompt: "x"
    },
    session: {
      mode: "ephemeral"
    },
    workspace: {
      source_root: sourceRoot
    },
    output: {
      schema: {
        type: "object"
      }
    }
  });

  assert.equal(defaulted.ok, true);
  if (!defaulted.ok) {
    throw new Error("expected normalized request");
  }
  assert.equal(defaulted.value.runtime.timeout_ms, 300_000);

  const invalid = await normalizeAndValidateRequest({
    backend: "codex",
    runtime: {
      timeout_ms: "five minutes"
    },
    task: {
      prompt: "x"
    },
    session: {
      mode: "ephemeral"
    },
    workspace: {
      source_root: sourceRoot
    },
    output: {
      schema: {
        type: "object"
      }
    }
  });

  assert.equal(invalid.ok, false);
  assert.match(invalid.issues[0].path, /\$\.runtime\.timeout_ms/);
});

test("rejects empty workspace source_root instead of normalizing it to cwd", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    task: {
      prompt: "x"
    },
    session: {
      mode: "ephemeral"
    },
    workspace: {
      source_root: ""
    },
    output: {
      schema: {
        type: "object"
      }
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.map((issue) => issue.path).join("; "), /\$\.workspace\.source_root/);
});

test("defaults message output.schema when output.format=message omits it", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    task: {
      prompt: "x"
    },
    session: {
      mode: "ephemeral"
    },
    workspace: {
      source_root: os.tmpdir()
    },
    output: {
      format: "message"
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected normalized request");
  }
  assert.equal(result.value.output.format, "message");
  assert.equal(result.value.output.schema.type, "object");
});

test("requires output.schema when output.format=custom", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    task: {
      prompt: "x"
    },
    session: {
      mode: "ephemeral"
    },
    workspace: {
      source_root: os.tmpdir()
    },
    output: {
      format: "custom"
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.map((issue) => issue.message).join("; "), /required when output\.format=custom/);
});

test("rejects non-object output.schema values instead of silently widening to {}", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    task: {
      prompt: "x"
    },
    session: {
      mode: "ephemeral"
    },
    workspace: {
      source_root: os.tmpdir()
    },
    output: {
      schema: "not-an-object"
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.map((issue) => issue.message).join("; "), /must be an object/);
});

test("validation does not mutate normalized attachment paths in place", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-validation-no-mutate-"));
  const attachmentPath = path.join(workspaceRoot, "note.txt");
  await writeFile(attachmentPath, "ok", "utf8");

  try {
    const first = await normalizeAndValidateRequest({
      backend: "codex",
      task: {
        prompt: "x",
        attachments: [
          {
            name: "note",
            path: "./note.txt"
          }
        ]
      },
      session: {
        mode: "ephemeral"
      },
      workspace: {
        source_root: workspaceRoot
      },
      output: {
        schema: {
          type: "object"
        }
      }
    });

    const second = await normalizeAndValidateRequest({
      backend: "codex",
      task: {
        prompt: "x",
        attachments: [
          {
            name: "note",
            path: "./note.txt"
          }
        ]
      },
      session: {
        mode: "ephemeral"
      },
      workspace: {
        source_root: workspaceRoot
      },
      output: {
        schema: {
          type: "object"
        }
      }
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {
      throw new Error("expected normalized requests");
    }
    assert.equal(first.value.task.attachments[0]?.kind, "path");
    assert.equal(second.value.task.attachments[0]?.kind, "path");
    if (first.value.task.attachments[0]?.kind !== "path" || second.value.task.attachments[0]?.kind !== "path") {
      throw new Error("expected path attachments");
    }
    assert.equal(first.value.task.attachments[0].path, attachmentPath);
    assert.equal(second.value.task.attachments[0].path, attachmentPath);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
