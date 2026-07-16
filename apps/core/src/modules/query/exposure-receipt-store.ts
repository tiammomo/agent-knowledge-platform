import type { Pool } from "pg";

export interface ExposureReceipt {
  readonly citations: readonly unknown[];
  readonly critical: readonly string[];
  readonly expiresAt: string;
  readonly exposureReceiptId: string;
  readonly issuedAt: string;
  readonly kind: "query" | "revision_read" | "blob_read";
  readonly obligations: readonly unknown[];
  readonly policyDecisionId: string;
  readonly policyEpoch: string;
  readonly purpose: string;
  readonly spaceIds: readonly string[];
  readonly subjectPseudonym: string;
}

export interface ExposureReceiptStore {
  readonly eraseIntegratedWithLifecycle: boolean;
  eraseRevision(spaceId: string, revisionId: string): Promise<void>;
  get(id: string): Promise<ExposureReceipt | undefined>;
  put(receipt: ExposureReceipt): Promise<void>;
}

export class InMemoryExposureReceiptStore implements ExposureReceiptStore {
  public readonly eraseIntegratedWithLifecycle = false;
  readonly #receipts = new Map<string, ExposureReceipt>();

  public async eraseRevision(spaceId: string, revisionId: string): Promise<void> {
    for (const [id, receipt] of this.#receipts) {
      if (receipt.citations.some((item) => {
        const citation = item as { readonly revisionId?: string; readonly spaceId?: string };
        return citation.spaceId === spaceId && citation.revisionId === revisionId;
      })) {
        this.#receipts.delete(id);
      }
    }
  }

  public async get(id: string): Promise<ExposureReceipt | undefined> {
    return this.#receipts.get(id);
  }

  public async put(receipt: ExposureReceipt): Promise<void> {
    this.#receipts.set(receipt.exposureReceiptId, receipt);
  }
}

export class PostgresExposureReceiptStore implements ExposureReceiptStore {
  public readonly eraseIntegratedWithLifecycle = true;
  public constructor(
    private readonly pool: Pool,
    private readonly tenantId: string,
  ) {}

  public async eraseRevision(spaceId: string, revisionId: string): Promise<void> {
    await this.pool.query(
      `delete from query.exposure_receipt
        where tenant_id = $1
          and exists (
          select 1
            from jsonb_array_elements(document->'citations') citation
           where citation->>'spaceId' = $2 and citation->>'revisionId' = $3
        )`,
      [this.tenantId, spaceId, revisionId],
    );
  }

  public async get(id: string): Promise<ExposureReceipt | undefined> {
    const result = await this.pool.query<{ readonly document: ExposureReceipt }>(
      `select document
         from query.exposure_receipt
        where tenant_id = $1 and exposure_receipt_id = $2`,
      [this.tenantId, id],
    );
    return result.rows[0]?.document;
  }

  public async put(receipt: ExposureReceipt): Promise<void> {
    await this.pool.query(
      `insert into query.exposure_receipt
         (tenant_id, exposure_receipt_id, subject_digest, policy_epoch, expires_at, document)
       values ($1, $2, $3, $4, $5, $6::jsonb)
       on conflict (tenant_id, exposure_receipt_id) do nothing`,
      [
        this.tenantId,
        receipt.exposureReceiptId,
        receipt.subjectPseudonym,
        receipt.policyEpoch,
        receipt.expiresAt,
        JSON.stringify(receipt),
      ],
    );
  }
}
