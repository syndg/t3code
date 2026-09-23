import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import type * as AcpSchema from "effect-acp/schema";

import { COMPACT_SLASH_COMMAND } from "../providerSnapshot.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import { makeAcpCommandCatalog } from "../Layers/AcpCommandCatalog.ts";

const SKILL_MENTION_PATTERN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

/** OMP invokes its advertised skills through `/skill:name`; composers insert `$name`. */
export function rewriteOmpSkillMentions(prompt: string, skillNames: ReadonlySet<string>): string {
  return prompt.replace(SKILL_MENTION_PATTERN, (match, prefix: string, name: string) =>
    skillNames.has(name) ? `${prefix}/skill:${name}` : match,
  );
}

function catalogFromCommands(commands: ReadonlyArray<AcpSchema.AvailableCommand>) {
  const slashCommands: ServerProviderSlashCommand[] = [COMPACT_SLASH_COMMAND];
  const skills: ServerProviderSkill[] = [];
  const seenCommands = new Set<string>([COMPACT_SLASH_COMMAND.name]);
  const seenSkills = new Set<string>();
  for (const command of commands) {
    const name = command.name.trim();
    const description = command.description.trim();
    if (name.startsWith("skill:")) {
      const skillName = name.slice("skill:".length).trim();
      if (!skillName || seenSkills.has(skillName)) continue;
      seenSkills.add(skillName);
      skills.push({
        name: skillName,
        path: `skill://${skillName}`,
        enabled: true,
        ...(description ? { description } : {}),
      });
      continue;
    }
    if (!name || seenCommands.has(name)) continue;
    seenCommands.add(name);
    const hint = command.input?.hint.trim();
    slashCommands.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return { slashCommands, skills };
}

export const makeOmpCommandCatalog = (provider: ServerProviderShape) =>
  makeAcpCommandCatalog(provider, (commands) => catalogFromCommands(commands));
