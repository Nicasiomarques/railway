import * as k8s from "@kubernetes/client-node";
import type { RuntimeAdapter, RuntimeRegistry } from "./adapter.js";
import { InMemoryRuntime } from "./in-memory.js";
import { K8sRuntime } from "./k8s.js";

// What the registry needs to know about a region to build its adapter. One row of `regions`
// (db/src/schema.ts) maps to one of these.
export interface RegionConfig {
  id: string;
  // The kubeconfig context whose cluster this region's workloads run on. Matches
  // K8sRuntime.fromContext's own `context` parameter -- a region *is* a kube context here.
  kubeContext: string;
}

// Builds one K8sRuntime per region, lazily and cached: most reconcile passes touch one region
// repeatedly, and a K8sRuntime holds no connection state worth avoiding reuse of.
export class K8sRuntimeRegistry implements RuntimeRegistry {
  private readonly adapters = new Map<string, K8sRuntime>();

  constructor(
    private readonly regions: RegionConfig[],
    private readonly kubeconfig: k8s.KubeConfig = loadDefault(),
  ) {}

  forRegion(regionId: string): RuntimeAdapter {
    const cached = this.adapters.get(regionId);
    if (cached) return cached;

    const region = this.regions.find((r) => r.id === regionId);
    if (!region) throw new Error(`no region configured for regionId ${regionId}`);

    const kc = new k8s.KubeConfig();
    kc.loadFromString(this.kubeconfig.exportConfig());
    kc.setCurrentContext(region.kubeContext);
    const adapter = new K8sRuntime(kc);
    this.adapters.set(regionId, adapter);
    return adapter;
  }
}

function loadDefault(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc;
}

// One InMemoryRuntime per region: lets a test assert that a workload applied for region A never
// shows up in region B's simulated state, the same way two real clusters would never see each
// other's workloads.
export class InMemoryRuntimeRegistry implements RuntimeRegistry {
  private readonly adapters = new Map<string, InMemoryRuntime>();

  forRegion(regionId: string): InMemoryRuntime {
    let adapter = this.adapters.get(regionId);
    if (!adapter) {
      adapter = new InMemoryRuntime();
      this.adapters.set(regionId, adapter);
    }
    return adapter;
  }
}

// For a single-region deployment (today's default): every regionId resolves to the same adapter,
// so existing callers that don't care about regions yet can keep passing one RuntimeAdapter.
export class SingleRegionRuntimeRegistry implements RuntimeRegistry {
  constructor(private readonly adapter: RuntimeAdapter) {}

  forRegion(): RuntimeAdapter {
    return this.adapter;
  }
}
