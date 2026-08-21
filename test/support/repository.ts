import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProject } from "../../src/project.ts";

export const fixtureGuidance = {
  goal: "# Fixture Goal guidance\n\nRequire explicit operator approval.\n",
  plan: "# Fixture Plan guidance\n\nKeep the next bounded step current.\n",
  change: "# Fixture Change guidance\n\nDefine one coherent integration unit.\n",
  implement: "# Fixture Implement guidance\n\nComplete the bounded implementation Ticket.\n",
  review: "# Fixture Review guidance\n\nReview only the exact Candidate and canonical criteria.\n",
  remediate: "# Fixture Remediate guidance\n\nClose only the accepted review findings.\n",
  decide: "# Fixture Decide guidance\n\nUse exact durable approval evidence.\n",
  recover: "# Fixture Recover guidance\n\nRewind to committed workflow facts.\n",
} as const;

async function removeTree(path: string): Promise<void> {
  // Exchanges deliberately contain read-only input directories. Restore owner
  // write access before removal; Bun's fs.rm can otherwise surface ENOTEMPTY
  // on APFS after traversing those durable directories.
  await Bun.spawn(["chmod", "-R", "u+w", path], { stdout: "ignore", stderr: "ignore" }).exited;
  const child = Bun.spawn(["rm", "-rf", path], { stdout: "ignore", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`could not remove test fixture ${path}: ${stderr.trim()}`);
}

async function git(root: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim());
  return stdout.trim();
}

export async function temporaryRepository(): Promise<{
  root: string;
  head: string;
  git: (...args: string[]) => Promise<string>;
  dataRoot: string;
  projectRoot: string;
  remove: () => Promise<void>;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "spike-test-")));
  // Every repository fixture owns a distinct host control-plane root. This
  // prevents unrelated test repositories with the same tracked slug from
  // colliding, while keeping all workflow state at projects/<slug>/.
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "spike-test-data-")));
  process.env["SPIKE_DATA_DIR"] = dataRoot;
  await git(root, "init", "--quiet");
  await git(root, "config", "user.name", "Spike Test");
  await git(root, "config", "user.email", "spike@example.test");
  await mkdir(join(root, "spike", "guidance"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "README.md"), "fixture\n"),
    ...Object.entries(fixtureGuidance).map(([step, markdown]) =>
      writeFile(join(root, "spike", "guidance", `${step}.md`), markdown)
    ),
    writeFile(
      join(root, "spike.json"),
      `${JSON.stringify(
        {
          project: { slug: "spike" },
          agents: {
            planner: { model: "planner-model", thinking: "high" },
            implement: { model: "implementation-model", thinking: "medium", isolation: "workspace", networkAccess: "unrestricted", credentialGrants: [] },
            review: { model: "review-model", thinking: "high", isolation: "workspace", networkAccess: "unrestricted", credentialGrants: [] },
          },
        },
        null,
        2,
      )}\n`,
    ),
  ]);
  await git(root, "add", "README.md", "spike.json", "spike/guidance");
  await git(root, "commit", "--quiet", "-m", "Initial fixture");
  // Resolve once in this test realm as well as in any spawned CLI process so
  // synchronous path helpers consistently point at this fixture's Project.
  await resolveProject(root);
  return {
    root,
    head: await git(root, "rev-parse", "HEAD"),
    git: (...args) => git(root, ...args),
    dataRoot,
    projectRoot: join(dataRoot, "projects", "spike"),
    remove: async () => {
      // Remove the checkout first. A just-finished worker can still be closing
      // repository handles while publishing its final central marker; deleting
      // both trees concurrently races that publication on macOS.
      await removeTree(root);
      await removeTree(dataRoot);
      if (process.env["SPIKE_DATA_DIR"] === dataRoot) delete process.env["SPIKE_DATA_DIR"];
    },
  };
}
