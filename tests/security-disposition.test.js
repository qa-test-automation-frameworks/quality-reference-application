import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateSecurityDisposition, loadInput } from '../scripts/security-disposition.mjs';

const now = new Date('2026-10-22T12:00:00.000Z');
const imageDigest = `sha256:${'a'.repeat(64)}`;
const amd64Digest = `sha256:${'b'.repeat(64)}`;
const arm64Digest = `sha256:${'c'.repeat(64)}`;

function cleanTrivyReport(architecture) {
  return {
    SchemaVersion: 2,
    ArtifactName: `qra:${architecture}`,
    ArtifactType: 'container_image',
    Metadata: {
      OS: { Family: 'alpine', Name: '3.23' },
      ImageConfig: { os: 'linux', architecture },
    },
    Results: [{ Target: 'alpine', Type: 'alpine', Vulnerabilities: [] }],
  };
}

function cleanInput() {
  return {
    sourceSha: 'e'.repeat(40),
    target: {
      mode: 'published',
      imageIndexDigest: imageDigest,
      platforms: {
        'linux/amd64': {
          imageRef: `ghcr.io/qa-test-automation-frameworks/quality-reference-application@${amd64Digest}`,
          manifestDigest: amd64Digest,
          stepStatus: 'success',
          report: cleanTrivyReport('amd64'),
        },
        'linux/arm64': {
          imageRef: `ghcr.io/qa-test-automation-frameworks/quality-reference-application@${arm64Digest}`,
          manifestDigest: arm64Digest,
          stepStatus: 'success',
          report: cleanTrivyReport('arm64'),
        },
      },
    },
    npm: {
      stepStatus: 'success',
      exitCode: 0,
      startedAt: '2026-10-22T11:55:00.000Z',
      completedAt: '2026-10-22T11:55:02.000Z',
      npmVersion: '10.9.4',
      registry: 'https://registry.npmjs.org/',
    },
    npmReport: {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
    },
    packageLock: { lockfileVersion: 3, packages: {} },
    trivyVersion: {
      Version: '0.76.0',
      VulnerabilityDB: {
        Version: 2,
        UpdatedAt: '2026-10-22T08:00:00.000Z',
        NextUpdate: '2026-10-23T08:00:00.000Z',
        DownloadedAt: '2026-10-22T08:30:00.000Z',
      },
    },
    exceptionsDocument: { schemaVersion: 1, exceptions: [] },
  };
}

function npmHighFinding(input) {
  input.npm.exitCode = 1;
  input.npmReport = {
    auditReportVersion: 2,
    vulnerabilities: {
      pg: {
        name: 'pg',
        severity: 'high',
        via: [{ source: 54321, title: 'A high advisory', url: 'https://example.test/advisories/54321', severity: 'high' }],
        range: '<8.16.4',
        nodes: ['node_modules/pg'],
      },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
  };
  input.packageLock = { lockfileVersion: 3, packages: { 'node_modules/pg': { version: '8.16.3' } } };
  return input;
}

function exactNpmException(version = '8.16.3', expiresAt = '2026-11-22T00:00:00.000Z') {
  return {
    scanner: 'npm-audit',
    advisoryId: 'NPM-54321',
    componentPurl: `pkg:npm/pg@${version}`,
    affectedVersion: version,
    imageDigest,
    owner: 'prayagv',
    rationaleAndExposure: 'Recorded owner rationale for this exact release target.',
    compensatingControl: 'Recorded compensating control for this exact release target.',
    approvedBy: 'prayagv',
    approvedAt: '2026-10-20T00:00:00.000Z',
    reviewedAt: '2026-10-21T00:00:00.000Z',
    expiresAt,
    evidenceUrl: 'https://github.com/qa-test-automation-frameworks/quality-reference-application/issues/1',
  };
}

test('the manifest loader and evaluator read a complete clean scanner bundle', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'qra-security-disposition-'));
  const writeJson = (name, value) => {
    const filePath = path.join(directory, name);
    writeFileSync(filePath, JSON.stringify(value));
    return filePath;
  };
  try {
    const input = cleanInput();
    const platforms = {};
    for (const [platform, target] of Object.entries(input.target.platforms)) {
      platforms[platform] = {
        imageRef: target.imageRef,
        manifestDigest: target.manifestDigest,
        stepStatus: target.stepStatus,
        reportPath: writeJson(platform.replace('/', '-') + '.json', target.report),
      };
    }
    const manifest = {
      sourceSha: input.sourceSha,
      target: { ...input.target, platforms },
      npm: { ...input.npm, reportPath: writeJson('npm.json', input.npmReport) },
      packageLockPath: writeJson('package-lock.json', input.packageLock),
      exceptionsPath: writeJson('exceptions.json', input.exceptionsDocument),
      trivy: { versionPath: writeJson('trivy-version.json', input.trivyVersion) },
    };
    const inputPath = writeJson('manifest.json', manifest);
    const loaded = loadInput(inputPath);
    assert.deepEqual(loaded.errors, []);
    assert.equal(evaluateSecurityDisposition(loaded.input, now).disposition, 'pass-no-findings');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a clean, complete two-platform scan passes without claiming more than its evidence', () => {
  const result = evaluateSecurityDisposition(cleanInput(), now);
  assert.equal(result.disposition, 'pass-no-findings');
  assert.deepEqual(result.counts, { findings: 0, blocked: 0, acceptedRisk: 0, triage: 0, highOrCritical: 0 });
  assert.equal(result.trivyDatabase.version, 2);
  assert.equal(result.npmAudit.status, 'success');
  assert.equal(result.image.platforms['linux/amd64'].report, undefined);
  assert.equal(result.npmAdvisoryDatabase.version, null);
});

