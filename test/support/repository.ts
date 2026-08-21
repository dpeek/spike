import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  remove: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "spike-test-"));
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
  return {
    root,
    head: await git(root, "rev-parse", "HEAD"),
    git: (...args) => git(root, ...args),
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
