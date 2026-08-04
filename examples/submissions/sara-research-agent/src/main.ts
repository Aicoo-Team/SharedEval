import { servePactAdapterV1 } from '../../../../src/adapter-host/v1/index.js';
import { TypeScriptBasicAdapter } from './adapter.js';

await servePactAdapterV1(new TypeScriptBasicAdapter());
