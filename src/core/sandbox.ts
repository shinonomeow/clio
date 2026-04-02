import * as path from 'node:path';
import * as os from "node:os";

// Types
export interface SandboxFilesystemConfig {
  allowedPaths?: string[];
  deniedPaths?: string[];
  readOnlyPaths?: string[];
}

export interface SandboxNetworkConfig {
  enabled?: boolean;
}

export interface SandboxEnvironmentConfig {
  passthrough?: string[];
  block?: string[];
  override?: Record<string, string>;
}


export interface SandboxResourceConfig {
  maxMemoryMB?: number;
  maxCPUseconds?: number;
}

export interface SandboxConfig {
  filesystem?: SandboxFilesystemConfig;
  network?: SandboxNetworkConfig;
  environment?: SandboxEnvironmentConfig;
  resources?: SandboxResourceConfig;
}

// 用来传给子进程的环境变量，默认会屏蔽掉一些常见的敏感环境变量，用户可以通过 environment.block 来添加更多需要屏蔽的环境变量
const DEFAULT_BLOCKED_ENV = [
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "CLIO_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
];

const ESSENTIAL_ENV = ["PATH", "HOME", "TERM", "SHELL", "USER", "LANG", "TMPDIR", "TMP", "TEMP"];

const NETWORK_COMMANDS = [
  /\bcurl\b/, /\bwget\b/, /\bssh\b/, /\bnc\b/, /\bncat\b/,
  /\btelnet\b/, /\bftp\b/, /\bscp\b/, /\brsync\b/,
];

// helpers

function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    // ~/document -> slice(2) -> document
    return path.resolve(os.homedir(), p.slice(2))
  }
  return path.resolve(p);
}

function isUnder(filePath: string, dir: string): boolean {
  const resolvedFile = path.resolve(filePath);
  const resolvedDir = path.resolve(dir);
  const prefix = resolvedDir.endsWith(path.sep) ? resolvedDir : resolvedDir + path.sep;
  return resolvedFile == resolvedDir || resolvedFile.startsWith(prefix);
}
export class Sandbox {
  private allowPaths: string[];
  private deniedPaths: string[];
  private readOnlyPaths: string[];
  private networkEnable: boolean;
  private envConfig: SandboxEnvironmentConfig;
  private resourceConfig: SandboxResourceConfig;
  constructor(private config: SandboxConfig, private cwd: string) {
    this.allowPaths = (config.filesystem?.allowedPaths ?? []).map(resolvePath);
    this.deniedPaths = (config.filesystem?.deniedPaths ?? []).map(resolvePath);
    this.readOnlyPaths = (config.filesystem?.readOnlyPaths ?? []).map(resolvePath);
    // default to true(undifined as true)
    this.networkEnable = config.network?.enabled !== false;
    this.envConfig = config.environment ?? {};
    this.resourceConfig = config.resources ?? {};
  }
  assertPathAllowed(filePath: string, mode: "read" | "write"): void {
    const resolved = path.resolve(filePath);
    // Denied paths - highest priority
    for (const denied of this.deniedPaths) {
      if (isUnder(resolved, denied)) {
        throw new Error(`Sandbox: path denied: ${filePath}`);
      }
    }
    if (mode === "write") {
      for (const ro of this.readOnlyPaths) {
        if (isUnder(resolved, ro)) {
          throw new Error(`Sandbox: path is read-only: ${filePath}`);
        }
      }
    }
    // must be under cwd or an allowed path
    if (isUnder(resolved, this.cwd)) return;
    for (const allowed of this.allowPaths) {
      if (isUnder(resolved, allowed)) return;
    }
    throw new Error(`Sandbox: path outside workspace: ${filePath} (cwd: ${this.cwd}). Add to sandbox.filesystem.allowedPaths to override.`);
  }
  buildEnvironment(extra?: Record<string, string>): Record<string, string> {
    const base = process.env;
    let result: Record<string, string> = {};
    if (this.envConfig.passthrough && this.envConfig.passthrough.length > 0) {
      const allowed = new Set([...ESSENTIAL_ENV, ...this.envConfig.passthrough]);
      for (const key of allowed) {
        if (base[key] !== undefined) {
          result[key] = base[key];
        }
      }
    }
    else {
      const blocked = new Set([...DEFAULT_BLOCKED_ENV, ...(this.envConfig.block ?? [])])
      for (const [key, value] of Object.entries(base)) {
        if (!blocked.has(key) && value !== undefined) {
          result[key] = value;
        }
      }
    }
    // apply overrides
    if (this.envConfig.override) {
      result = { ...result, ...this.envConfig.override };
    }
    // apply extra env vars
    if (extra) {
      result = { ...result, ...extra };
    }
    return result;

  }
}
