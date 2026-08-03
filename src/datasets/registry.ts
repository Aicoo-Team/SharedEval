import type { EvaluatorReference } from '../evaluation/index.js';
import {
  datasetIdentifierSchema,
  datasetSemanticVersionSchema,
  defineDataset,
  type DatasetDefinition,
} from './manifest.js';

export type DatasetReference = {
  readonly id: string;
  readonly version: string;
};

type AnyDatasetDefinition = DatasetDefinition<any, any>;

/** Registry of validated, declarative dataset definitions. */
export class DatasetRegistry {
  readonly #definitions = new Map<string, AnyDatasetDefinition>();

  register<TInput, TDetails>(
    definition: DatasetDefinition<TInput, TDetails>,
  ): DatasetDefinition<TInput, TDetails> {
    const validated = defineDataset<TInput, TDetails>(definition);
    const key = datasetKey(validated);
    if (this.#definitions.has(key)) {
      throw new Error(`dataset ${validated.id}@${validated.version} is already registered`);
    }
    this.#definitions.set(key, validated as AnyDatasetDefinition);
    return validated;
  }

  has(reference: DatasetReference): boolean {
    return this.#definitions.has(datasetKey(reference));
  }

  get<TInput = unknown, TDetails = unknown>(
    reference: DatasetReference,
  ): DatasetDefinition<TInput, TDetails> | undefined {
    return this.#definitions.get(datasetKey(reference)) as
      | DatasetDefinition<TInput, TDetails>
      | undefined;
  }

  require<TInput = unknown, TDetails = unknown>(
    reference: DatasetReference,
  ): DatasetDefinition<TInput, TDetails> {
    const definition = this.get<TInput, TDetails>(reference);
    if (!definition) {
      throw new Error(`dataset ${reference.id}@${reference.version} is not registered`);
    }
    return definition;
  }

  list(): readonly DatasetReference[] {
    return [...this.#definitions.values()]
      .map(({ id, version }) => ({ id, version }))
      .sort((left, right) => datasetKey(left).localeCompare(datasetKey(right)));
  }

  evaluatorFor(reference: DatasetReference): EvaluatorReference {
    return this.require(reference).evaluation.evaluator;
  }
}

export const datasetRegistry = new DatasetRegistry();

export function registerDatasetDefinition<TInput, TDetails>(
  definition: DatasetDefinition<TInput, TDetails>,
): DatasetDefinition<TInput, TDetails> {
  return datasetRegistry.register(definition);
}

export const registerDataset = registerDatasetDefinition;

export function getRegisteredDatasetDefinition<
  TInput = unknown,
  TDetails = unknown,
>(
  reference: DatasetReference,
): DatasetDefinition<TInput, TDetails> | undefined {
  return datasetRegistry.get<TInput, TDetails>(reference);
}

export const getDataset = getRegisteredDatasetDefinition;

export function datasetKey(reference: DatasetReference): string {
  if (!reference || typeof reference !== 'object') {
    throw new TypeError('dataset reference must contain an id and version');
  }
  const id = datasetIdentifierSchema.parse(reference.id);
  const version = datasetSemanticVersionSchema.parse(reference.version);
  return `${id}\0${version}`;
}
