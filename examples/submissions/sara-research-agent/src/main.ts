import { servePactAdapterV1 } from '../../../../src/adapter-host/v1/index.js';
import { SaraResearchAdapter } from './adapter.js';

await servePactAdapterV1(new SaraResearchAdapter());
