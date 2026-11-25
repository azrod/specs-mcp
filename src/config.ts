import { resolve } from "node:path";

export type SpecsPaths = Readonly<{ specs: string }>;

export interface SpecsConfig {
  /** Explicit project root, or null to let the server pick it from the MCP client roots. */
  projectRoot: string | null;
  paths: SpecsPaths;
}

/** What tool handlers receive: a concrete root plus the configured paths. */
export interface ToolContext {
  projectRoot: string;
  paths: SpecsPaths;
}

export const DEFAULT_SPECS_DIR = "docs/specs";

function readOption(argv: readonly string[], name: string): string | undefined {
  const flag = `--${name}`;
  const prefix = `${flag}=`;
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === flag) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value`);
      value = next;
      i++;
    } else if (arg.startsWith(prefix)) {
      value = arg.slice(prefix.length);
    }
  }
  return value;
}

/**
 * Build the server configuration.
 *
 * @param argv command-line arguments without the node binary and script (`process.argv.slice(2)`)
 * @param env environment variables (`process.env`)
 *
 * Root: `--root <dir>` > `SPECS_ROOT` > null. A blank root counts as absent.
 * Specs directory: `--specs-dir` > `SPECS_DIR` > `docs/specs`. A blank value is an error.
 */
export function resolveConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): SpecsConfig {
  const rootValue = [readOption(argv, "root"), env.SPECS_ROOT].find((v) => v !== undefined && v.trim() !== "");
  const specs = readOption(argv, "specs-dir") ?? env.SPECS_DIR ?? DEFAULT_SPECS_DIR;
  if (!specs.trim()) throw new Error("paths.specs must be a non-empty string");
  return {
    projectRoot: rootValue === undefined ? null : resolve(rootValue),
    paths: Object.freeze({ specs }),
  };
}
