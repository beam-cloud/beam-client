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

/** CPU capacity, selected per workload. Performance does not overbook vCPUs. */
export type CpuTier = "spot" | "shared" | "performance";
export interface CPUPriceBinding {
  tier: CpuTier;
  version: string;
  cpu_price_id: string;
  memory_price_id: string;
  cpu_cents_per_hour: string;
  memory_cents_per_gib_hour: string;
}
export interface CPUTierCatalog {
  enabled: boolean;
  default_cpu_tier: CpuTier | "";
  cpu_tiers: Partial<
    Record<
      CpuTier,
      {
        available: boolean;
        interruptible: boolean;
        cpu_sharing: boolean | null;
        pricing: CPUPriceBinding;
        max_cpu?: number;
        max_memory?: number;
        native_vm_min_cpu: number;
        native_vm_min_memory: number;
      }
    >
  >;
}
