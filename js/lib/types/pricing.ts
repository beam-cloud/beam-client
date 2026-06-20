export enum PricingPolicyCostModel {
  Task = "task",
  Duration = "duration",
}

export interface PricingPolicyConfig {
  maxInFlight?: number;
  costModel?: PricingPolicyCostModel;
  costPerTask?: number;
  costPerTaskDurationMs?: number;
}

export class PricingPolicy {
  public maxInFlight: number;
  public costModel: PricingPolicyCostModel;
  public costPerTask: number;
  public costPerTaskDurationMs: number;

  constructor(config: PricingPolicyConfig = {}) {
    this.maxInFlight = config.maxInFlight ?? 10;
    this.costModel = config.costModel ?? PricingPolicyCostModel.Task;
    this.costPerTask = config.costPerTask ?? 0.0;
    this.costPerTaskDurationMs = config.costPerTaskDurationMs ?? 0.0;
  }
}