test('an unexcepted high production dependency advisory blocks the image', () => {
  const result = evaluateSecurityDisposition(npmHighFinding(cleanInput()), now);
  assert.equal(result.disposition, 'blocked');
  assert.equal(result.counts.blocked, 1);
  assert.equal(result.findings[0].componentPurl, 'pkg:npm/pg@8.16.3');
});

test('an exact, unexpired owner-reviewed exception accepts only that exact image and package version', () => {
  const input = npmHighFinding(cleanInput());
  input.exceptionsDocument.exceptions = [exactNpmException()];
  const result = evaluateSecurityDisposition(input, now);
  assert.equal(result.disposition, 'pass-with-accepted-risk');
  assert.equal(result.counts.acceptedRisk, 1);
  assert.equal(result.findings[0].disposition, 'accepted-risk');
});

test('an exact Trivy exception accepts one exact published image and advisory', () => {
  const input = cleanInput();
  const finding = {
    VulnerabilityID: 'CVE-2026-23456',
    PkgName: 'openssl',
    InstalledVersion: '3.3.2-r0',
    PkgIdentifier: { PURL: 'pkg:apk/alpine/openssl@3.3.2-r0?arch=x86_64&distro=alpine-3.23.0' },
    Severity: 'CRITICAL',
    PrimaryURL: 'https://example.test/CVE-2026-23456',
  };
  input.target.platforms['linux/amd64'].report.Results[0].Vulnerabilities = [finding];
  const exception = {
    scanner: 'trivy',
    advisoryId: finding.VulnerabilityID,
    componentPurl: finding.PkgIdentifier.PURL,
    affectedVersion: finding.InstalledVersion,
    imageDigest,
    owner: 'prayagv',
    rationaleAndExposure: 'Synthetic fixture only; this does not approve a real finding.',
    compensatingControl: 'Synthetic fixture control.',
    approvedBy: 'prayagv',
    approvedAt: '2026-10-20T00:00:00.000Z',
    reviewedAt: '2026-10-21T00:00:00.000Z',
    expiresAt: '2026-11-22T00:00:00.000Z',
    evidenceUrl: 'https://github.com/qa-test-automation-frameworks/quality-reference-application/issues/1',
  };
  input.exceptionsDocument.exceptions = [exception];
  assert.equal(evaluateSecurityDisposition(input, now).disposition, 'pass-with-accepted-risk');

  input.exceptionsDocument.exceptions[0].advisoryId = 'CVE-2026-99999';
  assert.equal(evaluateSecurityDisposition(input, now).disposition, 'blocked');
});

test('a version-mismatched exception does not suppress a high finding', () => {
  const input = npmHighFinding(cleanInput());
  input.exceptionsDocument.exceptions = [exactNpmException('8.16.4')];
  const result = evaluateSecurityDisposition(input, now);
  assert.equal(result.disposition, 'blocked');
});

test('malformed package URLs and package URL version mismatches fail closed', () => {
  const malformed = cleanInput();
  malformed.exceptionsDocument.exceptions = [{ ...exactNpmException(), componentPurl: 'pkg:malformed' }];
  assert.equal(evaluateSecurityDisposition(malformed, now).disposition, 'unavailable');

  const mismatched = cleanInput();
  mismatched.exceptionsDocument.exceptions = [{
    ...exactNpmException(),
    componentPurl: 'pkg:npm/pg@8.16.4',
  }];
  assert.equal(evaluateSecurityDisposition(mismatched, now).disposition, 'unavailable');
});

test('expired exceptions fail the policy instead of suppressing a finding', () => {
  const input = npmHighFinding(cleanInput());
  input.exceptionsDocument.exceptions = [exactNpmException('8.16.3', '2026-10-21T00:00:00.000Z')];
  const result = evaluateSecurityDisposition(input, now);
  assert.equal(result.disposition, 'unavailable');
  assert.ok(result.errors.some((error) => error.includes('expired')));
});

test('malformed or wildcard exceptions fail closed', () => {
  const input = cleanInput();
  input.exceptionsDocument.exceptions = [{ ...exactNpmException(), affectedVersion: '8.*' }];
  const result = evaluateSecurityDisposition(input, now);
  assert.equal(result.disposition, 'unavailable');
  assert.ok(result.errors.some((error) => error.includes('exact affected version')));
});

