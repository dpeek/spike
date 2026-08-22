import { describe, expect, onTestFinished, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjectConfig, resolveTicketAssignment } from "./config.ts";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "spike-config-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "spike.json"),
    `${JSON.stringify({
      project: { slug: "example-project" },
      agents: {
        planner: { model: "planner", thinking: "high" },
        implement: { model: "implementer", thinking: "medium", isolation: "container", networkAccess: "unrestricted", credentialGrants: [] },
        review: { model: "reviewer", thinking: "high", isolation: "container", networkAccess: "unrestricted", credentialGrants: [] },
      },
    })}\n`,
  );
  return root;
}

describe("project agent configuration", () => {
  test("loads role defaults and applies one-Ticket overrides", async () => {
    const root = await fixture();

    expect((await loadProjectConfig(root)).project).toEqual({ slug: "example-project" });
    expect((await loadProjectConfig(root)).agents.planner).toEqual({ model: "planner", thinking: "high" });
    expect(await resolveTicketAssignment(root, "implement")).toEqual({
      model: "implementer", thinking: "medium", isolation: "container", networkAccess: "unrestricted", credentialGrants: [],
    });
    expect(await resolveTicketAssignment(root, "review", { model: "special-reviewer", thinking: "low", isolation: "workspace", credentialGrants: [] })).toEqual({
      model: "special-reviewer", thinking: "low", isolation: "workspace", networkAccess: "unrestricted", credentialGrants: [],
    });
  });

  test("defaults omitted worker isolation to container and rejects the former models shape", async () => {
    const root = await fixture();
    const config = JSON.parse(await readFile(join(root, "spike.json"), "utf8"));
    delete config.agents.implement.isolation;
    delete config.agents.review.isolation;
    await writeFile(join(root, "spike.json"), `${JSON.stringify(config)}\n`);
    expect(await resolveTicketAssignment(root, "implement")).toMatchObject({ isolation: "container" });
    expect(await resolveTicketAssignment(root, "review")).toMatchObject({ isolation: "container" });
    await writeFile(join(root, "spike.json"), JSON.stringify({ project: { slug: "example-project" }, models: config.agents }));
    await expect(loadProjectConfig(root)).rejects.toThrow();
  });

  test("rejects missing, malformed, and incomplete configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "spike-config-test-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await expect(loadProjectConfig(root)).rejects.toThrow("does not exist");

    await writeFile(join(root, "spike.json"), "not json\n");
    await expect(loadProjectConfig(root)).rejects.toThrow("not valid JSON");

    await writeFile(join(root, "spike.json"), '{"agents":{}}\n');
    await expect(loadProjectConfig(root)).rejects.toThrow();

    await writeFile(
      join(root, "spike.json"),
      `${JSON.stringify({
        project: { slug: "Invalid Slug" },
        agents: {
          planner: { model: "planner", thinking: "high" },
          implement: { model: "implementer", thinking: "medium", isolation: "container", networkAccess: "unrestricted", credentialGrants: [] },
          review: { model: "reviewer", thinking: "high", isolation: "container", networkAccess: "unrestricted", credentialGrants: [] },
        },
      })}\n`,
    );
    await expect(loadProjectConfig(root)).rejects.toThrow();
  });
});
