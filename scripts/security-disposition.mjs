import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REQUIRED_PLATFORMS = ['linux/amd64', 'linux/arm64'];
const REQUIRED_NPM_VERSION = '10.9.4';
const REQUIRED_TRIVY_VERSION = '0.76.0';
const SEVERITIES = new Set(['INFO', 'UNKNOWN', 'LOW', 'MEDIUM', 'MODERATE', 'HIGH', 'CRITICAL']);
const BLOCKING_SEVERITIES = new Set(['HIGH', 'CRITICAL']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isSha256(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isPackageUrl(value) {
  return typeof value === 'string'
    && /^pkg:[a-z][a-z0-9.+-]*\/[^?#*\s]+(?:\?[^#*\s]+)?(?:#\S+)?$/i.test(value);
}

function packageUrlVersion(value) {
  const core = value.split(/[?#]/, 1)[0];
  const at = core.lastIndexOf('@');
  if (at <= core.lastIndexOf('/')) return null;
  try {
    return decodeURIComponent(core.slice(at + 1));
  } catch {
    return undefined;
  }
}

function encodeNpmPurl(name, version) {
  const encodedName = name.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function readJson(repoPath) {
  try {
    return JSON.parse(readFileSync(path.resolve(repoPath), 'utf8'));
  } catch (error) {
    return { readError: `${repoPath}: ${error.message}` };
  }
}

export function validateSecurityExceptions(document, now = new Date()) {
  const errors = [];
  if (!isRecord(document) || document.schemaVersion !== 1 || !Array.isArray(document.exceptions)) {
    return ['Security exceptions must be an object with schemaVersion 1 and an exceptions array.'];
  }

  const seen = new Set();
  for (const [index, exception] of document.exceptions.entries()) {
    const prefix = `Exception ${index + 1}`;
    if (!isRecord(exception)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }

    const requiredStrings = [
      'scanner',
      'advisoryId',
      'componentPurl',
      'affectedVersion',
      'imageDigest',
      'owner',
      'rationaleAndExposure',
      'compensatingControl',
      'approvedBy',
      'approvedAt',
      'reviewedAt',
      'expiresAt',
      'evidenceUrl',
    ];
    for (const field of requiredStrings) {
      if (typeof exception[field] !== 'string' || exception[field].trim() === '') {
        errors.push(`${prefix} is missing ${field}.`);
      }
    }
    if (!['npm-audit', 'trivy'].includes(exception.scanner)) {
      errors.push(`${prefix} has an unsupported scanner.`);
    }
    if (typeof exception.advisoryId === 'string' && /[*?]/.test(exception.advisoryId)) {
      errors.push(`${prefix} uses a wildcard advisory ID.`);
    }
    if (typeof exception.componentPurl === 'string' && !isPackageUrl(exception.componentPurl)) {
      errors.push(prefix + ' must name one exact package URL without wildcards.');
    }
    if (typeof exception.componentPurl === 'string' && typeof exception.affectedVersion === 'string') {
      const purlVersion = packageUrlVersion(exception.componentPurl);
      if (purlVersion !== null && purlVersion !== exception.affectedVersion) {
        errors.push(prefix + ' package URL version does not match affectedVersion.');
      }
    }
    if (typeof exception.affectedVersion === 'string'
      && (/[?<>=~^*,|\s]/.test(exception.affectedVersion) || exception.affectedVersion.toLowerCase() === 'x')) {
      errors.push(`${prefix} must name one exact affected version without a range or wildcard.`);
    }
    if (!isSha256(exception.imageDigest)) {
      errors.push(`${prefix} must name one exact sha256 image-index digest.`);
    }
    if (!isTimestamp(exception.approvedAt) || !isTimestamp(exception.reviewedAt) || !isTimestamp(exception.expiresAt)) {
      errors.push(`${prefix} must include valid approval, review, and expiry timestamps.`);
    } else {
      const approvedAt = Date.parse(exception.approvedAt);
      const reviewedAt = Date.parse(exception.reviewedAt);
      const expiresAt = Date.parse(exception.expiresAt);
      if (approvedAt > reviewedAt || reviewedAt > now.getTime()) {
        errors.push(`${prefix} has approval/review dates in an invalid order.`);
      }
      if (expiresAt <= now.getTime()) {
        errors.push(`${prefix} has expired.`);
      }
    }
    try {
      const url = new URL(exception.evidenceUrl);
      if (url.protocol !== 'https:') errors.push(`${prefix} evidenceUrl must use HTTPS.`);
    } catch {
      errors.push(`${prefix} evidenceUrl must be a valid HTTPS URL.`);
    }

    const key = [exception.scanner, exception.advisoryId, exception.componentPurl,
      exception.affectedVersion, exception.imageDigest].join('|');
    if (seen.has(key)) errors.push(`${prefix} duplicates an existing exact exception.`);
    seen.add(key);
  }
  return errors;
}

function normalizeNpmAudit({ npm, report, packageLock, imageDigest }) {
  const errors = [];
  const findings = [];
  if (!isRecord(npm) || !['success', 'failure'].includes(npm.stepStatus)) {
    errors.push('npm audit did not complete successfully.');
  }
  if (!Number.isInteger(npm?.exitCode) || ![0, 1].includes(npm.exitCode)) {
    errors.push('npm audit returned an unavailable or unsupported exit code.');
  }
  if (!isTimestamp(npm?.startedAt) || !isTimestamp(npm?.completedAt)
    || Date.parse(npm.completedAt) < Date.parse(npm.startedAt)) {
    errors.push('npm audit observation timestamps are missing or invalid.');
  }
  if (npm?.npmVersion !== REQUIRED_NPM_VERSION) {
    errors.push('npm CLI version does not match the pinned version.');
  }
  if (typeof npm?.registry !== 'string' || npm.registry.trim() === '') {
    errors.push('npm registry is missing.');
  }
  if (!isRecord(report) || ![1, 2].includes(report.auditReportVersion)
    || !isRecord(report.vulnerabilities) || !isRecord(report.metadata?.vulnerabilities)) {
    errors.push('npm audit JSON is missing a supported report schema or vulnerability summary.');
    return { errors, findings, database: { status: 'unavailable' } };
  }
  if (report.error) errors.push('npm audit returned an error in its JSON report.');
  if (!isRecord(packageLock) || !isRecord(packageLock.packages)) {
    errors.push('package-lock.json does not contain the expected package inventory.');
    return { errors, findings, database: { status: 'unavailable' } };
  }

  const vulnerabilities = Object.entries(report.vulnerabilities);
  const vulnerabilityCounts = report.metadata.vulnerabilities;
  const total = vulnerabilityCounts.total;
  const severityNames = ['info', 'low', 'moderate', 'high', 'critical'];
  const severityCounts = severityNames.map((severity) => vulnerabilityCounts[severity]);
  if (!Number.isInteger(total) || total < 0
    || severityCounts.some((count) => !Number.isInteger(count) || count < 0)) {
    errors.push('npm audit vulnerability totals are missing or invalid.');
  }
  if ((total === 0) !== (vulnerabilities.length === 0)) {
    errors.push('npm audit summary and vulnerability details disagree.');
  }
  const lowOrAbove = ['low', 'moderate', 'high', 'critical']
    .some((severity) => vulnerabilityCounts[severity] > 0);
  if ((lowOrAbove && npm.exitCode !== 1) || (!lowOrAbove && npm.exitCode !== 0)) {
    errors.push('npm audit exit code and its JSON severity summary disagree.');
  }

  for (const [name, vulnerability] of vulnerabilities) {
    if (!isRecord(vulnerability) || typeof vulnerability.severity !== 'string'
      || !Array.isArray(vulnerability.nodes) || vulnerability.nodes.length === 0
      || !Array.isArray(vulnerability.via)) {
      errors.push(`npm audit details for ${name} are incomplete.`);
      continue;
    }
    const severity = vulnerability.severity.toUpperCase();
    if (!SEVERITIES.has(severity)) {
      errors.push(`npm audit reported an unsupported severity for ${name}.`);
      continue;
    }
    const advisories = vulnerability.via.filter((entry) => isRecord(entry) && entry.source !== undefined);
    if (advisories.length === 0) {
      errors.push(`npm audit did not identify an advisory ID for ${name}.`);
      continue;
    }
    for (const node of vulnerability.nodes) {
      const locked = packageLock.packages[node];
      if (typeof node !== 'string' || !isRecord(locked) || typeof locked.version !== 'string') {
        errors.push(`npm audit package ${name} cannot be joined to an exact lockfile version.`);
        continue;
      }
      for (const advisory of advisories) {
        const advisoryId = typeof advisory.source === 'number'
          ? `NPM-${advisory.source}`
          : String(advisory.source);
        const advisorySeverity = typeof advisory.severity === 'string'
          ? advisory.severity.toUpperCase()
          : severity;
        if (!SEVERITIES.has(advisorySeverity)) {
          errors.push(`npm advisory ${advisoryId} has an unsupported severity.`);
          continue;
        }
        findings.push({
          scanner: 'npm-audit',
          advisoryId,
          componentPurl: encodeNpmPurl(name, locked.version),
          affectedVersion: locked.version,
          severity: advisorySeverity === 'MODERATE' ? 'MEDIUM' : advisorySeverity,
          imageDigest,
          url: typeof advisory.url === 'string' ? advisory.url : null,
          title: typeof advisory.title === 'string' ? advisory.title : name,
        });
      }
    }
  }

  return {
    errors,
    findings,
    database: {
      source: 'configured npm registry audit API',
      reportSchemaVersion: report.auditReportVersion,
      version: null,
      updatedAt: null,
      observedAt: { startedAt: npm?.startedAt ?? null, completedAt: npm?.completedAt ?? null },
      note: 'npm audit JSON does not expose an upstream advisory database version or update timestamp.',
    },
  };
}

function normalizeTrivyTarget({ target, report, stepStatus, database, now }) {
  const errors = [];
  const findings = [];
  if (stepStatus !== 'success') errors.push(`Trivy did not complete for ${target?.platform ?? 'an unknown platform'}.`);
  if (!isRecord(report) || !Number.isInteger(report.SchemaVersion)
    || typeof report.ArtifactName !== 'string' || !isRecord(report.Metadata)
    || !Array.isArray(report.Results)) {
    errors.push(`Trivy JSON for ${target?.platform ?? 'an unknown platform'} is incomplete.`);
    return { errors, findings };
  }
  const [expectedOs, expectedArchitecture] = target.platform?.split('/') ?? [];
  const imageConfig = report.Metadata.ImageConfig;
  if (!isRecord(imageConfig)
    || imageConfig.os !== expectedOs
    || imageConfig.architecture !== expectedArchitecture) {
    errors.push(`Trivy image platform does not match ${target.platform}.`);
  }
  if (typeof target.imageRef !== 'string' || target.imageRef.trim() === '') {
    errors.push(`Trivy image reference is missing for ${target.platform}.`);
  }
  if (target.mode === 'published') {
    if (!isSha256(target.imageIndexDigest) || !isSha256(target.manifestDigest)) {
      errors.push('Published Trivy target is missing exact image digests for ' + target.platform + '.');
    } else {
      const expectedRef = 'ghcr.io/qa-test-automation-frameworks/quality-reference-application@' + target.manifestDigest;
      if (target.imageRef !== expectedRef) {
        errors.push('Published Trivy image reference does not match its child-manifest digest for ' + target.platform + '.');
      }
    }
  }
  for (const result of report.Results) {
    if (!isRecord(result)) {
      errors.push(`Trivy result section is malformed for ${target.platform}.`);
      continue;
    }
    const hasVulnerabilities = Object.hasOwn(result, 'Vulnerabilities');
    const hasEmptyPackageResult = ['os-pkgs', 'lang-pkgs'].includes(result.Class)
      && Array.isArray(result.Packages);
    if (!hasVulnerabilities && !hasEmptyPackageResult) {
      errors.push(`Trivy result section is malformed for ${target.platform}.`);
      continue;
    }
    const vulnerabilities = hasVulnerabilities ? result.Vulnerabilities ?? [] : [];
    if (!Array.isArray(vulnerabilities)) {
      errors.push(`Trivy vulnerability list is malformed for ${target.platform}.`);
      continue;
    }
    for (const vulnerability of vulnerabilities) {
      if (!isRecord(vulnerability) || typeof vulnerability.VulnerabilityID !== 'string'
        || typeof vulnerability.PkgName !== 'string' || typeof vulnerability.InstalledVersion !== 'string'
        || typeof vulnerability.Severity !== 'string') {
        errors.push(`Trivy finding is missing its advisory, package, version, or severity for ${target.platform}.`);
        continue;
      }
      const severity = vulnerability.Severity.toUpperCase();
      if (!SEVERITIES.has(severity)) {
        errors.push(`Trivy reported an unsupported severity for ${vulnerability.VulnerabilityID}.`);
        continue;
      }
      const purl = vulnerability.PkgIdentifier?.PURL;
      if (!isPackageUrl(purl)) {
        errors.push(`Trivy finding ${vulnerability.VulnerabilityID} has no package URL.`);
        continue;
      }
      findings.push({
        scanner: 'trivy',
        advisoryId: vulnerability.VulnerabilityID,
        componentPurl: purl,
        affectedVersion: vulnerability.InstalledVersion,
        severity: severity === 'MODERATE' ? 'MEDIUM' : severity,
        imageDigest: target.imageIndexDigest ?? null,
        platform: target.platform,
        platformManifestDigest: target.manifestDigest ?? null,
        url: typeof vulnerability.PrimaryURL === 'string' ? vulnerability.PrimaryURL : null,
        title: vulnerability.Title ?? vulnerability.PkgName,
      });
    }
  }
  if (database?.errors?.length) errors.push(...database.errors);
  if (database?.updatedAt && Date.parse(database.updatedAt) > now.getTime()) {
    errors.push('Trivy vulnerability database update timestamp is in the future.');
  }
  if (database?.nextUpdate && Date.parse(database.nextUpdate) < now.getTime()) {
    errors.push('Trivy vulnerability database is past its next-update time.');
  }
  return { errors, findings };
}

function parseTrivyDatabase(metadata) {
  const errors = [];
  if (!isRecord(metadata) || typeof metadata.Version !== 'string' || metadata.Version.trim() === ''
    || !isRecord(metadata.VulnerabilityDB)) {
    return { errors: ['Trivy version metadata does not include its vulnerability database record.'] };
  }
  const database = metadata.VulnerabilityDB;
  if (metadata.Version !== REQUIRED_TRIVY_VERSION) {
    errors.push('Trivy version does not match the pinned version.');
  }
  if (!Number.isInteger(database.Version) || database.Version < 1) {
    errors.push('Trivy vulnerability database version is missing or invalid.');
  }
  for (const field of ['UpdatedAt', 'NextUpdate', 'DownloadedAt']) {
    if (!isTimestamp(database[field])) errors.push('Trivy vulnerability database ' + field + ' is missing or invalid.');
  }
  if (isTimestamp(database.UpdatedAt) && isTimestamp(database.NextUpdate)
    && Date.parse(database.UpdatedAt) >= Date.parse(database.NextUpdate)) {
    errors.push('Trivy vulnerability database update and next-update timestamps are out of order.');
  }
  if (isTimestamp(database.UpdatedAt) && isTimestamp(database.DownloadedAt)
    && Date.parse(database.DownloadedAt) < Date.parse(database.UpdatedAt)) {
    errors.push('Trivy vulnerability database download predates its update timestamp.');
  }
  return {
    errors,
    toolVersion: metadata.Version,
    version: database.Version,
    updatedAt: database.UpdatedAt,
    nextUpdate: database.NextUpdate,
    downloadedAt: database.DownloadedAt,
  };
}

function findMatchingException(finding, exceptions) {
  if (!finding.imageDigest) return null;
  return exceptions.find((exception) => exception.scanner === finding.scanner
    && exception.advisoryId === finding.advisoryId
    && exception.componentPurl === finding.componentPurl
    && exception.affectedVersion === finding.affectedVersion
    && exception.imageDigest === finding.imageDigest) ?? null;
}

export function evaluateSecurityDisposition(input, now = new Date()) {
  const errors = [];
  const findings = [];
  if (!isRecord(input) || !/^[a-f0-9]{40}$/.test(input.sourceSha ?? '')) {
    errors.push('Source revision is missing or is not a full Git SHA.');
  }
  if (!isRecord(input?.target) || !['candidate', 'published'].includes(input.target.mode)) {
    errors.push('Image scan target mode is missing or unsupported.');
  }
  if (input?.target?.mode === 'published' && !isSha256(input.target.imageIndexDigest)) {
    errors.push('Published image index digest is missing or invalid.');
  }

  const exceptionsDocument = input?.exceptionsDocument;
  const exceptionErrors = validateSecurityExceptions(exceptionsDocument, now);
  errors.push(...exceptionErrors);

  const npmResult = normalizeNpmAudit({
    npm: input?.npm,
    report: input?.npmReport,
    packageLock: input?.packageLock,
    imageDigest: input?.target?.imageIndexDigest ?? null,
  });
  errors.push(...npmResult.errors);
  findings.push(...npmResult.findings);

  const trivyDatabase = parseTrivyDatabase(input?.trivyVersion);
  errors.push(...trivyDatabase.errors);
  const platformTargets = input?.target?.platforms;
  if (!isRecord(platformTargets)) {
    errors.push('Expected platform-specific image targets are missing.');
  } else {
    for (const platform of REQUIRED_PLATFORMS) {
      const entry = platformTargets[platform];
      if (!isRecord(entry)) {
        errors.push(`Missing Trivy target for ${platform}.`);
        continue;
      }
      const normalized = normalizeTrivyTarget({
        target: { ...entry, platform, mode: input.target.mode, imageIndexDigest: input.target.imageIndexDigest },
        report: entry.report,
        stepStatus: entry.stepStatus,
        database: trivyDatabase,
        now,
      });
      errors.push(...normalized.errors);
      findings.push(...normalized.findings);
    }
    for (const platform of Object.keys(platformTargets)) {
      if (!REQUIRED_PLATFORMS.includes(platform)) errors.push(`Unexpected Trivy platform ${platform}.`);
    }
  }

  const exceptions = exceptionsDocument?.exceptions ?? [];
  const dispositions = findings.map((finding) => {
    if (!BLOCKING_SEVERITIES.has(finding.severity)) {
      return { ...finding, disposition: 'triage', matchingException: null };
    }
    const exception = findMatchingException(finding, exceptions);
    if (exception) {
      return {
        ...finding,
        disposition: 'accepted-risk',
        matchingException: { owner: exception.owner, expiresAt: exception.expiresAt, evidenceUrl: exception.evidenceUrl },
      };
    }
    return { ...finding, disposition: 'blocked', matchingException: null };
  });

  const blockingFindings = dispositions.filter((finding) => finding.disposition === 'blocked');
  let disposition;
  if (errors.length > 0) disposition = 'unavailable';
  else if (blockingFindings.length > 0) disposition = 'blocked';
  else if (dispositions.some((finding) => finding.disposition === 'accepted-risk')) disposition = 'pass-with-accepted-risk';
  else if (dispositions.some((finding) => finding.disposition === 'triage')) disposition = 'pass-with-triage';
  else disposition = 'pass-no-findings';

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    sourceSha: input?.sourceSha ?? null,
    image: isRecord(input?.target) ? {
      mode: input.target.mode,
      imageIndexDigest: input.target.imageIndexDigest ?? null,
      platforms: Object.fromEntries(REQUIRED_PLATFORMS.map((platform) => {
        const target = input.target.platforms?.[platform] ?? {};
        return [platform, {
          imageRef: target.imageRef ?? null,
          manifestDigest: target.manifestDigest ?? null,
          stepStatus: target.stepStatus ?? null,
        }];
      })),
    } : null,
    disposition,
    npmAudit: {
      status: input?.npm?.stepStatus ?? 'missing',
      exitCode: input?.npm?.exitCode ?? null,
      version: input?.npm?.npmVersion ?? null,
      registry: input?.npm?.registry ?? null,
      startedAt: input?.npm?.startedAt ?? null,
      completedAt: input?.npm?.completedAt ?? null,
    },
    npmAdvisoryDatabase: npmResult.database,
    trivyDatabase: {
      toolVersion: trivyDatabase.toolVersion ?? null,
      version: trivyDatabase.version ?? null,
      updatedAt: trivyDatabase.updatedAt ?? null,
      nextUpdate: trivyDatabase.nextUpdate ?? null,
      downloadedAt: trivyDatabase.downloadedAt ?? null,
    },
    counts: {
      findings: dispositions.length,
      blocked: blockingFindings.length,
      acceptedRisk: dispositions.filter((finding) => finding.disposition === 'accepted-risk').length,
      triage: dispositions.filter((finding) => finding.disposition === 'triage').length,
      highOrCritical: dispositions.filter((finding) => BLOCKING_SEVERITIES.has(finding.severity)).length,
    },
    findings: dispositions,
    errors,
  };
}

export function loadInput(inputPath) {
  const manifest = readJson(inputPath);
  if (manifest.readError) return { manifest, errors: [manifest.readError] };
  const npmReport = readJson(manifest.npm?.reportPath ?? '');
  const packageLock = readJson(manifest.packageLockPath ?? 'package-lock.json');
  const exceptionsDocument = readJson(manifest.exceptionsPath ?? 'docs/security-exceptions.json');
  const trivyVersion = readJson(manifest.trivy?.versionPath ?? '');
  const platforms = {};
  for (const platform of REQUIRED_PLATFORMS) {
    const target = manifest.target?.platforms?.[platform] ?? {};
    platforms[platform] = {
      ...target,
      stepStatus: target.stepStatus,
      report: readJson(target.reportPath ?? ''),
    };
  }
  return {
    manifest,
    input: {
      sourceSha: manifest.sourceSha,
      target: { ...manifest.target, platforms },
      npm: manifest.npm,
      npmReport,
      packageLock,
      exceptionsDocument,
      trivyVersion,
    },
    errors: [],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    process.stderr.write('Usage: node scripts/security-disposition.mjs <scan-inputs.json> <summary.json>\n');
    process.exitCode = 2;
  } else {
    const loaded = loadInput(inputPath);
    const summary = evaluateSecurityDisposition(loaded.input ?? {}, new Date());
    summary.errors.push(...loaded.errors);
    if (loaded.errors.length > 0) summary.disposition = 'unavailable';
    writeFileSync(path.resolve(outputPath), `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ disposition: summary.disposition, counts: summary.counts, errors: summary.errors })}\n`);
    if (!summary.disposition.startsWith('pass-')) process.exitCode = 1;
  }
}
