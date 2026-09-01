import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';
import { NodeSpec } from '@nexus/protocol';

const Config = z.object({
  cluster: z.object({
    controlNodeId: z.string().min(1).default('mba-m4-control'),
    heartbeatTtlMs: z.number().int().positive().default(45_000),
    bootstrapNodes: z.array(NodeSpec).default([])
  })
});
export type NexusConfig = z.infer<typeof Config>;

export async function loadConfig(
  file = process.env.NEXUS_CONFIG ?? 'config/cluster.yaml'
): Promise<NexusConfig> {
  const raw = await readFile(file, 'utf8');
  return Config.parse(YAML.parse(raw));
}
