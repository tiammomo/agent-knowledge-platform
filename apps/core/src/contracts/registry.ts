import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

const addFormats = addFormatsModule.default as unknown as FormatsPlugin;

export class ContractValidationError extends Error {
  public constructor(
    public readonly schemaId: string,
    public readonly errors: readonly ErrorObject[],
  ) {
    super(`Value does not satisfy ${schemaId}`);
    this.name = "ContractValidationError";
  }
}

export class ContractRegistry {
  readonly #ajv: Ajv2020;
  readonly #schemas = new Map<string, unknown>();

  public constructor(contractRoot: string) {
    this.#ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      validateFormats: true,
    });
    addFormats(this.#ajv);

    const schemaDirectory = join(contractRoot, "schemas");
    const schemaFiles = readdirSync(schemaDirectory)
      .filter((file) => file.endsWith(".json"))
      .sort();

    for (const file of schemaFiles) {
      const schema = JSON.parse(
        readFileSync(join(schemaDirectory, file), "utf8"),
      ) as { readonly $id?: string };
      if (schema.$id === undefined) {
        throw new Error(`Schema ${file} has no $id`);
      }
      this.#ajv.addSchema(schema, schema.$id);
      this.#schemas.set(schema.$id, schema);
    }

    for (const schemaId of this.#schemas.keys()) {
      this.validator(schemaId);
    }
  }

  public assert(schemaId: string, value: unknown): void {
    const validate = this.validator(schemaId);
    if (!validate(value)) {
      throw new ContractValidationError(schemaId, validate.errors ?? []);
    }
  }

  public get schemaCount(): number {
    return this.#schemas.size;
  }

  public schema(schemaId: string): unknown {
    const schema = this.#schemas.get(schemaId);
    if (schema === undefined) {
      throw new Error(`Unknown schema: ${schemaId}`);
    }
    return schema;
  }

  public validator(schemaId: string): ValidateFunction {
    const validate = this.#ajv.getSchema(schemaId);
    if (validate === undefined) {
      throw new Error(`Unknown or uncompiled schema: ${schemaId}`);
    }
    return validate;
  }
}
