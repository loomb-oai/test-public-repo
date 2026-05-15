import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, resolve } from "node:path";

const repoRoot = process.env.GITHUB_WORKSPACE ?? process.cwd();
const mode = process.env.SDK_RELEASE_MODE;
const explicitVersion = process.env.SDK_RELEASE_VERSION ?? "";
const explicitReleaseTag = process.env.SDK_RELEASE_RELEASE_TAG ?? "";
const configPath = resolve(repoRoot, process.env.SDK_RELEASE_CONFIG ?? "sdk-release.config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const releaseDir = resolve(repoRoot, ".sdk-release");
const releaseFile = resolve(releaseDir, "release.json");
const distDir = resolve(repoRoot, "dist");
const publicToken = process.env.SDK_RELEASE_PUBLIC_REPO_TOKEN ?? "";
const privateToken = process.env.SDK_RELEASE_PRIVATE_REPO_TOKEN ?? "";
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
const outputFile = process.env.GITHUB_OUTPUT;
const githubRefName = process.env.GITHUB_REF_NAME ?? "";
const githubSha = process.env.GITHUB_SHA ?? git(["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const supportedModes = new Set([
  "prepare",
  "publish",
  "alpha",
  "beta",
  "cut-rc",
  "refresh-rc",
  "final",
  "registry-publish"
]);

if (!supportedModes.has(mode)) {
  throw new Error(`Unsupported mode: ${mode}`);
}

switch (mode) {
  case "prepare":
    prepareRelease(explicitVersion);
    break;
  case "publish":
    publishPreparedRelease();
    break;
  case "alpha":
    runEphemeralChannel("alpha");
    break;
  case "beta":
    runEphemeralChannel("beta");
    break;
  case "cut-rc":
    cutRcRelease();
    break;
  case "refresh-rc":
    refreshRcRelease();
    break;
  case "final":
    finalizeRcRelease();
    break;
  case "registry-publish":
    publishTaggedReleaseToRegistries();
    break;
}

function prepareRelease(version) {
  assertSemver(version);
  mkdirSync(releaseDir, { recursive: true });

  updatePackageVersions(version, version);
  updateChangelog(version, formatTag(version), "release");

  const releaseMetadata = buildReleaseMetadata({
    channel: "production",
    baseVersion: version,
    npmVersion: version,
    pypiVersion: version,
    tag: formatTag(version),
    sourceBranch: "main",
    note: "Prepared by the sample release PR flow."
  });

  writeReleaseMetadata(releaseMetadata);
  exposeRelease(releaseMetadata);
  writeSummary([
    "# Release prepared",
    "",
    `- Version: \`${version}\``,
    `- Tag: \`${releaseMetadata.tag}\``,
    `- Metadata: \`.sdk-release/release.json\``,
    "",
    "The workflow will commit these changes to a release branch and open a PR."
  ]);
}

function publishPreparedRelease() {
  const metadata = readReleaseMetadata();
  publishFromMetadata(metadata);
}

function runEphemeralChannel(channel) {
  const baseVersion = resolveNextBaseVersion();
  const date = dateStamp();
  const sequence = channel === "alpha" ? nextAlphaSequence(baseVersion, date) : null;
  const tag = renderChannelTag(channel, {
    version: baseVersion,
    date,
    sequence
  });
  const npmVersion = tag.replace(/^v/, "");
  const pypiVersion = toPyPiVersion(channel, baseVersion, {
    date,
    sequence
  });

  if (channel === "beta" && config.channels.beta.onlyIfChanged && !hasChangesSinceLastBeta()) {
    writeSummary([
      "# Beta skipped",
      "",
      "No repository changes were found since the most recent beta tag."
    ]);
    setOutput("release-skipped", "true");
    return;
  }

  updatePackageVersions(npmVersion, pypiVersion);
  const metadata = buildReleaseMetadata({
    channel,
    baseVersion,
    npmVersion,
    pypiVersion,
    tag,
    sourceBranch: config.channels[channel].sourceBranch,
    note: channel === "alpha" ? "Manual alpha build." : "Scheduled end-of-day beta build."
  });
  writeReleaseMetadata(metadata);
  publishFromMetadata(metadata);
}

function cutRcRelease() {
  const baseVersion = resolveNextBaseVersion();
  const rcBranch = renderPattern(config.channels.rc.branchPattern, {
    version: baseVersion
  });
  const tag = renderChannelTag("rc", {
    version: baseVersion,
    iteration: 1
  });
  const npmVersion = tag.replace(/^v/, "");
  const pypiVersion = toPyPiVersion("rc", baseVersion, { iteration: 1 });

  createOrRefreshRcBranch(rcBranch);
  updatePackageVersions(npmVersion, pypiVersion);
  updateChangelog(baseVersion, tag, "rc");

  const metadata = buildReleaseMetadata({
    channel: "rc",
    baseVersion,
    npmVersion,
    pypiVersion,
    tag,
    sourceBranch: rcBranch,
    rcBranch,
    iteration: 1,
    note: "Weekly RC branch cut."
  });

  writeReleaseMetadata(metadata);
  commitAndPushWorkingTree(`chore(rc): prepare ${tag}`, rcBranch);
  publishFromMetadata(metadata);
}

function refreshRcRelease() {
  const rcBranch = githubRefName || currentBranch();
  const baseVersion = parseRcBranchVersion(rcBranch);
  const iteration = nextRcIteration(baseVersion);
  const tag = renderChannelTag("rc", {
    version: baseVersion,
    iteration
  });
  const npmVersion = tag.replace(/^v/, "");
  const pypiVersion = toPyPiVersion("rc", baseVersion, { iteration });

  updatePackageVersions(npmVersion, pypiVersion);
  const metadata = buildReleaseMetadata({
    channel: "rc",
    baseVersion,
    npmVersion,
    pypiVersion,
    tag,
    sourceBranch: rcBranch,
    rcBranch,
    iteration,
    note: "RC refresh after a cherry-pick or branch update."
  });

  writeReleaseMetadata(metadata);
  commitAndPushWorkingTree(`chore(rc): refresh ${tag}`, rcBranch);
  publishFromMetadata(metadata);
}

function finalizeRcRelease() {
  const rcBranch = githubRefName || currentBranch();
  const baseVersion = parseRcBranchVersion(rcBranch);
  const tag = renderChannelTag("production", {
    version: baseVersion
  });

  updatePackageVersions(baseVersion, baseVersion);
  updateChangelog(baseVersion, tag, "production");

  const metadata = buildReleaseMetadata({
    channel: "production",
    baseVersion,
    npmVersion: baseVersion,
    pypiVersion: baseVersion,
    tag,
    sourceBranch: rcBranch,
    rcBranch,
    note: "Final production release from the baked RC branch."
  });

  writeReleaseMetadata(metadata);
  commitAndPushWorkingTree(`chore(release): finalize ${tag}`, rcBranch);
  publishFromMetadata(metadata);
}

function publishTaggedReleaseToRegistries() {
  if (!explicitReleaseTag) {
    throw new Error("registry-publish mode requires SDK_RELEASE_RELEASE_TAG.");
  }

  const metadata = releaseMetadataFromTag(explicitReleaseTag);
  updatePackageVersions(metadata.npmVersion, metadata.pypiVersion);
  publishFromMetadata(metadata, {
    mirrorPublicRelease: false,
    summaryTitle: "Public registry publish modeled"
  });
}

function publishFromMetadata(metadata, {
  mirrorPublicRelease = true,
  summaryTitle = `${titleCase(metadata.channel)} release modeled`
} = {}) {
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(resolve(distDir, "npm"), { recursive: true });
  mkdirSync(resolve(distDir, "pypi"), { recursive: true });

  const nodeArtifact = buildNodeArtifact();
  const pythonArtifacts = buildPythonArtifacts();
  const manifestPath = writeReleaseManifest({
    metadata,
    nodeArtifact,
    pythonArtifacts
  });

  const publicResult = mirrorPublicRelease
    ? mirrorAndCreatePublicRelease({
        metadata,
        nodeArtifact,
        pythonArtifacts,
        manifestPath
      })
    : {};

  exposeRelease(metadata, publicResult.releaseUrl ?? "");
  writeSummary([
    `# ${summaryTitle}`,
    "",
    `- Base version: \`${metadata.baseVersion}\``,
    `- Tag: \`${metadata.tag}\``,
    `- npm version: \`${metadata.npmVersion}\``,
    `- PyPI version: \`${metadata.pypiVersion}\``,
    `- npm artifact: \`${relativeToRepo(nodeArtifact)}\``,
    `- PyPI artifacts: ${pythonArtifacts.map((artifact) => `\`${relativeToRepo(artifact)}\``).join(", ")}`,
    `- npm publish model: Trusted Publisher OIDC with dist-tag \`${npmDistTag(metadata.channel)}\``,
    "- PyPI publish model: Trusted Publisher OIDC via `pypa/gh-action-pypi-publish@release/v1`",
    mirrorPublicRelease
      ? `- Repository sync: \`${config.publicRepositoryStrategy}\``
      : "- Repository sync: already completed before the public release event",
    mirrorPublicRelease
      ? publicResult.releaseUrl
        ? `- Public GitHub Release: ${publicResult.releaseUrl}`
        : "- Public GitHub Release: skipped"
      : `- Publish surface: \`${config.publicRepository}\` release event`
  ]);
}

