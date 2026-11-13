import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SKILL.md playbooks from firecrawl/web-agent (MIT, see third_party/web-agent)
 * plus any operator-supplied directory. Skills load on demand through the
 * `load_skill` tool; site playbooks match by hostname through
 * `lookup_site_playbook`, mirroring web-agent's skill policy.
 */
export type Skill = {
  name: string;
  description: string;
  body: string;
  sites: { platform: string; domains: string[]; body: string }[];
};

function parseFrontmatter(source: string): { meta: Record<string, string | string[]>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) return { meta: {}, body: source };
  const meta: Record<string, string | string[]> = {};
  const lines = match[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.trim();
    if (value === "|" || value === ">" || value === "") {
      const block: string[] = [];
      const list: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]!)) {
        const next = lines[++i]!.trim();
        if (next.startsWith("- ")) list.push(next.slice(2).trim());
        else block.push(next);
      }
      meta[key] = list.length > 0 ? list : block.join(" ");
    } else {
      meta[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: match[2]!.trim() };
}

export function defaultSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ (tsx) and dist/ (compiled) both sit one level below the package root.
  return resolve(here, "..", "skills");
}

export function loadSkills(dirs: string[]): Skill[] {
  const skills = new Map<string, Skill>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry);
      const file = join(skillDir, "SKILL.md");
      if (!statSync(skillDir).isDirectory() || !existsSync(file)) continue;
      const { meta, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const name = typeof meta.name === "string" ? meta.name : entry;
      const sitesDir = join(skillDir, "sites");
      const sites = existsSync(sitesDir)
        ? readdirSync(sitesDir)
            .filter(f => f.endsWith(".md"))
            .map(f => {
              const parsed = parseFrontmatter(readFileSync(join(sitesDir, f), "utf8"));
              const domains = parsed.meta.domains;
              return {
                platform: typeof parsed.meta.platform === "string" ? parsed.meta.platform : f,
                domains: Array.isArray(domains) ? domains.map(d => d.toLowerCase()) : [],
                body: parsed.body,
              };
            })
        : [];
      skills.set(name, {
        name,
        description: typeof meta.description === "string" ? meta.description : "",
        body,
        sites,
      });
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSitePlaybook(skills: Skill[], url: string): { skill: string; platform: string; body: string } | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const skill of skills) {
    for (const site of skill.sites) {
      if (site.domains.some(d => host === d || host.endsWith(`.${d}`))) {
        return { skill: skill.name, platform: site.platform, body: site.body };
      }
    }
  }
  return null;
}
