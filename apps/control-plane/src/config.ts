import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';
import { NodeSpec } from '@nexus/protocol';

const Config = z.object({ nodes: z.array(NodeSpec).min(1) });
export type NexusConfig = z.infer<typeof Config>;

export async function loadConfig(file = process.env.NEXUS_CONFIG ?? 'config/nodes.yaml'): Promise<NexusConfig> {
  const raw = await readFile(file, 'utf8');
  return Config.parse(YAML.parse(raw));
}
