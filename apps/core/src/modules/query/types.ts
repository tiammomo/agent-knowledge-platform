import type { PublishedAsset } from "../growth/types.js";

export type ImplementedQueryMode = "exact" | "lexical";

export interface TextOffsetLocator {
  readonly end: number;
  readonly start: number;
  readonly type: "text-offset";
}

export interface PassageCandidate {
  readonly asset: PublishedAsset;
  readonly chunkId: string;
  readonly end: number;
  readonly ordinal: number;
  readonly payloadDigest: string;
  readonly payloadName: string;
  readonly score: number;
  readonly start: number;
  readonly text: string;
}

export interface PassageSearchRequest {
  readonly assets: readonly PublishedAsset[];
  readonly locale?: string;
  readonly mode: ImplementedQueryMode;
  readonly query: {
    readonly reference?: string;
    readonly text?: string;
  };
}

export interface QuerySearchStore {
  readonly backend: string;
  readonly projectionGeneration: string;
  search(request: PassageSearchRequest): Promise<readonly PassageCandidate[]>;
}

export interface RankedAssetResult {
  readonly asset: PublishedAsset;
  readonly passages: readonly PassageCandidate[];
  readonly score: number;
}

export interface ContextPackBudget {
  readonly maxCharacters: number;
  readonly maxPassages: number;
  readonly maxTokens?: number;
}

export interface ContextPackRequest {
  readonly budget: ContextPackBudget;
  readonly critical: readonly string[];
  readonly filters?: Record<string, unknown>;
  readonly locale?: string;
  readonly mode: ImplementedQueryMode;
  readonly purpose: string;
  readonly spaces?: readonly string[];
  readonly supportedObligations: readonly unknown[];
  readonly task: string;
}
