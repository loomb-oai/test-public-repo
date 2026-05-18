import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, resolve } from "node:path";

const repoRoot = process.env.GITHUB_WORKSPACE ?? process.cwd();
const githubEvent = readGithubEvent();
const eventName = process.env.GITHUB_EVENT_NAME ?? "";
const workflowInputs = githubEvent.inputs ?? {};
const dispatchPayload = githubEvent.client_payload ?? {};
const githubRefName = process.env.GITHUB_REF_NAME ?? refNameFromRef(process.env.GITHUB_REF ?? "");
const mode = resolveMode(process.env.SDK_RELEASE_MODE ?? "auto");
const explicitReleaseTag =
  process.env.SDK_RELEASE_RELEASE_TAG ??
  githubEvent.release?.tag_name ??
  workflowInputs["release-tag"] ??
  "";
const requestedRcBranch =
  process.env.SDK_RELEASE_RC_BRANCH ??
  workflowInputs["rc-branch"] ??
  workflowInputs.rc_branch ??
  "";
const configPath = resolve(repoRoot, process.env.SDK_RELEASE_CONFIG ?? ".github/sdk-release.yml");
const config = normalizeConfig(readYamlConfig(configPath));
const releasePleaseConfigPath = resolve(
  repoRoot,
  process.env.SDK_RELEASE_RELEASE_PLEASE_CONFIG ?? ".github/release-please-config.json"
);
const releasePleaseManifestPath = resolve(
  repoRoot,
  process.env.SDK_RELEASE_RELEASE_PLEASE_MANIFEST ?? ".release-please-manifest.json"
);
const releasePleaseConfig = JSON.parse(readFileSync(releasePleaseConfigPath, "utf8"));
const releasePleaseManifest = JSON.parse(readFileSync(releasePleaseManifestPath, "utf8"));
const releasePleasePullRequests = readReleasePleasePullRequests();
const githubAppId = process.env.SDK_RELEASE_GH_APP_ID ?? "";
const githubAppPrivateKey = process.env.SDK_RELEASE_GH_APP_PRIVATE_KEY ?? "";
const githubAppToken = process.env.SDK_RELEASE_GH_APP_TOKEN ?? "";
const releaseDir = resolve(repoRoot, ".sdk-release");
const releaseFile = resolve(releaseDir, "release.json");
const distDir = resolve(repoRoot, "dist");
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
const outputFile = process.env.GITHUB_OUTPUT;
const githubRepository = process.env.GITHUB_REPOSITORY ?? "";
const githubSha = process.env.GITHUB_SHA ?? git(["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const supportedModes = new Set([
  "noop",
  "alpha",
  "beta",
  "cut-rc",
  "refresh-rc",
  "final",
  "registry-publish"
]);

await main();

