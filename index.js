const fs = require("fs");
const core = require("@actions/core");
const cache = require("@actions/tool-cache");
const artifact = require("@actions/artifact");
const artifactClient = artifact.create();
const { exec } = require("child_process");
const util = require("node:util");
const semver = require("semver");

const { Octokit } = require("@octokit/rest");
const octokit = new Octokit();
const owner = "manifest-cyber";
const repo = "cli";
const manifestBinary = "manifest";
const tmpPath = "/tmp";
const binaryPath = `${tmpPath}/${manifestBinary}`;

const execPromise = util.promisify(exec);

const validOutput = ["spdx-json", "cyclonedx-json"];
const validGenerator = ["syft", "trivy", "cdxgen", "sigstore-bom", "spdx-sbom-generator", "docker-sbom"];
const localTest = process.env.TEST_LOCALLY;
const sourceFlagMinVer = "0.8.1"
const labelsFlagMinVer = "0.9.1"

async function execWrapper(cmd) {
  const { stdout, stderr, error } = await execPromise(cmd);
  if (stdout) {
    console.log(`stdout: ${stdout}`);
  }

  if (stderr) {
    console.log(`stderr: ${stderr}`);
    return;
  }

  if (error) {
    core.setFailed(`error: ${error}`);
    return;
  }
}

// TODO: Add better support for different platforms
async function getReleaseVersion() {
  // Pull the latest version of the CLI
  let release = await octokit.repos.getLatestRelease({ owner, repo });

  let targetAsset = "manifest_linux_x86_64.tar.gz";
  if (localTest && localTest === 'enabled') {
    targetAsset = "manifest_darwin_x86_64.tar.gz";
  }

  let manifestVersion = release.data?.tag_name;
  let binaryUrl = undefined;

  for (let i = 0; i < release.data?.assets?.length || 0; i++) {
    if (release.data.assets[i].name === targetAsset) {
      binaryUrl = release.data.assets[i].browser_download_url;
      break;
    }
  }

  if (!binaryUrl) {
    throw new Error("Could not find the latest release of the CLI");
  }

  return { manifestVersion, binaryUrl };
}

// TODO: Add support for caching the CLI
async function getCLI(version, url) {
  const dest = `${tmpPath}${url.substring(url.lastIndexOf("/"))}`
  if (fileExists(`${binaryPath}/${manifestBinary}`)) {
    core.info("Manifest CLI already exists, skipping download");
    core.addPath(binaryPath);
    return;
  }

  if (!fileExists(dest)) {
    core.info(`Downloading the latest version of the CLI from ${url}`);
    await cache.downloadTool(url, dest);
  } else {
    core.info('CLI tarball already exists, skipping download');
  }

  const binaryExtractedPath = await cache.extractTar(dest, binaryPath, 'xz');
  core.addPath(binaryExtractedPath)
}

function shouldPublish(apiKey, publish) {
  if (!apiKey) {
    return false;
  }

  return publish !== "false";
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function validateInput(output, generator) {
  if (output && !validOutput.includes(output)) {
    throw new Error(`Invalid output format: ${output}, expected to be one of ${validOutput}`);
  }
  if (generator && !validGenerator.includes(generator)) {
    throw new Error(`Invalid generator: ${generator}, expected to be one of ${validGenerator}`);
  }
}

// TODO: Add support for caching the generators that the CLI uses
async function generateSBOM(targetPath, outputPath, outputFormat, sbomName, sbomVersion, generator, generatorFlags) {
  if (fileExists(outputPath)) {
    return;
  }
  validateInput(outputFormat, generator)
  let sbomFlags = `--file=${outputPath.replace(/\.json$/, '')} --output=${outputFormat} --name=${sbomName} --version=${sbomVersion} --generator=${generator} --publish=false ${targetPath}`;
  if (generatorFlags) {
    sbomFlags = `${sbomFlags} -- ${generatorFlags}`;
  }
  core.info(`Generating SBOM using flags: ${sbomFlags}`);

  await execWrapper(`${manifestBinary} install --generator ${generator}`).then(async () => {
    core.info(`Installed ${generator}`);
    await execWrapper(`${manifestBinary} sbom ${sbomFlags}`).then(() => { core.info(`SBOM Generated: ${outputPath}`) });
  });
  return outputPath;
}


// TODO: Add support for running the CLI against a local deployment
try {
  const apiKey = core.getInput("apiKey");
  core.setSecret(apiKey);
  const targetPath = core.getInput("path") || __dirname;
  const name = core.getInput("sbomName") || `${process.env.GITHUB_REPOSITORY?.replace(`${process.env.GITHUB_REPOSITORY_OWNER}/`, "")}`;

  const bomFilePath = core.getInput("bomFilePath") || `${name}.json`;
  const version = core.getInput("bomVersion");
  const output = core.getInput("sbomOutput");
  const generator = core.getInput("sbomGenerator");
  const artifact = core.getInput("sbomArtifact");
  const publish = core.getInput("sbomPublish");
  const generatorFlags = core.getInput("sbomGeneratorFlags");
  const source = core.getInput("source");
  const relationship = core.getInput("relationship");
  const labels= core.getInput('sbomLabels') || '';

  /**
   * At Manifest, we like to eat our own dogfood - you'll see some development code we use when testing our API and this action locally. We include our development code for both transparency to you and our own convenience.
   * If you have a better idea or suggested improvements, fork/PR or ping us at engineering@manifestcyber.com and we'd love to chat over a virtual cup of coffee :)
   */
  getReleaseVersion().then(async ({ manifestVersion, binaryUrl }) => {
    getCLI(manifestVersion, binaryUrl).then(async () => {
      generateSBOM(targetPath, bomFilePath, output, name, version, generator, generatorFlags).then(async (outputPath) => {
        execWrapper(`SBOM_FILENAME=${bomFilePath} SBOM_OUTPUT=${output} SBOM_NAME=${name} SBOM_VERSION=${version} bash ${__dirname}/update-sbom.sh`).then(async () => {
          console.log("SBOM Updated");
          if (outputPath && artifact === "true") {
            const upload = await artifactClient.uploadArtifact("sbom", [outputPath], outputPath.substring(0, outputPath.lastIndexOf("/")));
            core.info(`SBOM uploaded to GitHub as an artifact: ${upload}`);
          }
          if (shouldPublish(apiKey, publish)) {
            let publishCommand = `MANIFEST_API_KEY=${apiKey} ${manifestBinary} publish --ignore-validation=True --paths=${bomFilePath} --source=${source} --relationship=${relationship}`;
            const mVer = semver.coerce(manifestVersion)
            if (mVer && semver.gte(mVer, sourceFlagMinVer)) {
              publishCommand = `${publishCommand} --source=github-action`;
            } else {
              core.warning(`The version of the CLI (${manifestVersion}) does not support the \`--source\` flag. Please upgrade to v0.8.1 or later.`);
            }
            if (mVer && labels && semver.gte(mVer, labelsFlagMinVer)) {
              publishCommand = `${publishCommand} --labels=${labels.split(' ').join('-')}`;
            } else if (labels) {
              core.warning(`The version of the CLI (${manifestVersion}) does not support the \`--labels\` flag. Please upgrade to v0.9.1 or later.`);
            }
            core.info("Sending request to Manifest Server");
            await execWrapper(publishCommand);
          } else {
            core.info('No API Key provided, skipping publish')
          }
        });
      });
    });
  });
}
catch (error) {
  core.setFailed(error.message);
}

