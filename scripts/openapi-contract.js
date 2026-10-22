import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parseDocument } from 'yaml';

const REQUIRED_OPERATIONS = {
  '/health/ready': { get: ['200', '503'] },
  '/api/v1/sessions': { post: ['201', '404', '422'] },
  '/api/v1/policies': { get: ['200', '401'] },
  '/api/v1/policies/{policyId}': { get: ['200', '401', '404'] },
  '/api/v1/claims': { get: ['200', '401'], post: ['201', '401', '404', '422'] },
  '/api/v1/claims/{claimId}': {
    get: ['200', '401', '404'],
    patch: ['200', '401', '403', '404', '409', '422'],
  },
  '/api/v1/claims/{claimId}/events': { get: ['200', '401', '404'] },
  '/api/v2/policies': { get: ['200', '401'] },
  '/api/v2/policies/{policyId}': { get: ['200', '401', '404'] },
  '/api/v2/claims': { get: ['200', '401'], post: ['201', '401', '404', '422'] },
  '/api/v2/claims/{claimId}': {
    get: ['200', '401', '404'],
    patch: ['200', '401', '403', '404', '409', '422'],
  },
  '/api/v2/claims/{claimId}/events': { get: ['200', '401', '404'] },
  '/__test/seed': { post: ['200', '403', '404'] },
  '/__test/reset': { post: ['200', '403', '404'] },
};

const FIXTURE_RESPONSES = {
  session: ['/api/v1/sessions', 'post', '201'],
  policyList: ['/api/v2/policies', 'get', '200'],
  claimCreate: ['/api/v2/claims', 'post', '201'],
  eventList: ['/api/v2/claims/{claimId}/events', 'get', '200'],
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireContract(condition, message) {
  if (!condition) throw new Error(message);
}

function resolvePointer(root, reference, context) {
  requireContract(typeof reference === 'string' && (reference === '#' || reference.startsWith('#/')),
    `${context} must use a local JSON Pointer reference: ${String(reference)}`);
  if (reference === '#') return root;

  let decoded;
  try {
    decoded = decodeURIComponent(reference.slice(1));
  } catch {
    throw new Error(`${context} has an invalid local reference: ${reference}`);
  }

  let current = root;
  for (const rawSegment of decoded.slice(1).split('/')) {
    requireContract(!/~(?![01])/.test(rawSegment), `${context} has an invalid JSON Pointer escape: ${reference}`);
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current) && /^(0|[1-9]\d*)$/.test(segment)) {
      const index = Number(segment);
      requireContract(index < current.length, `${context} points to a missing local reference: ${reference}`);
      current = current[index];
    } else if (isRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      throw new Error(`${context} points to a missing local reference: ${reference}`);
    }
  }
  return current;
}

function rejectExternalOrMissingReferences(document) {
  const visited = new WeakSet();
  const visit = (value, location = 'document') => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${location}[${index}]`));
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      const childLocation = `${location}.${key}`;
      if (key === '$ref') resolvePointer(document, child, childLocation);
      else visit(child, childLocation);
    }
  };
  visit(document);
}

export function parseOpenApiDocument(source, sourceName = 'OpenAPI document') {
  const parsed = parseDocument(source, { prettyErrors: true, stringKeys: true, uniqueKeys: true });
  if (parsed.errors.length > 0) {
    const messages = parsed.errors.map((error) => error.message).join('; ');
    throw new Error(`${sourceName} YAML is invalid: ${messages}`);
  }
  requireContract(parsed.contents !== null, `${sourceName} is empty`);

  const document = parsed.toJS();
  requireContract(isRecord(document), `${sourceName} must be a YAML object`);
  rejectExternalOrMissingReferences(document);
  return document;
}

function operationAt(document, path, method) {
  const pathItem = document.paths?.[path];
  requireContract(isRecord(pathItem), `Required OpenAPI path is missing: ${path}`);
  const operation = pathItem[method];
  requireContract(isRecord(operation), `Required OpenAPI operation is missing: ${method.toUpperCase()} ${path}`);
  return operation;
}

function jsonSchemaAt(document, schema) {
  requireContract(isRecord(schema), 'Expected an OpenAPI JSON Schema object');
  const normalized = structuredClone(schema);
  const definitions = structuredClone(document.components?.schemas ?? {});

  const rewriteReferences = (value) => {
    if (Array.isArray(value)) {
      value.forEach(rewriteReferences);
      return;
    }
    if (!isRecord(value)) return;

    if (Object.hasOwn(value, '$ref')) {
      const prefix = '#/components/schemas/';
      requireContract(typeof value.$ref === 'string' && value.$ref.startsWith(prefix),
        `Fixture schema reference is not a component schema: ${String(value.$ref)}`);
      const name = value.$ref.slice(prefix.length);
      requireContract(Object.hasOwn(definitions, name), `Fixture schema reference is missing: ${value.$ref}`);
      value.$ref = `#/$defs/${name}`;
    }

    Object.values(value).forEach(rewriteReferences);
  };

  rewriteReferences(normalized);
  rewriteReferences(definitions);
  return {
    ...normalized,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: { ...(normalized.$defs ?? {}), ...definitions },
  };
}