async function main() {
  if (!supportedModes.has(mode)) {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  if (mode === "noop") {
    writeNoopSummary("No release operation matched this event.");
    return;
  }

  if (shouldSkipForRepository(mode)) {
    writeNoopSummary(
      `Mode \`${mode}\` does not run in \`${githubRepository}\`; the mirrored workflow is intentionally inert here.`
    );
    return;
  }

  switch (mode) {
    case "alpha":
      await runEphemeralChannel("alpha");
      break;
    case "beta":
      await runEphemeralChannel("beta");
      break;
    case "cut-rc":
      await cutRcRelease();
      break;
    case "refresh-rc":
      await refreshRcRelease();
      break;
    case "final":
      await finalizeRcRelease();
      break;
    case "registry-publish":
      await publishTaggedReleaseToRegistries();
      break;
  }
}

async function runEphemeralChannel(channel) {
  const baseVersion = releasePleaseCandidateVersion();
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
  await publishFromMetadata(metadata);
}

async function cutRcRelease() {
  const baseVersion = releasePleaseCandidateVersion();
  const rcBranch = renderPattern(config.channels.rc.branchPattern, {
    version: baseVersion
  });
  const tag = renderChannelTag("rc", {
    version: baseVersion,
    iteration: 1
  });
  const npmVersion = tag.replace(/^v/, "");
  const pypiVersion = toPyPiVersion("rc", baseVersion, { iteration: 1 });

  createOrRefreshRcBranch(rcBranch, releasePleaseCandidateCommit());
  updatePackageVersions(npmVersion, pypiVersion);

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
  await publishFromMetadata(metadata);
}

async function refreshRcRelease() {
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
  await publishFromMetadata(metadata);
}

async function finalizeRcRelease() {
  const rcBranch = requestedRcBranch || githubRefName || currentBranch();
  checkoutRequestedRcBranch(rcBranch);
  const baseVersion = parseRcBranchVersion(rcBranch);
  const tag = renderChannelTag("production", {
    version: baseVersion
  });

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
  await publishFromMetadata(metadata);
}

async function publishTaggedReleaseToRegistries() {
  if (!explicitReleaseTag) {
    throw new Error("registry-publish mode requires SDK_RELEASE_RELEASE_TAG.");
  }

  checkoutRegistryPublishTag(explicitReleaseTag);
  const metadata = releaseMetadataFromTag(explicitReleaseTag);
  updatePackageVersions(metadata.npmVersion, metadata.pypiVersion);
  await publishFromMetadata(metadata, {
    propagateRelease: false,
    summaryTitle: "Mirrored registry publish modeled"
  });
}

async function publishFromMetadata(metadata, {
  propagateRelease = true,
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

  const propagation = propagateRelease
    ? await propagateReleaseToTarget({
        metadata,
        nodeArtifact,
        pythonArtifacts,
        manifestPath
      })
    : {};

  exposeRelease(metadata);
  writeSummary([
    `# ${summaryTitle}`,
    "",
    `- Base version: \`${metadata.baseVersion}\``,
    `- Tag: \`${metadata.tag}\``,
    `- npm version: \`${metadata.npmVersion}\``,
    `- PyPI version: \`${metadata.pypiVersion}\``,
    `- Release Please released baseline: \`${releasePleaseBaselineVersion()}\``,
    `- Release Please candidate source: \`${releasePleaseCandidateSource()}\``,
    `- Release Please candidate version: \`${releasePleaseCandidateVersion()}\``,
    `- Release Please PR refresh: \`${releasePleasePrRefreshState()}\``,
    `- npm artifact: \`${relativeToRepo(nodeArtifact)}\``,
    `- PyPI artifacts: ${pythonArtifacts.map((artifact) => `\`${relativeToRepo(artifact)}\``).join(", ")}`,
    `- npm publish model: Trusted Publisher OIDC with dist-tag \`${npmDistTag(metadata.channel)}\``,
    "- PyPI publish model: Trusted Publisher OIDC via `pypa/gh-action-pypi-publish@release/v1`",
    propagateRelease
      ? `- Mirror propagation: ${propagation.description}`
      : "- Mirror propagation: already completed before the mirrored release event",
    propagateRelease
      ? mirrorSummaryLine()
      : `- Publish surface: \`${publishingRepository()}\` release event`
    ,
    propagateRelease
      ? `- Mirror debug artifact: \`${relativeToRepo(propagation.path)}\``
      : "- Mirror debug artifact: not needed for mirrored release events"
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

async function propagateReleaseToTarget({
  metadata,
  nodeArtifact,
  pythonArtifacts,
  manifestPath
}) {
  if (process.env.GITHUB_ACTIONS === "true") {
    ensureReleaseTagExists(metadata.tag);
  }

  const targetRepo = releaseRepository();
  const payload = {
    action: "mirror-and-create-release",
    sourceRepository: config.repository.source,
    releaseRepository: targetRepo,
    publishingRepository: publishingRepository(),
    mirror: config.repository.mirror,
    githubAppCredentialsPresent: {
      appId: githubAppId.length > 0,
      privateKey: githubAppPrivateKey.length > 0,
      token: githubAppToken.length > 0
    },
    release: {
      tag: metadata.tag,
      title: `${metadata.tag} ${metadata.channel} release`,
      prerelease: metadata.channel !== "production",
      notes: [
        `Simulated ${metadata.channel} release for base version ${metadata.baseVersion}.`,
        `npm -> ${config.packages.npm.packageName}@${metadata.npmVersion}`,
        `PyPI -> ${config.packages.pypi.packageName}==${metadata.pypiVersion}`
      ].join("\n")
    },
    artifacts: {
      node: relativeToRepo(nodeArtifact),
      python: pythonArtifacts.map((artifact) => relativeToRepo(artifact)),
      manifest: relativeToRepo(manifestPath)
    }
  };
  const debugPath = resolve(distDir, "mirror-propagation.json");

  if (!shouldPropagateRelease(targetRepo)) {
    payload.result = {
      mode: "skipped",
      reason: "release target matches the current repository or mirroring is disabled"
    };
    writeFileSync(debugPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return {
      path: debugPath,
      description: `not needed for \`${targetRepo}\``
    };
  }

  if (process.env.GITHUB_ACTIONS !== "true") {
    payload.result = {
      mode: "skipped",
      reason: "local simulation does not mutate remote repositories"
    };
    writeFileSync(debugPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return {
      path: debugPath,
      description: `local simulation prepared \`${metadata.tag}\` for \`${targetRepo}\` without mutating remotes`
    };
  }

  if (!githubAppToken) {
    throw new Error(
      "Mirror propagation requires SDK_RELEASE_GH_APP_TOKEN. Configure the GitHub App credentials so the action can mint an installation token."
    );
  }

  mirrorReleaseRefs(targetRepo, metadata);
  const release = await ensureRemoteGithubRelease(targetRepo, payload.release, metadata.sourceBranch);

  payload.result = {
    mode: "propagated",
    releaseUrl: release.html_url ?? null,
    releaseId: release.id ?? null
  };
  writeFileSync(debugPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return {
    path: debugPath,
    description: `mirrored \`${metadata.sourceBranch}\` and \`${metadata.tag}\` into \`${targetRepo}\`, then ensured the target GitHub Release exists`
  };
}

function checkoutRequestedRcBranch(rcBranch) {
  if (!requestedRcBranch) {
    return;
  }

  git(["fetch", "origin", rcBranch], { stdio: "inherit" });
  git(["checkout", "-B", rcBranch, `origin/${rcBranch}`], { stdio: "inherit" });
}

function checkoutRegistryPublishTag(tag) {
  try {
    git(["fetch", "--force", "--tags", "origin"], { stdio: "inherit" });
    git(["checkout", "--detach", tag], { stdio: "inherit" });
  } catch (error) {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw error;
    }
    console.log(`Tag ${tag} is not available locally. Continuing with the current checkout for simulation.`);
  }
}

function createOrRefreshRcBranch(rcBranch, startPoint = "HEAD") {
  git(["checkout", "-B", rcBranch, startPoint], { stdio: "inherit" });
  git(["push", "origin", rcBranch, "--force-with-lease"], { stdio: "inherit" });
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

function shouldPropagateRelease(targetRepo) {
  return (
    config.repository.mirror.enabled &&
    targetRepo &&
    targetRepo !== githubRepository
  );
}

function mirrorReleaseRefs(targetRepo, metadata) {
  const remoteName = "sdk-release-target";
  const remoteUrl = `https://x-access-token:${githubAppToken}@github.com/${targetRepo}.git`;
  const branchName = metadata.sourceBranch || currentBranch();
  const checkoutAuthHeaders = readCheckoutGithubAuthHeaders();

  try {
    clearCheckoutGithubAuthHeaders();

    try {
      git(["remote", "remove", remoteName], { stdio: "ignore" });
    } catch {
      // The temporary remote is not expected to exist on a fresh checkout.
    }

    git(["remote", "add", remoteName, remoteUrl], { stdio: "ignore" });
    git(["push", remoteName, `HEAD:refs/heads/${branchName}`], { stdio: "inherit" });
    git(["push", remoteName, `refs/tags/${metadata.tag}:refs/tags/${metadata.tag}`], {
      stdio: "inherit"
    });
  } finally {
    restoreCheckoutGithubAuthHeaders(checkoutAuthHeaders);
  }
}

function readCheckoutGithubAuthHeaders() {
  try {
    const headers = git(
      ["config", "--local", "--get-all", "http.https://github.com/.extraheader"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }
    );
    return headers
      .split("\n")
      .map((header) => header.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function clearCheckoutGithubAuthHeaders() {
  try {
    git(["config", "--local", "--unset-all", "http.https://github.com/.extraheader"], {
      stdio: "ignore"
    });
  } catch {
    // Checkouts without persisted credentials do not have this header.
  }
}

function restoreCheckoutGithubAuthHeaders(headers) {
  for (const header of headers) {
    git(["config", "--local", "--add", "http.https://github.com/.extraheader", header], {
      stdio: "ignore"
    });
  }
}

async function ensureRemoteGithubRelease(targetRepo, release, targetCommitish) {
  const existing = await githubApiRequest(
    "GET",
    `/repos/${targetRepo}/releases/tags/${release.tag}`,
    null,
    { allowNotFound: true }
  );
  if (existing) {
    return existing;
  }

  return githubApiRequest("POST", `/repos/${targetRepo}/releases`, {
    tag_name: release.tag,
    target_commitish: targetCommitish,
    name: release.title,
    body: release.notes,
    draft: false,
    prerelease: release.prerelease
  });
}

async function githubApiRequest(method, path, body = null, { allowNotFound = false } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubAppToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (allowNotFound && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub API ${method} ${path} failed with ${response.status}: ${message}`);
  }

  return response.json();
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
      note: "Mirrored release event for an alpha package publish."
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
      note: "Mirrored release event for a beta package publish."
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
      note: "Mirrored release event for an RC package publish."
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
      note: "Mirrored release event for a production package publish."
    });
  }

  throw new Error(`Unsupported release tag format for registry publish: ${tag}`);
}

function writeReleaseMetadata(metadata) {
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(releaseFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function exposeRelease(metadata) {
  setOutput("release-version", metadata.baseVersion);
  setOutput("release-tag", metadata.tag);
  setOutput("release-channel", metadata.channel);
  setOutput("npm-version", metadata.npmVersion);
  setOutput("pypi-version", metadata.pypiVersion);
}

function releasePleaseBaselineVersion() {
  const configuredPaths = Object.keys(releasePleaseConfig.packages ?? {});
  if (configuredPaths.length === 0) {
    throw new Error("Release Please config must define at least one package.");
  }

  const versions = configuredPaths.map((path) => {
    const version = releasePleaseManifest[path];
    if (!version) {
      throw new Error(`Release Please manifest is missing a version for ${path}.`);
    }
    return version.split("-")[0];
  });

  return versions.sort(compareSemver).at(-1);
}

function releasePleaseCandidateVersion() {
  const candidateManifest = releasePleaseCandidateManifest();
  const configuredPaths = Object.keys(releasePleaseConfig.packages ?? {});
  const versions = configuredPaths
    .map((path) => candidateManifest[path])
    .filter(Boolean)
    .map((version) => version.split("-")[0]);

  if (versions.length === 0) {
    throw new Error("Unable to resolve a Release Please candidate version.");
  }

  return versions.sort(compareSemver).at(-1);
}

function releasePleaseCandidateManifest() {
  const releasePullRequest = releasePleasePullRequests.at(0);
  const headSha = releasePullRequest?.head?.sha;

  if (headSha) {
    try {
      ensureReleasePleasePullRequestHead(releasePullRequest);
      const manifest = git(
        ["show", `${headSha}:${relativeToRepo(releasePleaseManifestPath)}`],
        { encoding: "utf8" }
      );
      return JSON.parse(manifest);
    } catch (error) {
      console.log(
        `Unable to read the Release Please manifest from PR head ${headSha}; falling back to the checked-in manifest.`
      );
    }
  }

  return releasePleaseManifest;
}

function ensureReleasePleasePullRequestHead(releasePullRequest) {
  const headSha = releasePullRequest?.head?.sha;
  const headRef = releasePullRequest?.head?.ref;
  if (!headSha) {
    return;
  }

  try {
    git(["cat-file", "-e", `${headSha}^{commit}`], { stdio: "ignore" });
    return;
  } catch {
    if (headRef) {
      git(["fetch", "origin", headRef], { stdio: "inherit" });
      return;
    }
    git(["fetch", "origin", headSha], { stdio: "inherit" });
  }
}

function releasePleaseCandidateSource() {
  const releasePullRequest = releasePleasePullRequests.at(0);
  const headSha = releasePullRequest?.head?.sha;
  if (headSha) {
    return `release-pr:${headSha.slice(0, 12)}`;
  }
  return "checked-in-manifest-fallback";
}

function releasePleaseCandidateCommit() {
  const releasePullRequest = releasePleasePullRequests.at(0);
  const headSha = releasePullRequest?.head?.sha;
  if (headSha) {
    ensureReleasePleasePullRequestHead(releasePullRequest);
    return headSha;
  }
  return githubSha;
}

function releasePleasePrRefreshState() {
  const refreshed = process.env.SDK_RELEASE_RELEASE_PLEASE_PRS_CREATED;
  if (!refreshed) {
    return "not-run-for-this-event";
  }
  return refreshed === "true" ? "created-or-updated" : "no-pr-change";
}

function compareSemver(left, right) {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function readReleasePleasePullRequests() {
  const raw = process.env.SDK_RELEASE_RELEASE_PLEASE_PRS;
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.log("Unable to parse Release Please PR metadata; continuing without PR-backed candidate discovery.");
    return [];
  }
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

function resolveMode(rawMode) {
  if (rawMode && rawMode !== "auto") {
    return rawMode;
  }

  if (eventName === "workflow_dispatch") {
    return workflowInputs.operation ?? "noop";
  }

  if (eventName === "repository_dispatch") {
    return dispatchPayload.operation ?? "noop";
  }

  if (eventName === "push" && githubRefName.startsWith("rc/")) {
    return "refresh-rc";
  }

  if (eventName === "release") {
    return "registry-publish";
  }

  return "noop";
}

function shouldSkipForRepository(releaseMode) {
  if (!githubRepository) {
    return false;
  }

  if (releaseMode === "registry-publish") {
    return githubRepository !== publishingRepository();
  }

  return githubRepository !== config.repository.source;
}

function releaseRepository() {
  return repositoryForTarget(config.releases.github.target);
}

function publishingRepository() {
  return repositoryForTarget(config.publishing.surface);
}

function repositoryForTarget(target) {
  switch (target) {
    case "source":
      return config.repository.source;
    case "mirror":
      if (!config.repository.mirror.enabled) {
        throw new Error("Configuration targets the mirror repo, but repository.mirror.enabled is false.");
      }
      return config.repository.mirror.target;
    default:
      throw new Error(`Unsupported repository target: ${target}`);
  }
}

function mirrorSummaryLine() {
  if (!config.repository.mirror.enabled) {
    return `- GitHub Release target: \`${releaseRepository()}\``;
  }
  return `- Mirror strategy: \`${config.repository.mirror.strategy}\` into \`${config.repository.mirror.target}\``;
}

function currentBranch() {
  return git(["branch", "--show-current"], { encoding: "utf8" }).trim();
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

function writeNoopSummary(reason) {
  writeSummary([
    "# Release bot no-op",
    "",
    reason
  ]);
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

function readYamlConfig(path) {
  const rubyScript = [
    "require 'json'",
    "require 'yaml'",
    "puts JSON.generate(YAML.safe_load(File.read(ARGV.fetch(0)), permitted_classes: [], aliases: false))"
  ].join("; ");

  const serialized = execFileSync("ruby", ["-e", rubyScript, path], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  return JSON.parse(serialized);
}

function normalizeConfig(raw) {
  const channels = raw.channels ?? {};
  const publishing = raw.publishing ?? {};
  const packages = raw.packages ?? {};

  return {
    repository: {
      source: raw.repository?.source,
      mirror: {
        enabled: raw.repository?.mirror?.enabled ?? false,
        target: raw.repository?.mirror?.target,
        strategy: raw.repository?.mirror?.strategy ?? "mirror"
      }
    },
    releases: {
      github: {
        target: raw.releases?.github?.target ?? "source"
      }
    },
    schedules: raw.schedules,
    channels: {
      alpha: normalizeChannel(channels.alpha),
      beta: normalizeChannel(channels.beta),
      rc: normalizeChannel(channels.rc),
      production: normalizeChannel(channels.production)
    },
    publishing: {
      mode: publishing.mode,
      surface: publishing.surface ?? "source",
      npm: normalizePublishing(publishing.npm),
      pypi: normalizePublishing(publishing.pypi)
    },
    packages: {
      npm: normalizePackage(packages.npm),
      pypi: normalizePackage(packages.pypi)
    }
  };
}

function normalizeChannel(channel = {}) {
  return {
    sourceBranch: channel["source-branch"],
    sourceBranchPattern: channel["source-branch-pattern"],
    branchPattern: channel["branch-pattern"],
    tagPattern: channel["tag-pattern"],
    npmDistTag: channel["npm-dist-tag"],
    pypiPhase: channel["pypi-phase"],
    onlyIfChanged: channel["only-if-changed"] ?? false
  };
}

function normalizePublishing(publishing = {}) {
  return {
    strategy: publishing.strategy,
    workflowFile: publishing["workflow-file"],
    requires: publishing.requires ?? [],
    recommendedAction: publishing["recommended-action"]
  };
}

function normalizePackage(pkg = {}) {
  return {
    id: pkg.id,
    path: pkg.path,
    packageName: pkg["package-name"]
  };
}

function readGithubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return {};
  }
  return JSON.parse(readFileSync(eventPath, "utf8"));
}

function refNameFromRef(ref) {
  return ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    ...options
  });
}
