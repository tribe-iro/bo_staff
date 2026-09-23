import { ENGINE_IDS, type EngineId, type EngineInfo } from "../model.ts";
import type { Harness } from "../harness/port.ts";
import type { EngineCatalog } from "../spec.ts";

const REPROBE_MS = 30_000;

interface Entry {
  harness: Harness;
  info: EngineInfo;
  probedAt: number;
  probing?: Promise<EngineInfo>;
}

/**
 * The configured engines and their last probe. Available engines are probed once (a version change needs a
 * restart); unavailable ones are re-probed lazily, at most once per `reprobeMs`, with concurrent callers sharing
 * one probe.
 */
export class Engines implements EngineCatalog {
  private readonly entries = new Map<EngineId, Entry>();
  private readonly configuredDefault?: EngineId;
  private readonly reprobeMs: number;

  private constructor(configuredDefault: EngineId | undefined, reprobeMs: number) {
    this.configuredDefault = configuredDefault;
    this.reprobeMs = reprobeMs;
  }

  static async start(harnesses: readonly Harness[], opts: { defaultEngine?: EngineId; reprobeMs?: number } = {}): Promise<Engines> {
    const { defaultEngine, reprobeMs = REPROBE_MS } = opts;
    if (defaultEngine !== undefined && !ENGINE_IDS.includes(defaultEngine)) throw new Error(`BO_DEFAULT_ENGINE must be one of ${ENGINE_IDS.join(", ")}`);
    const engines = new Engines(defaultEngine, reprobeMs);
    const now = Date.now();
    const infos = await Promise.all(harnesses.map((harness) => harness.probe()));
    harnesses.forEach((harness, i) => engines.entries.set(harness.id, { harness, info: infos[i]!, probedAt: now }));
    if (defaultEngine !== undefined && !engines.entries.get(defaultEngine)?.info.available) {
      throw new Error(`default engine ${defaultEngine} is not available`);
    }
    return engines;
  }

  harness(id: EngineId): Harness | undefined {
    return this.entries.get(id)?.harness;
  }

  /** Last known info, without probing (for hot paths that only need features/version of an admitted run). */
  cached(id: EngineId): EngineInfo | undefined {
    return this.entries.get(id)?.info;
  }

  async info(id: EngineId): Promise<EngineInfo | undefined> {
    const entry = this.entries.get(id);
    return entry && this.refresh(entry);
  }

  async list(): Promise<EngineInfo[]> {
    return Promise.all([...this.entries.values()].map((entry) => this.refresh(entry)));
  }

  async defaultEngine(): Promise<EngineId | undefined> {
    if (this.configuredDefault) return this.configuredDefault;
    for (const id of ENGINE_IDS) if ((await this.info(id))?.available) return id;
    return undefined;
  }

  private refresh(entry: Entry): Promise<EngineInfo> | EngineInfo {
    if (entry.info.available || Date.now() - entry.probedAt < this.reprobeMs) return entry.info;
    entry.probing ??= entry.harness.probe().then(
      (info) => info,
      (err: unknown): EngineInfo => ({ ...entry.info, reason: `probe failed: ${err instanceof Error ? err.message : String(err)}` }),
    ).then((info) => {
      entry.info = info;
      entry.probedAt = Date.now();
      entry.probing = undefined;
      return info;
    });
    return entry.probing;
  }
}