function compileFixtureValidator(document, schema, name) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  let compiled;
  try {
    compiled = ajv.compile(jsonSchemaAt(document, schema));
  } catch (error) {
    throw new Error(`${name} response schema is invalid: ${error.message}`, { cause: error });
  }

  return (value) => {
    const valid = compiled(value);
    return {
      valid,
      errors: (compiled.errors ?? []).map((error) => ({
        instancePath: error.instancePath,
        keyword: error.keyword,
        message: error.message,
        params: error.params,
      })),
    };
  };
}

function responseSchema(document, path, method, status) {
  const operation = operationAt(document, path, method);
  const response = operation.responses?.[status];
  requireContract(isRecord(response), `Required response is missing: ${method.toUpperCase()} ${path} ${status}`);
  const schema = response.content?.['application/json']?.schema;
  requireContract(isRecord(schema), `JSON response schema is missing: ${method.toUpperCase()} ${path} ${status}`);
  return schema;
}

function requestSchema(document, path, method) {
  const schema = operationAt(document, path, method).requestBody?.content?.['application/json']?.schema;
  requireContract(isRecord(schema), `JSON request schema is missing: ${method.toUpperCase()} ${path}`);
  return schema;
}

function assertIntegerAmount(schema, maximum, context) {
  const amount = schema.properties?.amountMinor;
  requireContract(Array.isArray(schema.required) && schema.required.includes('amountMinor'),
    `${context} must require amountMinor`);
  requireContract(isRecord(amount) && amount.type === 'integer', `${context} amountMinor must be an integer`);
  requireContract(amount.maximum === maximum, `${context} amountMinor maximum must be ${maximum}`);
}

function assertRequiredInteger(schema, field, context) {
  const property = schema.properties?.[field];
  requireContract(Array.isArray(schema.required) && schema.required.includes(field),
    `${context} must require ${field}`);
  requireContract(isRecord(property) && property.type === 'integer', `${context} ${field} must be an integer`);
}

function assertStableErrorEnvelope(document) {
  const error = document.components?.schemas?.Error;
  requireContract(isRecord(error) && error.type === 'object', 'Error response schema must be an object');
  requireContract(Array.isArray(error.required) && error.required.includes('error'),
    'Error response schema must require the error envelope');
  const envelope = error.properties?.error;
  requireContract(isRecord(envelope) && envelope.type === 'object', 'Error envelope must be an object');
  for (const field of ['code', 'message', 'correlationId']) {
    requireContract(envelope.required?.includes(field), `Error envelope must require ${field}`);
  }
  requireContract(envelope.properties?.code?.type === 'string', 'Error code must be a string');
  requireContract(envelope.properties?.correlationId?.type === 'string'
    && envelope.properties?.correlationId?.format === 'uuid', 'Error correlationId must be a UUID string');
  for (const stableCode of ['INVALID_TRANSITION', 'VERSION_CONFLICT']) {
    requireContract(envelope.properties?.code?.enum?.includes(stableCode),
      `Error code enum must include ${stableCode}`);
  }
}

export function checkOpenApiDocument(document) {
  requireContract(isRecord(document) && document.openapi === '3.1.0', 'OpenAPI version must be 3.1.0');
  rejectExternalOrMissingReferences(document);

  for (const [path, methods] of Object.entries(REQUIRED_OPERATIONS)) {
    for (const [method, statuses] of Object.entries(methods)) {
      const operation = operationAt(document, path, method);
      requireContract(typeof operation.operationId === 'string' && operation.operationId.trim().length > 0,
        `Operation ID is required: ${method.toUpperCase()} ${path}`);
      const responses = operation.responses;
      requireContract(isRecord(responses), `Responses are required: ${method.toUpperCase()} ${path}`);
      for (const status of statuses) {
        requireContract(Object.hasOwn(responses, status),
          `Required response is missing: ${method.toUpperCase()} ${path} ${status}`);
      }
    }
  }

  assertIntegerAmount(requestSchema(document, '/api/v1/claims', 'post'), 1000000, 'POST /api/v1/claims');
  assertIntegerAmount(requestSchema(document, '/api/v2/claims', 'post'), 500000, 'POST /api/v2/claims');
  assertIntegerAmount(document.components?.schemas?.Claim, 1000000, 'Claim response');
  assertIntegerAmount(document.components?.schemas?.ClaimV2, 500000, 'ClaimV2 response');

  for (const [path, label] of [
    ['/api/v1/claims/{claimId}', 'PATCH /api/v1/claims/{claimId}'],
    ['/api/v2/claims/{claimId}', 'PATCH /api/v2/claims/{claimId}'],
  ]) {
    assertRequiredInteger(requestSchema(document, path, 'patch'), 'expectedVersion', label);
  }
  assertStableErrorEnvelope(document);

  const validators = Object.fromEntries(Object.entries(FIXTURE_RESPONSES).map(([name, [path, method, status]]) => [
    name,
    compileFixtureValidator(document, responseSchema(document, path, method, status), name),
  ]));
  validators.error = compileFixtureValidator(document, document.components?.schemas?.Error, 'error');

  return {
    validateFixture(name, value) {
      const validator = validators[name];
      requireContract(typeof validator === 'function', `Unknown OpenAPI fixture: ${name}`);
      return validator(value);
    },
    fixtureNames: Object.keys(validators),
  };
}
