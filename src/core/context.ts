/**
  * 从工作目录中加载指定文件
* Agents.md > CLAUDE.md -> .agents/ > .claude/subdirs
*/

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { exec } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec);
// 从当前目录遍历到根目录,去找所有的 instruction 文件,并返回它们的路径列表
async function findInstructionFIles(cwd: string): Promise<string[]> {
  const found: string[] = [];
  let dir = path.resolve(cwd);
  const candidates = [
    "AGENTS.md",
    "CLAUDE.md",
    path.join(".agents", "AGENTS.md"),
    path.join(".claude", "CLAUDE.md"),
  ];
  while (true) {
    for (const name of candidates) {
      const filePath = path.join(dir, name)
      try {
        await fs.access(filePath);
        found.push(filePath);
        break;
      } catch { }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 把根目录的放到最前面,
  return found.reverse();
}

export async function loadCLaudeMd(cwd: string): Promise<string | null> {
  const files = await findInstructionFIles(cwd)
  if (files.length == 0) return null;
  const sections: string[] = [];
  for (const file of files) {
    try {
      const content = (await fs.readFile(file, "utf-8")).trim();
      if (content) {
        const rel = path.relative(cwd, file);
        sections.push(`# Instructions from ${rel}\n\n${content}`)
      }
    } catch { }
  }
  return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
}

// collect git context

export async function loadGitContext(cwd: string): Promise<string | null> {
  try {
    const run = (cmd: string) =>
      execAsync(cmd, {
        cwd, timeout: 5000
      }).then(r => r.stdout.trim());
    const [branch, status, log] = await Promise.all([
      run("git rev-parse --abrev-ref HEAD"),
      run("git status --short"),
      run("git log -5 --oneline")
    ])
    const lines = [`# Git Context`, `- Branch: ${branch}`];
    if (status) {
      const fileCount = status.split("\n").length;
      lines.push(`- Working tree: ${fileCount} changed file(s)`);
      lines.push("```\n" + status + "\n```");
    } else {
      lines.push("- Working tree: clean");
    }
    if (log) {
      lines.push("\nRecent commits:");
      lines.push("```\n" + log + "\n```");
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

export function getEnvironmentInfo(): Promise<string | null> {
  const cwd = process.cwd();
  return Promise.resolve(
    [
      "# Environment",
      `- Working directory: ${cwd}`,
      `- Platform: ${os.platform()} ${os.release()}`,
      `- Shell: bash`,
      `- User: ${os.userInfo().username}`,
    ].join("\n"));
}

export async function buildSystemPrompt(): Promise<string> {
  const cwd = process.cwd();
  const sections: string[] = [];
  const [env, claudeMd, gitCtx] = await Promise.all([
    getEnvironmentInfo(),
    loadCLaudeMd(cwd),
    loadGitContext(cwd),
  ]);
  if (env) sections.push(env);
  if (claudeMd) sections.push(claudeMd);
  if (gitCtx) sections.push(gitCtx);
  return sections.join("\n\n");
}
