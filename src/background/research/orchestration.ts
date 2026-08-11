import type { ModelRouter } from '../api/router';
import type { ResearchCheckpoint } from './progress';
import {
  DEFAULT_RESEARCH_LEAD_MODEL,
  isSupportedCloudModel,
  normalizeCloudModelPool,
  type SupportedCloudModel,
} from '@/shared/cloud-models';
import type {
  CompletionOptions,
  ResearchJob,
  ResearchOrchestrationConfig,
  ResearchTask,
  StorageSettings,
} from '@/shared/types';

type ResearchRouter = Pick<ModelRouter, 'complete'>;

export function createOrchestrationConfig(settings: StorageSettings): ResearchOrchestrationConfig {
  const workerModels = normalizeCloudModelPool(settings.research.workerModels);
  return {
    enabled: settings.research.orchestrationEnabled && !settings.privacy.localOnly,
    workerModels,
    leadModel: isSupportedCloudModel(settings.research.leadModel)
      ? settings.research.leadModel
      : DEFAULT_RESEARCH_LEAD_MODEL,
  };
}

export function assignResearchModels(job: ResearchJob): void {
  const config = job.orchestration;
  if (!config?.enabled) return;
  job.tasks.forEach((task, index) => {
    task.assignedModel ||= config.workerModels[index % config.workerModels.length];
    task.effectiveModel ||= task.assignedModel;
    task.fallbackUsed ||= false;
  });
}

export function createLeadRouter(
  router: ResearchRouter,
  config: ResearchOrchestrationConfig
): ResearchRouter {
  if (!config.enabled) return router;
  return {
    complete: (question, context, prompt, options = {}) =>
      router.complete(question, context, prompt, { ...options, cloudModel: config.leadModel }),
  };
}

export function createWorkerRouter(
  router: ResearchRouter,
  job: ResearchJob,
  task: ResearchTask,
  checkpoint: ResearchCheckpoint
): ResearchRouter {
  const config = job.orchestration;
  if (!config?.enabled || !task.effectiveModel) return router;

  return {
    complete: async (question, context, prompt, options: CompletionOptions = {}) => {
      const effectiveModel = task.effectiveModel;
      if (!effectiveModel) return router.complete(question, context, prompt, options);
      try {
        return await router.complete(question, context, prompt, {
          ...options,
          cloudModel: effectiveModel,
        });
      } catch (error) {
        if (options.signal?.aborted || task.fallbackUsed || config.workerModels.length < 2) {
          throw error;
        }
        const fallbackModel = nextModel(config.workerModels, effectiveModel);
        task.effectiveModel = fallbackModel;
        task.fallbackUsed = true;
        task.reasoning.push({
          step: task.reasoning.length + 1,
          type: 'synthesize',
          thought: `Model unavailable; retrying with ${fallbackModel}.`,
          timestamp: Date.now(),
        });
        await checkpoint(task, `${task.label}: retrying with ${fallbackModel}`);
        return router.complete(question, context, prompt, {
          ...options,
          cloudModel: fallbackModel,
        });
      }
    },
  };
}

function nextModel(
  models: SupportedCloudModel[],
  current: SupportedCloudModel
): SupportedCloudModel {
  const currentIndex = models.indexOf(current);
  return models[(currentIndex + 1 + models.length) % models.length];
}
