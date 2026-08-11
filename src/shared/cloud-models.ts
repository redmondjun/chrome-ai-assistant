export const SUPPORTED_CLOUD_MODELS = [
  'nemotron-3-nano',
  'nemotron-3-super',
  'nemotron-3-ultra',
  'glm-5.2',
  'minimax-m3',
] as const;

export type SupportedCloudModel = (typeof SUPPORTED_CLOUD_MODELS)[number];

export const DEFAULT_RESEARCH_WORKER_MODELS: SupportedCloudModel[] = [
  'glm-5.2',
  'nemotron-3-super',
  'minimax-m3',
];

export const DEFAULT_RESEARCH_LEAD_MODEL: SupportedCloudModel = 'glm-5.2';

export const CLOUD_MODEL_LABELS: Record<SupportedCloudModel, string> = {
  'nemotron-3-nano': 'Nemotron 3 Nano',
  'nemotron-3-super': 'Nemotron 3 Super',
  'nemotron-3-ultra': 'Nemotron 3 Ultra',
  'glm-5.2': 'GLM 5.2',
  'minimax-m3': 'MiniMax M3',
};

export function isSupportedCloudModel(value: unknown): value is SupportedCloudModel {
  return SUPPORTED_CLOUD_MODELS.includes(value as SupportedCloudModel);
}

export function normalizeCloudModelPool(
  value: unknown,
  fallback: SupportedCloudModel[] = DEFAULT_RESEARCH_WORKER_MODELS
): SupportedCloudModel[] {
  if (!Array.isArray(value)) return [...fallback];
  const models = [...new Set(value.filter(isSupportedCloudModel))];
  return models.length > 0 ? models : [...fallback];
}