function updatePackageVersions(npmVersion, pypiVersion) {
  updateNodeVersion(npmVersion);
  updatePythonVersion(pypiVersion);
}

function updateNodeVersion(version) {
  const packageJsonPath = resolve(repoRoot, config.packages.npm.path, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  packageJson.version = version;
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

function updatePythonVersion(version) {
  const pyprojectPath = resolve(repoRoot, config.packages.pypi.path, "pyproject.toml");
  const initPath = resolve(repoRoot, config.packages.pypi.path, "src/demo_python_sdk/__init__.py");

  const pyproject = readFileSync(pyprojectPath, "utf8").replace(
    /^version = ".*"$/m,
    `version = "${version}"`
  );
  writeFileSync(pyprojectPath, pyproject, "utf8");

  const initFile = readFileSync(initPath, "utf8").replace(
    /^__version__ = ".*"$/m,
    `__version__ = "${version}"`
  );
  writeFileSync(initPath, initFile, "utf8");
}

function updateChangelog(baseVersion, tag, channel) {
  const changelogPath = resolve(repoRoot, "CHANGELOG.md");
  const current = readFileSync(changelogPath, "utf8");
  const date = isoDate();
  const section = [
    `## ${tag} - ${date}`,
    "",
    `- Demo ${channel} release generated by the local SDK release simulation.`,
    ""
  ].join("\n");

  const updated = current.replace("## Unreleased\n\n", `## Unreleased\n\n${section}`);
  writeFileSync(changelogPath, updated, "utf8");
}

function buildNodeArtifact() {
  const packageDir = resolve(repoRoot, config.packages.npm.path);
  const npmEnv = {
    ...process.env,
    npm_config_cache: resolve(releaseDir, "npm-cache")
  };

  execFileSync("npm", ["run", "build"], {
    cwd: packageDir,
    stdio: "inherit",
    env: npmEnv
  });

  const npmDist = resolve(distDir, "npm");
  const output = execFileSync("npm", ["pack", "--pack-destination", npmDist], {
    cwd: packageDir,
    encoding: "utf8",
    env: npmEnv
  }).trim();
  return resolve(npmDist, output.split("\n").at(-1));
}

function buildPythonArtifacts() {
  const packageDir = resolve(repoRoot, config.packages.pypi.path);
  const pypiDist = resolve(distDir, "pypi");
  execFileSync("python3", ["-m", "build", "--outdir", pypiDist], {
    cwd: packageDir,
    stdio: "inherit"
  });

  return listFiles(pypiDist).map((file) => resolve(pypiDist, file));
}

function writeReleaseManifest({ metadata, nodeArtifact, pythonArtifacts }) {
  const manifestPath = resolve(distDir, "release-manifest.json");
  const payload = {
    ...metadata,
    npm: {
      packageName: config.packages.npm.packageName,
      artifact: basename(nodeArtifact),
      distTag: npmDistTag(metadata.channel),
      authStrategy: config.publishing.npm.strategy
    },
    pypi: {
      packageName: config.packages.pypi.packageName,
      artifacts: pythonArtifacts.map((artifact) => basename(artifact)),
      authStrategy: config.publishing.pypi.strategy
    }
  };

  writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return manifestPath;
}

function mirrorAndCreatePublicRelease({
  metadata,
  nodeArtifact,
  pythonArtifacts,
  manifestPath
}) {
  if (!publicToken) {
    console.log("No PUBLIC_REPO_TOKEN provided. Skipping public repository mirroring.");
    return {};
  }

  const tempRoot = resolve(repoRoot, ".sdk-release", "private-mirror.git");
  rmSync(tempRoot, { recursive: true, force: true });

  const privateRepoUrl = privateToken
    ? `https://x-access-token:${privateToken}@github.com/${config.privateRepository}.git`
    : `https://github.com/${config.privateRepository}.git`;
  const publicUrl = `https://x-access-token:${publicToken}@github.com/${config.publicRepository}.git`;

  ensureReleaseTagExists(metadata.tag);
  execFileSync("git", ["clone", "--mirror", privateRepoUrl, tempRoot], {
    stdio: "inherit"
  });
  execFileSync("git", ["remote", "set-url", "--push", "origin", publicUrl], {
    cwd: tempRoot,
    stdio: "inherit"
  });
  execFileSync("git", ["push", "--mirror"], { cwd: tempRoot, stdio: "inherit" });

  const releaseUrl = createOrUpdatePublicGithubRelease({
    metadata,
    nodeArtifact,
    pythonArtifacts,
    manifestPath
  });

  return { releaseUrl };
}

function createOrUpdatePublicGithubRelease({
  metadata,
  nodeArtifact,
  pythonArtifacts,
  manifestPath
}) {
  const releaseTitle = `${metadata.tag} ${metadata.channel} release`;
  const releaseNotes = [
    `Simulated ${metadata.channel} release for base version ${metadata.baseVersion}.`,
    `npm -> ${config.packages.npm.packageName}@${metadata.npmVersion}`,
    `PyPI -> ${config.packages.pypi.packageName}==${metadata.pypiVersion}`
  ].join("\n");
  const prereleaseArgs = metadata.channel === "production" ? [] : ["--prerelease"];

  try {
    execFileSync("gh", ["release", "view", metadata.tag, "--repo", config.publicRepository], {
      stdio: "ignore"
    });
    execFileSync(
      "gh",
      [
        "release",
        "upload",
        metadata.tag,
        nodeArtifact,
        ...pythonArtifacts,
        manifestPath,
        "--clobber",
        "--repo",
        config.publicRepository
      ],
      { stdio: "inherit" }
    );
  } catch {
    execFileSync(
      "gh",
      [
        "release",
        "create",
        metadata.tag,
        nodeArtifact,
        ...pythonArtifacts,
        manifestPath,
        "--repo",
        config.publicRepository,
        "--title",
        releaseTitle,
        "--notes",
        releaseNotes,
        ...prereleaseArgs
      ],
      { stdio: "inherit" }
    );
  }

  return `https://github.com/${config.publicRepository}/releases/tag/${metadata.tag}`;
}

function createOrRefreshRcBranch(rcBranch) {
  git(["checkout", "-B", rcBranch], { stdio: "inherit" });
  git(["push", "origin", rcBranch, "--force-with-lease"], { stdio: "inherit" });
}

function commitAndPushWorkingTree(message, branch) {
  git(["add", "."], { stdio: "inherit" });
  const porcelain = git(["status", "--porcelain"], { encoding: "utf8" }).trim();
  if (porcelain.length > 0) {
    git(["commit", "-m", message], { stdio: "inherit" });
  }
  git(["push", "origin", branch], { stdio: "inherit" });
}

function ensureReleaseTagExists(releaseTag) {
  try {
    git(["rev-parse", "--verify", `refs/tags/${releaseTag}`], { stdio: "ignore" });
  } catch {
    git(["tag", releaseTag], { stdio: "inherit" });
  }

  try {
    git(["push", "origin", `refs/tags/${releaseTag}`], { stdio: "inherit" });
  } catch {
    console.log(`Tag ${releaseTag} already exists on origin or could not be pushed again.`);
  }
}

function buildReleaseMetadata({
  channel,
  baseVersion,
  npmVersion,
  pypiVersion,
  tag,
  sourceBranch,
  rcBranch = null,
  iteration = null,
  note
}) {
  return {
    channel,
    baseVersion,
    npmVersion,
    pypiVersion,
    tag,
    sourceBranch,
    rcBranch,
    iteration,
    preparedAt: new Date().toISOString(),
    sourceSha: githubSha,
    note,
    packages: config.packages
  };
}

function releaseMetadataFromTag(tag) {
  let match = tag.match(/^v(\d+\.\d+\.\d+)-alpha\.(\d{8})\.(\d+)$/);
  if (match) {
    const [, baseVersion, date, sequence] = match;
    return buildReleaseMetadata({
      channel: "alpha",
      baseVersion,
      npmVersion: tag.replace(/^v/, ""),
      pypiVersion: toPyPiVersion("alpha", baseVersion, {
        date,
        sequence: Number.parseInt(sequence, 10)
      }),
      tag,
      sourceBranch: config.channels.alpha.sourceBranch,
      note: "Public mirror release event for an alpha package publish."
    });
  }

  match = tag.match(/^v(\d+\.\d+\.\d+)-beta\.(\d{8})$/);
  if (match) {
    const [, baseVersion, date] = match;
    return buildReleaseMetadata({
      channel: "beta",
      baseVersion,
      npmVersion: tag.replace(/^v/, ""),
      pypiVersion: toPyPiVersion("beta", baseVersion, { date }),
      tag,
      sourceBranch: config.channels.beta.sourceBranch,
      note: "Public mirror release event for a beta package publish."
    });
  }

  match = tag.match(/^v(\d+\.\d+\.\d+)-rc\.(\d+)$/);
  if (match) {
    const [, baseVersion, iteration] = match;
    const rcBranch = renderPattern(config.channels.rc.branchPattern, { version: baseVersion });
    return buildReleaseMetadata({
      channel: "rc",
      baseVersion,
      npmVersion: tag.replace(/^v/, ""),
      pypiVersion: toPyPiVersion("rc", baseVersion, {
        iteration: Number.parseInt(iteration, 10)
      }),
      tag,
      sourceBranch: rcBranch,
      rcBranch,
      iteration: Number.parseInt(iteration, 10),
      note: "Public mirror release event for an RC package publish."
    });
  }

  match = tag.match(/^v(\d+\.\d+\.\d+)$/);
  if (match) {
    const [, baseVersion] = match;
    return buildReleaseMetadata({
      channel: "production",
      baseVersion,
      npmVersion: baseVersion,
      pypiVersion: baseVersion,
      tag,
      sourceBranch: renderPattern(config.channels.production.sourceBranchPattern, {
        version: baseVersion
      }),
      rcBranch: renderPattern(config.channels.production.sourceBranchPattern, {
        version: baseVersion
      }),
      note: "Public mirror release event for a production package publish."
    });
  }

  throw new Error(`Unsupported release tag format for registry publish: ${tag}`);
}

function readReleaseMetadata() {
  if (!existsSync(releaseFile)) {
    throw new Error("Missing .sdk-release/release.json. This mode expects prepared release metadata.");
  }
  return JSON.parse(readFileSync(releaseFile, "utf8"));
}

function writeReleaseMetadata(metadata) {
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(releaseFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function exposeRelease(metadata, releaseUrl = "") {
  setOutput("release-version", metadata.baseVersion);
  setOutput("release-tag", metadata.tag);
  setOutput("release-channel", metadata.channel);
  setOutput("npm-version", metadata.npmVersion);
  setOutput("pypi-version", metadata.pypiVersion);
  setOutput("public-release-url", releaseUrl);
}

function resolveNextBaseVersion() {
  const packageJsonPath = resolve(repoRoot, config.packages.npm.path, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const sanitized = packageJson.version.split("-")[0];
  const parts = sanitized.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) {
    throw new Error(`Unable to resolve next base version from ${packageJson.version}`);
  }
  parts[1] += 1;
  parts[2] = 0;
  return parts.join(".");
}

function renderChannelTag(channel, values) {
  const pattern = config.channels[channel].tagPattern;
  return renderPattern(pattern, values);
}

function renderPattern(pattern, values) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    pattern
  );
}

function toPyPiVersion(channel, baseVersion, { date = null, sequence = null, iteration = null } = {}) {
  switch (channel) {
    case "alpha":
      return `${baseVersion}a${date}${String(sequence).padStart(2, "0")}`;
    case "beta":
      return `${baseVersion}b${date}`;
    case "rc":
      return `${baseVersion}rc${iteration}`;
    case "production":
      return baseVersion;
    default:
      throw new Error(`Unsupported PyPI version channel: ${channel}`);
  }
}

function nextAlphaSequence(baseVersion, date) {
  const pattern = `v${baseVersion}-alpha.${date}.`;
  const tags = listMatchingTags(pattern);
  const maxSequence = tags.reduce((max, tag) => {
    const sequence = Number.parseInt(tag.split(".").at(-1), 10);
    return Number.isNaN(sequence) ? max : Math.max(max, sequence);
  }, 0);
  return maxSequence + 1;
}

function nextRcIteration(baseVersion) {
  const pattern = `v${baseVersion}-rc.`;
  const tags = listMatchingTags(pattern);
  const maxIteration = tags.reduce((max, tag) => {
    const iteration = Number.parseInt(tag.split(".").at(-1), 10);
    return Number.isNaN(iteration) ? max : Math.max(max, iteration);
  }, 0);
  return maxIteration + 1;
}

function hasChangesSinceLastBeta() {
  const tags = listMatchingTags("-beta.").filter((tag) => tag.startsWith("v"));
  if (tags.length === 0) {
    return true;
  }
  const latestTag = tags.at(-1);
  const count = git(["rev-list", "--count", `${latestTag}..HEAD`], { encoding: "utf8" }).trim();
  return Number.parseInt(count, 10) > 0;
}

function listMatchingTags(fragment) {
  return git(["tag", "--list"], { encoding: "utf8" })
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag) => tag.includes(fragment))
    .sort();
}

function parseRcBranchVersion(branch) {
  const match = branch.match(/^rc\/(\d+\.\d+\.\d+)$/);
  if (!match) {
    throw new Error(`Expected rc/<version> branch, received: ${branch}`);
  }
  return match[1];
}

function npmDistTag(channel) {
  return config.channels[channel]?.npmDistTag ?? "latest";
}

function currentBranch() {
  return git(["branch", "--show-current"], { encoding: "utf8" }).trim();
}

function formatTag(version) {
  return config.releaseTagFormat.replace("{version}", version);
}

function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Expected a simple x.y.z version, received: ${version}`);
  }
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function dateStamp() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .format(new Date())
    .replaceAll("-", "");
}

function isoDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function setOutput(name, value) {
  if (!outputFile) {
    return;
  }
  appendFileSync(outputFile, `${name}=${value}\n`, "utf8");
}

function writeSummary(lines) {
  if (!summaryFile) {
    return;
  }
  appendFileSync(summaryFile, `${lines.join("\n")}\n`, "utf8");
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function relativeToRepo(path) {
  return path.replace(`${repoRoot}/`, "");
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    ...options
  });
}