test('npm info findings remain visible as triage when the low threshold exits successfully', () => {
  const input = cleanInput();
  input.npmReport = {
    auditReportVersion: 2,
    vulnerabilities: {
      zod: {
        name: 'zod',
        severity: 'info',
        via: [{ source: 'INFO-123', severity: 'info', title: 'Informational advisory' }],
        range: '*',
        nodes: ['node_modules/zod'],
      },
    },
    metadata: { vulnerabilities: { info: 1, low: 0, moderate: 0, high: 0, critical: 0, total: 1 } },
  };
  input.packageLock = { lockfileVersion: 3, packages: { 'node_modules/zod': { version: '4.1.0' } } };
  const result = evaluateSecurityDisposition(input, now);
  assert.equal(result.disposition, 'pass-with-triage');
  assert.equal(result.findings[0].severity, 'INFO');
});

test('a published child digest must match the scanner image reference', () => {
  const input = cleanInput();
  input.target.platforms['linux/amd64'].imageRef =
    'ghcr.io/qa-test-automation-frameworks/quality-reference-application@' + arm64Digest;
  const result = evaluateSecurityDisposition(input, now);
  assert.equal(result.disposition, 'unavailable');
  assert.ok(result.errors.some((error) => error.includes('does not match its child-manifest digest')));
});

test('Trivy image platform must match the requested operating system and architecture', () => {
  const input = cleanInput();
  input.target.platforms['linux/amd64'].report.Metadata.ImageConfig.architecture = 'arm64';
  const result = evaluateSecurityDisposition(input, now);
  assert.equal(result.disposition, 'unavailable');
  assert.ok(result.errors.some((error) => error.includes('image platform does not match linux/amd64')));
});

test('an empty Trivy package result may omit its vulnerability list', () => {
  const input = cleanInput();
  for (const target of Object.values(input.target.platforms)) {
    target.report.Results.push({ Target: 'Node.js', Class: 'lang-pkgs', Type: 'npm', Packages: [] });
  }
  const result = evaluateSecurityDisposition(input, now);
  assert.equal(result.disposition, 'pass');
  assert.deepEqual(result.findings, []);
});

test('a Trivy result without vulnerabilities or package metadata stays unavailable', () => {
  const input = cleanInput();
  input.target.platforms['linux/amd64'].report.Results.push({ Target: 'Node.js', Class: 'lang-pkgs' });
  const result = evaluateSecurityDisposition(input, now);
  assert.equal(result.disposition, 'unavailable');
  assert.ok(result.errors.some((error) => error.includes('result section is malformed')));
});

test('a truncated npm report or mismatched npm exit code is unavailable, not clean', () => {
  const truncated = cleanInput();
  truncated.npmReport = { readError: 'Unexpected end of JSON input' };
  assert.equal(evaluateSecurityDisposition(truncated, now).disposition, 'unavailable');

  const inconsistent = cleanInput();
  inconsistent.npm.exitCode = 1;
  assert.equal(evaluateSecurityDisposition(inconsistent, now).disposition, 'unavailable');
});

test('a missing or stale Trivy database record makes the scan unavailable', () => {
  const missing = cleanInput();
  missing.trivyVersion = { Version: '0.76.0' };
  assert.equal(evaluateSecurityDisposition(missing, now).disposition, 'unavailable');

  const missingVersion = cleanInput();
  delete missingVersion.trivyVersion.VulnerabilityDB.Version;
  assert.equal(evaluateSecurityDisposition(missingVersion, now).disposition, 'unavailable');

  const stale = cleanInput();
  stale.trivyVersion.VulnerabilityDB.NextUpdate = '2026-10-22T11:00:00.000Z';
  assert.equal(evaluateSecurityDisposition(stale, now).disposition, 'unavailable');
});

test('scanner versions must match the pinned npm and Trivy tools', () => {
  const wrongTrivy = cleanInput();
  wrongTrivy.trivyVersion.Version = '0.77.0';
  assert.equal(evaluateSecurityDisposition(wrongTrivy, now).disposition, 'unavailable');

  const wrongNpm = cleanInput();
  wrongNpm.npm.npmVersion = '10.9.5';
  assert.equal(evaluateSecurityDisposition(wrongNpm, now).disposition, 'unavailable');
});

test('medium findings stay visible with an explicit triage disposition', () => {
  const input = cleanInput();
  input.target.platforms['linux/amd64'].report.Results[0].Vulnerabilities = [{
    VulnerabilityID: 'CVE-2026-12345',
    PkgName: 'busybox',
    InstalledVersion: '1.37.0-r12',
    PkgIdentifier: { PURL: 'pkg:apk/alpine/busybox@1.37.0-r12?arch=x86_64&distro=alpine-3.23.0' },
    Severity: 'MEDIUM',
    PrimaryURL: 'https://example.test/CVE-2026-12345',
  }];
  const result = evaluateSecurityDisposition(input, now);
  assert.equal(result.disposition, 'pass-with-triage');
  assert.equal(result.findings[0].disposition, 'triage');
});

test('provenance by itself cannot satisfy a missing advisory scan', () => {
  const input = { provenance: { verified: true } };
  const result = evaluateSecurityDisposition(input, now);
  assert.equal(result.disposition, 'unavailable');
  assert.ok(result.errors.length > 0);
});
